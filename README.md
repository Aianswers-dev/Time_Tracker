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

Design is complete. No application code exists yet. Start with
[docs/07-roadmap.md](docs/07-roadmap.md), milestone M0.

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

Filled in during milestone M0 once the workspace exists. Planned commands:

```sh
pnpm install
pnpm dev        # Vite dev server + wrangler dev with local D1
pnpm test       # Vitest across packages
pnpm build      # builds the PWA into the Worker's static assets
pnpm deploy     # wrangler deploy
```
