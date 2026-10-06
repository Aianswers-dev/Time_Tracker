import { checkInvariants, switchCategory, toIso, uuidv7, type Segment } from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../api/client';
import { ensureSeeded } from '../data/seed';
import {
  applySegmentAction,
  switchTo,
  undoAction,
  type SegmentAction,
  type UndoToken,
} from '../data/segmentActions';
import { CAT, resetDb } from '../data/testUtils';
import { db } from '../db';
import { syncRound } from './engine';
import { stopSync } from './scheduler';
import { fakeServer, type FakeServer } from './testServer';

/**
 * Randomised: phone actions (switch, backdated switch, Undo, insert, delete,
 * backdate), Shortcut switches on the server, sync rounds with an action
 * made while the snapshot is in flight, partial application, lost answers
 * after the server applied, and no answer at all. After every clean round the
 * phone's segments satisfy the invariants, and at the end the phone and the
 * server hold exactly the same live segments.
 */

const SEEDS = 40;
const STEPS = 50;
const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const CATS = [CAT.sleep, CAT.relaxing, CAT.housework, CAT.contractWork, CAT.hobbies];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function shape(rows: readonly Segment[]): string[] {
  return rows
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((s) => `${s.id} ${s.categoryId} ${s.startedAt}-${s.endedAt ?? ''}`);
}

function serverRows(server: FakeServer): Segment[] {
  return [...server.segments.values()].map((s) => s.row);
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

describe('phone and server converge', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const log: string[] = [];
      const server = fakeServer();
      await setToken(server.token);
      await syncRound();

      let faults = false;
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        server.maxApplied = faults ? 1 + Math.floor(r() * 15) : 15;
        const f = r();
        if (faults && f < 0.1) throw new TypeError('Failed to fetch');
        const res = await inner(input, init);
        // The server applied the ops, but the answer never arrived.
        if (faults && f < 0.2) return new Response('oops', { status: 503 });
        return res;
      });

      let token: UndoToken | null = null;
      const live = async () => (await db.segments.toArray()).filter((s) => s.deletedAt === null);
      const act = async (action: SegmentAction) => {
        log.push(JSON.stringify(action));
        token = (await applySegmentAction(action)).undo ?? token;
      };
      const localAction = async () => {
        const x = r();
        try {
          if (x < 0.45) {
            const back = r() < 0.2 ? Math.floor(r() * 3 * 3_600_000) : 0;
            const categoryId = pick(CATS);
            log.push(`switch ${categoryId} back ${back}`);
            token =
              (await switchTo(categoryId, back ? toIso(Date.now() - back) : undefined)).undo ??
              token;
          } else if (x < 0.6 && token) {
            log.push('undo');
            token = (await undoAction(token)).undo;
          } else if (x < 0.75) {
            const closed = (await live()).filter((s) => s.endedAt !== null);
            if (closed.length > 0) {
              const fill = pick(['none', 'prev', 'next'] as const);
              await act({ kind: 'delete', id: pick(closed).id, fill });
            }
          } else if (x < 0.9) {
            const end = Date.now() - Math.floor(r() * 2 * 3_600_000);
            const start = end - 60_000 - Math.floor(r() * 3_600_000);
            await act({
              kind: 'insert',
              categoryId: pick(CATS),
              startedAt: toIso(start),
              endedAt: toIso(end),
            });
          } else {
            const open = (await live()).find((s) => s.endedAt === null);
            if (open) {
              const startedAt = toIso(Date.parse(open.startedAt) - Math.floor(r() * 3_600_000));
              await act({ kind: 'backdate', startedAt });
            }
          }
        } catch (err) {
          log.push(`  refused: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      for (let step = 0; step < STEPS; step++) {
        vi.setSystemTime(Date.now() + 1_000 + Math.floor(r() * 10 * 60_000));
        faults = r() < 0.5;
        let clean = false;
        const y = r();
        if (y < 0.55) {
          await localAction();
        } else if (y < 0.7) {
          const rows = serverRows(server).filter((s) => s.deletedAt === null);
          const categoryId = pick(CATS);
          if (rows.find((s) => s.endedAt === null)?.categoryId !== categoryId) {
            log.push(`shortcut ${categoryId}`);
            const res = switchCategory(
              rows,
              { categoryId, source: 'shortcut' },
              { now: toIso(Date.now()), newId: () => uuidv7() },
            );
            server.put({ segments: res.rows });
          }
        } else if (y < 0.85) {
          log.push('sync');
          const out = await syncRound();
          clean = out.status === 'ok' && !out.again;
        } else {
          log.push('sync, with an action while the snapshot is in flight');
          server.duringSnapshot = async () => {
            server.duringSnapshot = null;
            await localAction();
          };
          await syncRound();
          server.duringSnapshot = null;
        }
        if (clean) expect(checkInvariants(await db.segments.toArray()), log.join('\n')).toEqual([]);
      }

      faults = false;
      for (let i = 0; i < 20; i++) {
        const out = await syncRound();
        expect(out.status, log.join('\n')).toBe('ok');
        if (out.status === 'ok' && !out.again && (await db.outbox.count()) === 0) break;
      }
      const context = log.join('\n');
      expect(checkInvariants(serverRows(server)), context).toEqual([]);
      expect(checkInvariants(await db.segments.toArray()), context).toEqual([]);
      expect(shape(await db.segments.toArray()), context).toEqual(shape(serverRows(server)));
    });
  }
});
