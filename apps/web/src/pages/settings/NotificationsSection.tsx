import { ComingLater, Section } from './Section';

/** M3: install hint when not standalone, push toggle, status and test button. */
export function NotificationsSection() {
  return (
    <Section title="Notifications">
      <ComingLater milestone="M3">Nudges when you spend too long on something.</ComingLater>
    </Section>
  );
}
