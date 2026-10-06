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
notifications section shows the three steps above. Safari tabs have no Push
API, so on the iPhone the switch is hidden; a desktop browser with push
support still gets it, for debugging.

## Push permission flow (M3)

No owner setup is needed on the server: the Worker generates its VAPID key
pair the first time the app asks for it (step 2) and uses
`https://<the app's host>` as the VAPID subject Apple requires.

The code is `apps/web/src/push/push.ts`.

1. In standalone mode the owner turns on "Nudges on this phone" in Settings →
   Notifications.
2. `Notification.requestPermission()` is the first thing the tap handler
   does, before anything is awaited, so iOS still sees the user gesture.
   `GET /api/push/vapid-public-key` runs at the same time.
3. On `granted`, `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey })` with the key decoded from base64url (it must be
   a 65-byte uncompressed P-256 point, else Settings says to check
   `VAPID_PUBLIC_KEY`). An existing subscription made with the same key is
   reused; one made with another key is unsubscribed and replaced.
4. `POST /api/push/subscriptions` with `PushSubscription.toJSON()` plus
   `userAgent`. The answered id goes to meta `pushSubscriptionId` and the
   endpoint to meta `pushEndpoint`. If an older id was stored and differs,
   `DELETE /api/push/subscriptions/<old id>` removes the dead row.
5. On every launch and whenever the app comes back to the foreground
   (`visibilitychange`), if permission is `granted` and a token is stored,
   a health check compares the phone with what was registered and with the
   key the server serves (`push/watch.ts`, loaded lazily from `main.tsx`):
   - registered, but `pushManager.getSubscription()` is empty (iOS drops
     subscriptions on reinstall and sometimes on updates): subscribe and
     re-post.
   - the subscription's `options.applicationServerKey` differs from the
     served key (the owner set new VAPID keys): unsubscribe, subscribe with
     the new key, re-post, delete the old server row.
   - the endpoint differs from `pushEndpoint`, or a subscription exists that
     the server never got: re-post.
   - no subscription and nothing registered: notifications are off.

   The key check is one small GET per foreground; offline, with nothing else
   to fix, the check counts as passed. A service worker that is still
   installing (first launch) is waited for. Problems it cannot fix show in
   Settings → Notifications with "Try again".
6. "Send test notification" calls `POST /api/push/test` and reloads the
   status.
7. Turning the switch off unsubscribes the phone first, then calls
   `DELETE /api/push/subscriptions/:id` and clears the meta rows. Offline,
   the phone still turns off; the server drops the row the next time the
   push service rejects a send.

Known quirks:

- A payload that is not valid JSON or that the service worker fails to render
  shows nothing. Always send `{ title, body, tag, data: { url } }`. The
  service worker (`apps/web/src/push/swHandlers.ts`) still guards against
  it: it reads the payload defensively and shows a generic "Time Tracker"
  notification rather than nothing, because Safari may also revoke a
  subscription whose pushes stay invisible.
- The background re-subscribe in step 5 runs without a tap. If iOS ever
  refuses `pushManager.subscribe` outside a user gesture even with
  permission granted, Settings shows the error and its "Try again" button
  repeats the check from a tap. Not yet verified on a device.
- Safari does not support the `pushsubscriptionchange` event, so the app
  does not rely on it; the step 5 check covers a changed subscription the
  next time the app opens.
- If the owner denies permission, iOS will not ask again from the web. They
  must enable it under iOS Settings → Notifications → Time Tracker. The
  Settings screen says so.
- Delivery is reliable in practice but not instant. Expect nudges within a
  minute or two of the threshold. Pushes carry a 15 minute TTL, so a phone
  that is off for longer skips stale nudges instead of getting a burst.
- The Worker logs one JSON line per cron run (`"event": "nudges"`) with the
  outcome and any push service error, e.g. `HTTP 403 {"reason":"BadJwtToken"}`.
  `wrangler tail` shows them when a nudge does not arrive.
- Declarative Web Push (Safari 18.4+) could replace the service worker
  `push` handler later. Standard push is fine to start with.

## Fallback if web push is unreliable

Install the free ntfy app, create a private topic, and have the Worker `POST`
notification text to `https://ntfy.sh/<topic>`. Add `NTFY_TOPIC` as a secret
and a toggle in Settings. Only build this if real-world testing in M3 shows
missed or badly delayed pushes.

