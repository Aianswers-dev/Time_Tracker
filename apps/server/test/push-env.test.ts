import { vapidKeyResponseSchema } from '@time-tracker/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/db/schema';
import {
  envVapidKeys,
  generateVapidKeys,
  ORIGIN_CONFIG_KEY,
  VAPID_KEYS_CONFIG_KEY,
  vapidSubject,
} from '../src/push/vapid';
import { T0, TOKEN, useTestServer } from './harness';

/** RFC 8291 Appendix A's application server key pair: a valid P-256 pair. */
const ENV_PUBLIC =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const ENV_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';

const server = useTestServer({
  AUTH_TOKEN: TOKEN,
  VAPID_PUBLIC_KEY: ENV_PUBLIC,
  VAPID_PRIVATE_KEY: ENV_PRIVATE,
  VAPID_SUBJECT: 'mailto:owner@example.com',
});

describe('VAPID secrets', () => {
  it('override a stored pair, and nothing is generated', async () => {
    const stored = await generateVapidKeys();
    await server
      .db()
      .insert(serverConfig)
      .values({ key: VAPID_KEYS_CONFIG_KEY, value: JSON.stringify(stored), updatedAt: T0 });

    const res = await server.get('/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(vapidKeyResponseSchema.parse(res.json).key).toBe(ENV_PUBLIC);

    // The stored pair is left alone, for if the secrets are removed again.
    const rows = await server
      .db()
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.key, VAPID_KEYS_CONFIG_KEY));
    expect(rows.map((r) => r.value)).toEqual([JSON.stringify(stored)]);
  });

  it('with no stored pair, serve the secret key without storing one', async () => {
    const res = await server.get('/api/push/vapid-public-key');
    expect(vapidKeyResponseSchema.parse(res.json).key).toBe(ENV_PUBLIC);
    const keys = await server.db().select().from(serverConfig);
    expect(keys.map((r) => r.key)).toEqual([ORIGIN_CONFIG_KEY]);
  });
});

describe('envVapidKeys and vapidSubject', () => {
  const row = (key: string, value: string) => ({ key, value, updatedAt: T0 });

  it('use the secrets only when both keys are set and well formed', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(envVapidKeys({ VAPID_PUBLIC_KEY: ENV_PUBLIC, VAPID_PRIVATE_KEY: ENV_PRIVATE })).toEqual({
      publicKey: ENV_PUBLIC,
      privateKey: ENV_PRIVATE,
    });
    expect(envVapidKeys({ VAPID_PUBLIC_KEY: ENV_PUBLIC })).toBeNull();
    expect(envVapidKeys({ VAPID_PUBLIC_KEY: ENV_PUBLIC, VAPID_PRIVATE_KEY: '' })).toBeNull();
    expect(quiet).not.toHaveBeenCalled();
    expect(
      envVapidKeys({ VAPID_PUBLIC_KEY: ENV_PRIVATE, VAPID_PRIVATE_KEY: ENV_PRIVATE }),
    ).toBeNull();
    expect(quiet).toHaveBeenCalledTimes(1);
    // The log line never contains the key itself.
    expect(String(quiet.mock.calls[0]?.[0])).not.toContain(ENV_PRIVATE);
    quiet.mockRestore();
  });

  it('take VAPID_SUBJECT when it is a mailto: or https: URL, else the recorded origin', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = [row(ORIGIN_CONFIG_KEY, 'https://tracker.example.com')];
    expect(vapidSubject({ VAPID_SUBJECT: 'mailto:me@example.com' }, rows)).toBe(
      'mailto:me@example.com',
    );
    expect(vapidSubject({ VAPID_SUBJECT: 'https://me.example.com' }, rows)).toBe(
      'https://me.example.com',
    );
    expect(vapidSubject({}, rows)).toBe('https://tracker.example.com');
    expect(vapidSubject({ VAPID_SUBJECT: 'me@example.com' }, rows)).toBe(
      'https://tracker.example.com',
    );
    expect(vapidSubject({}, [])).toBeNull();
    quiet.mockRestore();
  });
});
