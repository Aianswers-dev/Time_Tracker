# 06 · iOS notes

What iPhone allows a web app to do, how we work with it, and the recipes the
owner sets up by hand.

## What a PWA can and cannot do on iOS

| Capability | Status | Our approach |
| --- | --- | --- |
| Install to Home Screen | Yes. Since iOS 26 any site added to the Home Screen opens as a web app by default. | Manifest plus install instructions when not standalone. |
| Web Push notifications | Yes since iOS 16.4, only when installed to the Home Screen and only when the permission request comes from a user tap. | Server-sent pushes from the cron. Toggle in Settings only in standalone mode. |
| Notification action buttons | No. Safari ignores `actions`. | None used. Tap opens the app. |
| Background JavaScript | No. Nothing runs while the app is closed. | The timer is derived from timestamps, so nothing needs to run. |
| Home Screen widgets | No web widgets exist. | Scriptable widget reading `GET /api/state`. Native WidgetKit is out of scope. |
| Live Activities on the lock screen | Native only. | Out of scope. |
| App badge | Supported for Home Screen web apps. | Not used for now. |
| Storage persistence | Home Screen web apps keep their storage. Safari tabs may evict after 7 days unused. | Always install. The server holds the durable copy anyway. |

## Install flow

1. Open the deployed URL in Safari.
2. Share → Add to Home Screen → Add.
3. Open from the Home Screen icon, not from Safari.

The app detects standalone via `window.navigator.standalone === true` or the
`(display-mode: standalone)` media query. When not standalone, the Settings
notifications section shows the three steps above and the toggle is hidden.

## Push permission flow (M3)

1. In standalone mode the owner taps "Enable notifications".
2. `Notification.requestPermission()` is called from that tap handler.
3. On `granted`, `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey })` with the VAPID public key from the API.
4. `POST /api/push/subscriptions` with the subscription JSON.
5. On every app launch, if permission is `granted` and there is no stored
   subscription id, or `pushManager.getSubscription()` returns a different
   endpoint, re-subscribe and re-post. iOS drops subscriptions when the app
   is deleted and reinstalled.
6. "Send test notification" calls `POST /api/push/test`.

Known quirks:

- A payload that is not valid JSON or that the service worker fails to render
  shows nothing. Always send `{ title, body, tag, data: { url } }`.
- If the owner denies permission, iOS will not ask again from the web. They
  must enable it under iOS Settings → Notifications → Time Tracker. The
  Settings screen says so.
- Delivery is reliable in practice but not instant. Expect nudges within a
  minute or two of the threshold.
- Declarative Web Push (Safari 18.4+) could replace the service worker
  `push` handler later. Standard push is fine to start with.

## Fallback if web push is unreliable

Install the free ntfy app, create a private topic, and have the Worker `POST`
notification text to `https://ntfy.sh/<topic>`. Add `NTFY_TOPIC` as a secret
and a toggle in Settings. Only build this if real-world testing in M3 shows
missed or badly delayed pushes.

## Shortcuts recipes (owner sets these up, M5 documents them)

All recipes use the "Get Contents of URL" action.

**Switch to a category.**

- URL: `https://<your-app>/api/switch`
- Method: POST
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
- Request body (JSON): `{ "categoryName": "Relaxing", "source": "shortcut" }`

Name the shortcut "I'm relaxing" and Siri will accept that phrase. Make one
per category you actually say out loud.

**What am I doing right now.**

- URL: `https://<your-app>/api/state`, Method: GET, same Authorization header.
- Follow with "Get Dictionary Value" for `open.category.name` and
  `open.elapsedMin`, then "Speak Text" or "Show Result".

**Automations worth setting up** (Shortcuts → Automation → New, set "Run
Immediately" so they do not ask):

| Trigger | Action |
| --- | --- |
| App opened: Netflix, YouTube, Disney+, TikTok, Instagram | Switch to Relaxing |
| Sleep Focus turned on | Switch to Sleep |
| Sleep Focus turned off | Switch to Life admin (or whatever you do first) |
| Arrive at work location | Switch to Casual work |
| Arrive at university | Switch to Uni study |
| Connect to car Bluetooth or CarPlay | Switch to Travel / commute |
| Disconnect from car Bluetooth | Ask: shows a menu of likely categories, runs the matching switch |

Automations only move the tracker in one direction. The stale check and the
Now screen cover the gaps.

The token is stored inside the shortcut on the device. That is acceptable for
a single-user personal app. If the token ever leaks, rotate it with
`wrangler secret put AUTH_TOKEN` and re-paste it in the app and shortcuts.

## Scriptable widget (M5)

`tools/scriptable/time-tracker-widget.js`:

- Reads `API_URL` and `TOKEN` from constants at the top of the file (the
  owner pastes them once in the Scriptable editor).
- Fetches `GET /api/state`.
- Small widget: category colour background, category name, elapsed time as
  `1h 12m`, and today's total for that category.
- Medium widget: the same plus today's top three categories with minutes.
- Lock screen accessory (rectangular): category name and elapsed time.
- Sets `widget.refreshAfterDate` to five minutes ahead. iOS decides the real
  cadence, usually 15 to 30 minutes, so the elapsed time can lag. The widget
  shows "as of HH:MM" in small text to make that honest.
- Tapping the widget opens the app URL. iOS opens widget URLs in Safari
  rather than the Home Screen app, which is a platform limitation.
- Handles network errors by showing the last cached state from Scriptable's
  `FileManager` with an "offline" marker.
