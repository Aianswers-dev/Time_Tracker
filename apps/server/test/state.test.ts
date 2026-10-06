import { dayKeyOf, dayRange, stateResponseSchema, wholeMinutes } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MIN,
  ago,
  insertCategories,
  insertSegments,
  insertSettings,
  makeCategory,
  makeSegment,
  makeSettings,
  useTestServer,
} from './harness';

const server = useTestServer();

/**
 * Settings whose logical day started about 12 hours ago, so "the last few
 * hours" is always inside today whenever the test runs.
 */
function midDaySettings() {
  const dayStartHour = (new Date().getUTCHours() + 12) % 24;
  return makeSettings({ timezone: 'UTC', dayStartHour, updatedAt: ago(0) });
}

describe('GET /api/state', () => {
  it('before the first switch: nothing open, no totals, default day settings', async () => {
    const res = await server.get('/api/state');
    expect(res.status).toBe(200);
    const body = stateResponseSchema.parse(res.json);
    expect(body.open).toBeNull();
    expect(body.today).toEqual({
      dayKey: dayKeyOf(body.now, { timezone: 'UTC', dayStartHour: 4 }),
      totals: [],
      untrackedMin: 0,
    });
  });

  it('reports the open segment and today’s totals, largest first, with untracked time', async () => {
    const settings = midDaySettings();
    await insertSettings(server.db(), settings);
    const work = makeCategory({ name: 'Contract work', color: '#0d74ce', icon: 'laptop' });
    const relax = makeCategory({ name: 'Relaxing', color: '#e5484d', icon: 'sofa' });
    const archived = makeCategory({ name: 'Old', archivedAt: ago(HOUR) });
    await insertCategories(server.db(), [work, relax, archived]);

    const nowMs = Date.now();
    const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
    const open = makeSegment(relax.id, at(150 * MIN), null);
    await insertSegments(server.db(), [
      // Yesterday: before today's range, but it means tracking began before today.
      makeSegment(work.id, at(30 * HOUR), at(29 * HOUR)),
      makeSegment(work.id, at(5 * HOUR), at(3 * HOUR)),
      // 30 minute gap, then the open segment.
      open,
      // Deleted rows never count.
      makeSegment(archived.id, at(3 * HOUR), at(150 * MIN), { deletedAt: at(MIN) }),
    ]);

    const res = await server.get('/api/state');
    expect(res.status).toBe(200);
    const body = stateResponseSchema.parse(res.json);

    expect(body.open?.segment).toEqual(open);
    expect(body.open?.category).toEqual(relax);
    expect(body.open?.elapsedMin).toBe(150);

    const dayKey = dayKeyOf(nowMs, settings);
    expect(body.today.dayKey).toBe(dayKey);
    expect(body.today.totals).toEqual([
      { categoryId: relax.id, name: 'Relaxing', color: '#e5484d', icon: 'sofa', minutes: 150 },
      {
        categoryId: work.id,
        name: 'Contract work',
        color: '#0d74ce',
        icon: 'laptop',
        minutes: 120,
      },
    ]);
    // From the start of the logical day to 5 hours ago, plus the 30 minute gap.
    const dayStart = dayRange(dayKey, settings).start;
    expect(body.today.untrackedMin).toBe(wholeMinutes(nowMs - 5 * HOUR - dayStart + 30 * MIN));
  });

  it('only counts the part of a segment inside today', async () => {
    const settings = midDaySettings();
    await insertSettings(server.db(), settings);
    const sleep = makeCategory({ name: 'Sleep' });
    await insertCategories(server.db(), [sleep]);
    const nowMs = Date.now();
    const dayStart = dayRange(dayKeyOf(nowMs, settings), settings).start;
    // Started two hours before the logical day began and is still running.
    await insertSegments(server.db(), [
      makeSegment(sleep.id, new Date(dayStart - 2 * HOUR).toISOString(), null),
    ]);

    const body = stateResponseSchema.parse((await server.get('/api/state')).json);
    const expected = wholeMinutes(Date.parse(body.now) - dayStart);
    expect(body.today.totals).toHaveLength(1);
    expect(body.today.totals[0]?.minutes).toBe(expected);
    expect(body.today.untrackedMin).toBe(0);
    expect(body.open?.elapsedMin).toBe(wholeMinutes(Date.parse(body.now) - dayStart + 2 * HOUR));
  });
});
