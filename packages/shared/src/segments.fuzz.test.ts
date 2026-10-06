import { describe, expect, it } from 'vitest';
import type { Segment, SegmentSource } from './entities';
import {
  applyRows,
  backdateOpen,
  checkInvariants,
  deleteSegment,
  editSegment,
  findOpen,
  insertSegment,
  liveSorted,
  SegmentOpError,
  splitSegment,
  switchCategory,
  undoRows,
  type DeleteFill,
  type OpContext,
  type SegmentResult,
} from './segments';
import { dailyTotals, hourHeatmap, totalsForRange } from './stats';
import { liveState, runOp } from './test-utils';
import {
  dayKeyOf,
  dayKeysInRange,
  HOUR_MS,
  MINUTE_MS,
  toIso,
  toMs,
  type DaySettings,
} from './time';

/** Node's process, for FUZZ_SEED. Declared here because this package has no Node types. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Randomised operations against the segment engine. Every step either succeeds
 * (and `runOp` checks invariants, row stamps, immutability and undo) or throws a
 * SegmentOpError and changes nothing.
 *
 * Reproduce a failure with FUZZ_SEED=<seed> pnpm --filter @time-tracker/shared test.
 */

const STEPS = 2000;
const CATEGORIES = ['A', 'B', 'C', 'D', 'E'];
const SOURCES: SegmentSource[] = ['app', 'shortcut', 'edit'];
const FILLS: DeleteFill[] = ['none', 'prev', 'next'];
const ZONES: DaySettings[] = [
  { timezone: 'Australia/Sydney', dayStartHour: 4 },
  { timezone: 'America/New_York', dayStartHour: 0 },
  { timezone: 'Asia/Kolkata', dayStartHour: 23 },
  { timezone: 'Australia/Sydney', dayStartHour: 2 },
];
/** Spans Sydney's October 2026 and New York's November 2026 clock changes. */
const START = Date.parse('2026-09-28T00:00:00.000Z');

/** mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seeds(): number[] {
  const fromEnv = process.env.FUZZ_SEED;
  if (fromEnv !== undefined && fromEnv !== '') return [Number(fromEnv)];
  return [1, 2, 3, 20261005];
}

type Op = (segments: readonly Segment[], ctx: OpContext) => SegmentResult;

interface Planned {
  name: string;
  params: unknown;
  op: Op;
  /** Extra checks on the state after a successful, non-no-op run. */
  check: (after: Segment[], nowMs: number) => void;
}

