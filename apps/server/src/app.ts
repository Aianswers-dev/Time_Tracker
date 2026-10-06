import type { HealthResponse } from '@time-tracker/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from './auth';
import type { AppEnv } from './env';
import { ApiException, errorResponse } from './http';
import { exportRoutes } from './routes/export';
import { pushRoutes } from './routes/push';
import { readRoutes } from './routes/reads';
import { stateRoutes } from './routes/state';
import { switchRoutes } from './routes/switch';
import { syncRoutes } from './routes/sync';

export type { Env } from './env';

/** Request bodies above this are rejected with 413 (docs/02 Security). */
export const MAX_BODY_BYTES = 1024 * 1024;

export const app = new Hono<AppEnv>();

// The only route without a token. Registered before the auth middleware.
app.get('/api/health', (c) => {
  const body: HealthResponse = { ok: true, time: new Date().toISOString() };
  return c.json(body);
});

app.use('/api/*', requireAuth());
app.use(
  '/api/*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => errorResponse(c, 413, 'validation_failed', 'Request body is larger than 1 MB'),
  }),
);

app.route('/api', stateRoutes);
app.route('/api', switchRoutes);
app.route('/api', syncRoutes);
app.route('/api', readRoutes);
app.route('/api', exportRoutes);
app.route('/api', pushRoutes);

app.all('/api/*', (c) => errorResponse(c, 404, 'not_found', 'Route not found'));

// Anything that is not an API route is the PWA (static assets, SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  if (err instanceof ApiException) return c.json(err.toBody(), err.status);
  if (err instanceof HTTPException) {
    const code = err.status === 401 ? 'unauthorized' : 'validation_failed';
    return errorResponse(c, err.status, code, err.message || 'Bad request');
  }
  console.error(
    JSON.stringify({ level: 'error', message: err.message, path: c.req.path, stack: err.stack }),
  );
  return errorResponse(c, 500, 'internal', 'Internal server error');
});
