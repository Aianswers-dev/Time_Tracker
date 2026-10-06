import { CloudUpload, X } from 'lucide-react';
import { Link } from 'react-router';
import { dismissConnectBanner } from '../../sync/actions';
import { useShowConnectBanner } from '../../sync/useConnectBanner';

/** Shown on the Now screen until a token is saved or the owner dismisses it. */
export function ConnectBanner() {
  const show = useShowConnectBanner();
  if (!show) return null;
  return (
    <aside
      className="animate-fade flex items-center rounded-3xl border border-line bg-surface"
      aria-label="Sync"
      data-testid="connect-banner"
    >
      <Link
        to="/settings#sync"
        className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-l-3xl py-3 pl-3 active:bg-surface-2"
      >
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
          <CloudUpload size={20} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 leading-snug">
          <span className="block text-[15px] font-semibold">Connect to your server</span>
          <span className="block text-sm text-muted">to get nudges and keep a backup</span>
        </span>
      </Link>
      <button
        type="button"
        className="inline-flex size-14 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
        onClick={() => void dismissConnectBanner()}
        aria-label="Dismiss"
      >
        <X size={20} aria-hidden />
      </button>
    </aside>
  );
}