function runFuzz(seed: number): void {
  const rnd = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs[Math.floor(rnd() * xs.length)];
    if (x === undefined) throw new Error('pick from empty list');
    return x;
  };
  const zone = pick(ZONES);

  let state: Segment[] = [];
  let nowMs = START;
  let idCounter = 0;
  const freshId = () => `id-${seed}-${++idCounter}`;
  let lastSuccess: { prior: Segment[]; rows: Segment[] } | null = null;
  let errors = 0;
  let successes = 0;

  const boundaries = (): number[] => {
    const out: number[] = [];
    for (const s of liveSorted(state)) {
      out.push(toMs(s.startedAt));
      if (s.endedAt !== null) out.push(toMs(s.endedAt));
    }
    return out;
  };
  const jitters = [0, 0, 0, 1, -1, 500, -500, 999, -999, 1000, -1000, 1001, -1001, 60_000, -60_000];
  const pickTime = (): number => {
    const pool = [nowMs, ...boundaries()];
    const base = rnd() < 0.8 ? pick(pool) : nowMs - int(0, 6 * 60) * MINUTE_MS;
    const jitter = rnd() < 0.7 ? pick(jitters) : int(-30 * 60, 30 * 60) * 1000;
    return base + jitter;
  };
  const pickId = (): string => {
    const r = rnd();
    const live = liveSorted(state);
    const deleted = state.filter((s) => s.deletedAt !== null);
    if (r < 0.85 && live.length > 0) return pick(live).id;
    if (r < 0.9 && deleted.length > 0) return pick(deleted).id;
    return 'missing';
  };

  const plan = (): Planned => {
    const r = rnd();
    if (r < 0.3) {
      const params = {
        categoryId: pick(CATEGORIES),
        at: rnd() < 0.5 ? undefined : toIso(rnd() < 0.1 ? nowMs + int(0, 120) * 1000 : pickTime()),
        newSegmentId:
          rnd() < 0.2 ? freshId() : rnd() < 0.03 && state.length > 0 ? pick(state).id : undefined,
        source: pick(SOURCES),
      };
      return {
        name: 'switchCategory',
        params,
        op: (s, c) => switchCategory(s, params, c),
        check: (after, now) => {
          const open = findOpen(after);
          expect(open?.categoryId).toBe(params.categoryId);
          const atMs = params.at === undefined ? now : Math.min(toMs(params.at), now);
          expect(open?.startedAt).toBe(toIso(atMs));
          if (params.newSegmentId !== undefined) expect(open?.id).toBe(params.newSegmentId);
          for (const s of liveSorted(after)) expect(toMs(s.startedAt)).toBeLessThanOrEqual(atMs);
        },
      };
    }
    if (r < 0.4) {
      const params = { startedAt: toIso(pickTime()) };
      return {
        name: 'backdateOpen',
        params,
        op: (s, c) => backdateOpen(s, params, c),
        check: (after) => expect(findOpen(after)?.startedAt).toBe(params.startedAt),
      };
    }
    if (r < 0.6) {
      const params: Parameters<typeof editSegment>[1] = { id: pickId() };
      if (rnd() < 0.5) params.startedAt = toIso(pickTime());
      if (rnd() < 0.5) params.endedAt = toIso(pickTime());
      if (rnd() < 0.3) params.categoryId = pick(CATEGORIES);
      if (rnd() < 0.2) params.note = pick(['  x ', '', null, 'note']);
      return {
        name: 'editSegment',
        params,
        op: (s, c) => editSegment(s, params, c),
        check: (after) => {
          const s = after.find((x) => x.id === params.id);
          expect(s?.deletedAt).toBeNull();
          if (params.startedAt !== undefined) expect(s?.startedAt).toBe(params.startedAt);
          if (params.endedAt !== undefined) expect(s?.endedAt).toBe(params.endedAt);
          if (params.categoryId !== undefined) expect(s?.categoryId).toBe(params.categoryId);
        },
      };
    }
    if (r < 0.7) {
      const params = {
        id: pickId(),
        at: toIso(pickTime()),
        secondCategoryId: pick(CATEGORIES),
        secondId: rnd() < 0.5 ? freshId() : undefined,
      };
      return {
        name: 'splitSegment',
        params,
        op: (s, c) => splitSegment(s, params, c),
        check: (after) => {
          expect(after.find((x) => x.id === params.id)?.endedAt).toBe(params.at);
          const second = liveSorted(after).find((x) => x.startedAt === params.at);
          expect(second?.categoryId).toBe(params.secondCategoryId);
        },
      };
    }
    if (r < 0.82) {
      const start = pickTime();
      const end =
        rnd() < 0.5 ? pickTime() : start + pick([1000, 999, 0, -1000, int(1, 3 * 60 * 60) * 1000]);
      const params = {
        categoryId: pick(CATEGORIES),
        startedAt: toIso(start),
        endedAt: toIso(end),
        note: rnd() < 0.3 ? ' hi ' : undefined,
        id: rnd() < 0.3 ? freshId() : undefined,
      };
      return {
        name: 'insertSegment',
        params,
        op: (s, c) => insertSegment(s, params, c),
        check: (after) => {
          const s = liveSorted(after).find(
            (x) => x.startedAt === params.startedAt && x.endedAt === params.endedAt,
          );
          expect(s?.categoryId).toBe(params.categoryId);
        },
      };
    }
    const params = { id: pickId(), fill: pick(FILLS) };
    return {
      name: 'deleteSegment',
      params,
      op: (s, c) => deleteSegment(s, params, c),
      check: (after) => expect(after.find((x) => x.id === params.id)?.deletedAt).not.toBeNull(),
    };
  };

  for (let step = 0; step < STEPS; step++) {
    const r = rnd();
    if (r < 0.25) nowMs += 0;
    else if (r < 0.45) nowMs += int(0, 2000);
    else if (r < 0.85) nowMs += int(0, 90 * 60) * 1000;
    else nowMs += int(0, 12 * 60) * MINUTE_MS;
    const now = toIso(nowMs);
    const ctx: OpContext = { now, newId: freshId };

    let description = '';
    try {
      if (rnd() < 0.05 && lastSuccess !== null) {
        description = 'undo';
        const undo = undoRows(lastSuccess.prior, lastSuccess.rows, now);
        for (const u of undo) expect(u.updatedAt).toBe(now);
        const restored = applyRows(state, undo);
        expect(checkInvariants(restored)).toEqual([]);
        expect(liveState(restored)).toEqual(liveState(lastSuccess.prior));
        state = restored;
        lastSuccess = null;
      } else {
        const planned = plan();
        description = `${planned.name} ${JSON.stringify(planned.params)}`;
        const prior = state;
        let outcome: ReturnType<typeof runOp<SegmentResult>> | null = null;
        try {
          outcome = runOp(prior, ctx, planned.op);
        } catch (e) {
          if (!(e instanceof SegmentOpError)) throw e;
          errors++;
        }
        if (outcome !== null) {
          successes++;
          if (!outcome.result.noop) planned.check(outcome.after, nowMs);
          state = outcome.after;
          lastSuccess = { prior, rows: outcome.result.rows };
        } else {
          lastSuccess = null;
        }
      }

      // Totals over all time equal the sum of live durations, the open one to now.
      const live = liveSorted(state);
      const expected: Record<string, number> = {};
      let sum = 0;
      for (const s of live) {
        const ms = (s.endedAt === null ? nowMs : toMs(s.endedAt)) - toMs(s.startedAt);
        expect(ms).toBeGreaterThanOrEqual(0);
        if (ms > 0) expected[s.categoryId] = (expected[s.categoryId] ?? 0) + ms;
        sum += ms;
      }
      const first = live[0];
      const totals = totalsForRange(state, START - 30 * 24 * HOUR_MS, nowMs + 24 * HOUR_MS, nowMs);
      expect(totals.byCategory).toEqual(expected);
      expect(totals.trackedMs).toBe(sum);
      expect(totals.untrackedMs).toBe(first ? nowMs - toMs(first.startedAt) - sum : 0);

      if (first && step % 100 === 0) {
        const keys = dayKeysInRange(dayKeyOf(first.startedAt, zone), dayKeyOf(nowMs, zone));
        const daily = dailyTotals(state, keys, zone, nowMs);
        const dailySum = Object.values(daily)
          .flatMap((d) => Object.values(d))
          .reduce((a, b) => a + b, 0);
        expect(dailySum).toBe(sum);
        const heat = hourHeatmap(state, first.startedAt, nowMs, zone.timezone, nowMs);
        const heatSum = Object.values(heat)
          .flat()
          .reduce((a, b) => a + b, 0);
        expect(heatSum).toBe(sum);
      }

      // Keep the soft-deleted history bounded so the run stays fast.
      const deleted = state.filter((s) => s.deletedAt !== null);
      if (deleted.length > 60) {
        const drop = new Set(deleted.slice(0, deleted.length - 30).map((s) => s.id));
        state = state.filter((s) => !drop.has(s.id));
        if (lastSuccess && lastSuccess.rows.some((r) => drop.has(r.id))) lastSuccess = null;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Fuzz failure. Reproduce with FUZZ_SEED=${seed}. Step ${step}, now ${now}, ${zone.timezone} ` +
          `dayStartHour ${zone.dayStartHour}, ${description}\n${message}`,
        { cause: e },
      );
    }
  }

  // The run must exercise both paths, or it proves little.
  expect(successes).toBeGreaterThan(STEPS / 4);
  expect(errors).toBeGreaterThan(STEPS / 20);
}

describe('segment operations under random use', () => {
  for (const seed of seeds()) {
    it(`seed ${seed}: ${STEPS} operations keep every invariant`, () => runFuzz(seed), 60_000);
  }
});
