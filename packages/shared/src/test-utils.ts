import { expect } from 'vitest';
import type { Segment } from './entities';
import {
  applyRows,
  checkInvariants,
  liveSorted,
  SegmentOpError,
  undoRows,
  type OpContext,
  type SegmentResult,
} from './segments';
import { MINUTE_MS, SECOND_MS, toIso, toMs, type ISO } from './time';

/**
 * Helpers for the segment and stats tests. Not exported from the package.
 * Times are written as minutes after T0 so tests read like a timeline.
 */

export const T0 = Date.parse('2026-10-05T00:00:00.000Z');
export const OLD = '2026-01-01T00:00:00.000Z';

/** ISO for T0 plus minutes, seconds and milliseconds. */
export function at(min: number, sec = 0, ms = 0): ISO {
  return toIso(T0 + min * MINUTE_MS + sec * SECOND_MS + ms);
}

export function seg(
  id: string,
  categoryId: string,
  startedAt: ISO,
  endedAt: ISO | null,
  extra: Partial<Segment> = {},
): Segment {
  return {
    id,
    categoryId,
    startedAt,
    endedAt,
    note: null,
    source: 'app',
    createdAt: OLD,
    updatedAt: OLD,
    deletedAt: null,
    ...extra,
  };
}

export interface TestContext extends OpContext {
  /** Ids handed out so far, in order. */
  ids: string[];
}

export function makeCtx(now: ISO, prefix = 'new'): TestContext {
  const ids: string[] = [];
  return {
    now,
    ids,
    newId: () => {
      const id = `${prefix}-${ids.length + 1}`;
      ids.push(id);
      return id;
    },
  };
}

function fmt(ms: number): string {
  const d = ms - T0;
  const min = Math.floor(d / MINUTE_MS);
  const rest = d - min * MINUTE_MS;
  return rest === 0 ? `${min}` : `${min}+${rest}ms`;
}

/** Live segments as "cat start-end" strings in minutes after T0, e.g. "A 0-10", "B 10-". */
export function describeLive(segments: readonly Segment[]): string[] {
  return liveSorted(segments).map(
    (s) =>
      `${s.categoryId} ${fmt(toMs(s.startedAt))}-${s.endedAt === null ? '' : fmt(toMs(s.endedAt))}`,
  );
}

/** Deep copy of plain JSON rows. */
function clone(segments: readonly Segment[]): Segment[] {
  return JSON.parse(JSON.stringify(segments)) as Segment[];
}

function freezeAll(segments: readonly Segment[]): readonly Segment[] {
  for (const s of segments) Object.freeze(s);
  return Object.freeze(segments);
}

/** Content of a row without its sync bookkeeping, for comparing states. */
function content(s: Segment): Omit<Segment, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...rest } = s;
  return rest;
}

/** Live rows keyed by id, without updatedAt. */
export function liveState(segments: readonly Segment[]): Map<string, Omit<Segment, 'updatedAt'>> {
  return new Map(liveSorted(segments).map((s) => [s.id, content(s)]));
}

export interface OpOutcome<R> {
  result: R;
  /** The input with the returned rows applied. */
  after: Segment[];
}

/**
 * Run a segment operation and check everything every successful operation must
 * satisfy (docs/03-data-model.md):
 * - the input is not mutated (it is frozen, and compared afterwards),
 * - every returned row has updatedAt = now, deleted rows have deletedAt = now,
 * - created rows have createdAt = now, existing rows keep theirs,
 * - every returned row is a real change, and no id is returned twice,
 * - the result applied to the input satisfies the invariants,
 * - undoRows restores the exact prior live state.
 */
export function runOp<R extends SegmentResult>(
  segments: readonly Segment[],
  ctx: OpContext,
  op: (segments: readonly Segment[], ctx: OpContext) => R,
): OpOutcome<R> {
  const snapshot = clone(segments);
  const input = freezeAll(segments);
  const result = op(input, ctx);
  expect(clone(input)).toEqual(snapshot);

  const byId = new Map(segments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const row of result.rows) {
    expect(seen.has(row.id), `row ${row.id} returned twice`).toBe(false);
    seen.add(row.id);
    expect(row.updatedAt).toBe(ctx.now);
    const prior = byId.get(row.id);
    if (row.deletedAt !== null) {
      expect(row.deletedAt).toBe(ctx.now);
      expect(prior, `deleted row ${row.id} must have existed`).toBeDefined();
      expect(prior?.deletedAt, `row ${row.id} was already deleted`).toBeNull();
    }
    if (prior === undefined) {
      expect(row.createdAt).toBe(ctx.now);
    } else {
      expect(row.createdAt).toBe(prior.createdAt);
      expect(prior.deletedAt, `soft-deleted row ${row.id} must not be touched`).toBeNull();
      expect(content(row), `row ${row.id} returned without a change`).not.toEqual(content(prior));
    }
  }
  expect(result.noop).toBe(result.rows.length === 0);

  const after = applyRows(segments, result.rows);
  expect(checkInvariants(after)).toEqual([]);

  const undoNow = toIso(toMs(ctx.now) + 5 * SECOND_MS);
  const undo = undoRows(segments, result.rows, undoNow);
  for (const row of undo) expect(row.updatedAt).toBe(undoNow);
  const restored = applyRows(after, undo);
  expect(liveState(restored)).toEqual(liveState(segments));
  expect(checkInvariants(restored)).toEqual(checkInvariants(segments));

  return { result, after };
}

/** Assert that `fn` throws a SegmentOpError with `code`. */
export function expectOpError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected SegmentOpError ${code}`).toBeInstanceOf(SegmentOpError);
  expect((caught as SegmentOpError).code).toBe(code);
}
