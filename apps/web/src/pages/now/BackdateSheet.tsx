import {
  dayKeyOf,
  formatDuration,
  HOUR_MS,
  localHHMM,
  MINUTE_MS,
  toIso,
  type Category,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { useState } from 'react';
import { ChangeList } from '../../components/ChangeList';
import { Sheet } from '../../components/Sheet';
import { inputClass } from '../../components/styles';
import { errorMessage } from '../../components/toast';
import { Button, ErrorText, Field } from '../../components/ui';
import { useSegmentsAround } from '../../data/hooks';
import { describeChanges, previewAction } from '../../data/preview';
import { applySegmentAction, type SegmentAction, type UndoToken } from '../../data/segmentActions';
import { clockTimeToMs } from '../../lib/datetime';
import { useNow } from '../../lib/useNow';

export type BackdateMode = 'backdate' | 'switch';

type Choice = { kind: 'ago'; minutes: number } | { kind: 'clock'; hhmm: string };

const QUICK_PICKS = [5, 15, 30, 60] as const;

interface Props {
  /** backdate: move the running entry's start. switch: start `category` at a past time. */
  mode: BackdateMode;
  category: Category;
  open: Segment | null;
  settings: Settings;
  categories: ReadonlyMap<string, Category>;
  onClose: () => void;
  onDone: (message: string, undo: UndoToken | null) => void;
}

function resolve(choice: Choice | null, nowMs: number, timezone: string): number | null {
  if (!choice) return null;
  if (choice.kind === 'ago') return nowMs - choice.minutes * MINUTE_MS;
  return clockTimeToMs(choice.hhmm, nowMs, timezone);
}

function actionFor(mode: BackdateMode, categoryId: string, atMs: number): SegmentAction {
  return mode === 'backdate'
    ? { kind: 'backdate', startedAt: toIso(atMs) }
    : { kind: 'switch', categoryId, at: toIso(atMs), source: 'app' };
}

export function BackdateSheet({
  mode,
  category,
  open,
  settings,
  categories,
  onClose,
  onDone,
}: Props) {
  const now = useNow(5_000);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = settings.timezone;

  const atMs = resolve(choice, now, tz);
  // Window keyed to the hour so the live query does not restart on every tick.
  const windowFrom = atMs === null ? null : Math.floor(atMs / HOUR_MS) * HOUR_MS;
  const segments = useSegmentsAround(windowFrom, Infinity);

  const preview =
    atMs !== null && segments
      ? previewAction(segments, actionFor(mode, category.id, atMs), now)
      : null;

  // The entry being moved, the new entry, and the running entry being closed at
  // the chosen time are expected. Anything else is worth a warning.
  const changes =
    preview?.ok === true
      ? describeChanges(
          preview.prior,
          preview.result.rows,
          new Set(
            [
              mode === 'backdate' ? open?.id : undefined,
              preview.result.opened?.id,
              ...preview.result.rows
                .filter((r) => mode === 'switch' && r.id === open?.id && r.deletedAt === null)
                .map((r) => r.id),
            ].filter((id): id is string => id !== undefined),
          ),
          now,
        )
      : [];

  async function confirm() {
    // Resolve against the current time, not the last render.
    const at = resolve(choice, Date.now(), tz);
    if (at === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applySegmentAction(actionFor(mode, category.id, at));
      const hhmm = localHHMM(at, tz);
      if (outcome.noop) {
        onClose();
        return;
      }
      onDone(
        mode === 'backdate'
          ? `${category.name} now started at ${hhmm}`
          : `Switched to ${category.name} from ${hhmm}`,
        outcome.undo,
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const timeValue =
    choice?.kind === 'clock' ? choice.hhmm : atMs !== null ? localHHMM(atMs, tz) : '';
  const title =
    mode === 'backdate' ? `When did ${category.name} start?` : `Switch to ${category.name} from…`;
  const shownError = error ?? (preview?.ok === false ? preview.error : null);

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2 text-sm font-medium text-muted">Started … ago</p>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="Started ago">
            {QUICK_PICKS.map((m) => {
              const selected = choice?.kind === 'ago' && choice.minutes === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setError(null);
                    setChoice({ kind: 'ago', minutes: m });
                  }}
                  className={`min-h-14 rounded-2xl text-base font-semibold active:opacity-75 ${
                    selected ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg'
                  }`}
                >
                  {m === 60 ? '1 h' : `${m} min`}
                </button>
              );
            })}
          </div>
        </div>

        <Field label="Or pick a time" hint="A time later than now means yesterday.">
          <input
            type="time"
            className={`${inputClass} tabular`}
            value={timeValue}
            onChange={(e) => {
              setError(null);
              setChoice(e.target.value ? { kind: 'clock', hhmm: e.target.value } : null);
            }}
          />
        </Field>

        {atMs !== null && (
          <p className="text-sm" data-testid="backdate-summary">
            Start at <strong className="tabular">{localHHMM(atMs, tz)}</strong>
            {dayKeyOf(atMs, settings) !== dayKeyOf(now, settings) && ' yesterday'}
            <span className="text-muted"> · {formatDuration(now - atMs)} ago</span>
          </p>
        )}

        <ChangeList
          changes={changes}
          categories={categories}
          settings={settings}
          dayKey={dayKeyOf(now, settings)}
        />
        <ErrorText>{shownError}</ErrorText>

        <Button
          variant="primary"
          disabled={atMs === null || busy || preview?.ok === false}
          onClick={() => void confirm()}
        >
          {mode === 'backdate' ? 'Set start time' : `Switch to ${category.name}`}
        </Button>
      </div>
    </Sheet>
  );
}
