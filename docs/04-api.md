# 04 · API

Base path `/api` on the same origin as the PWA. JSON in and out. All
timestamps ISO 8601 UTC. All ids UUID v7.

## Authentication

Every route except `GET /api/health` requires:

```
Authorization: Bearer <AUTH_TOKEN>
```

Missing or wrong token: `401 { "error": { "code": "unauthorized", "message": "..." } }`
with a `WWW-Authenticate: Bearer` header. The scheme name is case-insensitive.
The token is compared in constant time over its UTF-8 bytes. If the Worker has
no `AUTH_TOKEN` (unset or empty), every route except health answers `401`, so a
deploy that forgot the secret is closed rather than open.

Requests to unknown `/api/*` routes are authenticated first: `401` without a
valid token, `404 not_found` with one.

Request bodies over 1 MB are rejected with `413` and code `validation_failed`.

## Error shape

```json
{ "error": { "code": "validation_failed", "message": "thresholdMin must be > 0", "details": {} } }
```

Codes: `unauthorized`, `validation_failed`, `not_found`, `conflict`,
`switch_before_open_start`, `switch_in_future`, `internal`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `validation_failed` | Body is not JSON, or a body or query field fails its zod schema |
| 400 | `switch_in_future` | `POST /api/switch` with `at` more than 60 s ahead |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `not_found` | Unknown route, or no active category matches `POST /api/switch` |
| 409 | `conflict` | `POST /api/switch` lost a race with another write |
| 413 | `validation_failed` | Body over 1 MB |
| 500 | `internal` | Anything unexpected; safe to retry |

`validation_failed` from a zod schema carries every problem in
`details.issues`, each `{ path, message, code }` with `path` dotted from the
body or query root (for example `ops.0.opId`). `message` names the first one.

`switch_before_open_start` is reserved and not currently returned: the shared
`switchCategory` treats a switch before the open segment's start as a
backdate and clears the later time instead of rejecting it.

## Endpoints

### Health

`GET /api/health` → `200 { "ok": true, "time": "<ISO>" }`. No auth.

### Current state (widget, Shortcuts, Now screen fallback)

`GET /api/state`

```json
{
  "now": "2026-10-02T03:15:00.000Z",
  "open": {
    "segment": { "id": "...", "categoryId": "...", "startedAt": "...", "endedAt": null },
    "category": { "id": "...", "name": "Relaxing", "color": "#E5484D", "icon": "tv" },
    "elapsedMin": 72
  },
  "today": {
    "dayKey": "2026-10-02",
    "totals": [
      { "categoryId": "...", "name": "Contract work", "color": "#...", "minutes": 310 },
      { "categoryId": "...", "name": "Relaxing", "color": "#...", "minutes": 95 }
    ],
    "untrackedMin": 0
  }
}
```

`open` is `null` before the first switch. `open.segment` is the full
`Segment` and `open.category` the full `Category` (`stateResponseSchema` in
`packages/shared/src/api.ts`). Each total also carries the category `icon`.
`totals` is sorted by minutes descending and includes the open segment up to
`now`. Minutes are whole minutes, rounded down. "Today" is the logical day
containing `now` per the stored settings, or UTC with day start 04:00 before
any settings are stored. `untrackedMin` counts gaps between the start of
tracking (the earliest segment ever) and `now`, so time before the first
switch is not untracked.

### Switch (Shortcuts and Siri)

`POST /api/switch`

```json
{ "categoryName": "Relaxing", "at": "<ISO, optional>", "id": "<uuid, optional>", "source": "shortcut" }
```

`categoryId` may be given instead of `categoryName`; when both are given,
`categoryId` wins. Name matching is case-insensitive, ignores surrounding
whitespace and Unicode composition differences. Unknown name → `404`. Same
category as the open segment → `200 { "noop": true, ... }`. `source` defaults
to `shortcut`. `at` defaults to now and may be in the past (a backdated
switch, cleared with the same shared `switchCategory` the app uses). `id` is
the new segment's id: a retried request with an `id` that already exists
changes nothing and answers `200` with `noop: true` and "Switched to {name}".

Response:

```json
{ "noop": false, "message": "Switched to Relaxing", "category": { ...category },
  "closed": { ...segment } | null, "opened": { ...segment } | null }
```

