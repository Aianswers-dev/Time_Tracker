import { ComingLater, Section } from './Section';

/** M2: token, Sync now, last sync time, pending op count, reset and re-download. */
export function SyncSection() {
  return (
    <Section title="Sync">
      <ComingLater milestone="M2">
        Sync with your server, the pending change count and a full re-download.
      </ComingLater>
    </Section>
  );
}
