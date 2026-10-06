import { ruleSchema, uuidv7, type Rule } from '@time-tracker/shared';
import { db } from '../db';
import { enqueue, ruleUpsertOp } from './outbox';
import {
  quietWindowError,
  ValidationError,
  validationErrorFromIssues,
  type NudgeField,
} from './validation';

/**
 * Nudge rule edits (docs/03 "Rule", docs/05 "Rules"). Each user action writes
 * one rule row and queues exactly one `rule.upsert` op in the same
 * transaction. Rows are checked with the shared `ruleSchema` first, so a bad
 * value never reaches Dexie or the outbox; problems come back as a
 * `ValidationError` naming the form field.
 */

export type RuleDraft = Pick<
  Rule,
  | 'categoryId'
  | 'kind'
  | 'thresholdMin'
  | 'repeatEveryMin'
  | 'quietStart'
  | 'quietEnd'
  | 'message'
  | 'enabled'
>;

export type RulePatch = Partial<RuleDraft>;

const FIELD_OF: Record<string, NudgeField> = {
  categoryId: 'category',
  kind: 'kind',
  thresholdMin: 'threshold',
  repeatEveryMin: 'repeat',
  quietStart: 'quiet',
  quietEnd: 'quiet',
  message: 'message',
};

/** A blank custom message means "use the default copy". */
function normaliseMessage(message: string | null | undefined): string | null {
  const trimmed = message?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function validated(row: Rule): Rule {
  const parsed = ruleSchema.safeParse(row);
  if (!parsed.success) {
    throw validationErrorFromIssues(parsed.error.issues, (k) => FIELD_OF[k] ?? null, 'the rule');
  }
  const quiet = quietWindowError(parsed.data.quietStart, parsed.data.quietEnd);
  if (quiet) throw new ValidationError({ quiet });
  return parsed.data;
}

async function assertCategory(categoryId: string): Promise<void> {
  const category = await db.categories.get(categoryId);
  if (!category || category.deletedAt !== null) {
    throw new ValidationError({ category: 'Pick a category' });
  }
}

async function write(row: Rule, now: string): Promise<void> {
  await db.rules.put(row);
  await enqueue(ruleUpsertOp(row, now));
}

/** Live rules, oldest first. */
export async function liveRules(): Promise<Rule[]> {
  const rules = await db.rules.filter((r) => r.deletedAt === null).toArray();
  return rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function addRule(draft: RuleDraft): Promise<Rule> {
  return db.transaction('rw', [db.categories, db.rules, db.outbox], async () => {
    const now = new Date().toISOString();
    await assertCategory(draft.categoryId);
    const row = validated({
      id: uuidv7(),
      ...draft,
      message: normaliseMessage(draft.message),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await write(row, now);
    return row;
  });
}

/** Change some fields of a live rule. No change, no op. */
export async function updateRule(id: string, patch: RulePatch): Promise<Rule> {
  return db.transaction('rw', [db.categories, db.rules, db.outbox], async () => {
    const now = new Date().toISOString();
    const current = await db.rules.get(id);
    if (!current || current.deletedAt !== null) throw new Error('That rule no longer exists');
    if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
      await assertCategory(patch.categoryId);
    }
    const merged: Rule = {
      ...current,
      ...patch,
      message: normaliseMessage(patch.message === undefined ? current.message : patch.message),
    };
    const unchanged = (Object.keys(FIELD_OF) as (keyof RuleDraft)[])
      .concat('enabled')
      .every((k) => merged[k] === current[k]);
    if (unchanged) return current;
    const row = validated({ ...merged, updatedAt: now });
    await write(row, now);
    return row;
  });
}

export function setRuleEnabled(id: string, enabled: boolean): Promise<Rule> {
  return updateRule(id, { enabled });
}

/** Soft delete: the row stays with `deletedAt` set, so the deletion syncs. */
export async function deleteRule(id: string): Promise<void> {
  await db.transaction('rw', db.rules, db.outbox, async () => {
    const now = new Date().toISOString();
    const current = await db.rules.get(id);
    if (!current || current.deletedAt !== null) return;
    await write({ ...current, deletedAt: now, updatedAt: now }, now);
  });
}
