import { pushSubscriptionRequestSchema } from '@time-tracker/shared';
import { ApiError, getToken } from '../api/client';
import { db } from '../db';
import { deleteSubscription, fetchVapidKey, postSubscription } from './api';
import { base64UrlToBytes, isUncompressedP256, sameBytes } from './base64';
import { PushError, pushErrorFromApi } from './errors';

/**
 * The phone's side of Web Push (docs/06, "Push permission flow"). The server
 * decides when to nudge; the phone only subscribes, registers the
 * subscription with the server and keeps it registered.
 *
 * Meta rows: `pushSubscriptionId` is the server's id for this phone's
 * subscription, `pushEndpoint` the endpoint registered under it, so a changed
 * endpoint is noticed on the next launch.
 */

export const META_SUBSCRIPTION_ID = 'pushSubscriptionId';
export const META_ENDPOINT = 'pushEndpoint';

/** How long to wait for the service worker before telling the owner to reopen the app. */
const WORKER_WAIT_MS = 10_000;

export type PermissionState = NotificationPermission | 'unsupported';

/** Service worker, Push API and Notification API are all present. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    typeof Notification !== 'undefined'
  );
}

export function notificationPermission(): PermissionState {
  return isPushSupported() ? Notification.permission : 'unsupported';
}

async function metaValue(key: string): Promise<string | null> {
  return (await db.meta.get(key))?.value ?? null;
}

/** The server id of this phone's subscription, or null when it is not registered. */
export function storedSubscriptionId(): Promise<string | null> {
  return metaValue(META_SUBSCRIPTION_ID);
}

/** The registration with an active worker, waiting up to `waitMs` for one to activate. */
async function activeRegistration(waitMs: number): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  if (waitMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server's VAPID public key text as the 65 bytes `pushManager.subscribe` needs. */
function parseServerKey(text: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(text);
  } catch {
    throw new PushError('bad_key');
  }
  if (!isUncompressedP256(bytes)) throw new PushError('bad_key');
  return bytes;
}

async function serverKey(pending: Promise<string>): Promise<Uint8Array<ArrayBuffer>> {
  let text: string;
  try {
    text = await pending;
  } catch (err) {
    throw pushErrorFromApi(err);
  }
  return parseServerKey(text);
}

/**
 * This phone's subscription for `key`. Reuses the current one unless it was
 * made with a different key (the server's keys were rotated), in which case
 * it is replaced, because the push service would reject every send.
 */
async function subscribe(
  registration: ServiceWorkerRegistration,
  key: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const current = existing.options?.applicationServerKey ?? null;
    if (current === null || sameBytes(current, key)) return existing;
    await existing.unsubscribe().catch(() => false);
  }
  try {
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  } catch (err) {
    const reason = err instanceof Error && err.message ? ` (${err.message})` : '';
    throw new PushError(
      'subscribe_failed',
      `This phone refused to set up push notifications${reason}. Close the app completely, reopen it and try again.`,
    );
  }
}

/**
 * Send the subscription to the server and remember the id it answers with.
 * When the id changed (a new endpoint), the old server row is removed so the
 * server does not keep a dead subscription; that cleanup is best effort,
 * because the server also drops subscriptions the push service rejects.
 */
async function register(subscription: PushSubscription): Promise<string> {
  const json = subscription.toJSON();
  const body = pushSubscriptionRequestSchema.safeParse({
    endpoint: json.endpoint ?? subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: json.keys,
    userAgent: navigator.userAgent.slice(0, 300),
  });
  if (!body.success) {
    throw new PushError(
      'subscribe_failed',
      'This phone returned an incomplete push subscription. Turn notifications off and on again.',
    );
  }
  const previousId = await storedSubscriptionId();
  let id: string;
  try {
    id = await postSubscription(body.data);
  } catch (err) {
    throw pushErrorFromApi(err);
  }
  await db.meta.bulkPut([
    { key: META_SUBSCRIPTION_ID, value: id },
    { key: META_ENDPOINT, value: body.data.endpoint },
  ]);
  if (previousId !== null && previousId !== id) {
    await deleteSubscription(previousId).catch(() => undefined);
  }
  return id;
}

/**
 * Turn notifications on. Call it straight from the tap handler: iOS only
 * shows the permission prompt for a request made inside a user gesture, so
 * `Notification.requestPermission()` runs before anything is awaited. The key
 * is fetched at the same time so the prompt never waits on the network.
 *
 * Resolves with the server's subscription id; rejects with a `PushError`.
 */
export function enableNotifications(): Promise<string> {
  if (!isPushSupported()) return Promise.reject(new PushError('unsupported'));
  const permission = Promise.resolve(Notification.requestPermission());
  const key = fetchVapidKey();
  key.catch(() => undefined); // Reported below, once permission is settled.
  return finishEnable(permission, key);
}

async function finishEnable(
  permissionRequest: Promise<NotificationPermission>,
  key: Promise<string>,
): Promise<string> {
  const permission = await permissionRequest;
  if (permission === 'denied') throw new PushError('denied');
  if (permission !== 'granted') throw new PushError('dismissed');
  const registration = await activeRegistration(WORKER_WAIT_MS);
  if (!registration) throw new PushError('no_worker');
  const subscription = await subscribe(registration, await serverKey(key));
  return register(subscription);
}

