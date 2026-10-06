import { DAY_MS, toIso, type Segment } from '@time-tracker/shared';
import { db } from '../db';

/**
 * Segment loading without reading the whole history.
 *
 * Shared segment operations only look at segments overlapping the affected time
 * and at their immediate neighbours. Every live segment starting inside
 * [from - margin, to + margin) is loaded, plus the nearest live segment on each
 * side of that window and the open segment. Live segments never overlap, so the
 * nearest one before the window is the only one that can reach into it.
 */
export const WINDOW_MARGIN_MS = 7 * DAY_MS;

function isLive(s: Segment): boolean {
  return s.deletedAt === null;
}

/**
 * The live open segment. Live segments never overlap and the open one runs to
 * infinity, so it is always the live segment with the latest start.
 */
export async function findOpenSegment(): Promise<Segment | null> {
  const latest = await db.segments.orderBy('startedAt').reverse().filter(isLive).first();
  return latest && latest.endedAt === null ? latest : null;
}

/**
 * Live segments that can matter for an operation or view touching
 * [fromMs, toMs). `toMs` may be Infinity, which loads everything after `fromMs`.
 */
export async function loadAround(fromMs: number, toMs: number = Infinity): Promise<Segment[]> {
  const lower = toIso(fromMs - WINDOW_MARGIN_MS);
  const bounded = Number.isFinite(toMs);
  const upper = bounded ? toIso(toMs + WINDOW_MARGIN_MS) : null;

  const inside =
    upper === null
      ? db.segments.where('startedAt').aboveOrEqual(lower)
      : db.segments.where('startedAt').between(lower, upper, true, false);

  const [rows, before, after, open] = await Promise.all([
    // toArray() without a Dexie filter uses getAll(), much faster than a cursor.
    inside.toArray().then((all) => all.filter(isLive)),
    db.segments.where('startedAt').below(lower).reverse().filter(isLive).first(),
    upper === null
      ? Promise.resolve(undefined)
      : db.segments.where('startedAt').aboveOrEqual(upper).filter(isLive).first(),
    findOpenSegment(),
  ]);

  const byId = new Map<string, Segment>();
  for (const s of rows) byId.set(s.id, s);
  if (before) byId.set(before.id, before);
  if (after) byId.set(after.id, after);
  if (open) byId.set(open.id, open);
  return [...byId.values()];
}
