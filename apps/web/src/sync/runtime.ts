import { useSyncExternalStore } from 'react';

/**
 * In-memory sync state that does not need to survive a restart: whether a
 * sync is running and when the next backoff retry is due. Persistent state
 * (last sync, errors, token rejected) lives in Dexie `meta` (./meta.ts).
 */
export interface SyncRuntime {
  syncing: boolean;
  /** Epoch ms of the scheduled retry after a failure, or null. */
  retryAt: number | null;
  /**
   * Epoch ms the pending-changes clock starts from: app start or the latest
   * connect. Ops queued before then are not "stuck" until they had a chance.
   */
  watchFrom: number;
}

let state: SyncRuntime = { syncing: false, retryAt: null, watchFrom: Date.now() };
const listeners = new Set<() => void>();

export function getSyncRuntime(): SyncRuntime {
  return state;
}

export function setSyncRuntime(patch: Partial<SyncRuntime>): void {
  const next = { ...state, ...patch };
  if (
    next.syncing === state.syncing &&
    next.retryAt === state.retryAt &&
    next.watchFrom === state.watchFrom
  ) {
    return;
  }
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSyncRuntime(): SyncRuntime {
  return useSyncExternalStore(subscribe, getSyncRuntime, getSyncRuntime);
}

const noticeListeners = new Set<(message: string) => void>();

/** Messages for the owner, such as "Couldn't sync: switch to Relaxing". Shown as toasts. */
export function onSyncNotice(listener: (message: string) => void): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

export function emitSyncNotice(message: string): void {
  for (const l of noticeListeners) l(message);
}
