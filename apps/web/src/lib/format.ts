import {
  addDaysToKey,
  dayKeyOf,
  localHHMM,
  type DayKey,
  type DaySettings,
} from '@time-tracker/shared';

/**
 * Display formatting only. All time arithmetic comes from @time-tracker/shared;
 * these helpers turn its day keys and instants into labels.
 */

function keyToUtcDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
const longFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "Mon" for a "YYYY-MM-DD" key. */
export function weekdayOfKeyLabel(key: string): string {
  return weekdayFmt.format(keyToUtcDate(key));
}

/** "Today", "Yesterday" or "Mon 5 Oct". */
export function dayLabel(dayKey: DayKey, todayKey: DayKey): string {
  if (dayKey === todayKey) return 'Today';
  if (dayKey === addDaysToKey(todayKey, -1)) return 'Yesterday';
  if (dayKey === addDaysToKey(todayKey, 1)) return 'Tomorrow';
  return longFmt.format(keyToUtcDate(dayKey));
}

/**
 * "14:05" for a moment on `dayKey`, or "Sun 23:10" when the moment belongs to
 * another logical day, so entries that cross a day boundary read correctly.
 */
export function timeOnDay(ms: number, dayKey: DayKey, settings: DaySettings): string {
  const hhmm = localHHMM(ms, settings.timezone);
  const key = dayKeyOf(ms, settings);
  return key === dayKey ? hhmm : `${weekdayOfKeyLabel(key)} ${hhmm}`;
}
