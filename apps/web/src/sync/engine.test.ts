import {
  checkInvariants,
  defaultSettings,
  SEED_CATEGORIES,
  SEED_RULES,
  SETTINGS_ID,
  switchCategory,
  toIso,
  uuidv7,
  type Category,
} from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, setToken } from '../api/client';
import { updateCategory } from '../data/categoryActions';
import { ensureSeeded } from '../data/seed';
import { switchTo, undoAction } from '../data/segmentActions';
import { updateSettings } from '../data/settingsActions';
import { CAT, liveSegments, resetDb, seg } from '../data/testUtils';
import { db } from '../db';
import { connect, disconnect, uploadThisPhone } from './actions';
import { EMPTY_SERVER_MESSAGE, FLUSH_BATCH, queueFullUpload, syncRound } from './engine';
import { getMeta, parseSyncError, setMeta, SYNC_META } from './meta';
import { getSyncRuntime, onSyncNotice } from './runtime';
import { backoffDelay, requestReset, requestSync, stopSync } from './scheduler';
import { fakeServer, json, type FakeServer } from './testServer';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const SEED_OPS = SEED_CATEGORIES.length + SEED_RULES.length + 1;

function tick(ms = 60_000) {
  vi.setSystemTime(Date.now() + ms);
}

async function connected(): Promise<FakeServer> {
  const server = fakeServer();
  await setToken(server.token);
  return server;
}

async function syncError() {
  return parseSyncError(await getMeta(SYNC_META.syncError));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await resetDb();
  await ensureSeeded('UTC');
});

