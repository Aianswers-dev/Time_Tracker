import type { ReactNode } from 'react';

interface TooltipProps {
  /** Anchor x in pixels from the container's left edge. */
  x: number;
  /** Container width, to place the tooltip on the side away from the anchor. */
  width: number;
  top?: number;
  children: ReactNode;
}

/**
 * A floating readout beside the inspected mark, on the side away from it so the
 * mark stays visible under a finger. Purely visual: each chart also announces
 * the same text in a live region and lists it in its table view.
 */
export function ChartTooltip({ x, width, top = 0, children }: TooltipProps) {
  const leftSide = x > width / 2;
  // Never wider than the room on its side, so it stays inside the card.
  const room = Math.max(140, (leftSide ? x : width - x) - 12);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 w-max rounded-2xl border border-line px-3 py-2 text-sm shadow-[var(--shadow)]"
      style={{
        top,
        maxWidth: room,
        backgroundColor: 'var(--tooltip-bg)',
        ...(leftSide ? { right: Math.max(0, width - x + 12) } : { left: Math.max(0, x + 12) }),
      }}
    >
      {children}
    </div>
  );
}

interface RowProps {
  color?: string;
  hatched?: boolean;
  /** Line key shape: a short stroke (default) or a faded stroke for context series. */
  faded?: boolean;
  label: ReactNode;
  value: ReactNode;
}

/** One tooltip row: value first and strong, the series name after it in muted ink. */
export function TooltipRow({ color, hatched, faded, label, value }: RowProps) {
  return (
    <div className="flex items-center gap-2 leading-5">
      <span
        aria-hidden
        className={`inline-block h-[3px] w-3 shrink-0 rounded-full ${hatched ? 'hatched h-2' : ''}`}
        style={
          hatched ? undefined : { backgroundColor: color, opacity: faded ? 'var(--faded)' : 1 }
        }
      />
      <span className="tabular shrink-0 font-semibold whitespace-nowrap">{value}</span>
      <span className="min-w-0 truncate text-muted">{label}</span>
    </div>
  );
}

interface LegendItem {
  key: string;
  label: string;
  color?: string;
  hatched?: boolean;
  /** 'rect' for bars and cells, 'line' for lines. */
  shape?: 'rect' | 'line';
  faded?: boolean;
}

/** Legend under a chart. Text stays in text ink; the swatch beside it carries the colour. */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted">
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          {item.shape === 'line' ? (
            <span
              aria-hidden
              className="inline-block h-[3px] w-4 rounded-full"
              style={{ backgroundColor: item.color, opacity: item.faded ? 'var(--faded)' : 1 }}
            />
          ) : (
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-[3px] ${item.hatched ? 'hatched' : ''}`}
              style={item.hatched ? undefined : { backgroundColor: item.color }}
            />
          )}
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
