import {
  MAX_OPS_PER_REQUEST,
  MAX_ROWS_PER_OP,
  MAX_SEGMENT_ROWS_PER_REQUEST,
  opsResponseSchema,
  snapshotResponseSchema,
  SETTINGS_ID,
  type Op,
  type OpsResponse,
  type SnapshotResponse,
} from '@time-tracker/shared';
import { ApiError, apiFetch, getToken } from '../api/client';
import {
  categoryUpsertOp,
  enqueue,
  ruleUpsertOp,
  segmentsUpsertOp,
  settingsUpsertOp,
} from '../data/outbox';
import { db, type OutboxRow } from '../db';
import { describeOp, failureSummary } from './describe';
import { deleteMeta, getMeta, setMeta, setSyncError, SYNC_META } from './meta';
import { emitSyncNotice } from './runtime';
import { categoryTouched, ruleTouched, segmentTouched, touchedBy, type Touched } from './touched';

/**
 * One sync round (docs/02 "Sync details"): flush the outbox to
 * `POST /api/ops`, then, only once it is empty, pull `GET /api/snapshot`.
 * The scheduler (./scheduler.ts) runs rounds one at a time and owns retries.
 */

/** Ops per `POST /api/ops`. The server applies about 15 and answers only those. */
export const FLUSH_BATCH = Math.min(50, MAX_OPS_PER_REQUEST);

const OPS_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 30_000;
const FULL_TIMEOUT_MS = 120_000;

/** The full resync found a server that lost its data (no categories, or not the ones in use). */
export const EMPTY_SERVER_MESSAGE =
  'Your server is missing data this phone has, so this phone kept its data instead of replacing it.';

export type RoundOutcome =
  /** No token: sync is off. */
  | { status: 'off' }
  /** The server answered 401. Sync stays off until a new token is saved. */
  | { status: 'rejected' }
  /** `again`: ops were queued while pulling, so another round should follow at once. */
  | { status: 'ok'; again: boolean }
  | { status: 'error'; kind: 'retry' | 'problem'; message: string };

/** A failure of the round itself, as opposed to one op. */
export class SyncFailure extends Error {
  readonly kind: 'retry' | 'problem';
  constructor(kind: 'retry' | 'problem', message: string) {
    super(message);
    this.name = 'SyncFailure';
    this.kind = kind;
  }
}

/** Abort a request that hangs, so a round never blocks the next one forever. */
export function requestTimeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

const SYNCED = [db.categories, db.segments, db.rules, db.settings, db.outbox, db.meta];

async function pendingOps(): Promise<Op[]> {
  return (await db.outbox.orderBy('seq').toArray()).map((r) => r.op);
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return err.message;
    if (err.status >= 500) return `Your server had an error (HTTP ${err.status})`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Sync failed';
}

/** Record a failed request on the ops it carried. They stay queued. */
async function noteAttempt(batch: readonly OutboxRow[], err: unknown): Promise<void> {
  const seqs = batch.flatMap((r) => (r.seq === undefined ? [] : [r.seq]));
  const lastError = errorText(err);
  await db.outbox
    .where('seq')
    .anyOf(seqs)
    .modify((row) => {
      row.attempts += 1;
      row.lastError = lastError;
    });
}

/** Remove answered ops. A refused op is dropped too, and the next pull becomes a full resync. */
async function settleOps(seqs: readonly number[], anyFailed: boolean): Promise<void> {
  await db.transaction('rw', db.outbox, db.meta, async () => {
    await db.outbox.bulkDelete([...seqs]);
    if (anyFailed) await setMeta(SYNC_META.needsFullResync, '1');
  });
}

/**
 * Send the outbox in `seq` order until it is empty. Ops the server did not
 * answer (it applies a prefix of each request) are sent again at once. A
 * failed request leaves every op queued and throws.
 */
/**
 * The leading ops of `rows` whose segment rows fit in what the server applies
 * per request (MAX_SEGMENT_ROWS_PER_REQUEST), and always the first op. Sending
 * more would upload rows the server can only leave unanswered.
 */
export function capBySegmentRows(rows: readonly OutboxRow[]): OutboxRow[] {
  const out: OutboxRow[] = [];
  let total = 0;
  for (const row of rows) {
    const n = row.op.type === 'segments.upsert' ? row.op.payload.rows.length : 0;
    if (out.length > 0 && total + n > MAX_SEGMENT_ROWS_PER_REQUEST) break;
    out.push(row);
    total += n;
  }
  return out;
}

