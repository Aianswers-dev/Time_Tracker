import { DAY_MS, isoSchema, toMs } from '@time-tracker/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDb } from '../db/client';
import {
  activeCategories,
  effectiveSettings,
  liveRules,
  liveSegmentsOverlapping,
} from '../db/queries';
import type { AppEnv } from '../env';
import { readQuery } from '../http';

export const readRoutes = new Hono<AppEnv>();

/** Longest range `GET /api/segments` serves. */
export const MAX_SEGMENT_RANGE_DAYS = 92;

/** Active categories (not archived, not deleted) in display order. The login screen uses it to check the token. */
readRoutes.get('/categories', async (c) => {
  return c.json(await activeCategories(createDb(c.env.DB)));
});

const segmentsQuerySchema = z
  .object({ from: isoSchema, to: isoSchema })
  .refine((q) => q.from < q.to, { message: 'from must be before to', path: ['to'] })
  .refine((q) => toMs(q.to) - toMs(q.from) <= MAX_SEGMENT_RANGE_DAYS * DAY_MS, {
    message: `The range can be at most ${MAX_SEGMENT_RANGE_DAYS} days`,
    path: ['to'],
  });

/** Non-deleted segments overlapping [from, to), oldest first. The open segment counts as running forever. */
readRoutes.get('/segments', async (c) => {
  const { from, to } = readQuery(c, segmentsQuerySchema);
  return c.json(await liveSegmentsOverlapping(createDb(c.env.DB), toMs(from), toMs(to)));
});

/** Non-deleted rules, oldest first. */
readRoutes.get('/rules', async (c) => {
  return c.json(await liveRules(createDb(c.env.DB)));
});

/** The stored settings, or the defaults the server uses (UTC, day start 4) before any are stored. */
readRoutes.get('/settings', async (c) => {
  return c.json(await effectiveSettings(createDb(c.env.DB)));
});
