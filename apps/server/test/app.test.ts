import { describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema } from '@time-tracker/shared';
import { app, type Env } from '../src/app';

const env = {
  ASSETS: {
    fetch: () => Promise.resolve(new Response('<html>pwa</html>', { status: 200 })),
  },
} as unknown as Env;

describe('app', () => {
  it('GET /api/health returns ok and an ISO time', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
  });

  it('unknown /api route returns the not_found error shape', async () => {
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('non-/api paths are served by the ASSETS binding', async () => {
    const res = await app.request('/some/page', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>pwa</html>');
  });
});
