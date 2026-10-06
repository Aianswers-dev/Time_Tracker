import { formatDuration, type Category } from '@time-tracker/shared';
import { memo } from 'react';
import { CategoryBadge } from '../../components/CategoryBadge';
import { CategoryIcon } from '../../icons';
import { labelColorFor } from '../../lib/contrast';
import { useLongPress } from '../../lib/useLongPress';

interface Props {
  category: Category;
  active: boolean;
  totalMs: number;
  onTap: (c: Category) => void | Promise<void>;
  onLongPress: (c: Category) => void;
}

export const CategoryTile = memo(function CategoryTile({
  category,
  active,
  totalMs,
  onTap,
  onLongPress,
}: Props) {
  const handlers = useLongPress(
    () => void onTap(category),
    () => onLongPress(category),
  );
  const label = labelColorFor(category.color);
  const total = formatDuration(totalMs);

  return (
    <button
      type="button"
      {...handlers}
      aria-pressed={active}
      aria-label={`${category.name}, ${total} today${active ? ', running' : ''}`}
      className={`no-callout flex min-h-24 w-full flex-col justify-between gap-2 rounded-2xl border p-3 text-left transition-transform duration-75 active:scale-[0.97] ${
        active ? 'shadow-[var(--shadow)]' : 'border-line bg-surface'
      }`}
      style={
        active
          ? { backgroundColor: category.color, borderColor: category.color, color: label }
          : undefined
      }
    >
      <span className="flex items-start gap-2.5">
        {active ? (
          <span
            aria-hidden
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: `${label}26` }}
          >
            <CategoryIcon name={category.icon} size={20} />
          </span>
        ) : (
          <CategoryBadge category={category} size={36} />
        )}
        <span className="min-w-0 pt-1.5 text-[15px] leading-tight font-semibold break-words">
          {category.name}
        </span>
      </span>
      <span
        className={`tabular text-sm ${active ? 'font-medium' : 'text-muted'}`}
        style={active ? { color: label, opacity: 0.9 } : undefined}
      >
        {total}
      </span>
    </button>
  );
});
