import { categorySchema, uuidv7, type Category } from '@time-tracker/shared';
import { db } from '../db';
import { categoryUpsertOp, enqueue, ruleUpsertOp } from './outbox';

/**
 * Category edits. Each writes the category row(s) and queues one
 * `category.upsert` op per changed row in the same transaction.
 */

export type CategoryDraft = Pick<Category, 'name' | 'color' | 'icon' | 'exemptFromStaleCheck'>;

export class CategoryError extends Error {}

async function liveCategories(): Promise<Category[]> {
  return db.categories.filter((c) => c.deletedAt === null).toArray();
}

async function assertUniqueName(name: string, exceptId: string | null): Promise<void> {
  const key = name.trim().toLowerCase();
  const clash = (await liveCategories()).find(
    (c) => c.id !== exceptId && c.name.trim().toLowerCase() === key,
  );
  if (clash) throw new CategoryError(`“${clash.name}” already exists`);
}

/** Validate a full row with the shared schema, surfacing the first problem as a message. */
function validated(row: Category): Category {
  const parsed = categorySchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === 'name' ? 'Name' : String(issue?.path[0] ?? 'Category');
    throw new CategoryError(`${field}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

async function write(rows: Category[], now: string): Promise<void> {
  await db.categories.bulkPut(rows);
  await enqueue(...rows.map((c) => categoryUpsertOp(c, now)));
}

export async function addCategory(draft: CategoryDraft): Promise<Category> {
  return db.transaction('rw', db.categories, db.outbox, async () => {
    const now = new Date().toISOString();
    await assertUniqueName(draft.name, null);
    const all = await db.categories.toArray();
    const maxOrder = all.reduce((m, c) => Math.max(m, c.sortOrder), 0);
    const row = validated({
      id: uuidv7(),
      ...draft,
      name: draft.name.trim(),
      sortOrder: maxOrder + 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await write([row], now);
    return row;
  });
}

type CategoryPatch = Partial<Pick<Category, keyof CategoryDraft | 'archivedAt'>>;

export async function updateCategory(id: string, patch: CategoryPatch): Promise<Category> {
  return db.transaction('rw', db.categories, db.outbox, async () => {
    const now = new Date().toISOString();
    const current = await db.categories.get(id);
    if (!current || current.deletedAt !== null) throw new CategoryError('Category not found');
    if (patch.name !== undefined) await assertUniqueName(patch.name, id);
    const next = validated({
      ...current,
      ...patch,
      name: (patch.name ?? current.name).trim(),
      updatedAt: now,
    });
    const unchanged = (Object.keys(patch) as (keyof CategoryPatch)[]).every(
      (k) => next[k] === current[k],
    );
    if (unchanged) return current;
    await write([next], now);
    return next;
  });
}

export function setArchived(id: string, archived: boolean): Promise<Category> {
  return updateCategory(id, { archivedAt: archived ? new Date().toISOString() : null });
}

/**
 * Move a category one place up or down among live categories by swapping
 * sortOrder with its neighbour. Two rows change, so two ops are queued.
 */
export async function moveCategory(id: string, direction: -1 | 1): Promise<void> {
  await db.transaction('rw', db.categories, db.outbox, async () => {
    const now = new Date().toISOString();
    const list = (await liveCategories()).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    );
    const i = list.findIndex((c) => c.id === id);
    const j = i + direction;
    const a = list[i];
    const b = list[j];
    if (i < 0 || !a || !b) return;
    // Equal sortOrders (possible after a sync merge) would make a swap a no-op.
    const aOrder = a.sortOrder === b.sortOrder ? b.sortOrder + direction : b.sortOrder;
    await write(
      [
        { ...a, sortOrder: aOrder, updatedAt: now },
        { ...b, sortOrder: a.sortOrder, updatedAt: now },
      ],
      now,
    );
  });
}

/** Number of live segments in a category, via the categoryId index. */
export function countSegments(categoryId: string): Promise<number> {
  return db.segments
    .where('categoryId')
    .equals(categoryId)
    .filter((s) => s.deletedAt === null)
    .count();
}

/**
 * Soft-delete a category that has never been used. Its rules go with it, since
 * a rule for a deleted category can never fire.
 */
export async function deleteCategory(id: string): Promise<void> {
  await db.transaction('rw', [db.categories, db.segments, db.rules, db.outbox], async () => {
    const now = new Date().toISOString();
    const current = await db.categories.get(id);
    if (!current || current.deletedAt !== null) return;
    if ((await countSegments(id)) > 0) {
      throw new CategoryError('This category has entries. Archive it instead.');
    }
    const row: Category = { ...current, deletedAt: now, updatedAt: now };
    await write([row], now);
    const rules = await db.rules
      .where('categoryId')
      .equals(id)
      .filter((r) => r.deletedAt === null)
      .toArray();
    if (rules.length > 0) {
      const deleted = rules.map((r) => ({ ...r, deletedAt: now, updatedAt: now }));
      await db.rules.bulkPut(deleted);
      await enqueue(...deleted.map((r) => ruleUpsertOp(r, now)));
    }
  });
}
