import type { Op } from '@time-tracker/shared';
import { db } from '../db';

/** What an op changed, in words, for "Couldn't sync: …". */
export async function describeOp(op: Op): Promise<string> {
  switch (op.type) {
    case 'switch': {
      const category = await db.categories.get(op.payload.categoryId);
      return category ? `switch to ${category.name}` : 'a category switch';
    }
    case 'segments.upsert': {
      const n = op.payload.rows.length;
      return n === 1 ? 'an edit to one entry' : `an edit to ${n} entries`;
    }
    case 'category.upsert':
      return `changes to ${op.payload.name}`;
    case 'rule.upsert':
      return 'a nudge rule change';
    case 'settings.upsert':
      return 'a settings change';
  }
}

/** One toast for every change the server refused in a sync round. */
export function failureSummary(what: readonly string[]): string | null {
  const [first] = what;
  if (first === undefined) return null;
  const more = what.length - 1;
  if (more === 0) return `Couldn't sync: ${first}`;
  return `Couldn't sync: ${first} and ${more} more ${more === 1 ? 'change' : 'changes'}`;
}
