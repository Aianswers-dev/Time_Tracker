import {
  applyRows,
  dayKeyOf,
  dayRange,
  findOpen,
  sortedTotals,
  toMs,
  totalsForRange,
  wholeMinutes,
  type StateResponse,
} from '@time-tracker/shared';
import { Hono } from 'hono';
import { createDb } from '../db/client';
import { segmentFromRow } from '../db/mapping';
import {
  categoriesByIds,
  firstSegment,
  firstSettings,
  orDefaultSettings,
  select,
} from '../db/queries';
import type { AppEnv } from '../env';

export const stateRoutes = new Hono<AppEnv>();

/**
 * `GET /api/state`: what is running and today's totals, for the widget and
 * Shortcuts. "Today" is the logical day containing now, per settings.
 */
stateRoutes.get('/state', async (c) => {
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();
  const nowMs = toMs(now);

  const [settingsRows, earliestRows] = await db.batch([
    select.settings(db),
    select.earliestLiveSegment(db),
  ]);
  const settings = orDefaultSettings(firstSettings(settingsRows));
  const dayKey = dayKeyOf(nowMs, settings);
  const day = dayRange(dayKey, settings);

  // Today's segments include the open one: it never ends, so it overlaps today.
  const today = (await select.segmentsOverlapping(db, day.start, day.end)).map(segmentFromRow);
  const open = findOpen(today);
  // The earliest segment tells the shared totals when tracking began, so time
  // before the first switch is not counted as untracked. It adds nothing else.
  const earliest = firstSegment(earliestRows);
  const segments = earliest ? applyRows(today, [earliest]) : today;
  const totals = totalsForRange(segments, day.start, day.end, nowMs);
  const ranked = sortedTotals(totals.byCategory);

  const categories = await categoriesByIds(db, [
    ...ranked.map((t) => t.categoryId),
    ...(open ? [open.categoryId] : []),
  ]);

  let openState: StateResponse['open'] = null;
  if (open) {
    const category = categories.get(open.categoryId);
    if (!category) throw new Error(`Open segment ${open.id} has no category`);
    openState = {
      segment: open,
      category,
      elapsedMin: wholeMinutes(nowMs - toMs(open.startedAt)),
    };
  }

  const body: StateResponse = {
    now,
    open: openState,
    today: {
      dayKey,
      totals: ranked.flatMap(({ categoryId, ms }) => {
        const category = categories.get(categoryId);
        if (!category) return [];
        return [
          {
            categoryId,
            name: category.name,
            color: category.color,
            icon: category.icon,
            minutes: wholeMinutes(ms),
          },
        ];
      }),
      untrackedMin: wholeMinutes(totals.untrackedMs),
    },
  };
  return c.json(body);
});
