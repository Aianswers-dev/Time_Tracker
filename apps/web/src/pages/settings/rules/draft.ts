import type { FieldErrors } from '../../../data/validation';

/**
 * Form state for the nudge fields shared by the rule sheet and the stale
 * check sheet: what the inputs hold as text, and the conversion to stored
 * minutes. Range checks are left to the shared schemas (via the actions);
 * this only catches input that is not a number at all.
 */

export type DurationUnit = 'min' | 'h';

export interface DurationDraft {
  value: string;
  unit: DurationUnit;
}

export interface RepeatDraft {
  once: boolean;
  /** Minutes, as typed. Kept while "once" is picked so switching back restores it. */
  every: string;
}

export interface QuietDraft {
  on: boolean;
  start: string;
  end: string;
}

export interface NudgeDraft {
  threshold: DurationDraft;
  repeat: RepeatDraft;
  quiet: QuietDraft;
}

export interface NudgeValues {
  thresholdMin: number;
  repeatEveryMin: number | null;
  quietStart: string | null;
  quietEnd: string | null;
}

export const DEFAULT_QUIET = { start: '22:00', end: '07:00' } as const;

/** Whole hours show in hours, anything else in minutes. */
export function durationToDraft(min: number): DurationDraft {
  return min % 60 === 0
    ? { value: String(min / 60), unit: 'h' }
    : { value: String(min), unit: 'min' };
}

export function repeatToDraft(min: number | null, fallback = 30): RepeatDraft {
  return { once: min === null, every: String(min ?? fallback) };
}

export function quietToDraft(start: string | null, end: string | null): QuietDraft {
  return start !== null && end !== null
    ? { on: true, start, end }
    : { on: false, start: DEFAULT_QUIET.start, end: DEFAULT_QUIET.end };
}

/** A number as typed, accepting a decimal comma. NaN when it is not one. */
function parseNumber(text: string): number {
  const t = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return Number.NaN;
  return Number(t);
}

/**
 * Minutes for a duration: hours are rounded to the nearest minute, minutes
 * must be whole. Null when the text is not a usable number.
 */
export function draftToMinutes(draft: DurationDraft): number | null {
  const n = parseNumber(draft.value);
  if (!Number.isFinite(n)) return null;
  if (draft.unit === 'h') return Math.round(n * 60);
  return Number.isInteger(n) ? n : null;
}

/** Turn the drafts into stored values, or say which inputs are not numbers. */
export function parseNudgeDraft(
  draft: NudgeDraft,
): { ok: true; values: NudgeValues } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const thresholdMin = draftToMinutes(draft.threshold);
  if (thresholdMin === null) {
    errors.threshold =
      draft.threshold.unit === 'min'
        ? 'Enter a whole number of minutes'
        : 'Enter a number of hours, like 1.5';
  }
  let repeatEveryMin: number | null = null;
  if (!draft.repeat.once) {
    repeatEveryMin = draftToMinutes({ value: draft.repeat.every, unit: 'min' });
    if (repeatEveryMin === null) errors.repeat = 'Enter a whole number of minutes';
  }
  if (draft.quiet.on && (draft.quiet.start === '' || draft.quiet.end === '')) {
    errors.quiet = 'Set both a start and an end, or turn quiet hours off';
  }
  if (thresholdMin === null || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    values: {
      thresholdMin,
      repeatEveryMin,
      quietStart: draft.quiet.on ? draft.quiet.start.slice(0, 5) : null,
      quietEnd: draft.quiet.on ? draft.quiet.end.slice(0, 5) : null,
    },
  };
}