async function flush(failed: string[]): Promise<void> {
  let size = FLUSH_BATCH;
  for (;;) {
    const batch = capBySegmentRows(await db.outbox.orderBy('seq').limit(size).toArray());
    const first = batch[0];
    if (first === undefined) return;

    let res: OpsResponse;
    try {
      res = await apiFetch('/api/ops', {
        body: { ops: batch.map((r) => r.op) },
        schema: opsResponseSchema,
        signal: requestTimeout(OPS_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) {
        // Over the 1 MB body limit: send fewer at a time. A single op that
        // large can never be sent, so it is dropped like a refused op.
        if (batch.length > 1) {
          size = Math.ceil(batch.length / 2);
          continue;
        }
        failed.push(await describeOp(first.op));
        if (first.seq !== undefined) await settleOps([first.seq], true);
        continue;
      }
      await noteAttempt(batch, err);
      throw err;
    }

    const byOpId = new Map(batch.map((r) => [r.opId, r]));
    const done: number[] = [];
    let anyFailed = false;
    for (const result of res.results) {
      const row = byOpId.get(result.opId);
      if (!row || row.seq === undefined) continue;
      byOpId.delete(result.opId);
      done.push(row.seq);
      if (!result.ok) {
        anyFailed = true;
        failed.push(await describeOp(row.op));
        console.warn('Sync: the server refused an op', row.op.type, result.error);
      }
    }
    if (done.length === 0) {
      const err = new SyncFailure('retry', 'The server did not apply any changes');
      await noteAttempt(batch, err);
      throw err;
    }
    await settleOps(done, anyFailed);
  }
}

function snapshotPath(since: string | undefined): string {
  return since === undefined ? '/api/snapshot' : `/api/snapshot?since=${encodeURIComponent(since)}`;
}

/**
 * Incremental pull. The server's copy wins, soft-deleted rows included,
 * except rows touched by ops queued while the request was in flight: those
 * keep their local copy, and `lastSync` stays put so the next pull reads them
 * again. Returns true when such ops exist (another round should follow).
 */
/** Most snapshot pages one download follows, a guard against a server that never stops. */
const MAX_SNAPSHOT_PAGES = 1000;

/**
 * Every row written after `since` (everything when undefined), following the
 * server's pages. Categories, rules, settings and `serverTime` come from the
 * first page; segments from all of them. Nothing is applied until the last
 * page arrives, so a failure part way leaves local data untouched.
 */
async function fetchSnapshot(
  since: string | undefined,
  timeoutMs: number,
): Promise<SnapshotResponse> {
  const first = await apiFetch(snapshotPath(since), {
    schema: snapshotResponseSchema,
    signal: requestTimeout(timeoutMs),
  });
  const segments = [...first.segments];
  let cursor = first.nextCursor ?? null;
  for (let page = 1; cursor !== null; page++) {
    if (page >= MAX_SNAPSHOT_PAGES) {
      throw new SyncFailure('retry', 'The server sent more pages than expected');
    }
    const params = new URLSearchParams({ cursor });
    if (since !== undefined) params.set('since', since);
    const next = await apiFetch(`/api/snapshot?${params.toString()}`, {
      schema: snapshotResponseSchema,
      signal: requestTimeout(timeoutMs),
    });
    segments.push(...next.segments);
    cursor = next.nextCursor ?? null;
  }
  return { ...first, segments, nextCursor: null };
}

async function pull(): Promise<boolean> {
  const since = await getMeta(SYNC_META.lastSync);
  const snap = await fetchSnapshot(since, since === undefined ? FULL_TIMEOUT_MS : PULL_TIMEOUT_MS);
  return db.transaction('rw', SYNCED, async () => {
    const pending = await pendingOps();
    const t = touchedBy(pending);
    const local = await db.segments.bulkGet(snap.segments.map((s) => s.id));
    const segments = snap.segments.filter((s, i) => {
      const mine = local[i];
      return !segmentTouched(t, s) && !(mine && segmentTouched(t, mine));
    });
    const categories = snap.categories.filter((c) => !categoryTouched(t, c));
    const rules = snap.rules.filter((r) => !ruleTouched(t, r));
    const settings = snap.settings && !t.settings ? snap.settings : null;
    const skipped =
      segments.length !== snap.segments.length ||
      categories.length !== snap.categories.length ||
      rules.length !== snap.rules.length ||
      settings !== snap.settings;

    await db.categories.bulkPut(categories);
    await db.segments.bulkPut(segments);
    await db.rules.bulkPut(rules);
    if (settings) await db.settings.put(settings);
    if (!skipped) await setMeta(SYNC_META.lastSync, snap.serverTime);
    return pending.length > 0;
  });
}

/**
 * Whether the full snapshot lacks a category this phone has live entries in.
 * Deletes are soft, so a healthy server knows every category the phone ever
 * sent, deleted or not. One it has never seen means the server lost its data
 * and got some of it back from later ops (a rename, a switch): replacing
 * would delete the history in that category, as with an empty server. Rows
 * touched by ops still waiting in the outbox do not count.
 */
async function serverLostEntries(snap: SnapshotResponse, t: Touched): Promise<boolean> {
  const known = new Set(snap.categories.map((c) => c.id));
  const unknown = await db.categories
    .filter((c) => c.deletedAt === null && !known.has(c.id) && !categoryTouched(t, c))
    .toArray();
  for (const c of unknown) {
    const used = await db.segments
      .where('categoryId')
      .equals(c.id)
      .filter((s) => s.deletedAt === null && !segmentTouched(t, s))
      .first();
    if (used) return true;
  }
  return false;
}

/**
 * Replace the local synced tables with the server's full snapshot, in one
 * transaction. Refuses (and changes nothing) when the server has no
 * categories but this phone has some, or lacks a category this phone has
 * entries in (`serverLostEntries`): wiping would lose everything the server
 * never received. `discardThroughSeq` drops queued ops up to that seq
 * (Reset). Ops queued after that keep their rows, as in `pull`.
 */
async function fullResync(discardThroughSeq?: number): Promise<boolean> {
  const snap: SnapshotResponse = await fetchSnapshot(undefined, FULL_TIMEOUT_MS);
  return db.transaction('rw', SYNCED, async () => {
    const serverHasCategories = snap.categories.some((c) => c.deletedAt === null);
    if (!serverHasCategories) {
      const localCategories = await db.categories.filter((c) => c.deletedAt === null).count();
      if (localCategories > 0) throw new SyncFailure('problem', EMPTY_SERVER_MESSAGE);
    }
    if (discardThroughSeq !== undefined) {
      await db.outbox.where('seq').belowOrEqual(discardThroughSeq).delete();
    }

    const pending = await pendingOps();
    const t = touchedBy(pending);
    if (await serverLostEntries(snap, t)) throw new SyncFailure('problem', EMPTY_SERVER_MESSAGE);
    // A segment a pending switch closed is kept only if the server has it. One
    // the server never had came from a refused op (the reason for this
    // resync); no pending op will send it, so keeping it would leave it on
    // this phone for good, overlapping the server's rows.
    const onServer = new Set(snap.segments.map((s) => s.id));
    const keep =
      pending.length === 0
        ? { segments: [], categories: [], rules: [] }
        : {
            segments: (await db.segments.toArray()).filter(
              (s) => t.segments.has(s.id) || (segmentTouched(t, s) && onServer.has(s.id)),
            ),
            categories: (await db.categories.toArray()).filter((c) => categoryTouched(t, c)),
            rules: (await db.rules.toArray()).filter((r) => ruleTouched(t, r)),
          };
    const keptSegments = new Set(keep.segments.map((s) => s.id));
    const segments = snap.segments.filter((s) => !keptSegments.has(s.id) && !segmentTouched(t, s));
    const categories = snap.categories.filter((c) => !categoryTouched(t, c));
    const rules = snap.rules.filter((r) => !ruleTouched(t, r));
    const localSettings = await db.settings.get(SETTINGS_ID);
    // The server has no settings row only before its first settings op; keep ours then.
    const settings = t.settings || snap.settings === null ? localSettings : snap.settings;
    const skipped =
      segments.length !== snap.segments.length ||
      categories.length !== snap.categories.length ||
      rules.length !== snap.rules.length ||
      (t.settings && snap.settings !== null);

    await Promise.all([
      db.categories.clear(),
      db.segments.clear(),
      db.rules.clear(),
      db.settings.clear(),
    ]);
    await db.categories.bulkPut([...categories, ...keep.categories]);
    await db.segments.bulkPut([...segments, ...keep.segments]);
    await db.rules.bulkPut([...rules, ...keep.rules]);
    if (settings) await db.settings.put(settings);

    // After skipping rows, pull everything again next time rather than from now.
    if (skipped) await deleteMeta(SYNC_META.lastSync);
    else await setMeta(SYNC_META.lastSync, snap.serverTime);
    await deleteMeta(SYNC_META.needsFullResync);
    return pending.length > 0;
  });
}

async function finishRound(failed: readonly string[]): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    await setMeta(SYNC_META.lastSyncedAt, new Date().toISOString());
    await deleteMeta(SYNC_META.serverEmpty);
    const summary = failureSummary(failed);
    if (summary) await setSyncError(summary, 'notice');
    else await deleteMeta(SYNC_META.syncError);
  });
}

