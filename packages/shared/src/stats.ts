import type { Rule, Segment } from './entities';
import {
  HOUR_MS,
  dayRange,
  dayKeysRange,
  splitByDay,
  toMs,
  wholeMinutes,
  type DayKey,
  type DaySettings,
  type ISO,
} from './time';
import { TZDate } from '@date-fns/tz';

/**
 * Aggregations for the Today and Stats screens and the rule engine. All
 * durations are milliseconds. Soft-deleted segments are ignored and the open
 * segment counts up to `now`.
 */

type Instant = ISO | number;

function liveOverlapping(
  segments: readonly Segment[],
  from: number,
  to: number,
  nowMs: number,
): Segment[] {
  return segments.filter((s) => {
    if (s.deletedAt !== null) return false;
    const start = toMs(s.startedAt);
    const end = s.endedAt === null ? nowMs : toMs(s.endedAt);
    return start < to && end > from && end > start;
  });
}

/** The span of `s` inside [from, to), with the open segment ending at now. */
export function clipMs(s: Segment, from: number, to: number, nowMs: number): number {
  const start = Math.max(toMs(s.startedAt), from);
  const end = Math.min(s.endedAt === null ? nowMs : toMs(s.endedAt), to);
  return Math.max(0, end - start);
}

/** When tracking began: the earliest live segment start, or null if there is none. */
export function trackingStartMs(segments: readonly Segment[]): number | null {
  let min: number | null = null;
  for (const s of segments) {
    if (s.deletedAt !== null) continue;
    const t = toMs(s.startedAt);
    if (min === null || t < min) min = t;
  }
  return min;
}

export interface RangeTotals {
  /** Milliseconds per category id. Categories with no time are absent. */
  byCategory: Record<string, number>;
  trackedMs: number;
  /**
   * Time in the range with no segment, counted only after tracking began and
   * before now.
   */
  untrackedMs: number;
}

export function totalsForRange(
  segments: readonly Segment[],
  from: Instant,
  to: Instant,
  now: Instant,
): RangeTotals {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  const nowMs = toMs(now);
  const byCategory: Record<string, number> = {};
  let trackedMs = 0;
  for (const s of liveOverlapping(segments, fromMs, toMsValue, nowMs)) {
    const ms = clipMs(s, fromMs, toMsValue, nowMs);
    if (ms <= 0) continue;
    byCategory[s.categoryId] = (byCategory[s.categoryId] ?? 0) + ms;
    trackedMs += ms;
  }
  const first = trackingStartMs(segments);
  const spanStart = first === null ? toMsValue : Math.max(fromMs, first);
  const spanEnd = Math.min(toMsValue, nowMs);
  const untrackedMs = Math.max(0, spanEnd - spanStart - trackedMs);
  return { byCategory, trackedMs, untrackedMs };
}

/** Category totals sorted by time, largest first. */
export function sortedTotals(
  byCategory: Record<string, number>,
): Array<{ categoryId: string; ms: number }> {
  return Object.entries(byCategory)
    .map(([categoryId, ms]) => ({ categoryId, ms }))
    .sort((a, b) => b.ms - a.ms || a.categoryId.localeCompare(b.categoryId));
}

/** Milliseconds of `categoryId` in the logical day containing `now`. */
export function todayMsFor(
  segments: readonly Segment[],
  categoryId: string,
  dayKey: DayKey,
  settings: DaySettings,
  now: Instant,
): number {
  const range = dayRange(dayKey, settings);
  return totalsForRange(segments, range.start, range.end, now).byCategory[categoryId] ?? 0;
}

export type TimelineBlock =
  | {
      kind: 'segment';
      segmentId: string;
      categoryId: string;
      start: number;
      end: number;
      /** True for the running segment, whose end is now. */
      open: boolean;
    }
  | { kind: 'gap'; start: number; end: number };

export interface DayTimeline {
  dayKey: DayKey;
  /** The logical day's bounds. */
  start: number;
  end: number;
  /** Now, if it falls inside this day, else null. */
  now: number | null;
  /** Ordered blocks from tracking start (or day start) to now (or day end). */
  blocks: TimelineBlock[];
}

/**
 * Blocks for the Today bar: segments clipped to the day, with explicit gaps for
 * untracked time. Time before tracking began and after now has no block.
 */
