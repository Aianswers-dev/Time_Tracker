import {
  opSchema,
  ruleSchema,
  SEED_CATEGORIES,
  SEED_RULE_IDS,
  SEED_RULES,
  SETTINGS_ID,
  settingsSchema,
} from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { setArchived } from './categoryActions';
import {
  addRule,
  deleteRule,
  liveRules,
  setRuleEnabled,
  updateRule,
  type RuleDraft,
} from './ruleActions';
import { ensureSeeded } from './seed';
import { updateStaleCheck } from './settingsActions';
import { CAT, opsAfter, resetDb } from './testUtils';
import { ValidationError } from './validation';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const SEED_OPS = SEED_CATEGORIES.length + SEED_RULES.length + 1;

const draft: RuleDraft = {
  categoryId: CAT.uniStudy,
  kind: 'daily',
  thresholdMin: 240,
  repeatEveryMin: null,
  quietStart: '22:00',
  quietEnd: '07:00',
  message: '  Enough study for today  ',
  enabled: true,
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  await resetDb();
  await ensureSeeded('Australia/Sydney');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Ops queued since the seed, each parsed with the shared `opSchema`. */
function newOps() {
  return opsAfter(SEED_OPS);
}

async function expectRejected(work: Promise<unknown>, field: string): Promise<ValidationError> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  const v = err as ValidationError;
  expect(Object.keys(v.fields)).toContain(field);
  return v;
}

describe('rule actions', () => {
  it('adds a rule as one valid rule.upsert op', async () => {
    const rule = await addRule(draft);
    expect(ruleSchema.parse(rule)).toEqual(rule);
    expect(rule.message).toBe('Enough study for today');
    expect(rule.createdAt).toBe(new Date(T0).toISOString());
    expect(await db.rules.get(rule.id)).toEqual(rule);
    const ops = await newOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'rule.upsert', payload: rule });
  });

  it('stores a blank custom message as null', async () => {
    const rule = await addRule({ ...draft, message: '   ' });
    expect(rule.message).toBeNull();
  });

  it('updates a rule with one op and stamps updatedAt', async () => {
    vi.setSystemTime(new Date(T0 + 60_000));
    const next = await updateRule(SEED_RULE_IDS.relaxingSession, {
      thresholdMin: 45,
      repeatEveryMin: null,
    });
    expect(next).toMatchObject({ thresholdMin: 45, repeatEveryMin: null });
    expect(next.updatedAt).toBe(new Date(T0 + 60_000).toISOString());
    const ops = await newOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'rule.upsert', payload: next });
  });

  it('queues nothing when an update changes nothing', async () => {
    const before = await db.rules.get(SEED_RULE_IDS.relaxingSession);
    const same = await updateRule(SEED_RULE_IDS.relaxingSession, { thresholdMin: 60 });
    expect(same).toEqual(before);
    expect(await newOps()).toHaveLength(0);
  });

  it('toggles enabled with one op', async () => {
    const off = await setRuleEnabled(SEED_RULE_IDS.relaxingDaily, false);
    expect(off.enabled).toBe(false);
    const on = await setRuleEnabled(SEED_RULE_IDS.relaxingDaily, true);
    expect(on.enabled).toBe(true);
    const ops = await newOps();
    expect(ops.map((o) => o.type)).toEqual(['rule.upsert', 'rule.upsert']);
  });

  it('soft-deletes with one op and hides the rule', async () => {
    await deleteRule(SEED_RULE_IDS.relaxingSession);
    const row = await db.rules.get(SEED_RULE_IDS.relaxingSession);
    expect(row?.deletedAt).toBe(new Date(T0).toISOString());
    expect((await liveRules()).map((r) => r.id)).toEqual([SEED_RULE_IDS.relaxingDaily]);
    const ops = await newOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'rule.upsert',
      payload: { id: SEED_RULE_IDS.relaxingSession, deletedAt: row?.deletedAt },
    });
    // Deleting again is a no-op.
    await deleteRule(SEED_RULE_IDS.relaxingSession);
    expect(await newOps()).toHaveLength(1);
  });

  it('refuses invalid rules per field and queues nothing', async () => {
    await expectRejected(addRule({ ...draft, thresholdMin: 0 }), 'threshold');
    await expectRejected(addRule({ ...draft, thresholdMin: 8 * 24 * 60 }), 'threshold');
    await expectRejected(addRule({ ...draft, repeatEveryMin: 0 }), 'repeat');
    await expectRejected(addRule({ ...draft, quietStart: '22:00', quietEnd: null }), 'quiet');
    await expectRejected(addRule({ ...draft, quietStart: '25:00' }), 'quiet');
    const same = await expectRejected(
      addRule({ ...draft, quietStart: '22:00', quietEnd: '22:00' }),
      'quiet',
    );
    expect(same.fields.quiet).toMatch(/never be quiet/);
    const long = await expectRejected(addRule({ ...draft, message: 'x'.repeat(201) }), 'message');
    expect(long.fields.message).toMatch(/200/);
    await expectRejected(
      addRule({ ...draft, categoryId: '0192f0a0-0000-7000-8000-000000000000' }),
      'category',
    );
    await expectRejected(
      updateRule(SEED_RULE_IDS.relaxingSession, { thresholdMin: -5 }),
      'threshold',
    );
    expect(await newOps()).toHaveLength(0);
    expect(await db.rules.count()).toBe(SEED_RULES.length);
  });

  it('keeps rules of archived categories editable', async () => {
    await setArchived(CAT.relaxing, true);
    const skip = (await db.outbox.count()) - SEED_OPS;
    const rule = await updateRule(SEED_RULE_IDS.relaxingSession, { enabled: false });
    expect(rule.enabled).toBe(false);
    const ops = (await newOps()).slice(skip);
    expect(ops).toHaveLength(1);
    expect(opSchema.parse(ops[0]).type).toBe('rule.upsert');
  });
});