afterEach(() => {
  stopSync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('flush', () => {
  it('sends ops in seq order, 50 per request, and resends the ones the server did not answer', async () => {
    const server = await connected();
    for (let i = 0; i < 60; i++) {
      tick();
      await switchTo(i % 2 === 0 ? CAT.relaxing : CAT.housework);
    }
    const queued = (await db.outbox.orderBy('seq').toArray()).map((r) => r.opId);
    expect(queued).toHaveLength(SEED_OPS + 60);

    expect(await requestSync()).toEqual({ status: 'ok', again: false });

    const bodies = server.opsBodies();
    expect(bodies[0]).toHaveLength(FLUSH_BATCH);
    for (const ops of bodies) expect(ops.length).toBeLessThanOrEqual(FLUSH_BATCH);
    // The server answers the first 15 of each request; the next request starts right after.
    const answered = bodies.flatMap((ops) => ops.slice(0, 15).map((op) => op.opId));
    expect(answered).toEqual(queued);
    expect(bodies).toHaveLength(Math.ceil(queued.length / 15));
    expect(await db.outbox.count()).toBe(0);
    // Only then the pull, once.
    expect(server.calls.at(-1)?.path).toMatch(/^\/api\/snapshot/);
    expect(server.snapshotCalls()).toHaveLength(1);
    // The server replayed the same history.
    const open = [...server.segments.values()].filter((s) => s.row.endedAt === null);
    expect(open.map((s) => s.row.categoryId)).toEqual([CAT.housework]);
  });

  it('drops a refused op, names it in a toast and does a full resync', async () => {
    const server = await connected();
    await requestSync();
    tick();
    await switchTo(CAT.relaxing);
    server.failOp = (op) =>
      op.type === 'switch' ? { code: 'conflict', message: 'Already on Relaxing' } : undefined;
    const notices: string[] = [];
    const off = onSyncNotice((m) => notices.push(m));

    const outcome = await requestSync();
    off();

    expect(outcome.status).toBe('ok');
    expect(notices).toEqual(["Couldn't sync: switch to Relaxing"]);
    expect(await db.outbox.count()).toBe(0);
    expect(server.snapshotCalls().at(-1)?.path).toBe('/api/snapshot');
    // The server never had the switch, so the full resync removed it locally.
    expect(await liveSegments()).toEqual([]);
    expect(await db.categories.count()).toBe(10);
    expect(await getMeta(SYNC_META.needsFullResync)).toBeUndefined();
    expect((await syncError())?.kind).toBe('notice');
  });

  it('summarises several refused ops in one toast', async () => {
    const server = await connected();
    server.failOp = (op) =>
      op.type === 'rule.upsert' ? { code: 'validation_failed', message: 'nope' } : undefined;
    const notices: string[] = [];
    const off = onSyncNotice((m) => notices.push(m));
    await requestSync();
    off();
    expect(notices).toEqual(["Couldn't sync: a nudge rule change and 1 more change"]);
  });

  it('keeps every op on a 5xx or network error, records the attempt and backs off', async () => {
    const server = await connected();
    server.intercept = () => json(503, { error: { code: 'internal', message: 'down' } });

    expect(await requestSync()).toEqual({
      status: 'error',
      kind: 'retry',
      message: 'Your server had an error (HTTP 503)',
    });
    let rows = await db.outbox.toArray();
    expect(rows).toHaveLength(SEED_OPS);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows[0]?.lastError).toBe('Your server had an error (HTTP 503)');
    expect(getSyncRuntime().retryAt).toBe(Date.now() + 2_000);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await requestSync()).toMatchObject({ kind: 'retry', message: "Can't reach the server" });
    rows = await db.outbox.toArray();
    expect(rows).toHaveLength(SEED_OPS);
    expect(rows.every((r) => r.attempts === 2)).toBe(true);
    expect(getSyncRuntime().retryAt).toBe(Date.now() + 4_000);
    expect((await syncError())?.kind).toBe('retry');
    expect(server.snapshotCalls()).toHaveLength(0);
  });

  it('backs off 2 s, 4 s, 8 s ... capped at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('stops on 401, keeps the outbox and marks the token rejected', async () => {
    const server = await connected();
    server.token = 'rotated';
    expect(await requestSync()).toEqual({ status: 'rejected' });
    expect(await db.outbox.count()).toBe(SEED_OPS);
    expect(await getMeta(SYNC_META.tokenRejected)).toBe('1');
    expect(getSyncRuntime().retryAt).toBeNull();

    const calls = server.calls.length;
    expect(await requestSync()).toEqual({ status: 'rejected' });
    expect(server.calls).toHaveLength(calls);
  });

  it('treats a request that applies nothing as a failure to retry', async () => {
    const server = await connected();
    server.maxApplied = 0;
    expect(await requestSync()).toMatchObject({ status: 'error', kind: 'retry' });
    expect(await db.outbox.count()).toBe(SEED_OPS);
    expect(server.opsBodies()).toHaveLength(1);
  });

  it('halves the batch when the body is too large', async () => {
    const server = await connected();
    server.intercept = (call) =>
      call.path === '/api/ops' && (call.body as { ops: unknown[] }).ops.length > 4
        ? json(413, { error: { code: 'validation_failed', message: 'too big' } })
        : undefined;
    expect((await requestSync()).status).toBe('ok');
    expect(await db.outbox.count()).toBe(0);
    expect(server.categories.size).toBe(10);
  });

  it('does nothing without a token', async () => {
    const server = fakeServer();
    expect(await requestSync()).toEqual({ status: 'off' });
    expect(server.calls).toHaveLength(0);
  });
});

