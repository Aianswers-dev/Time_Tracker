import {
  formatDuration,
  MINUTE_MS,
  type Category,
  type DayKey,
  type Rule,
} from '@time-tracker/shared';
import { useMemo, useState } from 'react';
import { inputClass } from '../../components/styles';
import { dayLabel } from '../../lib/format';
import { ChartCard, DataTable } from './ChartCard';
import { dayAxisLabels, durationTicks, formatTick } from './chartUtils';
import { useElementWidth, useScrub } from './hooks';
import { TREND_WINDOW, trendSeries, type StatsModel, type TrendPoint } from './prepare';
import { Legend } from './Tooltip';

interface Props {
  model: StatsModel;
  categories: readonly Category[];
  byId: ReadonlyMap<string, Category>;
  rules: readonly Rule[];
  defaultCategoryId: string | null;
  todayKey: DayKey;
}

const M = { left: 34, right: 32, top: 12 };
const PLOT_H = 140;

/**
 * Minutes per day for one chosen category, with a trailing 7-day moving
 * average. The daily values are faded context; the average is the line that
 * matters. A daily budget for the category is drawn as a reference line.
 */
export function TrendChart({ model, categories, byId, rules, defaultCategoryId, todayKey }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const options = useMemo(
    () => categories.filter((c) => c.archivedAt === null || model.order.includes(c.id)),
    [categories, model.order],
  );
  const categoryId =
    chosen && byId.has(chosen) ? chosen : (defaultCategoryId ?? model.order[0] ?? options[0]?.id);
  const category = categoryId ? byId.get(categoryId) : undefined;
  const points = useMemo(
    () => (categoryId ? trendSeries(model, categoryId) : []),
    [model, categoryId],
  );
  const budget = rules.find(
    (r) => r.kind === 'daily' && r.enabled && r.deletedAt === null && r.categoryId === categoryId,
  );
  const budgetMs = budget ? budget.thresholdMin * MINUTE_MS : null;

  if (!category || !categoryId) return null;

  return (
    <ChartCard
      title="Trend"
      testId="trend"
      table={
        points.length > 1
          ? () => <TrendTable points={points} todayKey={todayKey} name={category.name} />
          : undefined
      }
    >
      <label className="mb-3 flex flex-col gap-1.5">
        <span className="sr-only">Category</span>
        <select
          className={inputClass}
          value={categoryId}
          onChange={(e) => setChosen(e.target.value)}
          data-testid="trend-category"
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {points.length > 1 ? (
        <>
          <TrendPlot
            points={points}
            color={category.color}
            budgetMs={budgetMs}
            todayKey={todayKey}
          />
          <Legend
            items={[
              {
                key: 'daily',
                label: 'Each day',
                color: category.color,
                shape: 'line',
                faded: true,
              },
              {
                key: 'avg',
                label: `${TREND_WINDOW}-day average`,
                color: category.color,
                shape: 'line',
              },
              ...(budgetMs !== null
                ? [
                    {
                      key: 'budget',
                      label: 'Daily budget',
                      color: 'var(--muted)',
                      shape: 'line' as const,
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : (
        <SingleDayTrend point={points[0]} budgetMs={budgetMs} todayKey={todayKey} />
      )}
    </ChartCard>
  );
}

function SingleDayTrend({
  point,
  budgetMs,
  todayKey,
}: {
  point: TrendPoint | undefined;
  budgetMs: number | null;
  todayKey: DayKey;
}) {
  if (!point || point.ms === null) {
    return <p className="text-muted">Nothing tracked on this day yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-2xl bg-surface-2 px-3 py-2">
        <p className="text-sm text-muted">{dayLabel(point.dayKey, todayKey)}</p>
        <p className="text-xl font-semibold">{formatDuration(point.ms)}</p>
      </div>
      <div className="rounded-2xl bg-surface-2 px-3 py-2">
        <p className="text-sm text-muted">{TREND_WINDOW}-day average</p>
        <p className="text-xl font-semibold">{formatDuration(point.avgMs ?? 0)}</p>
      </div>
      {budgetMs !== null && (
        <p className="col-span-2 text-sm text-muted">
          Budget {formatDuration(budgetMs)} a day. Pick a longer range to see the trend.
        </p>
      )}
    </div>
  );
}

function linePath(
  points: TrendPoint[],
  x: (i: number) => number,
  y: (ms: number) => number,
  pick: (p: TrendPoint) => number | null,
): string {
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    const v = pick(p);
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function TrendPlot({
  points,
  color,
  budgetMs,
  todayKey,
}: {
  points: TrendPoint[];
  color: string;
  budgetMs: number | null;
  todayKey: DayKey;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const n = points.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const twoLine = n <= 7;
  const height = M.top + PLOT_H + (twoLine ? 34 : 20);
  const slot = plotW / n;
  const x = (i: number) => M.left + slot * (i + 0.5);
  const maxValue = Math.max(budgetMs ?? 0, ...points.map((p) => Math.max(p.ms ?? 0, p.avgMs ?? 0)));
  const { max, ticks } = durationTicks(maxValue, 4);
  const y = (ms: number) => M.top + PLOT_H - (ms / max) * PLOT_H;
  const lastIndex = points.reduce((acc, p, i) => (p.ms !== null ? i : acc), -1);
  const scrub = useScrub({ count: n, defaultIndex: Math.max(0, lastIndex) });
  const shownIndex = scrub.active ?? lastIndex;
  const shown = points[shownIndex];
  const labels = dayAxisLabels(
    points.map((p) => p.dayKey),
    plotW,
  );
  const showDots = n <= 31;

  return (
    <div className="flex flex-col gap-2">
      <p className="tabular min-h-6 text-sm" aria-live="polite" data-testid="trend-readout">
        {shown && shown.ms !== null ? (
          <>
            <span className="font-semibold">{dayLabel(shown.dayKey, todayKey)}</span>
            <span className="text-muted"> · </span>
            <span className="font-semibold">{formatDuration(shown.ms)}</span>
            <span className="text-muted">
              {' '}
              · {TREND_WINDOW}-day avg {formatDuration(shown.avgMs ?? 0)}
            </span>
          </>
        ) : shown ? (
          <span className="text-muted">{dayLabel(shown.dayKey, todayKey)} · no data</span>
        ) : null}
      </p>
      <div ref={ref} className="relative">
        <svg width={width} height={height} className="chart-svg block" aria-hidden>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={y(t)}
                y2={y(t)}
                style={{ stroke: t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)' }}
              />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {budgetMs !== null && (
            <g>
              <line
                x1={M.left}
                x2={M.left + plotW + 4}
                y1={y(budgetMs)}
                y2={y(budgetMs)}
                strokeWidth={1}
                style={{ stroke: 'var(--fg)', opacity: 0.55 }}
              />
              <text x={M.left + plotW + 7} y={y(budgetMs)} dy="0.32em">
                {formatTick(budgetMs)}
              </text>
            </g>
          )}
          {scrub.active !== null && (
            <line
              x1={x(scrub.active)}
              x2={x(scrub.active)}
              y1={M.top}
              y2={M.top + PLOT_H}
              style={{ stroke: 'var(--chart-axis)' }}
            />
          )}
          <path
            d={linePath(points, x, y, (p) => p.ms)}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ stroke: color, opacity: 'var(--faded)' }}
          />
          {showDots &&
            points.map((p, i) =>
              p.ms === null ? null : (
                <circle
                  key={p.dayKey}
                  cx={x(i)}
                  cy={y(p.ms)}
                  r={2.5}
                  style={{ fill: color, opacity: 'var(--faded)' }}
                />
              ),
            )}
          <path
            d={linePath(points, x, y, (p) => p.avgMs)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ stroke: color }}
          />
          {shown && shown.ms !== null && shown.avgMs !== null && (
            <g>
              <circle
                cx={x(shownIndex)}
                cy={y(shown.ms)}
                r={4}
                strokeWidth={2}
                style={{ fill: color, opacity: 0.6, stroke: 'var(--surface)' }}
              />
              <circle
                cx={x(shownIndex)}
                cy={y(shown.avgMs)}
                r={4.5}
                strokeWidth={2}
                style={{ fill: color, stroke: 'var(--surface)' }}
              />
            </g>
          )}
          {labels.map((l) => {
            const p = points[l.index];
            const lx = n <= 7 ? x(l.index) : x(l.index) - slot / 2;
            return (
              <text
                key={l.index}
                x={lx}
                y={M.top + PLOT_H + 14}
                textAnchor={n <= 7 ? 'middle' : 'start'}
                className={p?.dayKey === todayKey ? 'chart-label-strong' : undefined}
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
          className="chart-scrub chart-focus absolute rounded-lg"
          style={{ left: M.left, top: 0, width: plotW, height }}
          tabIndex={0}
          role="group"
          aria-label="Days. Arrow keys move between days."
          {...scrub.handlers}
        />
      </div>
    </div>
  );
}

function TrendTable({
  points,
  todayKey,
  name,
}: {
  points: TrendPoint[];
  todayKey: DayKey;
  name: string;
}) {
  return (
    <DataTable
      caption={`${name} per day with a ${TREND_WINDOW}-day average`}
      head={['Day', name, `${TREND_WINDOW}-day avg`]}
      rows={points
        .filter((p) => p.ms !== null)
        .map((p) => [
          dayLabel(p.dayKey, todayKey),
          formatDuration(p.ms ?? 0),
          formatDuration(p.avgMs ?? 0),
        ])}
    />
  );
}
