import { formatDuration, MINUTE_MS, type Category, type DayKey } from '@time-tracker/shared';
import { CircleCheck, Flame, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { dayLabel } from '../../lib/format';
import { ChartCard, DataTable } from './ChartCard';
import { barLayout, formatTick, roundedTopRect } from './chartUtils';
import { useElementWidth, useScrub } from './hooks';
import { minutesPast, type BudgetView, type StatsModel } from './prepare';

interface Props {
  model: StatsModel;
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * For each enabled daily rule: days under and over its budget in the range,
 * the current run of days under, and a strip of the days themselves with the
 * budget as a line. Over-budget days use the danger colour and sit above the
 * line, so colour is never the only cue.
 */
export function BudgetTracker({ model, byId, todayKey }: Props) {
  const budgets = model.budgets.filter((b) => byId.has(b.categoryId));
  if (budgets.length === 0) return null;
  return (
    <ChartCard
      title="Budgets"
      testId="budgets"
      table={() => <BudgetTable budgets={budgets} byId={byId} todayKey={todayKey} />}
    >
      <ul className="flex flex-col gap-5">
        {budgets.map((b) => (
          <BudgetRow
            key={b.ruleId}
            budget={b}
            category={byId.get(b.categoryId)}
            todayKey={todayKey}
          />
        ))}
      </ul>
    </ChartCard>
  );
}

function BudgetRow({
  budget,
  category,
  todayKey,
}: {
  budget: BudgetView;
  category: Category | undefined;
  todayKey: DayKey;
}) {
  const budgetMs = budget.thresholdMin * MINUTE_MS;
  const single = budget.days.length <= 1;
  return (
    <li className="flex flex-col gap-3" data-testid="budget-row">
      <div className="flex items-center gap-3">
        {category && <CategoryBadge category={category} size={32} />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{category?.name ?? 'Unknown'}</p>
          <p className="text-sm text-muted">Budget {formatDuration(budgetMs)} a day</p>
        </div>
      </div>
      {single ? (
        <SingleDay budget={budget} budgetMs={budgetMs} todayKey={todayKey} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Figure
              icon={<CircleCheck size={16} aria-hidden />}
              value={budget.daysUnder}
              label="under"
            />
            <Figure
              icon={<TriangleAlert size={16} aria-hidden className="text-danger" />}
              value={budget.daysOver}
              label="over"
            />
            <Figure
              icon={<Flame size={16} aria-hidden />}
              value={budget.streakUnder}
              label="in a row under"
              testId="budget-streak"
            />
          </div>
          <BudgetStrip budget={budget} budgetMs={budgetMs} todayKey={todayKey} />
        </>
      )}
    </li>
  );
}

function Figure({
  icon,
  value,
  label,
  testId,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  testId?: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl bg-surface-2 px-3 py-2" data-testid={testId}>
      <span className="flex items-center gap-1.5 text-muted">
        {icon}
        <span className="text-lg leading-tight font-semibold text-fg">{value}</span>
      </span>
      <span className="text-xs text-muted">
        {value === 1 ? 'day' : 'days'} {label}
      </span>
    </div>
  );
}

function SingleDay({
  budget,
  budgetMs,
  todayKey,
}: {
  budget: BudgetView;
  budgetMs: number;
  todayKey: DayKey;
}) {
  const day = budget.days[0];
  const ms = day?.ms ?? 0;
  const over = day?.over ?? false;
  const ratio = budgetMs > 0 ? Math.min(1, ms / budgetMs) : 0;
  const name = day ? dayLabel(day.dayKey, todayKey) : 'Today';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="tabular text-lg font-semibold">{formatDuration(ms)}</span>
        <span className="inline-flex items-center gap-1 text-sm text-muted">
          {over && <TriangleAlert size={14} aria-hidden className="text-danger" />}
          {over
            ? `${formatDuration(minutesPast(ms, budget.thresholdMin))} over`
            : `${formatDuration(-minutesPast(ms, budget.thresholdMin))} left${name === 'Today' ? ' today' : ''}`}
        </span>
      </div>
      <span
        role="meter"
        aria-label={`${name}: ${formatDuration(ms)} of ${formatDuration(budgetMs)}`}
        aria-valuemin={0}
        aria-valuemax={budget.thresholdMin}
        aria-valuenow={Math.min(budget.thresholdMin, Math.floor(ms / MINUTE_MS))}
        className="block h-2.5 overflow-hidden rounded-full bg-surface-2"
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: `${ratio * 100}%`,
            backgroundColor: over ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </span>
    </div>
  );
}

const STRIP_H = 64;
const STRIP_TOP = 6;
/** Right gutter for the budget line's label, clear of the columns. */
const GUTTER = 32;

function BudgetStrip({
  budget,
  budgetMs,
  todayKey,
}: {
  budget: BudgetView;
  budgetMs: number;
  todayKey: DayKey;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const n = budget.days.length;
  const scrub = useScrub({ count: n, defaultIndex: n - 1 });
  const maxMs = Math.max(budgetMs * 1.5, ...budget.days.map((d) => d.ms));
  const y = (ms: number) => STRIP_TOP + STRIP_H - (Math.min(ms, maxMs) / maxMs) * STRIP_H;
  const plotW = Math.max(40, width - GUTTER);
  const { slot, bar } = barLayout(n, plotW);
  const shown = budget.days[scrub.active ?? n - 1];
  const lineY = y(budgetMs);

  return (
    <div className="flex flex-col gap-1">
      <div ref={ref} className="relative">
        <svg width={width} height={STRIP_TOP + STRIP_H + 1} className="chart-svg block" aria-hidden>
          <line
            x1={0}
            x2={plotW}
            y1={STRIP_TOP + STRIP_H + 0.5}
            y2={STRIP_TOP + STRIP_H + 0.5}
            style={{ stroke: 'var(--chart-axis)' }}
          />
          {budget.days.map((d, i) => {
            const top = y(d.ms);
            const h = STRIP_TOP + STRIP_H - top;
            const dim = scrub.active !== null && scrub.active !== i;
            if (h < 0.75) return null;
            return (
              <path
                key={d.dayKey}
                d={roundedTopRect(slot * (i + 0.5) - bar / 2, top, bar, h, 3)}
                opacity={dim ? 0.4 : 1}
                style={{ fill: d.over ? 'var(--danger)' : 'var(--chart-neutral)' }}
              />
            );
          })}
          <line
            x1={0}
            x2={plotW + 4}
            y1={lineY}
            y2={lineY}
            strokeWidth={1}
            style={{ stroke: 'var(--fg)', opacity: 0.55 }}
          />
          <text x={plotW + 7} y={lineY} dy="0.32em">
            {formatTick(budgetMs)}
          </text>
        </svg>
        <div
          className="chart-scrub chart-focus absolute top-0 bottom-0 left-0 rounded-lg"
          style={{ width: plotW }}
          tabIndex={0}
          role="group"
          aria-label="Days against the budget. Arrow keys move between days."
          {...scrub.handlers}
        />
      </div>
      {shown && (
        <p className="tabular flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
          <span className="font-medium text-fg">{dayLabel(shown.dayKey, todayKey)}</span>
          <span>·</span>
          <span>{formatDuration(shown.ms)}</span>
          <span>·</span>
          {shown.over ? (
            <span className="inline-flex items-center gap-1">
              <TriangleAlert size={14} aria-hidden className="text-danger" />
              {formatDuration(minutesPast(shown.ms, budget.thresholdMin))} over
            </span>
          ) : (
            <span>{formatDuration(-minutesPast(shown.ms, budget.thresholdMin))} under</span>
          )}
        </p>
      )}
    </div>
  );
}

function BudgetTable({
  budgets,
  byId,
  todayKey,
}: {
  budgets: BudgetView[];
  byId: ReadonlyMap<string, Category>;
  todayKey: DayKey;
}) {
  const rows = budgets.flatMap((b) => {
    const name = byId.get(b.categoryId)?.name ?? 'Unknown';
    const budgetMs = b.thresholdMin * MINUTE_MS;
    return [
      [
        `${name}: ${plural(b.daysUnder, 'day')} under, ${plural(b.daysOver, 'day')} over, streak ${b.streakUnder}`,
        formatDuration(budgetMs),
        '',
      ],
      ...b.days.map((d) => [
        dayLabel(d.dayKey, todayKey),
        formatDuration(d.ms),
        d.over ? 'Over' : 'Under',
      ]),
    ];
  });
  return <DataTable caption="Daily budgets by day" head={['Day', 'Time', 'Budget']} rows={rows} />;
}
