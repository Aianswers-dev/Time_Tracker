import { CloudUpload, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useNow } from '../lib/useNow';
import { useOnline } from '../lib/useOnline';
import { changesLabel } from '../sync/format';
import { onSyncNotice } from '../sync/runtime';
import { useSyncStatus } from '../sync/useSyncStatus';
import { useToast } from './toast';

/** Pending ops only count as "stuck" after this long. */
const PENDING_AFTER_MS = 10_000;

/**
 * Thin status pill above the page content, so it never covers it:
 * "Offline"; "Sync problem" (tap for Settings) after a sync error that needs
 * the owner; "N changes pending" when connected and the outbox has not
 * emptied for over 10 s. It also turns sync notices into toasts.
 */
export function StatusPill() {
  const online = useOnline();
  const status = useSyncStatus();
  const toast = useToast();

  useEffect(() => onSyncNotice((message) => toast.show({ message, tone: 'error' })), [toast]);

  const since =
    status?.oldestPendingAt != null
      ? Math.max(Date.parse(status.oldestPendingAt), status.watchFrom)
      : null;
  const now = useNow(since === null ? 60_000 : 1_000, since);

  const connected = status?.connection === 'connected';
  const pending = status?.pending ?? 0;

  if (!online) {
    return (
      <Pill icon={WifiOff}>
        Offline{connected && pending > 0 ? ` · ${changesLabel(pending)} pending` : ''}
      </Pill>
    );
  }
  if (!status) return null;
  if (status.connection === 'rejected' || status.error?.kind === 'problem') {
    return (
      <Pill icon={TriangleAlert} tone="warn" to="/settings#sync">
        Sync problem
      </Pill>
    );
  }
  if (connected && pending > 0 && since !== null && now - since > PENDING_AFTER_MS) {
    return (
      <Pill icon={CloudUpload} to="/settings#sync">
        {changesLabel(pending)} pending
      </Pill>
    );
  }
  return null;
}

interface PillProps {
  icon: LucideIcon;
  children: ReactNode;
  tone?: 'default' | 'warn';
  /** Makes the pill a link with a 56 px tall touch area. */
  to?: string;
}

function Pill({ icon: Icon, children, tone = 'default', to }: PillProps) {
  const look = `animate-fade inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
    tone === 'warn'
      ? 'border-transparent bg-warn-bg text-warn-fg'
      : 'border-line bg-surface text-muted'
  }`;
  const body = (
    <span className={look}>
      <Icon size={14} aria-hidden />
      {children}
    </span>
  );
  return (
    <div className="flex justify-center px-4 pt-2" role="status" data-testid="status-pill">
      {to ? (
        // The negative margin keeps the layout of a plain pill while the link
        // itself is 56 px tall.
        <Link to={to} className="-my-[15px] inline-flex min-h-14 items-center">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}
