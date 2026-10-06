import {
  toMs,
  type Category,
  type DayKey,
  type DaySettings,
  type Segment,
} from '@time-tracker/shared';
import { TriangleAlert } from 'lucide-react';
import type { Change, ChangeKind } from '../data/preview';
import { timeOnDay } from '../lib/format';

const VERB: Record<ChangeKind, string> = {
  removed: 'Removes',
  shortened: 'Shortens',
  extended: 'Extends',
  moved: 'Moves',
  added: 'Adds',
  reopened: 'Continues',
  edited: 'Changes',
};

interface Props {
  changes: readonly Change[];
  categories: ReadonlyMap<string, Category>;
  settings: DaySettings;
  dayKey: DayKey;
  title?: string;
}

function span(s: Segment, dayKey: DayKey, settings: DaySettings): string {
  const start = timeOnDay(toMs(s.startedAt), dayKey, settings);
  const end = s.endedAt === null ? 'now' : timeOnDay(toMs(s.endedAt), dayKey, settings);
  return `${start}–${end}`;
}

/** "This will also change" box listing rows an action touches besides the obvious one. */
export function ChangeList({ changes, categories, settings, dayKey, title }: Props) {
  if (changes.length === 0) return null;
  return (
    <div className="rounded-2xl bg-warn-bg p-3 text-warn-fg" role="note">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <TriangleAlert size={16} aria-hidden />
        {title ?? 'This will also change'}
      </p>
      <ul className="mt-1.5 space-y-1 text-sm">
        {changes.map((c) => {
          const name = categories.get(c.after.categoryId)?.name ?? 'Unknown';
          const shown = c.kind === 'removed' ? (c.before ?? c.after) : c.after;
          const from =
            c.before && (c.kind === 'shortened' || c.kind === 'extended' || c.kind === 'moved')
              ? ` (was ${span(c.before, dayKey, settings)})`
              : '';
          const text =
            c.kind === 'reopened'
              ? `${VERB[c.kind]} ${name} from ${timeOnDay(toMs(c.after.startedAt), dayKey, settings)}`
              : `${VERB[c.kind]} ${name} ${span(shown, dayKey, settings)}${from}`;
          return (
            <li key={c.after.id} className="tabular leading-snug">
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
