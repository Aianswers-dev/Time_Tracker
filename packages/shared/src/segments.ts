import type { Segment, SegmentSource } from './entities';
import { SECOND_MS, toIso, toMs, type ISO } from './time';

/**
 * Segment operations from docs/03-data-model.md.
 *
 * Every operation takes the current segments (any order; soft-deleted rows are
 * ignored), parameters and a context, and returns the rows it changed. The
 * caller persists those rows and syncs them. Operations never mutate their input.
 *
 * Invariants kept by every operation (checked by `checkInvariants`):
 * - I1: at most one live segment is open (endedAt null).
 * - I2: live segments never overlap, and closed ones end after they start.
 * - I5: no live closed segment is shorter than one second.
 */

/** Shortest closed segment that is kept. Anything shorter is deleted (I5). */
export const MIN_SEGMENT_MS = SECOND_MS;

/** How far in the future a switch time may be before it is rejected as a mistake. */
export const FUTURE_TOLERANCE_MS = 60 * SECOND_MS;

export interface OpContext {
  /** The current time. Open segments are treated as ending here. */
  now: ISO;
  /** Generates ids for segments an operation creates. */
  newId: () => string;
}

export interface SegmentResult {
  /**
   * Rows changed by the operation, in their new state with `updatedAt = now`.
   * Created rows are included; deleted rows have `deletedAt` set.
   */
  rows: Segment[];
  /** True when the operation changed nothing. */
  noop: boolean;
}

export type SegmentErrorCode =
  | 'not_found'
  | 'no_open_segment'
  | 'in_future'
  | 'invalid_range'
  | 'too_short'
  | 'cannot_delete_open';

export class SegmentOpError extends Error {
  readonly code: SegmentErrorCode;
  constructor(code: SegmentErrorCode, message: string) {
    super(message);
    this.name = 'SegmentOpError';
    this.code = code;
  }
}

/** The live open segment, or null. */
export function findOpen(segments: readonly Segment[]): Segment | null {
  return segments.find((s) => s.deletedAt === null && s.endedAt === null) ?? null;
}

/** Live segments sorted by start, oldest first. */
export function liveSorted(segments: readonly Segment[]): Segment[] {
  return segments
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
}

function endMs(s: Segment): number {
  return s.endedAt === null ? Number.POSITIVE_INFINITY : toMs(s.endedAt);
}

/**
 * Mutable working set used inside one operation. Tracks which rows changed and
 * produces the result rows at the end.
 */
class Working {
  private readonly rows = new Map<string, Segment>();
  private readonly original = new Map<string, Segment>();
  private readonly created = new Set<string>();
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();

  constructor(
    segments: readonly Segment[],
    readonly ctx: OpContext,
  ) {
    for (const s of segments) {
      if (s.deletedAt !== null) continue;
      this.rows.set(s.id, s);
      this.original.set(s.id, s);
    }
  }

  get nowMs(): number {
    return toMs(this.ctx.now);
  }

  get(id: string): Segment {
    const s = this.rows.get(id);
    if (!s) throw new SegmentOpError('not_found', `Segment ${id} not found`);
    return s;
  }

  live(): Segment[] {
    return [...this.rows.values()];
  }

  open(): Segment | null {
    return this.live().find((s) => s.endedAt === null) ?? null;
  }

  update(id: string, patch: Partial<Segment>): void {
    this.rows.set(id, { ...this.get(id), ...patch });
    this.touched.add(id);
  }

  create(seg: Omit<Segment, 'createdAt' | 'updatedAt' | 'deletedAt'>): Segment {
    if (this.rows.has(seg.id) || this.original.has(seg.id)) {
      throw new SegmentOpError('invalid_range', `Segment id ${seg.id} already exists`);
    }
    const row: Segment = { ...seg, createdAt: this.ctx.now, updatedAt: this.ctx.now, deletedAt: null };
    this.rows.set(row.id, row);
    this.created.add(row.id);
    this.touched.add(row.id);
    return row;
  }

  delete(id: string): void {
    const s = this.get(id);
    this.rows.delete(id);
    if (this.created.has(id)) {
      // Created and deleted within the same operation: it never existed.
      this.created.delete(id);
      this.touched.delete(id);
      return;
    }
    this.deleted.add(id);
    this.touched.add(id);
    this.original.set(id, this.original.get(id) ?? s);
  }

  /** The live segment that ends exactly where `atMs` is, excluding `exceptId`. */
  endingAt(atMs: number, exceptId: string): Segment | null {
    return this.live().find((s) => s.id !== exceptId && s.endedAt !== null && toMs(s.endedAt) === atMs) ?? null;
  }

  /** The live segment that starts exactly at `atMs`, excluding `exceptId`. */
  startingAt(atMs: number, exceptId: string): Segment | null {
    return this.live().find((s) => s.id !== exceptId && toMs(s.startedAt) === atMs) ?? null;
  }

