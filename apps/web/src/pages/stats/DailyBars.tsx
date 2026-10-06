import { formatDuration, HOUR_MS, type Category, type DayKey } from '@time-tracker/shared';
import { useId } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui';
import { dayLabel, shortDateLabel } from '../../lib/format';
import { ChartCard, DataTable } from './ChartCard';
import { barLayout, dayAxisLabels, durationTicks, formatTick, roundedTopRect } from './chartUtils';
import { useElementWidth, useScrub } from './hooks';
import type { DayColumn, StatsModel } from './prepare';
import { ChartTooltip, Legend, TooltipRow } from './Tooltip';

interface Props {
  model: StatsModel;
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}

const M = { left: 34, right: 4, top: 10 };
const PLOT_H = 168;
const GAP = 2;

function todayHref(dayKey: DayKey, todayKey: DayKey): string {
  return dayKey === todayKey ? '/today' : `/today?day=${dayKey}`;
}

/**
 * One stacked bar per logical day, stacked by category in the range's order
 * (largest at the base), untracked time hatched on top. A tap opens that day
 * on the Today screen; sliding a finger across inspects without leaving.
 */
export function DailyBars({ model, byId, todayKey }: Props) {
  const navigate = useNavigate();
  const days = model.days;

  if (days.length < 2) {
    const only = days[0];
    return (
      <ChartCard title="Each day" testId="daily">
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted">
            Daily bars compare days. Pick a longer range, or see this day hour by hour.
          </p>
          {only && (
            <Button onClick={() => void navigate(todayHref(only.dayKey, todayKey))}>
              Open {dayLabel(only.dayKey, todayKey)}
            </Button>
          )}
        </div>
      </ChartCard>
    );
  }

  const legend = [
    ...model.order.map((id) => ({
      key: id,
      label: byId.get(id)?.name ?? 'Unknown',
      color: byId.get(id)?.color ?? 'var(--chart-neutral)',
    })),
    ...(days.some((d) => d.untrackedMs >= 60_000)
      ? [{ key: 'untracked', label: 'Untracked', hatched: true }]
      : []),
  ];

  return (
    <ChartCard
      title="Each day"
      testId="daily"
      subtitle="Hours per day by category. Tap a bar to open that day; slide across to compare."
      table={() => <DailyTable days={days} order={model.order} byId={byId} todayKey={todayKey} />}
    >
      <BarsPlot days={days} byId={byId} todayKey={todayKey} />
      <Legend items={legend} />
    </ChartCard>
  );
}

function BarsPlot({
  days,
  byId,
  todayKey,
}: {
  days: DayColumn[];
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}) {
  const navigate = useNavigate();
  const hatchId = useId().replace(/:/g, '');
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const n = days.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const twoLine = n <= 7;
  const axisH = twoLine ? 34 : 20;
  const height = M.top + PLOT_H + axisH;
  const maxDay = Math.max(24 * HOUR_MS, ...days.map((d) => d.trackedMs + d.untrackedMs));
  const { max, ticks } = durationTicks(maxDay, 4);
  const y = (ms: number) => M.top + PLOT_H - (ms / max) * PLOT_H;
  const { slot, bar } = barLayout(n, plotW);
  const labels = dayAxisLabels(
    days.map((d) => d.dayKey),
    plotW,
  );
  const lastActive = days.reduce((acc, d, i) => (d.status === 'active' ? i : acc), n - 1);

  const scrub = useScrub({
    count: n,
    defaultIndex: lastActive,
    onTap: (i) => {
      const d = days[i];
      if (d && d.status !== 'future') void navigate(todayHref(d.dayKey, todayKey));
    },
  });
  const active = scrub.active;
  const activeDay = active === null ? null : (days[active] ?? null);

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={height}
        className="chart-svg block"
        role="img"
        aria-label={`Stacked bars of hours per day from ${shortDateLabel(days[0]?.dayKey ?? todayKey)} to ${shortDateLabel(days[n - 1]?.dayKey ?? todayKey)}. Use the table view for exact values.`}
      >
        <defs>
          <pattern
            id={hatchId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" style={{ fill: 'var(--hatch-b)' }} />
            <rect width="2.5" height="6" style={{ fill: 'var(--hatch-a)' }} />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={M.left + plotW}
              y1={y(t)}
              y2={y(t)}
              strokeWidth={1}
              style={{ stroke: t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)' }}
            />
            <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = M.left + slot * (i + 0.5);
          const x = cx - bar / 2;
          const stack = [
            ...d.parts.map((p) => ({
              key: p.categoryId,
              ms: p.ms,
              fill: byId.get(p.categoryId)?.color ?? 'var(--chart-neutral)',
            })),
            ...(d.untrackedMs >= 60_000
              ? [{ key: 'untracked', ms: d.untrackedMs, fill: `url(#${hatchId})` }]
              : []),
          ];
          let cum = 0;
          const pieces = stack.map((s, k) => {
            const bottom = y(cum);
            cum += s.ms;
            const top = y(cum);
            const h = bottom - top - (k > 0 ? GAP : 0);
            return { ...s, top, h };
          });
          const lastDrawn = pieces.reduce((acc, p, k) => (p.h >= 0.75 ? k : acc), -1);
          const dim = active !== null && active !== i;
          return (
            <g key={d.dayKey} opacity={dim ? 0.4 : 1}>
              {pieces.map((p, k) =>
                p.h < 0.75 ? null : k === lastDrawn ? (
                  <path
                    key={p.key}
                    d={roundedTopRect(x, p.top, bar, p.h, 4)}
                    style={{ fill: p.fill }}
                  />
                ) : (
                  <rect
                    key={p.key}
                    x={x}
                    y={p.top}
                    width={bar}
                    height={p.h}
                    style={{ fill: p.fill }}
                  />
                ),
              )}
            </g>
          );
        })}
        {labels.map((l) => {
          const d = days[l.index];
          const cx = M.left + slot * (l.index + 0.5);
          const strong = d?.isToday ?? false;
          const anchor = n <= 7 ? 'middle' : 'start';
          const lx = n <= 7 ? cx : cx - bar / 2;
          return (
            <text
              key={l.index}
              x={lx}
              y={M.top + PLOT_H + 14}
              textAnchor={anchor}
              className={strong ? 'chart-label-strong' : undefined}
              opacity={d?.status === 'future' ? 0.6 : 1}
            >
              {l.text}
              {l.sub && (
                <tspan x={lx} dy="1.25em">
                  {l.sub}
                </tspan>
              )}
            </text>
          );
        })}
      </svg>
      <div
        className="chart-scrub chart-focus absolute cursor-pointer rounded-lg"
        style={{ left: M.left, top: 0, width: plotW, height }}
        tabIndex={0}
        role="group"
        aria-label="Days. Arrow keys move between days, Enter opens a day on Today."
        {...scrub.handlers}
      />
      <p className="sr-only" aria-live="polite">
        {activeDay ? describeDay(activeDay, byId, todayKey) : ''}
      </p>
      {activeDay && active !== null && (
        <ChartTooltip x={M.left + slot * (active + 0.5)} width={width} top={0}>
          <DayReadout day={activeDay} byId={byId} todayKey={todayKey} />
        </ChartTooltip>
      )}
    </div>
  );
}

