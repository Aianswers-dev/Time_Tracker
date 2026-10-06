import { z } from 'zod';
import {
  categorySchema,
  isoSchema,
  ruleSchema,
  segmentSchema,
  segmentSourceSchema,
  settingsSchema,
} from './entities';
import { MAX_OPS_PER_REQUEST, opSchema } from './ops';

/** Error codes from docs/04-api.md. */
export const errorCodeSchema = z.enum([
  'unauthorized',
  'validation_failed',
  'not_found',
  'conflict',
  'switch_before_open_start',
  'switch_in_future',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Every non-2xx API response has this shape. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** `GET /api/health`, the only route that needs no token. */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  time: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** One category's total in `GET /api/state`. */
export const stateTotalSchema = z.object({
  categoryId: z.uuid(),
  name: z.string(),
  color: z.string(),
  icon: z.string(),
  minutes: z.number().int().min(0),
});

/** `GET /api/state`: what is running now and today's totals. For the widget and Shortcuts. */
export const stateResponseSchema = z.object({
  now: isoSchema,
  open: z
    .object({
      segment: segmentSchema,
      category: categorySchema,
      elapsedMin: z.number().int().min(0),
    })
    .nullable(),
  today: z.object({
    dayKey: z.string(),
    totals: z.array(stateTotalSchema),
    untrackedMin: z.number().int().min(0),
  }),
});
export type StateResponse = z.infer<typeof stateResponseSchema>;

/** `POST /api/switch`: switch by category name (Shortcuts, Siri) or id. */
export const switchRequestSchema = z
  .object({
    categoryName: z.string().trim().min(1).optional(),
    categoryId: z.uuid().optional(),
    at: isoSchema.optional(),
    id: z.uuid().optional(),
    source: segmentSourceSchema.default('shortcut'),
  })
  .refine((r) => r.categoryName !== undefined || r.categoryId !== undefined, {
    message: 'Give categoryName or categoryId',
    path: ['categoryName'],
  });
export type SwitchRequest = z.input<typeof switchRequestSchema>;

export const switchResponseSchema = z.object({
  noop: z.boolean(),
  /** "Switched to Relaxing" or "Already on Relaxing", for a Shortcut to show or speak. */
  message: z.string(),
  category: categorySchema,
  closed: segmentSchema.nullable(),
  opened: segmentSchema.nullable(),
});
export type SwitchResponse = z.infer<typeof switchResponseSchema>;

/** `POST /api/ops`: the client outbox. */
export const opsRequestSchema = z.object({
  ops: z.array(opSchema).min(1).max(MAX_OPS_PER_REQUEST),
});
export type OpsRequest = z.infer<typeof opsRequestSchema>;

export const opResultSchema = z.object({
  opId: z.string(),
  ok: z.boolean(),
  error: z.object({ code: errorCodeSchema, message: z.string() }).optional(),
});
export type OpResult = z.infer<typeof opResultSchema>;

export const opsResponseSchema = z.object({
  results: z.array(opResultSchema),
  serverTime: isoSchema,
});
export type OpsResponse = z.infer<typeof opsResponseSchema>;

/**
 * `GET /api/snapshot?since=`: every row the server wrote after `since`
 * (server time), including soft-deleted rows. Without `since`, everything.
 */
export const snapshotResponseSchema = z.object({
  serverTime: isoSchema,
  categories: z.array(categorySchema),
  segments: z.array(segmentSchema),
  rules: z.array(ruleSchema),
  settings: settingsSchema.nullable(),
});
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

/** `POST /api/push/subscriptions`: the browser's PushSubscription.toJSON() plus a label. */
export const pushSubscriptionRequestSchema = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(300).optional(),
});
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

export const pushSubscriptionResponseSchema = z.object({ id: z.string() });

export const vapidKeyResponseSchema = z.object({ key: z.string().min(1) });

export const pushTestResponseSchema = z.object({
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type PushTestResponse = z.infer<typeof pushTestResponseSchema>;

/** The payload the server sends through Web Push and the service worker shows. */
export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  data: z.object({ url: z.string() }),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;