  /** The closest live segment that ends at or before `atMs`. */
  before(atMs: number, exceptId: string): Segment | null {
    let best: Segment | null = null;
    for (const s of this.live()) {
      if (s.id === exceptId || s.endedAt === null || toMs(s.endedAt) > atMs) continue;
      if (!best || toMs(s.endedAt) > toMs(best.endedAt ?? s.endedAt)) best = s;
    }
    return best;
  }

  /** The closest live segment that starts at or after `atMs`. */
  after(atMs: number, exceptId: string): Segment | null {
    let best: Segment | null = null;
    for (const s of this.live()) {
      if (s.id === exceptId || toMs(s.startedAt) < atMs) continue;
      if (!best || toMs(s.startedAt) < toMs(best.startedAt)) best = s;
    }
    return best;
  }

  /**
   * Remove everything in [fromMs, toMs) except `exceptIds`: delete segments fully
   * inside, trim segments that overlap an edge, split a segment that contains the
   * whole range. `toMs` may be Infinity.
   */
  clearRange(fromMs: number, toMsValue: number, exceptIds: ReadonlySet<string> = new Set()): void {
    for (const s of this.live()) {
      if (exceptIds.has(s.id)) continue;
      const sStart = toMs(s.startedAt);
      const sEnd = endMs(s);
      if (sEnd <= fromMs || sStart >= toMsValue) continue;
      if (sStart >= fromMs && sEnd <= toMsValue) {
        this.delete(s.id);
      } else if (sStart < fromMs && sEnd > toMsValue) {
        // The range sits inside s: keep the head, add a tail piece.
        this.update(s.id, { endedAt: toIso(fromMs) });
        this.create({
          id: this.ctx.newId(),
          categoryId: s.categoryId,
          startedAt: toIso(toMsValue),
          endedAt: s.endedAt,
          note: s.note,
          source: s.source,
        });
      } else if (sStart < fromMs) {
        this.update(s.id, { endedAt: toIso(fromMs) });
      } else {
        this.update(s.id, { startedAt: toIso(toMsValue) });
      }
    }
  }

  /** Delete touched closed segments that became shorter than MIN_SEGMENT_MS (I5). */
  dropSlivers(): void {
    for (const id of this.touched) {
      const s = this.rows.get(id);
      if (!s || s.endedAt === null) continue;
      if (toMs(s.endedAt) - toMs(s.startedAt) < MIN_SEGMENT_MS) this.delete(id);
    }
  }

  result(): SegmentResult {
    this.dropSlivers();
    const now = this.ctx.now;
    const rows: Segment[] = [];
    for (const id of this.touched) {
      if (this.deleted.has(id)) {
        const orig = this.original.get(id);
        if (orig) rows.push({ ...orig, deletedAt: now, updatedAt: now });
        continue;
      }
      const row = this.rows.get(id);
      if (!row) continue;
      const orig = this.original.get(id);
      if (orig && !this.created.has(id) && sameContent(orig, row)) continue;
      rows.push({ ...row, updatedAt: now });
    }
    rows.sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
    return { rows, noop: rows.length === 0 };
  }
}

function sameContent(a: Segment, b: Segment): boolean {
  return (
    a.categoryId === b.categoryId &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.note === b.note &&
    a.source === b.source
  );
}

function assertNotFuture(atMs: number, nowMs: number): void {
  if (atMs > nowMs + FUTURE_TOLERANCE_MS) {
    throw new SegmentOpError('in_future', 'That time is in the future');
  }
}

export interface SwitchParams {
  categoryId: string;
  /** When the new activity started. Defaults to now. May be in the past. */
  at?: ISO;
  /** Id for the new segment, so a replayed switch is recognisable. */
  newSegmentId?: string;
  source?: SegmentSource;
}

export interface SwitchResult extends SegmentResult {
  /** The new open segment, absent on a no-op. */
  opened: Segment | null;
}

/**
 * Start `categoryId` at `at` (default now).
 *
 * - Same category as the open segment: no-op.
 * - `at` up to a minute in the future is clamped to now; further is an error.
 * - `at` in the past backdates the switch: everything from `at` onwards is
 *   cleared (the open segment is closed at `at`, later segments trimmed or
 *   removed) and the new segment opens at `at`.
 */
export function switchCategory(
  segments: readonly Segment[],
  params: SwitchParams,
  ctx: OpContext,
): SwitchResult {
  const w = new Working(segments, ctx);
  const nowMs = w.nowMs;
  let atMs = params.at === undefined ? nowMs : toMs(params.at);
  assertNotFuture(atMs, nowMs);
  atMs = Math.min(atMs, nowMs);

  const open = w.open();
  if (open && open.categoryId === params.categoryId) {
    return { rows: [], noop: true, opened: null };
  }

  w.clearRange(atMs, Number.POSITIVE_INFINITY);
  const opened = w.create({
    id: params.newSegmentId ?? ctx.newId(),
    categoryId: params.categoryId,
    startedAt: toIso(atMs),
    endedAt: null,
    note: null,
    source: params.source ?? 'app',
  });
  const result = w.result();
  return { ...result, opened: { ...opened, updatedAt: ctx.now } };
}

