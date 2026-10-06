import { healthResponseSchema } from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../data/testUtils';
import { ApiError, apiFetch, clearToken, getToken, setToken } from './client';

function respond(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores, trims and clears the token', async () => {
    expect(await getToken()).toBeNull();
    await setToken('  abc  ');
    expect(await getToken()).toBe('abc');
    await clearToken();
    expect(await getToken()).toBeNull();
  });

  it('refuses to call without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/state')).rejects.toMatchObject({ code: 'not_connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token and JSON body, and validates the response', async () => {
    await setToken('secret');
    const fetchMock = vi.fn(() =>
      Promise.resolve(respond(200, { ok: true, time: '2026-10-06T00:00:00.000Z' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await apiFetch('/api/x', { body: { a: 1 }, schema: healthResponseSchema });
    expect(out.ok).toBe(true);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    });
  });

  it('uses an explicit token over the stored one', async () => {
    await setToken('stored');
    const fetchMock = vi.fn(() => Promise.resolve(respond(204, undefined)));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/y', { method: 'DELETE', token: 'other' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer other' });
  });

  it('turns server errors into ApiError with the server code', async () => {
    await setToken('t');
    vi.stubGlobal('fetch', () =>
      Promise.resolve(respond(401, { error: { code: 'unauthorized', message: 'nope' } })),
    );
    const err = await apiFetch('/api/state').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'nope',
      retryable: false,
    });
  });

  it('marks network failures and 5xx as retryable', async () => {
    await setToken('t');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiFetch('/api/state')).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('oops', { status: 502 })));
    await expect(apiFetch('/api/state')).rejects.toMatchObject({ status: 502, retryable: true });
  });

  it('rejects a response that does not match the schema', async () => {
    await setToken('t');
    vi.stubGlobal('fetch', () => Promise.resolve(respond(200, { ok: 'yes' })));
    await expect(apiFetch('/api/health', { schema: healthResponseSchema })).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});
