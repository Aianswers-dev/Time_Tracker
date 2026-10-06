# 05 · Features

Screen by screen spec. Each item has acceptance criteria an agent can check.
Milestone tags (M1, M2, ...) map to `07-roadmap.md`.

## Global

- **Installable PWA (M1).** Manifest with name "Time Tracker", short name
  "Time", `display: standalone`, portrait orientation, theme colour, 192 and
  512 px icons plus an Apple touch icon. Lighthouse installability passes.
- **Offline (M1).** The app shell loads with no network. All four screens work
  from Dexie alone. A thin status pill shows "Offline" (M1) and, when the
  outbox is non-empty, "N changes pending" (M2, when the outbox flushes).
- **Dark mode (M1).** Follows the system. Category colours remain readable on
  both backgrounds.
- **Touch targets (M1).** Every tappable control is at least 56 px tall.
- **Cold start (M1).** The Now screen is interactive within one second on a
  warm service worker. A local switch applies within 50 ms.
- **Login (M2).** If no token is stored, the app shows a single screen: paste
  the token, tap Save. It calls `GET /api/categories` to validate. Until then
  the app works locally and sync is simply off, so M1 is usable before M2.

## Now screen `/` (M1)

- A header shows the active category's name, colour, and a running
  `H:MM:SS` timer derived from `startedAt`. Before the first switch it reads
  "What are you doing?".
- A two-column grid of category tiles in `sortOrder`. The active tile is
  highlighted. Archived categories are hidden.
- **Tap a tile** switches immediately and shows a 10 second toast with Undo.
  Undo applies the shared `undoRows` to the rows the switch changed, and
  refuses if any of them changed since.
- **Tap the active tile** opens a sheet to backdate: "Started ... ago" with
  quick picks (5, 15, 30, 60 min) and a time picker. Applies `backdateOpen`.
- **Long-press any tile** opens the same picker to switch with a backdated
  start, for "I actually started cooking 20 minutes ago". A picked clock time
  later than now means yesterday. If the change would trim or remove other
  entries, the sheet lists them before you confirm.
- Today's total for each category appears in small text on its tile.
- Switching the same category is a no-op with no toast.

## Today screen `/today` (M1)

- A horizontal bar spanning the logical day from `dayStartHour` to the next
  `dayStartHour`, coloured blocks per segment, grey hatched blocks for
  untracked gaps, a marker for "now". Blocks under a few minutes still get a
  minimum visual width, and neighbouring blocks are separated by a 2 px gap
  so similar colours never merge. Tapping a block names it (category, time
  range, duration) with an Edit or Assign button.
- Left and right arrows or a swipe move to previous and next days.
- Below the bar: a list of segments for the day, newest first, each showing
  category, start, end, duration, note. Tapping opens the edit sheet.
- A totals list per category, sorted descending, with the untracked total at
  the end if non-zero.
- **Edit sheet.** Change category, start time, end time (each with a date,
  since entries can cross midnight), note. Before saving it lists what else
  the change would move, trim or remove. Save validates with the shared
  operations and shows the error inline if the change is invalid. Also offers Split (pick a time and a second category) and Delete
  (with "fill from previous", "fill from next", or "leave gap").
- **Tap an untracked gap** opens a sheet pre-filled with the gap's range to
  assign a category, using `insertSegment`.
- Edits to the open segment's start also move the previous segment's end.

## Stats screen `/stats` (M4)

Range tabs: Today, This week, Last 7 days, This month, Custom. Week starts
Monday.

- **Totals donut or bar** with minutes and percentage per category for the
  range.
- **Stacked daily bars**, one bar per logical day, segments stacked by
  category. Tapping a bar jumps to that day on the Today screen.
- **Hour of day heatmap**: 24 columns, one row per category, intensity equals
  minutes in that local hour across the range. Answers "when do I waste
  time".
- **Budget tracker**: for each daily rule, the number of days under and over
  budget in the range and a streak of days under.
- **Trend**: for a chosen category, a line of minutes per day over the range
  with a 7 day moving average.
- Charts read from Dexie through the shared aggregation functions. Follow the
  `dataviz` skill guidance for colour and form when building them.

## Settings screen `/settings`

