import {
  formatDuration,
  HOUR_MS,
  MINUTE_MS,
  weekdayOfKey,
  type DayKey,
} from '@time-tracker/shared';
import { weekdayOfKeyLabel } from '../../lib/format';

/**
 * Pure helpers for the hand-rolled SVG charts: axis ticks, day labels, mark
 * geometry and the heatmap's colour steps. No time arithmetic happens here;
 * day keys and durations come from the shared package.
 */

const TICK_STEPS_MS = [
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  4 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
];

/**
 * A clean duration axis from 0 to at least `maxMs`, with at most `maxTicks`
 * intervals. Steps are whole minutes or hours, so labels read "30m" or "2h".
 */
export function durationTicks(maxMs: number, maxTicks = 4): { max: number; ticks: number[] } {
  const target = Math.max(maxMs, 15 * MINUTE_MS);
  const step =
    TICK_STEPS_MS.find((s) => Math.ceil(target / s) <= maxTicks) ??
    TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ??
    HOUR_MS;
  const max = Math.ceil(target / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1; t += step) ticks.push(t);
  return { max, ticks };
}

/** Axis tick text: "0", "45m", "2h", "1h30". */
export function formatTick(ms: number): string {
  if (ms === 0) return '0';
  const minutes = Math.round(ms / MINUTE_MS);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/**
 * A stat tile value: "52h 1m", or whole hours ("1,419h") from 100 hours up, so
 * a long range's total still fits a half-width tile (dataviz: auto-compact).
 */
export function compactDuration(ms: number): string {
  const hours = Math.floor(Math.max(0, ms) / HOUR_MS);
  return hours >= 100 ? `${hours.toLocaleString()}h` : formatDuration(ms);
}

/** "35%", or "<1%" for a sliver that would otherwise round to zero. */
export function formatShare(share: number): string {
  if (share <= 0) return '0%';
  const pct = Math.round(share * 100);
  return pct === 0 ? '<1%' : `${pct}%`;
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });

function monthLabel(key: DayKey): string {
  const [y, m] = key.split('-').map(Number);
  return monthFmt.format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)));
}

function dayOfMonth(key: DayKey): number {
  return Number(key.slice(8, 10));
}

export interface DayAxisLabel {
  index: number;
  text: string;
  /** A second line under the first, for weekday-plus-date labels. */
  sub?: string;
}

/**
 * Labels for a day axis, chosen so they never collide at phone width: every
 * day for a week ("Mon" over "6"), Mondays for up to two months ("6 Oct",
 * "13"), month starts beyond that ("Oct").
 */
export function dayAxisLabels(dayKeys: readonly DayKey[], plotWidth: number): DayAxisLabel[] {
  const n = dayKeys.length;
  if (n === 0) return [];
  const slot = plotWidth / n;
  if (n <= 7) {
    return dayKeys.map((k, index) => ({
      index,
      text: weekdayOfKeyLabel(k),
      sub: String(dayOfMonth(k)),
    }));
  }
  if (n <= 62) {
    const withMonth = slot * 7 >= 40;
    const out: DayAxisLabel[] = [];
    let lastMonth = '';
    const label = (k: DayKey, index: number, monthFits = withMonth) => {
      const month = k.slice(0, 7);
      const named = monthFits && month !== lastMonth;
      if (named) lastMonth = month;
      out.push({ index, text: named ? `${dayOfMonth(k)} ${monthLabel(k)}` : `${dayOfMonth(k)}` });
    };
    // Label the first day too when the first Monday leaves room: with its month
    // if that fits, else just the date (the next label then carries the month).
    const firstMonday = dayKeys.findIndex((k) => weekdayOfKey(k) === 0);
    const first = dayKeys[0];
    const room = firstMonday === -1 ? Infinity : firstMonday * slot;
    if (first !== undefined && firstMonday !== 0 && room >= 18) {
      label(first, 0, withMonth && room >= 46);
    }
    dayKeys.forEach((k, index) => {
      if (weekdayOfKey(k) === 0) label(k, index);
    });
    return out;
  }
  const starts = dayKeys
    .map((k, index) => ({ k, index }))
    .filter(({ k, index }) => index === 0 || dayOfMonth(k) === 1);
  const monthSlot = slot * 30;
  const every = monthSlot >= 28 ? 1 : monthSlot >= 14 ? 2 : 3;
  return starts
    .filter(({ k }) => dayOfMonth(k) === 1)
    .filter((_, i) => i % every === 0)
    .map(({ k, index }) => ({ index, text: monthLabel(k) }));
}

/**
 * Bar geometry for `n` slots across `width`: bars at most 24 px, at least a
 * 2 px surface gap between neighbours (dataviz mark spec).
 */
export function barLayout(n: number, width: number): { slot: number; bar: number } {
  const slot = n > 0 ? width / n : width;
  const gap = Math.max(2, slot * 0.32);
  return { slot, bar: Math.max(1, Math.min(24, slot - gap)) };
}

/** A rectangle with only its top corners rounded, square on the baseline. */
export function roundedTopRect(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M${x},${y + h}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h}`,
    'Z',
  ].join('');
}

/** Heatmap step bounds in minutes per day in that hour: 0 is empty, then five steps. */
export const HEAT_STEPS_MIN = [1, 10, 20, 35, 50] as const;

/**
 * The heatmap step, 0 to 5, for an average of `minPerDay` minutes per day in
 * one hour. Under a minute a day reads as empty.
 */
export function heatLevel(minPerDay: number): number {
  let level = 0;
  HEAT_STEPS_MIN.forEach((bound, i) => {
    if (minPerDay >= bound) level = i + 1;
  });
  return level;
}

export const HEAT_FILLS = [
  'var(--heat-0)',
  'var(--heat-1)',
  'var(--heat-2)',
  'var(--heat-3)',
  'var(--heat-4)',
  'var(--heat-5)',
] as const;

/** "04", "13" for an hour of the day. */
export function hourLabel(hour: number): string {
  return String(hour).padStart(2, '0');
}

/** The slot index under a pointer at `x` pixels across `width`, clamped. */
export function indexAt(x: number, width: number, n: number): number {
  if (n <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(n - 1, Math.floor((x / width) * n)));
}