`message` is "Switched to {name}" or "Already on {name}", ready for a
Shortcut's Show Result or Speak Text action. Only active categories match:
archived or deleted ones answer `404 not_found`. `opened` is the new open
segment; `closed` is the segment that now ends where `opened` starts (normally
the one that was running), or `null` when nothing touches it. Both are `null`
on a no-op.

### Ops (the client outbox)

`POST /api/ops`

```json
{ "ops": [ { "opId": "...", "type": "switch", "payload": { ... }, "createdAt": "..." } ] }
```

Applied strictly in order. Each op is atomic: its reads go in one D1 batch and
its writes in another, so either all of an op's rows are written or none.
The response reports each op; processing continues past a failed op so later
independent ops are not blocked.

The envelope is checked first (`ops` is 1 to 200 objects that each have a
string `opId`); a bad envelope is `400 validation_failed`. Each op is then
validated on its own with the shared `opSchema`, so a malformed op gets
`ok: false` with `validation_failed` in its result and does not block the
rest.

**At most 15 ops are applied per request.** D1 on the Workers Free plan allows
50 queries per Worker invocation, and each op makes up to 3 D1 calls. The
results then cover only a prefix of the ops sent: ops without a result were
not attempted and stay in the outbox. The client sends them again straight
away (not after the 30 s retry timer) until the outbox is empty or a request
fails. Malformed ops cost no D1 calls and always get a result.

A `500` can come after some ops were applied. Retrying the whole batch is
safe: switches are recognised by `newSegmentId` and upserts are
last-write-wins, so a replay leaves the same state.

```json
{ "results": [ { "opId": "...", "ok": true }, { "opId": "...", "ok": false, "error": { "code": "...", "message": "..." } } ],
  "serverTime": "<ISO>" }
```

Op types and payloads (zod schemas live in `packages/shared/src/ops.ts`). One
user action is one op, applied atomically.

| type | payload | server behaviour |
| --- | --- | --- |
| `switch` | `{ categoryId, at, newSegmentId, source }` | If `newSegmentId` already exists: ok, no-op (replay). If the server's open segment already has `categoryId` under a different id: `conflict` (state diverged, client resyncs). Else run shared `switchCategory` against server state and write the result. `at` more than 60 s ahead: `switch_in_future`. |
| `segments.upsert` | `{ rows: Segment[] }` (1 to 100) | Every edit, undo and delete. Apply each row by last-write-wins, then check I1 and I2 across the affected time window. Any violation rejects the whole op with `conflict`. |
| `category.upsert` | `Category` | Last-write-wins upsert. Setting `deletedAt` while live segments reference the category: `conflict` (the UI archives instead). |
| `rule.upsert` | `Rule` | Last-write-wins upsert. Unknown `categoryId`: `validation_failed`. |
| `settings.upsert` | `Settings` | Last-write-wins upsert of the singleton. |

Last-write-wins: an incoming row is applied when its `updatedAt` is greater
than or equal to the stored row's, otherwise acknowledged `ok: true` and
ignored. The server keeps the client's `updatedAt` and sets its own
`synced_at` on every write. The comparison is repeated inside the SQL upsert
(`ON CONFLICT DO UPDATE ... WHERE excluded.updated_at >= updated_at`) so a
concurrent request cannot overwrite a row with an older copy.

Details of each op type:

- `switch`: the replay check matches `newSegmentId` against every segment,
  soft-deleted ones included, so a switch the client later undid is not
  re-applied. A missing or deleted `categoryId` is `validation_failed`. The
  server loads the live segments that end after `at` (plus the open one),
  runs the shared `switchCategory` with its own clock as `now`, and writes the
  rows it returns. Those rows carry the server's time as `updatedAt` and skip
  the last-write-wins guard, because they describe the current state.
- `segments.upsert`: the same id twice in one op is `validation_failed`. A
  row whose category does not exist, or a live row whose category is deleted,
  is `validation_failed`. The affected window runs from the earliest start to
  the latest end of every incoming row and of the stored copy of each (an open
  segment ends at +∞). The server loads the live segments overlapping it plus
  the open segment, applies the incoming rows that win last-write-wins, and
  runs the shared `checkInvariants`: any I1, I2 or I5 violation is `conflict`
  for the whole op and nothing is written. Rows are written with closing and
  deleting rows first and the row that ends up open last, because SQLite
  checks the one-open index after every statement, not at commit (an undo
  that reopens A and deletes B must delete B first).
