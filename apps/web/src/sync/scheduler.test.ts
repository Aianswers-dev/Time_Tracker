import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../api/client';
import { ensureSeeded } from '../data/seed';
import { switchTo } from '../data/segmentActions';
import { CAT, resetDb } from '../data/testUtils';
import { getSyncRuntime } from './runtime';
import { startSync, stopSync, whenSyncIdle, type SyncEnv } from './scheduler';
import { fakeServer, json, type FakeServer } from './testServer';

interface FakeEnv extends SyncEnv {
  visible: boolean;
  online: boolean;
  fire: (name: 'online' | 'visibilitychange') => void;
}

function fakeEnv(): FakeEnv {
  const events = new EventTarget();
  const visibility = new EventTarget();
  const env: FakeEnv = {
    events,
    visibility,
    visible: true,
    online: true,
    isVisible: () => env.visible,
    isOnline: () => env.online,
    fire: (name) => (name === 'online' ? events : visibility).dispatchEvent(new Event(name)),
  };
  return env;
}

/** Let timers due within `ms` fire, then wait for the syncs they started. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await whenSyncIdle();
}

let server: FakeServer;
let env: FakeEnv;

beforeEach(async () => {
  // Timers and Date are fake; fake-indexeddb's setImmediate stays real.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(Date.parse('2026-10-06T10:00:00.000Z'));
  await resetDb();
  await ensureSeeded('UTC');
  server = fakeServer();
  env = fakeEnv();
});

afterEach(() => {
  stopSync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const pulls = () => server.snapshotCalls().length;

describe('triggers', () => {
  it('sync on start, on becoming visible, on going online and every 30 s while visible', async () => {
    await setToken(server.token);
    startSync(env);
    await whenSyncIdle();
    expect(pulls()).toBe(1);

    env.fire('visibilitychange');
    await whenSyncIdle();
    expect(pulls()).toBe(2);

    env.fire('online');
    await whenSyncIdle();
    expect(pulls()).toBe(3);

    await advance(30_000);
    expect(pulls()).toBe(4);

    env.visible = false;
    env.fire('visibilitychange');
    await advance(30_000);
    expect(pulls()).toBe(4);
  });

  it('sync about 1 s after the last outbox write, once for a burst', async () => {
    await setToken(server.token);
    startSync(env);
    await whenSyncIdle();
    const flushes = server.opsBodies().length;

    await switchTo(CAT.relaxing);
    await advance(600);
    await switchTo(CAT.housework);
    await advance(600);
    expect(server.opsBodies()).toHaveLength(flushes);

    await advance(500);
    expect(server.opsBodies()).toHaveLength(flushes + 1);
    expect(
      server
        .opsBodies()
        .at(-1)
        ?.map((op) => op.type),
    ).toEqual(['switch', 'switch']);
  });

  it('do nothing without a token or while offline', async () => {
    env.online = false;
    await setToken(server.token);
    startSync(env);
    await switchTo(CAT.relaxing);
    await advance(31_000);
    env.fire('visibilitychange');
    await whenSyncIdle();
    expect(server.calls).toHaveLength(0);

    env.online = true;
    env.fire('online');
    await whenSyncIdle();
    expect(pulls()).toBe(1);
  });

  it('never call the server when no token is stored', async () => {
    startSync(env);
    await switchTo(CAT.relaxing);
    await advance(31_000);
    env.fire('online');
    await whenSyncIdle();
    expect(server.calls).toHaveLength(0);
  });
});

describe('backoff', () => {
  it('retries after 2 s, 4 s, 8 s and holds interval and outbox triggers until then', async () => {
    await setToken(server.token);
    server.intercept = () => json(500, { error: { code: 'internal', message: 'boom' } });
    startSync(env);
    await whenSyncIdle();
    expect(server.calls).toHaveLength(1);
    expect(getSyncRuntime().retryAt).toBe(Date.now() + 2_000);

    await advance(1_999);
    expect(server.calls).toHaveLength(1);
    await advance(1);
    expect(server.calls).toHaveLength(2);

    // An outbox write during the 4 s backoff does not sync early.
    await switchTo(CAT.relaxing);
    await advance(3_999);
    expect(server.calls).toHaveLength(2);
    await advance(1);
    expect(server.calls).toHaveLength(3);
    expect(getSyncRuntime().retryAt).toBe(Date.now() + 8_000);

    // Coming back online retries at once.
    env.fire('online');
    await whenSyncIdle();
    expect(server.calls).toHaveLength(4);

    // Success clears the backoff.
    server.intercept = () => undefined;
    await advance(16_000);
    expect(getSyncRuntime().retryAt).toBeNull();
    expect(pulls()).toBe(1);
  });

  it('stops for good after a 401: no retries, no interval syncs', async () => {
    await setToken('stale');
    startSync(env);
    await whenSyncIdle();
    expect(server.calls).toHaveLength(1);
    expect(getSyncRuntime().retryAt).toBeNull();
    await advance(120_000);
    env.fire('online');
    await whenSyncIdle();
    expect(server.calls).toHaveLength(1);
  });
});
