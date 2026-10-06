import { formatDuration, type Category } from '@time-tracker/shared';
import { CategoryBadge, UntrackedBadge } from '../../components/CategoryBadge';
import { ChartCard } from './ChartCard';
import { formatShare } from './chartUtils';
import type { StatsModel } from './prepare';

interface Props {
  model: StatsModel;
  byId: ReadonlyMap<string, Category>;
}

/**
 * Where the time went: one row per category, largest first, as a bar list.
 * Every value is printed beside its bar, so the list is its own table view.
 * Bars are scaled to the largest row; percentages are of the range's elapsed
 * time, untracked included, so they add up to 100.
 */
export function TotalsList({ model, byId }: Props) {
  const { rows, untrackedMs, spanMs } = model.totals;
  const max = Math.max(rows[0]?.ms ?? 0, untrackedMs, 1);
  const showUntracked = untrackedMs >= 60_000;

  return (
    <ChartCard
      title="Where the time went"
      subtitle={`Largest first. Percentages are of ${formatDuration(spanMs)}, untracked time included.`}
      testId="totals"
    >
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const c = byId.get(row.categoryId);
          return (
            <li key={row.categoryId} className="flex items-center gap-3">
              {c ? <CategoryBadge category={c} size={32} /> : <UntrackedBadge size={32} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {c?.name ?? 'Unknown'}
                  </span>
                  <span className="tabular font-semibold">{formatDuration(row.ms)}</span>
                  <span className="tabular w-10 text-right text-sm text-muted">
                    {formatShare(row.share)}
                  </span>
                </div>
                <div
                  aria-hidden
                  className="mt-1.5 h-2 rounded-r"
                  style={{
                    width: `${Math.max(1, (row.ms / max) * 100)}%`,
                    backgroundColor: c?.color ?? 'var(--chart-neutral)',
                  }}
                />
              </div>
            </li>
          );
        })}
        {showUntracked && (
          <li className="flex items-center gap-3">
            <UntrackedBadge size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-muted">
                <span className="min-w-0 flex-1 truncate font-medium">Untracked</span>
                <span className="tabular font-semibold">{formatDuration(untrackedMs)}</span>
                <span className="tabular w-10 text-right text-sm">
                  {formatShare(untrackedMs / Math.max(1, spanMs))}
                </span>
              </div>
              <div
                aria-hidden
                className="hatched mt-1.5 h-2 rounded-r"
                style={{ width: `${Math.max(1, (untrackedMs / max) * 100)}%` }}
              />
            </div>
          </li>
        )}
      </ul>
    </ChartCard>
  );
}
