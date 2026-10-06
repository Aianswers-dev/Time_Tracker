import { ChartColumn } from 'lucide-react';
import { Link } from 'react-router';

export function Stats() {
  return (
    <main className="flex flex-col gap-4 px-4 pt-4">
      <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
      <section className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-surface p-5">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-accent">
          <ChartColumn size={26} aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">Dashboards are coming</h2>
        <p className="text-muted">
          Totals, daily bars, an hour-of-day heatmap, budgets and trends arrive in a later update
          (M4). Until then the Today screen shows each day&rsquo;s totals.
        </p>
        <Link
          to="/today"
          className="inline-flex min-h-14 items-center rounded-2xl bg-surface-2 px-5 font-semibold"
        >
          Open Today
        </Link>
      </section>
    </main>
  );
}
