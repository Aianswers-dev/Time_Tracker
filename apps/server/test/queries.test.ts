import { describe, expect, it } from 'vitest';
import { keepOverlapping, liveSegmentsOverlapping, select } from '../src/db/queries';
import {
  HOUR,
  insertCategories,
  insertSegments,
  iso,
  makeCategory,
  makeSegment,
  useTestServer,
} from './harness';

/**
 * The overlap query runs on every switch, every op that edits segments and
 * every `/api/state` (widget) request, so it must not read the whole history.
 */

const server = useTestServer();

const DAY = 24 * HOUR;
const T = Date.parse('2026-03-10T12:00:00.000Z');

describe('segmentsOverlapping', () => {
  it('reads through segments_ended, not across all history', async () => {
    const db = server.db();
    const plans: string[] = [];
    for (const q of [
      select.segmentsOverlapping(db, T - DAY, T).toSQL(),
      select.segmentsOverlapping(db, T - HOUR, Number.POSITIVE_INFINITY).toSQL(),
    ]) {
      const rows = await server
        .rawDb()
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.params)
        .all<{ detail: string }>();
      plans.push(...rows.results.map((r) => r.detail));
    }
    expect(plans.some((d) => /INDEX segments_ended/.test(d))).toBe(true);
    expect(plans.filter((d) => /^SCAN segments\b/.test(d))).toEqual([]);
    expect(plans.filter((d) => /segments_started/.test(d))).toEqual([]);
  });

  it('returns exactly the live segments overlapping the window, oldest first', async () => {
    const db = server.db();
    const cat = makeCategory();
    await insertCategories(db, [cat]);
    const before = makeSegment(cat.id, iso(T - 3 * DAY), iso(T - 2 * DAY));
    const crossing = makeSegment(cat.id, iso(T - 2 * DAY), iso(T - DAY + HOUR));
    const inside = makeSegment(cat.id, iso(T - DAY + HOUR), iso(T - 2 * HOUR));
    const deleted = makeSegment(cat.id, iso(T - 2 * HOUR), iso(T - HOUR), {
      deletedAt: iso(T),
    });
    const open = makeSegment(cat.id, iso(T - HOUR), null);
    await insertSegments(db, [open, deleted, inside, before, crossing]);

    const window = await liveSegmentsOverlapping(db, T - DAY, T - 90 * 60 * 1000);
    expect(window.map((s) => s.id)).toEqual([crossing.id, inside.id]);

    const recent = await liveSegmentsOverlapping(db, T - DAY, Number.POSITIVE_INFINITY);
    expect(recent.map((s) => s.id)).toEqual([crossing.id, inside.id, open.id]);
  });
});

describe('keepOverlapping', () => {
  const row = (id: string, start: number, end: number | null) => ({
    id,
    startedAt: iso(start),
    endedAt: end === null ? null : iso(end),
  });

  it('drops rows outside the window, keeps touching edges out, and sorts by start then id', () => {
    const rows = [
      row('c', 30, 40),
      row('b', 10, 20),
      row('a', 10, 15),
      row('ends-at-from', 0, 10),
      row('starts-at-to', 50, 60),
      row('open', 45, null),
    ];
    expect(keepOverlapping(rows, 10, 50).map((r) => r.id)).toEqual(['a', 'b', 'c', 'open']);
  });
});
