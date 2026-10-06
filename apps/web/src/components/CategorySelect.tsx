import type { Category } from '@time-tracker/shared';
import { CategoryBadge } from './CategoryBadge';
import { inputClass } from './styles';

interface Props {
  label: string;
  value: string;
  onChange: (id: string) => void;
  categories: readonly Category[];
}

/**
 * Native select (the iOS wheel picker) with the chosen category's badge.
 * Archived categories are offered only when already selected.
 */
export function CategorySelect({ label, value, onChange, categories }: Props) {
  const options = categories.filter((c) => c.archivedAt === null || c.id === value);
  const selected = categories.find((c) => c.id === value);
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium text-muted">{label}</span>
      <span className="flex items-center gap-2">
        {selected && <CategoryBadge category={selected} size={56} className="rounded-2xl" />}
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.archivedAt ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
