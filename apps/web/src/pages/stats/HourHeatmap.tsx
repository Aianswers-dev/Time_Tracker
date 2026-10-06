import { formatDuration, MINUTE_MS, type Category } from '@time-tracker/shared';
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { ChartCard, DataTable } from './ChartCard';
import { HEAT_FILLS, HEAT_STEPS_MIN, heatLevel, hourLabel, indexAt } from './chartUtils';
import type { HeatRow, StatsModel } from './prepare';

interface Props {
  model: StatsModel;
  byId: ReadonlyMap<string, Category>;
  /** A category to describe when nothing is picked, usually the one with a daily budget. */
  focusCategoryId: string | null;
}

interface Cell {
  row: number;
  col: number;
}

function minutesPerDay(ms: number, days: number): number {
  return ms / days / MINUTE_MS;
}

function hourSpan(hour: number): string {
  return `${hourLabel(hour)}:00–${hourLabel((hour + 1) % 24)}:00`;
}

function peakCol(row: HeatRow): number {
  let best = 0;
  row.cells.forEach((ms, i) => {
    if (ms > (row.cells[best] ?? 0)) best = i;
  });
  return best;
}

/**
 * Hour of day by category: 24 columns from the day start hour, one row per
 * category, and the colour step is the average minutes per day that category
 * took in that local hour across the range. One blue ramp for every row, so
 * rows compare directly; the row's name sits above it.
 */
