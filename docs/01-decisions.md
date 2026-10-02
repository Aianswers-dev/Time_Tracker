# 01 · Decisions

Agreed with the owner on 2026-10-02. Treat everything here as fixed unless the
owner changes it. Record anything you cannot satisfy under "Open questions" at
the bottom instead of silently deviating.

## Product decisions

**P1. Single user.** One person, one phone. No accounts, sign-up, sharing, or
multi-user anywhere in the data model or UI.

**P2. Phone only.** The owner uses an iPhone and nothing else. Design for a
phone in portrait. The app must still open in a desktop browser for debugging,
but desktop layout is not a goal.

**P3. Exactly one category is active at any moment.** No overlapping
activities. If the owner is eating while watching TV, that is one category,
whichever they pick.

**P4. Always on.** Once the first category is chosen there is always an open
segment. There is no Stop or Pause button. Gaps only appear through editing
(for example deleting a segment) and are displayed as "Untracked".

**P5. Starting categories.** Seeded on first run in this order. All are
editable later (rename, recolour, reorder, archive, add new).

| Order | Name | Covers | Colour hint | Stale check |
| --- | --- | --- | --- | --- |
| 1 | Sleep | Sleeping, in bed | Indigo | Exempt |
| 2 | Relaxing | TV, scrolling, gaming, doing nothing | Red/coral | On |
| 3 | Housework | Cooking, cleaning, laundry, groceries | Amber | On |
| 4 | Casual work | Hospitality job | Teal | On |
| 5 | Contract work | Software job | Blue | On |
| 6 | Uni study | Lectures, assignments, revision | Purple | On |
| 7 | Life admin | Bills, appointments, errands, email | Slate | On |
| 8 | Travel / commute | Driving, public transport, walking somewhere | Cyan | On |
| 9 | Socialising | Friends, family, calls, going out | Pink | On |
| 10 | Hobbies | Anything fun that is not Relaxing | Green | On |

Colours must be distinguishable on a dark and a light background and are the
only way categories are told apart on the timeline, so pick a palette with
care. Final hex values are chosen during M1.

**P6. Three nudge types, all supported.** Session limit (one unbroken
stretch), daily budget (total for the logical day), stale check (any category
running implausibly long, which usually means the owner forgot to switch).
Full semantics in `03-data-model.md`. Each rule can repeat while still over
the threshold. Quiet hours suppress nudges.

Seeded defaults are the agent's assumption and the owner will tune them in
the app:

| Rule | Category | Threshold | Repeat |
| --- | --- | --- | --- |
| Session limit | Relaxing | 60 min | every 30 min |
| Daily budget | Relaxing | 180 min | every 60 min |
| Stale check | all except Sleep | 300 min | every 60 min |

No quiet hours by default.

**P7. Logical day.** The day starts at a configurable hour, default 04:00
local. A 1am Netflix session counts toward the previous day. Timezone comes
from the device on first run and is stored in settings.

**P8. Platform.** PWA installed to the Home Screen. No native app in scope.
Home screen widget via Scriptable. Siri and automations via iOS Shortcuts
calling the API.

## Technical decisions

**T1. Frontend.** React 18+, Vite, TypeScript strict, Tailwind.
`vite-plugin-pwa` for the manifest and service worker. Dexie for IndexedDB.

**T2. Backend.** Hono on Cloudflare Workers. D1 (SQLite) through Drizzle ORM.
A Cron Trigger every minute evaluates nudge rules. The built PWA is served as
static assets from the same Worker, so client and API share an origin.

Why Workers rather than a Node VPS: it is the free tier that is always on.
Free Node hosts sleep when idle, which kills a scheduler. Hono also runs on
Node, so moving to a self-hosted Node + SQLite setup later is cheap.

**T3. Cost is $0.** Stay inside the Cloudflare free tier. See the budget table
in `02-architecture.md`.

**T4. Auth.** One long random bearer token stored as a Worker secret
(`AUTH_TOKEN`). The client stores it in IndexedDB after a one-time paste on a
login screen. Shortcuts and the Scriptable widget use the same token.

**T5. Local-first with an outbox.** The UI reads and writes IndexedDB. Every
write also goes into an outbox that replays to the server in order. The server
is the durable copy and the only place nudges are scheduled. IDs are generated
on the client (UUID v7). Soft deletes via `deletedAt`. Last write wins by
`updatedAt`; with a single device conflicts are rare and acceptable.

**T6. Notifications.** Web Push with VAPID to the installed PWA. If iOS web
push proves unreliable in practice, the fallback is posting to an ntfy.sh topic
with the ntfy iOS app installed. Only build the fallback if needed.

**T7. Monorepo.** pnpm workspaces: `apps/web`, `apps/server`, `packages/shared`.

**T8. Testing.** Vitest. Segment math and the rule engine must be unit tested.
UI tests are optional.

**T9. Time representation.** ISO 8601 UTC strings in storage and over the
wire. Day bucketing uses the settings timezone and `dayStartHour`.

## Out of scope for now

- Native iOS app, Live Activities, WidgetKit. Revisit only if the PWA is in
  daily use and the Scriptable widget is not enough.
- Multi-user, sharing, accounts, teams.
- Desktop layout.
- Automatic activity detection inside the app. The owner may wire up
  Shortcuts automations themselves; the app only exposes the API.
- Apple Health or sleep import.
- Data import from other trackers.

## Open questions

None at the time of writing. Agents add entries here as
`- [ ] <question> — <proposed answer> (<milestone>)`.
