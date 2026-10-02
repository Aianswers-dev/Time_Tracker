# 04 · API

Base path `/api` on the same origin as the PWA. JSON in and out. All
timestamps ISO 8601 UTC. All ids UUID v7.

## Authentication

Every route except `GET /api/health` requires:

```
Authorization: Bearer <AUTH_TOKEN>
```

Missing or wrong token: `401 { "error": { "code": "unauthorized", "message": "..." } }`.

## Error shape

```json
{ "error": { "code": "validation_failed", "message": "thresholdMin must be > 0", "details": {} } }
```

Codes: `unauthorized`, `validation_failed`, `not_found`, `conflict`,
`switch_before_open_start`, `switch_in_future`, `internal`.

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

`open` is `null` before the first switch. `totals` is sorted by minutes
descending and includes the open segment up to `now`.

### Switch (Shortcuts and Siri)

`POST /api/switch`

```json
{ "categoryName": "Relaxing", "at": "<ISO, optional>", "id": "<uuid, optional>", "source": "shortcut" }
```

`categoryId` may be given instead of `categoryName`. Name matching is
case-insensitive and ignores surrounding whitespace. Unknown name → `404`.
Same category as the open segment → `200 { "noop": true, ... }`.

Response:

```json
{ "noop": false, "closed": { ...segment } | null, "opened": { ...segment } }
```

### Ops (the client outbox)

`POST /api/ops`

```json
{ "ops": [ { "opId": "...", "type": "switch", "payload": { ... }, "createdAt": "..." } ] }
```

Applied strictly in order. Each op is one D1 batch. The response reports each
op; processing continues past a failed op so later independent ops are not
blocked.

```json
{ "results": [ { "opId": "...", "ok": true }, { "opId": "...", "ok": false, "error": { "code": "...", "message": "..." } } ],
  "serverTime": "<ISO>" }
```

Op types and payloads (zod schemas live in `packages/shared/src/ops.ts`):

| type | payload | server behaviour |
| --- | --- | --- |
| `switch` | `{ categoryId, at, newSegmentId, source }` | Close open, open new with the given id. If `newSegmentId` already exists → ok, noop. |
| `segment.upsert` | full `Segment` | Upsert; validate I2 against neighbours; reject with `conflict` if it overlaps. Used by every edit operation; a client edit that touches three segments sends three upserts in one batch. |
| `segment.delete` | `{ id }` | Set `deletedAt`. |
| `category.upsert` | full `Category` | Upsert. |
| `category.delete` | `{ id }` | Set `deletedAt` only if no segments reference it, else `conflict`. UI archives instead. |
| `rule.upsert` | full `Rule` | Upsert. |
| `rule.delete` | `{ id }` | Set `deletedAt`. |
| `settings.upsert` | full `Settings` | Upsert singleton. |

Upserts are last-write-wins on `updatedAt`: an incoming row older than the
stored one is acknowledged `ok: true` but ignored. The server stamps
`updatedAt = max(incoming, now)`.

For `segment.upsert` batches the server validates I1 and I2 after applying
the whole op list for that request, not after each row, so a multi-row edit
can pass through a transiently invalid state.

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

Rows with `updatedAt > since`, including soft-deleted rows. Without `since`,
everything. Segments are capped at 20,000 rows per response; if more exist the
response includes `"nextSince"` and the client pages.

### Convenience reads (debugging, Shortcuts)

- `GET /api/categories` → active categories, sorted.
- `GET /api/segments?from=<ISO>&to=<ISO>` → non-deleted segments overlapping
  the range, oldest first. Max range 92 days.
- `GET /api/rules`
- `GET /api/settings`

### Push

- `GET /api/push/vapid-public-key` → `{ "key": "<base64url>" }`
- `POST /api/push/subscriptions` with the browser's `PushSubscription.toJSON()`
  plus `{ "userAgent": "..." }` → `201 { "id": "..." }`. Upserts on `endpoint`.
- `DELETE /api/push/subscriptions/:id` → `204`.
- `POST /api/push/test` → sends `"Test notification"` to every subscription,
  returns `{ "sent": n, "failed": n }`. Used by the Settings screen.

### Export

- `GET /api/export.csv?from=&to=` → `text/csv` with columns
  `started_at,ended_at,category,minutes,note,source`, local time in the
  settings timezone plus a `started_at_utc` column.
- `GET /api/export.json?from=&to=` → `{ categories, segments, rules, settings }`.

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
