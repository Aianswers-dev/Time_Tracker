import {
  checkInvariants,
  HOUR_MS,
  MINUTE_MS,
  opSchema,
  SEED_CATEGORIES,
  SEED_RULES,
  SETTINGS_ID,
  toIso,
  toMs,
  type Segment,
} from '@time-tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import {
  addCategory,
  CategoryError,
  deleteCategory,
  moveCategory,
  setArchived,
  updateCategory,
} from './categoryActions';
import { ensureSeeded } from './seed';
import { applySegmentAction, backdateOpenTo, switchTo, undoAction } from './segmentActions';
import { updateSettings } from './settingsActions';
import { allOps, CAT, liveSegments, opsAfter, resetDb, seg } from './testUtils';
import { findOpenSegment, loadAround, WINDOW_MARGIN_MS } from './window';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const SEED_OPS = SEED_CATEGORIES.length + SEED_RULES.length + 1;

function setNow(ms: number) {
  vi.setSystemTime(new Date(ms));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(T0);
  await resetDb();
  await ensureSeeded('Australia/Sydney');
});

afterEach(() => {
  vi.useRealTimers();
});

async function expectValid() {
  expect(checkInvariants(await db.segments.toArray())).toEqual([]);
}

describe('seed', () => {
  it('seeds categories, rules, settings and one upsert op per row', async () => {
    expect(await db.categories.count()).toBe(10);
    expect(await db.rules.count()).toBe(2);
    const settings = await db.settings.get(SETTINGS_ID);
    expect(settings?.timezone).toBe('Australia/Sydney');
    expect(settings?.dayStartHour).toBe(4);
    const ops = await allOps();
    expect(ops).toHaveLength(SEED_OPS);
    for (const op of ops) expect(opSchema.safeParse(op).success).toBe(true);
    expect(ops.filter((o) => o.type === 'category.upsert')).toHaveLength(10);
    expect(ops.filter((o) => o.type === 'rule.upsert')).toHaveLength(2);
    expect(ops.filter((o) => o.type === 'settings.upsert')).toHaveLength(1);
    expect(await db.meta.get('seededAt')).toBeDefined();
  });

  it('is idempotent, including concurrent calls (StrictMode)', async () => {
    await resetDb();
    const results = await Promise.all([ensureSeeded('UTC'), ensureSeeded('UTC')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ensureSeeded('UTC')).toBe(false);
    expect(await db.categories.count()).toBe(10);
    expect(await db.outbox.count()).toBe(SEED_OPS);
  });

  it('keeps the categories in seeded order', async () => {
    const names = (await db.categories.orderBy('sortOrder').toArray()).map((c) => c.name);
    expect(names[0]).toBe('Sleep');
    expect(names[9]).toBe('Hobbies');
  });
});

describe('switch', () => {
  it('writes the new open segment and exactly one switch op', async () => {
    const out = await switchTo(CAT.relaxing);
    expect(out.noop).toBe(false);
    expect(out.opened?.categoryId).toBe(CAT.relaxing);
    const open = await findOpenSegment();
    expect(open?.id).toBe(out.opened?.id);
    expect(open?.startedAt).toBe(toIso(T0));

    const ops = await opsAfter(SEED_OPS);
    expect(ops).toHaveLength(1);
    const [op] = ops;
    expect(op?.type).toBe('switch');
    if (op?.type !== 'switch') throw new Error('expected a switch op');
    expect(op.payload).toEqual({
      categoryId: CAT.relaxing,
      at: toIso(T0),
      newSegmentId: out.opened?.id,
      source: 'app',
    });
    expect(op.createdAt).toBe(toIso(T0));
  });

  it('closes the previous segment at the switch time', async () => {
    await switchTo(CAT.sleep);
    setNow(T0 + 8 * HOUR_MS);
    const out = await switchTo(CAT.housework);
    expect(out.rows).toHaveLength(2);
    const live = await liveSegments();
    const sleep = live.find((s) => s.categoryId === CAT.sleep);
    expect(sleep?.endedAt).toBe(toIso(T0 + 8 * HOUR_MS));
    expect((await findOpenSegment())?.categoryId).toBe(CAT.housework);
    expect((await opsAfter(SEED_OPS)).map((o) => o.type)).toEqual(['switch', 'switch']);
    await expectValid();
  });

  it('is a no-op for the running category and queues nothing', async () => {
    await switchTo(CAT.relaxing);
    setNow(T0 + MINUTE_MS);
    const out = await switchTo(CAT.relaxing);
    expect(out.noop).toBe(true);
    expect(out.undo).toBeNull();
    expect(await opsAfter(SEED_OPS)).toHaveLength(1);
  });

  it('backdates a switch, trimming what came after', async () => {
    await switchTo(CAT.relaxing);
    setNow(T0 + HOUR_MS);
    const at = toIso(T0 + 20 * MINUTE_MS);
    const out = await switchTo(CAT.housework, at);
    expect(out.opened?.startedAt).toBe(at);
    const relaxing = (await liveSegments()).find((s) => s.categoryId === CAT.relaxing);
    expect(relaxing?.endedAt).toBe(at);
    const ops = await opsAfter(SEED_OPS);
    expect(ops).toHaveLength(2);
    const last = ops[1];
    expect(last?.type === 'switch' && last.payload.at).toBe(at);
    await expectValid();
  });

  it('rejects a switch far in the future without writing', async () => {
    await expect(switchTo(CAT.relaxing, toIso(T0 + HOUR_MS))).rejects.toThrow(/future/);
    expect(await db.segments.count()).toBe(0);
    expect(await opsAfter(SEED_OPS)).toHaveLength(0);
  });
});

describe('undo', () => {
  it('reverses a switch with one segments.upsert op', async () => {
    const first = await switchTo(CAT.sleep);
    setNow(T0 + HOUR_MS);
    const second = await switchTo(CAT.housework);
    setNow(T0 + HOUR_MS + 5_000);
    if (!second.undo) throw new Error('expected an undo token');
    await undoAction(second.undo);

    const open = await findOpenSegment();
    expect(open?.id).toBe(first.opened?.id);
    expect(open?.endedAt).toBeNull();
    const housework = await db.segments.get(second.opened?.id ?? '');
    expect(housework?.deletedAt).not.toBeNull();

    const ops = await opsAfter(SEED_OPS);
    expect(ops.map((o) => o.type)).toEqual(['switch', 'switch', 'segments.upsert']);
    await expectValid();
  });

  it('refuses once a row it would touch has changed', async () => {
    await switchTo(CAT.sleep);
    setNow(T0 + HOUR_MS);
    const second = await switchTo(CAT.housework);
    setNow(T0 + 2 * HOUR_MS);
    await switchTo(CAT.relaxing);
    if (!second.undo) throw new Error('expected an undo token');
    await expect(undoAction(second.undo)).rejects.toThrow(/Too late/);
    expect((await findOpenSegment())?.categoryId).toBe(CAT.relaxing);
  });
});

describe('segment edits each queue one segments.upsert op', () => {
  let a: Segment;
  let b: Segment;
  let c: Segment;

  beforeEach(async () => {
    // a: 07:00-08:00 Sleep, b: 08:00-09:00 Housework, c: 09:00-open Relaxing
    a = seg(CAT.sleep, T0 - 3 * HOUR_MS, T0 - 2 * HOUR_MS);
    b = seg(CAT.housework, T0 - 2 * HOUR_MS, T0 - HOUR_MS);
    c = seg(CAT.relaxing, T0 - HOUR_MS, null);
    await db.segments.bulkPut([a, b, c]);
  });

  async function expectOneUpsert(rowCount?: number) {
    const ops = await opsAfter(SEED_OPS);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.type).toBe('segments.upsert');
    if (rowCount !== undefined && op?.type === 'segments.upsert') {
      expect(op.payload.rows).toHaveLength(rowCount);
    }
    await expectValid();
  }

  it('backdate open', async () => {
    await backdateOpenTo(toIso(T0 - 90 * MINUTE_MS));
    expect((await db.segments.get(b.id))?.endedAt).toBe(toIso(T0 - 90 * MINUTE_MS));
    expect((await db.segments.get(c.id))?.startedAt).toBe(toIso(T0 - 90 * MINUTE_MS));
    await expectOneUpsert(2);
  });

  it('edit', async () => {
    await applySegmentAction({
      kind: 'edit',
      params: { id: b.id, endedAt: toIso(T0 - 30 * MINUTE_MS), note: ' dishes ' },
    });
    const edited = await db.segments.get(b.id);
    expect(edited?.endedAt).toBe(toIso(T0 - 30 * MINUTE_MS));
    expect(edited?.note).toBe('dishes');
    expect((await db.segments.get(c.id))?.startedAt).toBe(toIso(T0 - 30 * MINUTE_MS));
    await expectOneUpsert(2);
  });

  it('split', async () => {
    await applySegmentAction({
      kind: 'split',
      id: b.id,
      at: toIso(T0 - 90 * MINUTE_MS),
      secondCategoryId: CAT.lifeAdmin,
    });
    const live = await liveSegments();
    expect(live).toHaveLength(4);
    expect(live.find((s) => s.categoryId === CAT.lifeAdmin)?.endedAt).toBe(b.endedAt);
    await expectOneUpsert(2);
  });

  it('insert', async () => {
    await db.segments.put({ ...b, deletedAt: toIso(T0), updatedAt: toIso(T0) });
    await applySegmentAction({
      kind: 'insert',
      categoryId: CAT.hobbies,
      startedAt: b.startedAt,
      endedAt: b.endedAt ?? '',
      note: null,
    });
    const live = await liveSegments();
    expect(live.find((s) => s.categoryId === CAT.hobbies)?.source).toBe('edit');
    await expectOneUpsert(1);
  });

  it('delete with each fill', async () => {
    await applySegmentAction({ kind: 'delete', id: b.id, fill: 'prev' });
    expect((await db.segments.get(a.id))?.endedAt).toBe(b.endedAt);
    expect((await db.segments.get(b.id))?.deletedAt).not.toBeNull();
    await expectOneUpsert(2);
  });

  it('delete the open segment continues the previous one', async () => {
    await applySegmentAction({ kind: 'delete', id: c.id, fill: 'prev' });
    expect((await findOpenSegment())?.id).toBe(b.id);
    await expectOneUpsert(2);
  });

  it('refuses to delete the open segment without fill', async () => {
    await expect(applySegmentAction({ kind: 'delete', id: c.id, fill: 'none' })).rejects.toThrow();
    expect(await opsAfter(SEED_OPS)).toHaveLength(0);
  });

  it('an edit that changes nothing queues nothing', async () => {
    const out = await applySegmentAction({ kind: 'edit', params: { id: b.id, note: null } });
    expect(out.noop).toBe(true);
    expect(await opsAfter(SEED_OPS)).toHaveLength(0);
  });
});