async function failRound(err: unknown): Promise<RoundOutcome> {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      await setMeta(SYNC_META.tokenRejected, '1');
      return { status: 'rejected' };
    }
    if (err.code === 'not_connected') return { status: 'off' };
    const kind = err.retryable ? 'retry' : 'problem';
    const message = errorText(err);
    await setSyncError(message, kind);
    return { status: 'error', kind, message };
  }
  if (err instanceof SyncFailure) {
    if (err.message === EMPTY_SERVER_MESSAGE) await setMeta(SYNC_META.serverEmpty, '1');
    await setSyncError(err.message, err.kind);
    return { status: 'error', kind: err.kind, message: err.message };
  }
  console.error('Sync failed', err);
  const message = errorText(err);
  await setSyncError(message, 'problem');
  return { status: 'error', kind: 'problem', message };
}

async function canSync(): Promise<RoundOutcome | null> {
  if ((await getToken()) === null) return { status: 'off' };
  if ((await getMeta(SYNC_META.tokenRejected)) !== undefined) return { status: 'rejected' };
  return null;
}

/** Flush, then pull (or fully resync when flagged). Never throws for sync failures. */
export async function syncRound(): Promise<RoundOutcome> {
  const blocked = await canSync();
  if (blocked) return blocked;
  const failed: string[] = [];
  try {
    await flush(failed);
    const full = (await getMeta(SYNC_META.needsFullResync)) !== undefined;
    const again = full ? await fullResync() : await pull();
    await finishRound(failed);
    return { status: 'ok', again };
  } catch (err) {
    return await failRound(err);
  } finally {
    const summary = failureSummary(failed);
    if (summary) emitSyncNotice(summary);
  }
}

