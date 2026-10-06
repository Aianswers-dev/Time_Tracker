import { WifiOff } from 'lucide-react';
import { useOnline } from '../lib/useOnline';

/**
 * Thin status pill above the page content, so it never covers it. M1 only
 * shows "Offline"; M2 adds the pending change count from the outbox.
 */
export function StatusPill() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="flex justify-center px-4 pt-2">
      <p
        role="status"
        className="animate-fade inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted"
      >
        <WifiOff size={14} aria-hidden />
        Offline
      </p>
    </div>
  );
}
