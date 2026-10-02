import { TZDate } from '@date-fns/tz';
import { format, subDays } from 'date-fns';

/** ISO 8601 UTC timestamp with milliseconds, e.g. "2026-10-02T03:15:00.000Z". */
export type ISO = string;

/** Logical day as "YYYY-MM-DD", per the settings timezone and dayStartHour. */
export type DayKey = string;

/** The parts of Settings that decide which logical day a moment belongs to. */
export interface DaySettings {
  /** IANA timezone, e.g. "Australia/Sydney". */
  timezone: string;
  /** Local hour, 0 to 23, at which a logical day starts. */
  dayStartHour: number;
}

/**
 * The logical day a moment belongs to: convert it to the settings timezone, step
 * back dayStartHour hours of wall-clock time, and take the calendar date. With
 * dayStartHour 4, a 01:00 moment belongs to the previous day.
 *
 * Wall-clock hours are compared instead of subtracting elapsed milliseconds, so
 * the boundary stays at dayStartHour local time on daylight saving change days.
 */
export function dayKeyOf(t: ISO | Date, settings: DaySettings): DayKey {
  const ms = typeof t === 'string' ? Date.parse(t) : t.getTime();
  const local = new TZDate(ms, settings.timezone);
  const day = local.getHours() < settings.dayStartHour ? subDays(local, 1) : local;
  return format(day, 'yyyy-MM-dd');
}
