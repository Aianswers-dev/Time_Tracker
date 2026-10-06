import type { Category, Rule, Segment, Settings } from '@time-tracker/shared';
import { sql } from 'drizzle-orm';
import type { Db, Statement } from './client';
import { categoryToRow, ruleToRow, segmentToRow, settingsToRow } from './mapping';
import { categories, rules, segments, settings } from './schema';

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

export function upsertSegment(db: Db, s: Segment, opts: UpsertOptions): Statement {
  const row = segmentToRow(s, opts.syncedAt);
  const { id: _id, ...set } = row;
  return db
    .insert(segments)
    .values(row)
    .onConflictDoUpdate({
      target: segments.id,
      set,
      setWhere: opts.lww ? sql`excluded.updated_at >= ${segments.updatedAt}` : undefined,
    });
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

export function upsertSegments(db: Db, rows: readonly Segment[], opts: UpsertOptions): Statement[] {
  return orderForOneOpen(rows).map((s) => upsertSegment(db, s, opts));
}
