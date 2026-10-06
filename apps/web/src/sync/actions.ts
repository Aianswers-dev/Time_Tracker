import { settingsSchema } from '@time-tracker/shared';
import { ApiError, apiFetch, clearToken, setToken } from '../api/client';
import { db } from '../db';
import { queueFullUpload, requestTimeout, type RoundOutcome } from './engine';
import { deleteMeta, setMeta, SYNC_META } from './meta';
import { setSyncRuntime } from './runtime';
import { requestReset, requestSync, resetBackoff } from './scheduler';

/** What the Settings sync section calls. */

/** Why a token could not be used, in words for the token field. */
export function tokenErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your server rejected that token. Check it and paste it again.';
    if (err.code === 'network')
      return 'Can’t reach your server. Check your connection and try again.';
    if (err.status >= 500) return `Your server had an error (HTTP ${err.status}). Try again.`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * Test the token against the server, save it, and start a full sync: the
 * outbox (seed included) goes up first, then the server's copy replaces the
 * local tables. Throws `ApiError` when the server refuses the token, before
 * anything is saved. Resolves with the outcome of that first sync.
 */
export async function connect(token: string): Promise<RoundOutcome> {
  const trimmed = token.trim();
  if (trimmed === '') throw new Error('Paste the token first.');
  await apiFetch('/api/settings', {
    token: trimmed,
    schema: settingsSchema,
    signal: requestTimeout(20_000),
  });
  await db.transaction('rw', db.meta, async () => {
    await setToken(trimmed);
    await deleteMeta(SYNC_META.tokenRejected);
    await deleteMeta(SYNC_META.syncError);
    await setMeta(SYNC_META.needsFullResync, '1');
  });
  resetBackoff();
  setSyncRuntime({ watchFrom: Date.now() });
  return requestSync();
}

/** Forget the token. Local data and the outbox stay; sync resumes on the next connect. */
export async function disconnect(): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    await clearToken();
    await deleteMeta(SYNC_META.tokenRejected);
    await deleteMeta(SYNC_META.syncError);
  });
  resetBackoff();
}

export function syncNow(): Promise<RoundOutcome> {
  resetBackoff();
  return requestSync();
}

export function resetLocalData(): Promise<RoundOutcome> {
  resetBackoff();
  return requestReset();
}

export async function dismissConnectBanner(): Promise<void> {
  await setMeta(SYNC_META.bannerDismissed, '1');
}

/**
 * For a server that lost its data: queue everything on this phone, then sync.
 * Resolves with the number of changes queued and the outcome of the sync.
 */
export async function uploadThisPhone(): Promise<{ queued: number; outcome: RoundOutcome }> {
  const queued = await queueFullUpload();
  resetBackoff();
  return { queued, outcome: await requestSync() };
}
