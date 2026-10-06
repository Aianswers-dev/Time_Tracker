import { describe, expect, it } from 'vitest';
import type { Segment } from './entities';
import {
  applyRows,
  backdateOpen,
  checkInvariants,
  deleteSegment,
  editSegment,
  findOpen,
  FUTURE_TOLERANCE_MS,
  insertSegment,
  liveSorted,
  splitSegment,
  switchCategory,
  undoRows,
} from './segments';
import {
  at,
  describeLive,
  expectOpError,
  liveState,
  makeCtx,
  OLD,
  runOp,
  seg,
  T0,
} from './test-utils';
import { toIso } from './time';

/** A 0-10, B 10-20, C 20-30, D 30- (open). Now is 60. */
function fourInARow(): Segment[] {
  return [
    seg('a', 'A', at(0), at(10)),
    seg('b', 'B', at(10), at(20), { note: 'b note', source: 'shortcut' }),
    seg('c', 'C', at(20), at(30)),
    seg('d', 'D', at(30), null),
  ];
}

function row(rows: readonly Segment[], id: string): Segment {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

describe('switchCategory', () => {
  it('first-ever switch opens a segment at now', () => {
    const ctx = makeCtx(at(5));
    const { result, after } = runOp([], ctx, (s, c) => switchCategory(s, { categoryId: 'A' }, c));
    expect(describeLive(after)).toEqual(['A 5-']);
    expect(result.rows).toHaveLength(1);
    const created = result.rows[0];
    expect(created).toEqual({
      id: 'new-1',
      categoryId: 'A',
      startedAt: at(5),
      endedAt: null,
      note: null,
      source: 'app',
      createdAt: at(5),
      updatedAt: at(5),
      deletedAt: null,
    });
    expect(result.opened).toEqual(created);
  });

  it('uses newSegmentId and source when given', () => {
    const ctx = makeCtx(at(5));
    const { result } = runOp([], ctx, (s, c) =>
      switchCategory(s, { categoryId: 'A', newSegmentId: 'given', source: 'shortcut' }, c),
    );
    expect(result.opened?.id).toBe('given');
    expect(result.opened?.source).toBe('shortcut');
    expect(ctx.ids).toEqual([]);
  });

  it('closes the open segment at now and opens the new one', () => {
    const segs = [seg('a', 'A', at(0), null)];
    const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-60', 'B 60-']);
    expect(row(result.rows, 'a').endedAt).toBe(at(60));
    expect(findOpen(after)?.id).toBe(result.opened?.id);
  });

  it('is a no-op for the category already running, even when backdated', () => {
    const segs = fourInARow();
    for (const atParam of [undefined, at(45), at(5)]) {
      const { result } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'D', at: atParam }, c),
      );
      expect(result).toEqual({ rows: [], noop: true, opened: null });
    }
  });

  it('is not a no-op when only a soft-deleted open segment has the category', () => {
    const segs = [seg('a', 'A', at(0), null), seg('gone', 'B', at(0), null, { deletedAt: OLD })];
    const { after, result } = runOp(segs, makeCtx(at(10)), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-']);
    expect(result.rows.map((r) => r.id)).not.toContain('gone');
  });

  it('clamps a switch up to a minute in the future to now', () => {
    const segs = [seg('a', 'A', at(0), null)];
    for (const ahead of [1, 30_000, FUTURE_TOLERANCE_MS]) {
      const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'B', at: toIso(T0 + 60 * 60_000 + ahead) }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-60', 'B 60-']);
    }
  });

  it('rejects a switch more than a minute in the future', () => {
    const segs = [seg('a', 'A', at(0), null)];
    expectOpError(
      () =>
        switchCategory(
          segs,
          { categoryId: 'B', at: toIso(T0 + 60 * 60_000 + FUTURE_TOLERANCE_MS + 1) },
          makeCtx(at(60)),
        ),
      'in_future',
    );
  });

  it('backdates within the open segment', () => {
    const segs = [seg('z', 'C', at(-10), at(0)), seg('a', 'A', at(0), null)];
    const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'B', at: at(30) }, c),
    );
    expect(describeLive(after)).toEqual(['C -10-0', 'A 0-30', 'B 30-']);
  });

  it('a backdated switch trims the segment it lands in and deletes everything later', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'B', at: at(5) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-5', 'B 5-']);
    for (const id of ['b', 'c', 'd']) {
      const r = row(result.rows, id);
      expect(r.deletedAt).toBe(at(60));
      // A deleted row keeps its last content.
      expect(r.startedAt).toBe(fourInARow().find((s) => s.id === id)?.startedAt);
    }
    expect(row(result.rows, 'a').endedAt).toBe(at(5));
  });

  it('a switch backdated to exactly a boundary leaves the earlier segment alone', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'A', at: at(20) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'A 20-']);
    expect(result.rows.map((r) => r.id).sort()).toEqual(['c', 'd', 'new-1']);
  });

  it('a switch backdated into a gap leaves the gap before it', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'B', at(20), null)];
    const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'C', at: at(15) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'C 15-']);
  });

  it('a switch backdated before all tracking replaces everything', () => {
    const { after } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'C', at: at(-5) }, c),
    );
    expect(describeLive(after)).toEqual(['C -5-']);
  });

  it('deletes the old open segment when the switch leaves it under a second', () => {
    const segs = [seg('z', 'C', at(-10), at(0)), seg('a', 'A', at(0), null)];
    const { after, result } = runOp(segs, makeCtx(at(0, 0, 999)), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    expect(describeLive(after)).toEqual(['C -10-0', 'B 0+999ms-']);
    expect(row(result.rows, 'a').deletedAt).toBe(at(0, 0, 999));
  });

  it('keeps the old open segment when it is exactly one second long', () => {
    const segs = [seg('a', 'A', at(0), null)];
    const { after } = runOp(segs, makeCtx(at(0, 1)), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-0+1000ms', 'B 0+1000ms-']);
  });

  it('switching twice within a second replaces the first switch', () => {
    const segs = [seg('a', 'A', at(0), null)];
    const first = runOp(segs, makeCtx(at(10), 'x'), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    const second = runOp(first.after, makeCtx(at(10, 0, 400), 'y'), (s, c) =>
      switchCategory(s, { categoryId: 'C' }, c),
    );
    expect(describeLive(second.after)).toEqual(['A 0-10', 'C 10+400ms-']);
    // The sliver was created by the first op, so the second op deletes it.
    expect(row(second.result.rows, 'x-1').deletedAt).toBe(at(10, 0, 400));
  });

  it('works when nothing is open', () => {
    const segs = [seg('a', 'A', at(0), at(10))];
    const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'A' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'A 60-']);
  });

  it('rejects a newSegmentId that already exists', () => {
    const segs = [seg('a', 'A', at(0), null)];
    expect(() =>
      switchCategory(segs, { categoryId: 'B', newSegmentId: 'a' }, makeCtx(at(10))),
    ).toThrow();
  });

  it('rejects a newSegmentId that belongs to a soft-deleted segment', () => {
    const segs = [
      seg('a', 'A', at(0), null),
      seg('old', 'B', at(-20), at(-10), { deletedAt: OLD }),
    ];
    expectOpError(
      () => switchCategory(segs, { categoryId: 'B', newSegmentId: 'old' }, makeCtx(at(10))),
      'invalid_range',
    );
  });

  it('rejects an unparseable time with a SegmentOpError', () => {
    expectOpError(
      () => switchCategory([], { categoryId: 'A', at: 'not a time' }, makeCtx(at(0))),
      'invalid_range',
    );
  });

  describe('madeAt: a switch applied after it was made', () => {
    it('keeps segments that started after it was made and fills up to them', () => {
      // A open since 0. The phone switched to T at 30 while offline; a
      // Shortcut switched to X at 45. The phone's op arrives at 60.
      const segs = [seg('a', 'A', at(0), at(45)), seg('x', 'X', at(45), null)];
      const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'T', at: at(30), madeAt: at(30), newSegmentId: 't' }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-30', 'T 30-45', 'X 45-']);
      expect(result.opened).toBeNull();
      expect(row(result.rows, 't').endedAt).toBe(at(45));
      expect(checkInvariants(after)).toEqual([]);
    });

    it('still clears what started between at and madeAt (a backdated switch)', () => {
      // Made at 40 for "since 20": the B from 30 was known and is replaced; X from 50 is later.
      const segs = [
        seg('a', 'A', at(0), at(30)),
        seg('b', 'B', at(30), at(50)),
        seg('x', 'X', at(50), null),
      ];
      const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'T', at: at(20), madeAt: at(40) }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-20', 'T 20-50', 'X 50-']);
    });

    it('a later segment of the same category is not a no-op', () => {
      const segs = [seg('a', 'A', at(0), at(45)), seg('t', 'T', at(45), null)];
      const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'T', at: at(30), madeAt: at(30) }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-30', 'T 30-45', 'T 45-']);
    });

    it('nothing later: the usual switch', () => {
      const segs = [seg('a', 'A', at(0), null)];
      const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'T', at: at(30), madeAt: at(30) }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-30', 'T 30-']);
      expect(result.opened?.categoryId).toBe('T');
    });

    it('a later segment starting under a second after at leaves nothing behind', () => {
      const segs = [seg('a', 'A', at(0), at(30, 0, 500)), seg('x', 'X', at(30, 0, 500), null)];
      const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
        switchCategory(s, { categoryId: 'T', at: at(30), madeAt: at(30), newSegmentId: 't' }, c),
      );
      expect(describeLive(after)).toEqual(['A 0-30', 'X 30+500ms-']);
      expect(result.rows.some((r) => r.id === 't')).toBe(false);
      expect(checkInvariants(after)).toEqual([]);
    });
  });
});

