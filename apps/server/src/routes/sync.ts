import {
  isoSchema,
  MAX_OPS_PER_REQUEST,
  SNAPSHOT_PAGE_SIZE,
  toIso,
  toMs,
  type OpsResponse,
  type SnapshotResponse,
} from '@time-tracker/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDb } from '../db/client';
import { decodeSnapshotCursor, snapshotPage } from '../db/queries';
import type { AppEnv } from '../env';
import { ApiException, readJson, readQuery } from '../http';
import { applyOps, systemClock } from '../sync/ops';

export const syncRoutes = new Hono<AppEnv>();

/**
 * The request envelope. Each op is validated on its own with the shared
 * `opSchema`, so one malformed op fails alone (`validation_failed` in its
 * result) instead of blocking the whole outbox.
 */
const opsEnvelopeSchema = z.object({
  ops: z
    .array(z.looseObject({ opId: z.string().min(1).max(100) }))
    .min(1)
    .max(MAX_OPS_PER_REQUEST),
});

syncRoutes.post('/ops', async (c) => {
  const { ops } = await readJson(c, opsEnvelopeSchema);
  const db = createDb(c.env.DB);
  const results = await applyOps(db, ops, systemClock);
  const body: OpsResponse = { results, serverTime: new Date().toISOString() };
  return c.json(body);
});

/**
 * How far before `since` the snapshot looks. A write stamps `synced_at` when
 * its op starts and commits a moment later, so a snapshot taken in between
 * would not see it and the next one, starting at that snapshot's
 * `serverTime`, would skip it. Re-reading a short overlap closes that gap; the
 * client overwrites rows with the server's copy, so repeats are harmless.
 */
export const SNAPSHOT_OVERLAP_MS = 10_000;

const snapshotQuerySchema = z.object({
  since: isoSchema.optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

syncRoutes.get('/snapshot', async (c) => {
  const query = readQuery(c, snapshotQuerySchema);
  // Read the clock before the data, so nothing written after the reads can
  // carry a synced_at earlier than the cursor handed back.
  const serverTime = new Date().toISOString();
  const cursor = query.cursor === undefined ? null : decodeSnapshotCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    throw new ApiException(400, 'validation_failed', 'Invalid snapshot cursor', {
      issues: [{ path: 'cursor', message: 'Not a cursor this server handed out' }],
    });
  }
  const db = createDb(c.env.DB);
  const since = query.since === undefined ? null : toIso(toMs(query.since) - SNAPSHOT_OVERLAP_MS);
  const page = await snapshotPage(db, since, cursor, query.limit ?? SNAPSHOT_PAGE_SIZE);
  const body: SnapshotResponse = { serverTime, ...page };
  return c.json(body);
});
