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
  staleAfterMin: number;    // default 300
  staleRepeatMin: number;   // default 60
  staleQuietStart: HHMM | null;
  staleQuietEnd: HHMM | null;
  updatedAt: ISO;
}

// Server only
interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: ISO;
  lastSuccessAt: ISO | null;
  failureCount: number;
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
  opId: string;
  type: OpType;             // see 04-api.md
  payload: unknown;
  createdAt: ISO;
  attempts: number;
  lastError: string | null;
}

interface Meta {            // client only, key/value
  key: 'token' | 'lastSync' | 'installedAt' | 'pushSubscriptionId';
  value: string;
}
```

## SQL schema (D1 / SQLite)

Drizzle is the source of truth; this is the intended shape.

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
  deleted_at TEXT
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX segments_started ON segments(started_at);
CREATE INDEX segments_cat_started ON segments(category_id, started_at);
-- Enforces invariant I1 at the database level.
CREATE UNIQUE INDEX segments_one_open
  ON segments(ended_at) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX segments_updated ON segments(updated_at);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  kind TEXT NOT NULL CHECK (kind IN ('session','daily')),
  threshold_min INTEGER NOT NULL,
  repeat_every_min INTEGER,
  quiet_start TEXT,
  quiet_end TEXT,
  message TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE settings (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  timezone TEXT NOT NULL,
  day_start_hour INTEGER NOT NULL DEFAULT 4,
  stale_after_min INTEGER NOT NULL DEFAULT 300,
  stale_repeat_min INTEGER NOT NULL DEFAULT 60,
  stale_quiet_start TEXT,
  stale_quiet_end TEXT,
  updated_at TEXT NOT NULL
);

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
```

The Dexie schema on the client mirrors `categories`, `segments`, `rules`,
`settings` and adds `outbox` and `meta`. Dexie uses camelCase field names;
the server maps to snake_case columns.

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
  is `dayKey` at `dayStartHour` local and `end` is the next day's.
- `splitByDay(segment, now, settings)`: slices one segment (open segments end
  at `now`) into `{ dayKey, startedAt, endedAt, minutes }` pieces at logical
  day boundaries.

## Segment operations (`packages/shared/src/segments.ts`)

All take the current non-deleted segments plus a `now` and return changes.

- `switchCategory({ categoryId, at = now, newId, source })`
  - If the open segment has the same `categoryId`: no-op.
  - If `at < open.startedAt`: throw `SwitchBeforeOpenStart`.
  - If `at > now + 60s`: throw `SwitchInFuture`.
  - Close the open segment at `at` (if its length would be under one second,
    delete it instead). Create a new open segment with `newId`.
- `undoSwitch({ newSegmentId })`: delete the new segment, reopen the previous
  one by setting `endedAt = null`. The UI offers this for 10 seconds after a
  switch; the function itself has no time limit.
- `backdateOpen({ startedAt })`: move the open segment's `startedAt` earlier
  or later, and move the previous segment's `endedAt` to match. Validates
  against the previous segment's `startedAt`.
- `moveBoundary({ prevId, nextId, at })`: set `prev.endedAt = next.startedAt
  = at`. Requires `prev.startedAt < at < (next.endedAt ?? now)`.
- `changeCategory({ id, categoryId })`: recategorise without changing times.
- `splitSegment({ id, at, secondCategoryId })`: end the segment at `at`,
  create a second segment from `at` to the original end with the given
  category. If the original was open, the second is open.
- `insertSegment({ categoryId, startedAt, endedAt })`: carve a closed segment
  into existing history. Segments fully inside the range are deleted,
  overlapping ones are truncated, a segment that fully contains the range is
  split in two. `endedAt` must be `<= now`.
- `deleteSegment({ id, fill: 'none' | 'prev' | 'next' })`: soft delete. With
  `fill`, extend the neighbour to cover the gap. Deleting the open segment
  with `fill: 'prev'` reopens the previous segment. Deleting the open segment
  with `fill: 'none'` is refused (would violate P4), the UI offers switching
  instead.

## Aggregation (`packages/shared/src/stats.ts`)

- `totalsForRange(segments, from, to, now)`: minutes per category plus
  untracked minutes, computed by clipping segments to the range.
- `timelineForDay(segments, dayKey, now, settings)`: ordered blocks for the
  Today bar, with explicit `untracked` blocks for gaps.
- `dailyTotals(segments, dayKeys, now, settings)`: per-day map for stacked
  bars.
- `hourHeatmap(segments, dayKeys, now, settings)`: 24 x categories matrix of
  minutes, in local hours.
- `budgetStatus(rules, dailyTotals)`: for each daily rule, days under and over.

## Rule engine (`packages/shared/src/rules.ts`)

```ts
interface RuleEngineInput {
  now: ISO;
  settings: Settings;
  openSegment: Segment | null;
  category: Category | null;
  rules: Rule[];                 // enabled, for this category only
  todayMinutes: number;          // this category, current logical day, incl. open segment to now
  log: NotificationLog[];        // rows for this segment id or today's dayKey
}

interface Notification {
  kind: 'session' | 'daily' | 'stale';
  ruleId: string | null;
  segmentId: string | null;
  dayKey: DayKey | null;
  title: string;
  body: string;
  tag: string;                   // collapses repeats on the device
}

function evaluateRules(input: RuleEngineInput): Notification[];
```

Semantics, evaluated once a minute:

1. No open segment, or its category is archived: return `[]`.
2. Let `sessionMin = minutesBetween(openSegment.startedAt, now)`.
3. **Session rules.** Dedupe key `(ruleId, segmentId)`. Fire when
   `sessionMin >= thresholdMin` and either no log row exists for the key, or
   `repeatEveryMin` is set and `now - lastSentAt >= repeatEveryMin`.
4. **Daily rules.** Dedupe key `(ruleId, dayKeyOf(now))`. Fire when
   `todayMinutes >= thresholdMin` with the same repeat logic.
5. **Stale check.** Skipped when `category.exemptFromStaleCheck`. Dedupe key
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
   - `tag` is `"{kind}:{ruleId ?? 'stale'}"` so a repeat replaces the previous
     banner rather than stacking.

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
