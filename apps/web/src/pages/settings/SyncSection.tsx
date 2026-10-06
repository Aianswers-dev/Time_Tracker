import { Eye, EyeOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { Sheet } from '../../components/Sheet';
import { inputClass } from '../../components/styles';
import { useToast } from '../../components/toast';
import { Button, ErrorText } from '../../components/ui';
import { useNow } from '../../lib/useNow';
import {
  connect,
  disconnect,
  resetLocalData,
  syncNow,
  tokenErrorMessage,
} from '../../sync/actions';
import type { RoundOutcome } from '../../sync/engine';
import { changesLabel, formatAgo } from '../../sync/format';
import { useSyncStatus, type SyncStatus } from '../../sync/useSyncStatus';
import { Section } from './Section';

/** Token, status, Sync now, Disconnect, and Reset local data (docs/05 Settings, M2). */
export function SyncSection() {
  const status = useSyncStatus();
  const anchor = useRef<HTMLDivElement>(null);
  const { hash, key } = useLocation();

  const ready = status !== undefined;

  // The status pill and the Now banner link to /settings#sync.
  useEffect(() => {
    if (hash === '#sync' && ready) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, key, ready]);

  return (
    <div
      id="sync"
      ref={anchor}
      className="scroll-mt-[calc(env(safe-area-inset-top)+16px)]"
      data-testid="sync-section"
    >
      <Section title="Sync">
        {!status ? null : status.connection === 'connected' ? (
          <Connected status={status} />
        ) : (
          <NotConnected status={status} />
        )}
      </Section>
    </div>
  );
}

function NotConnected({ status }: { status: SyncStatus }) {
  const rejected = status.connection === 'rejected';
  return (
    <div className="flex flex-col gap-4">
      {rejected ? (
        <div
          className="flex gap-2.5 rounded-2xl bg-warn-bg p-3 text-sm text-warn-fg"
          role="alert"
          data-testid="token-rejected"
        >
          <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            <span className="font-semibold">Token rejected — paste it again.</span> Your server no
            longer accepts the saved token, so syncing has stopped. Nothing on this phone is lost.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">
          Connect to your server to keep a backup and get nudges. Paste the token you set as{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[13px]">AUTH_TOKEN</code>. Until
          then everything stays on this phone.
        </p>
      )}
      <TokenForm rejected={rejected} />
      {status.pending > 0 && (
        <p className="text-sm text-muted">
          {changesLabel(status.pending)} on this phone will upload when you connect.
        </p>
      )}
      {rejected && (
        <Button className="w-full" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      )}
    </div>
  );
}

function TokenForm({ rejected }: { rejected: boolean }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (token.trim() === '') {
      setError('Paste the token first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await connect(token);
      setToken('');
      toast.show({
        message: outcome.status === 'ok' ? 'Connected and synced' : 'Connected. Syncing shortly.',
      });
    } catch (err) {
      setError(tokenErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-muted">
          {rejected ? 'New token' : 'Server token'}
        </span>
        <span className="flex gap-2">
          <input
            type={show ? 'text' : 'password'}
            className={`${inputClass} ${token === '' ? '' : 'font-mono'}`}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
            placeholder="Paste your token"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={error !== null}
            data-testid="token-input"
          />
          <button
            type="button"
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-muted active:opacity-75"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide token' : 'Show token'}
            aria-pressed={show}
          >
            {show ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </Button>
    </form>
  );
}

function outcomeMessage(
  outcome: RoundOutcome,
  success: string,
): { message: string; error: boolean } {
  switch (outcome.status) {
    case 'ok':
      return { message: success, error: false };
    case 'error':
      return { message: outcome.message, error: true };
    case 'rejected':
      return { message: 'Your server rejected the token. Paste it again.', error: true };
    case 'off':
      return { message: 'Not connected to your server.', error: true };
  }
}

function Connected({ status }: { status: SyncStatus }) {
  const toast = useToast();
  const now = useNow(retryTick(status.retryAt), `${status.lastSyncedAt}|${status.retryAt}`);
  const [confirmReset, setConfirmReset] = useState(false);

  async function sync() {
    const { message, error } = outcomeMessage(await syncNow(), 'Synced');
    toast.show({ message, tone: error ? 'error' : 'default' });
  }

  async function disconnectNow() {
    await disconnect();
    toast.show({ message: 'Disconnected. Your data stays on this phone.' });
  }

  const retryIn =
    status.retryAt !== null ? Math.max(1, Math.ceil((status.retryAt - now) / 1000)) : null;

  const rows: Array<[string, string]> = [
    ['Status', status.syncing ? 'Syncing…' : 'Connected'],
    ['Last sync', status.lastSyncedAt ? formatAgo(status.lastSyncedAt, now) : 'Not yet'],
    ['Waiting to upload', status.pending === 0 ? 'Nothing' : changesLabel(status.pending)],
  ];

  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-line" data-testid="sync-status">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-h-11 items-center justify-between gap-4">
            <dt className="text-muted">{k}</dt>
            <dd className="tabular text-right font-medium">
              {k === 'Status' && (
                <span
                  className={`mr-2 inline-block size-2 rounded-full align-middle ${
                    status.error?.kind === 'problem' ? 'bg-danger' : 'bg-[#2f9e6b]'
                  }`}
                  aria-hidden
                />
              )}
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {status.error && (
        <div
          className={`rounded-2xl p-3 text-sm ${
            status.error.kind === 'retry' ? 'bg-surface-2 text-fg' : 'bg-warn-bg text-warn-fg'
          }`}
          role="note"
          data-testid="sync-error"
        >
          <p className="font-semibold">
            {status.error.kind === 'notice' ? 'Some changes did not sync' : 'Last error'}
            <span className="font-normal opacity-80"> · {formatAgo(status.error.at, now)}</span>
          </p>
          <p className="mt-0.5">{status.error.message}</p>
          {status.error.kind !== 'notice' && retryIn !== null && (
            <p className="mt-0.5 opacity-80">Trying again in {formatSeconds(retryIn)}.</p>
          )}
        </div>
      )}
      <Button
        variant="primary"
        className="w-full"
        disabled={status.syncing}
        onClick={() => void sync()}
      >
        <RefreshCw size={20} className={status.syncing ? 'animate-spin' : ''} aria-hidden />
        {status.syncing ? 'Syncing…' : 'Sync now'}
      </Button>
      <Button className="w-full" onClick={() => void disconnectNow()}>
        Disconnect
      </Button>
      <Button
        variant="danger-soft"
        className="w-full text-[15px]"
        onClick={() => setConfirmReset(true)}
      >
        {/* A non-breaking hyphen, so a narrow screen never splits "re-download". */}
        Reset local data and re‑download
      </Button>
      <p className="px-1 text-xs leading-relaxed text-muted">
        Disconnect stops syncing and keeps everything on this phone. Reset replaces this phone’s
        data with your server’s copy.
      </p>
      {confirmReset && (
        <ResetSheet pending={status.pending} onClose={() => setConfirmReset(false)} />
      )}
    </div>
  );
}

/** Tick every second while a retry countdown is shown, else every 15 s for "last sync". */
function retryTick(retryAt: number | null): number {
  return retryAt === null ? 15_000 : 1_000;
}

function formatSeconds(s: number): string {
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function ResetSheet({ pending, onClose }: { pending: number; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    const outcome = await resetLocalData();
    setBusy(false);
    onClose();
    const { message, error } = outcomeMessage(outcome, 'Re-downloaded everything from your server');
    toast.show({
      message: error ? `Nothing was reset. ${message}` : message,
      tone: error ? 'error' : 'default',
    });
  }

  return (
    <Sheet title="Reset local data?" onClose={busy ? () => undefined : onClose}>
      <div className="flex flex-col gap-3 pb-2">
        <p className="text-[15px] leading-relaxed">
          This phone’s categories, entries, rules and settings are replaced with the copy on your
          server.
        </p>
        {pending > 0 ? (
          <p className="rounded-2xl bg-warn-bg p-3 text-sm font-medium text-warn-fg" role="note">
            {changesLabel(pending)} not yet uploaded will be lost.
          </p>
        ) : (
          <p className="text-sm text-muted">Every change on this phone has already uploaded.</p>
        )}
        <Button variant="danger" className="w-full" disabled={busy} onClick={() => void reset()}>
          {busy ? 'Re-downloading…' : 'Reset and re-download'}
        </Button>
        <Button className="w-full" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
