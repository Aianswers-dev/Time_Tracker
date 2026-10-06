import {
  addDaysToKey,
  dayKeyOf,
  dayRange,
  type Rule,
  type DaySettings,
} from '@time-tracker/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChartColumn } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCategories, useCategoryMap, useSettings } from '../data/hooks';
import { db } from '../db';
import { shortDateLabel } from '../lib/format';
import { useNow } from '../lib/useNow';
import { BudgetTracker } from './stats/BudgetTracker';
import { DailyBars } from './stats/DailyBars';
import { HourHeatmap } from './stats/HourHeatmap';
import { loadStatsSegments, measured } from './stats/load';
import { buildStats, LOOKBACK_DAYS, type StatsModel } from './stats/prepare';
import { CustomRangePicker, RangeTabs } from './stats/RangeControls';
import { isRangeKind, rangeLabel, resolveRange, RANGE_LABELS, type RangeKind } from './stats/range';
import { StatTiles } from './stats/StatTiles';
import { TotalsList } from './stats/TotalsList';
import { TrendChart } from './stats/TrendChart';
import './stats/stats.css';

/** Ranges longer than this recompute every five minutes instead of every minute. */
const LONG_RANGE_DAYS = 62;
const MINUTE = 60_000;

function useRules(): Rule[] | undefined {
  return useLiveQuery(() => db.rules.filter((r) => r.deletedAt === null).toArray(), []);
}

/**
 * Dashboards over a range of logical days (docs/05 "Stats screen"). Loads only
 * the segments the range needs, builds every number with the shared
 * aggregation functions once per data change or minute, and keeps showing the
 * previous range, faded, while a new one loads.
 */
export function Stats() {
  const settings = useSettings();
  const categories = useCategories();
  const byId = useCategoryMap(categories);
  const rules = useRules();
  const tick = useNow(MINUTE);
  const [params, setParams] = useSearchParams();

  const requested = params.get('range');
  const kind: RangeKind = isRangeKind(requested) ? requested : 'today';
  const customFrom = params.get('from');
  const customTo = params.get('to');

  const tz = settings?.timezone;
  const startHour = settings?.dayStartHour;
  const daySettings = useMemo<DaySettings | null>(
    () =>
      tz !== undefined && startHour !== undefined
        ? { timezone: tz, dayStartHour: startHour }
        : null,
    [tz, startHour],
  );
  const todayKey = daySettings ? dayKeyOf(tick, daySettings) : null;

  const range = useMemo(
    () =>
      daySettings && todayKey
        ? resolveRange(kind, todayKey, daySettings, { from: customFrom, to: customTo })
        : null,
    [daySettings, todayKey, kind, customFrom, customTo],
  );

  const data = useLiveQuery(async () => {
    if (!range || !daySettings) return undefined;
    // The trend's moving average reaches back LOOKBACK_DAYS before the range.
    const loadFrom = dayRange(addDaysToKey(range.fromKey, -LOOKBACK_DAYS), daySettings).start;
    const segments = await loadStatsSegments(loadFrom, range.end);
    return { range, segments };
  }, [range?.key]);

  // Figures are whole minutes, so the model only moves on a minute beat (five
  // minutes for long ranges); a past range never needs now to move at all.
  const longRange = (data?.range.dayKeys.length ?? 0) > LONG_RANGE_DAYS;
  const quantised = tick - (tick % (longRange ? 5 * MINUTE : MINUTE));
  const modelNow = data && quantised > data.range.end ? data.range.end : quantised;

  const model = useMemo<StatsModel | null>(() => {
    if (!data || !daySettings || !rules || !todayKey) return null;
    return measured('stats:build', () =>
      buildStats({
        segments: data.segments,
        rules,
        settings: daySettings,
        range: data.range,
        todayKey,
        now: modelNow,
      }),
    );
  }, [data, daySettings, rules, todayKey, modelNow]);

  if (!settings || !categories || !range || !todayKey) {
    return <div className="min-h-dvh" aria-busy="true" />;
  }

  const stale = !model || model.range.key !== range.key;

  const setRange = (next: RangeKind) => {
    if (next === 'custom') {
      // Start the custom range from whatever was showing, up to today.
      const to = range.toKey > todayKey ? todayKey : range.toKey;
      setParams({ range: 'custom', from: range.fromKey, to }, { replace: true });
      return;
    }
    setParams(next === 'today' ? {} : { range: next }, { replace: true });
  };

  const focusCategoryId =
    model?.budgets.find((b) => byId.has(b.categoryId))?.categoryId ?? model?.order[0] ?? null;

  return (
    <main
      className="stats-root flex flex-col gap-5 px-4 pt-3"
      data-testid="stats"
      data-range-key={model?.range.key ?? ''}
      data-stale={stale ? 'true' : 'false'}
    >
      <header className="flex flex-col gap-0.5">
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <p className="text-sm text-muted" data-testid="range-label">
          {RANGE_LABELS[kind].long} · {rangeLabel(range)}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <RangeTabs value={kind} onChange={setRange} />
        {kind === 'custom' && (
          <CustomRangePicker
            from={range.fromKey}
            to={range.toKey}
            max={todayKey}
            onChange={(from, to) => setParams({ range: 'custom', from, to }, { replace: true })}
          />
        )}
      </div>

      {!model ? (
        <div className="min-h-96" aria-busy="true" />
      ) : (
        <div className={`flex flex-col gap-5 ${stale ? 'stats-stale' : ''}`} aria-busy={stale}>
          <StatsBody
            model={model}
            categories={categories}
            byId={byId}
            rules={rules ?? []}
            todayKey={todayKey}
            focusCategoryId={focusCategoryId}
          />
        </div>
      )}
    </main>
  );
}