/**
 * "Reset local data and re-download": discard the outbox and replace local
 * data with the server's full snapshot. When the server is empty nothing
 * changes, the outbox included.
 */
export async function resetRound(): Promise<RoundOutcome> {
  const blocked = await canSync();
  if (blocked) return blocked;
  try {
    const last = await db.outbox.orderBy('seq').last();
    const again = await fullResync(last?.seq ?? 0);
    await finishRound([]);
    return { status: 'ok', again };
  } catch (err) {
    return await failRound(err);
  }
}

/**
 * Queue this phone's whole history for a server that lost its data (the
 * empty-server guard tripped). Settings and categories go first so rules and
 * segments can reference them; segments go oldest first, at most
 * MAX_ROWS_PER_OP rows per op, so the server's invariant check sees a valid
 * timeline. Rows keep their own `updatedAt`, so on a server that does have
 * data last-write-wins keeps whichever copy is newer. Local data does not
 * change. Returns the number of ops queued; the next round sends them and
 * then fully resyncs.
 */
export async function queueFullUpload(): Promise<number> {
  const now = new Date().toISOString();
  return db.transaction('rw', SYNCED, async () => {
    const ops: Op[] = [];
    const settings = await db.settings.get(SETTINGS_ID);
    if (settings) ops.push(settingsUpsertOp(settings, now));
    const categories = (await db.categories.toArray()).filter((c) => c.deletedAt === null);
    const categoryIds = new Set(categories.map((c) => c.id));
    for (const c of categories) ops.push(categoryUpsertOp(c, now));
    for (const r of await db.rules.toArray()) {
      if (r.deletedAt === null && categoryIds.has(r.categoryId)) ops.push(ruleUpsertOp(r, now));
    }
    const segments = (await db.segments.orderBy('startedAt').toArray()).filter(
      (s) => s.deletedAt === null && categoryIds.has(s.categoryId),
    );
    for (let i = 0; i < segments.length; i += MAX_ROWS_PER_OP) {
      ops.push(segmentsUpsertOp(segments.slice(i, i + MAX_ROWS_PER_OP), now));
    }
    await enqueue(...ops);
    await deleteMeta(SYNC_META.serverEmpty);
    await deleteMeta(SYNC_META.syncError);
    await setMeta(SYNC_META.needsFullResync, '1');
    return ops.length;
  });
}
