import {
  applyRows,
  checkInvariants,
  findOpen,
  opSchema,
  toMs,
  type Category,
  type Op,
  type OpResult,
  type Rule,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { runBatch, type Db } from '../db/client';
import { categoryFromRow, ruleFromRow, segmentFromRow } from '../db/mapping';
import {
  categoryMap,
  firstSegment,
  firstSettings,
  keepOverlapping,
  segmentMap,
  select,
} from '../db/queries';
import { upsertCategory, upsertRule, upsertSegments, upsertSettings } from '../db/writes';
import { summarizeIssues, zodIssues } from '../http';
import { OpFailure, toOpFailure } from './errors';
import { computeSwitch, switchWindowStart, writeSwitch } from './switch';

/**
 * `POST /api/ops`: the client outbox, applied strictly in order. Each op is
 * atomic (its writes are one D1 batch) and a failed op does not stop the ops
 * after it. Semantics per the op table in docs/04-api.md.
 *
 * D1 on the Workers Free plan allows 50 queries per request. Every op here
 * makes at most MAX_D1_CALLS_PER_OP calls (its reads go in one batch, its
 * writes in another), and a request applies at most MAX_OPS_APPLIED_PER_REQUEST
 * ops. Ops past that get no result; the client sends them again.
 */

/** Most D1 calls (queries or batches) any single op makes. */
export const MAX_D1_CALLS_PER_OP = 3;

/** D1 calls one request may spend on ops, under the Free plan's 50 with room to spare. */
export const D1_CALL_BUDGET = 45;

/** Ops applied per request. Results stop after this many; the rest are sent again. */
export const MAX_OPS_APPLIED_PER_REQUEST = Math.floor(D1_CALL_BUDGET / MAX_D1_CALLS_PER_OP);

/** The server's clock, as an ISO string. Read once per op. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

/** Envelope fields every op has, read before the op itself is validated. */
export interface RawOp {
  opId: string;
  [key: string]: unknown;
}

/** The Workers runtime refusing further D1 calls in this request. */
function isCallLimitError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    if (/too many (api )?(sub)?requests/i.test(cur.message)) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Apply ops in order and return one result per op attempted. Fewer results
 * than ops means the request ran out of budget: the ops without a result were
 * not attempted.
 */
export async function applyOps(db: Db, ops: readonly RawOp[], clock: Clock): Promise<OpResult[]> {
  const results: OpResult[] = [];
  let applied = 0;
  for (const raw of ops) {
    const parsed = opSchema.safeParse(raw);
    if (!parsed.success) {
      const message = summarizeIssues(zodIssues(parsed.error));
      results.push({ opId: raw.opId, ok: false, error: { code: 'validation_failed', message } });
      continue;
    }
    if (applied >= MAX_OPS_APPLIED_PER_REQUEST) break;
    applied += 1;
    const op = parsed.data;
    try {
      await applyOp(db, op, clock());
      results.push({ opId: op.opId, ok: true });
    } catch (err) {
      // Out of D1 calls for this request. Nothing of this op was written (its
      // writes are one batch), so leave it unanswered for the client to resend.
      if (isCallLimitError(err)) break;
      const failure = toOpFailure(err);
      if (!failure) throw err;
      results.push({
        opId: op.opId,
        ok: false,
        error: { code: failure.code, message: failure.message },
      });
    }
  }
  return results;
}

export async function applyOp(db: Db, op: Op, now: string): Promise<void> {
  switch (op.type) {
    case 'switch':
      return applySwitchOp(db, op.payload, now);
    case 'segments.upsert':
      return applySegmentsUpsert(db, op.payload.rows, now);
    case 'category.upsert':
      return applyCategoryUpsert(db, op.payload, now);
    case 'rule.upsert':
      return applyRuleUpsert(db, op.payload, now);
    case 'settings.upsert':
      return applySettingsUpsert(db, op.payload, now);
  }
}

/** Last-write-wins: apply when there is no stored row or the incoming one is at least as new. */
function wins(
  incoming: { updatedAt: string },
  stored: { updatedAt: string } | null | undefined,
): boolean {
  return !stored || incoming.updatedAt >= stored.updatedAt;
}

/** Two D1 calls: one read batch, one write batch. A replay is one. */
async function applySwitchOp(
  db: Db,
  p: Extract<Op, { type: 'switch' }>['payload'],
  now: string,
): Promise<void> {
  const windowStart = switchWindowStart(p.at, now);
  const [existing, categoryRows, overlappingRows] = await db.batch([
    select.segmentsByIds(db, [p.newSegmentId]),
    select.categoriesByIds(db, [p.categoryId]),
    select.segmentsOverlapping(db, windowStart, Number.POSITIVE_INFINITY),
  ]);
  const currentRows = keepOverlapping(overlappingRows, windowStart, Number.POSITIVE_INFINITY);

  // A replay after a timeout: the segment already exists, in whatever state.
  if (existing.length > 0) return;

  const categoryRow = categoryRows[0];
  const category = categoryRow ? categoryFromRow(categoryRow) : null;
  if (!category || category.deletedAt !== null) {
    throw new OpFailure('validation_failed', 'Unknown category');
  }

  const current = currentRows.map(segmentFromRow);
  const open = findOpen(current);
  if (open && open.categoryId === p.categoryId) {
    // Something else (a Shortcut, another flush) already switched to this
    // category. Adding ours would be a different history; the client resyncs.
    throw new OpFailure('conflict', `Already on ${category.name} under another segment`);
  }

  const result = computeSwitch(
    current,
    { categoryId: p.categoryId, at: p.at, newSegmentId: p.newSegmentId, source: p.source },
    now,
  );
  await writeSwitch(db, result, now);
}

function endMs(s: Segment): number {
  return s.endedAt === null ? Number.POSITIVE_INFINITY : toMs(s.endedAt);
}

/** Three D1 calls: stored rows and categories, the affected window, the write. */
async function applySegmentsUpsert(db: Db, rows: readonly Segment[], now: string): Promise<void> {
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) {
    throw new OpFailure('validation_failed', 'The same segment appears twice in one op');
  }

  const [storedRows, categoryRows, openRows] = await db.batch([
    select.segmentsByIds(db, ids),
    select.categoriesByIds(
      db,
      rows.map((r) => r.categoryId),
    ),
    select.openSegment(db),
  ]);
  const stored = segmentMap(storedRows);
  const winners = rows.filter((r) => wins(r, stored.get(r.id)));
  if (winners.length === 0) return;

  // I3: every segment points at a category that exists; live ones at one that is not deleted.
  const cats = categoryMap(categoryRows);
  for (const r of winners) {
    const cat = cats.get(r.categoryId);
    if (!cat || (r.deletedAt === null && cat.deletedAt !== null)) {
      throw new OpFailure('validation_failed', `Segment ${r.id} has an unknown category`);
    }
  }

  // The time this op can affect: the new and the old span of every row it changes.
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const s of [...winners, ...winners.flatMap((r) => stored.get(r.id) ?? [])]) {
    from = Math.min(from, toMs(s.startedAt));
    to = Math.max(to, endMs(s));
  }

  // Everything live in that window plus the open segment (for I1), with the
  // incoming rows applied on top, must satisfy the invariants.
  const nearby = keepOverlapping(await select.segmentsOverlapping(db, from, to), from, to).map(
    segmentFromRow,
  );
  const open = firstSegment(openRows);
  const before = open ? applyRows(nearby, [open]) : nearby;
  const problems = checkInvariants(applyRows(before, winners));
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).join('; ');
    const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : '';
    throw new OpFailure('conflict', `Rejected: ${shown}${more}`);
  }

  await runBatch(db, upsertSegments(db, winners, { syncedAt: now, lww: true }));
}

