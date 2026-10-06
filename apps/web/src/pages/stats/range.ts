import {
  addDaysToKey,
  dayKeysInRange,
  dayKeysRange,
  monthEndKey,
  monthStartKey,
  weekStartKey,
  type DayKey,
  type DaySettings,
} from '@time-tracker/shared';
import { shortDateLabel } from '../../lib/format';

/**
 * The Stats screen's date ranges. Every range is a run of whole logical days
 * (docs/03: `dayStartHour` in the settings timezone), resolved from the
 * current logical day. Day keys are calendar arithmetic, so a range is the same
 * set of days in every timezone; `dayKeysRange` turns it into instants, which
 * is where daylight saving changes show up (a 23 or 25 hour day).
 */

export const RANGE_KINDS = ['today', 'week', 'last7', 'month', 'custom'] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];

export const RANGE_LABELS: Record<RangeKind, { short: string; long: string }> = {
  today: { short: 'Today', long: 'Today' },
  week: { short: 'Week', long: 'This week' },
  last7: { short: '7 days', long: 'Last 7 days' },
  month: { short: 'Month', long: 'This month' },
  custom: { short: 'Custom', long: 'Custom range' },
};

/** Custom ranges are capped so a mistyped year cannot stall the screen. */
export const MAX_CUSTOM_DAYS = 366;
/** The default custom range: the last 30 days. */
export const DEFAULT_CUSTOM_DAYS = 30;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatsRange {
  kind: RangeKind;
  /** First logical day, inclusive. */
  fromKey: DayKey;
  /** Last logical day, inclusive. May be after today for This week and This month. */
  toKey: DayKey;
  /** Every day from `fromKey` to `toKey`. */
  dayKeys: DayKey[];
  /** [start, end) of the whole range in epoch ms. */
  start: number;
  end: number;
  /** Identifies the range, for caching and stale-data checks. */
  key: string;
}

export interface CustomBounds {
  from: string | null;
  to: string | null;
}

export function isDayKey(value: string | null | undefined): value is DayKey {
  if (!value || !DAY_KEY_RE.test(value)) return false;
  // Reject 2026-02-31 and friends: a real date round-trips through addDaysToKey.
  return addDaysToKey(value, 0) === value;
}

export function isRangeKind(value: string | null | undefined): value is RangeKind {
  return (RANGE_KINDS as readonly string[]).includes(value ?? '');
}

/**
 * A custom range from two picked dates: either order, the end clamped to today
 * and the length to `MAX_CUSTOM_DAYS`. Missing or invalid dates fall back to
 * the last `DEFAULT_CUSTOM_DAYS` days.
 */
export function normaliseCustom(bounds: CustomBounds, todayKey: DayKey): [DayKey, DayKey] {
  let from = isDayKey(bounds.from) ? bounds.from : null;
  let to = isDayKey(bounds.to) ? bounds.to : null;
  if (from === null && to === null) {
    return [addDaysToKey(todayKey, -(DEFAULT_CUSTOM_DAYS - 1)), todayKey];
  }
  from ??= to ?? todayKey;
  to ??= todayKey;
  if (from > to) [from, to] = [to, from];
  if (to > todayKey) to = todayKey;
  if (from > to) from = to;
  const earliest = addDaysToKey(to, -(MAX_CUSTOM_DAYS - 1));
  if (from < earliest) from = earliest;
  return [from, to];
}

/** The first and last logical day of a range kind, relative to `todayKey`. */
export function rangeBounds(
  kind: RangeKind,
  todayKey: DayKey,
  custom: CustomBounds = { from: null, to: null },
): [DayKey, DayKey] {
  switch (kind) {
    case 'today':
      return [todayKey, todayKey];
    case 'week': {
      const monday = weekStartKey(todayKey);
      return [monday, addDaysToKey(monday, 6)];
    }
    case 'last7':
      return [addDaysToKey(todayKey, -6), todayKey];
    case 'month':
      return [monthStartKey(todayKey), monthEndKey(todayKey)];
    case 'custom':
      return normaliseCustom(custom, todayKey);
  }
}

export function resolveRange(
  kind: RangeKind,
  todayKey: DayKey,
  settings: DaySettings,
  custom?: CustomBounds,
): StatsRange {
  const [fromKey, toKey] = rangeBounds(kind, todayKey, custom);
  const { start, end } = dayKeysRange(fromKey, toKey, settings);
  return {
    kind,
    fromKey,
    toKey,
    dayKeys: dayKeysInRange(fromKey, toKey),
    start,
    end,
    key: `${kind}:${fromKey}:${toKey}:${settings.timezone}:${settings.dayStartHour}`,
  };
}

const monthYearFmt = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const withYearFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function keyDate(key: DayKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/**
 * "Mon 6 Oct – Sun 12 Oct", "October 2026", one day's label, or
 * "7 Oct 2025 – 6 Oct 2026" when the range crosses a year.
 */
export function rangeLabel(range: Pick<StatsRange, 'kind' | 'fromKey' | 'toKey'>): string {
  if (range.fromKey === range.toKey) return shortDateLabel(range.fromKey);
  if (range.kind === 'month') return monthYearFmt.format(keyDate(range.fromKey));
  if (range.fromKey.slice(0, 4) !== range.toKey.slice(0, 4)) {
    return `${withYearFmt.format(keyDate(range.fromKey))} – ${withYearFmt.format(keyDate(range.toKey))}`;
  }
  return `${shortDateLabel(range.fromKey)} – ${shortDateLabel(range.toKey)}`;
}
