import { SegmentOpError, toIso, toMs, type Segment } from '@time-tracker/shared';
import { opContext, runAction, type ActionResult, type SegmentAction } from './segmentActions';

export type ChangeKind =
  'removed' | 'shortened' | 'extended' | 'moved' | 'added' | 'reopened' | 'edited';

export interface Change {
  kind: ChangeKind;
  /** The row before the action, null for a created row. */
  before: Segment | null;
  /** The row after the action. */
  after: Segment;
}

export type Preview =
  { ok: true; result: ActionResult; prior: readonly Segment[] } | { ok: false; error: string };

/**
 * Run an action against already loaded segments without writing anything, so a
 * sheet can show what else a change will do before the owner confirms.
 */
export function previewAction(
  segments: readonly Segment[],
  action: SegmentAction,
  nowMs: number,
): Preview {
  try {
    return {
      ok: true,
      result: runAction(segments, action, opContext(toIso(nowMs))),
      prior: segments,
    };
  } catch (err) {
    if (err instanceof SegmentOpError) return { ok: false, error: err.message };
    throw err;
  }
}

function spanMs(s: Segment, nowMs: number): number {
  return (s.endedAt === null ? nowMs : toMs(s.endedAt)) - toMs(s.startedAt);
}

/** Classify each changed row, skipping `ignoreIds` (the row the owner is editing). */
export function describeChanges(
  prior: readonly Segment[],
  rows: readonly Segment[],
  ignoreIds: ReadonlySet<string>,
  nowMs: number,
): Change[] {
  const before = new Map(prior.map((s) => [s.id, s]));
  const out: Change[] = [];
  for (const after of rows) {
    if (ignoreIds.has(after.id)) continue;
    const old = before.get(after.id) ?? null;
    let kind: ChangeKind;
    if (after.deletedAt !== null) kind = 'removed';
    else if (!old) kind = 'added';
    else if (old.endedAt !== null && after.endedAt === null) kind = 'reopened';
    else {
      const delta = spanMs(after, nowMs) - spanMs(old, nowMs);
      if (delta < 0) kind = 'shortened';
      else if (delta > 0) kind = 'extended';
      else if (old.startedAt !== after.startedAt) kind = 'moved';
      else kind = 'edited';
    }
    out.push({ kind, before: old, after });
  }
  return out;
}
