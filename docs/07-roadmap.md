# 07 · Roadmap

Six milestones. One PR each, in order. A milestone is done when every line
of its definition of done is true and `pnpm lint && pnpm typecheck && pnpm
test && pnpm build` pass. Each milestone is sized so an agent can complete it
in one focused session.

## M0 · Scaffold

Tasks:

- pnpm workspace with `apps/web`, `apps/server`, `packages/shared`. Root
  scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `deploy`, `format`.
- `packages/shared`: TypeScript source consumed directly by both apps via
  workspace reference (no build step), with zod and date-fns as dependencies.
  Include a placeholder `dayKeyOf` with one test so the pipeline is proven.
- `apps/web`: Vite + React + TypeScript + Tailwind + `vite-plugin-pwa`
  (`injectManifest`) + Dexie + `dexie-react-hooks` + a router. A hello page.
- `apps/server`: Hono on Workers, `wrangler.toml` with D1 binding, assets
  binding pointing at `public/`, cron `* * * * *`. `GET /api/health`
  implemented. Drizzle configured with an empty schema and a first migration.
- ESLint (typescript-eslint, react-hooks), Prettier, TS strict in every
  package, Vitest in `shared` and `server`.
- GitHub Actions workflow on pull requests: install with frozen lockfile,
  lint, typecheck, test, build.
- `.dev.vars.example` listing every secret with a comment.
- README quick start filled in.

Definition of done:

- Fresh clone, `pnpm install && pnpm build && pnpm test` succeed.
- `pnpm dev` serves the hello page on `localhost:5173` and
  `curl localhost:5173/api/health` returns `{ "ok": true }` through the proxy.
- CI is green on the PR.

## M1 · Core tracking, local only

Tasks:

- Dexie schema for `categories`, `segments`, `rules`, `settings`, `outbox`,
  `meta`, with versioned migrations.
- First-run seed: the ten categories from `01-decisions.md` with final
  colours and icons, default settings (device timezone, day start 4), default
  rules (stored now, used in M3).
- `packages/shared`: all time helpers, segment operations, and aggregation
  functions from `03-data-model.md`, each with tests. Invariants asserted
  after every operation in tests.
- Now screen complete per `05-features.md`, including undo and backdate.
- Today screen complete, including the edit sheet, split, delete with fill,
  and gap assignment.
- Settings: categories manager, day start, timezone, about.
- Manifest, icons, Apple touch icon, service worker precaching, offline
  shell, dark mode, standalone detection.
- Outbox writes happen in M1 even though nothing flushes them yet, so M2
  does not need to touch the UI code paths.

Definition of done:

- Installable on an iPhone from a `wrangler dev --remote` or deployed URL.
  Lighthouse installability passes.
- Switching, undo, backdating, editing, splitting, deleting, and gap filling
  all work offline and survive a full app kill and relaunch.
- Shared package has tests for every operation listed in `03-data-model.md`
  and for day bucketing across a DST change.
- Timer shows the correct elapsed time after the app has been closed for an
  hour.

## M2 · Server, sync and auth

Tasks:

- Drizzle schema and migration for all tables in `03-data-model.md`,
  including the partial unique index for one open segment.
- Bearer auth middleware with constant-time compare.
- Endpoints: `/api/state`, `/api/switch`, `/api/ops`, `/api/snapshot`, the
  convenience reads, `/api/export.csv`, `/api/export.json`.
- Server-side validation of I1 and I2 on ops, with tests using a local D1
  (wrangler's `createTestHarness`: the real Worker in workerd with an
  in-memory D1; see `apps/server/test/harness.ts`).
- Client: login screen, outbox flusher with backoff, snapshot merge, sync
  status in Settings, "Reset local data and re-download".
- Seeding: when the server has no categories and the client pushes its seed
  as upserts, that becomes the canonical set. Document this in the login flow.

Definition of done:

- Fresh install on the phone, paste token, data appears from the server.
- A switch made offline reaches the server within 30 seconds of reconnecting.
- Deleting the PWA and reinstalling restores all history from the snapshot.
- `POST /api/switch` by name works from a Shortcut.
- Server tests cover each op type, idempotent replay, and overlap rejection.

Status: server and client built. The client sync engine (`apps/web/src/sync/`)
has unit tests for batching, partial results, refused ops, backoff, 401,
pulls, the full-resync guard, single flight and triggers. An end-to-end run
with Playwright against `wrangler dev` (390x844 touch viewport) checked:
connect, switches reaching the server, two offline switches landing within a
second of going online, a segment edit, a `POST /api/switch` by name showing
up in the app at the next 30 s pull, a fresh browser profile restoring the
full history with no duplicate categories, Reset, and a rejected token. The
items that need the owner's iPhone (install, real network changes) are still
to be checked on the device.

## M3 · Nudges

Tasks:

- Rule engine in `packages/shared` with the full test list from
  `03-data-model.md`.
- Scheduled handler: load inputs, evaluate, log, send. Subscription cleanup
  on 404 and 410. Structured logging of each evaluation outcome.
- Web Push sending from Workers (verify a library, else implement RFC 8291
  and RFC 8292 with WebCrypto, with a test vector).
- `/api/push/*` endpoints.
- Service worker `push` and `notificationclick` handlers.
- Settings: notifications section, rules manager, stale check settings.
- Owner task list below updated with VAPID key generation.