describe('backdateOpen', () => {
  it('needs an open segment', () => {
    expectOpError(
      () => backdateOpen([seg('a', 'A', at(0), at(10))], { startedAt: at(5) }, makeCtx(at(60))),
      'no_open_segment',
    );
    expectOpError(() => backdateOpen([], { startedAt: at(5) }, makeCtx(at(60))), 'no_open_segment');
  });

  it('rejects a start after now, even by a millisecond', () => {
    expectOpError(
      () => backdateOpen(fourInARow(), { startedAt: toIso(T0 + 60 * 60_000 + 1) }, makeCtx(at(60))),
      'in_future',
    );
  });

  it('is a no-op for the same start', () => {
    const { result } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(30) }, c),
    );
    expect(result.noop).toBe(true);
  });

  it('earlier into a gap leaves the previous segment alone', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'B', at(20), null)];
    const { after, result } = runOp(segs, makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(15) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 15-']);
    expect(result.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('earlier clears what was there', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(5) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-5', 'D 5-']);
    expect(row(result.rows, 'b').deletedAt).toBe(at(60));
    expect(row(result.rows, 'c').deletedAt).toBe(at(60));
    expect(row(result.rows, 'd').startedAt).toBe(at(5));
  });

  it('earlier to exactly a segment start deletes that segment', () => {
    const { after } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(10) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'D 10-']);
  });

  it('earlier deletes a segment left shorter than a second', () => {
    const { after } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(20, 0, 999) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'D 20+999ms-']);
  });

  it('later pulls a touching previous segment along', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(45) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-45', 'D 45-']);
    expect(result.rows.map((r) => r.id).sort()).toEqual(['c', 'd']);
  });

  it('later leaves an existing gap as a gap', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'B', at(20), null)];
    const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(30) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 30-']);
  });

  it('later up to exactly now is allowed', () => {
    const { after } = runOp(fourInARow(), makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(60) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-60', 'D 60-']);
  });

  it('works on the very first segment', () => {
    const segs = [seg('a', 'A', at(30), null)];
    const { after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      backdateOpen(s, { startedAt: at(0) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-']);
  });
});

describe('editSegment', () => {
  const now = at(60);

  it('moving the start later pulls the touching previous segment along', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(15) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-15', 'B 15-20', 'C 20-30', 'D 30-']);
    expect(result.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('moving the start earlier clears what was there', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(5) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-5', 'B 5-20', 'C 20-30', 'D 30-']);
  });

  it('moving the start earlier than the previous segment deletes it', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(-5) }, c),
    );
    expect(describeLive(after)).toEqual(['B -5-20', 'C 20-30', 'D 30-']);
    expect(row(result.rows, 'a').deletedAt).toBe(now);
  });

  it('moving the end earlier pulls the touching next segment along', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', endedAt: at(15) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-15', 'C 15-30', 'D 30-']);
  });

  it('moving the end later clears what was there', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', endedAt: at(25) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-25', 'C 25-30', 'D 30-']);
  });

  it('moving the end later past the open segment start moves the open start', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', endedAt: at(35) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-35', 'D 35-']);
    expect(row(result.rows, 'c').deletedAt).toBe(now);
  });

  it('moving the end up to now leaves the open segment starting at now', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', endedAt: now }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-60', 'D 60-']);
  });

  it('a pulled boundary does not reach across a gap', () => {
    const segs = [
      seg('a', 'A', at(0), at(5)),
      seg('b', 'B', at(10), at(20)),
      seg('c', 'C', at(25), null),
    ];
    const { after } = runOp(segs, makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(12), endedAt: at(18) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-5', 'B 12-18', 'C 25-']);
  });

  it('shrinking both ends pulls both neighbours along', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(12), endedAt: at(18) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-12', 'B 12-18', 'C 18-30', 'D 30-']);
  });

  it('moving a whole segment later never overlaps what was between', () => {
    // B moves from 10-20 to 25-28, past its old end. A takes the time B left,
    // C keeps its time except where B now sits.
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(25), endedAt: at(28) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-20', 'C 20-25', 'B 25-28', 'C 28-30', 'D 30-']);
  });

  it('moving a whole segment earlier never overlaps what was between', () => {
    // B moves from 10-20 to 2-5, before its old start. C takes the time B left.
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(2), endedAt: at(5) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-2', 'B 2-5', 'A 5-10', 'C 10-30', 'D 30-']);
  });

  it('moving the start later past the old end, with the next segment touching', () => {
    const segs = [
      seg('a', 'A', at(0), at(10)),
      seg('b', 'B', at(10), at(20)),
      seg('c', 'C', at(20), at(40)),
      seg('d', 'D', at(40), null),
    ];
    const { after } = runOp(segs, makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(30), endedAt: at(45) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-20', 'C 20-30', 'B 30-45', 'D 45-']);
  });

  it('deletes a neighbour left shorter than a second', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(0, 0, 500) }, c),
    );
    expect(describeLive(after)).toEqual(['B 0+500ms-20', 'C 20-30', 'D 30-']);
  });

  it('the open segment end cannot be set', () => {
    expectOpError(
      () => editSegment(fourInARow(), { id: 'd', endedAt: at(40) }, makeCtx(now)),
      'invalid_range',
    );
  });

  it('moving the open segment start later pulls the previous segment along', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'd', startedAt: at(40) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-40', 'D 40-']);
  });

  it('moving the open segment start earlier clears what was there', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'd', startedAt: at(15) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-15', 'D 15-']);
  });

  it('the open segment start may be moved to now but not after', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'd', startedAt: now }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-60', 'D 60-']);
    expectOpError(
      () => editSegment(fourInARow(), { id: 'd', startedAt: at(60, 0, 1) }, makeCtx(now)),
      'in_future',
    );
  });

  it('changes category and note without touching anything else', () => {
    const { result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', categoryId: 'D', note: '  lunch  ' }, c),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: 'b',
      categoryId: 'D',
      note: 'lunch',
      startedAt: at(10),
      endedAt: at(20),
      source: 'shortcut',
      createdAt: OLD,
    });
  });

  it('changes the open segment category', () => {
    const { result, after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'd', categoryId: 'A' }, c),
    );
    expect(result.rows.map((r) => r.id)).toEqual(['d']);
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-30', 'A 30-']);
  });

  it('a blank or null note clears it; an omitted note keeps it', () => {
    for (const note of ['', '   ', null]) {
      const { result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
        editSegment(s, { id: 'b', note }, c),
      );
      expect(row(result.rows, 'b').note).toBeNull();
    }
    const { result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(11) }, c),
    );
    expect(row(result.rows, 'b').note).toBe('b note');
  });

  it('is a no-op when nothing changes', () => {
    const { result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', startedAt: at(10), endedAt: at(20), note: 'b note' }, c),
    );
    expect(result.noop).toBe(true);
  });

  it('validates its input', () => {
    const segs = fourInARow();
    const ctx = makeCtx(now);
    expectOpError(() => editSegment(segs, { id: 'nope', categoryId: 'A' }, ctx), 'not_found');
    expectOpError(() => editSegment(segs, { id: 'b', endedAt: at(61) }, ctx), 'in_future');
    expectOpError(() => editSegment(segs, { id: 'b', endedAt: at(10) }, ctx), 'invalid_range');
    expectOpError(() => editSegment(segs, { id: 'b', endedAt: at(5) }, ctx), 'invalid_range');
    expectOpError(() => editSegment(segs, { id: 'b', startedAt: at(25) }, ctx), 'invalid_range');
    expectOpError(() => editSegment(segs, { id: 'b', endedAt: at(10, 0, 999) }, ctx), 'too_short');
    expectOpError(() => editSegment(segs, { id: 'b', startedAt: 'garbage' }, ctx), 'invalid_range');
  });

  it('a soft-deleted segment cannot be edited', () => {
    const segs = [...fourInARow(), seg('x', 'A', at(40), at(50), { deletedAt: OLD })];
    expectOpError(() => editSegment(segs, { id: 'x', categoryId: 'B' }, makeCtx(now)), 'not_found');
  });

  it('a one-second segment is allowed', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      editSegment(s, { id: 'b', endedAt: at(10, 1) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-10+1000ms', 'C 10+1000ms-30', 'D 30-']);
  });
});

