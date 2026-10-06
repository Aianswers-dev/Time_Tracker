import type { Category, Rule, Segment, Settings } from '@time-tracker/shared';
import { sql } from 'drizzle-orm';
import type { Db, Statement } from './client';
import { categoryToRow, ruleToRow, segmentToRow, settingsToRow } from './mapping';
import { categories, rules, settings } from './schema';

/**
 * Upsert statements for one D1 batch. Every write stamps `synced_at` with the
 * server's time and keeps the row's own `updatedAt`.
 *
 * `lww` adds the last-write-wins guard to the UPDATE: an existing row is only
 * replaced when the incoming `updated_at` is at least the stored one. Callers
 * have already compared in memory; the guard keeps a concurrent request from
 * being overwritten by an older copy. Server-computed switch rows skip it,
 * because they describe the current state, not an edit made on some clock.
 */

export interface UpsertOptions {
  syncedAt: string;
  lww: boolean;
}

/**
 * Segment upserts are the one write that comes in bulk (up to 100 rows per
 * `segments.upsert` op, many ops when a phone uploads its history), so they
 * skip Drizzle's query builder: building one statement costs about 150 µs,
 * 15 ms or more for 100 rows, over the Workers Free plan's 10 ms of CPU for
 * the whole request. One prepared statement bound per row costs microseconds.
 * Same columns, conflict target and guard as the Drizzle upserts below.
 */
const SEGMENT_COLUMNS = [
  'id',
  'category_id',
  'started_at',
  'ended_at',
  'note',
  'source',
  'created_at',
  'updated_at',
  'deleted_at',
  'synced_at',
] as const;

const SEGMENT_UPSERT_SQL =
  `INSERT INTO segments (${SEGMENT_COLUMNS.join(', ')}) ` +
  `VALUES (${SEGMENT_COLUMNS.map(() => '?').join(', ')}) ` +
  `ON CONFLICT (id) DO UPDATE SET ` +
  SEGMENT_COLUMNS.slice(1)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

const SEGMENT_LWW_GUARD = ' WHERE excluded.updated_at >= segments.updated_at';

function segmentParams(s: Segment, syncedAt: string): unknown[] {
  const r = segmentToRow(s, syncedAt);
  return [
    r.id,
    r.categoryId,
    r.startedAt,
    r.endedAt,
    r.note,
    r.source,
    r.createdAt,
    r.updatedAt,
    r.deletedAt,
    r.syncedAt,
  ];
}

export function upsertCategory(db: Db, c: Category, opts: UpsertOptions): Statement {
  const row = categoryToRow(c, opts.syncedAt);
  const { id: _id, ...set } = row;
  return db
    .insert(categories)
    .values(row)
    .onConflictDoUpdate({
      target: categories.id,
      set,
      setWhere: opts.lww ? sql`excluded.updated_at >= ${categories.updatedAt}` : undefined,
    });
}

export function upsertRule(db: Db, r: Rule, opts: UpsertOptions): Statement {
  const row = ruleToRow(r, opts.syncedAt);
  const { id: _id, ...set } = row;
  return db
    .insert(rules)
    .values(row)
    .onConflictDoUpdate({
      target: rules.id,
      set,
      setWhere: opts.lww ? sql`excluded.updated_at >= ${rules.updatedAt}` : undefined,
    });
}

export function upsertSettings(db: Db, s: Settings, opts: UpsertOptions): Statement {
  const row = settingsToRow(s, opts.syncedAt);
  const { id: _id, ...set } = row;
  return db
    .insert(settings)
    .values(row)
    .onConflictDoUpdate({
      target: settings.id,
      set,
      setWhere: opts.lww ? sql`excluded.updated_at >= ${settings.updatedAt}` : undefined,
    });
}

/** True when the row, after the write, is the live open segment. */
function opensSegment(s: Segment): boolean {
  return s.endedAt === null && s.deletedAt === null;
}

/**
 * SQLite checks the `segments_one_open` unique index after every statement, not
 * at commit. Write rows that close or delete segments first and the row that is
 * open afterwards last, so a batch that moves "open" from one row to another
 * (a switch, or an undo that reopens A and deletes B) never has two open rows
 * between statements.
 */
export function orderForOneOpen(rows: readonly Segment[]): Segment[] {
  return [...rows.filter((s) => !opensSegment(s)), ...rows.filter(opensSegment)];
}

/** One upsert per row, in `orderForOneOpen` order, for a single D1 batch. */
export function upsertSegments(
  db: Db,
  rows: readonly Segment[],
  opts: UpsertOptions,
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const statement = db.$client.prepare(
    opts.lww ? SEGMENT_UPSERT_SQL + SEGMENT_LWW_GUARD : SEGMENT_UPSERT_SQL,
  );
  return orderForOneOpen(rows).map((s) => statement.bind(...segmentParams(s, opts.syncedAt)));
}

/** Write segment rows as one D1 batch: a single transaction, all or nothing. */
export async function writeSegments(
  db: Db,
  rows: readonly Segment[],
  opts: UpsertOptions,
): Promise<void> {
  const statements = upsertSegments(db, rows, opts);
  if (statements.length > 0) await db.$client.batch(statements);
}
