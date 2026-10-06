import { opsResponseSchema, uuidv7, type OpsResponse } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MIN,
  T0,
  ago,
  allSegments,
  categoryRow,
  insertCategories,
  insertSegments,
  insertSettings,
  iso,
  makeCategory,
  makeRule,
  makeSegment,
  makeSettings,
  op,
  segmentRow,
  timeline,
  useTestServer,
  type Reply,
} from './harness';

const server = useTestServer();

function results(reply: Reply): OpsResponse['results'] {
  expect(reply.status).toBe(200);
  return opsResponseSchema.parse(reply.json).results;
}

/** Send one op and return its result. */
async function one(o: unknown) {
  const [result] = results(await server.ops([o]));
  return result;
}

async function seedCategories(n: number) {
  const cats = Array.from({ length: n }, () => makeCategory());
  await insertCategories(server.db(), cats);
  return cats;
}

describe('POST /api/ops envelope', () => {
  it('answers one result per op, in order, with the server time', async () => {
    const [a] = await seedCategories(1);
    const before = Date.now();
    const o1 = op.category({ ...a!, name: 'Renamed', updatedAt: ago(0) });
    const o2 = op.settings(makeSettings({ updatedAt: ago(0) }));
    const reply = await server.ops([o1, o2]);
    const body = opsResponseSchema.parse(reply.json);
    expect(body.results).toEqual([
      { opId: o1.opId, ok: true },
      { opId: o2.opId, ok: true },
    ]);
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before);
  });

  it('a failed op does not stop the ops after it', async () => {
    const [a, b] = await seedCategories(2);
    await insertSegments(server.db(), [makeSegment(a!.id, ago(HOUR), null)]);
    const bad = op.switch({ categoryId: a!.id, at: ago(0), newSegmentId: uuidv7(), source: 'app' });
    const good = op.switch({
      categoryId: b!.id,
      at: ago(0),
      newSegmentId: uuidv7(),
      source: 'app',
    });
    const [r1, r2] = results(await server.ops([bad, good]));
    expect(r1).toMatchObject({ opId: bad.opId, ok: false, error: { code: 'conflict' } });
    expect(r2).toEqual({ opId: good.opId, ok: true });
    expect((await timeline(server.db())).at(-1)?.[0]).toBe(b!.id);
  });

  it('a malformed op fails alone with validation_failed', async () => {
    const [a] = await seedCategories(1);
    const malformed = {
      opId: uuidv7(),
      type: 'switch',
      payload: { categoryId: 'nope' },
      createdAt: ago(0),
    };
    const good = op.category({ ...a!, name: 'Still applied', updatedAt: ago(0) });
    const [r1, r2] = results(await server.ops([malformed, good]));
    expect(r1).toMatchObject({
      opId: malformed.opId,
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(r1?.error?.message).toMatch(/payload/);
    expect(r2).toEqual({ opId: good.opId, ok: true });
    expect((await categoryRow(server.db(), a!.id))?.name).toBe('Still applied');
  });
});

describe('switch op', () => {
  it('opens a segment at `at` and closes the open one there', async () => {
    const [a, b] = await seedCategories(2);
    const s1 = uuidv7();
    const s2 = uuidv7();
    const at1 = ago(20 * MIN);
    const at2 = ago(5 * MIN);
    const start = Date.now();
    expect(
      await one(op.switch({ categoryId: a!.id, at: at1, newSegmentId: s1, source: 'app' })),
    ).toMatchObject({ ok: true });
    expect(
      await one(op.switch({ categoryId: b!.id, at: at2, newSegmentId: s2, source: 'app' })),
    ).toMatchObject({ ok: true });

    expect(await timeline(server.db())).toEqual([
      [a!.id, at1, at2],
      [b!.id, at2, null],
    ]);
    const opened = await segmentRow(server.db(), s2);
    expect(opened).toMatchObject({ source: 'app', note: null, deletedAt: null });
    // Rows the server computes carry the server's time, and synced_at is set on every write.
    expect(Date.parse(opened!.updatedAt)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(opened!.syncedAt)).toBeGreaterThanOrEqual(start);
    expect(Date.parse((await segmentRow(server.db(), s1))!.syncedAt)).toBeGreaterThanOrEqual(start);
  });

  it('a replayed switch (same newSegmentId) is ok and changes nothing', async () => {
    const [a, b] = await seedCategories(2);
    const s1 = uuidv7();
    const o = op.switch({ categoryId: a!.id, at: ago(10 * MIN), newSegmentId: s1, source: 'app' });
    expect(await one(o)).toEqual({ opId: o.opId, ok: true });
    await one(
      op.switch({ categoryId: b!.id, at: ago(5 * MIN), newSegmentId: uuidv7(), source: 'app' }),
    );
    const before = await allSegments(server.db());

    // The same op again (a retry after a timeout), and the same switch under a new opId.
    expect(await one(o)).toEqual({ opId: o.opId, ok: true });
    expect(await one({ ...o, opId: uuidv7() })).toMatchObject({ ok: true });
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('same category as the open segment under a different id is a conflict, nothing written', async () => {
    const [a] = await seedCategories(1);
    await insertSegments(server.db(), [makeSegment(a!.id, ago(HOUR), null)]);
    const before = await allSegments(server.db());
    const r = await one(
      op.switch({ categoryId: a!.id, at: ago(MIN), newSegmentId: uuidv7(), source: 'app' }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('an offline switch lands after a Shortcut switch, using the shared switch semantics', async () => {
    const [w, x, y] = await seedCategories(3);
    const wStart = ago(60 * MIN);
    await insertSegments(server.db(), [makeSegment(w!.id, wStart, null)]);

    // The phone goes offline and switches to Y 30 minutes ago. Meanwhile a
    // Shortcut switches the server to X just now.
    const shortcut = await server.post('/api/switch', { categoryName: x!.name });
    expect(shortcut.status).toBe(200);

    const yAt = ago(30 * MIN);
    const yId = uuidv7();
    const r = await one(
      op.switch({ categoryId: y!.id, at: yAt, newSegmentId: yId, source: 'app' }),
    );
    expect(r).toMatchObject({ ok: true });

    // switchCategory clears [yAt, ∞): W is trimmed to end at yAt, the later X
    // segment is removed, and Y is open from yAt.
    expect(await timeline(server.db())).toEqual([
      [w!.id, wStart, yAt],
      [y!.id, yAt, null],
    ]);
    const xRows = (await allSegments(server.db())).filter((s) => s.categoryId === x!.id);
    expect(xRows).toHaveLength(1);
    expect(xRows[0]?.deletedAt).not.toBeNull();
    expect(xRows[0]?.source).toBe('shortcut');
  });

  it('a backdated switch trims what came after `at`', async () => {
    const [a, b, c] = await seedCategories(3);
    const t0 = ago(3 * HOUR);
    const t1 = ago(2 * HOUR);
    await insertSegments(server.db(), [makeSegment(a!.id, t0, t1), makeSegment(b!.id, t1, null)]);
    const at = ago(150 * MIN);
    expect(
      await one(op.switch({ categoryId: c!.id, at, newSegmentId: uuidv7(), source: 'app' })),
    ).toMatchObject({ ok: true });
    expect(await timeline(server.db())).toEqual([
      [a!.id, t0, at],
      [c!.id, at, null],
    ]);
  });

  it('`at` more than 60 s ahead is switch_in_future', async () => {
    const [a] = await seedCategories(1);
    const r = await one(
      op.switch({
        categoryId: a!.id,
        at: iso(Date.now() + 5 * MIN),
        newSegmentId: uuidv7(),
        source: 'app',
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'switch_in_future' } });
    expect(await allSegments(server.db())).toEqual([]);
  });

  it('`at` a few seconds ahead is clamped to now', async () => {
    const [a] = await seedCategories(1);
    const id = uuidv7();
    const before = Date.now();
    expect(
      await one(
        op.switch({
          categoryId: a!.id,
          at: iso(Date.now() + 30_000),
          newSegmentId: id,
          source: 'app',
        }),
      ),
    ).toMatchObject({ ok: true });
    const row = await segmentRow(server.db(), id);
    expect(Date.parse(row!.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row!.startedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('an unknown or deleted category is validation_failed', async () => {
    const [gone] = await seedCategories(1);
    const missing = await one(
      op.switch({ categoryId: uuidv7(), at: ago(0), newSegmentId: uuidv7(), source: 'app' }),
    );
    expect(missing).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    await one(op.category({ ...gone!, deletedAt: ago(0), updatedAt: ago(0) }));
    const deleted = await one(
      op.switch({ categoryId: gone!.id, at: ago(0), newSegmentId: uuidv7(), source: 'app' }),
    );
    expect(deleted).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });
});

describe('segments.upsert op', () => {
  const h = (hh: number, mm = 0) =>
    `2026-09-01T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

  it('inserts rows and keeps the client updatedAt', async () => {
    const [a, b] = await seedCategories(2);
    const s1 = makeSegment(a!.id, h(9), h(10), { note: 'standup', updatedAt: h(12) });
    const s2 = makeSegment(b!.id, h(10), null, { updatedAt: h(12) });
    const start = Date.now();
    expect(await one(op.segments([s1, s2]))).toMatchObject({ ok: true });
    const stored = await segmentRow(server.db(), s1.id);
    expect(stored).toMatchObject({ ...s1 });
    expect(stored?.updatedAt).toBe(h(12));
    expect(Date.parse(stored!.syncedAt)).toBeGreaterThanOrEqual(start);
    expect(await timeline(server.db())).toEqual([
      [a!.id, h(9), h(10)],
      [b!.id, h(10), null],
    ]);
  });

  it('a replay of the same rows is ok and leaves the same state', async () => {
    const [a] = await seedCategories(1);
    const o = op.segments([makeSegment(a!.id, h(9), h(10)), makeSegment(a!.id, h(11), h(12))]);
    expect(await one(o)).toMatchObject({ ok: true });
    const strip = (rows: Awaited<ReturnType<typeof allSegments>>) =>
      rows.map(({ syncedAt: _s, ...rest }) => rest).sort((x, y) => x.id.localeCompare(y.id));
    const before = strip(await allSegments(server.db()));
    expect(await one(o)).toMatchObject({ ok: true });
    expect(strip(await allSegments(server.db()))).toEqual(before);
  });

  it('last write wins: an older copy is acknowledged and ignored, an equal one applied', async () => {
    const [a] = await seedCategories(1);
    const current = makeSegment(a!.id, h(9), h(10), { note: 'current', updatedAt: h(14) });
    await one(op.segments([current]));

    const older = { ...current, note: 'older', updatedAt: h(13) };
    expect(await one(op.segments([older]))).toMatchObject({ ok: true });
    expect((await segmentRow(server.db(), current.id))?.note).toBe('current');

    const equal = { ...current, note: 'equal', updatedAt: h(14) };
    expect(await one(op.segments([equal]))).toMatchObject({ ok: true });
    expect((await segmentRow(server.db(), current.id))?.note).toBe('equal');

    const newer = { ...current, note: 'newer', updatedAt: h(15) };
    expect(await one(op.segments([newer]))).toMatchObject({ ok: true });
    expect((await segmentRow(server.db(), current.id))?.note).toBe('newer');
  });

  it('an overlap rejects the whole op with conflict and writes nothing', async () => {
    const [a, b] = await seedCategories(2);
    await insertSegments(server.db(), [makeSegment(a!.id, h(10), h(11))]);
    const before = await allSegments(server.db());

    const fine = makeSegment(b!.id, h(8), h(9));
    const overlapping = makeSegment(b!.id, h(10, 30), h(11, 30));
    const r = await one(op.segments([fine, overlapping]));
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(r?.error?.message).toMatch(/I2/);
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('an edit that overlaps a stored neighbour outside the op is caught', async () => {
    const [a, b] = await seedCategories(2);
    const first = makeSegment(a!.id, h(9), h(10));
    const second = makeSegment(b!.id, h(10), h(11));
    await insertSegments(server.db(), [first, second]);
    // Stretch `first` over `second` without trimming `second`.
    const r = await one(op.segments([{ ...first, endedAt: h(10, 30), updatedAt: h(12) }]));
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((await segmentRow(server.db(), first.id))?.endedAt).toBe(h(10));
  });

  it('a second open segment is rejected with conflict', async () => {
    const [a, b] = await seedCategories(2);
    await insertSegments(server.db(), [makeSegment(a!.id, h(10), null)]);
    const before = await allSegments(server.db());
    const r = await one(
      op.segments([makeSegment(b!.id, h(8), h(9)), makeSegment(b!.id, h(12), null)]),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(r?.error?.message).toMatch(/I1/);
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('a segment shorter than a second is rejected (I5)', async () => {
    const [a] = await seedCategories(1);
    const r = await one(
      op.segments([makeSegment(a!.id, '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.500Z')]),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await allSegments(server.db())).toEqual([]);
  });

  it('undo in one op: reopening A and deleting B is written in a safe order', async () => {
    const [a, b] = await seedCategories(2);
    const segA = makeSegment(a!.id, h(9), h(10), { updatedAt: h(10) });
    const segB = makeSegment(b!.id, h(10), null, { updatedAt: h(10) });
    await one(op.segments([segA, segB]));

    // Rows in the order the client's undo produces them: reopen A first, then delete B.
    const undo = op.segments([
      { ...segA, endedAt: null, updatedAt: h(10, 1) },
      { ...segB, deletedAt: h(10, 1), updatedAt: h(10, 1) },
    ]);
    expect(await one(undo)).toMatchObject({ ok: true });
    expect(await timeline(server.db())).toEqual([[a!.id, h(9), null]]);
    expect((await segmentRow(server.db(), segB.id))?.deletedAt).toBe(h(10, 1));
  });

  it('moving the open segment from one row to another works in either row order', async () => {
    const [a, b] = await seedCategories(2);
    const segA = makeSegment(a!.id, h(9), null, { updatedAt: h(9) });
    await one(op.segments([segA]));
    // A switch expressed as rows: open B first in the list, close A second.
    const segB = makeSegment(b!.id, h(10), null, { updatedAt: h(10) });
    expect(
      await one(op.segments([segB, { ...segA, endedAt: h(10), updatedAt: h(10) }])),
    ).toMatchObject({ ok: true });
    expect(await timeline(server.db())).toEqual([
      [a!.id, h(9), h(10)],
      [b!.id, h(10), null],
    ]);
  });

  it('a delete is a soft delete and frees the time', async () => {
    const [a, b] = await seedCategories(2);
    const s = makeSegment(a!.id, h(9), h(10));
    await one(op.segments([s]));
    expect(await one(op.segments([{ ...s, deletedAt: h(11), updatedAt: h(11) }]))).toMatchObject({
      ok: true,
    });
    expect(await one(op.segments([makeSegment(b!.id, h(9), h(10))]))).toMatchObject({ ok: true });
    expect(await allSegments(server.db())).toHaveLength(2);
  });

  it('an unknown category is validation_failed', async () => {
    await seedCategories(1);
    const r = await one(op.segments([makeSegment(uuidv7(), h(9), h(10))]));
    expect(r).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });

  it('the same id twice in one op is validation_failed', async () => {
    const [a] = await seedCategories(1);
    const s = makeSegment(a!.id, h(9), h(10));
    const r = await one(op.segments([s, { ...s, note: 'again' }]));
    expect(r).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });
});

describe('category.upsert op', () => {
  it('inserts and updates with last-write-wins, storing booleans as 0/1', async () => {
    const c = makeCategory({ exemptFromStaleCheck: true, updatedAt: '2026-09-01T00:00:00.000Z' });
    expect(await one(op.category(c))).toMatchObject({ ok: true });
    expect(await categoryRow(server.db(), c.id)).toEqual(c);
    const raw = await server
      .rawDb()
      .prepare('SELECT exempt_from_stale_check AS e, synced_at AS s FROM categories WHERE id = ?')
      .bind(c.id)
      .first<{ e: number; s: string }>();
    expect(raw?.e).toBe(1);
    expect(raw?.s).toBeTruthy();

    await one(op.category({ ...c, name: 'Older', updatedAt: '2026-08-01T00:00:00.000Z' }));
    expect((await categoryRow(server.db(), c.id))?.name).toBe(c.name);
    await one(op.category({ ...c, name: 'Equal' }));
    expect((await categoryRow(server.db(), c.id))?.name).toBe('Equal');
  });

  it('deleting a category that live segments use is a conflict', async () => {
    const [a] = await seedCategories(1);
    await insertSegments(server.db(), [makeSegment(a!.id, ago(HOUR), null)]);
    const r = await one(op.category({ ...a!, deletedAt: ago(0), updatedAt: ago(0) }));
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((await categoryRow(server.db(), a!.id))?.deletedAt).toBeNull();
  });

  it('deleting a category with only deleted segments works', async () => {
    const [a] = await seedCategories(1);
    await insertSegments(server.db(), [
      makeSegment(a!.id, T0, '2026-01-01T01:00:00.000Z', { deletedAt: T0 }),
    ]);
    const deletedAt = ago(0);
    expect(await one(op.category({ ...a!, deletedAt, updatedAt: deletedAt }))).toMatchObject({
      ok: true,
    });
    expect((await categoryRow(server.db(), a!.id))?.deletedAt).toBe(deletedAt);
  });
});

describe('rule.upsert op', () => {
  it('inserts and updates with last-write-wins', async () => {
    const [a] = await seedCategories(1);
    const r = makeRule(a!.id, { updatedAt: '2026-09-01T00:00:00.000Z', enabled: false });
    expect(await one(op.rule(r))).toMatchObject({ ok: true });
    const listed = await server.get('/api/rules');
    expect(listed.json).toEqual([r]);

    await one(op.rule({ ...r, thresholdMin: 5, updatedAt: '2026-08-01T00:00:00.000Z' }));
    expect((await server.get('/api/rules')).json).toEqual([r]);
    await one(op.rule({ ...r, thresholdMin: 5 }));
    expect((await server.get('/api/rules')).json).toEqual([{ ...r, thresholdMin: 5 }]);
  });

  it('an unknown categoryId is validation_failed', async () => {
    const res = await one(op.rule(makeRule(uuidv7())));
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect((await server.get('/api/rules')).json).toEqual([]);
  });
});

describe('settings.upsert op', () => {
  it('inserts the singleton and updates it with last-write-wins', async () => {
    const s = makeSettings({
      timezone: 'Australia/Sydney',
      staleEnabled: false,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(await one(op.settings(s))).toMatchObject({ ok: true });
    expect((await server.get('/api/settings')).json).toEqual(s);

    await one(op.settings({ ...s, dayStartHour: 6, updatedAt: '2026-08-01T00:00:00.000Z' }));
    expect((await server.get('/api/settings')).json).toEqual(s);
    await one(op.settings({ ...s, dayStartHour: 6, updatedAt: '2026-09-02T00:00:00.000Z' }));
    expect((await server.get('/api/settings')).json).toMatchObject({ dayStartHour: 6 });
  });

  it('a stored older row is replaced when the incoming one is newer', async () => {
    await insertSettings(server.db(), makeSettings({ updatedAt: T0 }));
    expect(
      await one(op.settings(makeSettings({ dayStartHour: 0, updatedAt: ago(0) }))),
    ).toMatchObject({ ok: true });
    expect((await server.get('/api/settings')).json).toMatchObject({ dayStartHour: 0 });
  });
});
