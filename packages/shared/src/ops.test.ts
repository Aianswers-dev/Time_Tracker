import { describe, expect, it } from 'vitest';
import type { Segment } from './entities';
import { MAX_ROWS_PER_OP, opSchema } from './ops';
import { defaultSettings, SEED_CATEGORIES, SEED_RULES } from './seed';

const OP_ID = '0199b6d2-3c4a-7def-8123-456789abcdef';
const SEG_ID = '0199b6d2-3c4a-7def-8123-00000000aaaa';
const CREATED = '2026-10-02T03:15:00Z';

const category = SEED_CATEGORIES[0];
const rule = SEED_RULES[0];

const segment: Segment = {
  id: SEG_ID,
  categoryId: category?.id ?? '',
  startedAt: '2026-10-02T03:15:00.000Z',
  endedAt: null,
  note: null,
  source: 'app',
  createdAt: '2026-10-02T03:15:00.000Z',
  updatedAt: '2026-10-02T03:15:00.000Z',
  deletedAt: null,
};

const ops = {
  switch: {
    opId: OP_ID,
    createdAt: CREATED,
    type: 'switch',
    payload: {
      categoryId: category?.id,
      at: '2026-10-02T03:15:00Z',
      newSegmentId: SEG_ID,
      source: 'app',
    },
  },
  'segments.upsert': {
    opId: OP_ID,
    createdAt: CREATED,
    type: 'segments.upsert',
    payload: { rows: [segment] },
  },
  'category.upsert': {
    opId: OP_ID,
    createdAt: CREATED,
    type: 'category.upsert',
    payload: category,
  },
  'rule.upsert': { opId: OP_ID, createdAt: CREATED, type: 'rule.upsert', payload: rule },
  'settings.upsert': {
    opId: OP_ID,
    createdAt: CREATED,
    type: 'settings.upsert',
    payload: defaultSettings('Australia/Sydney'),
  },
};

describe('opSchema', () => {
  it('accepts and discriminates all five op types', () => {
    for (const [type, op] of Object.entries(ops)) {
      const parsed = opSchema.parse(op);
      expect(parsed.type).toBe(type);
      expect(parsed.createdAt).toBe('2026-10-02T03:15:00.000Z');
    }
    const sw = opSchema.parse(ops.switch);
    if (sw.type !== 'switch') throw new Error('not a switch');
    expect(sw.payload.at).toBe('2026-10-02T03:15:00.000Z');
  });

  it('validates the payload against the schema for its type', () => {
    expect(opSchema.safeParse({ ...ops['category.upsert'], payload: rule }).success).toBe(false);
    expect(opSchema.safeParse({ ...ops['rule.upsert'], payload: category }).success).toBe(false);
    expect(opSchema.safeParse({ ...ops.switch, type: 'segments.upsert' }).success).toBe(false);
  });

  it('rejects an unknown type, a bad op id and a missing switch field', () => {
    expect(opSchema.safeParse({ ...ops.switch, type: 'delete' }).success).toBe(false);
    expect(opSchema.safeParse({ ...ops.switch, opId: 'op-1' }).success).toBe(false);
    const { newSegmentId: _omit, ...payload } = ops.switch.payload;
    expect(opSchema.safeParse({ ...ops.switch, payload }).success).toBe(false);
  });

  it('segments.upsert takes 1 to MAX_ROWS_PER_OP valid rows', () => {
    const rows = (n: number) => Array.from({ length: n }, () => segment);
    const op = (r: unknown[]) => ({ ...ops['segments.upsert'], payload: { rows: r } });
    expect(opSchema.safeParse(op(rows(0))).success).toBe(false);
    expect(opSchema.safeParse(op(rows(MAX_ROWS_PER_OP))).success).toBe(true);
    expect(opSchema.safeParse(op(rows(MAX_ROWS_PER_OP + 1))).success).toBe(false);
    const backwards = { ...segment, endedAt: '2026-10-02T03:14:00.000Z' };
    expect(opSchema.safeParse(op([backwards])).success).toBe(false);
  });

  it('settings.upsert rejects a bad timezone', () => {
    const bad = { ...ops['settings.upsert'].payload, timezone: 'Nowhere/Special' };
    expect(opSchema.safeParse({ ...ops['settings.upsert'], payload: bad }).success).toBe(false);
  });
});