/** Two D1 calls. */
async function applyCategoryUpsert(db: Db, c: Category, now: string): Promise<void> {
  const [storedRows, liveSegment] = await db.batch([
    select.categoriesByIds(db, [c.id]),
    select.liveSegmentOfCategory(db, c.id),
  ]);
  const storedRow = storedRows[0];
  if (!wins(c, storedRow ? categoryFromRow(storedRow) : null)) return;
  if (c.deletedAt !== null && liveSegment.length > 0) {
    throw new OpFailure('conflict', `${c.name} still has entries; archive it instead`);
  }
  await runBatch(db, [upsertCategory(db, c, { syncedAt: now, lww: true })]);
}

/** Two D1 calls. */
async function applyRuleUpsert(db: Db, r: Rule, now: string): Promise<void> {
  const [categoryRows, storedRows] = await db.batch([
    select.categoriesByIds(db, [r.categoryId]),
    select.ruleById(db, r.id),
  ]);
  if (categoryRows.length === 0) {
    throw new OpFailure('validation_failed', 'Unknown category');
  }
  const storedRow = storedRows[0];
  if (!wins(r, storedRow ? ruleFromRow(storedRow) : null)) return;
  await runBatch(db, [upsertRule(db, r, { syncedAt: now, lww: true })]);
}

/** Two D1 calls. */
async function applySettingsUpsert(db: Db, s: Settings, now: string): Promise<void> {
  const stored = firstSettings(await select.settings(db));
  if (!wins(s, stored)) return;
  await runBatch(db, [upsertSettings(db, s, { syncedAt: now, lww: true })]);
}
