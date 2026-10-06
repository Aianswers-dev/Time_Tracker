import { SegmentOpError, type ErrorCode } from '@time-tracker/shared';

/** A failure that becomes an op result (`ok: false`) or an HTTP error, never a 500. */
export class OpFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpFailure';
  }
}

/** Shared segment errors in API terms: `in_future` is `switch_in_future`, the rest `validation_failed`. */
export function fromSegmentError(err: SegmentOpError): OpFailure {
  const code: ErrorCode = err.code === 'in_future' ? 'switch_in_future' : 'validation_failed';
  return new OpFailure(code, err.message);
}

function messages(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    out.push(cur.message);
    cur = cur.cause;
  }
  return out;
}

/**
 * Constraint errors from D1 that mean the request was wrong, not the server.
 * They only happen when a concurrent request changed the data between our
 * checks and the write, because every op checks these conditions first.
 */
export function fromDbError(err: unknown): OpFailure | null {
  const text = messages(err).join(' | ');
  if (/UNIQUE constraint failed.*segments_one_open/i.test(text)) {
    return new OpFailure('conflict', 'Another segment is already open');
  }
  if (/FOREIGN KEY constraint failed/i.test(text)) {
    return new OpFailure('validation_failed', 'Unknown category');
  }
  if (/CHECK constraint failed/i.test(text)) {
    return new OpFailure('validation_failed', 'A value is out of range');
  }
  return null;
}

/** Any thrown value as an OpFailure, or null for unexpected errors (which become a 500). */
export function toOpFailure(err: unknown): OpFailure | null {
  if (err instanceof OpFailure) return err;
  if (err instanceof SegmentOpError) return fromSegmentError(err);
  return fromDbError(err);
}
