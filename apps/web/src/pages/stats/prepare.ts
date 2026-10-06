import {
  addDaysToKey,
  budgetStatus,
  dayKeyOf,
  dayKeysInRange,
  dayRange,
  hourHeatmap,
  movingAverage,
  sortedTotals,
  toMs,
  totalsForRange,
  trackingStartMs,
  wholeMinutes,
  MINUTE_MS,
  type BudgetStatus,
  type DayKey,
  type DaySettings,
  type Rule,
  type Segment,
} from '@time-tracker/shared';
import type { StatsRange } from './range';

/**
 * Chart data for the Stats screen. Every number comes from the shared
 * aggregation functions (docs/03 "Aggregation"); this module only arranges
 * their output for the charts: stack order, which days have happened, hour
 * columns starting at the day start, and the trend's moving average window.
 */

/** The trend line's moving average covers this many days. */
export const TREND_WINDOW = 7;
/** Days loaded before a range so the first point of the average has a full window. */
export const LOOKBACK_DAYS = TREND_WINDOW - 1;

export interface StatsInput {
  /** Live segments overlapping the range and its lookback, plus the earliest live segment. */
  segments: readonly Segment[];
  rules: readonly Rule[];
  settings: DaySettings;
  range: StatsRange;
  todayKey: DayKey;
  now: number;
}

export interface TotalRow {
  categoryId: string;
  ms: number;
  /** Share of the range's elapsed, tracked-or-untracked time, 0 to 1. */
  share: number;
}

export type DayStatus = 'active' | 'future' | 'before-tracking';

export interface DayColumn {
  dayKey: DayKey;
  /** Category time in stack order (largest over the range first). Zero entries are left out. */
  parts: Array<{ categoryId: string; ms: number }>;
  trackedMs: number;
  /** Time in the day with no segment, after tracking began and before now. */
  untrackedMs: number;
  status: DayStatus;
  isToday: boolean;
}

export interface HeatRow {
  categoryId: string;
  totalMs: number;
  /** Milliseconds in each local hour, in `Heatmap.hours` order. */
  cells: number[];
}

export interface Heatmap {
  /** Local hours of the day in display order, starting at the day start hour. */
  hours: number[];
  rows: HeatRow[];
  /** Days the time is spread over (the range's active days), at least 1. */
  days: number;
}

export interface BudgetDay {
  dayKey: DayKey;
  ms: number;
  over: boolean;
}

export interface BudgetView extends BudgetStatus {
  /** One entry per active day, oldest first. */
  days: BudgetDay[];
}

export interface StatsModel {
  range: StatsRange;
  /** False until the first segment exists. */
  hasData: boolean;
  trackingStartKey: DayKey | null;
  /** Days in the range that have started and are on or after the day tracking began. */
  activeKeys: DayKey[];
  totals: {
    rows: TotalRow[];
    trackedMs: number;
    untrackedMs: number;
    /** trackedMs + untrackedMs: the elapsed time the shares are of. */
    spanMs: number;
  };
  /** Category ids by total time in the range, largest first. Fixes stack and row order. */
  order: string[];
  days: DayColumn[];
  heatmap: Heatmap;
  budgets: BudgetView[];
  /** Per-day, per-category time for the range and its lookback (as `dailyTotals` gives it). */
  daily: Record<DayKey, Record<string, number>>;
  /** Days that feed the trend average: lookback and range, tracked and not in the future. */
  trendKeys: DayKey[];
}

/**
 * Milliseconds per category for each logical day in `dayKeys`: the same numbers
 * as the shared `dailyTotals` (prepare.test.ts checks they agree, daylight
 * saving included), because `dayRange(k)` holds exactly the instants that
 * `dayKeyOf` assigns to `k`. It asks the shared `totalsForRange` about each
 * day's own segments, one `dayRange` per day, instead of splitting every
 * segment at day boundaries, so a year of 10,000 segments takes milliseconds
 * rather than a quarter of a second. Relies on live segments never
 * overlapping (I2), which keeps their ends in start order.
 */
export function dailyByCategory(
  segments: readonly Segment[],
  dayKeys: readonly DayKey[],
  settings: DaySettings,
  now: number,
): Record<DayKey, Record<string, number>> {
  const live = segments
    .filter((s) => s.deletedAt === null)
    .map((s) => ({ s, start: toMs(s.startedAt), end: s.endedAt === null ? now : toMs(s.endedAt) }))
    .sort((a, b) => a.start - b.start);
  const out: Record<DayKey, Record<string, number>> = {};
  let first = 0;
  for (const dayKey of [...dayKeys].sort()) {
    const { start, end } = dayRange(dayKey, settings);
    while (first < live.length && (live[first]?.end ?? 0) <= start) first++;
    let last = first;
    while (last < live.length && (live[last]?.start ?? Infinity) < end) last++;
    out[dayKey] =
      last > first
        ? totalsForRange(
            live.slice(first, last).map((x) => x.s),
            start,
            end,
            now,
          ).byCategory
        : {};
  }
  return out;
}

function keysBetween(from: DayKey, to: DayKey): DayKey[] {
  return from > to ? [] : dayKeysInRange(from, to);
}

/** Local hours starting at the logical day's first hour: 4, 5, ... 23, 0, ... 3. */
export function hourOrder(dayStartHour: number): number[] {
  return Array.from({ length: 24 }, (_, i) => (dayStartHour + i) % 24);
}

