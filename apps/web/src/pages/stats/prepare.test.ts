import {
  HOUR_MS,
  MINUTE_MS,
  SEED_RULES,
  dailyTotals,
  dayKeyOf,
  localDateTimeToMs,
  toIso,
  type Rule,
  type Segment,
} from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  buildStats,
  dailyByCategory,
  hourOrder,
  minutesPast,
  perDay,
  trendSeries,
  type StatsInput,
} from './prepare';
import { resolveRange, type RangeKind } from './range';

const UTC4 = { timezone: 'UTC', dayStartHour: 4 };
const SYDNEY = { timezone: 'Australia/Sydney', dayStartHour: 4 };
const A = 'cat-a';
const B = 'cat-b';
const C = 'cat-c';

let n = 0;
function seg(categoryId: string, start: string | number, end: string | number | null): Segment {
  const startedAt = toIso(start);
  return {
    id: `s${++n}`,
    categoryId,
    startedAt,
    endedAt: end === null ? null : toIso(end),
    note: null,
    source: 'app',
    createdAt: startedAt,
    updatedAt: startedAt,
    deletedAt: null,
  };
}

function rule(categoryId: string, thresholdMin: number, patch: Partial<Rule> = {}): Rule {
  return {
    ...(SEED_RULES[1] as Rule),
    id: `rule-${categoryId}-${thresholdMin}`,
    categoryId,
    thresholdMin,
    ...patch,
  };
}

function build(
  segments: Segment[],
  kind: RangeKind,
  now: string,
  opts: { rules?: Rule[]; settings?: typeof UTC4; custom?: { from: string; to: string } } = {},
) {
  const settings = opts.settings ?? UTC4;
  const nowMs = Date.parse(now);
  const todayKey = dayKeyOf(nowMs, settings);
  const input: StatsInput = {
    segments,
    rules: opts.rules ?? [],
    settings,
    range: resolveRange(kind, todayKey, settings, opts.custom),
    todayKey,
    now: nowMs,
  };
  return buildStats(input);
}

const h = (x: number) => x * HOUR_MS;