Status: the server half is done. The scheduled handler
(`apps/server/src/nudges/run.ts`), Web Push sending with
`@block65/webcrypto-web-push` 2.x (verified by decrypting its output with an
RFC 8291 decryptor checked against the RFC's test vector), the `/api/push/*`
endpoints including `GET /api/push/subscriptions`, and VAPID keys the Worker
generates itself, so the owner setup below has no VAPID step. Server tests
cover the scheduled job end to end against D1 with a fake sender, the D1 call
and send budgets, and the real `scheduled` export. The client half (service
worker handlers, Settings notifications and rules) and the on-device checks
below remain.

Definition of done:

- With the Relaxing session rule set to 2 minutes for testing, a real iPhone
  receives the nudge within 3 minutes of switching to Relaxing, and again at
  the repeat interval, and not after switching away.
- Daily budget and stale check verified the same way with short thresholds.
- Quiet hours verified with a window covering "now".
- Test notification button works. Reinstalling the app re-subscribes
  without a duplicate subscription row.

M3 client status (web app):

- Done: service worker `push` and `notificationclick` handlers
  (`apps/web/src/push/swHandlers.ts`, unit tested with malformed payloads);
  the push client (`apps/web/src/push/`): enable from the tap, disable,
  launch and foreground health check that re-subscribes when iOS dropped
  the subscription or the server's VAPID key changed and deletes the
  replaced server row; Settings → Notifications in every state, with the
  server's delivery status and the test button; the rules manager and the
  "Still on it?" stale check section, one outbox op per save. Driven
  end to end in Chromium with stubbed `PushManager` and `Notification` and
  a faked `/api`.
- Needs a real iPhone (cannot be checked headless): every definition of
  done line above, and whether iOS allows the background re-subscribe
  without a tap (docs/06, known quirks).
- A reinstall wipes the app's storage, so the new install cannot know the
  old subscription id; the old row disappears when the push service
  answers 404 or 410 to the server's next send, or the owner removes it
  under "Also sending to" in Settings → Notifications.

## M4 · Dashboards and export

Tasks:

- Stats screen with every chart in `05-features.md`, lazy loaded.
- Range tabs and custom range picker.
- Export buttons wired to the endpoints, with an offline path that builds the
  files from Dexie.
- Performance check with 10,000 synthetic segments: Stats renders under one
  second on a mid-range phone.

Definition of done:

- Every chart reads from the shared aggregation functions, which have tests
  including a segment crossing a day boundary and a segment crossing a DST
  change.
- Stats bundle is a separate chunk; the Now screen bundle is unchanged in
  size within 5 KB from M3.

Status (2026-10-06): built. The Stats screen and Export are in `apps/web`
(`src/pages/Stats.tsx`, `src/pages/stats/`, `src/lib/export.ts`); behaviour
is described in `05-features.md`. Charts are hand-rolled SVG with no new
dependency, in a 13 KB gzipped Stats chunk; the Now route's JS grew by about
2.3 KB gzipped because Rolldown regrouped modules the Now screen already
loads into shared chunks. With 10,000 synthetic segments over a year in
headless Chromium, every preset range renders in under 60 ms after a tab tap
(under 300 ms with 4x CPU throttling) and a full-year custom range in about
0.5 s (about 2 s at 4x, mostly the shared `hourHeatmap` and reading 10,000
rows). Export builds files locally (see `05-features.md`), so the "wired to
the endpoints" task became "matches the endpoints' formats", with tests
for CSV quoting, timezone, the open segment and the JSON shape.

## M5 · iOS glue

Tasks:

- `tools/scriptable/time-tracker-widget.js` per `06-ios.md`, with a README
  screenshot.
- `06-ios.md` recipes verified on a real device, including at least one
  automation, and corrected where iOS has changed.
- Optional: a second read-only token for the widget if the owner wants it
  (`WIDGET_TOKEN` secret, accepted only on `GET /api/state`).

Definition of done:

- Widget shows the live category on the Home Screen and lock screen.
- "I'm relaxing" to Siri switches the tracker.

M5 status: the widget script handles small and medium Home Screen widgets and
rectangular, inline and circular Lock Screen widgets, with an offline cache
and clear errors; it was exercised against stubbed Scriptable APIs in ten
scenarios. 06-ios.md has step-by-step Shortcuts, automation and widget setup.
A GitHub Actions **Deploy** workflow and [08-deploy.md](08-deploy.md) let the
owner deploy without a computer. Still to do on the owner's device: confirm
the widget and the Siri phrase work, and correct 06-ios.md where iOS differs.
The read-only `WIDGET_TOKEN` was not built; the widget uses the app token.

## Backlog (not scheduled)

- ntfy.sh fallback for notifications.
- Snooze a rule for the rest of the day from inside the app.
- Weekly email or push summary.
- Notes search.
- Apple Health sleep import to auto-correct Sleep segments.
- Native companion with a Live Activity timer and WidgetKit widget.
- Browser extension for a laptop, if the owner ever adds one.

## Owner setup tasks (not for the agent)

Follow [08-deploy.md](08-deploy.md). It takes a fresh Cloudflare account to the
installed app from a phone: three GitHub secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `APP_TOKEN`), then the **Deploy** workflow, which
finds or creates the D1 database, applies migrations before deploying, and
sets `AUTH_TOKEN` from `APP_TOKEN`. Push notifications need no setup: the
Worker generates its VAPID key pair on first use and stores it in D1.

Optional, only if you want your own push key pair or contact address:
`wrangler secret put` `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both, from
`npx web-push generate-vapid-keys`) and `VAPID_SUBJECT` (a `mailto:` or
`https:` URL). Setting or changing the keys after the app has subscribed makes
it re-subscribe on its next launch.

Deploying by hand instead: apply migrations first
(`wrangler d1 migrations apply time-tracker --remote`), then
`pnpm run deploy`. New code needs new tables; until they exist every cron run
fails. 08-deploy.md has the full command list.

Secrets are never committed. Local development uses `apps/server/.dev.vars`.
