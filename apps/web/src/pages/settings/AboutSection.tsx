import { ExternalLink } from 'lucide-react';
import { isStandalone } from '../../lib/standalone';
import { Section } from './Section';

const REPO_URL = 'https://github.com/Aianswers-dev/Time_Tracker';

export function AboutSection() {
  const rows: Array<[string, string]> = [
    ['Version', __APP_VERSION__],
    ['Build', __BUILD_SHA__],
    ['Installed to Home Screen', isStandalone() ? 'Yes' : 'No'],
  ];
  return (
    <Section title="About">
      <dl className="divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-h-11 items-center justify-between gap-4">
            <dt className="text-muted">{k}</dt>
            <dd className="tabular font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 flex min-h-14 items-center justify-between rounded-2xl bg-surface-2 px-4 font-semibold"
      >
        Source on GitHub
        <ExternalLink size={18} aria-hidden />
      </a>
    </Section>
  );
}
