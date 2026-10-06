import {
  opSchema,
  SEED_CATEGORY_IDS,
  toIso,
  uuidv7,
  type Op,
  type Segment,
} from '@time-tracker/shared';
import { db } from '../db';

/** Test helpers for the data layer. Not imported by the app. */

export const CAT = SEED_CATEGORY_IDS;

export async function resetDb(): Promise<void> {
  db.close();
  await db.delete();
  await db.open();
}

export function seg(
  categoryId: string,
  startMs: number,
  endMs: number | null,
  patch: Partial<Segment> = {},
): Segment {
  const at = toIso(startMs);
  return {
    id: uuidv7(startMs),
    categoryId,
    startedAt: at,
    endedAt: endMs === null ? null : toIso(endMs),
    note: null,
    source: 'app',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...patch,
  };
}

export async function allOps(): Promise<Op[]> {
  const rows = await db.outbox.orderBy('seq').toArray();
  return rows.map((r) => r.op);
}

/** Ops queued after the first `skip` (the seed ops), each checked against the shared schema. */
export async function opsAfter(skip: number): Promise<Op[]> {
  const ops = (await allOps()).slice(skip);
  for (const op of ops) opSchema.parse(op);
  return ops;
}

export async function liveSegments(): Promise<Segment[]> {
  return (await db.segments.toArray()).filter((s) => s.deletedAt === null);
}
