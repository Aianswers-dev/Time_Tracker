import { describe, expect, it } from 'vitest';
import type { Rule, Segment } from './entities';
import {
  budgetStatus,
  clipMs,
  dailyTotals,
  hourHeatmap,
  movingAverage,
  sortedTotals,
  timelineForDay,
  todayMsFor,
  totalsForRange,
  trackingStartMs,
} from './stats';
import { at, OLD, seg, T0 } from './test-utils';
import { dayRange, HOUR_MS, MINUTE_MS, type DaySettings } from './time';

const MIN = MINUTE_MS;
const UTC0: DaySettings = { timezone: 'UTC', dayStartHour: 0 };
const SYD4: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };

/** A 0-10, B 10-20, C 20-30, D 30- (open). */
function fourInARow(): Segment[] {
  return [
    seg('a', 'A', at(0), at(10)),
    seg('b', 'B', at(10), at(20)),
    seg('c', 'C', at(20), at(30)),
    seg('d', 'D', at(30), null),
  ];
}

const ms = (min: number) => T0 + min * MIN;

describe('totalsForRange', () => {
  it('clips segments to the range', () => {
    const t = totalsForRange(fourInARow(), at(5), at(25), at(60));
    expect(t.byCategory).toEqual({ A: 5 * MIN, B: 10 * MIN, C: 5 * MIN });
    expect(t.trackedMs).toBe(20 * MIN);
    expect(t.untrackedMs).toBe(0);
  });

  it('counts the open segment up to now and nothing after now', () => {
    const t = totalsForRange(fourInARow(), at(0), at(120), at(60));
    expect(t.byCategory.D).toBe(30 * MIN);
    expect(t.trackedMs).toBe(60 * MIN);
    expect(t.untrackedMs).toBe(0);
  });

  it('counts untracked time only after tracking began and before now', () => {
    const segs = [seg('a', 'A', at(10), at(20)), seg('b', 'B', at(30), null)];
    const t = totalsForRange(segs, at(0), at(100), at(60));
    expect(t.trackedMs).toBe(40 * MIN);
    expect(t.untrackedMs).toBe(10 * MIN);
  });

  it('a range wholly before tracking or after now is empty', () => {
    const segs = [seg('a', 'A', at(10), null)];
    expect(totalsForRange(segs, at(0), at(10), at(60))).toEqual({
      byCategory: {},
      trackedMs: 0,
      untrackedMs: 0,
    });
    expect(totalsForRange(segs, at(61), at(100), at(60))).toEqual({
      byCategory: {},
      trackedMs: 0,
      untrackedMs: 0,
    });
  });

  it('no segments means nothing tracked and nothing untracked', () => {
    expect(totalsForRange([], at(0), at(100), at(60))).toEqual({
      byCategory: {},
      trackedMs: 0,
      untrackedMs: 0,
    });
  });

  it('a segment touching the range edge contributes nothing', () => {
    const t = totalsForRange(fourInARow(), at(10), at(20), at(60));
    expect(t.byCategory).toEqual({ B: 10 * MIN });
  });

  it('ignores soft-deleted segments, including for when tracking began', () => {
    const segs = [...fourInARow(), seg('x', 'X', at(-100), at(-50), { deletedAt: OLD })];
    const t = totalsForRange(segs, at(-200), at(60), at(60));
    expect(t.byCategory.X).toBeUndefined();
    expect(t.untrackedMs).toBe(0);
  });

  it('sums several segments of one category and accepts epoch milliseconds', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'A', at(20), at(25))];
    const t = totalsForRange(segs, ms(0), ms(30), ms(30));
    expect(t.byCategory).toEqual({ A: 15 * MIN });
    expect(t.untrackedMs).toBe(15 * MIN);
  });

  it('an open segment starting at now has no time', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'B', at(10), null)];
    const t = totalsForRange(segs, at(0), at(20), at(10));
    expect(t.byCategory).toEqual({ A: 10 * MIN });
  });
});

describe('sortedTotals', () => {
  it('sorts largest first, ties by id', () => {
    expect(sortedTotals({ b: 5, a: 5, c: 10 })).toEqual([
      { categoryId: 'c', ms: 10 },
      { categoryId: 'a', ms: 5 },
      { categoryId: 'b', ms: 5 },
    ]);
    expect(sortedTotals({})).toEqual([]);
  });
});

