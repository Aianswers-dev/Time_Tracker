import { apiErrorSchema, switchResponseSchema, uuidv7 } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MIN,
  ago,
  allSegments,
  insertCategories,
  insertSegments,
  iso,
  makeCategory,
  makeSegment,
  segmentRow,
  timeline,
  useTestServer,
} from './harness';

const server = useTestServer();

async function seed() {
  const relaxing = makeCategory({ name: 'Relaxing', sortOrder: 2 });
  const sleep = makeCategory({ name: 'Sleep', sortOrder: 1 });
  const archived = makeCategory({ name: 'Old hobby', archivedAt: ago(HOUR) });
  const deleted = makeCategory({ name: 'Gone', deletedAt: ago(HOUR) });
  await insertCategories(server.db(), [relaxing, sleep, archived, deleted]);
  return { relaxing, sleep, archived, deleted };
}

describe('POST /api/switch', () => {
  it('matches the name case-insensitively, ignoring surrounding whitespace', async () => {
    const { relaxing, sleep } = await seed();
    const sleepStart = ago(8 * HOUR);
    const sleepSeg = makeSegment(sleep.id, sleepStart, null);
    await insertSegments(server.db(), [sleepSeg]);

    const before = Date.now();
    const res = await server.post('/api/switch', { categoryName: '  rELAXing \n' });
    expect(res.status).toBe(200);
    const body = switchResponseSchema.parse(res.json);
    expect(body.noop).toBe(false);
    expect(body.message).toBe('Switched to Relaxing');
    expect(body.category).toEqual(relaxing);
    expect(body.opened).toMatchObject({
      categoryId: relaxing.id,
      endedAt: null,
      source: 'shortcut',
    });
    expect(Date.parse(body.opened!.startedAt)).toBeGreaterThanOrEqual(before);
    expect(body.closed).toMatchObject({ id: sleepSeg.id, endedAt: body.opened!.startedAt });

    expect(await timeline(server.db())).toEqual([
      [sleep.id, sleepStart, body.opened!.startedAt],
      [relaxing.id, body.opened!.startedAt, null],
    ]);
  });

  it('answers "Already on X" with noop when that category is running', async () => {
    const { relaxing } = await seed();
    await insertSegments(server.db(), [makeSegment(relaxing.id, ago(HOUR), null)]);
    const before = await allSegments(server.db());
    const res = await server.post('/api/switch', { categoryName: 'relaxing' });
    expect(res.status).toBe(200);
    expect(switchResponseSchema.parse(res.json)).toEqual({
      noop: true,
      message: 'Already on Relaxing',
      category: relaxing,
      closed: null,
      opened: null,
    });
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('an unknown name is 404 not_found', async () => {
    await seed();
    const res = await server.post('/api/switch', { categoryName: 'Gaming' });
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(res.json).error.code).toBe('not_found');
  });

  it('archived and deleted categories are 404, by name and by id', async () => {
    const { archived, deleted } = await seed();
    for (const body of [
      { categoryName: archived.name },
      { categoryName: deleted.name },
      { categoryId: archived.id },
      { categoryId: deleted.id },
    ]) {
      const res = await server.post('/api/switch', body);
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    expect(await allSegments(server.db())).toEqual([]);
  });

  it('accepts categoryId, a backdated at, a client id and a source', async () => {
    const { sleep } = await seed();
    const at = ago(10 * MIN);
    const id = uuidv7();
    const res = await server.post('/api/switch', { categoryId: sleep.id, at, id, source: 'app' });
    expect(res.status).toBe(200);
    const body = switchResponseSchema.parse(res.json);
    expect(body.opened).toMatchObject({ id, categoryId: sleep.id, startedAt: at, source: 'app' });
    expect(body.closed).toBeNull();
    expect(await segmentRow(server.db(), id)).toMatchObject({ startedAt: at, source: 'app' });
  });

  it('a retried request with the same id changes nothing', async () => {
    const { sleep, relaxing } = await seed();
    const id = uuidv7();
    await server.post('/api/switch', { categoryId: sleep.id, id });
    await server.post('/api/switch', { categoryId: relaxing.id });
    const before = await allSegments(server.db());
    const res = await server.post('/api/switch', { categoryId: sleep.id, id });
    expect(res.status).toBe(200);
    expect(switchResponseSchema.parse(res.json)).toMatchObject({ noop: true, opened: null });
    expect(await allSegments(server.db())).toEqual(before);
  });

  it('refuses to backdate more than 24 hours, so a bad Shortcut cannot wipe history', async () => {
    const { sleep, relaxing } = await seed();
    await server.post('/api/switch', { categoryId: sleep.id, at: ago(20 * HOUR) });
    await server.post('/api/switch', { categoryId: relaxing.id, at: ago(10 * HOUR) });
    const before = await allSegments(server.db());

    for (const at of [ago(25 * HOUR), '1970-01-01T00:00:00.000Z']) {
      const res = await server.post('/api/switch', { categoryName: 'Sleep', at });
      expect(res.status, at).toBe(400);
      expect(apiErrorSchema.parse(res.json).error.code).toBe('validation_failed');
    }
    expect(await allSegments(server.db())).toEqual(before);

    const ok = await server.post('/api/switch', { categoryName: 'Sleep', at: ago(23 * HOUR) });
    expect(ok.status).toBe(200);
  });

  it('a time more than a minute ahead is 400 switch_in_future', async () => {
    await seed();
    const res = await server.post('/api/switch', {
      categoryName: 'Sleep',
      at: iso(Date.now() + 10 * MIN),
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.json).error.code).toBe('switch_in_future');
    expect(await allSegments(server.db())).toEqual([]);
  });

  it('the first switch ever opens a segment with nothing closed', async () => {
    const { sleep } = await seed();
    const body = switchResponseSchema.parse(
      (await server.post('/api/switch', { categoryName: 'Sleep' })).json,
    );
    expect(body).toMatchObject({ noop: false, closed: null, opened: { categoryId: sleep.id } });
  });
});