function describeDay(d: DayColumn, byId: ReadonlyMap<string, Category>, todayKey: DayKey): string {
  const name = dayLabel(d.dayKey, todayKey);
  if (d.status === 'future') return `${name}: still to come.`;
  if (d.status === 'before-tracking') return `${name}: before tracking began.`;
  const parts = d.parts.map(
    (p) => `${byId.get(p.categoryId)?.name ?? 'Unknown'} ${formatDuration(p.ms)}`,
  );
  if (d.untrackedMs >= 60_000) parts.push(`untracked ${formatDuration(d.untrackedMs)}`);
  return `${name}: ${formatDuration(d.trackedMs)} tracked. ${parts.join(', ')}.`;
}

function DayReadout({
  day,
  byId,
  todayKey,
}: {
  day: DayColumn;
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{dayLabel(day.dayKey, todayKey)}</span>
        {day.status === 'active' && (
          <span className="tabular text-muted">{formatDuration(day.trackedMs)}</span>
        )}
      </div>
      {day.status === 'future' && <span className="text-muted">Still to come</span>}
      {day.status === 'before-tracking' && (
        <span className="text-muted">Before tracking began</span>
      )}
      {day.status === 'active' && day.parts.length === 0 && day.untrackedMs < 60_000 && (
        <span className="text-muted">Nothing tracked</span>
      )}
      {day.parts.map((p) => {
        const c = byId.get(p.categoryId);
        return (
          <TooltipRow
            key={p.categoryId}
            color={c?.color}
            label={c?.name ?? 'Unknown'}
            value={formatDuration(p.ms)}
          />
        );
      })}
      {day.untrackedMs >= 60_000 && (
        <TooltipRow hatched label="Untracked" value={formatDuration(day.untrackedMs)} />
      )}
    </div>
  );
}

function DailyTable({
  days,
  order,
  byId,
  todayKey,
}: {
  days: DayColumn[];
  order: string[];
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}) {
  const shown = days.filter((d) => d.status === 'active');
  return (
    <DataTable
      caption="Time per day by category"
      head={['Day', 'Tracked', 'Untracked', ...order.map((id) => byId.get(id)?.name ?? 'Unknown')]}
      rows={shown.map((d) => {
        const byCat = new Map(d.parts.map((p) => [p.categoryId, p.ms]));
        return [
          dayLabel(d.dayKey, todayKey),
          formatDuration(d.trackedMs),
          formatDuration(d.untrackedMs),
          ...order.map((id) => {
            const ms = byCat.get(id) ?? 0;
            return ms > 0 ? formatDuration(ms) : '–';
          }),
        ];
      })}
    />
  );
}