- `category.upsert`: the delete check counts live segments only; soft-deleted
  segments do not block deleting a category.
- `rule.upsert`: `categoryId` must name an existing category row (archived or
  deleted ones count as existing).

### Snapshot (the client pull)

`GET /api/snapshot?since=<ISO, optional>`

```json
{
  "serverTime": "<ISO>",
  "categories": [ ... ],
  "segments": [ ... ],
  "rules": [ ... ],
  "settings": { ... } | null
}
```

Rows with `synced_at > since - 10 s`, including soft-deleted rows. Without
`since`, everything. `settings` is null when unchanged since `since` or never
set. Not paged: a year of use is well under a few MB. The four tables are read
in one D1 batch, so they are a consistent view. `synced_at` itself is never
sent.

`serverTime` is read before the data. The 10 second overlap covers a write
that stamped its `synced_at` just before that moment but committed just after
the reads: without it, the next pull (from this `serverTime`) would skip that
row forever. Rows inside the overlap come back twice, which is harmless
because the client overwrites with the server's copy.

### Convenience reads (debugging, Shortcuts)

- `GET /api/categories` → `Category[]`: active categories (not archived,
  not deleted) by `sortOrder`.
- `GET /api/segments?from=<ISO>&to=<ISO>` → `Segment[]`: non-deleted
  segments overlapping `[from, to)`, oldest first. The open segment counts as
  running forever. Both bounds required, `from < to`, max range 92 days,
  otherwise `400 validation_failed`.
- `GET /api/rules` → `Rule[]`: non-deleted rules, oldest first.
- `GET /api/settings` → `Settings`: the stored settings, or the defaults the
  server uses before any are stored (`timezone` "UTC", `dayStartHour` 4,
  `updatedAt` 2000-01-01). The app's Connect button calls it to check a
  token before saving it.

### Push

- `GET /api/push/vapid-public-key` → `{ "key": "<base64url>" }`
- `POST /api/push/subscriptions` with the browser's `PushSubscription.toJSON()`
  plus `{ "userAgent": "..." }` → `201 { "id": "..." }`. Upserts on `endpoint`.
- `DELETE /api/push/subscriptions/:id` → `204`.
- `POST /api/push/test` → sends `"Test notification"` to every subscription,
  returns `{ "sent": n, "failed": n }`. Used by the Settings screen.

### Export

Both take optional `from` and `to` (ISO). Without `from` the export starts at
the beginning, without `to` it runs to the end. There is no range limit. The
response has `Content-Disposition: attachment; filename="time-tracker-<date>.<ext>"`.

- `GET /api/export.csv?from=&to=` → `text/csv; charset=utf-8` with columns
  `started_at,ended_at,category,minutes,note,source,started_at_utc`. One row
  per non-deleted segment overlapping the range, whole segments (not clipped
  to the range), oldest first. `started_at` and `ended_at` are local wall-clock
  times in the settings timezone formatted `YYYY-MM-DD HH:MM` (UTC before any
  settings are stored); `started_at_utc` is the exact ISO instant, which also
  disambiguates the repeated hour when daylight saving ends. The open segment
  has an empty `ended_at` and counts `minutes` up to now. `minutes` is whole
  minutes, rounded down. Fields are quoted per RFC 4180 (a field containing a
  comma, quote, CR or LF is wrapped in quotes, inner quotes doubled) and lines
  end with CRLF.
- `GET /api/export.json?from=&to=` → `{ categories, segments, rules, settings }`:
  non-deleted segments overlapping the range, every non-deleted category
  (archived included) and rule, and the stored settings or `null`.

### Scheduled handler

Not an HTTP route. `wrangler.toml` declares `crons = ["* * * * *"]`. The
handler runs the flow described in `02-architecture.md` "Nudge evaluation".
Locally, `wrangler dev --test-scheduled` exposes
`GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*`.

## Web Push payload

```json
{ "title": "Relaxing for 1h 0m", "body": "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
  "tag": "session:<ruleId>", "data": { "url": "/" } }
```

Keep under 4 KB. Encrypt per RFC 8291 (aes128gcm) and sign per RFC 8292
(VAPID). Candidate Workers-compatible libraries, to be verified in M3:
`@block65/webcrypto-web-push`, `webpush-webcrypto`. If neither works, the
protocol is small enough to implement with WebCrypto directly.
