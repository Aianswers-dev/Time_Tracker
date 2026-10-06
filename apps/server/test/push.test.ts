import {
  apiErrorSchema,
  pushSubscriptionResponseSchema,
  pushTestResponseSchema,
  vapidKeyResponseSchema,
} from '@time-tracker/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pushSubscriptions, serverConfig } from '../src/db/schema';
import { decodeBase64Url, encodeBase64Url } from '../src/push/base64url';
import { ORIGIN_CONFIG_KEY, VAPID_KEYS_CONFIG_KEY } from '../src/push/vapid';
import { makeBrowserSubscription, verifyEs256Jwt } from './push-helpers';
import { useTestServer } from './harness';

const server = useTestServer();

/** What the web client will validate `GET /api/push/subscriptions` with (docs/04). Strict: no keys. */
const subscriptionsResponseSchema = z.object({
  subscriptions: z.array(
    z.strictObject({
      id: z.string(),
      createdAt: z.iso.datetime(),
      lastSuccessAt: z.iso.datetime().nullable(),
      failureCount: z.number().int().min(0),
      userAgent: z.string().nullable(),
    }),
  ),
});

async function config(key: string): Promise<string | null> {
  const rows = await server.db().select().from(serverConfig).where(eq(serverConfig.key, key));
  return rows[0]?.value ?? null;
}

async function subscriptionRows() {
  return server.db().select().from(pushSubscriptions);
}

async function subscriptionJson(endpoint?: string) {
  const sub = await makeBrowserSubscription(endpoint);
  return { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys };
}

