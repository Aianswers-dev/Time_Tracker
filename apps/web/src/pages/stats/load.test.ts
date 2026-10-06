import { DAY_MS, HOUR_MS, totalsForRange } from '@time-tracker/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { CAT, resetDb, seg } from '../../data/testUtils';
import { loadStatsSegments } from './load';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (days: number, hours = 0) => T0 + days * DAY_MS + hours * HOUR_MS;

describe('loadStatsSegments', () => {
  beforeEach(async () => {
    await resetDb();
    await db.segments.bulkPut([
      // A deleted segment earlier than everything: never tracking start.
      seg(CAT.hobbies, at(-5), at(-4), { deletedAt: '2026-01-02T00:00:00.000Z' }),
      seg(CAT.sleep, at(0), at(0, 8)), // earliest live segment
      seg(CAT.housework, at(1), at(1, 2)), // far before the range
      seg(CAT.relaxing, at(9, 20), at(10, 6)), // starts before the range, reaches in
      seg(CAT.travel, at(10, 6), at(10, 7)),
      seg(CAT.uniStudy, at(11), at(11, 3)),
      seg(CAT.socialising, at(20), at(20, 1)), // after the range
      seg(CAT.contractWork, at(30), null), // open
    ]);
  });

  it('loads the range, the segment reaching into it, the earliest and the open segment', async () => {
    const rows = await loadStatsSegments(at(10), at(12));
    const cats = rows.map((s) => s.categoryId).sort();
    expect(cats).toEqual(
      [CAT.sleep, CAT.relaxing, CAT.travel, CAT.uniStudy, CAT.contractWork].sort(),
    );
    expect(rows.every((s) => s.deletedAt === null)).toBe(true);
    expect(new Set(rows.map((s) => s.id)).size).toBe(rows.length);
  });

  it('gives the shared totals what they need for untracked time', async () => {
    const rows = await loadStatsSegments(at(10), at(12));
    const totals = totalsForRange(rows, at(10), at(12), at(40));
    // 6 h of Relaxing and 1 h of Travel on day 10, 3 h of Uni study on day 11.
    expect(totals.trackedMs).toBe(10 * HOUR_MS);
    expect(totals.untrackedMs).toBe(38 * HOUR_MS);
  });

  it('does not duplicate rows that are both earliest and inside the range', async () => {
    const rows = await loadStatsSegments(at(-1), at(0, 12));
    expect(rows.filter((s) => s.categoryId === CAT.sleep)).toHaveLength(1);
  });
});
