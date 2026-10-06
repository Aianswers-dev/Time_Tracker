import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './env';
import { errorResponse } from './http';

const encoder = new TextEncoder();

/**
 * Compare two strings over their UTF-8 bytes in time that depends only on the
 * longer length, never on where they first differ. Plain JavaScript so it runs
 * the same in workerd and Node.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const length = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < length; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Require `Authorization: Bearer <AUTH_TOKEN>`. An unset or empty AUTH_TOKEN
 * rejects everything, so a deploy that forgot the secret is closed, not open.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const expected = c.env.AUTH_TOKEN ?? '';
    const given = bearerToken(c.req.header('Authorization'));
    if (expected === '') {
      console.error(JSON.stringify({ level: 'error', message: 'AUTH_TOKEN is not set' }));
    }
    if (expected === '' || given === null || !timingSafeEqual(given, expected)) {
      c.header('WWW-Authenticate', 'Bearer');
      return errorResponse(c, 401, 'unauthorized', 'Missing or invalid token');
    }
    await next();
  };
}
