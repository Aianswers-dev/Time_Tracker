# 03 · Data model

All timestamps are ISO 8601 UTC strings. All ids are UUID v7 generated on the
client (or on the server for rows the server creates, such as the notification
log). Every synced table has `createdAt`, `updatedAt`, `deletedAt`.

## Entities

```ts
type ISO = string;          // "2026-10-02T03:15:00.000Z"
type DayKey = string;       // "2026-10-02", logical day per settings
type HHMM = string;         // "23:00"

interface Category {
  id: string;
  name: string;
  color: string;            // hex, e.g. "#E5484D"
  icon: string;             // name from the chosen icon set
  sortOrder: number;
  exemptFromStaleCheck: boolean;   // true for Sleep
  archivedAt: ISO | null;   // archived categories hide from the grid, keep history
  createdAt: ISO; updatedAt: ISO; deletedAt: ISO | null;
}

interface Segment {
  id: string;
  categoryId: string;
  startedAt: ISO;
  endedAt: ISO | null;      // null means this is the open segment
  note: string | null;
  source: 'app' | 'shortcut' | 'edit';
  createdAt: ISO; updatedAt: ISO; deletedAt: ISO | null;
}

interface Rule {
  id: string;
  categoryId: string;
  kind: 'session' | 'daily';
  thresholdMin: number;     // > 0
  repeatEveryMin: number | null;   // null = fire once per key
  quietStart: HHMM | null;  // both null = no quiet hours
  quietEnd: HHMM | null;    // window may cross midnight
  message: string | null;   // custom body, else a default is generated
  enabled: boolean;
  createdAt: ISO; updatedAt: ISO; deletedAt: ISO | null;
}

interface Settings {
  id: 'singleton';
  timezone: string;         // IANA, e.g. "Australia/Sydney"
  dayStartHour: number;     // 0..23, default 4
  staleEnabled: boolean;    // default true
  staleAfterMin: number;    // default 300
  staleRepeatMin: number | null;   // default 60, null = once per segment
  staleQuietStart: HHMM | null;
  staleQuietEnd: HHMM | null;
  updatedAt: ISO;
}

// Server only. One per browser that allowed notifications; unique by endpoint.
interface PushSubscription {
  id: string;               // server-generated UUID v7, kept when the endpoint re-registers
  endpoint: string;         // https URL of the push service
  p256dh: string;           // client ECDH P-256 public key, base64url (65 bytes)
  auth: string;             // client auth secret, base64url (16 bytes)
  userAgent: string | null;
  createdAt: ISO;
  lastSuccessAt: ISO | null;
  failureCount: number;     // failed sends since the last success
}

// Server only. Key/value config the Worker manages itself.
interface ServerConfig {
  key: 'vapid_keys' | 'origin';
  value: string;            // vapid_keys: JSON { publicKey, privateKey }, base64url
                            // origin: "https://<host>", the default VAPID subject
  updatedAt: ISO;
}

// Server only. Written before each send; the dedupe source of truth.
interface NotificationLog {
  id: string;
  kind: 'session' | 'daily' | 'stale';
  ruleId: string | null;    // null for stale
  segmentId: string | null; // set for session and stale
  dayKey: DayKey | null;    // set for daily
  sentAt: ISO;
  title: string;
  body: string;
}

// Client only
interface OutboxEntry {
  seq: number;              // auto-increment, replay order
  opId: string;             // same as op.opId, indexed
  op: Op;                   // the shared op exactly as POST /api/ops sends it (04-api.md)
  attempts: number;
  lastError: string | null;
}

interface Meta {            // client only, key/value
  key: 'token' | 'lastSync' | 'installedAt' | 'seededAt'
     | 'pushSubscriptionId'   // the server's id for this phone's push subscription
     | 'pushEndpoint'         // the endpoint registered under that id (docs/06)
     // sync state, see 02-architecture.md "The client sync engine"
     | 'lastSyncedAt' | 'tokenRejected' | 'syncError' | 'needsFullResync'
     | 'connectBannerDismissed' | 'serverEmpty';
  value: string;
}
```

## SQL schema (D1 / SQLite)

Drizzle (`apps/server/src/db/schema.ts`) is the source of truth and
`apps/server/drizzle/0000_init.sql` is the generated migration; this is the
same shape in plain SQL. Every synced table (`categories`, `segments`,
`rules`, `settings`) also has `synced_at TEXT NOT NULL`, the server time of
the last write, indexed. It is the `GET /api/snapshot?since=` cursor and is
never sent to the client. Booleans are `0`/`1` integers; the server maps rows
to the shared camelCase types in `apps/server/src/db/mapping.ts`.

