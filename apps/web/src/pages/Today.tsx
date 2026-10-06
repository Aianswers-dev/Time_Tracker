import {
  addDaysToKey,
  dayKeyOf,
  dayRange,
  formatDuration,
  sortedTotals,
  timelineForDay,
  toMs,
  totalsForRange,
  type Category,
  type Segment,
  type Settings,
  type TimelineBlock,
} from '@time-tracker/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { useSearchParams } from 'react-router';
import { CategoryBadge, UntrackedBadge } from '../components/CategoryBadge';
import { useCategories, useCategoryMap, useSegmentsAround, useSettings } from '../data/hooks';
import { dayLabel, timeOnDay } from '../lib/format';
import { useNow } from '../lib/useNow';
import { AssignSheet } from './today/AssignSheet';
import { DayBar } from './today/DayBar';
import { EditSheet } from './today/EditSheet';

type SheetState =
  { kind: 'edit'; segmentId: string } | { kind: 'assign'; start: number; end: number };

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SWIPE_MIN_PX = 60;

export function Today() {
  const settings = useSettings();
  const categories = useCategories();
  const byId = useCategoryMap(categories);
  const now = useNow(10_000);
  const [params, setParams] = useSearchParams();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const todayKey = settings ? dayKeyOf(now, settings) : null;
  const requested = params.get('day');
  const dayKey =
    requested && DAY_KEY_RE.test(requested) && todayKey && requested <= todayKey
      ? requested
      : todayKey;
  const tz = settings?.timezone;
  const startHour = settings?.dayStartHour;

  const range = useMemo(
    () =>
      dayKey && tz !== undefined && startHour !== undefined
        ? dayRange(dayKey, { timezone: tz, dayStartHour: startHour })
        : null,
    [dayKey, tz, startHour],
  );
  const segments = useSegmentsAround(range?.start ?? null, range?.end ?? 0);

  const view = useMemo(() => {
    if (!segments || !range || !dayKey || !settings) return null;
    const timeline = timelineForDay(segments, dayKey, settings, now);
    const totals = totalsForRange(segments, range.start, range.end, now);
    const segById = new Map(segments.map((s) => [s.id, s]));
    return { timeline, totals, segById };
  }, [segments, range, dayKey, settings, now]);

  if (!settings || !categories || !dayKey || !todayKey || !view) {
    return <div className="min-h-dvh" aria-busy="true" />;
  }

  const isToday = dayKey === todayKey;

  function goTo(delta: number) {
    if (!dayKey || !todayKey) return;
    const next = addDaysToKey(dayKey, delta);
    if (next > todayKey) return;
    setParams(next === todayKey ? {} : { day: next }, { replace: true });
  }

  function onSelect(block: TimelineBlock) {
    if (block.kind === 'gap') setSheet({ kind: 'assign', start: block.start, end: block.end });
    else setSheet({ kind: 'edit', segmentId: block.segmentId });
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    swipe.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent) {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) goTo(dx < 0 ? 1 : -1);
  }

  const { timeline, totals, segById } = view;
  const rows = [...timeline.blocks].reverse();
  const totalRows = sortedTotals(totals.byCategory);
  const editing = sheet?.kind === 'edit' ? segById.get(sheet.segmentId) : undefined;

  return (
    <main
      className="flex flex-1 touch-pan-y flex-col gap-4 px-4 pt-3"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipe.current = null)}
    >
      <header className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex size-14 items-center justify-center rounded-full active:bg-surface-2"
          aria-label="Previous day"
          onClick={() => goTo(-1)}
        >
          <ChevronLeft size={26} />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-xl font-semibold" data-testid="day-title">
            {dayLabel(dayKey, todayKey)}
          </h1>
          <p className="tabular text-xs text-muted">{dayKey}</p>
        </div>
        <button
          type="button"
          className="inline-flex size-14 items-center justify-center rounded-full active:bg-surface-2 disabled:opacity-30"
          aria-label="Next day"
          disabled={isToday}
          onClick={() => goTo(1)}
        >
          <ChevronRight size={26} />
        </button>
      </header>

      <DayBar timeline={timeline} settings={settings} categories={byId} onSelect={onSelect} />

      <section aria-labelledby="entries-h">
        <h2
          id="entries-h"
          className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase"
        >
          Entries
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface p-4 text-muted">
            Nothing tracked {isToday ? 'yet today' : 'on this day'}.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {rows.map((b) => (
              <li key={b.kind === 'segment' ? b.segmentId : `gap-${b.start}`}>
                {b.kind === 'segment' ? (
                  <EntryRow
                    segment={segById.get(b.segmentId)}
                    dayKey={dayKey}
                    now={now}
                    onOpen={() => onSelect(b)}
                    byId={byId}
                    settings={settings}
                  />
                ) : (
                  <button
                    type="button"
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
                    onClick={() => onSelect(b)}
                  >
                    <UntrackedBadge />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-muted">Untracked</span>
                      <span className="tabular block text-sm text-muted">
                        {timeOnDay(b.start, dayKey, settings)}–{timeOnDay(b.end, dayKey, settings)}{' '}
                        · tap to assign
                      </span>
                    </span>
                    <span className="tabular text-sm font-medium text-muted">
                      {formatDuration(b.end - b.start)}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(totalRows.length > 0 || totals.untrackedMs > 0) && (
        <section aria-labelledby="totals-h">
          <h2
            id="totals-h"
            className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase"
          >
            Totals
          </h2>
          <ul className="space-y-1 rounded-2xl border border-line bg-surface p-3">
            {totalRows.map(({ categoryId, ms }) => {
              const c = byId.get(categoryId);
              return (
                <li key={categoryId} className="flex min-h-9 items-center gap-3">
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: c?.color ?? '#6b7a90' }}
                  />
                  <span className="min-w-0 flex-1 truncate">{c?.name ?? 'Unknown'}</span>
                  <span className="tabular font-medium">{formatDuration(ms)}</span>
                </li>
              );
            })}
            {totals.untrackedMs >= 60_000 && (
              <li className="flex min-h-9 items-center gap-3 text-muted">
                <span aria-hidden className="hatched size-3 shrink-0 rounded-full" />
                <span className="flex-1">Untracked</span>
                <span className="tabular font-medium">{formatDuration(totals.untrackedMs)}</span>
              </li>
            )}
          </ul>
        </section>
      )}

      {sheet?.kind === 'edit' && editing && (
        <EditSheet
          segment={editing}
          settings={settings}
          categories={categories}
          byId={byId}
          dayKey={dayKey}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'assign' && (
        <AssignSheet
          start={sheet.start}
          end={sheet.end}
          settings={settings}
          categories={categories}
          byId={byId}
          dayKey={dayKey}
          onClose={() => setSheet(null)}
        />
      )}
    </main>
  );
}

interface EntryRowProps {
  segment: Segment | undefined;
  dayKey: string;
  now: number;
  onOpen: () => void;
  byId: ReadonlyMap<string, Category>;
  settings: Settings;
}

function EntryRow({ segment, dayKey, now, onOpen, byId, settings }: EntryRowProps) {
  if (!segment) return null;
  const c = byId.get(segment.categoryId);
  const start = toMs(segment.startedAt);
  const end = segment.endedAt === null ? now : toMs(segment.endedAt);
  return (
    <button
      type="button"
      className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
      onClick={onOpen}
    >
      {c ? <CategoryBadge category={c} /> : <UntrackedBadge />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{c?.name ?? 'Unknown'}</span>
        <span className="tabular block text-sm text-muted">
          {timeOnDay(start, dayKey, settings)}–
          {segment.endedAt === null ? 'now' : timeOnDay(end, dayKey, settings)}
        </span>
        {segment.note && <span className="block truncate text-sm">{segment.note}</span>}
      </span>
      <span className="tabular text-sm font-medium">{formatDuration(end - start)}</span>
    </button>
  );
}
