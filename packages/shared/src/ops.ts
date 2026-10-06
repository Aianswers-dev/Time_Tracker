import { z } from 'zod';
import {
  categorySchema,
  isoSchema,
  ruleSchema,
  segmentSchema,
  segmentSourceSchema,
  settingsSchema,
} from './entities';

/**
 * Outbox operations the client sends to `POST /api/ops` (docs/04-api.md).
 * One user action produces one op, so the server can apply each op atomically.
 */

/** Most ops accepted in one request. The client batches its outbox to this size. */
export const MAX_OPS_PER_REQUEST = 200;

/** Most segment rows in one `segments.upsert` op. */
export const MAX_ROWS_PER_OP = 100;

/**
 * Most `segments.upsert` rows the server applies in one `POST /api/ops`
 * (always at least the first op). Building and checking rows is the Worker's
 * main CPU cost against the Free plan's 10 ms; the client sizes its batches
 * to match so it does not upload rows the server would only send back.
 */
export const MAX_SEGMENT_ROWS_PER_REQUEST = 200;

const opBase = {
  opId: z.uuid(),
  createdAt: isoSchema,
};

/**
 * Close whatever is open at `at` and open `newSegmentId`. The server runs the
 * same `switchCategory` against its own state, so a switch made offline still
 * lands correctly if a Shortcut switched in the meantime.
 */
export const switchOpSchema = z.object({
  ...opBase,
  type: z.literal('switch'),
  payload: z.object({
    categoryId: z.uuid(),
    at: isoSchema,
    newSegmentId: z.uuid(),
    source: segmentSourceSchema,
  }),
});

/** Every edit operation: the full new state of each changed row. Deletes set deletedAt. */
export const segmentsUpsertOpSchema = z.object({
  ...opBase,
  type: z.literal('segments.upsert'),
  payload: z.object({ rows: z.array(segmentSchema).min(1).max(MAX_ROWS_PER_OP) }),
});

export const categoryUpsertOpSchema = z.object({
  ...opBase,
  type: z.literal('category.upsert'),
  payload: categorySchema,
});

export const ruleUpsertOpSchema = z.object({
  ...opBase,
  type: z.literal('rule.upsert'),
  payload: ruleSchema,
});

export const settingsUpsertOpSchema = z.object({
  ...opBase,
  type: z.literal('settings.upsert'),
  payload: settingsSchema,
});

export const opSchema = z.discriminatedUnion('type', [
  switchOpSchema,
  segmentsUpsertOpSchema,
  categoryUpsertOpSchema,
  ruleUpsertOpSchema,
  settingsUpsertOpSchema,
]);
export type Op = z.infer<typeof opSchema>;
export type OpType = Op['type'];
export type SwitchOp = z.infer<typeof switchOpSchema>;
export type SegmentsUpsertOp = z.infer<typeof segmentsUpsertOpSchema>;
