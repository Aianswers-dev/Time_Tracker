import {
  isoSchema,
  localDate,
  localHHMM,
  toMs,
  wholeMinutes,
  type Category,
  type Segment,
} from '@time-tracker/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDb } from '../db/client';
import {
  categoriesByIds,
  effectiveSettings,
  liveCategories,
  liveRules,
  liveSegmentsOverlapping,
  loadSettings,
} from '../db/queries';
import type { AppEnv } from '../env';
import { readQuery } from '../http';

export const exportRoutes = new Hono<AppEnv>();

/** Both bounds optional: no `from` starts at the beginning, no `to` runs to the end. */
const exportQuerySchema = z
  .object({ from: isoSchema.optional(), to: isoSchema.optional() })
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, {
    message: 'from must be before to',
    path: ['to'],
  });

function exportSegments(
  db: ReturnType<typeof createDb>,
  q: { from?: string; to?: string },
): Promise<Segment[]> {
  const from = q.from === undefined ? Number.NEGATIVE_INFINITY : toMs(q.from);
  const to = q.to === undefined ? Number.POSITIVE_INFINITY : toMs(q.to);
  return liveSegmentsOverlapping(db, from, to);
}

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

/** "2026-10-02 13:15", wall-clock time in the settings timezone. */
function localDateTime(iso: string, timezone: string): string {
  return `${localDate(iso, timezone)} ${localHHMM(iso, timezone)}`;
}

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

function filename(ext: string): string {
  return `time-tracker-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/**
 * `GET /api/export.csv?from=&to=`: one row per non-deleted segment overlapping
 * the range, whole segments (not clipped), oldest first. Local times use the
 * settings timezone; `started_at_utc` keeps the exact instant. The open
 * segment has an empty `ended_at` and counts minutes up to now.
 */
exportRoutes.get('/export.csv', async (c) => {
  const q = readQuery(c, exportQuerySchema);
  const db = createDb(c.env.DB);
  const nowMs = Date.now();
  const [settings, segments] = await Promise.all([effectiveSettings(db), exportSegments(db, q)]);
  const categories = await categoriesByIds(
    db,
    segments.map((s) => s.categoryId),
  );
  const csv = segmentsCsv(segments, categories, settings.timezone, nowMs);
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename('csv')}"`,
  });
});

/**
 * `GET /api/export.json?from=&to=`: non-deleted segments overlapping the
 * range, every non-deleted category (archived included) and rule, and the
 * stored settings (null before the client has pushed any).
 */
exportRoutes.get('/export.json', async (c) => {
  const q = readQuery(c, exportQuerySchema);
  const db = createDb(c.env.DB);
  const [categories, segments, rules, settings] = await Promise.all([
    liveCategories(db),
    exportSegments(db, q),
    liveRules(db),
    loadSettings(db),
  ]);
  c.header('Content-Disposition', `attachment; filename="${filename('json')}"`);
  return c.json({ categories, segments, rules, settings });
});
