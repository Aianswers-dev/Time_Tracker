import {
  dayKeyOf,
  dayRange,
  formatClock,
  localHHMM,
  toMs,
  totalsForRange,
  type Category,
} from '@time-tracker/shared';
import { useCallback, useMemo, useState } from 'react';
import { CategoryBadge } from '../components/CategoryBadge';
import { errorMessage, useToast } from '../components/toast';
import {
  useCategories,
  useCategoryMap,
  useOpenSegment,
  useSegmentsAround,
  useSettings,
} from '../data/hooks';
import { switchTo, undoAction, type UndoToken } from '../data/segmentActions';
import { useNow } from '../lib/useNow';
import { BackdateSheet, type BackdateMode } from './now/BackdateSheet';
import { ConnectBanner } from './now/ConnectBanner';
import { CategoryTile } from './now/CategoryTile';

export function Now() {
  const settings = useSettings();
  const categories = useCategories();
  const byId = useCategoryMap(categories);
  const open = useOpenSegment();
  const now = useNow(1000, open?.startedAt);
  const toast = useToast();
  const [sheet, setSheet] = useState<{ mode: BackdateMode; category: Category } | null>(null);

  const todayKey = settings ? dayKeyOf(now, settings) : null;
  const tz = settings?.timezone;
  const startHour = settings?.dayStartHour;
  const range = useMemo(
    () =>
      todayKey && tz !== undefined && startHour !== undefined
        ? dayRange(todayKey, { timezone: tz, dayStartHour: startHour })
        : null,
    [todayKey, tz, startHour],
  );
  const segments = useSegmentsAround(range?.start ?? null, range?.end ?? 0);
  const totals = useMemo(
    () =>
      segments && range ? totalsForRange(segments, range.start, range.end, now).byCategory : {},
    [segments, range, now],
  );

  const visible = useMemo(
    () => (categories ?? []).filter((c) => c.archivedAt === null),
    [categories],
  );
  const active = open ? byId.get(open.categoryId) : undefined;

  const undo = useCallback(
    async (token: UndoToken) => {
      try {
        await undoAction(token);
        toast.show({ message: 'Undone' });
      } catch (err) {
        toast.show({ message: errorMessage(err), tone: 'error' });
      }
    },
    [toast],
  );

  const offerUndo = useCallback(
    (message: string, token: UndoToken | null) => {
      toast.show({
        message,
        action: token ? { label: 'Undo', onClick: () => void undo(token) } : undefined,
        durationMs: 10_000,
      });
    },
    [toast, undo],
  );

  const onTap = useCallback(
    async (category: Category) => {
      if (open?.categoryId === category.id) {
        setSheet({ mode: 'backdate', category });
        return;
      }
      try {
        const outcome = await switchTo(category.id);
        if (!outcome.noop) offerUndo(`Switched to ${category.name}`, outcome.undo);
      } catch (err) {
        toast.show({ message: errorMessage(err), tone: 'error' });
      }
    },
    [open, offerUndo, toast],
  );

  const onLongPress = useCallback(
    (category: Category) => {
      setSheet({ mode: open?.categoryId === category.id ? 'backdate' : 'switch', category });
    },
    [open],
  );

  if (!settings || !categories || open === undefined) {
    return <div className="min-h-dvh" aria-busy="true" />;
  }

  return (
    <main className="flex flex-col gap-4 px-4 pt-4">
      <ConnectBanner />
      <section
        className="rounded-3xl border border-line bg-surface p-4"
        aria-label="Current activity"
        data-testid="now-header"
        data-category={active?.name ?? ''}
      >
        {open && active ? (
          <button
            type="button"
            className="flex w-full items-center gap-4 text-left"
            onClick={() => setSheet({ mode: 'backdate', category: active })}
          >
            <CategoryBadge category={active} size={56} className="rounded-2xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold">{active.name}</p>
              <p
                className="tabular text-[2.75rem] leading-none font-semibold tracking-tight"
                data-testid="timer"
              >
                {formatClock(now - toMs(open.startedAt))}
              </p>
              <p className="mt-1.5 text-sm text-muted">
                Since {localHHMM(open.startedAt, settings.timezone)} · tap to adjust
              </p>
            </div>
          </button>
        ) : (
          <div className="py-2">
            <h1 className="text-2xl font-semibold tracking-tight">What are you doing?</h1>
            <p className="mt-1 text-sm text-muted">
              Tap a category to start tracking. Hold one to say when you started.
            </p>
          </div>
        )}
      </section>

      <ul className="grid grid-cols-2 gap-3" aria-label="Categories">
        {visible.map((c) => (
          <li key={c.id} className="flex">
            <CategoryTile
              category={c}
              active={open?.categoryId === c.id}
              totalMs={totals[c.id] ?? 0}
              onTap={onTap}
              onLongPress={onLongPress}
            />
          </li>
        ))}
      </ul>

      {sheet && (
        <BackdateSheet
          mode={sheet.mode}
          category={sheet.category}
          open={open}
          settings={settings}
          categories={byId}
          onClose={() => setSheet(null)}
          onDone={(message, token) => {
            setSheet(null);
            offerUndo(message, token);
          }}
        />
      )}
    </main>
  );
}
