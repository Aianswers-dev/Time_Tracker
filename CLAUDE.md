# Agent guide for Time Tracker

This repo is a single-user, always-on time tracker: a React PWA on an iPhone
plus a Hono API on Cloudflare Workers. All milestones (M0 to M5) are built and
merged. Start with `HANDOFF.md` (current state, decisions, known gaps, lessons
learned), then read `docs/01` through `docs/08` in order before writing code.
They are short and they are the spec.

## Ground rules

- **Decisions in `docs/01-decisions.md` are settled.** Do not add multi-user,
  accounts, a different framework, a paid service, or a native app. If a
  decision turns out to be impossible, write the problem and your proposed
  change under "Open questions" in that file and pick the simplest workaround
  that keeps the free tier and single-user model.
- **One milestone or change per PR.** Update the docs when the code diverges
  from them, in the same PR. New work goes under "Backlog" or "Known
  limitations" first (`docs/07-roadmap.md`, `HANDOFF.md`).
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
- **Stay inside the Workers Free plan** (docs/02 "Free tier budget"): 10 ms of
  CPU and about 50 D1 calls per invocation, 100 bound parameters per statement.
  Batch reads with `db.batch()`, pass id lists through the `json_each` helper,
  page anything that grows with history, and do not add per-row Drizzle work
  to hot paths.

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

## Testing

- Server tests run the real Worker in workerd with an in-memory D1
  (`apps/server/test/harness.ts`). Web data and sync tests use fake-indexeddb
  and the fake server in `apps/web/src/sync/testServer.ts`.
- End-to-end checks of the built app live in `tools/e2e` (see its README).
  Run `tools/e2e/sync` against the real Worker after any sync change, and look
  at the screenshots after any UI change.
- Stop any server you start by port or PID. Never `pkill -f` a pattern that
  also matches your own shell's command line.

## Before opening a PR

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass. Check
  each command's exit status; piping into `tail` hides failures.
- The relevant definition of done in `docs/07-roadmap.md` is met.
- Docs updated where behaviour changed.