describe('pull', () => {
  it('overwrites local rows with the server copy, soft deletes included, and moves the cursor', async () => {
    const server = await connected();
    tick();
    await switchTo(CAT.relaxing);
    await requestSync();
    const cursor = await getMeta(SYNC_META.lastSync);
    expect(cursor).toBe(toIso(Date.now()));

    // A local rename, synced, then an older copy on the server: the server copy still wins.
    tick();
    await updateCategory(CAT.hobbies, { name: 'Fun' });
    await requestSync();
    const relaxing = SEED_CATEGORIES.find((c) => c.id === CAT.relaxing) as Category;
    const open = (await liveSegments())[0];
    if (!open) throw new Error('no open segment');
    tick();
    server.put({
      categories: [{ ...relaxing, name: 'Chilling' }],
      segments: [{ ...open, deletedAt: toIso(Date.now()), updatedAt: toIso(Date.now()) }],
    });
    const before = server.snapshotCalls().length;

    expect(await requestSync()).toEqual({ status: 'ok', again: false });

    const since = new URL(server.snapshotCalls()[before]?.path ?? '', 'http://x').searchParams;
    expect(since.get('since')).toBeTruthy();
    expect((await db.categories.get(CAT.relaxing))?.name).toBe('Chilling');
    expect((await db.categories.get(CAT.hobbies))?.name).toBe('Fun');
    expect((await db.segments.get(open.id))?.deletedAt).not.toBeNull();
    expect(await liveSegments()).toEqual([]);
    expect(await getMeta(SYNC_META.lastSync)).toBe(toIso(Date.now()));
  });

  it('skips rows touched by ops queued while it was in flight, then pulls them again', async () => {
    const server = await connected();
    tick();
    await switchTo(CAT.relaxing);
    await requestSync();
    const cursor = await getMeta(SYNC_META.lastSync);
    const relaxingSeg = (await liveSegments())[0];
    if (!relaxingSeg) throw new Error('no segment');

    // Something the pull should still apply: a rename on the server.
    const sleep = SEED_CATEGORIES.find((c) => c.id === CAT.sleep) as Category;
    server.put({ categories: [{ ...sleep, name: 'Snoozing' }] });
    // A switch made while the snapshot request is in flight.
    let switched = false;
    server.duringSnapshot = async () => {
      if (switched) return;
      switched = true;
      tick();
      await switchTo(CAT.housework);
    };

    expect(await syncRound()).toEqual({ status: 'ok', again: true });

    // The server still had Relaxing open; the local close and the new segment survive.
    const local = await liveSegments();
    expect(local.find((s) => s.id === relaxingSeg.id)?.endedAt).not.toBeNull();
    expect(local.filter((s) => s.endedAt === null).map((s) => s.categoryId)).toEqual([
      CAT.housework,
    ]);
    expect(checkInvariants(local)).toEqual([]);
    expect((await db.categories.get(CAT.sleep))?.name).toBe('Snoozing');
    expect(await getMeta(SYNC_META.lastSync)).toBe(cursor);
    expect(await db.outbox.count()).toBe(1);

    // The next round sends the switch and pulls the rows back from the server.
    expect(await syncRound()).toEqual({ status: 'ok', again: false });
    const after = await liveSegments();
    expect(after.filter((s) => s.endedAt === null).map((s) => s.categoryId)).toEqual([
      CAT.housework,
    ]);
    expect(checkInvariants(after)).toEqual([]);
    expect(await getMeta(SYNC_META.lastSync)).not.toBe(cursor);
  });

  it('Undo of a switch still works after the switch synced and came back', async () => {
    const server = await connected();
    await requestSync();
    tick();
    const first = await switchTo(CAT.sleep);
    await requestSync();
    tick();
    const second = await switchTo(CAT.housework);
    // The outbox flushes about a second later; the server stamps the switch
    // with its own clock and the pull brings that copy back.
    tick(1_000);
    await requestSync();
    tick(2_000);
    if (!second.undo) throw new Error('no undo token');

    await undoAction(second.undo);
    expect((await liveSegments()).filter((s) => s.endedAt === null).map((s) => s.id)).toEqual([
      first.opened?.id,
    ]);
    await requestSync();
    const serverOpen = [...server.segments.values()]
      .map((s) => s.row)
      .filter((s) => s.deletedAt === null && s.endedAt === null);
    expect(serverOpen.map((s) => s.id)).toEqual([first.opened?.id]);
    expect((await liveSegments()).filter((s) => s.endedAt === null).map((s) => s.id)).toEqual([
      first.opened?.id,
    ]);
  });

  it('keeps a pending settings change over the server copy', async () => {
    const server = await connected();
    await requestSync();
    server.duringSnapshot = async () => {
      server.duringSnapshot = null;
      await updateSettings({ dayStartHour: 6 });
    };
    tick();
    const current = await db.settings.get(SETTINGS_ID);
    if (!current) throw new Error('no settings');
    server.settings = {
      row: { ...current, dayStartHour: 2, updatedAt: toIso(Date.now()) },
      syncedAt: Date.now(),
    };
    expect(await syncRound()).toEqual({ status: 'ok', again: true });
    expect((await db.settings.get(SETTINGS_ID))?.dayStartHour).toBe(6);
  });
});

