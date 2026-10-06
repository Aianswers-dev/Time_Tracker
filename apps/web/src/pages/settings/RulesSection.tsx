import { ComingLater, Section } from './Section';

/** M3: rules grouped by category, add and edit, stale check settings. */
export function RulesSection() {
  return (
    <Section title="Rules">
      <ComingLater milestone="M3">
        Session limits, daily budgets and the stale check. The default rules are already stored.
      </ComingLater>
    </Section>
  );
}