export function buildStats(input: StatsInput): StatsModel {
  const { segments, rules, settings, range, todayKey, now } = input;
  const firstMs = trackingStartMs(segments);
  const trackingStartKey = firstMs === null ? null : dayKeyOf(firstMs, settings);

  const lastActive = range.toKey < todayKey ? range.toKey : todayKey;
  const activeKeys =
    trackingStartKey === null
      ? []
      : keysBetween(
          range.fromKey > trackingStartKey ? range.fromKey : trackingStartKey,
          lastActive,
        );

  // Totals over the whole range. The open segment counts to now.
  const totals = totalsForRange(segments, range.start, range.end, now);
  const order = sortedTotals(totals.byCategory).map((t) => t.categoryId);
  const spanMs = totals.trackedMs + totals.untrackedMs;
  const rows = order.map((categoryId) => {
    const ms = totals.byCategory[categoryId] ?? 0;
    return { categoryId, ms, share: spanMs > 0 ? ms / spanMs : 0 };
  });

  // One pass covers the bars, the budgets and the trend's lookback.
  const lookbackFrom = addDaysToKey(range.fromKey, -LOOKBACK_DAYS);
  const daily = dailyByCategory(segments, keysBetween(lookbackFrom, range.toKey), settings, now);

  const days: DayColumn[] = range.dayKeys.map((dayKey) => {
    const status: DayStatus =
      dayKey > todayKey
        ? 'future'
        : trackingStartKey === null || dayKey < trackingStartKey
          ? 'before-tracking'
          : 'active';
    const byCat = daily[dayKey] ?? {};
    const parts = order
      .map((categoryId) => ({ categoryId, ms: byCat[categoryId] ?? 0 }))
      .filter((p) => p.ms > 0);
    const trackedMs = parts.reduce((sum, p) => sum + p.ms, 0);
    let untrackedMs = 0;
    if (status === 'active' && firstMs !== null) {
      // Same rule as totalsForRange: untracked only after tracking began and before now.
      const { start, end } = dayRange(dayKey, settings);
      const visible = Math.min(end, now) - Math.max(start, firstMs);
      untrackedMs = Math.max(0, visible - trackedMs);
    }
    return { dayKey, parts, trackedMs, untrackedMs, status, isToday: dayKey === todayKey };
  });

  const hours = hourOrder(settings.dayStartHour);
  const byHour = hourHeatmap(segments, range.start, range.end, settings.timezone, now);
  const heatRows: HeatRow[] = order.map((categoryId) => {
    const raw = byHour[categoryId] ?? [];
    return {
      categoryId,
      totalMs: totals.byCategory[categoryId] ?? 0,
      cells: hours.map((h) => raw[h] ?? 0),
    };
  });

  const budgets: BudgetView[] = budgetStatus(rules, daily, activeKeys).map((status) => {
    const rule = rules.find((r) => r.id === status.ruleId);
    return {
      ...status,
      days: activeKeys.map((dayKey) => ({
        dayKey,
        ms: daily[dayKey]?.[status.categoryId] ?? 0,
        // Ask the shared function about each day alone, so "over" means exactly
        // what the counts and the nudges mean.
        over: rule ? (budgetStatus([rule], daily, [dayKey])[0]?.daysOver ?? 0) > 0 : false,
      })),
    };
  });

  const trendKeys =
    trackingStartKey === null
      ? []
      : keysBetween(lookbackFrom > trackingStartKey ? lookbackFrom : trackingStartKey, lastActive);

  return {
    range,
    hasData: firstMs !== null,
    trackingStartKey,
    activeKeys,
    totals: {
      rows,
      trackedMs: totals.trackedMs,
      untrackedMs: totals.untrackedMs,
      spanMs,
    },
    order,
    days,
    heatmap: { hours, rows: heatRows, days: Math.max(1, activeKeys.length) },
    budgets,
    daily,
    trendKeys,
  };
}

export interface TrendPoint {
  dayKey: DayKey;
  /** The category's time that day, or null for a day that has not happened or was not tracked. */
  ms: number | null;
  /** Trailing average over up to `TREND_WINDOW` tracked days, null where `ms` is null. */
  avgMs: number | null;
}

/**
 * Minutes per day for one category across the range, with a trailing 7-day
 * moving average. The average reaches back into the lookback days, so the
 * first day of a week already has a full window, but never before tracking began.
 */
export function trendSeries(model: StatsModel, categoryId: string): TrendPoint[] {
  const values = model.trendKeys.map((k) => model.daily[k]?.[categoryId] ?? 0);
  const averages = movingAverage(values, TREND_WINDOW);
  const byKey = new Map<DayKey, { ms: number; avg: number }>();
  model.trendKeys.forEach((k, i) => byKey.set(k, { ms: values[i] ?? 0, avg: averages[i] ?? 0 }));
  return model.range.dayKeys.map((dayKey) => {
    const hit = byKey.get(dayKey);
    return { dayKey, ms: hit?.ms ?? null, avgMs: hit?.avg ?? null };
  });
}

/** Average time per active day, for "a day" figures. */
export function perDay(ms: number, model: Pick<StatsModel, 'activeKeys'>): number {
  return ms / Math.max(1, model.activeKeys.length);
}

/**
 * How far `ms` is past a budget of `thresholdMin`, in whole-minute steps as
 * the budget counts them: positive when over, negative when under.
 */
export function minutesPast(ms: number, thresholdMin: number): number {
  return (wholeMinutes(ms) - thresholdMin) * MINUTE_MS;
}
