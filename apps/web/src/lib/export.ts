import {
  addDaysToKey,
  dayKeysRange,
  localDate,
  localHHMM,
  monthEndKey,
  monthStartKey,
  SETTINGS_ID,
  toIso,
  toMs,
  wholeMinutes,
  type Category,
  type DayKey,
  type DaySettings,
  type Rule,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { db } from '../db';

/**
 * Export built on the phone from Dexie, in exactly the formats of
 * `GET /api/export.csv` and `GET /api/export.json` (docs/04 "Export"). Local
 * generation works offline and needs no token, so the app never calls the
 * endpoints; Shortcuts and scripts still can.
 */

export const CSV_COLUMNS = [
  'started_at',
  'ended_at',
  'category',
  'minutes',
  'note',
  'source',
  'started_at_utc',
] as const;

/** RFC 4180: quote a field that holds a comma, quote, CR or LF, doubling inner quotes. */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "2026-10-02 13:15", wall-clock time in `timezone`. */
function localDateTime(iso: string, timezone: string): string {
  return `${localDate(iso, timezone)} ${localHHMM(iso, timezone)}`;
}

/**
 * One row per segment, in the order given, CRLF line endings. Local times are
 * in `timezone`; `started_at_utc` keeps the exact instant (and tells apart the
 * repeated hour when daylight saving ends). The open segment has an empty
 * `ended_at` and counts its minutes up to `nowMs`. Minutes round down.
 */
export function segmentsCsv(
  segments: readonly Segment[],
  categories: ReadonlyMap<string, Category>,
  timezone: string,
  nowMs: number,
): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const s of segments) {
    const end = s.endedAt === null ? nowMs : toMs(s.endedAt);
    lines.push(
      [
        localDateTime(s.startedAt, timezone),
        s.endedAt === null ? '' : localDateTime(s.endedAt, timezone),
        categories.get(s.categoryId)?.name ?? '',
        wholeMinutes(end - toMs(s.startedAt)),
        s.note ?? '',
        s.source,
        s.startedAt,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export interface ExportJson {
  /** Every non-deleted category, archived ones included. */
  categories: Category[];
  /** Non-deleted segments overlapping the range, whole, oldest first. */
  segments: Segment[];
  /** Every non-deleted rule. */
  rules: Rule[];
  /** The stored settings, or null if there are none. */
  settings: Settings | null;
}

/** Bounds in epoch ms; null means open-ended, like the endpoints' missing from or to. */
export interface ExportBounds {
  from: number | null;
  to: number | null;
}

export const EXPORT_RANGES = ['all', 'last30', 'month', 'lastMonth', 'custom'] as const;
export type ExportRange = (typeof EXPORT_RANGES)[number];

export const EXPORT_RANGE_LABELS: Record<ExportRange, string> = {
  all: 'All time',
  last30: 'Last 30 days',
  month: 'This month',
  lastMonth: 'Last month',
  custom: 'Custom',
};

/**
 * The first and last logical day of an export range, or null for all time.
 * Custom dates may come in either order.
 */
export function exportRangeKeys(
  range: ExportRange,
  todayKey: DayKey,
  custom: { from: DayKey; to: DayKey },
): [DayKey, DayKey] | null {
  switch (range) {
    case 'all':
      return null;
    case 'last30':
      return [addDaysToKey(todayKey, -29), todayKey];
    case 'month':
      return [monthStartKey(todayKey), monthEndKey(todayKey)];
    case 'lastMonth': {
      const prev = addDaysToKey(monthStartKey(todayKey), -1);
      return [monthStartKey(prev), prev];
    }
    case 'custom':
      return custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
  }
}

/** Export bounds covering whole logical days, per the settings timezone and day start. */
export function exportBounds(keys: [DayKey, DayKey] | null, settings: DaySettings): ExportBounds {
  if (keys === null) return { from: null, to: null };
  const { start, end } = dayKeysRange(keys[0], keys[1], settings);
  return { from: start, to: end };
}

function isLive<T extends { deletedAt: string | null }>(row: T): boolean {
  return row.deletedAt === null;
}

function byStart(a: Segment, b: Segment): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id.localeCompare(b.id);
}

/**
 * Live segments overlapping [from, to), whole and oldest first, read by the
 * `startedAt` index: those starting inside the range plus the one before it
 * if it reaches in (segments never overlap, so no other earlier one can).
 */
export async function exportSegments(bounds: ExportBounds): Promise<Segment[]> {
  const upper = bounds.to === null ? null : toIso(bounds.to);
  const lower = bounds.from === null ? null : toIso(bounds.from);
  const startsInside =
    lower === null
      ? upper === null
        ? db.segments.orderBy('startedAt')
        : db.segments.where('startedAt').below(upper)
      : upper === null
        ? db.segments.where('startedAt').aboveOrEqual(lower)
        : db.segments.where('startedAt').between(lower, upper, true, false);
  const [inside, before] = await Promise.all([
    startsInside.toArray().then((rows) => rows.filter(isLive)),
    lower === null
      ? Promise.resolve(undefined)
      : db.segments.where('startedAt').below(lower).reverse().filter(isLive).first(),
  ]);
  const rows = [...inside];
  // Same test as the server: the open segment runs on, a closed one must end after `from`.
  if (before && lower !== null && (before.endedAt === null || before.endedAt > lower)) {
    rows.push(before);
  }
  return rows.sort(byStart);
}

export async function exportJson(bounds: ExportBounds): Promise<ExportJson> {
  const [categories, segments, rules, settings] = await Promise.all([
    db.categories
      .toArray()
      .then((rows) => rows.filter(isLive).sort((a, b) => a.sortOrder - b.sortOrder)),
    exportSegments(bounds),
    db.rules.toArray().then((rows) => rows.filter(isLive)),
    db.settings.get(SETTINGS_ID),
  ]);
  return { categories, segments, rules, settings: settings ?? null };
}

export async function exportCsv(
  bounds: ExportBounds,
  nowMs: number,
): Promise<{
  text: string;
  count: number;
}> {
  const [segments, categories, settings] = await Promise.all([
    exportSegments(bounds),
    // Every category, deleted ones too, so an old segment still gets its name.
    db.categories.toArray(),
    db.settings.get(SETTINGS_ID),
  ]);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const text = segmentsCsv(segments, byId, settings?.timezone ?? 'UTC', nowMs);
  return { text, count: segments.length };
}

export type ExportFormat = 'csv' | 'json';

/** "time-tracker-2026-10-06.csv", dated by the local day of export. */
export function exportFileName(format: ExportFormat, dateKey: string): string {
  return `time-tracker-${dateKey}.${format}`;
}

export const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
};

export interface BuiltExport {
  file: File;
  /** Segments in the file. */
  count: number;
}

/** The export as a File, ready to share or download. */
export async function buildExportFile(
  format: ExportFormat,
  bounds: ExportBounds,
  dateKey: string,
  nowMs: number = Date.now(),
): Promise<BuiltExport> {
  let body: string;
  let count: number;
  if (format === 'csv') {
    const csv = await exportCsv(bounds, nowMs);
    body = csv.text;
    count = csv.count;
  } else {
    const json = await exportJson(bounds);
    body = JSON.stringify(json, null, 2);
    count = json.segments.length;
  }
  const file = new File([body], exportFileName(format, dateKey), { type: EXPORT_MIME[format] });
  return { file, count };
}
