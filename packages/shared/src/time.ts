import { TZDate, tzOffset } from '@date-fns/tz';
import { format } from 'date-fns';

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

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Milliseconds since the epoch for an ISO string, Date or number. */
export function toMs(t: ISO | Date | number): number {
  if (typeof t === 'number') return t;
  return typeof t === 'string' ? Date.parse(t) : t.getTime();
}

/** Normalised ISO string ("...T03:15:00.000Z") for an ISO string, Date or number. */
export function toIso(t: ISO | Date | number): ISO {
  return new Date(toMs(t)).toISOString();
}

/**
 * The UTC offset of `timezone` at instant `ms`, in milliseconds (positive east
 * of UTC). Uses Intl through `tzOffset`, so it does not depend on the runtime's
 * own timezone.
 */
function offsetMs(timezone: string, ms: number): number {
  const minutes = tzOffset(timezone, new Date(ms));
  if (Number.isNaN(minutes)) throw new RangeError(`Unknown timezone: ${timezone}`);
  return Math.round(minutes * MINUTE_MS);
}

/** The local wall-clock time at `ms` in `timezone`, encoded as a UTC epoch value. */
function wallClockMs(ms: number, timezone: string): number {
  return ms + offsetMs(timezone, ms);
}

/**
 * The instant at which the local wall clock in `timezone` reads `wall` (a
 * wall-clock time encoded as a UTC epoch value). When clocks go back and the
 * time happens twice, the first occurrence. When clocks go forward over it, the
 * time is shifted forward by the gap (02:30 becomes 03:30), as JavaScript's
 * `Date` does.
 *
 * Built on offsets rather than TZDate's wall-clock constructor, whose answer
 * for repeated and skipped times depends on the runtime's own timezone, so the
 * phone and the server would disagree.
 */
function instantOfWallClock(wall: number, timezone: string): number {
  const before = offsetMs(timezone, wall - DAY_MS);
  const after = offsetMs(timezone, wall + DAY_MS);
  const candidates = [wall - before, wall - after].sort((a, b) => a - b);
  for (const t of candidates) {
    if (wallClockMs(t, timezone) === wall) return t;
  }
  // Skipped by a forward transition: read the wall time with the offset in force before it.
  return wall - before;
}

/**
 * The logical day a moment belongs to: convert it to the settings timezone, step
 * back dayStartHour hours of wall-clock time, and take the calendar date. With
 * dayStartHour 4, a 01:00 moment belongs to the previous day.
 *
 * Wall-clock hours are compared instead of subtracting elapsed milliseconds, so
 * the boundary stays at dayStartHour local time on daylight saving change days.
 */
export function dayKeyOf(t: ISO | Date | number, settings: DaySettings): DayKey {
  const wall = new Date(wallClockMs(toMs(t), settings.timezone));
  const date = wall.toISOString().slice(0, 10);
  return wall.getUTCHours() < settings.dayStartHour ? addDaysToKey(date, -1) : date;
}

