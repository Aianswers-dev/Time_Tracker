import {
  switchCategory,
  toIso,
  toMs,
  uuidv7,
  type Category,
  type Op,
  type OpResult,
  type Rule,
  type Segment,
  type Settings,
  type SnapshotResponse,
} from '@time-tracker/shared';
import { vi } from 'vitest';

/**
 * Test helper, not imported by the app: a stand-in for the Worker behind a
 * mocked `fetch`. It keeps rows in memory with a `syncedAt` like the real
 * server, applies ops the same way in spirit (a switch runs the shared
 * `switchCategory`), answers at most `maxApplied` ops per request and
 * returns the 10 s overlap on `since` pulls.
 */

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

interface Stored<T> {
  row: T;
  syncedAt: number;
}

export interface FakeServer {
  token: string;
  calls: Call[];
  maxApplied: number;
  /** Most requests ever in flight at once. */
  maxInFlight: number;
  categories: Map<string, Stored<Category>>;
  segments: Map<string, Stored<Segment>>;
  rules: Map<string, Stored<Rule>>;
  settings: Stored<Settings> | null;
  /** Return a result to override the default for one op, or undefined to apply it. */
  failOp: (op: Op) => OpResult['error'] | undefined;
  /** Replace the whole response for a request, or return undefined for the default. */
  intercept: (call: Call) => Response | Promise<Response> | undefined;
  /** Runs while a snapshot request is in flight, before it answers. */
  duringSnapshot: (() => Promise<void>) | null;
  opsBodies: () => Op[][];
  snapshotCalls: () => Call[];
  put: (rows: { categories?: Category[]; segments?: Segment[]; rules?: Rule[] }) => void;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export function fakeServer(token = 'secret'): FakeServer {
  let inFlight = 0;
  const server: FakeServer = {
    token,
    calls: [],
    maxApplied: 15,
    maxInFlight: 0,
    categories: new Map(),
    segments: new Map(),
    rules: new Map(),
    settings: null,
    failOp: () => undefined,
    intercept: () => undefined,
    duringSnapshot: null,
    opsBodies: () =>
      server.calls.filter((c) => c.path === '/api/ops').map((c) => (c.body as { ops: Op[] }).ops),
    snapshotCalls: () => server.calls.filter((c) => c.path.startsWith('/api/snapshot')),
    put: ({ categories = [], segments = [], rules = [] }) => {
      const at = Date.now();
      for (const r of categories) server.categories.set(r.id, { row: r, syncedAt: at });
      for (const r of segments) server.segments.set(r.id, { row: r, syncedAt: at });
      for (const r of rules) server.rules.set(r.id, { row: r, syncedAt: at });
    },
  };

  /** Last-write-wins, as on the real server. */
  function wins(
    incoming: { updatedAt: string },
    stored: Stored<{ updatedAt: string }> | undefined,
  ) {
    return !stored || incoming.updatedAt >= stored.row.updatedAt;
  }

  function apply(op: Op): void {
    const now = Date.now();
    switch (op.type) {
      case 'switch': {
        if (server.segments.has(op.payload.newSegmentId)) return;
        const live = [...server.segments.values()]
          .map((s) => s.row)
          .filter((s) => s.deletedAt === null);
        const result = switchCategory(
          live,
          {
            categoryId: op.payload.categoryId,
            at: op.payload.at,
            newSegmentId: op.payload.newSegmentId,
            source: op.payload.source,
          },
          { now: toIso(now), newId: () => uuidv7() },
        );
        server.put({ segments: result.rows });
        return;
      }
      case 'segments.upsert':
        server.put({ segments: op.payload.rows.filter((r) => wins(r, server.segments.get(r.id))) });
        return;
      case 'category.upsert':
        if (wins(op.payload, server.categories.get(op.payload.id))) {
          server.put({ categories: [op.payload] });
        }
        return;
      case 'rule.upsert':
        if (wins(op.payload, server.rules.get(op.payload.id))) server.put({ rules: [op.payload] });
        return;
      case 'settings.upsert':
        if (wins(op.payload, server.settings ?? undefined)) {
          server.settings = { row: op.payload, syncedAt: now };
        }
        return;
    }
  }

  async function handle(call: Call): Promise<Response> {
    if (call.auth !== `Bearer ${server.token}`) {
      return apiError(401, 'unauthorized', 'Missing or invalid token');
    }
    const custom = server.intercept(call);
    if (custom) return custom;

    if (call.path === '/api/ops' && call.method === 'POST') {
      const ops = (call.body as { ops: Op[] }).ops;
      const results: OpResult[] = [];
      for (const op of ops.slice(0, server.maxApplied)) {
        const error = server.failOp(op);
        if (error) {
          results.push({ opId: op.opId, ok: false, error });
          continue;
        }
        apply(op);
        results.push({ opId: op.opId, ok: true });
      }
      return json(200, { results, serverTime: toIso(Date.now()) });
    }

    if (call.path.startsWith('/api/snapshot')) {
      const serverTime = toIso(Date.now());
      if (server.duringSnapshot) await server.duringSnapshot();
      const since = new URL(call.path, 'http://x').searchParams.get('since');
      const after = since === null ? -Infinity : toMs(since) - 10_000;
      const pick = <T>(m: Map<string, Stored<T>>) =>
        [...m.values()].filter((s) => s.syncedAt > after).map((s) => s.row);
      const body: SnapshotResponse = {
        serverTime,
        categories: pick(server.categories),
        segments: pick(server.segments),
        rules: pick(server.rules),
        settings: server.settings && server.settings.syncedAt > after ? server.settings.row : null,
      };
      return json(200, body);
    }

    if (call.path === '/api/settings') {
      return server.settings
        ? json(200, server.settings.row)
        : json(200, {
            id: 'singleton',
            timezone: 'UTC',
            dayStartHour: 4,
            staleEnabled: true,
            staleAfterMin: 300,
            staleRepeatMin: 60,
            staleQuietStart: null,
            staleQuietEnd: null,
            updatedAt: '2000-01-01T00:00:00.000Z',
          });
    }
    return apiError(404, 'not_found', 'Route not found');
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        method: init.method ?? 'GET',
        path: input,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        auth: headers.Authorization ?? null,
      };
      server.calls.push(call);
      inFlight += 1;
      server.maxInFlight = Math.max(server.maxInFlight, inFlight);
      try {
        // A real request never answers synchronously.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        return await handle(call);
      } finally {
        inFlight -= 1;
      }
    }),
  );
  return server;
}
