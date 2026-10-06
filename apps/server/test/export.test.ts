import {
  categorySchema,
  ruleSchema,
  segmentSchema,
  settingsSchema,
  wholeMinutes,
} from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  HOUR,
  ago,
  insertCategories,
  insertRules,
  insertSegments,
  insertSettings,
  makeCategory,
  makeRule,
  makeSegment,
  makeSettings,
  useTestServer,
} from './harness';

const server = useTestServer();

const range = 'from=2026-06-30T00:00:00.000Z&to=2026-07-02T00:00:00.000Z';

describe('GET /api/export.csv', () => {
  it('writes local times in the settings timezone and quotes fields per RFC 4180', async () => {
    // Sydney is UTC+10 in July (no daylight saving).
    await insertSettings(server.db(), makeSettings({ timezone: 'Australia/Sydney' }));
    const travel = makeCategory({ name: 'Travel, commute' });
    const work = makeCategory({ name: 'Work' });
    await insertCategories(server.db(), [travel, work]);
    await insertSegments(server.db(), [
      makeSegment(travel.id, '2026-07-01T00:00:00.000Z', '2026-07-01T01:30:00.000Z', {
        note: 'He said "hi", then\nleft',
        source: 'shortcut',
      }),
      makeSegment(work.id, '2026-07-01T01:30:00.000Z', '2026-07-01T14:05:30.000Z', {
        source: 'edit',
      }),
      // Outside the range, and deleted: neither is exported.
      makeSegment(work.id, '2026-07-05T00:00:00.000Z', '2026-07-05T01:00:00.000Z'),
      makeSegment(work.id, '2026-07-01T15:00:00.000Z', '2026-07-01T16:00:00.000Z', {
        deletedAt: '2026-07-02T00:00:00.000Z',
      }),
    ]);

    const res = await server.get(`/api/export.csv?${range}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="time-tracker-.*\.csv"/,
    );
    expect(res.text).toBe(
      [
        'started_at,ended_at,category,minutes,note,source,started_at_utc',
        '2026-07-01 10:00,2026-07-01 11:30,"Travel, commute",90,"He said ""hi"", then\nleft",shortcut,2026-07-01T00:00:00.000Z',
        // Ends at 00:05 the next local day; 12 h 35 m 30 s rounds down to 755 minutes.
        '2026-07-01 11:30,2026-07-02 00:05,Work,755,,edit,2026-07-01T01:30:00.000Z',
        '',
      ].join('\r\n'),
    );
  });

  it('uses UTC before settings exist and leaves ended_at empty for the open segment', async () => {
    const cat = makeCategory({ name: 'Sleep' });
    await insertCategories(server.db(), [cat]);
    const started = ago(2 * HOUR);
    await insertSegments(server.db(), [makeSegment(cat.id, started, null)]);
    const res = await server.get('/api/export.csv');
    const [header, row, last] = res.text.split('\r\n');
    expect(header).toBe('started_at,ended_at,category,minutes,note,source,started_at_utc');
    const cells = row!.split(',');
    expect(cells[0]).toBe(`${started.slice(0, 10)} ${started.slice(11, 16)}`);
    expect(cells[1]).toBe('');
    expect(cells[2]).toBe('Sleep');
    expect(Number(cells[3])).toBe(wholeMinutes(2 * HOUR));
    expect(cells[6]).toBe(started);
    expect(last).toBe('');
  });
});

describe('GET /api/export.json', () => {
  it('returns segments in range plus every live category and rule and the settings', async () => {
    const settings = makeSettings({ timezone: 'Europe/London' });
    await insertSettings(server.db(), settings);
    const cat = makeCategory();
    const archived = makeCategory({ archivedAt: '2026-01-02T00:00:00.000Z' });
    const deleted = makeCategory({ deletedAt: '2026-01-02T00:00:00.000Z' });
    await insertCategories(server.db(), [cat, archived, deleted]);
    const inRange = makeSegment(cat.id, '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z');
    await insertSegments(server.db(), [
      inRange,
      makeSegment(cat.id, '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z'),
    ]);
    const rule = makeRule(cat.id);
    await insertRules(server.db(), [
      rule,
      makeRule(cat.id, { deletedAt: '2026-01-02T00:00:00.000Z' }),
    ]);

    const res = await server.get(`/api/export.json?${range}`);
    expect(res.status).toBe(200);
    const body = z
      .object({
        categories: z.array(categorySchema),
        segments: z.array(segmentSchema),
        rules: z.array(ruleSchema),
        settings: settingsSchema.nullable(),
      })
      .parse(res.json);
    expect(body.segments).toEqual([inRange]);
    expect(body.categories.map((c) => c.id).sort()).toEqual([cat.id, archived.id].sort());
    expect(body.rules).toEqual([rule]);
    expect(body.settings).toEqual(settings);
  });
});

describe('convenience reads', () => {
  it('GET /api/categories lists active categories in sort order', async () => {
    const b = makeCategory({ name: 'B', sortOrder: 2 });
    const a = makeCategory({ name: 'A', sortOrder: 1 });
    await insertCategories(server.db(), [
      b,
      a,
      makeCategory({ archivedAt: '2026-01-02T00:00:00.000Z' }),
      makeCategory({ deletedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const res = await server.get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.json).toEqual([a, b]);
  });

  it('GET /api/segments returns live segments overlapping the range, oldest first', async () => {
    const cat = makeCategory();
    await insertCategories(server.db(), [cat]);
    const before = makeSegment(cat.id, '2026-07-01T00:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const crossing = makeSegment(cat.id, '2026-07-01T10:00:00.000Z', '2026-07-01T12:30:00.000Z');
    const inside = makeSegment(cat.id, '2026-07-01T12:30:00.000Z', '2026-07-01T13:00:00.000Z');
    const open = makeSegment(cat.id, '2026-07-01T13:00:00.000Z', null);
    const deleted = makeSegment(cat.id, '2026-07-01T11:00:00.000Z', '2026-07-01T11:30:00.000Z', {
      deletedAt: '2026-07-01T12:00:00.000Z',
    });
    await insertSegments(server.db(), [open, inside, crossing, before, deleted]);
    const res = await server.get(
      '/api/segments?from=2026-07-01T12:00:00.000Z&to=2026-07-02T00:00:00.000Z',
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual([crossing, inside, open]);
  });

  it('GET /api/settings returns the defaults before any are stored', async () => {
    const res = await server.get('/api/settings');
    expect(res.status).toBe(200);
    expect(settingsSchema.parse(res.json)).toMatchObject({ timezone: 'UTC', dayStartHour: 4 });
  });
});
