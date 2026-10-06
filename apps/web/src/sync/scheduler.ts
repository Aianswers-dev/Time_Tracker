import { onEnqueue } from '../data/outbox';
import { resetRound, syncRound, type RoundOutcome } from './engine';
import { getSyncRuntime, setSyncRuntime } from './runtime';

/**
 * When sync runs. Rounds are single-flight: a trigger during a round makes
 * that round go again once it finishes instead of starting a second one, and
 * a reset waits for the running round. A failed round backs off 2 s, 4 s,
 * 8 s ... up to 60 s; a 401 stops sync until a new token is saved.
 */

export type SyncTrigger =
  'start' | 'visible' | 'online' | 'interval' | 'outbox' | 'retry' | 'manual' | 'connect';

export const INTERVAL_MS = 30_000;
export const OUTBOX_DEBOUNCE_MS = 1_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;

/** 2 s after the first failure, doubling, capped at 60 s. */
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/** What the scheduler needs from the browser, injectable for tests. */
export interface SyncEnv {
  /** Fires `online` (window). */
  events: EventTarget;
  /** Fires `visibilitychange` (document). */
  visibility: EventTarget;
  isVisible: () => boolean;
  isOnline: () => boolean;
}

function browserEnv(): SyncEnv {
  return {
    events: window,
    visibility: document,
    isVisible: () => document.visibilityState === 'visible',
    isOnline: () => navigator.onLine,
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Run tasks strictly one after another. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.catch(() => undefined);
  return run;
}

/** Resolves once no sync or reset is running or queued. For tests. */
export async function whenSyncIdle(): Promise<void> {
  for (;;) {
    const current = chain;
    await current;
    if (current === chain) return;
  }
}

let active: Promise<RoundOutcome> | null = null;
let rerun = false;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let env: SyncEnv | null = null;
let stopTriggers: (() => void) | null = null;

/** Forget earlier failures: the next trigger syncs at once. */
export function resetBackoff(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  failures = 0;
  setSyncRuntime({ retryAt: null });
}

function settle(outcome: RoundOutcome): void {
  if (outcome.status !== 'error') {
    resetBackoff();
    return;
  }
  clearTimeout(retryTimer);
  failures += 1;
  const delay = backoffDelay(failures);
  setSyncRuntime({ retryAt: Date.now() + delay });
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    trigger('retry');
  }, delay);
}

async function runRound(round: () => Promise<RoundOutcome>): Promise<RoundOutcome> {
  setSyncRuntime({ syncing: true });
  try {
    const outcome = await round();
    settle(outcome);
    return outcome;
  } finally {
    setSyncRuntime({ syncing: false });
  }
}

/**
 * Sync now, or join the round already running (which then goes again). Rounds
 * repeat while they succeed and something asked for another.
 */
export function requestSync(): Promise<RoundOutcome> {
  if (active) {
    rerun = true;
    return active;
  }
  const run = exclusive(async () => {
    try {
      for (;;) {
        rerun = false;
        const outcome = await runRound(syncRound);
        if (outcome.status !== 'ok' || !(rerun || outcome.again)) return outcome;
      }
    } finally {
      active = null;
    }
  });
  active = run;
  return run;
}

/** Discard the outbox and re-download everything, after any running round. */
export function requestReset(): Promise<RoundOutcome> {
  return exclusive(() => runRound(resetRound));
}

/**
 * Ask for a sync. Interval and outbox triggers wait out a running backoff;
 * the others (app start, focus, back online, Sync now) go at once. Nothing
 * runs while the browser says it is offline, except an explicit request.
 */
export function trigger(reason: SyncTrigger): void {
  const explicit = reason === 'manual' || reason === 'connect';
  if (!explicit && env && !env.isOnline()) return;
  const { retryAt } = getSyncRuntime();
  if ((reason === 'interval' || reason === 'outbox') && retryAt !== null && Date.now() < retryAt) {
    return;
  }
  requestSync().catch((err: unknown) => console.error('Sync failed', err));
}

/**
 * Wire the triggers: app start (now), page visible again, back online, every
 * 30 s while visible, and about 1 s after the last outbox write.
 */
export function startSync(e: SyncEnv = browserEnv()): () => void {
  stopSync();
  env = e;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onVisibility = () => {
    if (e.isVisible()) trigger('visible');
  };
  const onOnline = () => trigger('online');
  e.visibility.addEventListener('visibilitychange', onVisibility);
  e.events.addEventListener('online', onOnline);
  const interval = setInterval(() => {
    if (e.isVisible()) trigger('interval');
  }, INTERVAL_MS);
  const offEnqueue = onEnqueue(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => trigger('outbox'), OUTBOX_DEBOUNCE_MS);
  });
  stopTriggers = () => {
    e.visibility.removeEventListener('visibilitychange', onVisibility);
    e.events.removeEventListener('online', onOnline);
    clearInterval(interval);
    clearTimeout(debounce);
    offEnqueue();
  };
  setSyncRuntime({ watchFrom: Date.now() });
  trigger('start');
  return stopSync;
}

export function stopSync(): void {
  stopTriggers?.();
  stopTriggers = null;
  env = null;
  resetBackoff();
}
