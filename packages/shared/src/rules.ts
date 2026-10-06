import type {
  Category,
  NotificationKind,
  NotificationLogEntry,
  Rule,
  Segment,
  Settings,
} from './entities';
import {
  dayKeyOf,
  formatDuration,
  isInQuietWindow,
  localHHMM,
  MINUTE_MS,
  toMs,
  wholeMinutes,
  type ISO,
} from './time';

/**
 * The nudge rule engine from docs/03-data-model.md. Pure: the server's cron
 * gathers the inputs once a minute, calls `evaluateRules`, logs what it returns
 * and sends each notification.
 */

export interface RuleEngineInput {
  now: ISO;
  settings: Settings;
  /** The live open segment, or null before tracking starts. */
  openSegment: Segment | null;
  /** The open segment's category. */
  category: Category | null;
  /** Rules to consider. Disabled, deleted and other categories' rules are ignored. */
  rules: readonly Rule[];
  /**
   * Milliseconds spent on the open segment's category in the current logical
   * day, including the open segment up to now.
   */
  todayMs: number;
  /** Log rows for the open segment and for today's day key. Extra rows are harmless. */
  log: readonly NotificationLogEntry[];
}

export interface PendingNotification {
  kind: NotificationKind;
  ruleId: string | null;
  segmentId: string | null;
  dayKey: string | null;
  title: string;
  body: string;
  /** Collapses repeats of the same nudge on the device. */
  tag: string;
}

/**
 * Cron runs drift by a few seconds, so a repeat is due once at least this much
 * less than the repeat interval has passed. Without it a 30 minute repeat would
 * usually fire at 31 minutes.
 */
export const REPEAT_TOLERANCE_MS = 30_000;

function lastSentMs(entries: readonly NotificationLogEntry[]): number | null {
  let last: number | null = null;
  for (const e of entries) {
    const t = toMs(e.sentAt);
    if (last === null || t > last) last = t;
  }
  return last;
}

/** The rule's custom body, or null when it has none. A blank message counts as none. */
function customBody(rule: Rule): string | null {
  return rule.message !== null && rule.message.trim() !== '' ? rule.message : null;
}

function isDue(
  over: boolean,
  last: number | null,
  repeatEveryMin: number | null,
  nowMs: number,
): boolean {
  if (!over) return false;
  if (last === null) return true;
  if (repeatEveryMin === null) return false;
  return nowMs - last >= repeatEveryMin * MINUTE_MS - REPEAT_TOLERANCE_MS;
}

export function evaluateRules(input: RuleEngineInput): PendingNotification[] {
  const { openSegment: open, category, settings } = input;
  if (!open || open.deletedAt !== null || open.endedAt !== null) return [];
  if (!category || category.id !== open.categoryId) return [];
  if (category.archivedAt !== null || category.deletedAt !== null) return [];

  const nowMs = toMs(input.now);
  const sessionMs = Math.max(0, nowMs - toMs(open.startedAt));
  const sessionMin = wholeMinutes(sessionMs);
  const todayMin = wholeMinutes(input.todayMs);
  const today = dayKeyOf(nowMs, settings);
  const hhmm = localHHMM(nowMs, settings.timezone);
  const name = category.name;
  const out: PendingNotification[] = [];

  const rules = input.rules.filter(
    (r) => r.enabled && r.deletedAt === null && r.categoryId === category.id,
  );

  for (const rule of rules.filter((r) => r.kind === 'session')) {
    if (isInQuietWindow(hhmm, rule.quietStart, rule.quietEnd)) continue;
    const last = lastSentMs(
      input.log.filter(
        (e) => e.kind === 'session' && e.ruleId === rule.id && e.segmentId === open.id,
      ),
    );
    if (!isDue(sessionMin >= rule.thresholdMin, last, rule.repeatEveryMin, nowMs)) continue;
    const duration = formatDuration(sessionMs);
    out.push({
      kind: 'session',
      ruleId: rule.id,
      segmentId: open.id,
      dayKey: null,
      title: `${name} for ${duration}`,
      body:
        customBody(rule) ??
        `You've been on ${name} for ${duration} straight. Time to switch it up.`,
      tag: `session:${rule.id}`,
    });
  }

  for (const rule of rules.filter((r) => r.kind === 'daily')) {
    if (isInQuietWindow(hhmm, rule.quietStart, rule.quietEnd)) continue;
    const last = lastSentMs(
      input.log.filter((e) => e.kind === 'daily' && e.ruleId === rule.id && e.dayKey === today),
    );
    if (!isDue(todayMin >= rule.thresholdMin, last, rule.repeatEveryMin, nowMs)) continue;
    out.push({
      kind: 'daily',
      ruleId: rule.id,
      segmentId: null,
      dayKey: today,
      title: `${formatDuration(input.todayMs)} of ${name} today`,
      body:
        customBody(rule) ??
        `That's past your ${formatDuration(rule.thresholdMin * MINUTE_MS)} budget for today.`,
      tag: `daily:${rule.id}`,
    });
  }

  if (
    settings.staleEnabled &&
    !category.exemptFromStaleCheck &&
    !isInQuietWindow(hhmm, settings.staleQuietStart, settings.staleQuietEnd)
  ) {
    const last = lastSentMs(input.log.filter((e) => e.kind === 'stale' && e.segmentId === open.id));
    if (isDue(sessionMin >= settings.staleAfterMin, last, settings.staleRepeatMin, nowMs)) {
      out.push({
        kind: 'stale',
        ruleId: null,
        segmentId: open.id,
        dayKey: null,
        title: `Still on ${name}?`,
        body: `It's been ${formatDuration(sessionMs)}. Tap to update if you've moved on.`,
        tag: 'stale',
      });
    }
  }

  return out;
}