describe('full resync', () => {
  it('connect tests the token, sends the seed, then replaces local data with the server copy', async () => {
    const server = fakeServer('right');
    // History from an earlier install, plus a category this phone never had.
    tick();
    const extra: Category = {
      ...(SEED_CATEGORIES[0] as Category),
      id: uuidv7(),
      name: 'Gym',
      sortOrder: 11,
      createdAt: toIso(Date.now()),
      updatedAt: toIso(Date.now()),
    };
    const history = [
      seg(CAT.sleep, T0 - 8 * 3_600_000, T0 - 3_600_000),
      seg(CAT.casualWork, T0 - 3_600_000, null),
    ];
    server.put({
      categories: [...SEED_CATEGORIES, extra],
      segments: history,
      rules: [...SEED_RULES],
    });
    server.settings = {
      row: { ...defaultSettings('Europe/London'), dayStartHour: 5, updatedAt: toIso(Date.now()) },
      syncedAt: Date.now(),
    };
    // A local-only row the server never received is replaced too.
    const orphan: Category = { ...extra, id: uuidv7(), name: 'Orphan' };
    await db.categories.put(orphan);

    await expect(connect('wrong')).rejects.toMatchObject({ status: 401 });
    expect(await getToken()).toBeNull();

    expect(await connect('  right ')).toEqual({ status: 'ok', again: false });
    expect(await getToken()).toBe('right');
    expect(server.calls.findLast((c) => c.path === '/api/settings')?.auth).toBe('Bearer right');
    expect(server.snapshotCalls().map((c) => c.path)).toEqual(['/api/snapshot']);

    const categories = await db.categories.toArray();
    expect(categories).toHaveLength(11);
    expect(new Set(categories.map((c) => c.name)).size).toBe(11);
    expect(categories.some((c) => c.name === 'Orphan')).toBe(false);
    expect((await db.segments.toArray()).map((s) => s.id).sort()).toEqual(
      history.map((s) => s.id).sort(),
    );
    // The seed's settings op lost to the server's newer copy.
    expect((await db.settings.get(SETTINGS_ID))?.dayStartHour).toBe(5);
    expect(await getMeta(SYNC_META.needsFullResync)).toBeUndefined();
    expect(await getMeta(SYNC_META.lastSync)).toBe(toIso(Date.now()));
  });

  it('keeps local data when the server has no categories but this phone has', async () => {
    const server = await connected();
    await db.outbox.clear();
    await setMeta(SYNC_META.needsFullResync, '1');

    expect(await requestSync()).toEqual({
      status: 'error',
      kind: 'problem',
      message: EMPTY_SERVER_MESSAGE,
    });
    expect(await db.categories.count()).toBe(10);
    expect(await db.rules.count()).toBe(2);
    expect(await db.settings.count()).toBe(1);
    expect((await syncError())?.kind).toBe('problem');
    expect(await getMeta(SYNC_META.needsFullResync)).toBe('1');
    expect(server.snapshotCalls()).toHaveLength(1);
  });

  it('keeps local data when the server lost it but got a category back since', async () => {
    const server = await connected();
    for (let i = 0; i < 6; i++) {
      tick();
      await switchTo(i % 2 === 0 ? CAT.relaxing : CAT.contractWork);
    }
    await requestSync();
    const history = await liveSegments();
    expect(history).toHaveLength(6);

    // The server loses everything. The phone does not notice: incremental
    // pulls never wipe. Then a rename lands, so the server has one category.
    server.categories.clear();
    server.segments.clear();
    server.rules.clear();
    server.settings = null;
    tick();
    await updateCategory(CAT.hobbies, { name: 'Fun' });
    expect((await requestSync()).status).toBe('ok');
    expect(server.categories.size).toBe(1);

    // A switch to a category the server lost is refused, which asks for a full resync.
    tick();
    await switchTo(CAT.housework);
    const outcome = await requestSync();

    expect(outcome).toMatchObject({ status: 'error', kind: 'problem' });
    expect(await getMeta(SYNC_META.serverEmpty)).toBe('1');
    const after = await liveSegments();
    for (const s of history) expect(after.map((x) => x.id)).toContain(s.id);
    expect(await db.categories.count()).toBe(10);

    // Reset is refused the same way and keeps the outbox.
    tick();
    await switchTo(CAT.relaxing);
    expect(await requestReset()).toMatchObject({ status: 'error', kind: 'problem' });
    expect(await db.outbox.count()).toBe(1);

    // Uploading this phone restores the server, and then the full resync goes through.
    const local = (await liveSegments()).map((s) => s.id).sort();
    expect((await uploadThisPhone()).outcome).toEqual({ status: 'ok', again: false });
    expect(server.categories.size).toBe(10);
    expect((await liveSegments()).map((s) => s.id).sort()).toEqual(local);
    expect(await getMeta(SYNC_META.serverEmpty)).toBeUndefined();
  });

  it('a refused op on a healthy server still replaces the local rows it made', async () => {
    const server = await connected();
    tick();
    await switchTo(CAT.relaxing);
    await requestSync();
    // A Shortcut switched the server to Housework meanwhile; the phone switches there too.
    const open = [...server.segments.values()].map((s) => s.row).find((s) => !s.endedAt);
    if (!open) throw new Error('no open segment');
    tick();
    const at = toIso(Date.now());
    const shortcut = { ...open, id: uuidv7(), categoryId: CAT.housework, startedAt: at };
    server.put({ segments: [{ ...open, endedAt: at, updatedAt: at }, shortcut] });
    tick();
    await switchTo(CAT.housework);

    expect((await requestSync()).status).toBe('ok');
    expect(await getMeta(SYNC_META.serverEmpty)).toBeUndefined();
    expect((await liveSegments()).map((s) => s.id).sort()).toEqual([open.id, shortcut.id].sort());
  });

  it('drops a refused switch’s segment even when an op made during the resync closed it', async () => {
    const server = await connected();
    tick();
    await switchTo(CAT.sleep);
    await requestSync();
    // Offline: switch to Relaxing. Before it is flushed a Shortcut switches the server to Relaxing too.
    tick();
    const refused = await switchTo(CAT.relaxing);
    tick(5 * 60_000);
    const live = [...server.segments.values()].map((s) => s.row).filter((s) => !s.deletedAt);
    const shortcut = switchCategory(
      live,
      { categoryId: CAT.relaxing, source: 'shortcut' },
      { now: toIso(Date.now()), newId: () => uuidv7() },
    );
    server.put({ segments: shortcut.rows });
    // Back online: the switch is a conflict, and while the full resync is in
    // flight the owner switches to Housework, which closes the refused segment.
    tick(5 * 60_000);
    server.duringSnapshot = async () => {
      if (server.snapshotCalls().at(-1)?.path !== '/api/snapshot') return;
      server.duringSnapshot = null;
      tick(1_000);
      await switchTo(CAT.housework);
    };
    expect((await syncRound()).status).toBe('ok');
    expect(checkInvariants(await db.segments.toArray())).toEqual([]);

    expect(await syncRound()).toEqual({ status: 'ok', again: false });
    const local = await liveSegments();
    expect(local.some((s) => s.id === refused.opened?.id)).toBe(false);
    expect(checkInvariants(local)).toEqual([]);
    const shape = (rows: typeof local) =>
      rows.map((s) => `${s.id} ${s.startedAt} ${s.endedAt}`).sort();
    const remote = [...server.segments.values()].map((s) => s.row).filter((s) => !s.deletedAt);
    expect(shape(local)).toEqual(shape(remote));
  });

  it('reset discards the outbox and re-downloads everything', async () => {
    const server = await connected();
    await requestSync();
    tick();
    await switchTo(CAT.relaxing);
    expect(await db.outbox.count()).toBe(1);

    expect(await requestReset()).toEqual({ status: 'ok', again: false });
    expect(await db.outbox.count()).toBe(0);
    expect(await liveSegments()).toEqual([]);
    expect(
      server
        .opsBodies()
        .flat()
        .some((op) => op.type === 'switch'),
    ).toBe(false);
    expect(await db.categories.count()).toBe(10);
  });

  it('reset keeps the outbox and local data when the server is empty', async () => {
    const server = await connected();
    expect(await requestReset()).toMatchObject({ status: 'error', kind: 'problem' });
    expect(await db.outbox.count()).toBe(SEED_OPS);
    expect(await db.categories.count()).toBe(10);
    expect(server.opsBodies()).toHaveLength(0);
  });
});