describe('clipMs and trackingStartMs', () => {
  it('clipMs clips to the range, open to now', () => {
    const open = seg('d', 'D', at(30), null);
    expect(clipMs(open, ms(0), ms(100), ms(60))).toBe(30 * MIN);
    expect(clipMs(open, ms(40), ms(50), ms(60))).toBe(10 * MIN);
    expect(clipMs(open, ms(70), ms(80), ms(60))).toBe(0);
  });

  it('trackingStartMs is the earliest live start', () => {
    expect(trackingStartMs([])).toBeNull();
    expect(trackingStartMs(fourInARow())).toBe(ms(0));
    expect(
      trackingStartMs([...fourInARow(), seg('x', 'X', at(-5), at(-1), { deletedAt: OLD })]),
    ).toBe(ms(0));
  });
});

describe('todayMsFor', () => {
  it('counts the open segment up to now and only the part of a segment inside the day', () => {
    // UTC day 2026-10-05 is [T0, T0 + 24h). A started yesterday.
    const segs = [
      seg('y', 'A', at(-120), at(30)),
      seg('b', 'B', at(30), at(40)),
      seg('a', 'A', at(40), null),
    ];
    expect(todayMsFor(segs, 'A', '2026-10-05', UTC0, at(100))).toBe(30 * MIN + 60 * MIN);
    expect(todayMsFor(segs, 'A', '2026-10-04', UTC0, at(100))).toBe(120 * MIN);
    expect(todayMsFor(segs, 'Z', '2026-10-05', UTC0, at(100))).toBe(0);
  });
});

describe('timelineForDay', () => {
  it('has gaps, the open block and clips a segment crossing the day start', () => {
    const segs = [
      seg('y', 'A', at(-60), at(10)),
      seg('b', 'B', at(20), at(30)),
      seg('c', 'C', at(30), null),
    ];
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(60));
    expect(tl.start).toBe(ms(0));
    expect(tl.end).toBe(ms(24 * 60));
    expect(tl.now).toBe(ms(60));
    expect(tl.blocks).toEqual([
      { kind: 'segment', segmentId: 'y', categoryId: 'A', start: ms(0), end: ms(10), open: false },
      { kind: 'gap', start: ms(10), end: ms(20) },
      { kind: 'segment', segmentId: 'b', categoryId: 'B', start: ms(20), end: ms(30), open: false },
      { kind: 'segment', segmentId: 'c', categoryId: 'C', start: ms(30), end: ms(60), open: true },
    ]);
  });

  it('has no block before tracking began', () => {
    const segs = [seg('a', 'A', at(120), null)];
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(180));
    expect(tl.blocks).toEqual([
      {
        kind: 'segment',
        segmentId: 'a',
        categoryId: 'A',
        start: ms(120),
        end: ms(180),
        open: true,
      },
    ]);
  });

  it('a past day runs to the day end and has no now', () => {
    const segs = [seg('a', 'A', at(-60), null)];
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(48 * 60));
    expect(tl.now).toBeNull();
    expect(tl.blocks).toEqual([
      {
        kind: 'segment',
        segmentId: 'a',
        categoryId: 'A',
        start: ms(0),
        end: ms(24 * 60),
        open: true,
      },
    ]);
  });

  it('ends with a gap when nothing runs up to now', () => {
    const segs = [seg('a', 'A', at(0), at(30))];
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(60));
    expect(tl.blocks.at(-1)).toEqual({ kind: 'gap', start: ms(30), end: ms(60) });
  });

  it('is empty for a future day, a day before tracking, and no segments', () => {
    expect(timelineForDay(fourInARow(), '2026-10-07', UTC0, at(60)).blocks).toEqual([]);
    expect(timelineForDay(fourInARow(), '2026-10-01', UTC0, at(60)).blocks).toEqual([]);
    expect(timelineForDay([], '2026-10-05', UTC0, at(60)).blocks).toEqual([]);
  });

  it('ignores soft-deleted segments, which leave a gap', () => {
    const segs = fourInARow().map((s) => (s.id === 'b' ? { ...s, deletedAt: OLD } : s));
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(60));
    expect(tl.blocks.map((b) => b.kind)).toEqual(['segment', 'gap', 'segment', 'segment']);
  });

  it('uses the logical day in the settings timezone, including a 23 hour day', () => {
    // Sydney 2026-10-03 with a 04:00 start is 23 hours (clocks jump at 02:00 on the 4th).
    const r = dayRange('2026-10-03', SYD4);
    const segs = [seg('a', 'A', new Date(r.start - HOUR_MS).toISOString(), null)];
    const tl = timelineForDay(segs, '2026-10-03', SYD4, r.end + HOUR_MS);
    expect(tl.blocks).toHaveLength(1);
    const block = tl.blocks[0];
    expect(block?.start).toBe(r.start);
    expect(block?.end).toBe(r.end);
    expect((r.end - r.start) / HOUR_MS).toBe(23);
  });

  it('blocks are contiguous from the first block to the visible end', () => {
    const segs = [
      seg('a', 'A', at(5), at(7)),
      seg('b', 'B', at(9), at(9, 1)),
      seg('c', 'C', at(9, 1), at(50)),
      seg('d', 'D', at(55), null),
    ];
    const tl = timelineForDay(segs, '2026-10-05', UTC0, at(90));
    for (let i = 1; i < tl.blocks.length; i++) {
      expect(tl.blocks[i]?.start).toBe(tl.blocks[i - 1]?.end);
    }
    expect(tl.blocks[0]?.start).toBe(ms(5));
    expect(tl.blocks.at(-1)?.end).toBe(ms(90));
  });
});

