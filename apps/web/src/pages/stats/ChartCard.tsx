import { ChartColumn, Table2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

interface Props {
  title: string;
  /** One line under the title saying what is plotted. */
  subtitle?: ReactNode;
  /** The chart's table twin. When given, a toggle switches between them. */
  table?: () => ReactNode;
  children: ReactNode;
  testId?: string;
}

/**
 * A titled card for one chart. Every chart has a table view (dataviz: the
 * accessible twin), behind a toggle in the header so values never depend on
 * hovering or colour.
 */
export function ChartCard({ title, subtitle, table, children, testId }: Props) {
  const headingId = useId();
  const [showTable, setShowTable] = useState(false);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex min-h-14 items-end gap-2 px-1">
        <div className="min-w-0 flex-1 pb-1">
          <h2 id={headingId} className="text-sm font-semibold tracking-wide text-muted uppercase">
            {title}
          </h2>
        </div>
        {table && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            className="-mr-2 inline-flex min-h-14 items-center gap-1.5 rounded-2xl px-3 text-sm font-medium text-accent active:bg-surface-2"
          >
            {showTable ? <ChartColumn size={18} aria-hidden /> : <Table2 size={18} aria-hidden />}
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
      </div>
      <div className="rounded-3xl border border-line bg-surface p-4">
        {subtitle && <p className="mb-3 text-sm text-muted">{subtitle}</p>}
        {showTable && table ? table() : children}
      </div>
    </section>
  );
}

interface TableProps {
  caption: string;
  head: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
}

/** A compact, scrollable data table for a chart's table view. */
export function DataTable({ caption, head, rows }: TableProps) {
  return (
    <div className="-mx-1 max-h-96 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`border-b border-line px-1.5 py-2 font-medium whitespace-nowrap text-muted ${i === 0 ? 'text-left' : 'text-right'}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-line last:border-b-0">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th
                    key={i}
                    scope="row"
                    className="px-1.5 py-2 text-left font-normal whitespace-nowrap"
                  >
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="tabular px-1.5 py-2 text-right whitespace-nowrap">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
