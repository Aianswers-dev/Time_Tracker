import { CATEGORY_PALETTE, type Category } from '@time-tracker/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, ArchiveRestore, Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { Sheet } from '../../components/Sheet';
import { inputClass } from '../../components/styles';
import { errorMessage, useToast } from '../../components/toast';
import { Button, ErrorText, Field } from '../../components/ui';
import {
  addCategory,
  countSegments,
  deleteCategory,
  setArchived,
  updateCategory,
  type CategoryDraft,
} from '../../data/categoryActions';
import { CATEGORY_ICON_MAP, CATEGORY_ICON_NAMES } from '../../icons';
import { labelColorFor } from '../../lib/contrast';

interface Props {
  /** Undefined to add a new category. */
  category?: Category;
  /** All live categories, so a new one starts with an unused colour and icon. */
  existing: readonly Category[];
  onClose: () => void;
}

/** The first option no existing category uses, else the first option. */
function firstUnused(options: readonly string[], used: readonly string[]): string {
  const taken = new Set(used.map((u) => u.toLowerCase()));
  return options.find((o) => !taken.has(o.toLowerCase())) ?? options[0] ?? '';
}

export function CategoryEditorSheet({ category, existing, onClose }: Props) {
  const toast = useToast();
  const [draft, setDraft] = useState<CategoryDraft>(() => ({
    name: category?.name ?? '',
    color:
      category?.color ??
      firstUnused(
        CATEGORY_PALETTE,
        existing.map((c) => c.color),
      ),
    icon:
      category?.icon ??
      firstUnused(
        CATEGORY_ICON_NAMES,
        existing.map((c) => c.icon),
      ),
    exemptFromStaleCheck: category?.exemptFromStaleCheck ?? false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const segmentCount = useLiveQuery(
    () => (category ? countSegments(category.id) : Promise.resolve(0)),
    [category?.id],
  );

  const set = <K extends keyof CategoryDraft>(key: K, value: CategoryDraft[K]) => {
    setError(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  async function attempt(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
      toast.show({ message });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const save = () =>
    attempt(
      () =>
        category
          ? updateCategory(category.id, {
              name: draft.name,
              color: draft.color,
              icon: draft.icon,
              exemptFromStaleCheck: draft.exemptFromStaleCheck,
            })
          : addCategory(draft),
      category ? 'Category saved' : `Added ${draft.name.trim()}`,
    );

  const archived = category?.archivedAt != null;
  const palette = CATEGORY_PALETTE.includes(draft.color)
    ? CATEGORY_PALETTE
    : [draft.color, ...CATEGORY_PALETTE];

  return (
    <Sheet title={category ? `Edit ${category.name}` : 'New category'} onClose={onClose}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-3">
          <CategoryBadge category={draft} size={56} className="rounded-2xl" />
          <Field label="Name" className="flex-1">
            <input
              className={inputClass}
              value={draft.name}
              maxLength={40}
              placeholder="e.g. Exercise"
              onChange={(e) => set('name', e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-muted">Colour</legend>
          <div className="grid grid-cols-6 gap-2">
            {palette.map((hex) => {
              const selected = draft.color.toLowerCase() === hex.toLowerCase();
              return (
                <button
                  key={hex}
                  type="button"
                  aria-label={`Colour ${hex}`}
                  aria-pressed={selected}
                  onClick={() => set('color', hex)}
                  className={`inline-flex aspect-square min-h-14 items-center justify-center rounded-2xl ${
                    selected ? 'ring-2 ring-fg ring-offset-2 ring-offset-[var(--surface)]' : ''
                  }`}
                  style={{ backgroundColor: hex, color: labelColorFor(hex) }}
                >
                  {selected && <Check size={22} aria-hidden />}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-muted">Icon</legend>
          <div className="grid grid-cols-6 gap-2">
            {CATEGORY_ICON_NAMES.map((name) => {
              const Icon = CATEGORY_ICON_MAP[name];
              if (!Icon) return null;
              const selected = draft.icon === name;
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={`Icon ${name.replaceAll('-', ' ')}`}
                  aria-pressed={selected}
                  onClick={() => set('icon', name)}
                  className={`inline-flex aspect-square min-h-14 items-center justify-center rounded-2xl ${
                    selected ? '' : 'bg-surface-2 text-fg'
                  }`}
                  style={
                    selected
                      ? { backgroundColor: draft.color, color: labelColorFor(draft.color) }
                      : undefined
                  }
                >
                  <Icon size={24} aria-hidden />
                </button>
              );
            })}
          </div>
        </fieldset>

        <button
          type="button"
          role="switch"
          aria-checked={!draft.exemptFromStaleCheck}
          onClick={() => set('exemptFromStaleCheck', !draft.exemptFromStaleCheck)}
          className="flex min-h-14 items-center justify-between gap-4 rounded-2xl bg-surface-2 px-4 text-left"
        >
          <span>
            <span className="block font-medium">Stale check</span>
            <span className="block text-xs text-muted">
              Nudge when this runs implausibly long. Turn off for Sleep.
            </span>
          </span>
          <span
            aria-hidden
            className={`relative h-8 w-13 shrink-0 rounded-full transition-colors ${
              draft.exemptFromStaleCheck ? 'bg-line' : 'bg-accent'
            }`}
          >
            <span
              className={`absolute top-1 size-6 rounded-full bg-white shadow transition-transform ${
                draft.exemptFromStaleCheck ? 'left-1' : 'left-6'
              }`}
            />
          </span>
        </button>

        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy || draft.name.trim() === ''}>
          {category ? 'Save' : 'Add category'}
        </Button>

        {category && (
          <div className={`grid gap-2 ${segmentCount === 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <Button
              disabled={busy}
              onClick={() =>
                void attempt(
                  () => setArchived(category.id, !archived),
                  archived
                    ? `${category.name} is back on the Now screen`
                    : `${category.name} archived`,
                )
              }
            >
              {archived ? (
                <ArchiveRestore size={18} aria-hidden />
              ) : (
                <Archive size={18} aria-hidden />
              )}
              {archived ? 'Unarchive' : 'Archive'}
            </Button>
            {/* Deleting is only offered for a category that was never used. */}
            {segmentCount === 0 && (
              <Button
                variant="danger-soft"
                disabled={busy}
                onClick={() =>
                  void attempt(() => deleteCategory(category.id), `${category.name} deleted`)
                }
              >
                <Trash2 size={18} aria-hidden /> Delete
              </Button>
            )}
          </div>
        )}
        {category && segmentCount !== undefined && segmentCount > 0 && (
          <p className="-mt-2 text-center text-xs text-muted">
            Used by {segmentCount} {segmentCount === 1 ? 'entry' : 'entries'}. Archive it to hide it
            from the Now screen and keep its history.
          </p>
        )}
      </form>
    </Sheet>
  );
}
