import {
  HOUR_MS,
  toIso,
  toMs,
  type Category,
  type DayKey,
  type DeleteFill,
  type EditParams,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { ArrowLeft, Scissors, Trash2 } from 'lucide-react';
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
import {
  applySegmentAction,
  undoAction,
  type SegmentAction,
  type UndoToken,
} from '../../data/segmentActions';
import { partsToMs, sameParts, toParts, type LocalParts } from '../../lib/datetime';
import { timeOnDay } from '../../lib/format';
import { useNow } from '../../lib/useNow';

interface Props {
  segment: Segment;
  settings: Settings;
  categories: readonly Category[];
  byId: ReadonlyMap<string, Category>;
  dayKey: DayKey;
  onClose: () => void;
}

type View = 'edit' | 'split' | 'delete';

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const ceilHour = (ms: number) => (Number.isFinite(ms) ? Math.ceil(ms / HOUR_MS) * HOUR_MS : ms);

export function EditSheet({ segment, settings, categories, byId, dayKey, onClose }: Props) {
  const [view, setView] = useState<View>('edit');
  const toast = useToast();
  const category = byId.get(segment.categoryId);
  const isOpen = segment.endedAt === null;

  async function run(action: SegmentAction, message: string): Promise<string | null> {
    try {
      const outcome = await applySegmentAction(action);
      onClose();
      if (!outcome.noop) {
        const token: UndoToken | null = outcome.undo;
        toast.show({
          message,
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
      }
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  const back = (
    <button
      type="button"
      className="inline-flex size-14 items-center justify-center rounded-full active:bg-surface-2"
      aria-label="Back"
      onClick={() => setView('edit')}
    >
      <ArrowLeft size={22} />
    </button>
  );

  const name = category?.name ?? 'entry';
  const shared = { segment, settings, categories, byId, dayKey, run };

  if (view === 'split') {
    return (
      <Sheet title={`Split ${name}`} onClose={onClose} leading={back}>
        <SplitView {...shared} />
      </Sheet>
    );
  }
  if (view === 'delete') {
    return (
      <Sheet title={`Delete ${name}`} onClose={onClose} leading={back}>
        <DeleteView {...shared} />
      </Sheet>
    );
  }
  return (
    <Sheet title={isOpen ? `Edit ${name} (running)` : `Edit ${name}`} onClose={onClose}>
      <EditView {...shared} onSplit={() => setView('split')} onDelete={() => setView('delete')} />
    </Sheet>
  );
}

interface ViewProps {
  segment: Segment;
  settings: Settings;
  categories: readonly Category[];
  byId: ReadonlyMap<string, Category>;
  dayKey: DayKey;
  run: (action: SegmentAction, message: string) => Promise<string | null>;
}

function EditView({
  segment,
  settings,
  categories,
  byId,
  dayKey,
  run,
  onSplit,
  onDelete,
}: ViewProps & { onSplit: () => void; onDelete: () => void }) {
  const tz = settings.timezone;
  const now = useNow(5_000);
  const isOpen = segment.endedAt === null;
  const startMs = toMs(segment.startedAt);
  const endMs = segment.endedAt === null ? null : toMs(segment.endedAt);

  const [initialStart] = useState(() => toParts(startMs, tz));
  const [initialEnd] = useState(() => (endMs === null ? null : toParts(endMs, tz)));
  const [categoryId, setCategoryId] = useState(segment.categoryId);
  const [start, setStart] = useState<LocalParts>(initialStart);
  const [end, setEnd] = useState<LocalParts | null>(initialEnd);
  const [note, setNote] = useState(segment.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only send fields the owner changed, so an untouched time keeps its seconds.
  const params: EditParams = { id: segment.id };
  let inputError: string | null = null;
  if (categoryId !== segment.categoryId) params.categoryId = categoryId;
  if (!sameParts(start, initialStart)) {
    const ms = partsToMs(start, tz);
    if (ms === null) inputError = 'Enter a start date and time';
    else params.startedAt = toIso(ms);
  }
  if (end && initialEnd && !sameParts(end, initialEnd)) {
    const ms = partsToMs(end, tz);
    if (ms === null) inputError = 'Enter an end date and time';
    else params.endedAt = toIso(ms);
  }
  const trimmed = note.trim();
  if ((trimmed === '' ? null : trimmed) !== segment.note) params.note = trimmed;
  const dirty = Object.keys(params).length > 1;

  const newStart = params.startedAt ? toMs(params.startedAt) : startMs;
  const newEnd = params.endedAt ? toMs(params.endedAt) : (endMs ?? Infinity);
  const segments = useSegmentsAround(
    floorHour(Math.min(startMs, newStart)),
    ceilHour(Math.max(endMs ?? Infinity, newEnd)),
  );
  const preview =
    dirty && !inputError && segments
      ? previewAction(segments, { kind: 'edit', params }, now)
      : null;
  const changes =
    preview?.ok === true
      ? describeChanges(preview.prior, preview.result.rows, new Set([segment.id]), now)
      : [];

  async function save() {
    setBusy(true);
    setError(await run({ kind: 'edit', params }, 'Entry saved'));
    setBusy(false);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <CategorySelect
        label="Category"
        value={categoryId}
        onChange={setCategoryId}
        categories={categories}
      />
      <DateTimeFields label="Start" value={start} onChange={setStart} />
      {end ? (
        <DateTimeFields label="End" value={end} onChange={setEnd} />
      ) : (
        <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
          Running now. Switch category on the Now screen to end it.
        </p>
      )}
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
      <ErrorText>{error ?? inputError ?? (preview?.ok === false ? preview.error : null)}</ErrorText>

      <Button
        type="submit"
        variant="primary"
        disabled={!dirty || busy || inputError !== null || preview?.ok === false}
      >
        Save
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onSplit}>
          <Scissors size={18} aria-hidden /> Split
        </Button>
        <Button onClick={onDelete} className="text-danger">
          <Trash2 size={18} aria-hidden /> Delete
        </Button>
      </div>
      {isOpen && (
        <p className="text-center text-xs text-muted">
          Moving the start also moves the end of the entry before it.
        </p>
      )}
    </form>
  );
}

function SplitView({ segment, settings, categories, byId, dayKey, run }: ViewProps) {
  const tz = settings.timezone;
  const now = useNow(5_000);
  const startMs = toMs(segment.startedAt);
  const [endAtOpen] = useState(() => Date.now());
  const endMs = segment.endedAt === null ? endAtOpen : toMs(segment.endedAt);
  const [at, setAt] = useState<LocalParts>(() => toParts((startMs + endMs) / 2, tz));
  const firstOther = categories.find((c) => c.archivedAt === null && c.id !== segment.categoryId);
  const [secondId, setSecondId] = useState(firstOther?.id ?? segment.categoryId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const atMs = partsToMs(at, tz);
  const segments = useSegmentsAround(
    floorHour(startMs),
    ceilHour(segment.endedAt ? endMs : Infinity),
  );
  const action: SegmentAction | null =
    atMs === null
      ? null
      : { kind: 'split', id: segment.id, at: toIso(atMs), secondCategoryId: secondId };
  const preview = action && segments ? previewAction(segments, action, now) : null;
  const first = byId.get(segment.categoryId)?.name ?? 'Entry';
  const second = byId.get(secondId)?.name ?? 'Entry';

  async function split() {
    if (!action) return;
    setBusy(true);
    setError(await run(action, `Split into ${first} and ${second}`));
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {first} from {timeOnDay(startMs, dayKey, settings)} to{' '}
        {segment.endedAt === null ? 'now' : timeOnDay(endMs, dayKey, settings)}. Pick where the
        second part starts.
      </p>
      <DateTimeFields label="Split at" value={at} onChange={setAt} />
      <CategorySelect
        label="Second part"
        value={secondId}
        onChange={setSecondId}
        categories={categories}
      />
      {atMs !== null && preview?.ok === true && (
        <p className="tabular text-sm">
          {first} {timeOnDay(startMs, dayKey, settings)}–{timeOnDay(atMs, dayKey, settings)}, then{' '}
          {second} {timeOnDay(atMs, dayKey, settings)}–
          {segment.endedAt === null ? 'now' : timeOnDay(endMs, dayKey, settings)}
        </p>
      )}
      <ErrorText>
        {error ??
          (atMs === null ? 'Enter a date and time' : preview?.ok === false ? preview.error : null)}
      </ErrorText>
      <Button
        variant="primary"
        disabled={busy || atMs === null || preview?.ok === false}
        onClick={() => void split()}
      >
        <Scissors size={18} aria-hidden /> Split
      </Button>
    </div>
  );
}

function DeleteView({ segment, settings, byId, dayKey, run }: ViewProps) {
  const now = useNow(5_000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startMs = toMs(segment.startedAt);
  const isOpen = segment.endedAt === null;
  const endMs = segment.endedAt === null ? Infinity : toMs(segment.endedAt);
  const segments = useSegmentsAround(floorHour(startMs), ceilHour(endMs));

  // Which neighbour each fill would use, from a preview of the shared operation.
  const preview = (fill: DeleteFill) =>
    segments ? previewAction(segments, { kind: 'delete', id: segment.id, fill }, now) : null;
  const neighbour = (fill: DeleteFill): string | null => {
    const p = preview(fill);
    if (!p?.ok) return null;
    const other = p.result.rows.find((r) => r.id !== segment.id && r.deletedAt === null);
    return other ? (byId.get(other.categoryId)?.name ?? 'Entry') : null;
  };

  async function remove(fill: DeleteFill) {
    setBusy(true);
    setError(await run({ kind: 'delete', id: segment.id, fill }, 'Entry deleted'));
    setBusy(false);
  }

  const span = `${timeOnDay(startMs, dayKey, settings)}–${
    isOpen ? 'now' : timeOnDay(endMs, dayKey, settings)
  }`;

  if (isOpen) {
    const prev = neighbour('prev');
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Something is always running, so deleting the current entry continues the one before it.
        </p>
        <ErrorText>
          {error ?? (segments && !prev ? 'There is nothing before this to continue.' : null)}
        </ErrorText>
        <Button variant="danger" disabled={busy || !prev} onClick={() => void remove('prev')}>
          {prev ? `Delete and continue ${prev}` : 'Delete'}
        </Button>
      </div>
    );
  }

  const prev = neighbour('prev');
  const next = neighbour('next');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {byId.get(segment.categoryId)?.name ?? 'Entry'} {span}. What should cover that time?
      </p>
      <Button variant="secondary" disabled={busy || !prev} onClick={() => void remove('prev')}>
        {prev ? `Fill from previous (${prev})` : 'Fill from previous (none)'}
      </Button>
      <Button variant="secondary" disabled={busy || !next} onClick={() => void remove('next')}>
        {next ? `Fill from next (${next})` : 'Fill from next (none)'}
      </Button>
      <Button variant="danger" disabled={busy} onClick={() => void remove('none')}>
        Leave gap
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