function parseDayKey(dayKey: DayKey): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error(`Invalid day key: ${dayKey}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function formatUtcDate(ms: number): DayKey {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar arithmetic on day keys, independent of any timezone. */
export function addDaysToKey(dayKey: DayKey, days: number): DayKey {
  const { y, m, d } = parseDayKey(dayKey);
  return formatUtcDate(Date.UTC(y, m - 1, d + days));
}

/** Every day key from `from` to `to`, both inclusive. Empty when `to` is before `from`. */
export function dayKeysInRange(from: DayKey, to: DayKey): DayKey[] {
  const keys: DayKey[] = [];
  for (let k = from; k <= to; k = addDaysToKey(k, 1)) keys.push(k);
  return keys;
}

/** Day of week for a day key, 0 = Monday through 6 = Sunday. */
export function weekdayOfKey(dayKey: DayKey): number {
  const { y, m, d } = parseDayKey(dayKey);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `dayKey`. Weeks start on Monday. */
export function weekStartKey(dayKey: DayKey): DayKey {
  return addDaysToKey(dayKey, -weekdayOfKey(dayKey));
}

/** The first day of the month containing `dayKey`. */
export function monthStartKey(dayKey: DayKey): DayKey {
  return `${dayKey.slice(0, 7)}-01`;
}

/** The last day of the month containing `dayKey`. */
export function monthEndKey(dayKey: DayKey): DayKey {
  const { y, m } = parseDayKey(dayKey);
  return formatUtcDate(Date.UTC(y, m, 0));
}

/** A half-open interval [start, end) in epoch milliseconds. */
export interface MsRange {
  start: number;
  end: number;
}

/**
 * The instants a logical day covers: from `dayStartHour` local time on `dayKey`
 * to `dayStartHour` local time on the next calendar day. Usually 24 hours, 23 or
 * 25 on daylight saving change days. If `dayStartHour` happens twice (clocks
 * going back), the day starts at the first one, matching `dayKeyOf`.
 */
export function dayRange(dayKey: DayKey, settings: DaySettings): MsRange {
  const { y, m, d } = parseDayKey(dayKey);
  const h = settings.dayStartHour;
  return {
    start: instantOfWallClock(Date.UTC(y, m - 1, d, h), settings.timezone),
    end: instantOfWallClock(Date.UTC(y, m - 1, d + 1, h), settings.timezone),
  };
}

/** The range covering logical days `from` through `to`, both inclusive. */
export function dayKeysRange(from: DayKey, to: DayKey, settings: DaySettings): MsRange {
  return { start: dayRange(from, settings).start, end: dayRange(to, settings).end };
}

/** A piece of a time span that falls inside one logical day. */
export interface DayPiece {
  dayKey: DayKey;
  start: number;
  end: number;
}

/**
 * Slice the span [start, end) at logical day boundaries. Use `end = now` for the
 * open segment. Returns nothing for an empty or inverted span.
 */
export function splitByDay(start: number, end: number, settings: DaySettings): DayPiece[] {
  const pieces: DayPiece[] = [];
  let cursor = start;
  while (cursor < end) {
    const dayKey = dayKeyOf(cursor, settings);
    const range = dayRange(dayKey, settings);
    // Guard against a timezone database quirk leaving the cursor outside its own day.
    if (range.end <= cursor) break;
    const pieceEnd = Math.min(end, range.end);
    pieces.push({ dayKey, start: cursor, end: pieceEnd });
    cursor = pieceEnd;
  }
  return pieces;
}

/** Local wall-clock "HH:MM" for a moment in a timezone. */
export function localHHMM(t: ISO | Date | number, timezone: string): string {
  return format(new TZDate(toMs(t), timezone), 'HH:mm');
}

/** The local hour, 0 to 23, of a moment in a timezone. */
export function localHour(t: ISO | Date | number, timezone: string): number {
  return new TZDate(toMs(t), timezone).getHours();
}

/** The calendar date "YYYY-MM-DD" of a moment in a timezone (ignores dayStartHour). */
export function localDate(t: ISO | Date | number, timezone: string): string {
  return format(new TZDate(toMs(t), timezone), 'yyyy-MM-dd');
}

/**
 * Convert a local calendar date and wall-clock time in a timezone to an instant.
 * `date` is "YYYY-MM-DD", `time` is "HH:MM" or "HH:MM:SS". A time that happens
 * twice (clocks going back) gives the first occurrence; a time skipped by
 * clocks going forward is shifted forward by the gap.
 */
export function localDateTimeToMs(date: string, time: string, timezone: string): number {
  const { y, m, d } = parseDayKey(date);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new Error(`Invalid time: ${time}`);
  const wall = Date.UTC(y, m - 1, d, Number(match[1]), Number(match[2]), Number(match[3] ?? 0));
  return instantOfWallClock(wall, timezone);
}

/**
 * Whether local time `hhmm` falls inside the quiet window [start, end). A window
 * whose start is after its end crosses midnight. Equal start and end is an empty
 * window. Both null means no quiet hours.
 */
export function isInQuietWindow(hhmm: string, start: string | null, end: string | null): boolean {
  if (start === null || end === null || start === end) return false;
  if (start < end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

/** Whole minutes in a span of milliseconds, rounded down. */
export function wholeMinutes(ms: number): number {
  return Math.floor(Math.max(0, ms) / MINUTE_MS);
}

/** "1h 12m", "45m" or "0m". Rounds down to whole minutes. */
export function formatDuration(ms: number): string {
  const total = wholeMinutes(ms);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "1:02:03" or "0:00:45", for the running timer. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / SECOND_MS);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
