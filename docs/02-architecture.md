# 02 · Architecture

## Overview

```
 iPhone                                   Cloudflare (free tier)
 ┌──────────────────────────┐             ┌──────────────────────────────┐
 │ Home Screen PWA          │  HTTPS      │ Worker (apps/server)         │
 │  React UI                │────────────▶│  Hono API  /api/*            │
 │  Dexie (IndexedDB)       │◀────────────│  Static assets (built PWA)   │
 │  Service worker (push)   │             │  Cron Trigger  * * * * *     │
 └──────────────────────────┘             │        │                     │
        ▲  Web Push                       │        ▼                     │
        │                                 │  D1 (SQLite) via Drizzle     │
 ┌──────┴────────┐                        └──────────────┬───────────────┘
 │ Apple push    │◀──── VAPID-signed request ────────────┘
 │ service       │
 └───────────────┘
 ┌──────────────────────────┐
 │ Shortcuts / Siri         │──── POST /api/switch ───────▶ same Worker
 │ Scriptable widget        │──── GET  /api/state  ───────▶ same Worker
 └──────────────────────────┘
```

Three packages, one deploy target.

## Components

### `apps/web` (React PWA)

Routes:

| Path | Screen | Purpose |
| --- | --- | --- |
| `/` | Now | Category grid, running timer, undo, backdate |
| `/today` | Today | 24h timeline from day start, totals, edit and backfill |
| `/stats` | Stats | Dashboards over today, week, month |
| `/settings` | Settings | Categories, rules, notifications, token, day start, export |

State lives in Dexie tables that mirror the server tables, plus an `outbox`
table and a `meta` table (token, lastSync). React reads Dexie through
`dexie-react-hooks` (`useLiveQuery`), so every screen updates when the data
changes with no extra state library. Every user action is one Dexie
transaction that writes the changed rows and appends one outbox op
(`apps/web/src/data/`). The Now screen is in the main bundle; Today, Stats
and Settings are lazy route chunks, all precached by the service worker.

Service worker (`vite-plugin-pwa`, `injectManifest` so we control the file):
precaches the app shell, handles `push` by showing a notification from the
payload, handles `notificationclick` by focusing or opening the app.

### `apps/server` (Hono on Workers)

- `fetch` handler: `/api/*` routes, everything else falls through to the
  assets binding with SPA fallback to `index.html`.
- `scheduled` handler: runs the rule engine once a minute
  (`src/nudges/run.ts`).
- Bindings: `DB` (D1), `ASSETS`. Secret: `AUTH_TOKEN`. Optional secrets:
  `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (used only when both are set),
  `VAPID_SUBJECT` (a `mailto:` or `https:` URL). Without them the Worker
  generates a VAPID key pair on first use and keeps it in the `server_config`
  table, and signs with `https://<the host the app registered from>` as the
  subject, so the owner needs no VAPID setup (`src/push/vapid.ts`).
- Web Push sending: `@block65/webcrypto-web-push` 2.x (aes128gcm per RFC 8291,
  `vapid` authorization per RFC 8292, both accepted by Apple), behind a small
  `PushSender` interface so the scheduled job is testable (`src/push/`).
- Drizzle schema and generated SQL migrations under `apps/server/drizzle`.

### `packages/shared`

Pure TypeScript, no runtime dependencies beyond zod and a date library.

- Types and zod schemas for every entity and every API payload.
- Time helpers: `dayKeyOf`, `dayRange`, `splitByDay`, day key arithmetic,
  `localDateTimeToMs`, quiet-hour windows, formatting.
- Segment operations: `switchCategory`, `backdateOpen`, `editSegment`,
  `splitSegment`, `insertSegment`, `deleteSegment`, `undoRows`,
  `checkInvariants`.
- Aggregation: `totalsForRange`, `timelineForDay`, `dailyTotals`,
  `hourHeatmap`, `budgetStatus`, `movingAverage`.
- Rule engine: `evaluateRules(input) -> PendingNotification[]`.

The server runs the rule engine; the client runs the same totals code for
dashboards. One implementation, tested once.

## Key flows

**1. Switch category, online.** Tap a tile. The client runs `switchCategory`
against local segments, writes the closed and new segment to Dexie in one
transaction, appends a `switch` op to the outbox. UI updates immediately. The
outbox flusher POSTs the op to `/api/ops`. The server applies it atomically.
Within 60 seconds the cron sees the new open segment.

