import { z } from 'zod';

/**
 * ISO 8601 UTC timestamp. Accepts any precision on input and normalises to
 * `Date.prototype.toISOString()` form ("2026-10-02T03:15:00.000Z"), so stored
 * timestamps always compare correctly as strings.
 */
export const isoSchema = z.iso.datetime().transform((s) => new Date(s).toISOString());

/** Local wall-clock time "HH:MM", 24-hour. */
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export type HHMM = z.infer<typeof hhmmSchema>;

/** IANA timezone name the runtime understands, e.g. "Australia/Sydney". */
export const timezoneSchema = z.string().refine(isValidTimezone, 'Unknown timezone');

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

const syncedFields = {
  createdAt: isoSchema,
  updatedAt: isoSchema,
  deletedAt: isoSchema.nullable(),
};

export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(40),
  color: hexColorSchema,
  /** A lucide icon name in kebab-case, e.g. "cooking-pot". */
  icon: z.string().min(1).max(40),
  sortOrder: z.number().int(),
  exemptFromStaleCheck: z.boolean(),
  archivedAt: isoSchema.nullable(),
  ...syncedFields,
});
export type Category = z.infer<typeof categorySchema>;

export const segmentSourceSchema = z.enum(['app', 'shortcut', 'edit']);
export type SegmentSource = z.infer<typeof segmentSourceSchema>;

export const segmentSchema = z
  .object({
    id: z.uuid(),
    categoryId: z.uuid(),
    startedAt: isoSchema,
    /** null means this is the open segment. */
    endedAt: isoSchema.nullable(),
    note: z.string().max(500).nullable(),
    source: segmentSourceSchema,
    ...syncedFields,
  })
  .refine((s) => s.endedAt === null || s.startedAt < s.endedAt, {
    message: 'endedAt must be after startedAt',
    path: ['endedAt'],
  });
export type Segment = z.infer<typeof segmentSchema>;

export const ruleKindSchema = z.enum(['session', 'daily']);
export type RuleKind = z.infer<typeof ruleKindSchema>;

/** One week in minutes. Thresholds above this are certainly mistakes. */
const MAX_MINUTES = 7 * 24 * 60;

export const ruleSchema = z
  .object({
    id: z.uuid(),
    categoryId: z.uuid(),
    kind: ruleKindSchema,
    thresholdMin: z.number().int().min(1).max(MAX_MINUTES),
    /** null fires once per segment (session) or once per day (daily). */
    repeatEveryMin: z.number().int().min(1).max(MAX_MINUTES).nullable(),
    quietStart: hhmmSchema.nullable(),
    quietEnd: hhmmSchema.nullable(),
    message: z.string().trim().max(200).nullable(),
    enabled: z.boolean(),
    ...syncedFields,
  })
  .refine((r) => (r.quietStart === null) === (r.quietEnd === null), {
    message: 'Set both quiet hours or neither',
    path: ['quietEnd'],
  });
export type Rule = z.infer<typeof ruleSchema>;

export const SETTINGS_ID = 'singleton';

export const settingsSchema = z
  .object({
    id: z.literal(SETTINGS_ID),
    timezone: timezoneSchema,
    /** Local hour, 0 to 23, at which a logical day starts. */
    dayStartHour: z.number().int().min(0).max(23),
    staleEnabled: z.boolean(),
    staleAfterMin: z.number().int().min(1).max(MAX_MINUTES),
    staleRepeatMin: z.number().int().min(1).max(MAX_MINUTES).nullable(),
    staleQuietStart: hhmmSchema.nullable(),
    staleQuietEnd: hhmmSchema.nullable(),
    updatedAt: isoSchema,
  })
  .refine((s) => (s.staleQuietStart === null) === (s.staleQuietEnd === null), {
    message: 'Set both quiet hours or neither',
    path: ['staleQuietEnd'],
  });
export type Settings = z.infer<typeof settingsSchema>;

export const notificationKindSchema = z.enum(['session', 'daily', 'stale']);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** Server-side record of a sent nudge. The dedupe source of truth for the rule engine. */
export interface NotificationLogEntry {
  id: string;
  kind: NotificationKind;
  ruleId: string | null;
  segmentId: string | null;
  dayKey: string | null;
  sentAt: string;
  title: string;
  body: string;
}
