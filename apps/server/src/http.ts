import type { ApiError, ErrorCode } from '@time-tracker/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/**
 * Thrown by handlers to answer with the error shape from docs/04-api.md.
 * `app.onError` turns it into the response.
 */
export class ApiException extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiException';
  }

  toBody(): ApiError {
    const error: ApiError['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return c.json(new ApiException(status, code, message, details).toBody(), status);
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** Zod issues as `{ path: "ops.0.payload.at", message, code }`, for `details.issues`. */
export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
    code: i.code,
  }));
}

/** One line naming the first problem, e.g. "payload.at: Invalid ISO datetime (and 2 more)". */
export function summarizeIssues(issues: readonly ValidationIssue[]): string {
  const first = issues[0];
  if (!first) return 'Invalid input';
  const head = first.path === '' ? first.message : `${first.path}: ${first.message}`;
  return issues.length > 1 ? `${head} (and ${issues.length - 1} more)` : head;
}

export function validationFailed(error: z.ZodError): ApiException {
  const issues = zodIssues(error);
  return new ApiException(400, 'validation_failed', summarizeIssues(issues), { issues });
}

/** Parse `value` with `schema` or throw `validation_failed` with the zod issues as details. */
export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationFailed(result.error);
  return result.data;
}

/** The JSON body, validated. A body that is not JSON is `validation_failed` too. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiException(400, 'validation_failed', 'Request body must be JSON', {
      issues: [{ path: '', message: 'Request body must be JSON', code: 'invalid_json' }],
    });
  }
  return validate(schema, raw);
}

/** The query string, validated. Repeated keys keep the first value. */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return validate(schema, c.req.query());
}