describe('buildStats', () => {
  it('reports no data before the first segment', () => {
    const m = build([], 'week', '2026-10-06T12:00:00Z');
    expect(m.hasData).toBe(false);
    expect(m.activeKeys).toEqual([]);
    expect(m.totals.rows).toEqual([]);
    expect(m.trackingStartKey).toBeNull();
  });

  it('splits a segment crossing the day start between the two logical days', () => {
    // 23:00 to 06:00 UTC with the day starting at 04:00: 5 h on the 5th, 2 h on the 6th.
    const segs = [seg(A, '2026-10-05T23:00:00Z', '2026-10-06T06:00:00Z')];
    const m = build(segs, 'week', '2026-10-06T12:00:00Z');
    const mon = m.days.find((d) => d.dayKey === '2026-10-05');
    const tue = m.days.find((d) => d.dayKey === '2026-10-06');
    expect(mon?.parts).toEqual([{ categoryId: A, ms: h(5) }]);
    expect(tue?.parts).toEqual([{ categoryId: A, ms: h(2) }]);
    expect(m.totals.trackedMs).toBe(h(7));
  });

  it('marks future days and days before tracking began', () => {
    const segs = [seg(A, '2026-10-06T05:00:00Z', null)];
    const m = build(segs, 'week', '2026-10-06T12:00:00Z');
    expect(m.days.map((d) => d.status)).toEqual([
      'before-tracking',
      'active',
      'future',
      'future',
      'future',
      'future',
      'future',
    ]);
    expect(m.activeKeys).toEqual(['2026-10-06']);
    expect(m.days[1]?.isToday).toBe(true);
    expect(m.trackingStartKey).toBe('2026-10-06');
  });

  it('counts the open segment up to now and untracked gaps after tracking began', () => {
    const segs = [
      seg(A, '2026-10-06T04:00:00Z', '2026-10-06T06:00:00Z'),
      // An hour untracked, then B running.
      seg(B, '2026-10-06T07:00:00Z', null),
    ];
    const m = build(segs, 'today', '2026-10-06T10:00:00Z');
    expect(m.totals.trackedMs).toBe(h(5));
    expect(m.totals.untrackedMs).toBe(h(1));
    expect(m.totals.spanMs).toBe(h(6));
    expect(m.days[0]?.untrackedMs).toBe(h(1));
    expect(m.order).toEqual([B, A]);
    expect(m.totals.rows.map((r) => r.share)).toEqual([0.5, 2 / 6]);
  });

  it('does not count untracked time before the earliest segment', () => {
    // Tracking began at 08:00 on the 6th: the 5th and the start of the 6th are not untracked.
    const segs = [seg(A, '2026-10-06T08:00:00Z', null)];
    const m = build(segs, 'last7', '2026-10-06T10:00:00Z');
    expect(m.totals.untrackedMs).toBe(0);
    expect(m.days.at(-1)?.untrackedMs).toBe(0);
  });

  it('orders categories by range total and stacks every day in that order', () => {
    const segs = [
      seg(C, '2026-10-05T04:00:00Z', '2026-10-05T05:00:00Z'),
      seg(A, '2026-10-05T05:00:00Z', '2026-10-05T09:00:00Z'),
      seg(B, '2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z'),
      seg(B, '2026-10-06T04:00:00Z', '2026-10-06T08:00:00Z'),
      seg(C, '2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z'),
    ];
    const m = build(segs, 'week', '2026-10-06T09:00:00Z');
    expect(m.order).toEqual([B, A, C]);
    expect(m.days[0]?.parts.map((p) => p.categoryId)).toEqual([B, A, C]);
    expect(m.days[1]?.parts.map((p) => p.categoryId)).toEqual([B, C]);
    const shares = m.totals.rows.reduce((s, r) => s + r.share, 0);
    expect(shares + m.totals.untrackedMs / m.totals.spanMs).toBeCloseTo(1, 10);
  });

  it('lays the heatmap out from the day start hour and keeps every minute', () => {
    const segs = [
      seg(A, '2026-10-06T04:30:00Z', '2026-10-06T06:00:00Z'),
      seg(B, '2026-10-06T23:00:00Z', '2026-10-07T01:15:00Z'),
    ];
    const m = build(segs, 'today', '2026-10-07T02:00:00Z');
    expect(m.heatmap.hours.slice(0, 3)).toEqual([4, 5, 6]);
    expect(m.heatmap.hours.at(-1)).toBe(3);
    const rowA = m.heatmap.rows.find((r) => r.categoryId === A);
    const rowB = m.heatmap.rows.find((r) => r.categoryId === B);
    expect(rowA?.cells[0]).toBe(30 * MINUTE_MS); // 04:00 column
    expect(rowA?.cells[1]).toBe(h(1)); // 05:00 column
    expect(rowB?.cells[19]).toBe(h(1)); // 23:00 column
    expect(rowB?.cells[20]).toBe(h(1)); // 00:00 column
    expect(rowB?.cells[21]).toBe(15 * MINUTE_MS); // 01:00 column
    for (const row of m.heatmap.rows) {
      expect(row.cells.reduce((s, x) => s + x, 0)).toBe(row.totalMs);
    }
    expect(m.heatmap.days).toBe(1);
  });

  it('sums a segment across a daylight saving start to its real length', () => {
    // Sydney: 4 October 2026, 02:00 becomes 03:00. 01:00 to 04:00 local is 2 real hours.
    const start = localDateTimeToMs('2026-10-04', '01:00', SYDNEY.timezone);
    const end = localDateTimeToMs('2026-10-04', '04:00', SYDNEY.timezone);
    expect(end - start).toBe(h(2));
    const m = build([seg(A, start, end)], 'week', '2026-10-04T06:00:00Z', { settings: SYDNEY });
    // The night belongs to logical Saturday 3 October.
    const sat = m.days.find((d) => d.dayKey === '2026-10-03');
    expect(sat?.trackedMs).toBe(h(2));
    expect(m.totals.trackedMs).toBe(h(2));
    const row = m.heatmap.rows[0];
    const col = (hour: number) => m.heatmap.hours.indexOf(hour);
    expect(row?.cells[col(1)]).toBe(h(1));
    expect(row?.cells[col(2)]).toBe(0);
    expect(row?.cells[col(3)]).toBe(h(1));
  });

  it('counts budget days under and over, per day, with the streak back from the last day', () => {
    const r = rule(A, 60);
    const segs = [
      // Mon 5th: 90 min, over. Tue 6th: 59 min, under. Wed 7th: 60 min, over (at threshold).
      // Thu 8th: none, under.
      seg(A, '2026-10-05T10:00:00Z', '2026-10-05T11:30:00Z'),
      seg(A, '2026-10-06T10:00:00Z', '2026-10-06T10:59:00Z'),
      seg(A, '2026-10-07T10:00:00Z', '2026-10-07T11:00:00Z'),
      seg(B, '2026-10-08T05:00:00Z', null),
    ];
    const m = build(segs, 'week', '2026-10-08T12:00:00Z', {
      rules: [r, rule(B, 30, { enabled: false }), rule(C, 30, { kind: 'session' })],
    });
    expect(m.budgets).toHaveLength(1);
    const b = m.budgets[0];
    expect(b?.daysOver).toBe(2);
    expect(b?.daysUnder).toBe(2);
    expect(b?.streakUnder).toBe(1);
    expect(b?.days.map((d) => d.over)).toEqual([true, false, true, false]);
    expect(b?.days.map((d) => d.dayKey)).toEqual(m.activeKeys);
  });

  it('feeds the trend average from days before the range, but not before tracking began', () => {
    // A runs 2 h every day from 28 September; the range is the week of 5 October.
    const segs: Segment[] = [];
    for (let d = 28; d <= 37; d++) {
      const day = new Date(Date.UTC(2026, 8, d, 10));
      segs.push(seg(A, day.getTime(), day.getTime() + h(2)));
    }
    // On Monday 5 October A runs 9 h instead (a second block).
    segs.push(seg(A, '2026-10-05T13:00:00Z', '2026-10-05T20:00:00Z'));
    const m = build(segs, 'week', '2026-10-07T23:00:00Z');
    const t = trendSeries(m, A);
    expect(t.map((p) => p.dayKey)).toEqual(m.range.dayKeys);
    expect(t[0]?.ms).toBe(h(9));
    // Seven days ending Monday: six of 2 h and one of 9 h.
    expect(t[0]?.avgMs).toBeCloseTo((6 * h(2) + h(9)) / 7, 6);
    expect(t[2]?.ms).toBe(h(2));
    expect(t[3]?.ms).toBeNull();
    expect(t[3]?.avgMs).toBeNull();

    // Tracking that began on 4 October only averages the days that exist.
    const late = segs.filter((s) => s.startedAt >= '2026-10-04');
    const m2 = build(late, 'week', '2026-10-07T23:00:00Z');
    const t2 = trendSeries(m2, A);
    expect(m2.trendKeys[0]).toBe('2026-10-04');
    expect(t2[0]?.avgMs).toBeCloseTo((h(2) + h(9)) / 2, 6);
  });

  it('averages per active day', () => {
    const segs = [seg(A, '2026-10-05T04:00:00Z', null)];
    const m = build(segs, 'week', '2026-10-06T16:00:00Z');
    expect(m.activeKeys).toHaveLength(2);
    expect(perDay(m.totals.trackedMs, m)).toBe(h(18));
  });
});

