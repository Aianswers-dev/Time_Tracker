# Time Tracker

A personal, always-on time tracker for one person on one iPhone.

Exactly one category is active at every moment. Switching category closes the
current time segment and opens a new one. The app nudges you with a push
notification when you have spent too long on a category, and shows dashboards
of where your day went.

- **Client:** React PWA installed to the iPhone Home Screen. Local-first, works offline.
- **Server:** tiny Hono API on Cloudflare Workers with a D1 (SQLite) database and a
  once-a-minute cron that evaluates nudge rules and sends Web Push.
- **Cost:** $0. Everything stays inside the Cloudflare free tier.
- **iOS extras:** Siri and Shortcuts automations via the API, a Scriptable home
  screen widget. No native app.

## Status

M0 to M2 are in place: the scaffold, local tracking, and the server with sync
and auth. M3 (nudges) has its server half: the once-a-minute cron evaluates the
rules and sends Web Push, and the `/api/push/*` endpoints are ready for the
app. Push needs no setup: the Worker generates its own VAPID keys. See
[docs/07-roadmap.md](docs/07-roadmap.md).

## Documentation

Read in order.

| Doc | What it covers |
| --- | --- |
| [01-decisions.md](docs/01-decisions.md) | Settled product and technical decisions, starting categories, out of scope |
| [02-architecture.md](docs/02-architecture.md) | Components, key flows, sync, time handling, hosting, free tier budget |
| [03-data-model.md](docs/03-data-model.md) | Types, SQL schema, invariants, segment math, rule engine semantics |
| [04-api.md](docs/04-api.md) | HTTP API, auth, sync ops, push endpoints |
| [05-features.md](docs/05-features.md) | Screen by screen feature spec with acceptance criteria |
| [06-ios.md](docs/06-ios.md) | iOS constraints, install and push flow, Shortcuts recipes, Scriptable widget |
| [07-roadmap.md](docs/07-roadmap.md) | Milestones, task breakdown, definition of done, owner setup tasks |

Agents working in this repo should also read [CLAUDE.md](CLAUDE.md).

## Quick start

### Prerequisites

- Node 22 (check [.nvmrc](.nvmrc))
- pnpm 10: run `corepack enable` to use the version pinned in `package.json`

### Commands

```sh
pnpm install              # Install dependencies
pnpm dev                  # Vite on :5173 proxying /api to wrangler dev on :8787 with local D1
pnpm test                 # Vitest across packages
pnpm lint                 # ESLint and Prettier
pnpm typecheck            # TypeScript checks
pnpm build                # builds the PWA into the Worker's static assets
pnpm run deploy           # pnpm deploy is a pnpm built-in, so use run
```

### Local development

`pnpm dev` applies the local D1 migrations, then starts `wrangler dev` on :8787
and Vite on :5173. Open `http://localhost:5173`. Vite proxies `/api` to the
Worker, so `curl localhost:5173/api/health` returns `{ "ok": true, ... }`.

The API needs a token from M2 on: every `/api` route except `/api/health`
answers `401` until `AUTH_TOKEN` is set. Copy the example file and fill it in:

```sh
cp apps/server/.dev.vars.example apps/server/.dev.vars
openssl rand -base64 32   # paste as AUTH_TOKEN
```

### Server tests

`pnpm test` includes them; to run only the server's:

```sh
pnpm --filter @time-tracker/server test
```

They start the real Worker in workerd with wrangler's `createTestHarness`,
backed by an in-memory local D1 with the migrations in `apps/server/drizzle`
applied, and call it over HTTP. No Cloudflare account, network or
`.dev.vars` is needed (the tests set their own `AUTH_TOKEN`), and your
`wrangler dev` database is not touched. Each test file starts its own Worker
and every table is emptied before each test.

While `pnpm dev` runs, trigger the cron handler by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

### Repo layout

- `apps/web`: React PWA, Tailwind, service worker
- `apps/server`: Hono on Workers, D1 database, cron handler
- `packages/shared`: types, zod schemas and all time math, with Vitest tests
