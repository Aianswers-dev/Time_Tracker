import { pushSubscriptionRequestSchema } from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../api/client';
import { resetDb } from '../data/testUtils';
import { db } from '../db';
import { base64UrlToBytes, bytesToBase64Url } from './base64';
import { PushError } from './errors';
import {
  checkPushHealth,
  disableNotifications,
  enableNotifications,
  META_ENDPOINT,
  META_SUBSCRIPTION_ID,
  reregister,
} from './push';

/**
 * The push client against a fake browser: `navigator.serviceWorker`, a
 * `pushManager`, `Notification` and `fetch` for the server routes.
 */

const KEY_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
const VAPID_KEY = bytesToBase64Url(KEY_BYTES);
const OTHER_KEY = bytesToBase64Url(new Uint8Array(65).map((_, i) => (i === 0 ? 4 : 200 - i)));

class FakeSubscription {
  readonly options: { applicationServerKey: ArrayBuffer | null };
  readonly unsubscribe = vi.fn(() => {
    env.current = null;
    return Promise.resolve(true);
  });
  constructor(
    readonly endpoint: string,
    key: Uint8Array | null = KEY_BYTES,
  ) {
    this.options = { applicationServerKey: key ? new Uint8Array(key).buffer : null };
  }
  toJSON() {
    return {
      endpoint: this.endpoint,
      expirationTime: null,
      keys: { p256dh: 'p256', auth: 'auth' },
    };
  }
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const env = {
  permission: 'granted' as NotificationPermission,
  answer: 'granted' as NotificationPermission,
  current: null as FakeSubscription | null,
  registered: true,
  endpointCounter: 0,
  serverIds: new Map<string, string>(),
  calls: [] as Call[],
};

const pushManager = {
  getSubscription: vi.fn(() => Promise.resolve(env.current)),
  subscribe: vi.fn((opts: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
    env.endpointCounter += 1;
    env.current = new FakeSubscription(
      `https://web.push.apple.com/endpoint-${env.endpointCounter}`,
      opts.applicationServerKey,
    );
    return Promise.resolve(env.current);
  }),
};

const registration = { active: {}, pushManager };

const requestPermission = vi.fn(() => {
  env.permission = env.answer;
  return Promise.resolve(env.answer);
});

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(path: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? 'GET';
  const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  env.calls.push({ method, path, body });
  if (path === '/api/push/vapid-public-key') return Promise.resolve(json(200, { key: VAPID_KEY }));
  if (path === '/api/push/subscriptions' && method === 'POST') {
    const endpoint = (body as { endpoint: string }).endpoint;
    const id = env.serverIds.get(endpoint) ?? `sub-${env.serverIds.size + 1}`;
    env.serverIds.set(endpoint, id);
    return Promise.resolve(json(201, { id }));
  }
  if (path.startsWith('/api/push/subscriptions/') && method === 'DELETE') {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return Promise.resolve(json(404, { error: { code: 'not_found', message: 'nope' } }));
}

function posts(): Call[] {
  return env.calls.filter((c) => c.method === 'POST' && c.path === '/api/push/subscriptions');
}

async function meta() {
  return {
    id: (await db.meta.get(META_SUBSCRIPTION_ID))?.value ?? null,
    endpoint: (await db.meta.get(META_ENDPOINT))?.value ?? null,
  };
}

/** Pretend the phone already subscribed and registered as `id`. */
async function alreadyRegistered(endpoint: string, id: string) {
  env.current = new FakeSubscription(endpoint);
  env.serverIds.set(endpoint, id);
  await db.meta.bulkPut([
    { key: META_SUBSCRIPTION_ID, value: id },
    { key: META_ENDPOINT, value: endpoint },
  ]);
}

beforeEach(async () => {
  await resetDb();
  await setToken('secret');
  Object.assign(env, {
    permission: 'granted',
    answer: 'granted',
    current: null,
    registered: true,
    endpointCounter: 0,
    serverIds: new Map(),
    calls: [],
  });
  vi.clearAllMocks();
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
    serviceWorker: {
      getRegistration: () => Promise.resolve(env.registered ? registration : undefined),
      ready: Promise.resolve(registration),
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    get permission() {
      return env.permission;
    },
    requestPermission,
  });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enableNotifications', () => {
  it('asks for permission inside the tap, then subscribes and registers', async () => {
    env.permission = 'default';
    const pending = enableNotifications();
    // Synchronously, before anything was awaited: iOS needs the user gesture.
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const id = await pending;

    expect(id).toBe('sub-1');
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const opts = pushManager.subscribe.mock.calls[0]?.[0];
    expect(opts?.userVisibleOnly).toBe(true);
    expect([...(opts?.applicationServerKey ?? [])]).toEqual([...KEY_BYTES]);

    const [post] = posts();
    expect(pushSubscriptionRequestSchema.parse(post?.body)).toEqual({
      endpoint: 'https://web.push.apple.com/endpoint-1',
      expirationTime: null,
      keys: { p256dh: 'p256', auth: 'auth' },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
    });
    expect(await meta()).toEqual({
      id: 'sub-1',
      endpoint: 'https://web.push.apple.com/endpoint-1',
    });
  });

  it('reports a denied or dismissed prompt and subscribes nothing', async () => {
    env.permission = 'default';
    env.answer = 'denied';
    await expect(enableNotifications()).rejects.toMatchObject({ code: 'denied' });
    env.permission = 'default';
    env.answer = 'default';
    await expect(enableNotifications()).rejects.toMatchObject({ code: 'dismissed' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
    expect(await meta()).toEqual({ id: null, endpoint: null });
  });

  it('reuses a subscription made with the same key', async () => {
    env.current = new FakeSubscription('https://web.push.apple.com/existing');
    await enableNotifications();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect((posts()[0]?.body as { endpoint: string }).endpoint).toBe(
      'https://web.push.apple.com/existing',
    );
  });

  it('replaces a subscription made with an old server key', async () => {
    const old = new FakeSubscription(
      'https://web.push.apple.com/old-key',
      base64UrlToBytes(OTHER_KEY),
    );
    env.current = old;
    await enableNotifications();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed server key with a clear message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init: RequestInit) =>
        path === '/api/push/vapid-public-key'
          ? Promise.resolve(json(200, { key: 'not-a-p256-key' }))
          : fakeFetch(path, init),
      ),
    );
    const err = await enableNotifications().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as PushError).code).toBe('bad_key');
    expect((err as PushError).message).toMatch(/VAPID_PUBLIC_KEY/);
  });

  it('explains a server without push routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(404, { error: { code: 'not_found', message: 'nope' } }))),
    );
    await expect(enableNotifications()).rejects.toThrow(/Deploy the latest version/);
  });

  it('fails clearly without push support', async () => {
    vi.stubGlobal('PushManager', undefined);
    await expect(enableNotifications()).rejects.toMatchObject({ code: 'unsupported' });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('disableNotifications', () => {
  it('unsubscribes, deletes on the server and forgets the id', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    const sub = env.current;
    const result = await disableNotifications();
    expect(result.serverWarning).toBeNull();
    expect(sub?.unsubscribe).toHaveBeenCalled();
    expect(env.calls).toContainEqual({
      method: 'DELETE',
      path: '/api/push/subscriptions/sub-a',
      body: undefined,
    });
    expect(await meta()).toEqual({ id: null, endpoint: null });
  });

  it('still turns off on the phone when the server is unreachable', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const result = await disableNotifications();
    expect(result.serverWarning).toMatch(/reach your server/);
    expect(env.current).toBeNull();
    expect(await meta()).toEqual({ id: null, endpoint: null });
  });
});

