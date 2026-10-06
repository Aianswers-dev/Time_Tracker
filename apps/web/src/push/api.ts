import {
  pushSubscriptionResponseSchema,
  pushTestResponseSchema,
  vapidKeyResponseSchema,
  type PushSubscriptionRequest,
  type PushTestResponse,
} from '@time-tracker/shared';
import { ApiError, apiFetch, type Parser } from '../api/client';

/** The push routes from docs/04-api.md. All go through `apiFetch`, so all carry the token. */

/** One row of `GET /api/push/subscriptions`. The server never sends endpoints or keys. */
export interface ServerSubscription {
  id: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  userAgent: string | null;
}

class ParseError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parseSubscription(v: unknown): ServerSubscription {
  if (!isRecord(v)) throw new ParseError('subscription is not an object');
  const { id, createdAt, lastSuccessAt, failureCount, userAgent } = v;
  if (typeof id !== 'string' || id === '') throw new ParseError('id');
  if (!isIso(createdAt)) throw new ParseError('createdAt');
  if (lastSuccessAt !== null && lastSuccessAt !== undefined && !isIso(lastSuccessAt)) {
    throw new ParseError('lastSuccessAt');
  }
  if (typeof failureCount !== 'number' || !Number.isInteger(failureCount) || failureCount < 0) {
    throw new ParseError('failureCount');
  }
  if (userAgent !== null && userAgent !== undefined && typeof userAgent !== 'string') {
    throw new ParseError('userAgent');
  }
  return {
    id,
    createdAt,
    lastSuccessAt: lastSuccessAt ?? null,
    failureCount,
    userAgent: userAgent ?? null,
  };
}

/**
 * Hand-rolled parser for `GET /api/push/subscriptions`, since the shared
 * package has no schema for it yet and the web app does not depend on zod
 * directly. Same contract as a zod schema's `parse`: return the data or throw.
 */
export const subscriptionListParser: Parser<{ subscriptions: ServerSubscription[] }> = {
  parse(data: unknown) {
    if (!isRecord(data) || !Array.isArray(data.subscriptions)) {
      throw new ParseError('Expected { subscriptions: [...] }');
    }
    return { subscriptions: data.subscriptions.map(parseSubscription) };
  },
};

/** `GET /api/push/vapid-public-key`: the base64url public key to subscribe with. */
export async function fetchVapidKey(): Promise<string> {
  const { key } = await apiFetch('/api/push/vapid-public-key', { schema: vapidKeyResponseSchema });
  return key;
}

/** `POST /api/push/subscriptions`. The server upserts on endpoint, so a repeat returns the same id. */
export async function postSubscription(body: PushSubscriptionRequest): Promise<string> {
  const { id } = await apiFetch('/api/push/subscriptions', {
    method: 'POST',
    body,
    schema: pushSubscriptionResponseSchema,
  });
  return id;
}

/** `DELETE /api/push/subscriptions/:id`. A subscription the server already forgot counts as deleted. */
export async function deleteSubscription(id: string): Promise<void> {
  try {
    await apiFetch(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

/** `POST /api/push/test`: sends "Test notification" to every stored subscription. */
export function sendTestNotification(): Promise<PushTestResponse> {
  return apiFetch('/api/push/test', { method: 'POST', schema: pushTestResponseSchema });
}

/** `GET /api/push/subscriptions`: every subscription the server will send to. */
export async function listSubscriptions(): Promise<ServerSubscription[]> {
  const { subscriptions } = await apiFetch('/api/push/subscriptions', {
    schema: subscriptionListParser,
  });
  return subscriptions;
}
