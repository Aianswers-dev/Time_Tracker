import {
  switchCategory,
  toMs,
  uuidv7,
  type Segment,
  type SegmentSource,
  type SwitchResult,
} from '@time-tracker/shared';
import type { Db } from '../db/client';
import { writeSegments } from '../db/writes';

export interface SwitchInput {
  categoryId: string;
  /** When the new activity started. Defaults to now. */
  at?: string;
  /** Id for the new segment. Generated when absent. */
  newSegmentId?: string;
  source: SegmentSource;
  /** When the switch was made, for an op applied later. See shared `switchCategory`. */
  madeAt?: string;
}

/**
 * The earliest instant a switch at `at` can change: it clears [at, ∞), so only
 * live segments that end after this (or are open) need loading.
 * A future `at` is clamped to now the same way the shared code clamps it.
 */
export function switchWindowStart(at: string | undefined, now: string): number {
  return at === undefined ? toMs(now) : Math.min(toMs(at), toMs(now));
}

/**
 * Run the shared `switchCategory` against the server's segments, which must
 * include every live segment ending after `switchWindowStart` plus the open
 * one. The server's clock is `now`; new ids are UUID v7.
 *
 * Throws `SegmentOpError` (e.g. `in_future`) from the shared code unchanged.
 */
export function computeSwitch(
  current: readonly Segment[],
  input: SwitchInput,
  now: string,
): SwitchResult {
  return switchCategory(
    current,
    {
      categoryId: input.categoryId,
      at: input.at,
      newSegmentId: input.newSegmentId,
      source: input.source,
      madeAt: input.madeAt,
    },
    { now, newId: () => uuidv7() },
  );
}

/** Write a switch result as one batch. Server-computed rows skip the LWW guard. */
export async function writeSwitch(db: Db, result: SwitchResult, now: string): Promise<void> {
  if (result.noop) return;
  await writeSegments(db, result.rows, { syncedAt: now, lww: false });
}