/**
 * Move the open segment's start. Earlier clears whatever was there. Later
 * extends the previous segment if it was touching, otherwise leaves a gap.
 */
export function backdateOpen(
  segments: readonly Segment[],
  params: { startedAt: ISO },
  ctx: OpContext,
): SegmentResult {
  const w = new Working(segments, ctx);
  const open = w.open();
  if (!open) throw new SegmentOpError('no_open_segment', 'Nothing is running');
  const nowMs = w.nowMs;
  const newStart = toMs(params.startedAt);
  if (newStart > nowMs) throw new SegmentOpError('in_future', 'That time is in the future');
  const oldStart = toMs(open.startedAt);
  if (newStart === oldStart) return { rows: [], noop: true };

  if (newStart < oldStart) {
    w.clearRange(newStart, oldStart, new Set([open.id]));
  } else {
    const prev = w.endingAt(oldStart, open.id);
    if (prev) w.update(prev.id, { endedAt: toIso(newStart) });
  }
  w.update(open.id, { startedAt: toIso(newStart) });
  return w.result();
}

export interface EditParams {
  id: string;
  categoryId?: string;
  startedAt?: ISO;
  /** Only for closed segments. The open segment's end cannot be set. */
  endedAt?: ISO;
  /** Empty or whitespace-only clears the note. */
  note?: string | null;
}

/**
 * Edit one segment. Boundaries behave like dragging:
 * - Moving the start later or the end earlier pulls a touching neighbour along,
 *   so no gap appears where there was none.
 * - Moving the start earlier or the end later clears whatever was there.
 */
export function editSegment(
  segments: readonly Segment[],
  params: EditParams,
  ctx: OpContext,
): SegmentResult {
  const w = new Working(segments, ctx);
  const seg = w.get(params.id);
  const nowMs = w.nowMs;
  const isOpen = seg.endedAt === null;
  if (isOpen && params.endedAt !== undefined) {
    throw new SegmentOpError('invalid_range', 'The running entry has no end time. Switch instead.');
  }

  const oldStart = toMs(seg.startedAt);
  const oldEnd = endMs(seg);
  const newStart = params.startedAt === undefined ? oldStart : toMs(params.startedAt);
  const newEnd = params.endedAt === undefined ? oldEnd : toMs(params.endedAt);

  if (isOpen) {
    if (newStart > nowMs) throw new SegmentOpError('in_future', 'Start is in the future');
  } else {
    if (newEnd > nowMs) throw new SegmentOpError('in_future', 'End is in the future');
    if (newEnd <= newStart) throw new SegmentOpError('invalid_range', 'End must be after start');
    if (newEnd - newStart < MIN_SEGMENT_MS) throw new SegmentOpError('too_short', 'Entry is too short');
  }

  if (newStart > oldStart) {
    const prev = w.endingAt(oldStart, seg.id);
    if (prev) w.update(prev.id, { endedAt: toIso(newStart) });
  }
  if (!isOpen && newEnd < oldEnd) {
    const next = w.startingAt(oldEnd, seg.id);
    if (next) w.update(next.id, { startedAt: toIso(newEnd) });
  }
  w.clearRange(newStart, newEnd, new Set([seg.id]));

  const patch: Partial<Segment> = { startedAt: toIso(newStart) };
  if (!isOpen) patch.endedAt = toIso(newEnd);
  if (params.categoryId !== undefined) patch.categoryId = params.categoryId;
  if (params.note !== undefined) {
    const trimmed = params.note?.trim() ?? '';
    patch.note = trimmed === '' ? null : trimmed;
  }
  w.update(seg.id, patch);
  return w.result();
}

/**
 * Split a segment at `at`. The first piece keeps its category, the second
 * piece gets `secondCategoryId`. Splitting the open segment leaves the second
 * piece open.
 */
export function splitSegment(
  segments: readonly Segment[],
  params: { id: string; at: ISO; secondCategoryId: string; secondId?: string },
  ctx: OpContext,
): SegmentResult {
  const w = new Working(segments, ctx);
  const seg = w.get(params.id);
  const atMs = toMs(params.at);
  const start = toMs(seg.startedAt);
  const isOpen = seg.endedAt === null;
  const end = isOpen ? w.nowMs : toMs(seg.endedAt ?? '');
  if (atMs - start < MIN_SEGMENT_MS) {
    throw new SegmentOpError('invalid_range', 'Split time must be after the start');
  }
  if (isOpen ? atMs > end : end - atMs < MIN_SEGMENT_MS) {
    throw new SegmentOpError('invalid_range', 'Split time must be before the end');
  }
  w.update(seg.id, { endedAt: toIso(atMs) });
  w.create({
    id: params.secondId ?? ctx.newId(),
    categoryId: params.secondCategoryId,
    startedAt: toIso(atMs),
    endedAt: seg.endedAt,
    note: null,
    source: 'edit',
  });
  return w.result();
}

