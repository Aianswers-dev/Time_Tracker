import { opsResponseSchema, uuidv7, type Op } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { applyOp, MAX_D1_CALLS_PER_OP, MAX_OPS_APPLIED_PER_REQUEST } from '../src/sync/ops';
import {
  HOUR,
  MIN,
  ago,
  allSegments,
  insertCategories,
  insertSegments,
  iso,
  makeCategory,
  makeRule,
  makeSegment,
  makeSettings,
  op,
  useTestServer,
} from './harness';

const server = useTestServer();

/**
 * Wrap a D1 binding to count calls that reach D1: each executed statement and
 * each batch. This is what the Workers Free limit of 50 D1 queries per
 * request counts.
 */
function countingD1(inner: D1Database): { d1: D1Database; calls: () => number } {
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

async function callsFor(o: Op): Promise<number> {
  const { d1, calls } = countingD1(server.rawDb());
  await applyOp(createDb(d1), o, new Date().toISOString());
  return calls();
}

describe('D1 calls per op', () => {
  it(`every op type makes at most ${MAX_D1_CALLS_PER_OP} calls`, async () => {
    const [a, b] = [makeCategory(), makeCategory()];
    await insertCategories(server.db(), [a, b]);
    await insertSegments(server.db(), [
      makeSegment(a.id, ago(5 * HOUR), ago(4 * HOUR)),
      makeSegment(b.id, ago(4 * HOUR), ago(3 * HOUR)),
      makeSegment(a.id, ago(3 * HOUR), null),
    ]);
    // A backdated switch that trims and deletes several segments.
    const sw = op.switch({
      categoryId: b.id,
      at: ago(270 * MIN),
      newSegmentId: uuidv7(),
      source: 'app',
    });
    expect(await callsFor(sw)).toBeLessThanOrEqual(2);
    // Its replay.
    expect(await callsFor(sw)).toBe(1);

    // 100 five-minute segments, one every ten minutes on a past day.
    const dayStart = Date.parse('2026-01-01T00:00:00.000Z');
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeSegment(a.id, iso(dayStart + i * 10 * MIN), iso(dayStart + i * 10 * MIN + 5 * MIN)),
    );
    expect(await callsFor(op.segments(rows))).toBeLessThanOrEqual(MAX_D1_CALLS_PER_OP);
    expect((await allSegments(server.db())).length).toBeGreaterThanOrEqual(100);

    expect(
      await callsFor(op.category({ ...a, name: 'Renamed', updatedAt: ago(0) })),
    ).toBeLessThanOrEqual(2);
    expect(await callsFor(op.rule(makeRule(a.id)))).toBeLessThanOrEqual(2);
    expect(await callsFor(op.settings(makeSettings({ updatedAt: ago(0) })))).toBeLessThanOrEqual(2);
  });
});

describe('ops per request', () => {
  it(`applies at most ${MAX_OPS_APPLIED_PER_REQUEST} ops and leaves the rest unanswered`, async () => {
    const cats = Array.from({ length: MAX_OPS_APPLIED_PER_REQUEST + 5 }, () => makeCategory());
    const ops = cats.map((c) => op.category(c));
    const first = opsResponseSchema.parse((await server.ops(ops)).json);
    expect(first.results).toHaveLength(MAX_OPS_APPLIED_PER_REQUEST);
    expect(first.results.map((r) => r.opId)).toEqual(
      ops.slice(0, MAX_OPS_APPLIED_PER_REQUEST).map((o) => o.opId),
    );
    expect(first.results.every((r) => r.ok)).toBe(true);
    expect(((await server.get('/api/categories')).json as unknown[]).length).toBe(
      MAX_OPS_APPLIED_PER_REQUEST,
    );

    // The client sends the unanswered rest again.
    const rest = ops.slice(first.results.length);
    const second = opsResponseSchema.parse((await server.ops(rest)).json);
    expect(second.results.map((r) => r.opId)).toEqual(rest.map((o) => o.opId));
    expect(((await server.get('/api/categories')).json as unknown[]).length).toBe(cats.length);
  });

  it('malformed ops cost nothing and still get their result', async () => {
    const bad = Array.from({ length: 30 }, () => ({ opId: uuidv7(), type: 'nope' }));
    const good = op.settings(makeSettings({ updatedAt: ago(0) }));
    const body = opsResponseSchema.parse((await server.ops([...bad, good])).json);
    expect(body.results).toHaveLength(31);
    expect(body.results.at(-1)).toEqual({ opId: good.opId, ok: true });
  });
});

describe('database constraints', () => {
  it('segments_one_open rejects a second live open segment at the database level', async () => {
    const cat = makeCategory();
    await insertCategories(server.db(), [cat]);
    await insertSegments(server.db(), [makeSegment(cat.id, ago(2 * HOUR), null)]);
    await expect(
      insertSegments(server.db(), [makeSegment(cat.id, ago(HOUR), null)]),
    ).rejects.toThrow();
    // A deleted open row and closed rows are not constrained.
    await insertSegments(server.db(), [
      makeSegment(cat.id, ago(HOUR), null, { deletedAt: ago(0) }),
      makeSegment(cat.id, ago(5 * HOUR), ago(4 * HOUR)),
    ]);
    expect(await allSegments(server.db())).toHaveLength(3);
  });

  it('foreign keys are enforced: a segment needs an existing category', async () => {
    await expect(
      insertSegments(server.db(), [makeSegment(uuidv7(), ago(2 * HOUR), ago(HOUR))]),
    ).rejects.toThrow();
  });
});