interface BodyProps {
  model: StatsModel;
  categories: NonNullable<ReturnType<typeof useCategories>>;
  byId: ReturnType<typeof useCategoryMap>;
  rules: Rule[];
  todayKey: string;
  focusCategoryId: string | null;
}

function StatsBody({ model, categories, byId, rules, todayKey, focusCategoryId }: BodyProps) {
  if (!model.hasData) {
    return (
      <EmptyCard
        title="Nothing tracked yet"
        body="Pick what you are doing on the Now screen. Your first stats appear here as soon as the timer runs."
        action={{ to: '/', label: 'Go to Now' }}
      />
    );
  }
  if (
    model.activeKeys.length === 0 ||
    (model.totals.trackedMs === 0 && model.totals.untrackedMs === 0)
  ) {
    return (
      <EmptyCard
        title="Nothing in this range"
        body={
          model.trackingStartKey
            ? `Tracking began on ${shortDateLabel(model.trackingStartKey)}. Pick a range after that.`
            : 'Pick another range.'
        }
      />
    );
  }

  const startedInRange =
    model.trackingStartKey !== null && model.trackingStartKey > model.range.fromKey;

  return (
    <>
      {startedInRange && model.trackingStartKey && (
        <p className="-mt-2 text-sm text-muted" data-testid="tracking-began">
          Tracking began on {shortDateLabel(model.trackingStartKey)}; earlier days are left out of
          averages.
        </p>
      )}
      <StatTiles model={model} byId={byId} isToday={model.activeKeys.at(-1) === todayKey} />
      <TotalsList model={model} byId={byId} />
      <DailyBars model={model} byId={byId} todayKey={todayKey} />
      <HourHeatmap model={model} byId={byId} focusCategoryId={focusCategoryId} />
      <BudgetTracker model={model} byId={byId} todayKey={todayKey} />
      <TrendChart
        model={model}
        categories={categories}
        byId={byId}
        rules={rules}
        defaultCategoryId={focusCategoryId}
        todayKey={todayKey}
      />
    </>
  );
}

function EmptyCard({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { to: string; label: string };
}) {
  return (
    <section
      className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-surface p-5"
      data-testid="stats-empty"
    >
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-accent">
        <ChartColumn size={26} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted">{body}</p>
      {action && (
        <Link
          to={action.to}
          className="inline-flex min-h-14 items-center rounded-2xl bg-surface-2 px-5 font-semibold"
        >
          {action.label}
        </Link>
      )}
    </section>
  );
}