export interface DisableResult {
  /** Why the server could not be told, when it could not. The phone is unsubscribed either way. */
  serverWarning: string | null;
}

/**
 * Turn notifications off: unsubscribe the phone, remove the subscription from
 * the server and forget the id. The phone goes first so a failure there leaves
 * everything as it was. Works offline: if the server cannot be reached the
 * phone is still unsubscribed, and the server drops the row the next time the
 * push service rejects a send to it.
 */
export async function disableNotifications(): Promise<DisableResult> {
  if (isPushSupported()) {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      try {
        await subscription.unsubscribe();
      } catch {
        throw new PushError('unsubscribe_failed');
      }
    }
  }
  const id = await storedSubscriptionId();
  let serverWarning: string | null = null;
  if (id !== null) {
    try {
      await deleteSubscription(id);
    } catch (err) {
      serverWarning = pushErrorFromApi(err).message;
    }
  }
  await db.meta.bulkDelete([META_SUBSCRIPTION_ID, META_ENDPOINT]);
  return { serverWarning };
}

/**
 * Register this phone again even though the stored state looks fine, for
 * when the server says it does not know the stored id.
 */
export async function reregister(): Promise<string> {
  if (!isPushSupported()) throw new PushError('unsupported');
  const permission = Notification.permission;
  if (permission !== 'granted') {
    throw new PushError(permission === 'denied' ? 'denied' : 'dismissed');
  }
  if (!(await getToken())) throw new PushError('not_connected');
  const registration = await activeRegistration(WORKER_WAIT_MS);
  if (!registration) throw new PushError('no_worker');
  // subscribe() keeps the current subscription unless the server's key changed.
  return register(await subscribe(registration, await serverKey(fetchVapidKey())));
}

export type PushHealth =
  /** Nothing to check: push missing, permission not granted, no token, no worker, or turned off. */
  | { status: 'unsupported' | 'not_granted' | 'not_connected' | 'no_worker' | 'off' }
  | { status: 'ok' }
  /** Fixed: iOS had dropped the subscription, the endpoint changed, or the server's key did. */
  | { status: 'repaired'; action: 'resubscribed' | 'reposted' | 'rekeyed' }
  | { status: 'error'; message: string };

/**
 * Run on every launch and whenever the app comes back to the foreground. iOS
 * can drop a subscription (reinstall, OS update) or hand out a new endpoint,
 * and the owner may set new VAPID keys on the server; each leaves the server
 * pushing into the void. When permission is granted and the app is
 * connected, compare the phone's subscription with what was registered and
 * with the key the server serves, and fix any difference:
 *
 * - registered, but the phone has no subscription: subscribe again and re-post.
 * - the subscription was made with another key than the server serves:
 *   unsubscribe it, subscribe with the served key, re-post, and delete the
 *   old server row.
 * - the phone's endpoint differs from the registered one: re-post.
 * - the phone has a subscription the server never got (an earlier post
 *   failed): post it.
 * - no subscription and nothing registered: notifications are off; nothing to do.
 *
 * The key check costs one small request. Offline, when nothing else needs
 * fixing, the check counts as passed and runs again next time.
 *
 * Never throws: failures come back as `{ status: 'error' }` for Settings to show.
 */
export async function checkPushHealth(): Promise<PushHealth> {
  try {
    if (!isPushSupported()) return { status: 'unsupported' };
    if (Notification.permission !== 'granted') return { status: 'not_granted' };
    if (!(await getToken())) return { status: 'not_connected' };
    // No registration at all (development): nothing to check. One still
    // installing (first launch, or right after an update): wait for it.
    if (!(await navigator.serviceWorker.getRegistration())) return { status: 'no_worker' };
    const registration = await activeRegistration(WORKER_WAIT_MS);
    if (!registration) return { status: 'no_worker' };

    const [storedId, storedEndpoint] = await Promise.all([
      storedSubscriptionId(),
      metaValue(META_ENDPOINT),
    ]);
    const current = await registration.pushManager.getSubscription();
    if (!current && storedId === null) return { status: 'off' };
    const registered = current !== null && storedId !== null && current.endpoint === storedEndpoint;

    let keyText: string;
    try {
      keyText = await fetchVapidKey();
    } catch (err) {
      if (registered && err instanceof ApiError && err.code === 'network') {
        return { status: 'ok' };
      }
      throw err;
    }
    const key = parseServerKey(keyText);

    if (!current) {
      await register(await subscribe(registration, key));
      return { status: 'repaired', action: 'resubscribed' };
    }
    const currentKey = current.options?.applicationServerKey ?? null;
    if (currentKey !== null && !sameBytes(currentKey, key)) {
      // subscribe() replaces a subscription made with another key, and
      // register() deletes the old server row because the new endpoint gets a new id.
      await register(await subscribe(registration, key));
      return { status: 'repaired', action: 'rekeyed' };
    }
    if (registered) return { status: 'ok' };
    await register(current);
    return { status: 'repaired', action: 'reposted' };
  } catch (err) {
    return { status: 'error', message: pushErrorFromApi(err).message };
  }
}