/**
 * Add a closed segment for [startedAt, endedAt), clearing whatever was there.
 * Used to fill untracked gaps and to log something after the fact.
 */
export function insertSegment(
  segments: readonly Segment[],
  params: { categoryId: string; startedAt: ISO; endedAt: ISO; note?: string | null; id?: string },
  ctx: OpContext,
): SegmentResult {
  const w = new Working(segments, ctx);
  const start = toMs(params.startedAt);
  const end = toMs(params.endedAt);
  if (end > w.nowMs) throw new SegmentOpError('in_future', 'End is in the future');
  if (end <= start) throw new SegmentOpError('invalid_range', 'End must be after start');
  if (end - start < MIN_SEGMENT_MS) throw new SegmentOpError('too_short', 'Entry is too short');
  w.clearRange(start, end);
  const note = params.note?.trim() ?? '';
  w.create({
    id: params.id ?? ctx.newId(),
    categoryId: params.categoryId,
    startedAt: toIso(start),
    endedAt: toIso(end),
    note: note === '' ? null : note,
    source: 'edit',
  });
  return w.result();
}

export type DeleteFill = 'none' | 'prev' | 'next';

/**
 * Soft-delete a segment.
 * - `fill: 'prev'` extends the previous segment over the freed time. For the
 *   open segment this reopens the previous segment.
 * - `fill: 'next'` pulls the next segment's start back over the freed time.
 * - `fill: 'none'` leaves an untracked gap.
 * The open segment can only be deleted with `fill: 'prev'`, because something
 * must always be running once tracking has started.
 */
export function deleteSegment(
  segments: readonly Segment[],
  params: { id: string; fill: DeleteFill },
  ctx: OpContext,
): SegmentResult {
  const w = new Working(segments, ctx);
  const seg = w.get(params.id);
  const start = toMs(seg.startedAt);

  if (seg.endedAt === null) {
    if (params.fill !== 'prev') {
      throw new SegmentOpError('cannot_delete_open', 'Switch to something else instead');
    }
    const prev = w.before(start, seg.id);
    if (!prev) {
      throw new SegmentOpError('cannot_delete_open', 'There is nothing before this to continue');
    }
    w.delete(seg.id);
    w.update(prev.id, { endedAt: null });
    return w.result();
  }

  const end = toMs(seg.endedAt);
  w.delete(seg.id);
  if (params.fill === 'prev') {
    const prev = w.before(start, seg.id);
    if (prev) w.update(prev.id, { endedAt: toIso(end) });
  } else if (params.fill === 'next') {
    const next = w.after(end, seg.id);
    if (next) w.update(next.id, { startedAt: toIso(start) });
  }
  return w.result();
}

/**
 * Rows that reverse an operation: changed rows go back to their prior state and
 * rows the operation created are deleted. `prior` is the segment list the
 * operation ran against.
 */
export function undoRows(prior: readonly Segment[], changed: readonly Segment[], now: ISO): Segment[] {
  const before = new Map(prior.map((s) => [s.id, s]));
  return changed.map((row) => {
    const old = before.get(row.id);
    if (old) return { ...old, updatedAt: now };
    return { ...row, deletedAt: now, updatedAt: now };
  });
}

/**
 * Apply changed rows to a segment list by id (insert or replace). Used by the
 * client to preview results and by tests.
 */
export function applyRows(segments: readonly Segment[], rows: readonly Segment[]): Segment[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * Human-readable invariant violations among live segments. Empty means valid.
 */
export function checkInvariants(segments: readonly Segment[]): string[] {
  const problems: string[] = [];
  const live = liveSorted(segments);
  const open = live.filter((s) => s.endedAt === null);
  if (open.length > 1) problems.push(`I1: ${open.length} open segments`);
  for (const s of live) {
    if (s.endedAt !== null) {
      const len = toMs(s.endedAt) - toMs(s.startedAt);
      if (len <= 0) problems.push(`I2: ${s.id} ends before it starts`);
      else if (len < MIN_SEGMENT_MS) problems.push(`I5: ${s.id} is shorter than a second`);
    }
  }
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1];
    const cur = live[i];
    if (!prev || !cur) continue;
    if (endMs(prev) > toMs(cur.startedAt)) problems.push(`I2: ${prev.id} overlaps ${cur.id}`);
  }
  return problems;
}
