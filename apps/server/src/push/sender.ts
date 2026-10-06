import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { PushPayload } from '@time-tracker/shared';
import type { Vapid } from './vapid';

/**
 * Sending one Web Push message. The scheduled job and `POST /api/push/test`
 * talk to a `PushSender`, so tests can swap in a fake.
 *
 * The real sender encrypts with `@block65/webcrypto-web-push` 2.x: aes128gcm
 * (RFC 8291) and the `vapid` authorization scheme (RFC 8292), both accepted by
 * Apple. Every body is padded to 4096 bytes, so a payload can be at most 3993.
 */

/** Where to send: a stored subscription's endpoint and client keys (base64url). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** How long the push service keeps an undelivered message. */
  ttlSeconds: number;
  urgency: 'low' | 'normal' | 'high';
}

export type PushOutcome =
  /** The push service accepted the message (2xx). */
  | { status: 'sent'; httpStatus: number }
  /** 404 or 410: the subscription no longer exists and should be deleted. */
  | { status: 'gone'; httpStatus: number }
  /** Anything else, including errors before or during the request. */
  | { status: 'failed'; httpStatus: number | null; reason: string };

export interface PushSender {
  /** Never throws: every problem is a `failed` outcome. */
  send(target: PushTarget, payload: PushPayload, options: PushOptions): Promise<PushOutcome>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** How much of a push service's error body goes into the outcome. */
const REASON_CHARS = 120;

function describe(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, REASON_CHARS);
}

/** Sends through the network with `fetch`, signing with `vapid`. */
export function webPushSender(
  vapid: Vapid,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): PushSender {
  return {
    async send(target, payload, options) {
      let init: Awaited<ReturnType<typeof buildPushPayload>>;
      try {
        init = await buildPushPayload(
          { data: payload, options: { ttl: options.ttlSeconds, urgency: options.urgency } },
          {
            endpoint: target.endpoint,
            expirationTime: null,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          vapid,
        );
      } catch (err) {
        return { status: 'failed', httpStatus: null, reason: `encrypt: ${describe(err)}` };
      }

      let res: Response;
      try {
        res = await fetchImpl(target.endpoint, init);
      } catch (err) {
        return { status: 'failed', httpStatus: null, reason: `fetch: ${describe(err)}` };
      }
      // Read the body so the connection is released. Push services explain
      // rejections in it (Apple: {"reason":"BadJwtToken"}).
      let body = '';
      try {
        body = (await res.text()).slice(0, REASON_CHARS);
      } catch {
        // The status is what matters.
      }
      if (res.ok) return { status: 'sent', httpStatus: res.status };
      if (res.status === 404 || res.status === 410) {
        return { status: 'gone', httpStatus: res.status };
      }
      const reason =
        body.trim() === '' ? `HTTP ${res.status}` : `HTTP ${res.status} ${body.trim()}`;
      return { status: 'failed', httpStatus: res.status, reason };
    },
  };
}
