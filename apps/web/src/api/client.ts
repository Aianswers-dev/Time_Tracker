import { apiErrorSchema, type ErrorCode } from '@time-tracker/shared';
import { db } from '../db';

/**
 * The one way the app talks to the server. Every request is same-origin
 * (`/api/...`; Vite proxies it in development) and carries the bearer token
 * stored in Dexie `meta`. Failures always surface as `ApiError`, so callers
 * can tell "offline, try later" from "the server said no".
 */

export const TOKEN_KEY = 'token';

export async function getToken(): Promise<string | null> {
  const row = await db.meta.get(TOKEN_KEY);
  const token = row?.value.trim() ?? '';
  return token === '' ? null : token;
}

export async function setToken(token: string): Promise<void> {
  await db.meta.put({ key: TOKEN_KEY, value: token.trim() });
}

export async function clearToken(): Promise<void> {
  await db.meta.delete(TOKEN_KEY);
}

/**
 * - `network`: the request never got an answer (offline, DNS, timeout). Retry later.
 * - `bad_response`: the server answered with something that does not match the contract.
 * - `not_connected`: there is no token yet; sync is off.
 * - anything else: the server's error code from docs/04-api.md.
 */
export type ApiErrorCode = ErrorCode | 'network' | 'bad_response' | 'not_connected';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when retrying later may succeed: no answer, or a 5xx. */
  get retryable(): boolean {
    return this.code === 'network' || this.status >= 500;
  }
}

/** Anything with zod's `parse`, so this module does not depend on zod directly. */
export interface Parser<T> {
  parse(data: unknown): T;
}

export interface ApiRequest<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON-serialisable request body. */
  body?: unknown;
  /** Validates the 2xx response body. Omit for responses with no body (204). */
  schema?: Parser<T>;
  /** Use this token instead of the stored one, e.g. to test a token before saving it. */
  token?: string;
  signal?: AbortSignal;
}

export async function apiFetch<T = void>(path: string, req: ApiRequest<T> = {}): Promise<T> {
  const token = req.token ?? (await getToken());
  if (!token) throw new ApiError(0, 'not_connected', 'Not connected to your server yet');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: req.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', "Can't reach the server");
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
    }
    throw new ApiError(
      res.status,
      res.status >= 500 ? 'internal' : 'bad_response',
      `HTTP ${res.status}`,
    );
  }

  if (!req.schema) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The server sent something unexpected');
  }
  try {
    return req.schema.parse(data);
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The server sent something unexpected');
  }
}
