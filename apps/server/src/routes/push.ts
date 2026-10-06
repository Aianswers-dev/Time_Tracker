import {
  pushSubscriptionRequestSchema,
  uuidv7,
  type vapidKeyResponseSchema,
} from '@time-tracker/shared';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { z } from 'zod';
import { createDb } from '../db/client';
import { select } from '../db/queries';
import { pushSubscriptions } from '../db/schema';
import type { AppEnv } from '../env';
import { readJson } from '../http';
import { decodeBase64Url, encodeBase64Url } from '../push/base64url';
import { webPushSender } from '../push/sender';
import { sendTestNotification } from '../push/test-notification';
import { recordOrigin, resolveVapidKeys } from '../push/vapid';
import { systemClock } from '../sync/ops';

export const pushRoutes = new Hono<AppEnv>();

/** `GET /api/push/subscriptions`: one entry per subscription, without its endpoint or keys. */
export interface PushSubscriptionInfo {
  id: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  userAgent: string | null;
}

export interface PushSubscriptionsResponse {
  subscriptions: PushSubscriptionInfo[];
}

/**
 * `GET /api/push/vapid-public-key`: the key for `pushManager.subscribe`. Also
 * records the request's origin as the default VAPID subject. One D1 call, two
 * the very first time (when the key pair is generated).
 */
pushRoutes.get('/push/vapid-public-key', async (c) => {
  const db = createDb(c.env.DB);
  const now = systemClock();
  const [, configRows] = await db.batch([
    recordOrigin(db, c.req.url, now),
    select.serverConfig(db),
  ]);
  const { keys } = await resolveVapidKeys(db, c.env, configRows, now);
  const body: z.infer<typeof vapidKeyResponseSchema> = { key: keys.publicKey };
  return c.json(body);
});

/** Base64url bytes of `text` when they have the expected length (and first byte). */
function decodesTo(text: string, length: number, firstByte?: number): Uint8Array | null {
  const bytes = decodeBase64Url(text);
  if (!bytes || bytes.length !== length) return null;
  if (firstByte !== undefined && bytes[0] !== firstByte) return null;
  return bytes;
}

/**
 * The shared request schema plus what sending needs: an https endpoint, a
 * P-256 public key and a 16-byte auth secret. Keys are stored as base64url.
 */
const subscriptionRequestSchema = pushSubscriptionRequestSchema
  .superRefine((s, ctx) => {
    if (!/^https:\/\//i.test(s.endpoint) || s.endpoint.length > 2048) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpoint'],
        message: 'Push endpoints must be https URLs of at most 2048 characters',
      });
    }
    if (!decodesTo(s.keys.p256dh, 65, 0x04)) {
      ctx.addIssue({
        code: 'custom',
        path: ['keys', 'p256dh'],
        message: 'Expected an uncompressed P-256 public key (65 bytes, base64url)',
      });
    }
    if (!decodesTo(s.keys.auth, 16)) {
      ctx.addIssue({
        code: 'custom',
        path: ['keys', 'auth'],
        message: 'Expected a 16-byte auth secret (base64url)',
      });
    }
  })
  .transform((s) => ({
    endpoint: s.endpoint,
    p256dh: encodeBase64Url(decodesTo(s.keys.p256dh, 65) ?? new Uint8Array()),
    auth: encodeBase64Url(decodesTo(s.keys.auth, 16) ?? new Uint8Array()),
    userAgent: s.userAgent ?? null,
  }));

/**
 * `POST /api/push/subscriptions`: upsert on `endpoint`, `201 { id }`.
 * Registering the same endpoint again keeps its id, replaces its keys and
 * resets its failure count. Also records the origin. One D1 call.
 */
pushRoutes.post('/push/subscriptions', async (c) => {
  const req = await readJson(c, subscriptionRequestSchema);
  const db = createDb(c.env.DB);
  const now = systemClock();
  const [, rows] = await db.batch([
    recordOrigin(db, c.req.url, now),
    db
      .insert(pushSubscriptions)
      .values({
        id: uuidv7(),
        endpoint: req.endpoint,
        p256dh: req.p256dh,
        auth: req.auth,
        userAgent: req.userAgent,
        createdAt: now,
        lastSuccessAt: null,
        failureCount: 0,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          p256dh: sql`excluded.p256dh`,
          auth: sql`excluded.auth`,
          userAgent: sql`coalesce(excluded.user_agent, ${pushSubscriptions.userAgent})`,
          failureCount: 0,
        },
      })
      .returning({ id: pushSubscriptions.id }),
  ]);
  const stored = rows[0];
  if (!stored) throw new Error('Subscription upsert returned no row');
  return c.json({ id: stored.id }, 201);
});

/** `GET /api/push/subscriptions`: status for the Settings screen, oldest first. */
pushRoutes.get('/push/subscriptions', async (c) => {
  const rows = await select.pushSubscriptions(createDb(c.env.DB));
  const body: PushSubscriptionsResponse = {
    subscriptions: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastSuccessAt: r.lastSuccessAt,
      failureCount: r.failureCount,
      userAgent: r.userAgent,
    })),
  };
  return c.json(body);
});

/** `DELETE /api/push/subscriptions/:id`: `204`, also when there was no such subscription. */
pushRoutes.delete('/push/subscriptions/:id', async (c) => {
  const db = createDb(c.env.DB);
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, c.req.param('id')));
  return c.body(null, 204);
});

/** `POST /api/push/test`: "Test notification" to every subscription, `{ sent, failed }`. */
pushRoutes.post('/push/test', async (c) => {
  const body = await sendTestNotification({
    db: createDb(c.env.DB),
    env: c.env,
    senderFor: (vapid) => webPushSender(vapid),
    requestUrl: c.req.url,
    now: systemClock(),
  });
  return c.json(body);
});
