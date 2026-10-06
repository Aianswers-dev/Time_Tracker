/**
 * The service worker's `push` and `notificationclick` logic, kept free of
 * service worker globals so it type-checks in both the app and the worker and
 * can be unit tested with plain objects. `src/sw.ts` wires it to the events.
 *
 * A push that shows nothing is the worst outcome on iOS: the owner misses the
 * nudge, and Safari may revoke a subscription whose pushes stay invisible. So
 * every push shows a notification, whatever the payload looks like.
 */

export const FALLBACK_TITLE = 'Time Tracker';
export const FALLBACK_BODY = 'Open the app to see what you’re tracking.';
export const NOTIFICATION_ICON = '/pwa-192x192.png';

const MAX_TITLE = 120;
const MAX_BODY = 400;

/** The parts of `PushMessageData` this needs. */
export interface PushDataLike {
  json(): unknown;
  text(): string;
}

export interface ShownNotification {
  title: string;
  options: Omit<NotificationOptions, 'data'> & { data: { url: string } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}

/**
 * A same-origin path to open, from whatever the payload's `data.url` holds.
 * Anything else (missing, malformed, another origin) opens the Now screen.
 *
 * Leading slashes are collapsed to one: a same-origin URL such as
 * `https://<origin>//evil.example/` has the pathname `//evil.example/`, which
 * would resolve to another origin when used as a path.
 */
export function safeUrl(url: unknown, origin: string): string {
  if (typeof url !== 'string' || url.trim() === '') return '/';
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return '/';
    const path = `/${parsed.pathname.replace(/^\/+/, '')}${parsed.search}${parsed.hash}`;
    return new URL(path, origin).origin === origin ? path : '/';
  } catch {
    return '/';
  }
}

/**
 * The notification for a push: `{ title, body, tag, data: { url } }` per
 * docs/04, read defensively. Not JSON: the text becomes the body. Missing or
 * wrong fields fall back to a generic title and body.
 */
export function notificationFromPush(
  data: PushDataLike | null | undefined,
  origin: string,
): ShownNotification {
  let payload: Record<string, unknown> = {};
  let raw: string | null = null;
  if (data) {
    try {
      const parsed = data.json();
      if (isRecord(parsed)) payload = parsed;
    } catch {
      try {
        raw = text(data.text(), MAX_BODY);
      } catch {
        raw = null;
      }
    }
  }
  const tag = text(payload.tag, 200);
  return {
    title: text(payload.title, MAX_TITLE) ?? FALLBACK_TITLE,
    options: {
      body: text(payload.body, MAX_BODY) ?? raw ?? FALLBACK_BODY,
      ...(tag ? { tag } : {}),
      data: { url: safeUrl(isRecord(payload.data) ? payload.data.url : undefined, origin) },
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
    },
  };
}

/** The parts of `ServiceWorkerRegistration` the push handler needs. */
export interface NotificationTarget {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
}

/** Show the push. If the browser rejects the options, show the plain fallback instead. */
export async function handlePush(
  data: PushDataLike | null | undefined,
  registration: NotificationTarget,
  origin: string,
): Promise<void> {
  const { title, options } = notificationFromPush(data, origin);
  try {
    await registration.showNotification(title, options);
  } catch {
    await registration.showNotification(FALLBACK_TITLE, {
      body: FALLBACK_BODY,
      data: { url: '/' },
    });
  }
}

/** The parts of `WindowClient` the click handler needs. */
export interface WindowClientLike {
  readonly url: string;
  readonly focused: boolean;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

/** The parts of `Clients` the click handler needs. */
export interface ClientsLike {
  matchAll(options: {
    type: 'window';
    includeUncontrolled: boolean;
  }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface ClickedNotification {
  readonly data: unknown;
  close(): void;
}

/**
 * Close the notification, then bring the app forward on `data.url`: focus an
 * open window and navigate it there, or open a new one.
 */
export async function handleNotificationClick(
  notification: ClickedNotification,
  clients: ClientsLike,
  origin: string,
): Promise<void> {
  notification.close();
  const data: unknown = notification.data;
  const target = new URL(safeUrl(isRecord(data) ? data.url : undefined, origin), origin).href;
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((w) => w.focused) ?? windows[0];
  if (!client) {
    await clients.openWindow(target);
    return;
  }
  try {
    await client.focus();
  } catch {
    await clients.openWindow(target);
    return;
  }
  if (client.url !== target) {
    // An uncontrolled window cannot be navigated; it is focused, which is enough.
    await client.navigate(target).catch(() => null);
  }
}
