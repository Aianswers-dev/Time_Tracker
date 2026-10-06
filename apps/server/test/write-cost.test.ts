import { uuidv7, type Op } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { applyOps, MAX_SEGMENT_ROWS_PER_REQUEST } from '../src/sync/ops';
import { makeCategory, makeSegment, op } from './harness';

/**
 * CPU per request. The Workers Free plan allows 10 ms of CPU per request,
 * and Drizzle takes about 150 µs to build one segment upsert, so a single
 * 100-row `segments.upsert` op (the full upload of a phone's history sends
 * nothing else) cost 15 to 25 ms before any D1 work, and a request of 15 such
 * ops over 200 ms: every retry would fail the same way and the outbox would
 * never drain. These run the op processor against a D1 stand-in that answers
 * instantly, so only the Worker's own work is timed.
 */

const category = makeCategory();
const categoryRow = {
  id: category.id,
  name: category.name,
  color: category.color,
  icon: category.icon,
  sort_order: category.sortOrder,
  exempt_from_stale_check: 0,
  archived_at: null,
  created_at: category.createdAt,
  updated_at: category.updatedAt,
  deleted_at: null,
  synced_at: category.updatedAt,
};

/** Every statement answers with no rows, except reads of categories. */
function instantD1(): D1Database {
  const statement = (sql: string): D1PreparedStatement => {
    const self = {
      sql,
      bind: () => self,
      raw: () => Promise.resolve([]),
      all: () => Promise.resolve({ results: [], success: true, meta: {} }),
      run: () => Promise.resolve({ results: [], success: true, meta: {} }),
      first: () => Promise.resolve(null),
    };
    return self as unknown as D1PreparedStatement;
  };
  return {
    prepare: statement,
    batch: (stmts: Array<{ sql: string }>) =>
      Promise.resolve(
        stmts.map((s) => ({
          results: /from "categories"/.test(s.sql) ? [categoryRow] : [],
          success: true,
          meta: {},
        })),
      ),
  } as unknown as D1Database;
}

const START = Date.parse('2025-10-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;

function bulkOp(k: number, rows = 100): Op {
  return op.segments(
    Array.from({ length: rows }, (_, i) => {
      const start = START + (k * rows + i) * HOUR_MS;
      return makeSegment(
        category.id,
        new Date(start).toISOString(),
        new Date(start + HOUR_MS).toISOString(),
      );
    }),
  );
}

/** The fastest of a few runs of the whole request body: parse, validate, apply, answer. */
async function bestMs(body: string): Promise<{ ms: number; results: number }> {
  let best = Number.POSITIVE_INFINITY;
  let results = 0;
  for (let run = 0; run < 6; run++) {
    const db = createDb(instantD1());
    const t = performance.now();
    const { ops } = JSON.parse(body) as { ops: Array<{ opId: string }> };
    const out = await applyOps(db, ops, () => new Date().toISOString());
    JSON.stringify({ results: out });
    best = Math.min(best, performance.now() - t);
    results = out.length;
  }
  return { ms: best, results };
}

describe('CPU per /api/ops request', () => {
  it('one 100-row segments.upsert op stays under 10 ms', async () => {
    const { ms, results } = await bestMs(JSON.stringify({ ops: [bulkOp(0)] }));
    expect(results).toBe(1);
    // Drizzle alone took 15 to 35 ms here; now it is a few.
    expect(ms).toBeLessThan(10);
  });

  it('a request full of bulk ops applies only a bounded number of rows', async () => {
    // What the client sends after halving a 50-op batch that was over 1 MB.
    const body = JSON.stringify({ ops: Array.from({ length: 25 }, (_, k) => bulkOp(k)) });
    const { ms, results } = await bestMs(body);
    expect(results).toBe(Math.floor(MAX_SEGMENT_ROWS_PER_REQUEST / 100));
    // It applied 15 ops (1,500 rows) in 200 to 350 ms here before.
    expect(ms).toBeLessThan(15);
  });

  it('always applies the first op, however many rows it has', async () => {
    const body = JSON.stringify({ ops: [bulkOp(0, 100), bulkOp(1, 1)] });
    expect((await bestMs(body)).results).toBeGreaterThanOrEqual(1);
  });

  it('fifteen switch ops stay cheap', async () => {
    const ops = Array.from({ length: 15 }, (_, i) =>
      op.switch({
        categoryId: i % 2 === 0 ? category.id : uuidv7(),
        at: new Date(Date.now() - (15 - i) * 60_000).toISOString(),
        newSegmentId: uuidv7(),
        source: 'app',
      }),
    );
    const { ms, results } = await bestMs(JSON.stringify({ ops }));
    expect(results).toBe(15);
    expect(ms).toBeLessThan(15);
  });
});
