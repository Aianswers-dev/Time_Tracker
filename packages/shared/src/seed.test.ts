import { describe, expect, it } from 'vitest';
import { categorySchema, hexColorSchema, ruleSchema, settingsSchema } from './entities';
import {
  CATEGORY_ICONS,
  CATEGORY_PALETTE,
  defaultSettings,
  SEED_CATEGORIES,
  SEED_CATEGORY_IDS,
  SEED_RULE_IDS,
  SEED_RULES,
  SEED_TIMESTAMP,
} from './seed';

describe('seed data', () => {
  it('every seed category parses with its schema, unchanged', () => {
    for (const c of SEED_CATEGORIES) expect(categorySchema.parse(c)).toEqual(c);
  });

  it('every seed rule parses with its schema, unchanged', () => {
    for (const r of SEED_RULES) expect(ruleSchema.parse(r)).toEqual(r);
  });

  it('defaultSettings parses and matches the documented defaults', () => {
    const s = defaultSettings('Australia/Sydney');
    expect(settingsSchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({
      id: 'singleton',
      timezone: 'Australia/Sydney',
      dayStartHour: 4,
      staleEnabled: true,
      staleAfterMin: 300,
      staleRepeatMin: 60,
      staleQuietStart: null,
      staleQuietEnd: null,
    });
  });

  it('ids are unique across categories and rules', () => {
    const ids = [...SEED_CATEGORIES.map((c) => c.id), ...SEED_RULES.map((r) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(SEED_CATEGORIES.map((c) => c.id)).toEqual(Object.values(SEED_CATEGORY_IDS));
    expect(SEED_RULES.map((r) => r.id)).toEqual(Object.values(SEED_RULE_IDS));
  });

  it('categories are seeded in the documented order, Sleep exempt from the stale check', () => {
    expect(SEED_CATEGORIES.map((c) => c.name)).toEqual([
      'Sleep',
      'Relaxing',
      'Housework',
      'Casual work',
      'Contract work',
      'Uni study',
      'Life admin',
      'Travel / commute',
      'Socialising',
      'Hobbies',
    ]);
    expect(SEED_CATEGORIES.map((c) => c.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(SEED_CATEGORIES.filter((c) => c.exemptFromStaleCheck).map((c) => c.name)).toEqual([
      'Sleep',
    ]);
    for (const c of SEED_CATEGORIES) {
      expect(c).toMatchObject({
        archivedAt: null,
        deletedAt: null,
        createdAt: SEED_TIMESTAMP,
        updatedAt: SEED_TIMESTAMP,
      });
    }
  });

  it('seed colours come from the palette, distinct, in palette order', () => {
    expect(SEED_CATEGORIES.map((c) => c.color)).toEqual(CATEGORY_PALETTE.slice(0, 10));
    for (const c of SEED_CATEGORIES) expect(CATEGORY_PALETTE).toContain(c.color);
  });

  it('the palette is valid, distinct hex', () => {
    for (const hex of CATEGORY_PALETTE)
      expect(hexColorSchema.safeParse(hex).success, hex).toBe(true);
    const lower = CATEGORY_PALETTE.map((h) => h.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(CATEGORY_PALETTE.length).toBeGreaterThan(SEED_CATEGORIES.length);
  });

  it('seed icons are in CATEGORY_ICONS, which holds distinct kebab-case names', () => {
    for (const c of SEED_CATEGORIES) expect(CATEGORY_ICONS).toContain(c.icon);
    expect(new Set(CATEGORY_ICONS).size).toBe(CATEGORY_ICONS.length);
    for (const icon of CATEGORY_ICONS) expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // Seed icons come first so the editor shows them at the top.
    expect(CATEGORY_ICONS.slice(0, SEED_CATEGORIES.length)).toEqual(
      SEED_CATEGORIES.map((c) => c.icon),
    );
  });

  it('seed rules are the documented Relaxing nudges', () => {
    const relaxing = SEED_CATEGORY_IDS.relaxing;
    expect(SEED_RULES.map((r) => [r.categoryId, r.kind, r.thresholdMin, r.repeatEveryMin])).toEqual(
      [
        [relaxing, 'session', 60, 30],
        [relaxing, 'daily', 180, 60],
      ],
    );
    for (const r of SEED_RULES) {
      expect(r).toMatchObject({ enabled: true, quietStart: null, quietEnd: null, message: null });
    }
  });
});
