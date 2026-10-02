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

The M0 scaffold is in place. M1 (core tracking, local only) is next. See
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

Secrets are not read before M2. When they are, copy the example file first:

```sh
cp apps/server/.dev.vars.example apps/server/.dev.vars
```

While `pnpm dev` runs, trigger the cron handler by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

### Repo layout

- `apps/web`: React PWA, Tailwind, service worker
- `apps/server`: Hono on Workers, D1 database, cron handler
- `packages/shared`: types, zod schemas and all time math, with Vitest tests