describe('dailyTotals', () => {
  it('splits a segment crossing dayStartHour between the two logical days', () => {
    // 02:00 to 06:00 AEDT on 2026-10-06: two hours belong to the 5th.
    const segs = [seg('a', 'A', '2026-10-05T15:00:00.000Z', '2026-10-05T19:00:00.000Z')];
    const out = dailyTotals(segs, ['2026-10-05', '2026-10-06'], SYD4, '2026-10-06T00:00:00.000Z');
    expect(out).toEqual({ '2026-10-05': { A: 2 * HOUR_MS }, '2026-10-06': { A: 2 * HOUR_MS } });
  });

  it('a segment across the Sydney spring-forward sums to the real elapsed time', () => {
    // 22:00 AEST on the 3rd to 06:00 AEDT on the 4th is 7 real hours, not 8.
    const segs = [seg('a', 'A', '2026-10-03T12:00:00.000Z', '2026-10-03T19:00:00.000Z')];
    const midnight: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 0 };
    const out = dailyTotals(
      segs,
      ['2026-10-03', '2026-10-04'],
      midnight,
      '2026-10-05T00:00:00.000Z',
    );
    expect(out['2026-10-03']?.A).toBe(2 * HOUR_MS);
    expect(out['2026-10-04']?.A).toBe(5 * HOUR_MS);
    // With a 04:00 start, the 3rd's logical day ends at 04:00 AEDT (17:00 UTC).
    const four = dailyTotals(segs, ['2026-10-03', '2026-10-04'], SYD4, '2026-10-05T00:00:00.000Z');
    expect(four['2026-10-03']?.A).toBe(5 * HOUR_MS);
    expect(four['2026-10-04']?.A).toBe(2 * HOUR_MS);
  });

  it('a segment across the New York fall-back sums to the real elapsed time', () => {
    // 00:00 EDT to 06:00 EST on 2026-11-01 is 7 real hours.
    const segs = [seg('a', 'A', '2026-11-01T04:00:00.000Z', '2026-11-01T11:00:00.000Z')];
    const ny: DaySettings = { timezone: 'America/New_York', dayStartHour: 0 };
    const out = dailyTotals(segs, ['2026-11-01'], ny, '2026-11-02T00:00:00.000Z');
    expect(out['2026-11-01']?.A).toBe(7 * HOUR_MS);
  });

  it('a Sydney fall-back day with the day starting in the repeated hour matches todayMsFor', () => {
    const s: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 2 };
    // 02:30 AEDT, the first 02:30 on 2026-04-05, to 01:00 AEST on the 6th.
    const segs = [seg('a', 'A', '2026-04-04T15:30:00.000Z', null)];
    const now = '2026-04-05T15:00:00.000Z';
    const out = dailyTotals(segs, ['2026-04-04', '2026-04-05'], s, now);
    expect(out['2026-04-04']?.A).toBeUndefined();
    expect(out['2026-04-05']?.A).toBe(todayMsFor(segs, 'A', '2026-04-05', s, now));
    expect(out['2026-04-05']?.A).toBe(23.5 * HOUR_MS);
  });

  it('accepts unsorted and non-contiguous day keys and returns exactly those keys', () => {
    const segs = [seg('a', 'A', at(-24 * 60), null)];
    const out = dailyTotals(segs, ['2026-10-06', '2026-10-04', '2026-10-06'], UTC0, at(36 * 60));
    expect(Object.keys(out).sort()).toEqual(['2026-10-04', '2026-10-06']);
    expect(out['2026-10-04']?.A).toBe(24 * HOUR_MS);
    expect(out['2026-10-06']?.A).toBe(12 * HOUR_MS);
  });

  it('empty day keys give an empty map and days with nothing are empty objects', () => {
    expect(dailyTotals(fourInARow(), [], UTC0, at(60))).toEqual({});
    expect(dailyTotals(fourInARow(), ['2026-10-01'], UTC0, at(60))).toEqual({ '2026-10-01': {} });
  });

  it('Kolkata with dayStartHour 23', () => {
    const s: DaySettings = { timezone: 'Asia/Kolkata', dayStartHour: 23 };
    // 22:00 to 00:00 IST on 2026-10-05: one hour on the 4th, one on the 5th.
    const segs = [seg('a', 'A', '2026-10-05T16:30:00.000Z', '2026-10-05T18:30:00.000Z')];
    const out = dailyTotals(segs, ['2026-10-04', '2026-10-05'], s, '2026-10-06T00:00:00.000Z');
    expect(out).toEqual({ '2026-10-04': { A: HOUR_MS }, '2026-10-05': { A: HOUR_MS } });
  });

  it('per-day totals sum to the range total', () => {
    const segs = fourInARow().map((s, i) => ({
      ...s,
      startedAt: new Date(T0 + i * 17 * HOUR_MS).toISOString(),
      endedAt: s.endedAt === null ? null : new Date(T0 + (i + 1) * 17 * HOUR_MS).toISOString(),
    }));
    const now = T0 + 100 * HOUR_MS;
    const keys = [
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ];
    const out = dailyTotals(segs, keys, SYD4, now);
    const sum = Object.values(out)
      .flatMap((d) => Object.values(d))
      .reduce((a, b) => a + b, 0);
    const r = { start: dayRange('2026-10-04', SYD4).start, end: dayRange('2026-10-09', SYD4).end };
    expect(sum).toBe(totalsForRange(segs, r.start, r.end, now).trackedMs);
  });
});

