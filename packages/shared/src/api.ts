import { z } from 'zod';

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