describe('splitSegment', () => {
  const now = at(60);

  it('splits a closed segment', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      splitSegment(s, { id: 'b', at: at(15), secondCategoryId: 'C' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-15', 'C 15-20', 'C 20-30', 'D 30-']);
    expect(row(result.rows, 'b').note).toBe('b note');
    expect(row(result.rows, 'new-1')).toMatchObject({ note: null, source: 'edit', createdAt: now });
  });

  it('splits the open segment and keeps the second piece open', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      splitSegment(s, { id: 'd', at: at(40), secondCategoryId: 'A', secondId: 'second' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-30', 'D 30-40', 'A 40-']);
    expect(findOpen(after)?.id).toBe('second');
    expect(row(result.rows, 'd').endedAt).toBe(at(40));
  });

  it('the open segment may be split at now, leaving an empty open piece', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      splitSegment(s, { id: 'd', at: now, secondCategoryId: 'A' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-30', 'D 30-60', 'A 60-']);
  });

  it('both closed pieces must be at least a second', () => {
    const segs = fourInARow();
    const ctx = makeCtx(now);
    const split =
      (t: string, id = 'b') =>
      () =>
        splitSegment(segs, { id, at: t, secondCategoryId: 'C' }, ctx);
    expectOpError(split(at(10)), 'invalid_range');
    expectOpError(split(at(10, 0, 999)), 'invalid_range');
    expectOpError(split(at(19, 59, 1)), 'invalid_range');
    expectOpError(split(at(20)), 'invalid_range');
    expectOpError(split(at(25)), 'invalid_range');
    expectOpError(split(at(5)), 'invalid_range');
    expectOpError(split(at(60, 0, 1), 'd'), 'invalid_range');
    expectOpError(split(at(30, 0, 500), 'd'), 'invalid_range');
    expectOpError(split('garbage'), 'invalid_range');
    expectOpError(split(at(15), 'nope'), 'not_found');
    runOp(segs, ctx, (s, c) =>
      splitSegment(s, { id: 'b', at: at(10, 1), secondCategoryId: 'C' }, c),
    );
    runOp(segs, ctx, (s, c) =>
      splitSegment(s, { id: 'b', at: at(19, 59), secondCategoryId: 'C' }, c),
    );
  });
});

describe('insertSegment', () => {
  const now = at(60);

  it('fills a gap exactly without touching the neighbours', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('c', 'C', at(20), null)];
    const { after, result } = runOp(segs, makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'B', startedAt: at(10), endedAt: at(20) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ source: 'edit', note: null, createdAt: now });
  });

  it('clears over several segments', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'A', startedAt: at(5), endedAt: at(25) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-5', 'A 5-25', 'C 25-30', 'D 30-']);
    expect(row(result.rows, 'b').deletedAt).toBe(now);
  });

  it('splits a segment that contains the span', () => {
    const { after, result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'C', startedAt: at(12), endedAt: at(15), note: ' x ' }, c),
    );
    expect(describeLive(after)).toEqual([
      'A 0-10',
      'B 10-12',
      'C 12-15',
      'B 15-20',
      'C 20-30',
      'D 30-',
    ]);
    const tail = liveSorted(after).find((s) => s.startedAt === at(15));
    // The tail of the split keeps the original's note and source.
    expect(tail).toMatchObject({ categoryId: 'B', note: 'b note', source: 'shortcut' });
    expect(result.rows.find((r) => r.startedAt === at(12))?.note).toBe('x');
  });

  it('splits the open segment and the tail stays open', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'A', startedAt: at(40), endedAt: at(50) }, c),
    );
    expect(describeLive(after)).toEqual([
      'A 0-10',
      'B 10-20',
      'C 20-30',
      'D 30-40',
      'A 40-50',
      'D 50-',
    ]);
    expect(liveSorted(after).filter((s) => s.endedAt === null)).toHaveLength(1);
  });

  it('covering the open start up to now moves the open start to now', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'A', startedAt: at(25), endedAt: now }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 20-25', 'A 25-60', 'D 60-']);
  });

  it('before tracking began just adds the segment', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'B', startedAt: at(-30), endedAt: at(-20) }, c),
    );
    expect(describeLive(after)[0]).toBe('B -30--20');
  });

  it('deletes a neighbour left shorter than a second', () => {
    const { after } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'A', startedAt: at(10, 0, 500), endedAt: at(25) }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'A 10+500ms-25', 'C 25-30', 'D 30-']);
  });

  it('validates its input', () => {
    const segs = fourInARow();
    const ctx = makeCtx(now);
    const ins = (s: string, e: string) => () =>
      insertSegment(segs, { categoryId: 'A', startedAt: s, endedAt: e }, ctx);
    expectOpError(ins(at(50), at(60, 0, 1)), 'in_future');
    expectOpError(ins(at(50), at(50)), 'invalid_range');
    expectOpError(ins(at(50), at(40)), 'invalid_range');
    expectOpError(ins(at(50), at(50, 0, 999)), 'too_short');
    expectOpError(ins('garbage', at(50)), 'invalid_range');
    expectOpError(ins(at(40), 'garbage'), 'invalid_range');
  });

  it('uses the given id', () => {
    const { result } = runOp(fourInARow(), makeCtx(now), (s, c) =>
      insertSegment(s, { categoryId: 'A', startedAt: at(40), endedAt: at(41), id: 'mine' }, c),
    );
    expect(result.rows.map((r) => r.id)).toContain('mine');
  });
});

