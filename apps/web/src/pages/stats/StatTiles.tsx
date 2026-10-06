import { formatDuration, wholeMinutes, type Category } from '@time-tracker/shared';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { compactDuration, formatShare } from './chartUtils';
import { minutesPast, perDay, type StatsModel } from './prepare';

interface Props {
  model: StatsModel;
  byId: ReadonlyMap<string, Category>;
  isToday: boolean;
}

interface TileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  testId?: string;
}

/** Stat tile: sentence-case label, proportional-figure value, one muted line under it. */
function Tile({ label, value, sub, leading, children, testId }: TileProps) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-3xl border border-line bg-surface p-4"
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-muted">
        {leading}
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-2xl leading-tight font-semibold tracking-tight">{value}</span>
      {children}
      {sub && <span className="text-sm leading-snug text-muted">{sub}</span>}
    </div>
  );
}

/** The headline row: tracked, top category, untracked, and the first daily budget. */
export function StatTiles({ model, byId, isToday }: Props) {
  const { totals, activeKeys } = model;
  const multiDay = activeKeys.length > 1;
  const top = totals.rows[0];
  const topCategory = top ? byId.get(top.categoryId) : undefined;
  const budget = model.budgets.find((b) => byId.has(b.categoryId));

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="stat-tiles">
      <Tile
        label="Tracked"
        value={compactDuration(totals.trackedMs)}
        testId="tile-tracked"
        sub={
          multiDay
            ? `${formatDuration(perDay(totals.trackedMs, model))} a day`
            : `${formatShare(totals.spanMs > 0 ? totals.trackedMs / totals.spanMs : 0)} of the day${isToday ? ' so far' : ''}`
        }
      />
      <Tile
        label="Most time"
        testId="tile-top"
        leading={
          topCategory ? (
            <CategoryBadge category={topCategory} size={20} className="rounded-md" />
          ) : undefined
        }
        value={top ? compactDuration(top.ms) : '—'}
        sub={
          top ? (
            <>
              <span className="font-medium text-fg">{topCategory?.name ?? 'Unknown'}</span> ·{' '}
              {formatShare(top.share)}
            </>
          ) : (
            'Nothing yet'
          )
        }
      />
      <Tile
        label="Untracked"
        testId="tile-untracked"
        leading={
          totals.untrackedMs >= 60_000 ? (
            <span aria-hidden className="hatched size-5 shrink-0 rounded-md border border-line" />
          ) : undefined
        }
        value={compactDuration(totals.untrackedMs)}
        sub={
          totals.untrackedMs < 60_000
            ? 'Every minute accounted for'
            : `${formatShare(totals.untrackedMs / Math.max(1, totals.spanMs))} of the time`
        }
      />
      {budget ? (
        <BudgetTile model={model} budget={budget} category={byId.get(budget.categoryId)} />
      ) : (
        <Tile
          label="Days tracked"
          testId="tile-days"
          value={String(activeKeys.length)}
          sub={`of ${model.range.dayKeys.length} in this range`}
        />
      )}
    </div>
  );
}

function BudgetTile({
  model,
  budget,
  category,
}: {
  model: StatsModel;
  budget: StatsModel['budgets'][number];
  category: Category | undefined;
}) {
  const multiDay = budget.days.length > 1;
  const totalMs = budget.days.reduce((sum, d) => sum + d.ms, 0);
  const valueMs = multiDay ? perDay(totalMs, model) : (budget.days[0]?.ms ?? 0);
  const budgetMs = budget.thresholdMin * 60_000;
  const over = wholeMinutes(valueMs) >= budget.thresholdMin;
  const ratio = budgetMs > 0 ? Math.min(1, valueMs / budgetMs) : 0;
  const name = category?.name ?? 'Budget';
  const sub = multiDay
    ? `a day on average · ${budget.daysOver} ${budget.daysOver === 1 ? 'day' : 'days'} over ${formatDuration(budgetMs)}`
    : over
      ? `${formatDuration(minutesPast(valueMs, budget.thresholdMin))} over ${formatDuration(budgetMs)}`
      : `of ${formatDuration(budgetMs)} · ${formatDuration(-minutesPast(valueMs, budget.thresholdMin))} left`;

  return (
    <Tile
      label={name}
      testId="tile-budget"
      leading={
        category ? (
          <CategoryBadge category={category} size={20} className="rounded-md" />
        ) : undefined
      }
      value={compactDuration(valueMs)}
      sub={
        <span className="inline-flex items-start gap-1">
          {over && <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />}
          <span>
            {over && <span className="sr-only">Over budget. </span>}
            {sub}
          </span>
        </span>
      }
    >
      <span
        role="meter"
        aria-label={`${name} against its daily budget`}
        aria-valuemin={0}
        aria-valuemax={budget.thresholdMin}
        aria-valuenow={Math.min(budget.thresholdMin, wholeMinutes(valueMs))}
        className="mt-1 block h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(ratio > 0 ? 4 : 0, ratio * 100)}%`,
            backgroundColor: over ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </span>
    </Tile>
  );
}