export function timelineForDay(
  segments: readonly Segment[],
  dayKey: DayKey,
  settings: DaySettings,
  now: Instant,
): DayTimeline {
  const nowMs = toMs(now);
  const { start, end } = dayRange(dayKey, settings);
  const first = trackingStartMs(segments);
  const visibleStart = first === null ? end : Math.max(start, first);
  const visibleEnd = Math.min(end, nowMs);
  const blocks: TimelineBlock[] = [];
  const overlapping = liveOverlapping(segments, start, end, nowMs).sort(
    (a, b) => toMs(a.startedAt) - toMs(b.startedAt),
  );
  let cursor = visibleStart;
  for (const s of overlapping) {
    const sStart = Math.max(toMs(s.startedAt), start);
    const sEnd = Math.min(s.endedAt === null ? nowMs : toMs(s.endedAt), end);
    if (sEnd <= sStart) continue;
    if (sStart > cursor) blocks.push({ kind: 'gap', start: cursor, end: sStart });
    blocks.push({
      kind: 'segment',
      segmentId: s.id,
      categoryId: s.categoryId,
      start: sStart,
      end: sEnd,
      open: s.endedAt === null,
    });
    cursor = Math.max(cursor, sEnd);
  }
  if (cursor < visibleEnd) blocks.push({ kind: 'gap', start: cursor, end: visibleEnd });
  return { dayKey, start, end, now: nowMs >= start && nowMs < end ? nowMs : null, blocks };
}

/** Milliseconds per category for each logical day in `dayKeys`. */
export function dailyTotals(
  segments: readonly Segment[],
  dayKeys: readonly DayKey[],
  settings: DaySettings,
  now: Instant,
): Record<DayKey, Record<string, number>> {
  const out: Record<DayKey, Record<string, number>> = {};
  for (const k of dayKeys) out[k] = {};
  const sorted = [...dayKeys].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return out;
  const nowMs = toMs(now);
  const range = dayKeysRange(first, last, settings);
  for (const s of liveOverlapping(segments, range.start, range.end, nowMs)) {
    const sStart = Math.max(toMs(s.startedAt), range.start);
    const sEnd = Math.min(s.endedAt === null ? nowMs : toMs(s.endedAt), range.end);
    for (const piece of splitByDay(sStart, sEnd, settings)) {
      const day = out[piece.dayKey];
      if (!day) continue;
      day[s.categoryId] = (day[s.categoryId] ?? 0) + (piece.end - piece.start);
    }
  }
  return out;
}

/**
 * Milliseconds per category per local hour of day (0 to 23) across [from, to).
 * Answers "when do I spend time on what".
 */
export function hourHeatmap(
  segments: readonly Segment[],
  from: Instant,
  to: Instant,
  timezone: string,
  now: Instant,
): Record<string, number[]> {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  const nowMs = toMs(now);
  const out: Record<string, number[]> = {};
  for (const s of liveOverlapping(segments, fromMs, toMsValue, nowMs)) {
    const start = Math.max(toMs(s.startedAt), fromMs);
    const end = Math.min(s.endedAt === null ? nowMs : toMs(s.endedAt), toMsValue);
    const row = (out[s.categoryId] ??= Array.from({ length: 24 }, () => 0));
    let cursor = start;
    while (cursor < end) {
      const local = new TZDate(cursor, timezone);
      const intoHour =
        local.getMinutes() * 60_000 + local.getSeconds() * 1000 + local.getMilliseconds();
      const next = Math.min(end, cursor - intoHour + HOUR_MS);
      const hour = local.getHours();
      row[hour] = (row[hour] ?? 0) + (next - cursor);
      cursor = next;
    }
  }
  return out;
}

export interface BudgetStatus {
  ruleId: string;
  categoryId: string;
  thresholdMin: number;
  daysOver: number;
  daysUnder: number;
  /** Consecutive days under budget, counting back from the last day in range. */
  streakUnder: number;
}

/**
 * For each enabled daily rule, how many days in `dayKeys` stayed under or went
 * over its threshold. `daily` comes from `dailyTotals`.
 */
export function budgetStatus(
  rules: readonly Rule[],
  daily: Record<DayKey, Record<string, number>>,
  dayKeys: readonly DayKey[],
): BudgetStatus[] {
  return rules
    .filter((r) => r.kind === 'daily' && r.enabled && r.deletedAt === null)
    .map((r) => {
      let daysOver = 0;
      let daysUnder = 0;
      let streakUnder = 0;
      let streakBroken = false;
      for (let i = dayKeys.length - 1; i >= 0; i--) {
        const key = dayKeys[i];
        if (key === undefined) continue;
        const minutes = wholeMinutes(daily[key]?.[r.categoryId] ?? 0);
        const over = minutes >= r.thresholdMin;
        if (over) daysOver++;
        else daysUnder++;
        if (!streakBroken) {
          if (over) streakBroken = true;
          else streakUnder++;
        }
      }
      return {
        ruleId: r.id,
        categoryId: r.categoryId,
        thresholdMin: r.thresholdMin,
        daysOver,
        daysUnder,
        streakUnder,
      };
    });
}

/** Trailing moving average over up to `window` values, including the current one. */
export function movingAverage(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= window) sum -= values[i - window] ?? 0;
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}
