import { Hono } from 'hono';
import type { ApiError, HealthResponse } from '@time-tracker/shared';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_TOKEN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => {
  const body: HealthResponse = { ok: true, time: new Date().toISOString() };
  return c.json(body);
});

app.all('/api/*', (c) => {
  const body: ApiError = { error: { code: 'not_found', message: 'Route not found' } };
  return c.json(body, 404);
});

// Anything that is not an API route is the PWA (static assets, SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', message: err.message }));
  const body: ApiError = { error: { code: 'internal', message: 'Internal server error' } };
  return c.json(body, 500);
});
