import { snapshotResponseSchema, uuidv7 } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MIN,
  T0,
  ago,
  insertCategories,
  insertRules,
  insertSegments,
  insertSettings,
  iso,
  makeCategory,
  makeRule,
  makeSegment,
  makeSettings,
  op,
  useTestServer,
} from './harness';

const server = useTestServer();

/** Pretend everything stored so far was written long ago. */
async function ageAllRows(byMs: number) {
  const stamp = iso(Date.now() - byMs);
  const raw = server.rawDb();
  await raw.batch(
    ['categories', 'segments', 'rules', 'settings'].map((t) =>
      raw.prepare(`UPDATE ${t} SET synced_at = ?`).bind(stamp),
    ),
  );
}

describe('GET /api/snapshot', () => {
  it('without since returns everything, soft-deleted rows included, and never synced_at', async () => {
    const cat = makeCategory();
    const gone = makeCategory({ deletedAt: T0 });
    await insertCategories(server.db(), [cat, gone]);
    const live = makeSegment(cat.id, ago(2 * HOUR), ago(HOUR));
    const deleted = makeSegment(cat.id, ago(3 * HOUR), ago(2 * HOUR), { deletedAt: ago(MIN) });
    await insertSegments(server.db(), [live, deleted]);
    const rule = makeRule(cat.id);
    await insertRules(server.db(), [rule]);
    const settings = makeSettings({ timezone: 'Europe/Berlin' });
    await insertSettings(server.db(), settings);

    const before = Date.now();
    const res = await server.get('/api/snapshot');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/synced/i);
    const body = snapshotResponseSchema.parse(res.json);
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before);
    expect(body.categories).toHaveLength(2);
    expect(body.categories).toContainEqual(gone);
    expect(body.segments).toEqual([deleted, live]);
    expect(body.rules).toEqual([rule]);
    expect(body.settings).toEqual(settings);
  });

  it('is empty with settings null on a fresh database', async () => {
    const body = snapshotResponseSchema.parse((await server.get('/api/snapshot')).json);
    expect(body).toMatchObject({ categories: [], segments: [], rules: [], settings: null });
  });

  it('with since returns rows written after the cursor and not rows written before', async () => {
    const [a, b] = [makeCategory(), makeCategory()];
    await insertCategories(server.db(), [a, b]);
    const old = makeSegment(a.id, ago(5 * HOUR), ago(4 * HOUR));
    const toDelete = makeSegment(a.id, ago(4 * HOUR), ago(3 * HOUR));
    await insertSegments(server.db(), [old, toDelete]);
    await insertSettings(server.db(), makeSettings());

    // The client pulled a while ago; everything above was written before that.
    const first = snapshotResponseSchema.parse((await server.get('/api/snapshot')).json);
    await ageAllRows(HOUR);
    const cursor = iso(Date.now() - 30 * MIN);
    expect(first.segments).toHaveLength(2);

    // After the cursor: a switch, a soft delete and a category edit.
    const sw = op.switch({ categoryId: b.id, at: ago(MIN), newSegmentId: uuidv7(), source: 'app' });
    const del = op.segments([{ ...toDelete, deletedAt: ago(0), updatedAt: ago(0) }]);
    const edit = op.category({ ...a, name: 'Renamed', updatedAt: ago(0) });
    expect((await server.ops([sw, del, edit])).status).toBe(200);

    const res = await server.get(`/api/snapshot?since=${encodeURIComponent(cursor)}`);
    const body = snapshotResponseSchema.parse(res.json);
    expect(body.categories.map((c) => c.name)).toEqual(['Renamed']);
    const ids = body.segments.map((s) => s.id);
    expect(ids).toContain(sw.payload.newSegmentId);
    expect(ids).toContain(toDelete.id);
    expect(ids).not.toContain(old.id);
    expect(body.segments.find((s) => s.id === toDelete.id)?.deletedAt).not.toBeNull();
    expect(body.rules).toEqual([]);
    // Settings did not change since the cursor.
    expect(body.settings).toBeNull();
  });

  it('a since equal to a previous serverTime still returns what was written after it', async () => {
    const cat = makeCategory();
    await insertCategories(server.db(), [cat]);
    const first = snapshotResponseSchema.parse((await server.get('/api/snapshot')).json);
    await server.ops([op.settings(makeSettings({ updatedAt: ago(0) }))]);
    const next = snapshotResponseSchema.parse(
      (await server.get(`/api/snapshot?since=${encodeURIComponent(first.serverTime)}`)).json,
    );
    expect(next.settings).not.toBeNull();
  });
});