describe('loading windows', () => {
  it('includes a long segment that starts before the margin', async () => {
    const long = seg(CAT.sleep, T0 - 30 * 24 * HOUR_MS, T0 - HOUR_MS);
    const open = seg(CAT.relaxing, T0 - HOUR_MS, null);
    await db.segments.bulkPut([long, open]);
    const rows = await loadAround(T0 - 2 * HOUR_MS, T0);
    expect(rows.map((s) => s.id).sort()).toEqual([long.id, open.id].sort());
  });

  it('a backdated switch into a long segment trims it correctly', async () => {
    const long = seg(CAT.sleep, T0 - 10 * 24 * HOUR_MS, null);
    await db.segments.put(long);
    await switchTo(CAT.housework, toIso(T0 - 2 * HOUR_MS));
    expect((await db.segments.get(long.id))?.endedAt).toBe(toIso(T0 - 2 * HOUR_MS));
    await expectValid();
  });

  it('skips old segments outside the window', async () => {
    const old = seg(CAT.sleep, T0 - 20 * 24 * HOUR_MS, T0 - 19 * 24 * HOUR_MS);
    const older = seg(CAT.sleep, T0 - 21 * 24 * HOUR_MS, T0 - 20.5 * 24 * HOUR_MS);
    const recent = seg(CAT.relaxing, T0 - HOUR_MS, null);
    await db.segments.bulkPut([older, old, recent]);
    const rows = await loadAround(T0 - HOUR_MS);
    // `old` is the nearest segment before the window, `older` is not loaded.
    expect(rows.map((s) => s.id).sort()).toEqual([old.id, recent.id].sort());
    expect(T0 - HOUR_MS - WINDOW_MARGIN_MS).toBeGreaterThan(toMs(old.endedAt ?? ''));
  });
});