describe('GET /api/push/vapid-public-key', () => {
  it('generates a key pair once and serves the same public key afterwards', async () => {
    const first = await server.get('/api/push/vapid-public-key');
    expect(first.status).toBe(200);
    const { key } = vapidKeyResponseSchema.parse(first.json);
    const raw = decodeBase64Url(key);
    expect(raw?.length).toBe(65);
    expect(raw?.[0]).toBe(0x04);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = vapidKeyResponseSchema.parse(
      (await server.get('/api/push/vapid-public-key')).json,
    );
    expect(second.key).toBe(key);

    const stored = z
      .object({ publicKey: z.string(), privateKey: z.string() })
      .parse(JSON.parse((await config(VAPID_KEYS_CONFIG_KEY)) ?? 'null'));
    expect(stored.publicKey).toBe(key);
    expect(decodeBase64Url(stored.privateKey)?.length).toBe(32);
  });

  it('the stored private key belongs to the served public key', async () => {
    const { key } = vapidKeyResponseSchema.parse(
      (await server.get('/api/push/vapid-public-key')).json,
    );
    const { privateKey } = z
      .object({ privateKey: z.string() })
      .parse(JSON.parse((await config(VAPID_KEYS_CONFIG_KEY)) ?? 'null'));
    const pub = decodeBase64Url(key)!;
    const signingKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: encodeBase64Url(pub.slice(1, 33)),
        y: encodeBase64Url(pub.slice(33)),
        d: privateKey,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const enc = (o: object) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(o)));
    const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ sub: 'x' })}`;
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      new TextEncoder().encode(data),
    );
    await expect(verifyEs256Jwt(`${data}.${encodeBase64Url(sig)}`, key)).resolves.toBeTruthy();
  });

  it('concurrent first requests all get the one stored pair', async () => {
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => server.get('/api/push/vapid-public-key')),
    );
    const keys = replies.map((r) => vapidKeyResponseSchema.parse(r.json).key);
    expect(new Set(keys).size).toBe(1);
    const rows = await server.db().select().from(serverConfig);
    expect(rows.filter((r) => r.key === VAPID_KEYS_CONFIG_KEY)).toHaveLength(1);
  });

  it('records the origin it was fetched from as https://<host>', async () => {
    await server.get('http://tracker.example.com/api/push/vapid-public-key');
    expect(await config(ORIGIN_CONFIG_KEY)).toBe('https://tracker.example.com');
    await server.get('https://time.example.workers.dev/api/push/vapid-public-key');
    expect(await config(ORIGIN_CONFIG_KEY)).toBe('https://time.example.workers.dev');
  });
});

describe('POST /api/push/subscriptions', () => {
  it('stores the subscription and answers 201 with its id', async () => {
    const body = await subscriptionJson();
    const res = await server.post('/api/push/subscriptions', {
      ...body,
      userAgent: 'iPhone Safari',
    });
    expect(res.status).toBe(201);
    const { id } = pushSubscriptionResponseSchema.parse(res.json);
    const rows = await subscriptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: 'iPhone Safari',
      lastSuccessAt: null,
      failureCount: 0,
    });
  });

  it('re-registering the same endpoint keeps the id, replaces the keys and resets failures', async () => {
    const body = await subscriptionJson();
    const first = pushSubscriptionResponseSchema.parse(
      (await server.post('/api/push/subscriptions', { ...body, userAgent: 'iPhone' })).json,
    );
    await server
      .db()
      .update(pushSubscriptions)
      .set({ failureCount: 4 })
      .where(eq(pushSubscriptions.id, first.id));

    const renewed = await subscriptionJson(body.endpoint);
    const res = await server.post('/api/push/subscriptions', renewed);
    expect(res.status).toBe(201);
    expect(pushSubscriptionResponseSchema.parse(res.json).id).toBe(first.id);
    const rows = await subscriptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      p256dh: renewed.keys.p256dh,
      auth: renewed.keys.auth,
      failureCount: 0,
      // Kept when the new registration does not say.
      userAgent: 'iPhone',
    });
  });

  it('a different endpoint is a second subscription', async () => {
    const a = pushSubscriptionResponseSchema.parse(
      (await server.post('/api/push/subscriptions', await subscriptionJson())).json,
    );
    const b = pushSubscriptionResponseSchema.parse(
      (await server.post('/api/push/subscriptions', await subscriptionJson())).json,
    );
    expect(a.id).not.toBe(b.id);
    expect(await subscriptionRows()).toHaveLength(2);
  });

  it('stores keys as base64url even when sent as padded base64', async () => {
    const body = await subscriptionJson();
    const toBase64 = (s: string) => {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      return b + '='.repeat((4 - (b.length % 4)) % 4);
    };
    const res = await server.post('/api/push/subscriptions', {
      ...body,
      keys: { p256dh: toBase64(body.keys.p256dh), auth: toBase64(body.keys.auth) },
    });
    expect(res.status).toBe(201);
    expect((await subscriptionRows())[0]).toMatchObject({
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
  });

  it('records the origin', async () => {
    await server.request('POST', 'https://tracker.example.com/api/push/subscriptions', {
      body: await subscriptionJson(),
    });
    expect(await config(ORIGIN_CONFIG_KEY)).toBe('https://tracker.example.com');
  });

  it('rejects invalid subscriptions with validation_failed and the problem paths', async () => {
    const good = await subscriptionJson();
    const cases: Array<[unknown, string[]]> = [
      [{}, ['endpoint', 'keys']],
      [{ ...good, endpoint: 'not a url' }, ['endpoint']],
      [{ ...good, endpoint: 'http://push.example.com/abc' }, ['endpoint']],
      [{ ...good, keys: { p256dh: good.keys.p256dh } }, ['keys.auth']],
      [
        { ...good, keys: { ...good.keys, p256dh: encodeBase64Url(new Uint8Array(33)) } },
        ['keys.p256dh'],
      ],
      [
        { ...good, keys: { ...good.keys, auth: encodeBase64Url(new Uint8Array(8)) } },
        ['keys.auth'],
      ],
      [{ ...good, keys: { ...good.keys, auth: 'not base64!' } }, ['keys.auth']],
      [{ ...good, userAgent: 'x'.repeat(301) }, ['userAgent']],
    ];
    for (const [body, paths] of cases) {
      const res = await server.post('/api/push/subscriptions', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const error = apiErrorSchema.parse(res.json).error;
      expect(error.code).toBe('validation_failed');
      const issues = z
        .array(z.object({ path: z.string() }))
        .parse(error.details?.issues)
        .map((i) => i.path);
      for (const path of paths) expect(issues, JSON.stringify(body)).toContain(path);
    }
    const notJson = await server.request('POST', '/api/push/subscriptions', {
      rawBody: '{nope',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(notJson.status).toBe(400);
    expect(await subscriptionRows()).toHaveLength(0);
  });
});

describe('GET /api/push/subscriptions', () => {
  it('lists subscriptions oldest first, without endpoints or keys', async () => {
    expect(
      subscriptionsResponseSchema.parse((await server.get('/api/push/subscriptions')).json),
    ).toEqual({
      subscriptions: [],
    });
    const a = pushSubscriptionResponseSchema.parse(
      (
        await server.post('/api/push/subscriptions', {
          ...(await subscriptionJson()),
          userAgent: 'A',
        })
      ).json,
    );
    const b = pushSubscriptionResponseSchema.parse(
      (await server.post('/api/push/subscriptions', await subscriptionJson())).json,
    );
    const res = await server.get('/api/push/subscriptions');
    expect(res.status).toBe(200);
    const body = subscriptionsResponseSchema.parse(res.json);
    expect(body.subscriptions.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(body.subscriptions[0]).toMatchObject({
      userAgent: 'A',
      lastSuccessAt: null,
      failureCount: 0,
    });
    expect(body.subscriptions[1]?.userAgent).toBeNull();
    expect(res.text).not.toMatch(/endpoint|p256dh|auth|web\.push\.apple\.com/);
  });
});

describe('DELETE /api/push/subscriptions/:id', () => {
  it('deletes the subscription and answers 204, also when it is already gone', async () => {
    const { id } = pushSubscriptionResponseSchema.parse(
      (await server.post('/api/push/subscriptions', await subscriptionJson())).json,
    );
    const res = await server.request('DELETE', `/api/push/subscriptions/${id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await subscriptionRows()).toHaveLength(0);
    expect((await server.request('DELETE', `/api/push/subscriptions/${id}`)).status).toBe(204);
  });
});