describe('hourHeatmap', () => {
  const sum = (xs: readonly number[] | undefined) => (xs ?? []).reduce((a, b) => a + b, 0);

  it('row sums equal the clipped totals', () => {
    const segs = [
      seg('a', 'A', at(-90), at(75, 30)),
      seg('b', 'B', at(75, 30), at(200)),
      seg('a2', 'A', at(200), null),
    ];
    const heat = hourHeatmap(segs, at(0), at(24 * 60), 'Australia/Sydney', at(500));
    const totals = totalsForRange(segs, at(0), at(24 * 60), at(500));
    expect(sum(heat.A)).toBe(totals.byCategory.A);
    expect(sum(heat.B)).toBe(totals.byCategory.B);
    expect(heat.A).toHaveLength(24);
  });

  it('uses local hours in a half-hour zone', () => {
    // 03:15 to 05:15 IST.
    const segs = [seg('a', 'A', '2026-10-05T21:45:00.000Z', '2026-10-05T23:45:00.000Z')];
    const heat = hourHeatmap(
      segs,
      '2026-10-05T00:00:00.000Z',
      '2026-10-07T00:00:00.000Z',
      'Asia/Kolkata',
      '2026-10-07T00:00:00.000Z',
    );
    expect(heat.A?.[3]).toBe(45 * MIN);
    expect(heat.A?.[4]).toBe(60 * MIN);
    expect(heat.A?.[5]).toBe(15 * MIN);
    expect(sum(heat.A)).toBe(2 * HOUR_MS);
  });

  it('a spring-forward night has no 02:00 hour', () => {
    // 00:00 AEST to 06:00 AEDT on 2026-10-04: five real hours.
    const segs = [seg('a', 'A', '2026-10-03T14:00:00.000Z', '2026-10-03T19:00:00.000Z')];
    const heat = hourHeatmap(
      segs,
      0,
      Date.parse('2027-01-01T00:00:00Z'),
      'Australia/Sydney',
      Date.parse('2027-01-01T00:00:00Z'),
    );
    expect(heat.A?.slice(0, 7)).toEqual([HOUR_MS, HOUR_MS, 0, HOUR_MS, HOUR_MS, HOUR_MS, 0]);
  });

  it('a fall-back night counts the 01:00 hour twice', () => {
    // 00:00 EDT to 06:00 EST on 2026-11-01: seven real hours.
    const segs = [seg('a', 'A', '2026-11-01T04:00:00.000Z', '2026-11-01T11:00:00.000Z')];
    const end = Date.parse('2027-01-01T00:00:00Z');
    const heat = hourHeatmap(segs, 0, end, 'America/New_York', end);
    expect(heat.A?.slice(0, 7)).toEqual([
      HOUR_MS,
      2 * HOUR_MS,
      HOUR_MS,
      HOUR_MS,
      HOUR_MS,
      HOUR_MS,
      0,
    ]);
  });

  it('clips to the range, counts the open segment to now and ignores deleted rows', () => {
    const segs = [seg('a', 'A', at(0), null), seg('x', 'X', at(0), at(10), { deletedAt: OLD })];
    const heat = hourHeatmap(segs, at(30), at(600), 'UTC', at(90));
    expect(heat.A?.[0]).toBe(30 * MIN);
    expect(heat.A?.[1]).toBe(30 * MIN);
    expect(heat.X).toBeUndefined();
    expect(hourHeatmap([], at(0), at(60), 'UTC', at(60))).toEqual({});
  });
});

