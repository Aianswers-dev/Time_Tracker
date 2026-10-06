import {
  addDaysToKey,
  localDateTimeToMs,
  type Category,
  type DayTimeline,
  type DaySettings,
  type TimelineBlock,
} from '@time-tracker/shared';

interface Props {
  timeline: DayTimeline;
  settings: DaySettings;
  categories: ReadonlyMap<string, Category>;
  onSelect: (block: TimelineBlock) => void;
}

const TICK_OFFSETS = [0, 6, 12, 18, 24] as const;

function pct(ms: number, timeline: DayTimeline): number {
  return ((ms - timeline.start) / (timeline.end - timeline.start)) * 100;
}

/**
 * The logical day as one horizontal bar from dayStartHour to the next
 * dayStartHour: coloured blocks for entries, hatched blocks for untracked gaps,
 * a line at now. Tiny blocks keep a minimum width so they stay visible.
 */
export function DayBar({ timeline, settings, categories, onSelect }: Props) {
  const ticks = TICK_OFFSETS.map((k) => {
    const hour = settings.dayStartHour + k;
    const date = hour >= 24 ? addDaysToKey(timeline.dayKey, 1) : timeline.dayKey;
    const hh = String(hour % 24).padStart(2, '0');
    const ms = localDateTimeToMs(date, `${hh}:00`, settings.timezone);
    return { k, label: hh, left: pct(ms, timeline) };
  });

  return (
    <div>
      <div
        className="relative h-14 overflow-hidden rounded-2xl border border-line bg-surface-2"
        data-testid="day-bar"
      >
        {timeline.blocks.map((b) => {
          const left = pct(b.start, timeline);
          const width = pct(b.end, timeline) - left;
          const category = b.kind === 'segment' ? categories.get(b.categoryId) : undefined;
          const label =
            b.kind === 'gap' ? 'Untracked time' : `${category?.name ?? 'Unknown'} entry`;
          return (
            <button
              key={b.kind === 'segment' ? b.segmentId : `gap-${b.start}`}
              type="button"
              aria-label={label}
              onClick={() => onSelect(b)}
              className={`absolute inset-y-0 border-r border-[var(--surface)] ${
                b.kind === 'gap' ? 'hatched' : ''
              }`}
              style={{
                left: `${left}%`,
                width: `max(4px, ${width}%)`,
                backgroundColor: b.kind === 'segment' ? (category?.color ?? '#6b7a90') : undefined,
              }}
            />
          );
        })}
        {timeline.now !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--now)]"
            style={{ left: `${pct(timeline.now, timeline)}%` }}
          >
            <span className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-[var(--now)]" />
          </span>
        )}
      </div>
      <div className="tabular relative mt-1 h-4 text-[11px] text-muted" aria-hidden>
        {ticks.map((t, i) => (
          <span
            key={t.k}
            className="absolute"
            style={{
              left: `${t.left}%`,
              transform:
                i === 0
                  ? 'none'
                  : i === ticks.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