describe('POST /api/push/test', () => {
  it('with no subscriptions sends nothing', async () => {
    const res = await server.post('/api/push/test', {});
    expect(res.status).toBe(200);
    expect(pushTestResponseSchema.parse(res.json)).toEqual({ sent: 0, failed: 0 });
  });

  it('encrypts and sends from inside the Worker; an unreachable push service counts as failed', async () => {
    // Nothing listens on port 1, so the real fetch fails fast. Everything up to
    // it (keys, origin subject, encryption in workerd) runs for real.
    server.clearLogs();
    const { id } = pushSubscriptionResponseSchema.parse(
      (
        await server.post(
          '/api/push/subscriptions',
          await subscriptionJson('https://127.0.0.1:1/push'),
        )
      ).json,
    );
    const res = await server.post('/api/push/test', {});
    expect(res.status).toBe(200);
    expect(pushTestResponseSchema.parse(res.json)).toEqual({ sent: 0, failed: 1 });
    const rows = await subscriptionRows();
    expect(rows).toMatchObject([{ id, failureCount: 1, lastSuccessAt: null }]);
    expect(await config(VAPID_KEYS_CONFIG_KEY)).not.toBeNull();
    const line = server.logs().find((l) => l.message.includes('"event":"push_test"'));
    expect(JSON.parse(line?.message ?? '{}')).toMatchObject({ sent: 0, failed: 1 });
  });
});

describe('auth', () => {
  it('every push route requires the token', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/push/vapid-public-key'],
      ['GET', '/api/push/subscriptions'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions/abc'],
      ['POST', '/api/push/test'],
    ];
    for (const [method, path] of routes) {
      for (const token of [null, 'wrong']) {
        const res = await server.request(method, path, {
          token,
          body: method === 'GET' ? undefined : {},
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(apiErrorSchema.parse(res.json).error.code).toBe('unauthorized');
      }
    }
    expect(await config(VAPID_KEYS_CONFIG_KEY)).toBeNull();
    expect(await config(ORIGIN_CONFIG_KEY)).toBeNull();
  });
});
