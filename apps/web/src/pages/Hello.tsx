import { dayKeyOf, healthResponseSchema } from '@time-tracker/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../db';

type ApiStatus =
  { kind: 'checking' } | { kind: 'ok'; serverTime: string } | { kind: 'unreachable' };

async function fetchHealth(signal: AbortSignal): Promise<ApiStatus> {
  try {
    const res = await fetch('/api/health', { signal });
    if (!res.ok) return { kind: 'unreachable' };
    const body = healthResponseSchema.safeParse(await res.json());
    return body.success ? { kind: 'ok', serverTime: body.data.time } : { kind: 'unreachable' };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** Write the first-open time once. The transaction keeps StrictMode's double effect safe. */
async function ensureInstalledAt(): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const existing = await db.meta.get('installedAt');
    if (!existing) await db.meta.add({ key: 'installedAt', value: new Date().toISOString() });
  });
}

export function Hello() {
  const [now] = useState(() => new Date());
  const [status, setStatus] = useState<ApiStatus>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  const day = dayKeyOf(now, {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayStartHour: 4,
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then((next) => {
      if (!controller.signal.aborted) setStatus(next);
    });
    return () => {
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    void ensureInstalledAt();
  }, []);

  const installedAt = useLiveQuery(() => db.meta.get('installedAt'), []);

  function checkAgain() {
    setStatus({ kind: 'checking' });
    setAttempt((n) => n + 1);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">Time Tracker</h1>

      <dl className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
        <div>
          <dt className="text-sm text-muted">Logical day</dt>
          <dd className="text-lg font-medium">{day}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">API status</dt>
          <dd className="text-lg font-medium" role="status">
            {status.kind === 'checking' && 'Checking…'}
            {status.kind === 'ok' && `API ok · ${new Date(status.serverTime).toLocaleString()}`}
            {status.kind === 'unreachable' && 'API unreachable'}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">First opened</dt>
          <dd className="text-lg font-medium">
            {installedAt ? new Date(installedAt.value).toLocaleString() : '…'}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={checkAgain}
        disabled={status.kind === 'checking'}
        className="min-h-14 rounded-xl bg-accent px-6 text-base font-medium text-accent-fg active:opacity-80 disabled:opacity-60"
      >
        Check again
      </button>
    </main>
  );
}