describe('deleteSegment', () => {
  const now = at(60);
  /** A 0-10, B 10-20, gap, C 25-30, D 30- (open). */
  function withGap(): Segment[] {
    return [
      seg('a', 'A', at(0), at(10)),
      seg('b', 'B', at(10), at(20)),
      seg('c', 'C', at(25), at(30)),
      seg('d', 'D', at(30), null),
    ];
  }

  it("fill 'none' leaves a gap", () => {
    const { after, result } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'b', fill: 'none' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'C 25-30', 'D 30-']);
    expect(result.rows).toEqual([{ ...withGap()[1], deletedAt: now, updatedAt: now }]);
  });

  it("fill 'prev' extends the previous segment", () => {
    const { after } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'b', fill: 'prev' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-20', 'C 25-30', 'D 30-']);
  });

  it("fill 'prev' across a gap extends the previous segment over the gap too", () => {
    const { after } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'c', fill: 'prev' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-30', 'D 30-']);
  });

  it("fill 'next' pulls the next segment back", () => {
    const { after } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'a', fill: 'next' }, c),
    );
    expect(describeLive(after)).toEqual(['B 0-20', 'C 25-30', 'D 30-']);
  });

  it("fill 'next' can pull the open segment back", () => {
    const { after } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'c', fill: 'next' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'D 25-']);
  });

  it('with nothing to fill from just deletes', () => {
    const { after: a1 } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'a', fill: 'prev' }, c),
    );
    expect(describeLive(a1)).toEqual(['B 10-20', 'C 25-30', 'D 30-']);
    const segs = [seg('a', 'A', at(0), at(10))];
    const { after: a2 } = runOp(segs, makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'a', fill: 'next' }, c),
    );
    expect(describeLive(a2)).toEqual([]);
  });

  it("the open segment needs fill 'prev'", () => {
    expectOpError(
      () => deleteSegment(withGap(), { id: 'd', fill: 'none' }, makeCtx(now)),
      'cannot_delete_open',
    );
    expectOpError(
      () => deleteSegment(withGap(), { id: 'd', fill: 'next' }, makeCtx(now)),
      'cannot_delete_open',
    );
  });

  it('deleting the open segment reopens the previous one', () => {
    const { after, result } = runOp(withGap(), makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'd', fill: 'prev' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-20', 'C 25-']);
    expect(row(result.rows, 'c').endedAt).toBeNull();
  });

  it('deleting the open segment reopens the previous one across a gap', () => {
    const segs = [seg('a', 'A', at(0), at(10)), seg('b', 'B', at(20), null)];
    const { after } = runOp(segs, makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'b', fill: 'prev' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-']);
  });

  it('the only segment cannot be deleted', () => {
    expectOpError(
      () => deleteSegment([seg('a', 'A', at(0), null)], { id: 'a', fill: 'prev' }, makeCtx(now)),
      'cannot_delete_open',
    );
  });

  it('unknown and soft-deleted ids are not found', () => {
    const segs = [...withGap(), seg('x', 'A', at(20), at(25), { deletedAt: OLD })];
    expectOpError(
      () => deleteSegment(segs, { id: 'nope', fill: 'none' }, makeCtx(now)),
      'not_found',
    );
    expectOpError(() => deleteSegment(segs, { id: 'x', fill: 'none' }, makeCtx(now)), 'not_found');
  });

  it('ignores soft-deleted rows when looking for a neighbour', () => {
    const segs = [...withGap(), seg('x', 'A', at(20), at(25), { deletedAt: OLD })];
    const { after, result } = runOp(segs, makeCtx(now), (s, c) =>
      deleteSegment(s, { id: 'c', fill: 'prev' }, c),
    );
    expect(describeLive(after)).toEqual(['A 0-10', 'B 10-30', 'D 30-']);
    expect(result.rows.map((r) => r.id)).not.toContain('x');
  });
});

