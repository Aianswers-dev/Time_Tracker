import {
  defaultSettings,
  SETTINGS_ID,
  toIso,
  type Category,
  type Rule,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { and, asc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from './client';
import { categoryFromRow, ruleFromRow, segmentFromRow, settingsFromRow } from './mapping';
import {
  categories,
  rules,
  segments,
  settings,
  type CategoryRow,
  type SegmentRow,
  type SettingsRow,
} from './schema';

/**
 * Reads shared by the routes and the op processor.
 *
 * `select.*` build queries without running them, so a caller can send several
 * in one `db.batch()`: one round trip, one consistent view, and one call
 * against the Workers Free limit on D1 queries per request. The plain async
 * functions below run a single query and return shared entity types.
 */

/**
 * `column IN (ids)` with a single bound parameter (a JSON array), so any
 * number of ids stays under D1's limit of 100 bound parameters per query.
 */
function idIn(column: SQLiteColumn, ids: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`;
}

/** Live segments overlapping [fromMs, toMs). The open segment never ends. Either bound may be infinite. */
function overlapping(fromMs: number, toMs: number): SQL | undefined {
  const conditions: SQL[] = [isNull(segments.deletedAt)];
  if (Number.isFinite(fromMs)) {
    const endsAfter = or(isNull(segments.endedAt), gt(segments.endedAt, toIso(fromMs)));
    if (endsAfter) conditions.push(endsAfter);
  }
  if (Number.isFinite(toMs)) conditions.push(lt(segments.startedAt, toIso(toMs)));
  return and(...conditions);
}

export const select = {
  settings: (db: Db) => db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1),

  openSegment: (db: Db) =>
    db
      .select()
      .from(segments)
      .where(and(isNull(segments.endedAt), isNull(segments.deletedAt)))
      .limit(1),

  /** Oldest first. */
  segmentsOverlapping: (db: Db, fromMs: number, toMs: number) =>
    db
      .select()
      .from(segments)
      .where(overlapping(fromMs, toMs))
      .orderBy(asc(segments.startedAt), asc(segments.id)),

  /** The live segment that started first, which marks when tracking began. */
  earliestLiveSegment: (db: Db) =>
    db
      .select()
      .from(segments)
      .where(isNull(segments.deletedAt))
      .orderBy(asc(segments.startedAt))
      .limit(1),

  /** Any state, soft-deleted included. */
  segmentsByIds: (db: Db, ids: readonly string[]) =>
    db.select().from(segments).where(idIn(segments.id, ids)),

  /** One live segment of the category, if any. */
  liveSegmentOfCategory: (db: Db, categoryId: string) =>
    db
      .select({ id: segments.id })
      .from(segments)
      .where(and(eq(segments.categoryId, categoryId), isNull(segments.deletedAt)))
      .limit(1),

  /** Any state, archived and soft-deleted included. */
  categoriesByIds: (db: Db, ids: readonly string[]) =>
    db.select().from(categories).where(idIn(categories.id, ids)),

  /** Not archived, not deleted, in display order. */
  activeCategories: (db: Db) =>
    db
      .select()
      .from(categories)
      .where(and(isNull(categories.archivedAt), isNull(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id)),

  /** Not deleted (archived included), in display order. */
  liveCategories: (db: Db) =>
    db
      .select()
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id)),

  ruleById: (db: Db, id: string) => db.select().from(rules).where(eq(rules.id, id)).limit(1),

  /** Not deleted, oldest first. */
  liveRules: (db: Db) =>
    db
      .select()
      .from(rules)
      .where(isNull(rules.deletedAt))
      .orderBy(asc(rules.createdAt), asc(rules.id)),
};

export function firstSettings(rows: readonly SettingsRow[]): Settings | null {
  const row = rows[0];
  return row ? settingsFromRow(row) : null;
}

export function firstSegment(rows: readonly SegmentRow[]): Segment | null {
  const row = rows[0];
  return row ? segmentFromRow(row) : null;
}

export function categoryMap(rows: readonly CategoryRow[]): Map<string, Category> {
  return new Map(rows.map((r) => [r.id, categoryFromRow(r)]));
}

export function segmentMap(rows: readonly SegmentRow[]): Map<string, Segment> {
  return new Map(rows.map((r) => [r.id, segmentFromRow(r)]));
}

/** The settings to do day math with: the stored ones, or the defaults in UTC before any are stored. */
export function orDefaultSettings(stored: Settings | null): Settings {
  return stored ?? defaultSettings('UTC');
}

export async function loadSettings(db: Db): Promise<Settings | null> {
  return firstSettings(await select.settings(db));
}

export async function effectiveSettings(db: Db): Promise<Settings> {
  return orDefaultSettings(await loadSettings(db));
}

export async function liveSegmentsOverlapping(
  db: Db,
  fromMs: number,
  toMs: number,
): Promise<Segment[]> {
  return (await select.segmentsOverlapping(db, fromMs, toMs)).map(segmentFromRow);
}

export async function categoriesByIds(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, Category>> {
  if (ids.length === 0) return new Map();
  return categoryMap(await select.categoriesByIds(db, ids));
}

export async function activeCategories(db: Db): Promise<Category[]> {
  return (await select.activeCategories(db)).map(categoryFromRow);
}

export async function liveCategories(db: Db): Promise<Category[]> {
  return (await select.liveCategories(db)).map(categoryFromRow);
}

export async function liveRules(db: Db): Promise<Rule[]> {
  return (await select.liveRules(db)).map(ruleFromRow);
}

/**
 * Rows written after `since` (server time), soft-deleted rows included. No
 * `since`: everything. One D1 batch, so the four reads see the same state.
 */
export async function rowsSyncedAfter(db: Db, since: string | null) {
  const [categoryRows, segmentRows, ruleRows, settingsRows] = await db.batch([
    db
      .select()
      .from(categories)
      .where(since === null ? undefined : gt(categories.syncedAt, since))
      .orderBy(asc(categories.sortOrder), asc(categories.id)),
    db
      .select()
      .from(segments)
      .where(since === null ? undefined : gt(segments.syncedAt, since))
      .orderBy(asc(segments.startedAt), asc(segments.id)),
    db
      .select()
      .from(rules)
      .where(since === null ? undefined : gt(rules.syncedAt, since))
      .orderBy(asc(rules.createdAt), asc(rules.id)),
    db
      .select()
      .from(settings)
      .where(
        since === null
          ? eq(settings.id, SETTINGS_ID)
          : and(eq(settings.id, SETTINGS_ID), gt(settings.syncedAt, since)),
      ),
  ]);
  return {
    categories: categoryRows.map(categoryFromRow),
    segments: segmentRows.map(segmentFromRow),
    rules: ruleRows.map(ruleFromRow),
    settings: firstSettings(settingsRows),
  };
}
