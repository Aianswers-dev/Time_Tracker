import { toIso, type Segment } from '@time-tracker/shared';
import { db } from '../../db';
import { findOpenSegment } from '../../data/window';

function isLive(s: Segment): boolean {
  return s.deletedAt === null;
}

/**
 * The segments a Stats range needs, without reading the whole history: every
 * live segment starting inside [fromMs, toMs) by the `startedAt` index, the
 * nearest live segment starting before it (segments never overlap, so it is
 * the only earlier one that can reach into the range), the open segment, and
 * the earliest live segment, so the shared totals know when tracking began and
 * count untracked time from there.
 */
export async function loadStatsSegments(fromMs: number, toMs: number): Promise<Segment[]> {
  const started = now();
  const lower = toIso(fromMs);
  const upper = toIso(toMs);
  const [inside, before, earliest, open] = await Promise.all([
    // toArray() without a Dexie filter uses getAll(), much faster than a cursor.
    db.segments
      .where('startedAt')
      .between(lower, upper, true, false)
      .toArray()
      .then((rows) => rows.filter(isLive)),
    db.segments.where('startedAt').below(lower).reverse().filter(isLive).first(),
    db.segments.orderBy('startedAt').filter(isLive).first(),
    findOpenSegment(),
  ]);
  const byId = new Map<string, Segment>();
  for (const s of inside) byId.set(s.id, s);
  for (const s of [before, earliest, open]) if (s) byId.set(s.id, s);
  measure('stats:load', started);
  return [...byId.values()];
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Record a User Timing entry, so the Stats screen's cost shows up in Safari's
 * Web Inspector (Timelines) and in Playwright without extra logging.
 */
export function measure(name: string, startedAt: number): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  try {
    performance.measure(name, { start: startedAt, end: now() });
  } catch {
    // User Timing is diagnostics only.
  }
}

/** Run `fn` and record how long it took under `name`. */
export function measured<T>(name: string, fn: () => T): T {
  const started = now();
  const out = fn();
  measure(name, started);
  return out;
}
