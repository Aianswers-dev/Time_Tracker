import {
  addDaysToKey,
  localDateTimeToMs,
  type Category,
  type DayTimeline,
  type DaySettings,
  type TimelineBlock,
} from '@time-tracker/shared';
import { blockKey } from './blocks';

interface Props {
  timeline: DayTimeline;
  settings: DaySettings;
  categories: ReadonlyMap<string, Category>;
  /** Key of the selected block (see `blockKey`), or null. */
  selected: string | null;
  onSelect: (block: TimelineBlock) => void;
  /** Accessible name for a block, e.g. "Housework, 06:28–07:13". */
  describe: (block: TimelineBlock) => string;
}

const TICK_OFFSETS = [0, 6, 12, 18, 24] as const;

function pct(ms: number, timeline: DayTimeline): number {
  return ((ms - timeline.start) / (timeline.end - timeline.start)) * 100;
}

/**
 * The logical day as one horizontal bar from dayStartHour to the next
 * dayStartHour: coloured blocks for entries, hatched blocks for untracked gaps,
 * a line at now. Blocks keep a minimum width so short ones stay visible, and a
 * 2 px gap in the bar colour separates neighbours, so similar colours never
 * merge. Tapping a block selects it; the screen then names it.
 */
export function DayBar({ timeline, settings, categories, selected, onSelect, describe }: Props) {
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
          const key = blockKey(b);
          const isSelected = key === selected;
          const color =
            b.kind === 'segment' ? (categories.get(b.categoryId)?.color ?? '#5b6677') : undefined;
          return (
            <button
              key={key}
              type="button"
              aria-label={describe(b)}
              aria-pressed={isSelected}
              onClick={() => onSelect(b)}
              className="absolute inset-y-0 px-px"
              style={{ left: `${left}%`, width: `max(4px, ${width}%)` }}
            >
              <span
                className={`block h-full w-full rounded-[3px] transition-opacity ${
                  b.kind === 'gap' ? 'hatched' : ''
                } ${selected !== null && !isSelected ? 'opacity-35' : ''}`}
                style={{ backgroundColor: color }}
              />
            </button>
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
