import type { Category } from '@time-tracker/shared';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { errorMessage, useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { moveCategory } from '../../data/categoryActions';
import { useCategories } from '../../data/hooks';
import { CategoryEditorSheet } from './CategoryEditorSheet';
import { Section } from './Section';

type Editing = { kind: 'new' } | { kind: 'edit'; id: string };

/** Category manager: order, add, rename, recolour, icon, stale check, archive, delete. */
export function CategoriesSection() {
  const categories = useCategories();
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);

  async function move(id: string, direction: -1 | 1) {
    try {
      await moveCategory(id, direction);
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    }
  }

  if (!categories) return null;
  const current =
    editing?.kind === 'edit' ? categories.find((c) => c.id === editing.id) : undefined;

  return (
    <Section title="Categories" description="Tap a category to edit it. Arrows change the order.">
      <ul className="-mx-1 divide-y divide-line">
        {categories.map((c, i) => (
          <CategoryRow
            key={c.id}
            category={c}
            first={i === 0}
            last={i === categories.length - 1}
            onEdit={() => setEditing({ kind: 'edit', id: c.id })}
            onMove={(d) => void move(c.id, d)}
          />
        ))}
      </ul>
      <Button className="mt-3 w-full" onClick={() => setEditing({ kind: 'new' })}>
        <Plus size={20} aria-hidden /> Add category
      </Button>
      {editing && (editing.kind === 'new' || current) && (
        <CategoryEditorSheet
          category={editing.kind === 'edit' ? current : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

interface RowProps {
  category: Category;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
}

function CategoryRow({ category, first, last, onEdit, onMove }: RowProps) {
  const archived = category.archivedAt !== null;
  return (
    <li className="flex items-center">
      <button
        type="button"
        onClick={onEdit}
        className={`flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl px-1 text-left active:bg-surface-2 ${
          archived ? 'opacity-60' : ''
        }`}
      >
        <CategoryBadge category={category} size={40} />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{category.name}</span>
          {(archived || category.exemptFromStaleCheck) && (
            <span className="block truncate text-xs text-muted">
              {[archived && 'Archived', category.exemptFromStaleCheck && 'No stale check']
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        className="inline-flex size-14 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 disabled:opacity-25"
        aria-label={`Move ${category.name} up`}
        disabled={first}
        onClick={() => onMove(-1)}
      >
        <ChevronUp size={22} />
      </button>
      <button
        type="button"
        className="inline-flex size-14 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 disabled:opacity-25"
        aria-label={`Move ${category.name} down`}
        disabled={last}
        onClick={() => onMove(1)}
      >
        <ChevronDown size={22} />
      </button>
    </li>
  );
}
