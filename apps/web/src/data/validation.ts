/**
 * Friendly, per-field messages for the nudge forms (rules and the stale
 * check). The shared zod schemas decide what is valid; this only turns their
 * issues into sentences next to the right field.
 */

/** The fields of the rule and stale check forms. */
export type NudgeField = 'category' | 'kind' | 'threshold' | 'repeat' | 'quiet' | 'message';

export type FieldErrors = Partial<Record<NudgeField, string>>;

/** A save refused before anything was written. `fields` says where. */
export class ValidationError extends Error {
  readonly fields: FieldErrors;
  constructor(fields: FieldErrors) {
    super(Object.values(fields)[0] ?? 'Check the highlighted fields');
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/** The subset of a zod issue this reads, so the web app needs no direct zod dependency. */
export interface SchemaIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
}

/** A week, the shared schemas' upper bound for every duration. */
const MAX_LABEL = '7 days (168 h)';

function durationMessage(issue: SchemaIssue, what: string): string {
  if (issue.code === 'too_small') return `${what} must be at least 1 minute`;
  if (issue.code === 'too_big') return `${what} can be at most ${MAX_LABEL}`;
  return `${what} must be a whole number of minutes`;
}

/**
 * Map schema issues to field messages. `fieldOf` names the form field for a
 * schema path key, or null for keys the form does not edit (those are left
 * for the caller, see `validationErrorFromIssues`).
 */
export function fieldErrorsFromIssues(
  issues: readonly SchemaIssue[],
  fieldOf: (key: string) => NudgeField | null,
): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const field = fieldOf(String(issue.path[0] ?? ''));
    if (field === null || out[field]) continue;
    switch (field) {
      case 'threshold':
        out.threshold = durationMessage(issue, 'The limit');
        break;
      case 'repeat':
        out.repeat = durationMessage(issue, 'The repeat');
        break;
      case 'quiet':
        out.quiet =
          issue.code === 'custom'
            ? 'Set both a start and an end, or turn quiet hours off'
            : 'Use times like 22:00';
        break;
      case 'message':
        out.message =
          issue.code === 'too_big' ? 'Keep the message under 200 characters' : 'Check the message';
        break;
      case 'category':
        out.category = 'Pick a category';
        break;
      case 'kind':
        out.kind = 'Pick a session limit or a daily budget';
        break;
    }
  }
  return out;
}

/** Quiet hours from equal times would never be quiet, which is never what was meant. */
export function quietWindowError(start: string | null, end: string | null): string | null {
  if (start !== null && start === end) {
    return 'Start and end are the same, so it would never be quiet';
  }
  return null;
}

/**
 * The error for a failed schema check: field messages when the form can show
 * them, else a plain error naming the first problem (a bug, not a typo).
 */
export function validationErrorFromIssues(
  issues: readonly SchemaIssue[],
  fieldOf: (key: string) => NudgeField | null,
  what: string,
): Error {
  const fields = fieldErrorsFromIssues(issues, fieldOf);
  if (Object.keys(fields).length > 0) return new ValidationError(fields);
  const first = issues[0];
  const where = first ? first.path.map(String).join('.') : '';
  return new Error(
    `Couldn’t save ${what}: ${where ? `${where}: ` : ''}${first?.message ?? 'invalid'}`,
  );
}