## Shortcuts recipes

Your app's address is `https://time-tracker.<subdomain>.workers.dev` (the
Deploy workflow prints it). Below, `<app>` means that address and `<token>`
means your app password.

### Switch to a category ("Hey Siri, I'm relaxing")

1. Open **Shortcuts → +** and add the action **Get Contents of URL**.
2. URL: `<app>/api/switch`.
3. Tap the arrow next to the URL to show more options:
   - **Method**: POST.
   - **Headers**: add `Authorization` with the value `Bearer <token>`
     (the word Bearer, a space, then your password).
   - **Request Body**: JSON. Add a Text field `categoryName` with the value
     `Relaxing` (any category name, any capitalisation).
4. Optional: add **Get Dictionary Value** for the key `message`, then
   **Show Result** or **Speak Text**. It says "Switched to Relaxing", or
   "Already on Relaxing".
5. Name the shortcut the phrase you want to say, e.g. "I'm relaxing". Siri
   runs it when you say the name.

Make one per category you actually say out loud. A category that does not
exist (or is archived) answers with an error instead of guessing.

### What am I doing right now?

1. **Get Contents of URL**: `<app>/api/state`, method GET, the same
   `Authorization` header.
2. **Get Dictionary Value** `open.category.name`, then another for
   `open.elapsedMin`.
3. **Speak Text**, e.g. "Relaxing for 72 minutes".

`open` is empty before you first pick a category.

### Automations worth setting up

**Shortcuts → Automation → +**. For each, pick **Run Immediately** so it does
not ask first, and use **Run Shortcut** with one of the switch shortcuts above
(or paste the Get Contents of URL action directly).

| Trigger | Action |
| --- | --- |
| App: Netflix, YouTube, Disney+, TikTok or Instagram is opened | Switch to Relaxing |
| Sleep Focus turns on | Switch to Sleep |
| Sleep Focus turns off | Switch to whatever you usually do first |
| Arrive at work | Switch to Casual work |
| Arrive at university | Switch to Uni study |
| CarPlay connects, or your car's Bluetooth connects | Switch to Travel / commute |
| Your car's Bluetooth disconnects | **Choose from Menu** with your likely next categories, each running its switch |

Automations only move the tracker one way: closing Netflix does not switch you
back. The "Still on it?" nudge and the Now screen cover that.

The password is stored inside each shortcut on your phone, which is fine for a
personal app. To change it, see "Changing your app password" in
[08-deploy.md](08-deploy.md), then update each shortcut.

## Scriptable widget

[Scriptable](https://scriptable.app) is a free iOS app that runs small
JavaScript programs as Home Screen and Lock Screen widgets. The script is
`tools/scriptable/time-tracker-widget.js` in this repository.

### Setup

1. Install **Scriptable** from the App Store.
2. Open the script on GitHub, tap **Raw**, select all and copy.
3. In Scriptable tap **+**, paste, and name the script "Time Tracker".
4. At the top of the script set `API_URL` to your app's address and `TOKEN`
   to your app password.
5. Tap **▶** once. A preview of the medium widget appears; if it says
   "Token rejected" or "Can't reach the app", fix the two values.
6. **Home Screen**: long-press an empty spot → **Edit → Add Widget →
   Scriptable**, pick a size, add it, then tap the new widget and choose the
   script **Time Tracker**. Tapping the widget opens your app's address.
7. **Lock Screen**: long-press the Lock Screen → **Customize → Lock Screen →**
   tap the widget area → **Scriptable** (rectangular, inline or circular),
   then pick the script the same way.

### What it shows

- **Small**: the category's colour, its name, how long it has been running
  (e.g. `1h 12m`) and today's total for it.
- **Medium**: the same, plus today's top three categories.
- **Lock Screen**: rectangular shows the name, elapsed time and today's total;
  inline shows "Relaxing 1h 12m"; circular shows the elapsed time.
- Before you pick anything: "Not tracking".

### Limits

- iOS decides how often widgets refresh, usually every 15 to 30 minutes, so
  the time can lag. The widget prints "as of HH:MM" so you know how fresh it
  is. The elapsed time is worked out when the widget draws, not when the data
  was fetched.
- Without a connection it shows the last data it fetched, marked "Offline".
- A tap opens the app's address in Safari, not the Home Screen app. That is an
  iOS limit for links from widgets.
