import { HOUR_MS, toIso, type Category, type DayKey, type Settings } from '@time-tracker/shared';
import { useState } from 'react';
import { CategorySelect } from '../../components/CategorySelect';
import { ChangeList } from '../../components/ChangeList';
import { DateTimeFields } from '../../components/DateTimeFields';
import { Sheet } from '../../components/Sheet';
import { inputClass } from '../../components/styles';
import { errorMessage, useToast } from '../../components/toast';
import { Button, ErrorText, Field } from '../../components/ui';
import { useSegmentsAround } from '../../data/hooks';
import { describeChanges, previewAction } from '../../data/preview';
import { applySegmentAction, undoAction, type SegmentAction } from '../../data/segmentActions';
import { partsToMs, sameParts, toParts, type LocalParts } from '../../lib/datetime';
import { useNow } from '../../lib/useNow';

interface Props {
  /** The untracked gap, in epoch ms. */
  start: number;
  end: number;
  settings: Settings;
  categories: readonly Category[];
  byId: ReadonlyMap<string, Category>;
  dayKey: DayKey;
  onClose: () => void;
}

/** Assign a category to untracked time with the shared insertSegment. */
export function AssignSheet({ start, end, settings, categories, byId, dayKey, onClose }: Props) {
  const tz = settings.timezone;
  const now = useNow(5_000);
  const toast = useToast();
  const [initialStart] = useState(() => toParts(start, tz));
  const [initialEnd] = useState(() => toParts(end, tz));
  const [from, setFrom] = useState<LocalParts>(initialStart);
  const [to, setTo] = useState<LocalParts>(initialEnd);
  const firstActive = categories.find((c) => c.archivedAt === null);
  const [categoryId, setCategoryId] = useState(firstActive?.id ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Untouched fields keep the gap's exact instants, seconds included.
  const fromMs = sameParts(from, initialStart) ? start : partsToMs(from, tz);
  const toMsValue = sameParts(to, initialEnd) ? end : partsToMs(to, tz);
  const action: SegmentAction | null =
    fromMs === null || toMsValue === null || !categoryId
      ? null
      : {
          kind: 'insert',
          categoryId,
          startedAt: toIso(fromMs),
          endedAt: toIso(toMsValue),
          note,
        };

  const segments = useSegmentsAround(
    Math.floor(Math.min(start, fromMs ?? start) / HOUR_MS) * HOUR_MS,
    Math.ceil(Math.max(end, toMsValue ?? end) / HOUR_MS) * HOUR_MS,
  );
  const preview = action && segments ? previewAction(segments, action, now) : null;
  // The inserted entry itself is expected; anything else it trims or removes is not.
  const changes =
    preview?.ok === true && action?.kind === 'insert'
      ? describeChanges(
          preview.prior,
          preview.result.rows,
          new Set(
            preview.result.rows
              .filter((r) => r.startedAt === action.startedAt && r.endedAt === action.endedAt)
              .map((r) => r.id),
          ),
          now,
        )
      : [];

  async function assign() {
    if (!action) return;
    setBusy(true);
    try {
      const outcome = await applySegmentAction(action);
      onClose();
      const token = outcome.undo;
      const name = byId.get(categoryId)?.name ?? 'category';
      toast.show({
        message: `Assigned to ${name}`,
        action: token
          ? {
              label: 'Undo',
              onClick: () => {
                undoAction(token).then(
                  () => toast.show({ message: 'Undone' }),
                  (err: unknown) => toast.show({ message: errorMessage(err), tone: 'error' }),
                );
              },
            }
          : undefined,
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const inputError =
    fromMs === null
      ? 'Enter a start date and time'
      : toMsValue === null
        ? 'Enter an end date and time'
        : null;

  return (
    <Sheet title="Assign untracked time" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void assign();
        }}
      >
        <CategorySelect
          label="Category"
          value={categoryId}
          onChange={setCategoryId}
          categories={categories}
        />
        <DateTimeFields label="Start" value={from} onChange={setFrom} />
        <DateTimeFields label="End" value={to} onChange={setTo} />
        <Field label="Note">
          <input
            className={inputClass}
            value={note}
            maxLength={500}
            placeholder="Optional"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <ChangeList changes={changes} categories={byId} settings={settings} dayKey={dayKey} />
        <ErrorText>
          {error ?? inputError ?? (preview?.ok === false ? preview.error : null)}
        </ErrorText>
        <Button type="submit" variant="primary" disabled={busy || !action || preview?.ok === false}>
          Assign
        </Button>
      </form>
    </Sheet>
  );
}
