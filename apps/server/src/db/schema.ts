import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * D1 schema, the source of truth for the migrations in `drizzle/`. Matches
 * docs/03-data-model.md. Column names are snake_case; Drizzle exposes them in
 * camelCase. Booleans are stored as 0/1 integers and converted in `mapping.ts`.
 *
 * Every synced table (categories, segments, rules, settings) has a server-only
 * `synced_at`: the server time of the last write, used as the
 * `GET /api/snapshot?since=` cursor. It is never sent to the client.
 */

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    icon: text('icon').notNull(),
    sortOrder: integer('sort_order').notNull(),
    exemptFromStaleCheck: integer('exempt_from_stale_check').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [index('categories_synced').on(t.syncedAt)],
);

export const segments = sqliteTable(
  'segments',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    note: text('note'),
    source: text('source', { enum: ['app', 'shortcut', 'edit'] })
      .notNull()
      .default('app'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [
    index('segments_started').on(t.startedAt),
    index('segments_cat_started').on(t.categoryId, t.startedAt),
    // Overlap queries ("ended_at IS NULL OR ended_at > ?") read only recent rows.
    index('segments_ended').on(t.endedAt),
    // Invariant I1 at the database level: at most one live open segment. The
    // indexed expression is 1 for every row the WHERE clause admits. Indexing
    // ended_at itself would enforce nothing, because SQLite treats NULLs as
    // distinct in a UNIQUE index.
    uniqueIndex('segments_one_open')
      .on(sql`(ended_at IS NULL)`)
      .where(sql`ended_at IS NULL AND deleted_at IS NULL`),
    index('segments_synced').on(t.syncedAt),
  ],
);

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    kind: text('kind', { enum: ['session', 'daily'] }).notNull(),
    thresholdMin: integer('threshold_min').notNull(),
    repeatEveryMin: integer('repeat_every_min'),
    quietStart: text('quiet_start'),
    quietEnd: text('quiet_end'),
    message: text('message'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [
    check('rules_kind', sql`kind IN ('session', 'daily')`),
    index('rules_synced').on(t.syncedAt),
  ],
);

export const settings = sqliteTable(
  'settings',
  {
    id: text('id').primaryKey(),
    timezone: text('timezone').notNull(),
    dayStartHour: integer('day_start_hour').notNull().default(4),
    staleEnabled: integer('stale_enabled').notNull().default(1),
    staleAfterMin: integer('stale_after_min').notNull().default(300),
    staleRepeatMin: integer('stale_repeat_min').default(60),
    staleQuietStart: text('stale_quiet_start'),
    staleQuietEnd: text('stale_quiet_end'),
    updatedAt: text('updated_at').notNull(),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [
    check('settings_singleton', sql`id = 'singleton'`),
    index('settings_synced').on(t.syncedAt),
  ],
);

/** Server only. One row per installed PWA that allowed notifications (M3). */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
  lastSuccessAt: text('last_success_at'),
  failureCount: integer('failure_count').notNull().default(0),
});

/** Server only. Written before each push; the rule engine's dedupe source of truth (M3). */
export const notificationLog = sqliteTable(
  'notification_log',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['session', 'daily', 'stale'] }).notNull(),
    ruleId: text('rule_id'),
    segmentId: text('segment_id'),
    dayKey: text('day_key'),
    sentAt: text('sent_at').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
  },
  (t) => [
    index('notif_rule_segment').on(t.ruleId, t.segmentId, t.sentAt),
    index('notif_rule_day').on(t.ruleId, t.dayKey, t.sentAt),
    index('notif_kind_segment').on(t.kind, t.segmentId, t.sentAt),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type SegmentRow = typeof segments.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NotificationLogRow = typeof notificationLog.$inferSelect;
