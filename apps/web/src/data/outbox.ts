import {
  MAX_ROWS_PER_OP,
  opSchema,
  SegmentOpError,
  uuidv7,
  type Category,
  type Op,
  type Rule,
  type Segment,
  type Settings,
  type SwitchOp,
} from '@time-tracker/shared';
import { db, type OutboxRow } from '../db';

/**
 * Builders for outbox ops. Every op is parsed with the shared `opSchema` before
 * it is queued, so a malformed op fails the user action (and its transaction)
 * here rather than being rejected by the server later.
 */

function build(raw: Record<string, unknown>, now: string): Op {
  return opSchema.parse({ opId: uuidv7(), createdAt: now, ...raw });
}

export function switchOp(payload: SwitchOp['payload'], now: string): Op {
  return build({ type: 'switch', payload }, now);
}

export function segmentsUpsertOp(rows: readonly Segment[], now: string): Op {
  if (rows.length > MAX_ROWS_PER_OP) {
    // The server applies one op atomically and caps its size. An edit this large
    // is almost certainly a mistake, so refuse it rather than split it.
    throw new SegmentOpError(
      'invalid_range',
      `That change would touch ${rows.length} entries. Make it in smaller steps.`,
    );
  }
  return build({ type: 'segments.upsert', payload: { rows } }, now);
}

export function categoryUpsertOp(category: Category, now: string): Op {
  return build({ type: 'category.upsert', payload: category }, now);
}

export function ruleUpsertOp(rule: Rule, now: string): Op {
  return build({ type: 'rule.upsert', payload: rule }, now);
}

export function settingsUpsertOp(settings: Settings, now: string): Op {
  return build({ type: 'settings.upsert', payload: settings }, now);
}

const outboxListeners = new Set<() => void>();

/** Call `listener` after every enqueue (the sync engine flushes about 1 s later). */
export function onEnqueue(listener: () => void): () => void {
  outboxListeners.add(listener);
  return () => outboxListeners.delete(listener);
}

/** Queue ops in order. Call inside the same rw transaction as the data write. */
export async function enqueue(...ops: Op[]): Promise<void> {
  const rows: OutboxRow[] = ops.map((op) => ({
    opId: op.opId,
    op,
    attempts: 0,
    lastError: null,
  }));
  await db.outbox.bulkAdd(rows);
  for (const listener of outboxListeners) listener();
}
