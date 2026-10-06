import type { Category } from '@time-tracker/shared';
import { CategoryIcon } from '../icons';
import { labelColorFor } from '../lib/contrast';

interface Props {
  category: Pick<Category, 'color' | 'icon'>;
  size?: number;
  className?: string;
}

/** A rounded square in the category colour with its icon in a readable label colour. */
export function CategoryBadge({ category, size = 40, className = '' }: Props) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-xl ${className}`}
      style={{
        backgroundColor: category.color,
        color: labelColorFor(category.color),
        width: size,
        height: size,
      }}
    >
      <CategoryIcon name={category.icon} size={Math.round(size * 0.55)} strokeWidth={2} />
    </span>
  );
}

/** Grey hatched badge for untracked time. */
export function UntrackedBadge({ size = 40 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="hatched inline-flex shrink-0 rounded-xl border border-line"
      style={{ width: size, height: size }}
    />
  );
}