describe('upload this phone', () => {
  it('flags an empty server, uploads everything in order, and clears the flag', async () => {
    // A phone that synced fully, then the server lost its data.
    const server = await connected();
    for (let i = 0; i < 230; i++) {
      tick();
      await switchTo(i % 2 === 0 ? CAT.relaxing : CAT.contractWork);
    }
    await requestSync();
    expect(await db.outbox.count()).toBe(0);
    const before = {
      segments: await liveSegments(),
      categories: await db.categories.count(),
      rules: await db.rules.count(),
    };
    server.categories.clear();
    server.segments.clear();
    server.rules.clear();
    server.settings = null;
    await setMeta(SYNC_META.needsFullResync, '1');

    expect(await requestSync()).toMatchObject({ status: 'error', message: EMPTY_SERVER_MESSAGE });
    expect(await getMeta(SYNC_META.serverEmpty)).toBe('1');

    const { queued, outcome } = await uploadThisPhone();
    // Settings, 10 categories, 2 rules, then 230 segments in ops of at most 100 rows.
    expect(queued).toBe(1 + 10 + 2 + 3);
    expect(outcome).toEqual({ status: 'ok', again: false });

    // Each request answers only 15 ops, so later requests repeat the unanswered ones.
    const firstSends = new Map(
      server
        .opsBodies()
        .flat()
        .map((op) => [op.opId, op] as const),
    );
    const sent = [...firstSends.values()].slice(-queued);
    expect(sent.map((op) => op.type)).toEqual([
      'settings.upsert',
      ...Array<string>(10).fill('category.upsert'),
      'rule.upsert',
      'rule.upsert',
      'segments.upsert',
      'segments.upsert',
      'segments.upsert',
    ]);
    expect(server.categories.size).toBe(10);
    expect(server.rules.size).toBe(2);
    expect(server.settings).not.toBeNull();
    const serverSegments = [...server.segments.values()].map((s) => s.row);
    expect(serverSegments).toHaveLength(before.segments.length);
    expect(checkInvariants(serverSegments)).toEqual([]);

    // The phone kept everything, the flag and the error are gone.
    expect(await liveSegments()).toEqual(before.segments);
    expect(await db.categories.count()).toBe(before.categories);
    expect(await db.rules.count()).toBe(before.rules);
    expect(await getMeta(SYNC_META.serverEmpty)).toBeUndefined();
    expect(await syncError()).toBeNull();
    expect(await db.outbox.count()).toBe(0);
  });

  it('a clean sync clears a stale empty-server flag', async () => {
    await connected();
    await setMeta(SYNC_META.serverEmpty, '1');
    expect(await requestSync()).toEqual({ status: 'ok', again: false });
    expect(await getMeta(SYNC_META.serverEmpty)).toBeUndefined();
  });

  it('skips rows that point at deleted categories', async () => {
    await connected();
    const gone: Category = { ...SEED_CATEGORIES[0]!, id: uuidv7(), deletedAt: toIso(T0) };
    await db.categories.put(gone);
    await db.segments.put(seg(gone.id, T0 - 7_200_000, T0 - 3_600_000));
    await db.outbox.clear();
    const queued = await queueFullUpload();
    const ops = (await db.outbox.toArray()).map((r) => r.op);
    expect(queued).toBe(ops.length);
    expect(ops.some((op) => op.type === 'category.upsert' && op.payload.id === gone.id)).toBe(
      false,
    );
    expect(ops.some((op) => op.type === 'segments.upsert')).toBe(false);
  });
});

