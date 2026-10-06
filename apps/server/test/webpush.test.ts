import { pushPayloadSchema, type PushPayload } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../src/push/base64url';
import { NUDGE_PUSH_OPTIONS, PUSH_TTL_SECONDS, pushPayload } from '../src/push/deliver';
import { webPushSender, type FetchLike } from '../src/push/sender';
import { generateVapidKeys, normalizeVapidKeys, type Vapid } from '../src/push/vapid';
import {
  bytes,
  decryptPushBody,
  importEcdhPrivateKey,
  makeBrowserSubscription,
  verifyEs256Jwt,
} from './push-helpers';

/**
 * Web Push encryption and signing, in Node. The library's output is decrypted
 * with an RFC 8291 decryptor written in the test (checked first against the
 * RFC's own example), and its VAPID JWT is verified against the public key.
 */

describe('the test decryptor', () => {
  it('decrypts the RFC 8291 §5 example message', async () => {
    // RFC 8291 §5 and Appendix A.
    const uaPublic = bytes(
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    );
    const message = bytes(`
      DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
      mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
      pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`);
    const decrypted = await decryptPushBody(message, {
      privateKey: await importEcdhPrivateKey(
        'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
        uaPublic,
      ),
      publicKey: uaPublic,
      authSecret: bytes('BTBZMqHH6r4Tts7J_aSIgg'),
    });
    expect(decrypted.plaintext).toBe('When I grow up, I want to be a watermelon');
    expect(decrypted.recordSize).toBe(4096);
    expect(encodeBase64Url(decrypted.senderPublicKey)).toBe(
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
  });
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  method: string;
  body: Uint8Array;
}

/** A fetch that records the request and answers `status`. */
function capturingFetch(status = 201, responseBody = ''): { fetch: FetchLike; sent: Captured[] } {
  const sent: Captured[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    sent.push({
      url,
      headers,
      method: String(init.method),
      body: new Uint8Array(init.body as Uint8Array),
    });
    return Promise.resolve(new Response(responseBody, { status }));
  };
  return { fetch: fetchImpl, sent };
}

async function testVapid(subject = 'https://tracker.example.com'): Promise<Vapid> {
  return { ...(await generateVapidKeys()), subject };
}

const PAYLOAD: PushPayload = pushPayload({
  title: 'Relaxing for 1h 0m',
  body: "You've been on Relaxing for 1h 0m straight. Time to switch it up.",
  tag: 'session:0199a000-0000-7000-8000-000000000000',
});

describe('generateVapidKeys', () => {
  it('makes a P-256 pair in the web-push format: raw 65-byte point and 32-byte scalar', async () => {
    const keys = await generateVapidKeys();
    const pub = decodeBase64Url(keys.publicKey);
    expect(pub?.length).toBe(65);
    expect(pub?.[0]).toBe(0x04);
    expect(decodeBase64Url(keys.privateKey)?.length).toBe(32);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(normalizeVapidKeys(keys.publicKey, keys.privateKey)).toEqual(keys);
  });

  it('normalizes padded and plain base64 keys, rejects wrong lengths', async () => {
    const keys = await generateVapidKeys();
    const toBase64 = (s: string) => {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      return b + '='.repeat((4 - (b.length % 4)) % 4);
    };
    expect(normalizeVapidKeys(toBase64(keys.publicKey), toBase64(keys.privateKey))).toEqual(keys);
    expect(normalizeVapidKeys(keys.privateKey, keys.privateKey)).toBeNull();
    expect(normalizeVapidKeys(keys.publicKey, keys.publicKey)).toBeNull();
    expect(normalizeVapidKeys('not base64!', keys.privateKey)).toBeNull();
  });
});

describe('webPushSender', () => {
  it('sends an aes128gcm body the subscriber can decrypt back to the JSON payload', async () => {
    const vapid = await testVapid();
    const sub = await makeBrowserSubscription('https://web.push.apple.com/QGuDXnmT_device-token');
    const { fetch, sent } = capturingFetch(201);
    const outcome = await webPushSender(vapid, fetch).send(
      { endpoint: sub.endpoint, ...sub.keys },
      PAYLOAD,
      NUDGE_PUSH_OPTIONS,
    );
    expect(outcome).toEqual({ status: 'sent', httpStatus: 201 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.url).toBe(sub.endpoint);
    expect(req.method.toUpperCase()).toBe('POST');
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers['content-type']).toBe('application/octet-stream');
    expect(req.headers.ttl).toBe(String(PUSH_TTL_SECONDS));
    expect(req.headers.urgency).toBe('high');
    expect(req.headers['content-length']).toBe(String(req.body.byteLength));

    const decrypted = await decryptPushBody(req.body, sub);
    expect(decrypted.recordSize).toBe(4096);
    expect(decrypted.senderPublicKey).toHaveLength(65);
    const json: unknown = JSON.parse(decrypted.plaintext);
    expect(pushPayloadSchema.parse(json)).toEqual(PAYLOAD);
    expect(json).toEqual({
      title: PAYLOAD.title,
      body: PAYLOAD.body,
      tag: PAYLOAD.tag,
      data: { url: '/' },
    });
  });

  it('signs a VAPID JWT for the endpoint origin with the configured subject', async () => {
    const vapid = await testVapid('mailto:owner@example.com');
    const sub = await makeBrowserSubscription('https://web.push.apple.com/abc123');
    const { fetch, sent } = capturingFetch(201);
    const before = Math.floor(Date.now() / 1000);
    await webPushSender(vapid, fetch).send(
      { endpoint: sub.endpoint, ...sub.keys },
      PAYLOAD,
      NUDGE_PUSH_OPTIONS,
    );

    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(
      sent[0]?.headers.authorization ?? '',
    );
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(vapid.publicKey);
    const { header, claims } = await verifyEs256Jwt(jwt!, vapid.publicKey);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe('mailto:owner@example.com');
    const exp = claims.exp as number;
    expect(exp).toBeGreaterThan(before);
    expect(exp).toBeLessThanOrEqual(before + 24 * 3600 + 5);

    // Signed by this key and no other.
    await expect(verifyEs256Jwt(jwt!, (await generateVapidKeys()).publicKey)).rejects.toThrow();
  });

  it('encrypts each message afresh', async () => {
    const vapid = await testVapid();
    const sub = await makeBrowserSubscription();
    const { fetch, sent } = capturingFetch(201);
    const sender = webPushSender(vapid, fetch);
    const target = { endpoint: sub.endpoint, ...sub.keys };
    await sender.send(target, PAYLOAD, NUDGE_PUSH_OPTIONS);
    await sender.send(target, PAYLOAD, NUDGE_PUSH_OPTIONS);
    expect(encodeBase64Url(sent[0]!.body)).not.toBe(encodeBase64Url(sent[1]!.body));
    for (const req of sent) {
      expect(JSON.parse((await decryptPushBody(req.body, sub)).plaintext)).toEqual(PAYLOAD);
    }
  });

  it('maps push service answers to outcomes', async () => {
    const vapid = await testVapid();
    const sub = await makeBrowserSubscription();
    const target = { endpoint: sub.endpoint, ...sub.keys };
    const send = (status: number, body = '') =>
      webPushSender(vapid, capturingFetch(status, body).fetch).send(
        target,
        PAYLOAD,
        NUDGE_PUSH_OPTIONS,
      );
    expect(await send(201)).toEqual({ status: 'sent', httpStatus: 201 });
    expect(await send(200)).toEqual({ status: 'sent', httpStatus: 200 });
    expect(await send(410)).toEqual({ status: 'gone', httpStatus: 410 });
    expect(await send(404)).toEqual({ status: 'gone', httpStatus: 404 });
    expect(await send(500)).toEqual({ status: 'failed', httpStatus: 500, reason: 'HTTP 500' });
    expect(await send(403, '{"reason":"BadJwtToken"}')).toEqual({
      status: 'failed',
      httpStatus: 403,
      reason: 'HTTP 403 {"reason":"BadJwtToken"}',
    });
  });

  it('turns network errors and bad subscription keys into failures without throwing', async () => {
    const vapid = await testVapid();
    const sub = await makeBrowserSubscription();
    const failing = webPushSender(vapid, () => Promise.reject(new TypeError('Network lost')));
    const outcome = await failing.send(
      { endpoint: sub.endpoint, ...sub.keys },
      PAYLOAD,
      NUDGE_PUSH_OPTIONS,
    );
    expect(outcome).toMatchObject({ status: 'failed', httpStatus: null });
    expect(outcome.status === 'failed' && outcome.reason).toContain('Network lost');

    const { fetch, sent } = capturingFetch(201);
    const bad = await webPushSender(vapid, fetch).send(
      { endpoint: sub.endpoint, p256dh: encodeBase64Url(new Uint8Array(10)), auth: sub.keys.auth },
      PAYLOAD,
      NUDGE_PUSH_OPTIONS,
    );
    expect(bad).toMatchObject({ status: 'failed', httpStatus: null });
    expect(sent).toHaveLength(0);
  });

  it('the largest payload the schemas allow fits in one push message', async () => {
    const vapid = await testVapid();
    const sub = await makeBrowserSubscription();
    const { fetch, sent } = capturingFetch(201);
    // Category names are at most 40 characters and custom messages 200.
    const big = pushPayload({
      title: `${'😀'.repeat(40)} for 9999h 59m`,
      body: '😀'.repeat(200),
      tag: 'session:0199a000-0000-7000-8000-000000000000',
    });
    const outcome = await webPushSender(vapid, fetch).send(
      { endpoint: sub.endpoint, ...sub.keys },
      big,
      NUDGE_PUSH_OPTIONS,
    );
    expect(outcome.status).toBe('sent');
    expect(JSON.parse((await decryptPushBody(sent[0]!.body, sub)).plaintext)).toEqual(big);
  });
});
