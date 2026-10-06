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

Range tabs: Today, This week, Last 7 days, This month, Custom (labelled
Today, Week, 7 days, Month, Custom to fit one row; the full name and dates
show under the title). Every range is whole logical days per `dayStartHour`
and the settings timezone. Week starts Monday and, like This month, covers
the whole calendar period, so days still to come show as empty slots. Custom
has two date pickers (either order, end clamped to today, at most 366 days;
it opens on the last 30 days). The range lives in the URL (`?range=week`,
`?range=custom&from=&to=`), so Back from a drill-down returns to it. While a
new range loads, the previous one stays on screen, faded.

- **Headline tiles**: tracked time (with the average per day), the category
  with the most time, untracked time, and the first enabled daily budget's
  category against its budget (today's time, or the average per day for a
  longer range, with a meter). Without a daily rule the fourth tile counts
  days tracked.
- **Totals bar list** with time and percentage per category, largest first,
  untracked last and hatched. Percentages are of the range's elapsed time,
  untracked included, so they add up to 100. A bar list rather than a donut:
  ten categories are too many slices.
- **Stacked daily bars**, one bar per logical day, segments stacked by
  category (largest over the range at the base, untracked hatched on top),
  on a fixed 24 hour axis. Tapping a bar opens that day on the Today screen
  (`/today?day=`); sliding a finger across, hovering, or the arrow keys show
  that day's breakdown in a tooltip instead. A one-day range shows a button
  to the day instead of a one-bar chart.
- **Hour of day heatmap**: 24 columns starting at `dayStartHour`, one row per
  category with its name above it, intensity is the average minutes per day
  that category took in that local hour (five steps of one blue ramp, with a
  scale). Tapping a square names it; with nothing picked, the readout gives
  the peak hour of the budgeted category. Answers "when do I waste time".
- **Budget tracker**: for each enabled daily rule, the days under and over
  budget in the range, the streak of days under counting back from the last
  day so far, and a strip of the days with the budget as a line (over days
  in the danger colour, above the line). For a one-day range it is a meter
  with the time left or over.
- **Trend**: for a chosen category (defaults to the budgeted one), its time
  per day, faded, and a trailing 7 day moving average. The average reaches
  up to six days before the range so the first day has a full window, but
  never before tracking began. A daily budget for the category is drawn as a
  reference line.
- Days before the first segment are left out of averages, budgets and the
  heatmap's per-day figures, and the screen says when tracking began.
  Before any segment exists it shows a "Nothing tracked yet" card.
- Every chart has a table view behind a Table toggle, and names categories
  in a legend or label, never by colour alone.
- Charts read from Dexie through the shared aggregation functions:
  `totalsForRange`, `sortedTotals`, `hourHeatmap`, `budgetStatus`,
  `movingAverage`, and per-day totals equal to `dailyTotals` (computed as
  `totalsForRange` over each day's `dayRange`, which is the same thing and an
  order of magnitude faster over a year; a test checks they agree). Segments
  are loaded by the `startedAt` index for the range plus six lookback days,
  with the segment reaching in from before, the open segment and the
  earliest segment (for untracked time). Hand-rolled SVG, no chart library,
  in the lazily loaded Stats chunk, following the `dataviz` skill.
- Performance (M4, 10,000 synthetic segments over a year, headless Chromium):
  every preset range renders in under 60 ms after a tab tap, a full-year
  custom range in about 0.5 s.

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
- **Notifications (M3).** If not running standalone: show "Install to Home
  Screen first" with the Share → Add to Home Screen steps. If standalone:
  a toggle that requests permission and subscribes, the subscription status,
  and a "Send test notification" button. Shown even when permission was
  denied, with a note on how to re-enable in iOS Settings.
- **Rules (M3).** List of rules grouped by category. Add or edit: kind
  (session or daily), threshold, repeat, quiet hours, custom message, enabled.
  Stale check settings (threshold, repeat, quiet hours) in their own section.
  Seeded defaults from `01-decisions.md` on first run.
- **Export (M4).** CSV and JSON for a chosen range (all time, last 30 days,
  this month, last month, or two dates; whole logical days). The files are
  built on the phone from Dexie in exactly the formats of the export
  endpoints (`04-api.md`), so export works offline and needs no token; the
  app never calls the endpoints. Where the browser can share files
  (`navigator.canShare({ files })`, iOS) the share sheet opens, so the owner
  can Save to Files or AirDrop it; elsewhere it downloads, and a Download
  link stays on screen. The open segment has an empty `ended_at` and counts
  its minutes up to now, as the endpoint does.
- **About (M1).** App version, build hash, link to the repo.

## Notifications (M3)

- Delivered as Web Push to the installed PWA. The service worker renders the
  payload; nothing is computed on the device.
- Tapping a notification opens or focuses the app on `/`.
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