describe('single flight', () => {
  it('runs one request at a time and folds requests made during a round into one rerun', async () => {
    const server = await connected();
    const a = requestSync();
    // Asked before the round started: the same round serves it.
    expect(requestSync()).toBe(a);
    let joined: Promise<unknown> | null = null;
    server.duringSnapshot = () => {
      server.duringSnapshot = null;
      joined = requestSync();
      return Promise.resolve();
    };
    await a;
    expect(joined).toBe(a);
    expect(server.maxInFlight).toBe(1);
    // The request made mid-round made it go again: one flush, two pulls.
    expect(server.opsBodies()).toHaveLength(1);
    expect(server.snapshotCalls()).toHaveLength(2);

    // A reset waits for the running round.
    const c = requestSync();
    const r = requestReset();
    await Promise.all([c, r]);
    expect(server.maxInFlight).toBe(1);
    expect(server.snapshotCalls()).toHaveLength(4);
  });
});

describe('disconnect', () => {
  it('forgets the token and keeps local data and the outbox', async () => {
    const server = await connected();
    tick();
    await switchTo(CAT.relaxing);
    await disconnect();
    expect(await getToken()).toBeNull();
    expect(await requestSync()).toEqual({ status: 'off' });
    expect(server.calls).toHaveLength(0);
    expect(await liveSegments()).toHaveLength(1);
    expect(await db.outbox.count()).toBe(SEED_OPS + 1);
  });
});
