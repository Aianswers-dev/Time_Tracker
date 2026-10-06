import {
  backdateOpen,
  deleteSegment,
  editSegment,
  insertSegment,
  SegmentOpError,
  splitSegment,
  switchCategory,
  toMs,
  undoRows,
  uuidv7,
  type DeleteFill,
  type EditParams,
  type ISO,
  type OpContext,
  type Segment,
  type SegmentSource,
} from '@time-tracker/shared';
import { db } from '../db';
import { enqueue, segmentsUpsertOp, switchOp } from './outbox';
import { findOpenSegment, loadAround } from './window';

/**
 * Segment actions the UI calls. Each one is a single Dexie rw transaction:
 * load the segments around the affected time, run the shared operation, write
 * the changed rows and queue exactly one outbox op. A no-op writes nothing.
 */

export type SegmentAction =
  | { kind: 'switch'; categoryId: string; at?: ISO; source?: SegmentSource }
  | { kind: 'backdate'; startedAt: ISO }
  | { kind: 'edit'; params: EditParams }
  | { kind: 'split'; id: string; at: ISO; secondCategoryId: string }
  | { kind: 'insert'; categoryId: string; startedAt: ISO; endedAt: ISO; note?: string | null }
  | { kind: 'delete'; id: string; fill: DeleteFill };

export interface ActionResult {
  rows: Segment[];
  noop: boolean;
  /** The new open segment for a switch, else null. */
  opened: Segment | null;
}

/** Everything `undoRows` needs to reverse an applied action. */
export interface UndoToken {
  /** The changed rows as they were before the action (created rows are absent). */
  prior: Segment[];
  /** The rows the action wrote. */
  changed: Segment[];
}

export interface ActionOutcome extends ActionResult {
  undo: UndoToken | null;
}

export function opContext(now: ISO = new Date().toISOString()): OpContext {
  return { now, newId: () => uuidv7() };
}

/**
 * Run the shared operation for `action` against `segments`. Pure: used both by
 * the actions below and by sheets to preview what a change will do.
 */
export function runAction(
  segments: readonly Segment[],
  action: SegmentAction,
  ctx: OpContext,
): ActionResult {
  switch (action.kind) {
    case 'switch':
      return switchCategory(
        segments,
        { categoryId: action.categoryId, at: action.at, source: action.source ?? 'app' },
        ctx,
      );
    case 'backdate':
      return { ...backdateOpen(segments, { startedAt: action.startedAt }, ctx), opened: null };
    case 'edit':
      return { ...editSegment(segments, action.params, ctx), opened: null };
    case 'split':
      return {
        ...splitSegment(
          segments,
          { id: action.id, at: action.at, secondCategoryId: action.secondCategoryId },
          ctx,
        ),
        opened: null,
      };
    case 'insert':
      return {
        ...insertSegment(
          segments,
          {
            categoryId: action.categoryId,
            startedAt: action.startedAt,
            endedAt: action.endedAt,
            note: action.note,
          },
          ctx,
        ),
        opened: null,
      };
    case 'delete':
      return {
        ...deleteSegment(segments, { id: action.id, fill: action.fill }, ctx),
        opened: null,
      };
  }
}

async function segmentOrThrow(id: string): Promise<Segment> {
  const seg = await db.segments.get(id);
  if (!seg || seg.deletedAt !== null) throw new SegmentOpError('not_found', 'Entry not found');
  return seg;
}

function endOf(s: Segment): number {
  return s.endedAt === null ? Infinity : toMs(s.endedAt);
}

/** The time span an action can touch, used to load just enough segments. */
async function affectedSpan(action: SegmentAction, nowMs: number): Promise<[number, number]> {
  switch (action.kind) {
    case 'switch':
      return [Math.min(action.at === undefined ? nowMs : toMs(action.at), nowMs), Infinity];
    case 'backdate': {
      const open = await findOpenSegment();
      const newStart = toMs(action.startedAt);
      return [open ? Math.min(newStart, toMs(open.startedAt)) : newStart, Infinity];
    }
    case 'edit': {
      const seg = await segmentOrThrow(action.params.id);
      const { startedAt, endedAt } = action.params;
      const from = Math.min(
        toMs(seg.startedAt),
        startedAt === undefined ? Infinity : toMs(startedAt),
      );
      const to = Math.max(endOf(seg), endedAt === undefined ? -Infinity : toMs(endedAt));
      return [from, to];
    }
    case 'split':
    case 'delete': {
      const seg = await segmentOrThrow(action.id);
      return [toMs(seg.startedAt), endOf(seg)];
    }
    case 'insert':
      return [toMs(action.startedAt), toMs(action.endedAt)];
  }
}

/** Load the segments an action needs. Exported for previews and tests. */
export async function loadForAction(action: SegmentAction, nowMs = Date.now()): Promise<Segment[]> {
  const [from, to] = await affectedSpan(action, nowMs);
  return loadAround(from, to);
}

function undoToken(prior: readonly Segment[], changed: Segment[]): UndoToken {
  const ids = new Set(changed.map((r) => r.id));
  return { prior: prior.filter((s) => ids.has(s.id)), changed };
}

export async function applySegmentAction(action: SegmentAction): Promise<ActionOutcome> {
  return db.transaction('rw', db.segments, db.outbox, async () => {
    const ctx = opContext();
    const prior = await loadForAction(action, toMs(ctx.now));
    const result = runAction(prior, action, ctx);
    if (result.noop) return { ...result, undo: null };

    await db.segments.bulkPut(result.rows);
    if (action.kind === 'switch' && result.opened) {
      await enqueue(
        switchOp(
          {
            categoryId: action.categoryId,
            at: result.opened.startedAt,
            newSegmentId: result.opened.id,
            source: result.opened.source,
          },
          ctx.now,
        ),
      );
    } else {
      await enqueue(segmentsUpsertOp(result.rows, ctx.now));
    }
    return { ...result, undo: undoToken(prior, result.rows) };
  });
}

export function switchTo(categoryId: string, at?: ISO): Promise<ActionOutcome> {
  return applySegmentAction({ kind: 'switch', categoryId, at, source: 'app' });
}

export function backdateOpenTo(startedAt: ISO): Promise<ActionOutcome> {
  return applySegmentAction({ kind: 'backdate', startedAt });
}

/**
 * Reverse an applied action. Refuses when any of its rows changed since, so a
 * late Undo never overwrites a newer edit.
 */
export async function undoAction(token: UndoToken): Promise<ActionOutcome> {
  return db.transaction('rw', db.segments, db.outbox, async () => {
    const now = new Date().toISOString();
    const current = await db.segments.bulkGet(token.changed.map((r) => r.id));
    const moved = token.changed.some((row, i) => {
      const cur = current[i];
      return !cur || cur.updatedAt !== row.updatedAt || cur.deletedAt !== row.deletedAt;
    });
    if (moved) {
      throw new SegmentOpError('invalid_range', 'Too late to undo: that entry has changed since.');
    }
    const rows = undoRows(token.prior, token.changed, now);
    await db.segments.bulkPut(rows);
    await enqueue(segmentsUpsertOp(rows, now));
    return { rows, noop: false, opened: null, undo: undoToken(token.changed, rows) };
  });
}
