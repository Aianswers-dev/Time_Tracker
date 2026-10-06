import { apiErrorSchema, healthResponseSchema, uuidv7 } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { makeSettings, op, useTestServer } from './harness';

describe('with AUTH_TOKEN set', () => {
  const server = useTestServer();

  it('GET /api/health needs no token', async () => {
    const res = await server.get('/api/health', { token: null });
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.json).ok).toBe(true);
  });

  it.each([
    ['GET', '/api/state'],
    ['GET', '/api/snapshot'],
    ['GET', '/api/categories'],
    ['GET', '/api/segments?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'],
    ['GET', '/api/rules'],
    ['GET', '/api/settings'],
    ['GET', '/api/export.csv'],
    ['GET', '/api/export.json'],
    ['POST', '/api/switch'],
    ['POST', '/api/ops'],
    ['GET', '/api/no-such-route'],
  ])('%s %s without a token is 401 unauthorized', async (method, path) => {
    const res = await server.request(method, path, { token: null });
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(res.json).error.code).toBe('unauthorized');
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('a wrong token is 401', async () => {
    for (const token of ['wrong', 'test-toke', 'test-token-and-more', 'TEST-TOKEN', '']) {
      const res = await server.get('/api/state', { token });
      expect(res.status, token).toBe(401);
    }
  });

  it('a malformed Authorization header is 401', async () => {
    for (const value of ['test-token', 'Basic test-token', 'Bearer', 'Bearer test-token extra']) {
      const res = await server.get('/api/state', {
        token: null,
        headers: { Authorization: value },
      });
      expect(res.status, value).toBe(401);
    }
  });

  it('the right token is accepted, with any case of "Bearer"', async () => {
    expect((await server.get('/api/state')).status).toBe(200);
    const lower = await server.get('/api/state', {
      token: null,
      headers: { Authorization: 'bearer test-token' },
    });
    expect(lower.status).toBe(200);
  });

  it('an unknown /api route with a token is 404 not_found', async () => {
    const res = await server.get('/api/no-such-route');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(res.json).error.code).toBe('not_found');
  });

  it('a body over 1 MB is rejected with 413', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const res = await server.request('POST', '/api/ops', {
      rawBody: big,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(apiErrorSchema.parse(res.json).error.code).toBe('validation_failed');
  });

  it('a large body under 1 MB is accepted', async () => {
    const ops = Array.from({ length: 150 }, () =>
      op.settings(makeSettings({ timezone: 'UTC', updatedAt: '2026-09-01T00:00:00.000Z' })),
    );
    const padded = JSON.stringify({ ops, pad: 'y'.repeat(500_000) });
    const res = await server.request('POST', '/api/ops', {
      rawBody: padded,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });
});

describe('with AUTH_TOKEN empty', () => {
  const server = useTestServer({ AUTH_TOKEN: '' });

  it('rejects every request, even one with an empty bearer token', async () => {
    expect((await server.get('/api/state', { token: null })).status).toBe(401);
    expect((await server.get('/api/state', { token: '' })).status).toBe(401);
    expect((await server.get('/api/state', { token: 'anything' })).status).toBe(401);
    expect(
      (await server.post('/api/ops', { ops: [{ opId: uuidv7() }] }, { token: 'x' })).status,
    ).toBe(401);
  });

  it('still serves /api/health', async () => {
    expect((await server.get('/api/health', { token: null })).status).toBe(200);
  });
});
