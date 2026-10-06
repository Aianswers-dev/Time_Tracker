import { db } from '../db';

/**
 * Sync state kept in Dexie `meta`, so it survives an app kill and screens can
 * read it with `useLiveQuery`. The token itself is `TOKEN_KEY` in api/client.
 */
export const SYNC_META = {
  /** Server time of the last applied snapshot: the next pull's `since` cursor. */
  lastSync: 'lastSync',
  /** Device time of the last successful sync, for display. */
  lastSyncedAt: 'lastSyncedAt',
  /** '1' after the server answered 401. Sync stays off until a new token is saved. */
  tokenRejected: 'tokenRejected',
  /** JSON `SyncErrorInfo`: the latest failure, cleared by the next clean sync. */
  syncError: 'syncError',
  /** '1' when the next pull must be a full resync (failed op, first connect). */
  needsFullResync: 'needsFullResync',
  /** '1' once the owner dismissed the "connect to your server" banner. */
  bannerDismissed: 'connectBannerDismissed',
} as const;

/**
 * - `retry`: no answer or a 5xx; the engine retries with backoff on its own.
 * - `problem`: needs the owner (token rejected, server refused the request, empty server).
 * - `notice`: some changes were refused and dropped; the full resync already fixed local data.
 */
export type SyncErrorKind = 'retry' | 'problem' | 'notice';

export interface SyncErrorInfo {
  message: string;
  /** Device time, ISO. */
  at: string;
  kind: SyncErrorKind;
}

const KINDS: ReadonlySet<string> = new Set<SyncErrorKind>(['retry', 'problem', 'notice']);

export function parseSyncError(value: string | undefined): SyncErrorInfo | null {
  if (!value) return null;
  try {
    const v: unknown = JSON.parse(value);
    if (typeof v !== 'object' || v === null) return null;
    const { message, at, kind } = v as Record<string, unknown>;
    if (typeof message !== 'string' || typeof at !== 'string' || typeof kind !== 'string') {
      return null;
    }
    if (!KINDS.has(kind)) return null;
    return { message, at, kind: kind as SyncErrorKind };
  } catch {
    return null;
  }
}

export async function getMeta(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deleteMeta(key: string): Promise<void> {
  await db.meta.delete(key);
}

export async function setSyncError(message: string, kind: SyncErrorKind): Promise<void> {
  const info: SyncErrorInfo = { message, at: new Date().toISOString(), kind };
  await setMeta(SYNC_META.syncError, JSON.stringify(info));
}