```sql
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  exempt_from_stale_check INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX categories_synced ON categories(synced_at);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX segments_started ON segments(started_at);
CREATE INDEX segments_cat_started ON segments(category_id, started_at);
-- Overlap queries ("ended_at IS NULL OR ended_at > ?") only read recent rows.
CREATE INDEX segments_ended ON segments(ended_at);
-- Enforces invariant I1 at the database level. The indexed expression is 1
-- for every row the WHERE clause admits, so at most one such row can exist.
-- Indexing ended_at itself would enforce nothing: every admitted row has
-- ended_at NULL, and SQLite treats NULLs as distinct in a UNIQUE index.
CREATE UNIQUE INDEX segments_one_open
  ON segments((ended_at IS NULL)) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX segments_synced ON segments(synced_at);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  kind TEXT NOT NULL,
  threshold_min INTEGER NOT NULL,
  repeat_every_min INTEGER,
  quiet_start TEXT,
  quiet_end TEXT,
  message TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  synced_at TEXT NOT NULL,
  CONSTRAINT rules_kind CHECK (kind IN ('session', 'daily'))
);
CREATE INDEX rules_synced ON rules(synced_at);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  day_start_hour INTEGER NOT NULL DEFAULT 4,
  stale_enabled INTEGER NOT NULL DEFAULT 1,
  stale_after_min INTEGER NOT NULL DEFAULT 300,
  stale_repeat_min INTEGER DEFAULT 60,
  stale_quiet_start TEXT,
  stale_quiet_end TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  CONSTRAINT settings_singleton CHECK (id = 'singleton')
);
CREATE INDEX settings_synced ON settings(synced_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  rule_id TEXT,
  segment_id TEXT,
  day_key TEXT,
  sent_at TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX notif_rule_segment ON notification_log(rule_id, segment_id, sent_at);
CREATE INDEX notif_rule_day ON notification_log(rule_id, day_key, sent_at);
CREATE INDEX notif_kind_segment ON notification_log(kind, segment_id, sent_at);
-- 0001: the cron's daily-row read and the age prune.
CREATE INDEX notif_kind_day ON notification_log(kind, day_key, sent_at);
CREATE INDEX notif_sent ON notification_log(sent_at);

-- 0001: never synced, never sent to the client.
CREATE TABLE server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Migrations: `0000_init.sql` creates everything above except what is marked
0001; `0001_server_config.sql` adds `server_config` and the two notification
log indexes.

Notes on the server-only tables:

- `push_subscriptions` is upserted on `endpoint`: registering the same
  endpoint again keeps the row's id, replaces its keys and resets
  `failure_count`. The cron deletes a row when the push service answers 404
  or 410. Keys are stored as base64url without padding.
- `notification_log` rows are written by the cron, one per notification,
  before the push is sent. `id` is a server UUID v7 and `sent_at` is the
  run's clock. Session and stale rows carry `segment_id`, daily rows
  `day_key`. Every run that writes also deletes rows older than 60 days,
  except rows for the open segment, so a segment left running for months
  still dedupes. Quiet hours and the send budget never write a row: a skipped
  notification is simply evaluated again the next minute.
- `server_config` holds `vapid_keys` (the generated pair, written once with
  `INSERT ... ON CONFLICT DO NOTHING` and read back in the same batch, so two
  first requests agree on one pair) and `origin` (updated whenever the app
  fetches the VAPID key, registers a subscription or sends a test, and only
  written when it changed). The `VAPID_*` secrets, when set, take precedence
  and leave this table alone.

D1 enforces foreign keys, so a segment or rule can only point at a category
row that exists (soft-deleted or not). The server checks this before writing
and answers `validation_failed` instead of surfacing a constraint error.

SQLite checks `segments_one_open` after each statement, not at commit. A
batch that moves "open" from one row to another must write the row that
closes (or is deleted) before the row that opens; the server orders every
segment batch that way.

Timestamps are stored exactly as the shared zod schemas normalise them
(`Date.prototype.toISOString()`), so comparing them as strings in SQL orders
them correctly.

The Dexie schema on the client mirrors `categories`, `segments`, `rules`,
`settings` and adds `outbox` and `meta`. Dexie uses camelCase field names;
the server maps to snake_case columns. Version 1 (M0) has only `meta`;
version 2 (M1) adds the rest:

```ts
categories: 'id, sortOrder'
segments:   'id, startedAt, categoryId'
rules:      'id, categoryId'
settings:   'id'
outbox:     '++seq, opId'
```

The client never loads the whole segment history for an action or a screen.
It reads, by the `startedAt` index, every segment starting within seven days
either side of the affected time, plus the nearest live segment on each side
of that window and the open segment (the live segment with the latest start).
Segments never overlap, so this is exactly what the shared operations and the
day views need.

## Invariants

- **I1.** At most one segment has `endedAt = null` among non-deleted segments.
- **I2.** Non-deleted segments never overlap, and `startedAt < endedAt` when
  `endedAt` is set. Two segments may touch (`a.endedAt === b.startedAt`).
- **I3.** Every segment references an existing category. Archived is allowed.
- **I4.** `settings` has exactly one row with id `singleton`.
- **I5.** A segment shorter than one second is never persisted.

Every operation below returns a list of row changes that preserve I1 to I5,
or throws a typed error. Tests assert the invariants after each operation.

## Time helpers

- `dayKeyOf(t, settings)`: convert `t` to `settings.timezone`, subtract
  `dayStartHour` hours, format as `YYYY-MM-DD`.
- `dayRange(dayKey, settings)`: `[start, end)` as UTC instants, where `start`
  is `dayKey` at `dayStartHour` local and `end` is the next day's. When
  `dayStartHour` happens twice (clocks going back) the day starts at the
  first; when it is skipped, at the moment the clocks jump. So `t` is in
  `dayRange(k)` exactly when `dayKeyOf(t) === k`.
- `splitByDay(start, end, settings)`: slices the span [start, end) in epoch
  milliseconds (pass `now` as the end for the open segment) into
  `{ dayKey, start, end }` pieces at logical day boundaries.

## Segment operations (`packages/shared/src/segments.ts`)

All take the current segments (soft-deleted rows are ignored), parameters, and
a context `{ now, newId }`. They return `{ rows, noop }`: every changed row in
its new state with `updatedAt = now`, including created rows and deleted rows
(with `deletedAt = now`). They never mutate their input and throw a
`SegmentOpError` with a `code` on invalid input. A shared `clearRange` helper
removes everything in a span: segments fully inside are deleted, segments
overlapping an edge are trimmed, a segment containing the span is split in
two. Any trimmed closed segment left shorter than one second is deleted (I5).

- `switchCategory({ categoryId, at = now, newSegmentId?, source })`
  - Same category as the open segment: no-op.
  - `at` up to 60 seconds in the future is clamped to now; later throws
    `in_future`.
  - Otherwise clears `[at, ∞)` (so the open segment closes at `at`, and a
    backdated switch trims or removes whatever came after `at`) and opens a
    new segment at `at`.
  - `madeAt` (optional, for a switch applied later, such as an outbox op):
    live segments starting after both `at` and `madeAt` were recorded after
    the switch was made and stay. The new segment fills `[at, first such
    start)` and is closed; there is no no-op check in that case.
- `backdateOpen({ startedAt })`: move the open segment's start. Earlier clears
  what was there. Later pulls a touching previous segment's end along, or
  leaves a gap if there was one already.
- `editSegment({ id, categoryId?, startedAt?, endedAt?, note? })`: boundaries
  behave like dragging. Moving the start later or the end earlier pulls a
  touching neighbour along. Moving the start earlier or the end later clears
  what was there. A pulled neighbour only takes over time the segment gave
  up: when an edit moves the segment past its old end (or before its old
  start), the time in between keeps whatever was there. The open segment's
  end cannot be set (switch instead).
  The UI previews the returned rows to show what else will change.
- `splitSegment({ id, at, secondCategoryId })`: end the segment at `at`,
  create a second segment from `at` to the original end. If the original was
  open, the second is open. Both pieces must be at least one second, except
  an open second piece.
- `insertSegment({ categoryId, startedAt, endedAt, note? })`: clear the span
  and add a closed segment. Used for gap assignment and logging after the
  fact. `endedAt` must be `<= now`.
- `deleteSegment({ id, fill: 'none' | 'prev' | 'next' })`: soft delete.
  `prev` extends the previous segment over the freed time; `next` pulls the
  next segment's start back. Deleting the open segment requires `prev` and
  reopens the previous segment (P4).
- `undoRows(prior, changedRows, now)`: rows that reverse an operation. The
  Now screen's 10 second Undo uses it.
- `checkInvariants(segments)`: human-readable violations of I1, I2, I5. Tests
  run it after every operation; the server runs it before committing an op.

## Aggregation (`packages/shared/src/stats.ts`)

All durations are milliseconds; the UI formats them.

- `totalsForRange(segments, from, to, now)`: `{ byCategory, trackedMs,
  untrackedMs }` by clipping segments to the range. Untracked time only counts
  after the earliest segment in the input and before now, so pass the full
  history (or at least the earliest live segment) when untracked matters.
- `sortedTotals(byCategory)`: category totals, largest first.
- `todayMsFor(segments, categoryId, dayKey, settings, now)`: one category's
  time in one logical day.
- `timelineForDay(segments, dayKey, settings, now)`: ordered blocks for the
  Today bar, with explicit gap blocks for untracked time.
- `dailyTotals(segments, dayKeys, settings, now)`: per-day map of per-category
  time, for stacked bars. The Stats screen gets the same map by calling
  `totalsForRange` over each day's `dayRange`, which needs one `dayRange` per
  day instead of one per segment piece; a web test checks the two agree.
- `hourHeatmap(segments, from, to, timezone, now)`: per category, 24 numbers of
  time in each local hour of day.
- `budgetStatus(rules, daily, dayKeys)`: for each enabled daily rule, days
  under and over and the current streak under budget.
- `movingAverage(values, window)`: trailing average for trend lines.

Inserting a closed block inside the running segment splits it, and the
still-running tail gets a new id. Session rules and the stale check restart
for the tail, which matches their meaning: one unbroken stretch.

## Rule engine (`packages/shared/src/rules.ts`)

```ts
interface RuleEngineInput {
  now: ISO;
  settings: Settings;
  openSegment: Segment | null;
  category: Category | null;
  rules: Rule[];                 // enabled, for this category only
  todayMs: number;               // this category, current logical day, incl. open segment to now
  log: NotificationLog[];        // rows for this segment id or today's dayKey
}

