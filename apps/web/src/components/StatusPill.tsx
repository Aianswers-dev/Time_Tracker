import { WifiOff } from 'lucide-react';
import { useOnline } from '../lib/useOnline';

/**
 * Thin status pill at the top. M1 only shows "Offline"; M2 adds the pending
 * change count from the outbox.
 */
export function StatusPill() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 z-50 flex justify-center">
      <p
        role="status"
        className="animate-fade inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted shadow-[var(--shadow)]"
      >
        <WifiOff size={14} aria-hidden />
        Offline
      </p>
    </div>
  );
}
