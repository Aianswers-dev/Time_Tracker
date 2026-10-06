# Agent guide for Time Tracker

This repo is a single-user, always-on time tracker: a React PWA on an iPhone
plus a Hono API on Cloudflare Workers. Read `docs/01` through `docs/07` in
order before writing code. They are short and they are the spec.

## Ground rules

- **Decisions in `docs/01-decisions.md` are settled.** Do not add multi-user,
  accounts, a different framework, a paid service, or a native app. If a
  decision turns out to be impossible, write the problem and your proposed
  change under "Open questions" in that file and pick the simplest workaround
  that keeps the free tier and single-user model.
- **One milestone per PR**, in roadmap order. Finish the milestone's
  definition of done before starting the next. Update the docs when the code
  diverges from them, in the same PR.
- **The timer is derived, never run.** Elapsed time is `now - startedAt` of
  the open segment. Never store a running counter. `setInterval` is only for
  re-rendering the clock.
- **All time math lives in `packages/shared`** as pure functions with Vitest
  tests: day bucketing, splitting segments across day boundaries, totals,
  switch and edit operations, the rule engine. Both apps import it.
- **Times are ISO 8601 UTC strings** everywhere in storage and over the wire.
  Local day boundaries use the timezone and `dayStartHour` from settings.
- **Local-first.** The UI reads and writes Dexie (IndexedDB). An outbox replays
  writes to the server. Never put app data in `localStorage`.
- **Validate at boundaries with zod**, schemas shared between client and server.

## Conventions

- pnpm workspaces: `apps/web`, `apps/server`, `packages/shared`.
- TypeScript strict, no `any`, ESLint + Prettier, Vitest.
- React function components, hooks, Tailwind. Mobile portrait first. Touch
  targets at least 56px. Must look right in dark mode.
- Hono for the API. Drizzle ORM for D1. Migrations committed under
  `apps/server/drizzle`.
- Never commit secrets. Local secrets go in `apps/server/.dev.vars` (gitignored).
  Document any new secret in `docs/07-roadmap.md` under owner setup tasks.

## Commands (available after M0)

```sh
pnpm install
pnpm dev          # web on :5173 proxying /api to wrangler dev on :8787
pnpm test
pnpm lint && pnpm typecheck
pnpm build
pnpm run deploy   # pnpm deploy is a pnpm built-in, so use run
```

## Before opening a PR

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass.
- The milestone's definition of done in `docs/07-roadmap.md` is met, item by item.
- Docs updated where behaviour changed.