describe('checkPushHealth', () => {
  it('does nothing while permission is denied or not asked', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.current = null;
    for (const permission of ['denied', 'default'] as const) {
      env.permission = permission;
      expect(await checkPushHealth()).toEqual({ status: 'not_granted' });
    }
    expect(env.calls).toHaveLength(0);
    expect(pushManager.getSubscription).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('does nothing without a token', async () => {
    await db.meta.delete('token');
    expect(await checkPushHealth()).toEqual({ status: 'not_connected' });
    expect(env.calls).toHaveLength(0);
  });

  it('only checks the key when the subscription matches what is registered', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    expect(await checkPushHealth()).toEqual({ status: 'ok' });
    expect(env.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/push/vapid-public-key',
    ]);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('passes offline when nothing else needs fixing', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect(await checkPushHealth()).toEqual({ status: 'ok' });
  });

  it('re-subscribes with the new key when the server key changed', async () => {
    const oldKey = base64UrlToBytes(OTHER_KEY);
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    const old = new FakeSubscription('https://web.push.apple.com/a', oldKey);
    env.current = old;

    expect(await checkPushHealth()).toEqual({ status: 'repaired', action: 'rekeyed' });

    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const opts = pushManager.subscribe.mock.calls[0]?.[0];
    expect(bytesToBase64Url(opts?.applicationServerKey ?? new Uint8Array())).toBe(VAPID_KEY);
    expect(posts().map((c) => (c.body as { endpoint: string }).endpoint)).toEqual([
      'https://web.push.apple.com/endpoint-1',
    ]);
    expect(await meta()).toEqual({
      id: 'sub-2',
      endpoint: 'https://web.push.apple.com/endpoint-1',
    });
    expect(env.calls).toContainEqual({
      method: 'DELETE',
      path: '/api/push/subscriptions/sub-a',
      body: undefined,
    });
    // The next check finds everything in order.
    env.calls = [];
    expect(await checkPushHealth()).toEqual({ status: 'ok' });
    expect(posts()).toHaveLength(0);
  });

  it('keeps a subscription whose key the browser does not expose', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.current = new FakeSubscription('https://web.push.apple.com/a', null);
    expect(await checkPushHealth()).toEqual({ status: 'ok' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('does nothing when notifications were never turned on', async () => {
    expect(await checkPushHealth()).toEqual({ status: 'off' });
    expect(env.calls).toHaveLength(0);
  });

  it('re-subscribes and re-posts when iOS dropped the subscription', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.current = null;
    expect(await checkPushHealth()).toEqual({ status: 'repaired', action: 'resubscribed' });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    expect((posts()[0]?.body as { endpoint: string }).endpoint).toBe(
      'https://web.push.apple.com/endpoint-1',
    );
    const stored = await meta();
    expect(stored).toEqual({ id: 'sub-2', endpoint: 'https://web.push.apple.com/endpoint-1' });
    // The dead row is removed so the server holds no duplicate.
    expect(env.calls).toContainEqual({
      method: 'DELETE',
      path: '/api/push/subscriptions/sub-a',
      body: undefined,
    });
  });

  it('re-posts when the endpoint changed', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.current = new FakeSubscription('https://web.push.apple.com/b');
    expect(await checkPushHealth()).toEqual({ status: 'repaired', action: 'reposted' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(posts().map((c) => (c.body as { endpoint: string }).endpoint)).toEqual([
      'https://web.push.apple.com/b',
    ]);
    expect(await meta()).toEqual({ id: 'sub-2', endpoint: 'https://web.push.apple.com/b' });
  });

  it('posts a subscription the server never received', async () => {
    env.current = new FakeSubscription('https://web.push.apple.com/unsent');
    expect(await checkPushHealth()).toEqual({ status: 'repaired', action: 'reposted' });
    expect(posts()).toHaveLength(1);
    expect((await meta()).id).toBe('sub-1');
  });

  it('keeps the same id when the server already knows the endpoint', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    await db.meta.delete(META_ENDPOINT);
    expect(await checkPushHealth()).toEqual({ status: 'repaired', action: 'reposted' });
    expect(await meta()).toEqual({ id: 'sub-a', endpoint: 'https://web.push.apple.com/a' });
    expect(env.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('reports a failure instead of throwing', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.current = new FakeSubscription('https://web.push.apple.com/b');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const health = await checkPushHealth();
    expect(health.status).toBe('error');
    expect(health.status === 'error' && health.message).toMatch(/reach your server/);
    expect((await meta()).endpoint).toBe('https://web.push.apple.com/a');
  });

  it('waits for the service worker without failing', async () => {
    env.registered = false;
    expect(await checkPushHealth()).toEqual({ status: 'no_worker' });
  });
});

describe('reregister', () => {
  it('posts the current subscription again', async () => {
    await alreadyRegistered('https://web.push.apple.com/a', 'sub-a');
    env.serverIds.clear(); // The server forgot it.
    expect(await reregister()).toBe('sub-1');
    expect(await meta()).toEqual({ id: 'sub-1', endpoint: 'https://web.push.apple.com/a' });
  });
});