export function HourHeatmap({ model, byId, focusCategoryId }: Props) {
  const { heatmap } = model;
  const { rows, hours, days } = heatmap;
  const [picked, setPicked] = useState<Cell | null>(null);
  const [pressStart, setPressStart] = useState<{ x: number; y: number } | null>(null);

  const cell = picked && picked.row < rows.length ? picked : null;

  function cellFromPointer(e: PointerEvent<HTMLElement>, row: number): Cell {
    const rect = e.currentTarget.getBoundingClientRect();
    return { row, col: indexAt(e.clientX - rect.left, rect.width, 24) };
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const current = cell ?? { row: 0, col: 0 };
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setPicked({
        row: Math.max(0, Math.min(rows.length - 1, current.row + move[0])),
        col: Math.max(0, Math.min(23, current.col + move[1])),
      });
    } else if (e.key === 'Escape') {
      setPicked(null);
    }
  }

  const focusRowIndex = rows.findIndex((r) => r.categoryId === focusCategoryId);
  const focusRow = rows[focusRowIndex];
  const readout = cell ? describeCell(rows[cell.row], cell.col) : defaultReadout();

  function describeCell(row: HeatRow | undefined, col: number) {
    if (!row) return null;
    const c = byId.get(row.categoryId);
    const ms = row.cells[col] ?? 0;
    const hour = hours[col] ?? 0;
    return {
      title: `${c?.name ?? 'Unknown'} · ${hourSpan(hour)}`,
      body:
        ms < MINUTE_MS
          ? 'None in this hour'
          : days > 1
            ? `${Math.round(minutesPerDay(ms, days))} min a day · ${formatDuration(ms)} in all`
            : `${formatDuration(ms)} in this hour`,
    };
  }

  function defaultReadout() {
    if (focusRow && focusRow.totalMs >= MINUTE_MS) {
      const col = peakCol(focusRow);
      const ms = focusRow.cells[col] ?? 0;
      const c = byId.get(focusRow.categoryId);
      return {
        title: `${c?.name ?? 'Unknown'} peaks ${hourSpan(hours[col] ?? 0)}`,
        body:
          days > 1
            ? `${Math.round(minutesPerDay(ms, days))} min a day in that hour`
            : `${formatDuration(ms)} in that hour`,
      };
    }
    return { title: 'Tap a square', body: 'See what that hour went on.' };
  }

  const axis = (
    <div aria-hidden className="grid grid-cols-24 gap-[2px] text-[11px] text-muted tabular">
      {hours.map((h, i) => (
        <span key={i} className="overflow-visible whitespace-nowrap">
          {i % 4 === 0 ? hourLabel(h) : ''}
        </span>
      ))}
    </div>
  );

  return (
    <ChartCard
      title="When"
      testId="heatmap"
      subtitle={
        days > 1
          ? `Average minutes a day in each hour, across ${days} days. Tap a square for details.`
          : 'Minutes in each hour of the day. Tap a square for details.'
      }
      table={() => <HeatTable model={model} byId={byId} />}
    >
      <div
        className="mb-3 min-h-12 rounded-2xl bg-surface-2 px-3 py-2"
        aria-live="polite"
        data-testid="heatmap-readout"
      >
        <p className="truncate text-sm font-semibold">{readout?.title}</p>
        <p className="tabular truncate text-sm text-muted">{readout?.body}</p>
      </div>
      <div
        className="chart-focus flex flex-col gap-2 rounded-lg"
        tabIndex={0}
        role="group"
        aria-label="Hour of day grid. Arrow keys move between hours and categories."
        onKeyDown={onKeyDown}
      >
        {axis}
        {rows.map((row, r) => {
          const c = byId.get(row.categoryId);
          return (
            <div key={row.categoryId} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-sm">
                {c && <CategoryBadge category={c} size={18} className="rounded-md" />}
                <span className="min-w-0 flex-1 truncate font-medium">{c?.name ?? 'Unknown'}</span>
                <span className="tabular text-xs text-muted">
                  peak {hourLabel(hours[peakCol(row)] ?? 0)}:00
                </span>
              </div>
              <div
                className="chart-scrub grid grid-cols-24 gap-[2px]"
                onPointerDown={(e) => {
                  setPressStart({ x: e.clientX, y: e.clientY });
                  setPicked(cellFromPointer(e, r));
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' || pressStart) setPicked(cellFromPointer(e, r));
                }}
                onPointerUp={() => setPressStart(null)}
                onPointerCancel={() => setPressStart(null)}
              >
                {row.cells.map((ms, col) => {
                  const level = heatLevel(minutesPerDay(ms, days));
                  const isPicked = cell?.row === r && cell.col === col;
                  return (
                    <span
                      key={col}
                      className="h-4 rounded-[3px]"
                      style={{
                        backgroundColor: HEAT_FILLS[level],
                        outline: isPicked ? '2px solid var(--fg)' : undefined,
                        outlineOffset: 1,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        {rows.length > 4 && axis}
      </div>
      <HeatScale perDay={days > 1} />
    </ChartCard>
  );
}

/** The sequential scale: what each step means in minutes a day. */
function HeatScale({ perDay }: { perDay: boolean }) {
  return (
    <div className="mt-4 flex items-center gap-2 text-xs text-muted">
      <span>{perDay ? 'Min a day' : 'Minutes'}</span>
      <div className="flex flex-1 items-center gap-[2px]">
        {HEAT_STEPS_MIN.map((bound, i) => (
          <div key={bound} className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="h-3 rounded-[3px]" style={{ backgroundColor: HEAT_FILLS[i + 1] }} />
            <span className="tabular">
              {bound}
              {i === HEAT_STEPS_MIN.length - 1 ? '+' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeatTable({ model, byId }: { model: StatsModel; byId: ReadonlyMap<string, Category> }) {
  const { rows, hours, days } = model.heatmap;
  return (
    <DataTable
      caption={`Average minutes a day in each hour, across ${days} days`}
      head={['Hour', ...rows.map((r) => byId.get(r.categoryId)?.name ?? 'Unknown')]}
      rows={hours.map((h, col) => [
        `${hourLabel(h)}:00`,
        ...rows.map((r) => {
          const min = minutesPerDay(r.cells[col] ?? 0, days);
          return min < 1 ? '–' : `${Math.round(min)}m`;
        }),
      ])}
    />
  );
}
