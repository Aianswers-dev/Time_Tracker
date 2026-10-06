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