describe('undoRows', () => {
  it('reverses a switch: the old open segment reopens and the new one is deleted', () => {
    const segs = [seg('a', 'A', at(0), null)];
    const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      switchCategory(s, { categoryId: 'B' }, c),
    );
    const undo = undoRows(segs, result.rows, at(61));
    expect(undo).toEqual(
      expect.arrayContaining([
        { ...segs[0], updatedAt: at(61) },
        { ...result.opened, deletedAt: at(61), updatedAt: at(61) },
      ]),
    );
    const restored = applyRows(after, undo);
    expect(describeLive(restored)).toEqual(['A 0-']);
  });

  it('reverses a delete', () => {
    const segs = fourInARow();
    const { result, after } = runOp(segs, makeCtx(at(60)), (s, c) =>
      deleteSegment(s, { id: 'b', fill: 'prev' }, c),
    );
    const restored = applyRows(after, undoRows(segs, result.rows, at(61)));
    expect(liveState(restored)).toEqual(liveState(segs));
    expect(restored.find((s) => s.id === 'b')?.deletedAt).toBeNull();
  });

  it('returns nothing for nothing', () => {
    expect(undoRows(fourInARow(), [], at(61))).toEqual([]);
  });
});

describe('applyRows', () => {
  it('replaces by id and appends new rows without mutating the input', () => {
    const segs = Object.freeze(fourInARow().map((s) => Object.freeze(s)));
    const changed = seg('b', 'X', at(10), at(20));
    const added = seg('e', 'E', at(70), null);
    const out = applyRows(segs, [changed, added]);
    expect(out).toHaveLength(5);
    expect(out.find((s) => s.id === 'b')).toBe(changed);
    expect(out.find((s) => s.id === 'e')).toBe(added);
    expect(segs[1]?.categoryId).toBe('B');
  });
});