describe('budgetStatus', () => {
  function rule(id: string, extra: Partial<Rule> = {}): Rule {
    return {
      id,
      categoryId: 'A',
      kind: 'daily',
      thresholdMin: 60,
      repeatEveryMin: null,
      quietStart: null,
      quietEnd: null,
      message: null,
      enabled: true,
      createdAt: OLD,
      updatedAt: OLD,
      deletedAt: null,
      ...extra,
    };
  }

  const keys = ['d1', 'd2', 'd3', 'd4', 'd5'];
  const daily = {
    d1: { A: 60 * MIN - 1 },
    d2: { A: 60 * MIN },
    d3: {},
    d4: { A: 120 * MIN, B: 999 * MIN },
    d5: { A: 10 * MIN },
  };

  it('counts days at or over the threshold as over, and the streak from the last day', () => {
    expect(budgetStatus([rule('r')], daily, keys)).toEqual([
      { ruleId: 'r', categoryId: 'A', thresholdMin: 60, daysOver: 2, daysUnder: 3, streakUnder: 1 },
    ]);
  });

  it('ignores session, disabled and deleted rules', () => {
    const rules = [
      rule('s', { kind: 'session' }),
      rule('off', { enabled: false }),
      rule('gone', { deletedAt: OLD }),
    ];
    expect(budgetStatus(rules, daily, keys)).toEqual([]);
  });

  it('missing days count as under, and an unbroken run is the whole range', () => {
    expect(budgetStatus([rule('r')], {}, keys)[0]).toMatchObject({
      daysOver: 0,
      daysUnder: 5,
      streakUnder: 5,
    });
    expect(budgetStatus([rule('r')], daily, [])[0]).toMatchObject({
      daysOver: 0,
      daysUnder: 0,
      streakUnder: 0,
    });
  });

  it('a last day over budget means no streak', () => {
    expect(budgetStatus([rule('r')], daily, ['d1', 'd2'])[0]?.streakUnder).toBe(0);
  });
});

describe('movingAverage', () => {
  it('trails over up to `window` values', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2, 3, 4]);
    expect(movingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(movingAverage([2, 4], 7)).toEqual([2, 3]);
    expect(movingAverage([], 7)).toEqual([]);
  });

  it('a 7 day average over 30 days of the same value is that value', () => {
    expect(
      movingAverage(
        Array.from({ length: 30 }, () => 90 * MIN),
        7,
      ),
    ).toEqual(Array.from({ length: 30 }, () => 90 * MIN));
  });
});