describe('stale check', () => {
  it('updates the settings row with one valid settings.upsert op', async () => {
    const next = await updateStaleCheck({
      staleAfterMin: 240,
      staleRepeatMin: null,
      staleQuietStart: '23:00',
      staleQuietEnd: '06:30',
    });
    expect(settingsSchema.parse(next)).toEqual(next);
    expect(next).toMatchObject({
      staleEnabled: true,
      staleAfterMin: 240,
      staleRepeatMin: null,
      staleQuietStart: '23:00',
      staleQuietEnd: '06:30',
      timezone: 'Australia/Sydney',
    });
    expect(await db.settings.get(SETTINGS_ID)).toEqual(next);
    const ops = await newOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'settings.upsert', payload: next });
  });

  it('turns the stale check off and on', async () => {
    expect((await updateStaleCheck({ staleEnabled: false })).staleEnabled).toBe(false);
    expect((await updateStaleCheck({ staleEnabled: true })).staleEnabled).toBe(true);
    expect((await newOps()).map((o) => o.type)).toEqual(['settings.upsert', 'settings.upsert']);
  });

  it('queues nothing when nothing changes', async () => {
    await updateStaleCheck({ staleAfterMin: 300, staleRepeatMin: 60 });
    expect(await newOps()).toHaveLength(0);
  });

  it('refuses invalid values per field and queues nothing', async () => {
    await expectRejected(updateStaleCheck({ staleAfterMin: 0 }), 'threshold');
    await expectRejected(updateStaleCheck({ staleRepeatMin: 1.5 }), 'repeat');
    await expectRejected(
      updateStaleCheck({ staleQuietStart: '22:00', staleQuietEnd: null }),
      'quiet',
    );
    await expectRejected(
      updateStaleCheck({ staleQuietStart: '01:00', staleQuietEnd: '01:00' }),
      'quiet',
    );
    expect(await newOps()).toHaveLength(0);
    expect((await db.settings.get(SETTINGS_ID))?.staleAfterMin).toBe(300);
  });
});
