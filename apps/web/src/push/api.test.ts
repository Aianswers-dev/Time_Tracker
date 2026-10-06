import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../api/client';
import { resetDb } from '../data/testUtils';
import {
  deleteSubscription,
  listSubscriptions,
  sendTestNotification,
  subscriptionListParser,
} from './api';
import { deviceLabel, timeAgo } from './format';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('subscription list parser', () => {
  const row = {
    id: 'sub-1',
    createdAt: '2026-10-06T10:00:00.000Z',
    lastSuccessAt: null,
    failureCount: 0,
    userAgent: 'Mozilla/5.0 (iPhone)',
  };

  it('accepts the documented shape', () => {
    expect(subscriptionListParser.parse({ subscriptions: [row] })).toEqual({
      subscriptions: [row],
    });
    expect(
      subscriptionListParser.parse({
        subscriptions: [{ ...row, lastSuccessAt: '2026-10-06T11:00:00.000Z', userAgent: null }],
      }).subscriptions[0]?.lastSuccessAt,
    ).toBe('2026-10-06T11:00:00.000Z');
  });

  it('fills in optional nullable fields that are missing', () => {
    const { lastSuccessAt: _a, userAgent: _b, ...bare } = row;
    expect(subscriptionListParser.parse({ subscriptions: [bare] }).subscriptions[0]).toEqual({
      ...bare,
      lastSuccessAt: null,
      userAgent: null,
    });
  });

  it.each([
    [null],
    [[]],
    [{ subscriptions: 'x' }],
    [{ subscriptions: [{ ...row, id: 7 }] }],
    [{ subscriptions: [{ ...row, createdAt: 'yesterday' }] }],
    [{ subscriptions: [{ ...row, failureCount: -1 }] }],
    [{ subscriptions: [{ ...row, failureCount: 1.5 }] }],
    [{ subscriptions: [{ ...row, lastSuccessAt: 3 }] }],
  ])('rejects %j', (bad) => {
    expect(() => subscriptionListParser.parse(bad)).toThrow();
  });
});

describe('push routes', () => {
  beforeEach(async () => {
    await resetDb();
    await setToken('secret');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists subscriptions and reports a malformed answer as bad_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(200, { subscriptions: [] }))
        .mockResolvedValueOnce(json(200, { subs: [] })),
    );
    expect(await listSubscriptions()).toEqual([]);
    await expect(listSubscriptions()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('sends the test as a POST without a body', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, { sent: 1, failed: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendTestNotification()).toEqual({ sent: 1, failed: 0 });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/push/test');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('treats deleting an unknown subscription as done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(404, { error: { code: 'not_found', message: 'No such subscription' } }),
        ),
      ),
    );
    await expect(deleteSubscription('gone')).resolves.toBeUndefined();
  });
});

describe('status labels', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  it('says how long ago', () => {
    expect(timeAgo('2026-10-06T11:59:40.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-06T11:55:00.000Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-06T09:00:00.000Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-01T09:00:00.000Z', now)).not.toMatch(/ago/);
  });

  it('names devices from user agents', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Mac');
    expect(deviceLabel(null)).toBe('Unknown device');
  });
});
