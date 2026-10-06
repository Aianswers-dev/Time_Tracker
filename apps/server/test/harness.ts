import {
  SETTINGS_ID,
  uuidv7,
  type Category,
  type Op,
  type Rule,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createTestHarness } from 'wrangler';
import { createDb, type Db } from '../src/db/client';
import {
  categoryFromRow,
  categoryToRow,
  ruleToRow,
  segmentFromRow,
  segmentToRow,
  settingsToRow,
} from '../src/db/mapping';
import { categories, rules, segments, settings } from '../src/db/schema';

/**
 * Test harness: the real Worker (src/index.ts bundled by wrangler) running in
 * workerd with an in-memory local D1. The migrations in `drizzle/` are applied
 * the same way `wrangler d1 migrations apply` does, then every table is
 * emptied before each test.
 */

export const TOKEN = 'test-token';

export interface Reply {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
  /** The body parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
}

export interface RequestOptions {
  /** Bearer token to send. Default TOKEN; null sends no Authorization header. */
  token?: string | null;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as is. */
  rawBody?: string;
}

const TABLES = [
  'notification_log',
  'push_subscriptions',
  'server_config',
  'segments',
  'rules',
  'settings',
  'categories',
] as const;

export function useTestServer(secrets: Record<string, string> = { AUTH_TOKEN: TOKEN }) {
  const server = createTestHarness({
    workers: [{ configPath: new URL('../wrangler.toml', import.meta.url), secrets }],
  });
  let d1: D1Database | undefined;

  beforeAll(async () => {
    await server.listen();
    const worker = server.getWorker<{ DB: D1Database }>();
    await worker.applyD1Migrations('DB');
    d1 = (await worker.getEnv()).DB;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    const raw = rawDb();
    await raw.batch(TABLES.map((t) => raw.prepare(`DELETE FROM ${t}`)));
  });

  function rawDb(): D1Database {
    if (!d1) throw new Error('Test server is not running');
    return d1;
  }

  async function request(method: string, path: string, opts: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await server.fetch(path, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  return {
    rawDb,
    /** Drizzle over the test database, for seeding and assertions. */
    db: (): Db => createDb(rawDb()),
    /** The Worker, for dispatching events other than fetch (e.g. `scheduled`). */
    worker: () => server.getWorker(),
    /** Runtime log lines (console output) since the server started or `clearLogs`. */
    logs: () => server.getLogs(),
    clearLogs: () => server.clearLogs(),
    request,
    get: (path: string, opts?: RequestOptions) => request('GET', path, opts),
    post: (path: string, body: unknown, opts?: RequestOptions) =>
      request('POST', path, { ...opts, body }),
    ops: (ops: unknown[], opts?: RequestOptions) =>
      request('POST', '/api/ops', { ...opts, body: { ops } }),
  };
}

export type TestServer = ReturnType<typeof useTestServer>;

// ---------------------------------------------------------------------------
// Time

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function ago(ms: number): string {
  return iso(Date.now() - ms);
}

/** A fixed timestamp well in the past, for rows whose times do not matter. */
export const T0 = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Entities

let seq = 0;

export function makeCategory(overrides: Partial<Category> = {}): Category {
  seq += 1;
  return {
    id: uuidv7(),
    name: `Category ${seq}`,
    color: '#5b5bd6',
    icon: 'moon',
    sortOrder: seq,
    exemptFromStaleCheck: false,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

export function makeSegment(
  categoryId: string,
  startedAt: string,
  endedAt: string | null,
  overrides: Partial<Segment> = {},
): Segment {
  return {
    id: uuidv7(),
    categoryId,
    startedAt,
    endedAt,
    note: null,
    source: 'app',
    createdAt: startedAt,
    updatedAt: endedAt ?? startedAt,
    deletedAt: null,
    ...overrides,
  };
}

export function makeRule(categoryId: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id: uuidv7(),
    categoryId,
    kind: 'session',
    thresholdMin: 60,
    repeatEveryMin: 30,
    quietStart: null,
    quietEnd: null,
    message: null,
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: SETTINGS_ID,
    timezone: 'UTC',
    dayStartHour: 4,
    staleEnabled: true,
    staleAfterMin: 300,
    staleRepeatMin: 60,
    staleQuietStart: null,
    staleQuietEnd: null,
    updatedAt: T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ops

function opOf<T extends Op['type']>(type: T, payload: Extract<Op, { type: T }>['payload']) {
  return { opId: uuidv7(), type, payload, createdAt: new Date().toISOString() };
}

export const op = {
  switch: (payload: Extract<Op, { type: 'switch' }>['payload']) => opOf('switch', payload),
  segments: (rows: Segment[]) => opOf('segments.upsert', { rows }),
  category: (c: Category) => opOf('category.upsert', c),
  rule: (r: Rule) => opOf('rule.upsert', r),
  settings: (s: Settings) => opOf('settings.upsert', s),
};

// ---------------------------------------------------------------------------
// Direct database access

export async function insertCategories(db: Db, rows: Category[], syncedAt = T0): Promise<void> {
  for (const c of rows) await db.insert(categories).values(categoryToRow(c, syncedAt));
}

export async function insertSegments(db: Db, rows: Segment[], syncedAt = T0): Promise<void> {
  for (const s of rows) await db.insert(segments).values(segmentToRow(s, syncedAt));
}

export async function insertRules(db: Db, rows: Rule[], syncedAt = T0): Promise<void> {
  for (const r of rows) await db.insert(rules).values(ruleToRow(r, syncedAt));
}

export async function insertSettings(db: Db, s: Settings, syncedAt = T0): Promise<void> {
  await db.insert(settings).values(settingsToRow(s, syncedAt));
}

/** Every segment row, deleted ones included, with its synced_at. */
export async function allSegments(db: Db): Promise<Array<Segment & { syncedAt: string }>> {
  const rows = await db.select().from(segments);
  return rows.map((r) => ({ ...segmentFromRow(r), syncedAt: r.syncedAt }));
}

export async function segmentRow(
  db: Db,
  id: string,
): Promise<(Segment & { syncedAt: string }) | null> {
  return (await allSegments(db)).find((s) => s.id === id) ?? null;
}

export async function categoryRow(db: Db, id: string): Promise<Category | null> {
  const rows = await db.select().from(categories);
  const row = rows.find((r) => r.id === id);
  return row ? categoryFromRow(row) : null;
}

/** Live segments sorted by start, as [categoryId, startedAt, endedAt] for compact assertions. */
export async function timeline(db: Db): Promise<Array<[string, string, string | null]>> {
  return (await allSegments(db))
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((s) => [s.categoryId, s.startedAt, s.endedAt]);
}

/**
 * Wrap a D1 binding to count calls that reach D1: each executed statement and
 * each batch. This is what the Workers Free limit of 50 D1 queries per
 * request counts.
 */
export function countingD1(inner: D1Database): { d1: D1Database; calls: () => number } {
  let calls = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const wrapper = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      all: () => (calls++, stmt.all()),
      run: () => (calls++, stmt.run()),
      first: (column?: string) => (
        calls++,
        column === undefined ? stmt.first() : stmt.first(column)
      ),
      raw: (options?: { columnNames?: boolean }) => (calls++, stmt.raw(options as never)),
    };
    real.set(wrapper, stmt);
    return wrapper as unknown as D1PreparedStatement;
  };
  const d1 = {
    prepare: (query: string) => wrap(inner.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => {
      calls++;
      return inner.batch(statements.map((s) => real.get(s) ?? s));
    },
    exec: (query: string) => (calls++, inner.exec(query)),
  } as unknown as D1Database;
  return { d1, calls: () => calls };
}