describe('categories and settings', () => {
  it('rename queues one category.upsert op', async () => {
    const updated = await updateCategory(CAT.relaxing, { name: 'Chilling', color: '#f76b15' });
    expect(updated.name).toBe('Chilling');
    const ops = await opsAfter(SEED_OPS);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.type).toBe('category.upsert');
    expect(ops[0]?.type === 'category.upsert' && ops[0].payload.name).toBe('Chilling');
  });

  it('rejects a duplicate name', async () => {
    await expect(updateCategory(CAT.relaxing, { name: ' sleep ' })).rejects.toBeInstanceOf(
      CategoryError,
    );
    expect(await opsAfter(SEED_OPS)).toHaveLength(0);
  });

  it('add, archive, reorder', async () => {
    const added = await addCategory({
      name: 'Exercise',
      color: '#46a758',
      icon: 'dumbbell',
      exemptFromStaleCheck: false,
    });
    expect(added.sortOrder).toBe(11);
    await setArchived(added.id, true);
    await moveCategory(added.id, -1);
    const order = (await db.categories.orderBy('sortOrder').toArray()).map((c) => c.name);
    expect(order.slice(-2)).toEqual(['Exercise', 'Hobbies']);
    const types = (await opsAfter(SEED_OPS)).map((o) => o.type);
    expect(types).toEqual(Array(4).fill('category.upsert'));
  });

  it('deletes only unused categories, with their rules', async () => {
    await db.segments.put(seg(CAT.housework, T0 - HOUR_MS, null));
    await expect(deleteCategory(CAT.housework)).rejects.toBeInstanceOf(CategoryError);
    await deleteCategory(CAT.relaxing);
    expect((await db.categories.get(CAT.relaxing))?.deletedAt).not.toBeNull();
    const rules = await db.rules.where('categoryId').equals(CAT.relaxing).toArray();
    expect(rules.every((r) => r.deletedAt !== null)).toBe(true);
    const types = (await opsAfter(SEED_OPS)).map((o) => o.type);
    expect(types).toEqual(['category.upsert', 'rule.upsert', 'rule.upsert']);
  });

  it('settings changes queue settings.upsert', async () => {
    await updateSettings({ dayStartHour: 5 });
    await updateSettings({ dayStartHour: 5 });
    const ops = await opsAfter(SEED_OPS);
    expect(ops.map((o) => o.type)).toEqual(['settings.upsert']);
    expect((await db.settings.get(SETTINGS_ID))?.dayStartHour).toBe(5);
  });
});
