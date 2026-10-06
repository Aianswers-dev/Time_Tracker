# End-to-end checks

Playwright scripts that drive the built app the way a phone would, at a
390x844 touch viewport in light and dark mode. They are manual checks, not
part of CI: run them before merging a change to sync, push, the Now or Today
screens, or Stats. Each prints PASS/FAIL lines (or OK lines) and writes
screenshots to a `shots/` folder next to the script (gitignored). Look at the
screenshots, not just the exit code.

## Setup

```sh
cd tools/e2e
npm install            # playwright 1.56.1, outside the pnpm workspace
npx playwright install chromium   # skip in Claude Code cloud sessions
```

In Claude Code cloud sessions Chromium is preinstalled: run every script with
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and never run `playwright install`
(1.56.1 matches the preinstalled build).

## Suites

| Folder | Serves the app with | Port | What it proves |
| --- | --- | --- | --- |
| `local-ui/` | `pnpm --filter @time-tracker/web build` then `pnpm --filter @time-tracker/web preview --port 4173 --strictPort` | 4173 | M1: first run seeds 10 categories, switch, timer ticks, undo, backdate, every Today sheet (edit preview, split, delete, gap assign), category editing, reload persistence, offline reload. `insets-and-perf.mjs`: simulated iPhone safe areas and switch latency with 10,000 segments. `installability.mjs`: manifest and icons. |
| `sync/` | the real Worker: see "Real Worker" below | 8788 | M2, 16 checks: banner, wrong token refused, connect pushes the seed, switches reach the server, offline switches land in order, recovery from an unreachable server, edits sync, a Shortcut switch shows up after a pull, a fresh phone restores the full history without duplicates, reset, rejected token and recovery. `offline-shortcut.mjs`: an offline switch and a later Shortcut switch both survive. `final-probe.mjs`: every screen loads without page errors. |
| `notifications/` | `vite preview` on 4176 | 4176 | M3 client: every Notifications state (not installed, not connected, ready, on, denied, not delivering, re-keyed), rules add/edit/delete, the "Still on it?" settings. Push is stubbed and `/api/**` faked; real delivery needs an iPhone. |
| `stats/` | `vite preview` on 4177 | 4177 | M4: every range and chart, bar tap to Today, CSV and JSON downloads, empty and day-one states, render time with 10,000 segments. `shots.mjs` screenshots everything; `profile.mjs` breaks down the year-range cost. |
| `nudge-chain/` | the real Worker on 8790 with `AUTH_TOKEN=it-token` | 8790 | M3 server: sync ops create a 1-minute rule, a Shortcut switch, a push subscription with real P-256 keys, then `curl "http://localhost:8790/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"` logs a nudge and attempts the send. TypeScript: bundle it first, e.g. `npx esbuild nudge-chain.ts --bundle --platform=node --format=esm --outfile=/tmp/nudge-chain.mjs && node /tmp/nudge-chain.mjs`. |

`../scriptable/test-harness.mjs` runs the Scriptable widget under Node with
stubbed Scriptable APIs in ten scenarios:
`node tools/scriptable/test-harness.mjs tools/scriptable/time-tracker-widget.js`.

## Real Worker

```sh
printf 'AUTH_TOKEN=e2e-token\n' > apps/server/.dev.vars   # gitignored
pnpm build                                             # app into apps/server/public
cd apps/server
rm -rf .wrangler/state                                 # fresh local D1
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev --port 8788 --test-scheduled
```

The Worker serves both the app and the API on the one port. When done, stop
it by port (find the PID with `ss -ltnp | grep 8788` or `ps`), and do not use
`pkill -f` with a pattern that also matches your own shell's command line.
Leftover preview servers from earlier runs hold their port and serve an old
build; `--strictPort` makes that fail loudly instead of silently.