interface PendingNotification {
  kind: 'session' | 'daily' | 'stale';
  ruleId: string | null;
  segmentId: string | null;
  dayKey: DayKey | null;
  title: string;
  body: string;
  tag: string;                   // collapses repeats on the device
}

function evaluateRules(input: RuleEngineInput): PendingNotification[];
```

Semantics, evaluated once a minute:

1. No open segment, or its category is archived: return `[]`.
2. Let `sessionMin = minutesBetween(openSegment.startedAt, now)`.
3. **Session rules.** Dedupe key `(ruleId, segmentId)`. Fire when
   `sessionMin >= thresholdMin` and either no log row exists for the key, or
   `repeatEveryMin` is set and `now - lastSentAt >= repeatEveryMin` minus a
   30 second tolerance for cron drift.
4. **Daily rules.** Dedupe key `(ruleId, dayKeyOf(now))`. Fire when
   `todayMinutes >= thresholdMin` with the same repeat logic.
5. **Stale check.** Skipped when `settings.staleEnabled` is false or
   `category.exemptFromStaleCheck`. Dedupe key
   `('stale', segmentId)`. Fire when `sessionMin >= staleAfterMin`, repeat
   every `staleRepeatMin`.
6. **Quiet hours.** A rule (or the stale check) inside its quiet window is
   skipped and nothing is logged, so it fires the first minute after the
   window ends if still over threshold. A window with `start > end` crosses
   midnight. Quiet hours are evaluated in the settings timezone.
7. Default copy, when `rule.message` is null:
   - session: title `"{category} for {Nh Nm}"`, body
     `"You've been on {category} for {duration} straight. Time to switch it up."`
   - daily: title `"{Nh Nm} of {category} today"`, body
     `"That's past your {threshold} budget for today."`
   - stale: title `"Still on {category}?"`, body
     `"It's been {duration}. Tap to update if you've moved on."`
   - `tag` is `"{kind}:{ruleId}"`, or `"stale"`, so a repeat replaces the
     previous banner rather than stacking.
   - A custom `rule.message` replaces the body; the title stays.

Required tests (minimum):

- Session rule fires at threshold, not one minute before.
- Session rule does not fire twice without `repeatEveryMin`.
- Session rule repeats at exactly `repeatEveryMin` after the last send.
- Switching category resets session rules (new segment id, no log).
- Daily rule counts the open segment up to `now`.
- Daily rule counts a segment that started before `dayStartHour` only for the
  part inside today.
- Daily rule dedupes by day and fires again the next logical day.
- Stale check skipped for exempt category; fires and repeats for others.
- Quiet window suppresses, including a window crossing midnight, and the
  notification fires the first minute after the window.
- No open segment yields no notifications.