describe('dailyByCategory', () => {
  it('agrees with the shared dailyTotals, across daylight saving changes', () => {
    // Pseudo-random contiguous segments with gaps and deletions, through both of
    // Sydney's 2026 transitions (5 April back, 4 October forward), ending open.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const segs: Segment[] = [];
    let t = Date.parse('2026-03-25T00:00:00Z');
    const stop = Date.parse('2026-10-10T00:00:00Z');
    while (t < stop) {
      const len = Math.round((5 + rnd() * 600) * MINUTE_MS);
      const kind = rnd();
      if (kind < 0.08) {
        t += len; // a gap
        continue;
      }
      const s = seg([A, B, C][Math.floor(rnd() * 3)] ?? A, t, t + len);
      if (kind > 0.97) s.deletedAt = toIso(t);
      segs.push(s);
      t += len;
    }
    const lastSeg = segs.at(-1);
    if (lastSeg) lastSeg.endedAt = null;
    const now = stop + 5 * HOUR_MS;

    for (const settings of [SYDNEY, UTC4, { timezone: 'America/New_York', dayStartHour: 0 }]) {
      const keys = resolveRange('custom', '2026-10-12', settings, {
        from: '2026-03-20',
        to: '2026-10-12',
      }).dayKeys;
      const shuffled = [...keys].reverse();
      expect(dailyByCategory(segs, shuffled, settings, now)).toEqual(
        dailyTotals(segs, keys, settings, now),
      );
    }
  });
});

describe('hourOrder', () => {
  it('starts at the day start hour and wraps', () => {
    expect(hourOrder(0)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(hourOrder(4).slice(0, 2)).toEqual([4, 5]);
    expect(hourOrder(4).slice(-4)).toEqual([0, 1, 2, 3]);
  });
});

describe('minutesPast', () => {
  it('measures in whole minutes, as the budget counts them', () => {
    expect(minutesPast(h(3) + 59_000, 180)).toBe(0);
    expect(minutesPast(h(1) + 28 * MINUTE_MS + 30_000, 180)).toBe(-92 * MINUTE_MS);
    expect(minutesPast(h(4), 180)).toBe(h(1));
  });
});

describe('performance', () => {
  it('builds a month and a year from 10,000 segments quickly', () => {
    const cats = [A, B, C, 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const now = Date.parse('2026-10-06T10:00:00.000Z');
    const lens = Array.from({ length: 10_000 }, (_, i) => (20 + ((i * 37) % 61)) * MINUTE_MS);
    let t = now - lens.reduce((a, b) => a + b, 0);
    const segs = lens.map((len, i) => {
      const s = seg(cats[i % cats.length] ?? A, t, i === lens.length - 1 ? null : t + len);
      t += len;
      return s;
    });
    const timings: Record<string, number> = {};
    for (const [kind, custom] of [
      ['month', undefined],
      ['custom', { from: '2025-10-07', to: '2026-10-06' }],
    ] as const) {
      const t0 = performance.now();
      const m = build(segs, kind, '2026-10-06T10:00:00Z', {
        settings: SYDNEY,
        rules: [rule(A, 60)],
        custom,
      });
      trendSeries(m, A);
      timings[kind] = performance.now() - t0;
      expect(m.totals.trackedMs).toBeGreaterThan(0);
    }
    console.info(`buildStats with 10,000 segments: ${JSON.stringify(timings)}`);
    // Loose bounds for slow CI; the app passes only the range's segments anyway.
    expect(timings.month).toBeLessThan(500);
    expect(timings.custom).toBeLessThan(3000);
  });
});
