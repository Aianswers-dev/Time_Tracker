import { toMs, type Category, type Op, type Rule, type Segment } from '@time-tracker/shared';

/**
 * The local rows that ops still waiting in the outbox changed. A pull must
 * not overwrite them with the server's copy, which predates those ops: the
 * local copy wins until the ops are flushed and pulled back.
 *
 * A `switch` op only names the segment it opens, but locally it also closed
 * the open segment at `at` and trimmed or removed whatever came after `at`.
 * So every segment still open, or ending at or after the earliest pending
 * switch time, counts as touched.
 */
export interface Touched {
  segments: ReadonlySet<string>;
  /** Earliest `at` of a pending switch, epoch ms, or null when none is pending. */
  switchFromMs: number | null;
  categories: ReadonlySet<string>;
  rules: ReadonlySet<string>;
  settings: boolean;
}

export const NOTHING_TOUCHED: Touched = {
  segments: new Set(),
  switchFromMs: null,
  categories: new Set(),
  rules: new Set(),
  settings: false,
};

export function touchedBy(ops: readonly Op[]): Touched {
  if (ops.length === 0) return NOTHING_TOUCHED;
  const segments = new Set<string>();
  const categories = new Set<string>();
  const rules = new Set<string>();
  let settings = false;
  let switchFromMs: number | null = null;
  for (const op of ops) {
    switch (op.type) {
      case 'switch': {
        segments.add(op.payload.newSegmentId);
        const at = toMs(op.payload.at);
        switchFromMs = switchFromMs === null ? at : Math.min(switchFromMs, at);
        break;
      }
      case 'segments.upsert':
        for (const row of op.payload.rows) segments.add(row.id);
        break;
      case 'category.upsert':
        categories.add(op.payload.id);
        break;
      case 'rule.upsert':
        rules.add(op.payload.id);
        break;
      case 'settings.upsert':
        settings = true;
        break;
    }
  }
  return { segments, switchFromMs, categories, rules, settings };
}

export function segmentTouched(t: Touched, s: Segment): boolean {
  if (t.segments.has(s.id)) return true;
  if (t.switchFromMs === null) return false;
  return s.endedAt === null || toMs(s.endedAt) >= t.switchFromMs;
}

export function categoryTouched(t: Touched, c: Category): boolean {
  return t.categories.has(c.id);
}

export function ruleTouched(t: Touched, r: Rule): boolean {
  return t.rules.has(r.id);
}