describe('checkInvariants', () => {
  it('accepts an empty list and a valid timeline with touching segments', () => {
    expect(checkInvariants([])).toEqual([]);
    expect(checkInvariants(fourInARow())).toEqual([]);
  });

  it('detects two open segments (I1)', () => {
    const problems = checkInvariants([seg('a', 'A', at(0), null), seg('b', 'B', at(10), null)]);
    expect(problems.some((p) => p.startsWith('I1'))).toBe(true);
  });

  it('detects overlap (I2), including a long segment covering a later one', () => {
    expect(checkInvariants([seg('a', 'A', at(0), at(11)), seg('b', 'B', at(10), at(20))])).toEqual([
      'I2: a overlaps b',
    ]);
    const covering = checkInvariants([
      seg('a', 'A', at(0), at(100)),
      seg('b', 'B', at(10), at(20)),
      seg('c', 'C', at(30), at(40)),
    ]);
    expect(covering.length).toBeGreaterThan(0);
    expect(checkInvariants([seg('o', 'A', at(0), null), seg('b', 'B', at(10), at(20))])).toEqual([
      'I2: o overlaps b',
    ]);
  });

  it('detects segments that end before or when they start (I2)', () => {
    expect(checkInvariants([seg('a', 'A', at(10), at(5))])).toEqual([
      'I2: a ends before it starts',
    ]);
    expect(checkInvariants([seg('a', 'A', at(10), at(10))])).toEqual([
      'I2: a ends before it starts',
    ]);
  });

  it('detects closed segments under a second (I5), but not exactly a second', () => {
    expect(checkInvariants([seg('a', 'A', at(10), at(10, 0, 999))])).toEqual([
      'I5: a is shorter than a second',
    ]);
    expect(checkInvariants([seg('a', 'A', at(10), at(10, 1))])).toEqual([]);
  });

  it('ignores soft-deleted rows', () => {
    expect(
      checkInvariants([
        ...fourInARow(),
        seg('x', 'A', at(5), null, { deletedAt: OLD }),
        seg('y', 'A', at(5), at(5), { deletedAt: OLD }),
      ]),
    ).toEqual([]);
  });

  it('accepts an open segment that starts at now (zero length)', () => {
    expect(checkInvariants([seg('a', 'A', at(0), at(10)), seg('b', 'B', at(10), null)])).toEqual(
      [],
    );
  });
});