**2. Switch category, offline.** Same as above; the op waits in the outbox.
The flusher retries on the `online` event, on app focus, and every 30 seconds
while the app is open. Nudges for the new segment cannot fire until the op
reaches the server. This is a known and accepted limitation.

**3. App open or focus.** Flush the outbox first, then
`GET /api/snapshot?since=<lastSync>` and write the returned rows into Dexie:
the server's copy wins, except rows touched by ops still waiting in the
outbox. Store the returned `serverTime` as the new `lastSync`.

**4. Nudge evaluation (cron).** `runNudges` in `apps/server/src/nudges/run.ts`:

1. One D1 read batch (one call, one consistent view): settings (or
   `defaultSettings('UTC')`), the open segment, its category, its category's
   enabled non-deleted rules, the notification log rows for the open segment
   and for today's day key, the live segments that are open or end in the
   last 48 hours (for today's total of the category), the push subscriptions
   and `server_config`. The reads that depend on the open segment use a
   subquery; the day-key read asks for every key the current instant can have
   under any timezone and day start (at most four), because the settings are
   not known yet. Extra rows are harmless to the rule engine.
2. No open segment, or no subscriptions: stop. That is the whole run.
3. Call the shared `evaluateRules` with `todayMs` from the shared `todayMsFor`.
   Nothing due: stop.
4. Resolve the VAPID keys and subject. Only the very first send without VAPID
   secrets writes (one call: store a generated pair). If no subject is known
   yet (nothing has registered from the app), stop without logging, so the
   notifications fire as soon as one is.
5. One write batch: a `notification_log` row for each notification, plus a
   prune of log rows older than 60 days (except the open segment's). The log
   is written before anything is sent, so a crash mid-send cannot cause a
   duplicate on the next minute. Each row is inserted only if no row for the
   same notification appeared since the run's read, and only inserted rows
   are sent, so two overlapping runs (a cron delivered twice) send it once.
6. Send each notification to each subscription (subscriptions in parallel,
   notifications to one subscription in order), at most 6 sends per run. When
   more are due than fit, the extra notifications are neither logged nor sent
   and go out a minute later. One bad subscription never stops the others.
7. One batch recording each subscription's outcome: 404 or 410 deletes it;
   any other failure adds to `failure_count`; a success sets
   `last_success_at` and resets the count.
8. Log one JSON line: `{ event: "nudges", outcome, now, openSegmentId, fired,
   deferred, subscriptions, sent, failed, removed, errors }`, where `outcome`
   is `no_open_segment`, `no_subscriptions`, `nothing_due`,
   `no_vapid_subject` or `sent`, `fired` and `deferred` are notification tags
   (`session:<ruleId>`, `daily:<ruleId>`, `stale`) and `errors` are push
   service answers such as `HTTP 403 {"reason":"BadJwtToken"}`. Tokens, keys
   and endpoints are never logged.

So a run makes 1 D1 call when nothing is due and at most 4 when it sends
(3 once the key pair exists), and at most 6 push subrequests.

**5. Push received.** The service worker shows the notification using
`title`, `body`, `tag`, and `data.url` from the payload. Tapping focuses an
open client or opens `/`. iOS ignores action buttons, so none are used.

**6. Shortcuts and Siri.** A shortcut calls `POST /api/switch` with the bearer
token and a category name. Siri phrases are attached to shortcuts by the
owner. Recipes in `06-ios.md`.

**7. Widget.** A Scriptable script fetches `GET /api/state` and renders the
current category, elapsed time, and today's top categories. iOS decides the
actual refresh cadence.

## Sync details

- Every synced row carries `id` (client UUID v7), `createdAt`, `updatedAt`,
  and nullable `deletedAt`. `updatedAt` is set by whoever made the change (the
  phone for app edits, the server for Shortcut switches) and is never
  restamped. Deletes are soft: an upsert with `deletedAt` set.
- The server adds a `synced_at` column to every synced table: server time of
  the last write. It is the snapshot cursor, so phone clock drift cannot make
  a change invisible to the next pull. The snapshot re-reads the 10 seconds
  before `since`, so a write that committed while the previous snapshot was
  being read is not skipped.
- One user action produces one op. The outbox holds ordered ops
  `{ opId, type, payload, createdAt }`, sent in batches of up to 50 (the
  server accepts 200) and applied in order, each atomically. The server
  applies at most 15 ops per request (D1 allows 50 queries per request on the
  Free plan) and answers only those; the client keeps the unanswered ops and
  sends them again straight away.
- Upserts are last-write-wins: the server applies an incoming row when its
  `updatedAt` is at least the stored one, otherwise acknowledges and ignores it.
- A `switch` op carries the new segment's id, so a replay after a timeout is
  a no-op. The server runs the shared `switchCategory` against its own state,
  with the op's `createdAt` as `madeAt`: a switch that waited offline still
  lands, and a Shortcut switch made in the meantime stays (the offline
  segment ends where it starts). Its rows carry the op's `createdAt` (capped
  at the server's time) as `updatedAt`, so an edit or Undo queued after the
  switch wins last-write-wins against them.
- Failed ops (any `ok: false` result) are dropped from the outbox, a toast
  names the change that did not sync, and the client does a full resync:
  it replaces its local synced tables with a full snapshot. The server is the
  durable truth, so this always converges. `5xx` and network errors keep the
  op and retry with exponential backoff (2s, 4s, 8s, capped at 60s).
- After a successful flush the client pulls `GET /api/snapshot?since=` and
  overwrites local rows with the server's copies, except rows touched by an op
  still waiting in the outbox. The outbox is flushed first, so the server copy
  already includes every local change.
- A year of use is roughly 5 to 10 thousand segments, which IndexedDB handles
  comfortably, so the client keeps the full history locally and the snapshot
  is not paged.
- The server is authoritative for the invariants. It checks I1 and I2 after
  applying each op and rejects the whole op with `conflict` if they fail.

### The client sync engine (`apps/web/src/sync/`)

- **One round at a time.** `scheduler.ts` runs rounds single-flight: a
  trigger during a round makes that round go again when it finishes instead
  of starting a second one, and Reset waits for the running round.
- **Triggers.** App start, the page becoming visible, the `online` event,
  every 30 s while visible, and 1 s after the last outbox write (`enqueue`
  in `data/outbox.ts` notifies the scheduler). Nothing runs without a token
  or while `navigator.onLine` is false (except Sync now).
- **Flush** (`engine.ts`). Ops go in `seq` order, 50 per request, and every
  response is validated with `opsResponseSchema`. `ok: true` deletes the
  row. `ok: false` deletes it too, queues a toast ("Couldn't sync: switch
  to Relaxing") and flags a full resync. Ops without a result are sent again
  at once, until the outbox is empty; a request that applies nothing counts
  as a failure. A `413` halves the batch.
- **Failures.** No answer, a `5xx` or any other refused request keeps every
  op, bumps its `attempts`, records `lastError`, and retries after 2 s, 4 s,
  8 s ... capped at 60 s. Interval and outbox triggers wait out the backoff;
  focus, `online` and Sync now do not. A `401` stops syncing and marks the
  token rejected (meta `tokenRejected`) until a new token is saved; the
  outbox is kept.
- **Pull.** Only after a flush that emptied the outbox. One Dexie
  transaction writes every returned row (soft-deleted ones included) and the
  settings row if present. Rows touched by ops queued while the request was
  in flight keep their local copy: ids named by `segments.upsert`,
  `category.upsert` and `rule.upsert`, the settings for `settings.upsert`,
  and for a `switch` the new segment plus every segment still open or ending
  at or after its `at` (the switch closed or trimmed those locally). When
  anything was skipped, `lastSync` stays put so the next pull reads those
  rows again, and another round follows at once.
- **Full resync.** After any failed op, on every Connect, and for Reset:
  `GET /api/snapshot` without `since`, then one transaction clears
  `categories`, `segments`, `rules` and `settings` and writes the snapshot
  (rows touched by pending ops keep their local copy, as above). Guard: if
  the server has no live categories but this phone has some, or the
  snapshot lacks (even as a deleted row) a category this phone has live
  entries in (a server that lost its data and got a rename or a switch back
  since), nothing is wiped; the round fails with "Your server is missing
  data this phone has, so this phone kept its data instead of replacing it",
  `serverEmpty` is set (Settings offers the upload) and the flag stays set.
  Reset discards the outbox inside that same transaction, so a refused
  Reset keeps the outbox too.
- **State for the UI.** Dexie `meta` holds `lastSync` (server time, the
  pull cursor), `lastSyncedAt` (device time, for display), `tokenRejected`,
  `syncError` (`{ message, at, kind }`, kind `retry`, `problem` or `notice`,
  cleared by the next clean round), `needsFullResync` and
  `connectBannerDismissed`. Whether a round is running and when the next
  retry is due live in memory (`runtime.ts`). `useSyncStatus()` combines
  them with the outbox count for the Settings section and the status pill.
- **First connect and seeding.** The seed is queued as upserts with fixed
  ids and `updatedAt` 2000-01-01. On an empty server it becomes the
  canonical set. On a server that already has data (a reinstall), the ids
  match the existing rows and any row the owner edited is newer, so
  last-write-wins ignores the seed op for it (an unedited seed row is
  rewritten as it was). The full resync that follows brings everything else
  down: no duplicate categories.

## Time handling

- Storage and wire format: ISO 8601 UTC with milliseconds, e.g.
  `2026-10-02T03:15:00.000Z`.
- A timestamp belongs to logical day `dayKeyOf(t)`: convert `t` to the
  settings timezone, subtract `dayStartHour` hours, take the calendar date as
  `YYYY-MM-DD`.
- Totals split segments at logical day boundaries. The open segment is treated
  as ending at `now` for all computations.
- Library: `date-fns` with `@date-fns/tz`. Do not hand-roll timezone math.
  One exception: do not build instants from local wall-clock fields with the
  `TZDate` constructor or mutate a `TZDate` (`subDays` and friends). For
  repeated and skipped local times its answer depends on the runtime's own
  timezone, so the phone and the Worker disagree. `time.ts` converts with
  `tzOffset` instead; reading fields from `new TZDate(ms, tz)` is fine.
- Daylight saving transitions are handled by the library; the one test that
  matters is a segment spanning a DST change still summing to the correct
  number of real minutes.

## Security

- Every `/api/*` route except `/api/health` requires
  `Authorization: Bearer <AUTH_TOKEN>`. Compare in constant time. An unset
  or empty `AUTH_TOKEN` rejects every request.
- Reject request bodies over 1 MB. No rate limiting is needed for one user.
- The VAPID private key never leaves the Worker. The public key is served by
  `GET /api/push/vapid-public-key`. A generated pair is stored in D1
  (`server_config`), which only the Worker can read. Push endpoints and keys
  are never logged or returned by the API.
- The owner generates the token with `openssl rand -base64 32` and sets it via
  `wrangler secret put AUTH_TOKEN`. The client stores it in Dexie `meta`.
- The service worker and app are same-origin with the API, so no CORS
  configuration is required. Shortcuts and Scriptable are not browsers and do
  not need CORS either.

## Development and deployment

- `pnpm dev` runs `wrangler dev` (API, local D1, `--test-scheduled`) and the
  Vite dev server with `/api` proxied to `localhost:8787`.
- `pnpm build` builds the PWA into `apps/server/public`, which `wrangler.toml`
  declares as the assets directory.
- `pnpm run deploy` runs `wrangler deploy`.
- Migrations: `drizzle-kit generate` produces SQL; `wrangler d1 migrations
  apply` runs it locally or remotely.
- Trigger the cron locally with
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`.
- Server tests (`pnpm --filter @time-tracker/server test`) run the real
  Worker in workerd through wrangler's `createTestHarness`, with an in-memory
  local D1 and the migrations in `apps/server/drizzle` applied. No Cloudflare
  account or network access is needed.
- CI (GitHub Actions) on every PR: install, lint, typecheck, test, build.
  Deploys are manual from the owner's machine.

## Free tier budget

| Resource | Free limit | Expected use |
| --- | --- | --- |
| Worker requests | 100,000 / day | Cron 1,440 + app traffic well under 2,000 |
| Worker CPU | 10 ms / invocation | Rule evaluation is negligible. Each push send costs an ECDH key pair, ECDH, HKDF, AES-GCM over 4 KB and an ECDSA signature (about 3 ms measured in Node); at most 6 sends per invocation |
| Subrequests | 50 / invocation | Cron: at most 6 push sends plus at most 4 D1 calls |
| Cron Triggers | Available on free plan | 1 trigger, every minute |
| D1 reads | 5,000,000 rows / day | Cron reads the open segment's rows plus the last 48 hours of segments through indexes: tens of rows per minute, under 150,000 a day |
| D1 writes | 100,000 rows / day | Dozens per day |
| D1 queries per request | 50 | `/api/ops` applies at most 15 ops of at most 3 calls each; the cron makes 1 to 4; other routes make at most 4 |
| D1 storage | 5 GB | Under 10 MB after years of use |
| Static assets | Free | One small SPA |

If Workers CPU limits ever bite during push encryption, the fix is to lower
`MAX_PUSH_SENDS_PER_INVOCATION` in `apps/server/src/push/deliver.ts` (the
notifications that do not fit wait for the next minute), not to move to a paid
plan.
