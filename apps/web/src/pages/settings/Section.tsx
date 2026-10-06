import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Short note under the title. */
  description?: ReactNode;
  children?: ReactNode;
  id?: string;
}

/** A titled card on the Settings screen. Each section lives in its own file. */
export function Section({ title, description, children, id }: Props) {
  const headingId = `${id ?? title.toLowerCase().replace(/\W+/g, '-')}-h`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="px-1 text-sm font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      <div className="rounded-3xl border border-line bg-surface p-4">
        {description && <p className="mb-3 text-sm text-muted">{description}</p>}
        {children}
      </div>
    </section>
  );
}

/** Placeholder body for sections that later milestones fill in. */
export function ComingLater({ milestone, children }: { milestone: string; children: ReactNode }) {
  return (
    <p className="text-sm text-muted">
      {children} Coming in a later update ({milestone}).
    </p>
  );
}