- **Categories (M1).** List with up and down buttons to reorder (simpler and
  more reliable than drag on iOS). Add, rename, recolour (from
  a fixed palette that passes contrast in both modes), pick an icon, toggle
  stale-check exemption, archive and unarchive. Deleting is only offered when
  the category has no segments.
- **Day start and timezone (M1).** Hour picker; timezone defaults to the
  device and is editable from the IANA list. Changing either re-renders all
  stats, no data migration needed because storage is UTC.
- **Sync (M2).** Token field, "Sync now", last sync time, pending op count,
  "Reset local data and re-download" with confirmation.
- **Notifications (M3).** Shows one of these, checked in order:
  - Not standalone: "Install to Home Screen first" with the Share → Add to
    Home Screen steps. A desktop browser that supports push also gets the
    controls below, for debugging; iPhone Safari (no push in a tab) does not.
  - Standalone on an iOS version without web push: "Needs iOS 16.4 or later".
  - No token: "Connect to your server first" with a button that scrolls to
    Sync.
  - Permission denied: how to re-enable it in iOS Settings → Notifications →
    Time Tracker (iOS never asks again from the web).
  - Otherwise a "Nudges on this phone" switch that requests permission and
    subscribes (docs/06). When on: the server's status for this phone from
    `GET /api/push/subscriptions` (last delivered, failed deliveries; "Not
    delivering" in red when nothing was ever delivered and sends have
    failed), any other subscriptions the server holds with a remove button,
    and "Send test notification". If the server does not know this phone's
    subscription id, the section registers it again once by itself, then
    offers "Register again". A failure of the background health check
    (docs/06 step 5) shows here with "Try again". Every failure is a
    sentence on screen, never silent.
- **Rules (M3).** Rules grouped by category in category order; an archived
  category's rules are greyed with "Archived · won't nudge". Each row reads
  in plain language ("Nudges you after 1h of Relaxing in a row, then every
  30m") and has its own enabled switch. Add and edit in a bottom sheet:
  category, kind (session limit or daily budget, each with a one-line
  explanation), threshold in minutes or hours, repeat once or every N
  minutes, optional quiet hours, optional custom message (replaces the body,
  200 characters), enabled, and a live preview. Delete asks for
  confirmation and soft-deletes. Values are checked with the shared
  `ruleSchema` before saving and problems show next to the field; quiet
  hours with equal start and end are refused because they would never
  apply. Every save, switch flip and delete writes one `rule.upsert` op.
- **Still on it? (M3).** The stale check in its own section: a summary
  ("Asks “Still on it?” when anything except Sleep runs 5h without a switch,
  then every 1h"), an enabled switch, and a sheet for threshold, repeat and
  quiet hours. Each save writes one `settings.upsert` op. Seeded defaults
  from `01-decisions.md` on first run.
- **Export (M4).** Buttons for CSV and JSON for a chosen range, calling the
  export endpoints and triggering a download. Offline: generate from Dexie.
- **About (M1).** App version, build hash, link to the repo.

## Notifications (M3)

- Delivered as Web Push to the installed PWA. The service worker renders the
  payload; nothing is computed on the device. Every push shows a
  notification: a payload that is not JSON shows its text, and missing or
  malformed fields fall back to the title "Time Tracker" and a generic body.
- Tapping a notification focuses an open window and navigates it to
  `data.url` (same origin only, else `/`), or opens the app there.
- Repeats for the same rule replace the previous banner via `tag`.
- No action buttons (iOS ignores them). "Snooze" is a future idea, not in
  scope.
- A nudge about the open segment stops the moment the owner switches away,
  because the next cron run sees a new segment.

## Siri, Shortcuts and widget (M5)

- `POST /api/switch` by category name and `GET /api/state` are stable and
  documented in `06-ios.md` with copy-paste shortcut recipes.
- `tools/scriptable/time-tracker-widget.js` renders small, medium, and lock
  screen accessory widgets from `GET /api/state`.

## Non-functional

- Lighthouse PWA and accessibility scores of 90 or above on the Now screen.
- The JS bundle for the Now screen stays under 250 KB gzipped. Charting code
  is lazy loaded on the Stats route.
- No analytics, no third-party scripts, no fonts from a CDN. Everything is
  self-hosted.
