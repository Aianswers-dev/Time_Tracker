import {
  findOpen,
  switchRequestSchema,
  type Category,
  type SwitchResponse,
} from '@time-tracker/shared';
import { Hono } from 'hono';
import { createDb } from '../db/client';
import { categoryFromRow, segmentFromRow } from '../db/mapping';
import { select } from '../db/queries';
import type { AppEnv } from '../env';
import { ApiException, readJson } from '../http';
import { toOpFailure } from '../sync/errors';
import { computeSwitch, switchWindowStart, writeSwitch } from '../sync/switch';

export const switchRoutes = new Hono<AppEnv>();

/** Case-insensitive, ignoring surrounding whitespace and Unicode composition differences. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

function isActive(c: Category): boolean {
  return c.archivedAt === null && c.deletedAt === null;
}

/**
 * The active category the request names, by id (which wins when both are
 * given) or by name. Archived and deleted categories never match. Candidates
 * are in display order, so duplicate names resolve to the first in the grid.
 */
function resolveCategory(
  candidates: readonly Category[],
  req: { categoryId?: string; categoryName?: string },
): Category | null {
  if (req.categoryId !== undefined) {
    return candidates.find((c) => c.id === req.categoryId && isActive(c)) ?? null;
  }
  const wanted = normalizeName(req.categoryName ?? '');
  return candidates.find((c) => isActive(c) && normalizeName(c.name) === wanted) ?? null;
}

/**
 * `POST /api/switch`: switch by name for Shortcuts and Siri. Runs the same
 * shared `switchCategory` as the app, with the server's clock. Two D1 calls:
 * one read batch, one write batch.
 */
switchRoutes.post('/switch', async (c) => {
  const req = await readJson(c, switchRequestSchema);
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  const [candidateRows, existing, currentRows] = await db.batch([
    req.categoryId !== undefined
      ? select.categoriesByIds(db, [req.categoryId])
      : select.activeCategories(db),
    select.segmentsByIds(db, req.id === undefined ? [] : [req.id]),
    select.segmentsOverlapping(db, switchWindowStart(req.at, now), Number.POSITIVE_INFINITY),
  ]);

  const category = resolveCategory(candidateRows.map(categoryFromRow), req);
  if (!category) {
    const what = req.categoryId ?? req.categoryName ?? '';
    throw new ApiException(404, 'not_found', `No active category "${what}"`);
  }

  const noop = (message: string): Response => {
    const body: SwitchResponse = { noop: true, message, category, closed: null, opened: null };
    return c.json(body);
  };

  // A retried request with the same id: the first attempt already switched.
  if (existing.length > 0) return noop(`Switched to ${category.name}`);

  const current = currentRows.map(segmentFromRow);
  if (findOpen(current)?.categoryId === category.id) return noop(`Already on ${category.name}`);

  let result;
  try {
    result = computeSwitch(
      current,
      { categoryId: category.id, at: req.at, newSegmentId: req.id, source: req.source },
      now,
    );
    await writeSwitch(db, result, now);
  } catch (err) {
    const failure = toOpFailure(err);
    if (!failure) throw err;
    const status = failure.code === 'conflict' ? 409 : 400;
    throw new ApiException(status, failure.code, failure.message);
  }

  const opened = result.opened;
  if (result.noop || !opened) return noop(`Already on ${category.name}`);
  // The segment that now ends where the new one starts, if there is one.
  const closed =
    result.rows.find((s) => s.deletedAt === null && s.endedAt === opened.startedAt) ?? null;
  const body: SwitchResponse = {
    noop: false,
    message: `Switched to ${category.name}`,
    category,
    closed,
    opened,
  };
  return c.json(body);
});
