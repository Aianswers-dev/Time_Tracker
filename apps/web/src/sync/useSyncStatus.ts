import { useLiveQuery } from 'dexie-react-hooks';
import { TOKEN_KEY } from '../api/client';
import { db } from '../db';
import { parseSyncError, SYNC_META, type SyncErrorInfo } from './meta';
import { useSyncRuntime, type SyncRuntime } from './runtime';

export type Connection = 'off' | 'connected' | 'rejected';

export interface SyncStatus extends SyncRuntime {
  /** `off`: no token stored. `rejected`: the server answered 401 to the stored one. */
  connection: Connection;
  /** Device time of the last successful sync, ISO. */
  lastSyncedAt: string | null;
  /** Ops waiting in the outbox. */
  pending: number;
  /** When the oldest waiting op was queued, ISO. */
  oldestPendingAt: string | null;
  error: SyncErrorInfo | null;
  bannerDismissed: boolean;
}

/** Everything the UI shows about sync. Undefined until the first read resolves. */
export function useSyncStatus(): SyncStatus | undefined {
  const stored = useLiveQuery(async () => {
    const [token, rejected, lastSyncedAt, error, dismissed] = await db.meta.bulkGet([
      TOKEN_KEY,
      SYNC_META.tokenRejected,
      SYNC_META.lastSyncedAt,
      SYNC_META.syncError,
      SYNC_META.bannerDismissed,
    ]);
    const pending = await db.outbox.count();
    const oldest = pending > 0 ? await db.outbox.orderBy('seq').first() : undefined;
    const connection: Connection =
      !token || token.value.trim() === '' ? 'off' : rejected ? 'rejected' : 'connected';
    return {
      connection,
      lastSyncedAt: lastSyncedAt?.value ?? null,
      pending,
      oldestPendingAt: oldest?.op.createdAt ?? null,
      error: parseSyncError(error?.value),
      bannerDismissed: dismissed !== undefined,
    };
  }, []);
  const runtime = useSyncRuntime();
  return stored && { ...stored, ...runtime };
}
