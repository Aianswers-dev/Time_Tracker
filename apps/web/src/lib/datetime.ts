import { addDaysToKey, localDate, localDateTimeToMs, localHHMM } from '@time-tracker/shared';

/** What a pair of date and time inputs hold, in the settings timezone. */
export interface LocalParts {
  date: string;
  time: string;
}

export function toParts(ms: number, timezone: string): LocalParts {
  return { date: localDate(ms, timezone), time: localHHMM(ms, timezone) };
}

/** The instant for a date and time input pair, or null while either is incomplete. */
export function partsToMs(parts: LocalParts, timezone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts.date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(parts.time)) {
    return null;
  }
  try {
    return localDateTimeToMs(parts.date, parts.time, timezone);
  } catch {
    return null;
  }
}

export function sameParts(a: LocalParts, b: LocalParts): boolean {
  return a.date === b.date && a.time === b.time;
}

/**
 * A wall-clock time picked without a date: today in the settings timezone, or
 * yesterday if that would be later than now ("I started at 23:30" said at 00:10).
 */
export function clockTimeToMs(hhmm: string, nowMs: number, timezone: string): number | null {
  const today = localDate(nowMs, timezone);
  const ms = partsToMs({ date: today, time: hhmm }, timezone);
  if (ms === null) return null;
  return ms > nowMs ? partsToMs({ date: addDaysToKey(today, -1), time: hhmm }, timezone) : ms;
}
