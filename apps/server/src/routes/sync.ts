import {
  isoSchema,
  MAX_OPS_PER_REQUEST,
  toIso,
  toMs,
  type OpsResponse,
  type SnapshotResponse,
} from '@time-tracker/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDb } from '../db/client';
import { rowsSyncedAfter } from '../db/queries';
import type { AppEnv } from '../env';
import { readJson, readQuery } from '../http';
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

const snapshotQuerySchema = z.object({ since: isoSchema.optional() });

syncRoutes.get('/snapshot', async (c) => {
  const { since } = readQuery(c, snapshotQuerySchema);
  // Read the clock before the data, so nothing written after the reads can
  // carry a synced_at earlier than the cursor handed back.
  const serverTime = new Date().toISOString();
  const db = createDb(c.env.DB);
  const after = since === undefined ? null : toIso(toMs(since) - SNAPSHOT_OVERLAP_MS);
  const rows = await rowsSyncedAfter(db, after);
  const body: SnapshotResponse = { serverTime, ...rows };
  return c.json(body);
});
