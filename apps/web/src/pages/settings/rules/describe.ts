import type { Rule, RuleKind, Settings } from '@time-tracker/shared';

/** Plain-language labels and previews for nudge rules and the stale check. */

/** "45m", "1h", "1h 30m". Whole minutes in, as stored. */
export function formatMinutes(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const KIND_LABEL: Record<RuleKind, string> = {
  session: 'Session limit',
  daily: 'Daily budget',
};

/** One line on what each kind measures. */
export function kindExplanation(kind: RuleKind, dayStartHour: number): string {
  if (kind === 'session') return 'One unbroken stretch. Starts over whenever you switch.';
  const hh = String(dayStartHour).padStart(2, '0');
  return `Your total for the day, counted from ${hh}:00 to ${hh}:00.`;
}

/** "Quiet 22:00–07:00", or null without quiet hours. */
export function describeQuiet(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  return `Quiet ${start}–${end}`;
}

/**
 * "Nudges you after 1h of Relaxing in a row, then every 30m", or the daily
 * "Nudges you when Relaxing reaches 3h in a day, then every 1h".
 */
export function describeRule(
  rule: Pick<Rule, 'kind' | 'thresholdMin' | 'repeatEveryMin'>,
  categoryName: string,
): string {
  const limit = formatMinutes(rule.thresholdMin);
  const once = rule.repeatEveryMin === null;
  const then = once ? '' : `, then every ${formatMinutes(rule.repeatEveryMin ?? 0)}`;
  if (rule.kind === 'session') {
    return `Nudges you ${once ? 'once ' : ''}after ${limit} of ${categoryName} in a row${then}`;
  }
  return `Nudges you ${once ? 'once ' : ''}when ${categoryName} reaches ${limit} in a day${then}`;
}

/** "Sleep", "Sleep and Hobbies", "Sleep, Uni study and Hobbies". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/**
 * "Asks “Still on it?” when anything except Sleep runs 5h without a switch,
 * then every 1h".
 */
export function describeStale(
  settings: Pick<Settings, 'staleEnabled' | 'staleAfterMin' | 'staleRepeatMin'>,
  exemptNames: readonly string[],
): string {
  if (!settings.staleEnabled) {
    return 'Off. Turn it on to be asked “Still on it?” when something runs implausibly long.';
  }
  const scope = exemptNames.length > 0 ? `anything except ${joinNames(exemptNames)}` : 'anything';
  const once = settings.staleRepeatMin === null;
  const then = once ? '' : `, then every ${formatMinutes(settings.staleRepeatMin ?? 0)}`;
  return `Asks “Still on it?” ${once ? 'once ' : ''}when ${scope} runs ${formatMinutes(
    settings.staleAfterMin,
  )} without a switch${then}`;
}
