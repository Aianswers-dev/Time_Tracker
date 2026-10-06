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
changes with no extra state library.

Service worker (`vite-plugin-pwa`, `injectManifest` so we control the file):
precaches the app shell, handles `push` by showing a notification from the
payload, handles `notificationclick` by focusing or opening the app.

### `apps/server` (Hono on Workers)

- `fetch` handler: `/api/*` routes, everything else falls through to the
  assets binding with SPA fallback to `index.html`.
- `scheduled` handler: runs the rule engine once a minute.
- Bindings: `DB` (D1), `ASSETS`. Secrets: `AUTH_TOKEN`, `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` URL).
- Drizzle schema and generated SQL migrations under `apps/server/drizzle`.

### `packages/shared`

Pure TypeScript, no runtime dependencies beyond zod and a date library.

- Types and zod schemas for every entity and every API payload.
- Time helpers: `dayKeyOf`, `dayRange`, `splitByDay`.
- Segment operations: `switchCategory`, `moveBoundary`, `insertSegment`,
  `splitSegment`, `changeCategory`, `deleteSegment`, `undoSwitch`.
- Aggregation: `totalsForRange`, `timelineForDay`, `hourHeatmap`.
- Rule engine: `evaluateRules(input, now) -> Notification[]`.

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
`GET /api/snapshot?since=<lastSync>` and merge rows into Dexie, keeping
whichever copy has the later `updatedAt`. Store the returned `serverTime` as
the new `lastSync`.

**4. Nudge evaluation (cron).** Load the open segment, its category, enabled
rules for that category, settings, today's minutes for that category, and the
notification log for the open segment and the current day. Call
`evaluateRules`. For each resulting notification: insert a log row, then send
a Web Push to every stored subscription. Delete a subscription on HTTP 404 or
410 from the push service. The log insert happens before the send so a crash
mid-send cannot cause a duplicate on the next minute.

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
  a change invisible to the next pull.
- One user action produces one op. The outbox holds ordered ops
  `{ opId, type, payload, createdAt }`, sent in batches of up to 200 and
  applied in order, each atomically.
- Upserts are last-write-wins: the server applies an incoming row when its
  `updatedAt` is at least the stored one, otherwise acknowledges and ignores it.
- A `switch` op carries the new segment's id, so a replay after a timeout is
  a no-op. The server runs the shared `switchCategory` against its own state,
  so an offline switch still lands correctly after a Shortcut switch.
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

## Time handling

- Storage and wire format: ISO 8601 UTC with milliseconds, e.g.
  `2026-10-02T03:15:00.000Z`.
- A timestamp belongs to logical day `dayKeyOf(t)`: convert `t` to the
  settings timezone, subtract `dayStartHour` hours, take the calendar date as
  `YYYY-MM-DD`.
- Totals split segments at logical day boundaries. The open segment is treated
  as ending at `now` for all computations.
- Library: `date-fns` with `@date-fns/tz`. Do not hand-roll timezone math.
- Daylight saving transitions are handled by the library; the one test that
  matters is a segment spanning a DST change still summing to the correct
  number of real minutes.

## Security

- Every `/api/*` route except `/api/health` requires
  `Authorization: Bearer <AUTH_TOKEN>`. Compare in constant time.
- Reject request bodies over 1 MB. No rate limiting is needed for one user.
- The VAPID private key never leaves the Worker. The public key is served by
  `GET /api/push/vapid-public-key`.
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
- CI (GitHub Actions) on every PR: install, lint, typecheck, test, build.
  Deploys are manual from the owner's machine.

## Free tier budget

| Resource | Free limit | Expected use |
| --- | --- | --- |
| Worker requests | 100,000 / day | Cron 1,440 + app traffic well under 2,000 |
| Worker CPU | 10 ms / invocation | Rule evaluation and one push encryption are well under 10 ms |
| Cron Triggers | Available on free plan | 1 trigger, every minute |
| D1 reads | 5,000,000 rows / day | Cron reads under 20 rows per minute |
| D1 writes | 100,000 rows / day | Dozens per day |
| D1 storage | 5 GB | Under 10 MB after years of use |
| Static assets | Free | One small SPA |

If Workers CPU limits ever bite during push encryption, the fix is to batch
fewer subscriptions per invocation, not to move to a paid plan.
