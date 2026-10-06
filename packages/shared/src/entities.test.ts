import { describe, expect, it } from 'vitest';
import {
  categorySchema,
  hexColorSchema,
  hhmmSchema,
  isoSchema,
  isValidTimezone,
  ruleSchema,
  segmentSchema,
  settingsSchema,
  type Category,
  type Rule,
  type Segment,
} from './entities';
import { defaultSettings, SEED_CATEGORIES, SEED_RULES } from './seed';

const ID = '0199b6d2-3c4a-7def-8123-456789abcdef';
const CAT = '0199b6d2-3c4a-7def-8123-000000000001';
const T = '2026-10-02T03:15:00.000Z';

function firstOf<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error('empty');
  return x;
}

const category: Category = firstOf(SEED_CATEGORIES);
const rule: Rule = firstOf(SEED_RULES);
const segment: Segment = {
  id: ID,
  categoryId: CAT,
  startedAt: T,
  endedAt: '2026-10-02T04:15:00.000Z',
  note: null,
  source: 'app',
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
};

describe('isoSchema', () => {
  it('normalises to toISOString form', () => {
    expect(isoSchema.parse('2026-10-02T03:15:00Z')).toBe('2026-10-02T03:15:00.000Z');
    expect(isoSchema.parse('2026-10-02T03:15:00.5Z')).toBe('2026-10-02T03:15:00.500Z');
    expect(isoSchema.parse('2026-10-02T03:15:00.000Z')).toBe('2026-10-02T03:15:00.000Z');
  });

  it('rejects non-UTC offsets, bare dates and impossible dates', () => {
    for (const bad of [
      '2026-10-02T03:15:00+10:00',
      '2026-10-02',
      '2026-10-02 03:15:00Z',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-02T24:00:00Z',
      'not a date',
      '',
    ]) {
      expect(isoSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(isoSchema.safeParse(1234).success).toBe(false);
  });

  it('accepts 29 February only in a leap year', () => {
    expect(isoSchema.safeParse('2028-02-29T00:00:00Z').success).toBe(true);
    expect(isoSchema.safeParse('2026-02-29T00:00:00Z').success).toBe(false);
  });
});

describe('small schemas', () => {
  it('hhmmSchema', () => {
    for (const ok of ['00:00', '07:30', '23:59'])
      expect(hhmmSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['24:00', '7:30', '07:60', '0730', '07:30:00', '']) {
      expect(hhmmSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('hexColorSchema', () => {
    expect(hexColorSchema.safeParse('#e5484D').success).toBe(true);
    for (const bad of ['#fff', 'e5484d', '#e5484dff', '#GGGGGG', 'red', '']) {
      expect(hexColorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('isValidTimezone', () => {
    for (const tz of ['UTC', 'Australia/Sydney', 'America/New_York', 'Asia/Kolkata']) {
      expect(isValidTimezone(tz)).toBe(true);
    }
    for (const tz of ['Mars/Olympus_Mons', 'Australia/Sydny', 'not a zone']) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});

describe('categorySchema', () => {
  it('accepts a seed category unchanged', () => {
    expect(categorySchema.parse(category)).toEqual(category);
  });

  it('trims the name and rejects a blank or long one', () => {
    expect(categorySchema.parse({ ...category, name: '  Gym  ' }).name).toBe('Gym');
    expect(categorySchema.safeParse({ ...category, name: '   ' }).success).toBe(false);
    expect(categorySchema.safeParse({ ...category, name: 'x'.repeat(41) }).success).toBe(false);
  });

  it('rejects a bad colour, a non-UUID id and a bad timestamp', () => {
    expect(categorySchema.safeParse({ ...category, color: '#123' }).success).toBe(false);
    expect(categorySchema.safeParse({ ...category, id: 'sleep' }).success).toBe(false);
    expect(categorySchema.safeParse({ ...category, archivedAt: 'yesterday' }).success).toBe(false);
    expect(categorySchema.safeParse({ ...category, sortOrder: 1.5 }).success).toBe(false);
  });
});

describe('segmentSchema', () => {
  it('accepts closed and open segments', () => {
    expect(segmentSchema.parse(segment)).toEqual(segment);
    expect(segmentSchema.parse({ ...segment, endedAt: null }).endedAt).toBeNull();
  });

  it('rejects endedAt before or equal to startedAt', () => {
    expect(
      segmentSchema.safeParse({ ...segment, endedAt: '2026-10-02T03:14:59.999Z' }).success,
    ).toBe(false);
    expect(segmentSchema.safeParse({ ...segment, endedAt: T }).success).toBe(false);
  });

  it('compares times after normalising them', () => {
    // "…00Z" sorts after "…00.999Z" as text, but is earlier in time.
    const r = segmentSchema.safeParse({
      ...segment,
      startedAt: '2026-10-02T03:15:00.999Z',
      endedAt: '2026-10-02T03:15:00Z',
    });
    expect(r.success).toBe(false);
    const ok = segmentSchema.parse({
      ...segment,
      startedAt: '2026-10-02T03:15:00Z',
      endedAt: '2026-10-02T03:15:00.5Z',
    });
    expect(ok.endedAt).toBe('2026-10-02T03:15:00.500Z');
  });

  it('rejects non-UUID ids, an unknown source and a long note', () => {
    expect(segmentSchema.safeParse({ ...segment, id: 'seg-1' }).success).toBe(false);
    expect(segmentSchema.safeParse({ ...segment, categoryId: 'A' }).success).toBe(false);
    expect(segmentSchema.safeParse({ ...segment, source: 'siri' }).success).toBe(false);
    expect(segmentSchema.safeParse({ ...segment, note: 'x'.repeat(501) }).success).toBe(false);
    expect(segmentSchema.safeParse({ ...segment, note: 'x'.repeat(500) }).success).toBe(true);
  });
});

describe('ruleSchema', () => {
  it('accepts the seed rules unchanged', () => {
    for (const r of SEED_RULES) expect(ruleSchema.parse(r)).toEqual(r);
  });

  it('quiet hours must be both set or both null', () => {
    expect(ruleSchema.safeParse({ ...rule, quietStart: '22:00', quietEnd: '07:00' }).success).toBe(
      true,
    );
    expect(ruleSchema.safeParse({ ...rule, quietStart: '22:00', quietEnd: null }).success).toBe(
      false,
    );
    expect(ruleSchema.safeParse({ ...rule, quietStart: null, quietEnd: '07:00' }).success).toBe(
      false,
    );
  });

  it('thresholds and repeats are positive whole minutes up to a week', () => {
    for (const thresholdMin of [0, -1, 1.5, 7 * 24 * 60 + 1]) {
      expect(ruleSchema.safeParse({ ...rule, thresholdMin }).success, String(thresholdMin)).toBe(
        false,
      );
    }
    expect(ruleSchema.safeParse({ ...rule, repeatEveryMin: 0 }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...rule, repeatEveryMin: null }).success).toBe(true);
  });

  it('rejects an unknown kind and a long message', () => {
    expect(ruleSchema.safeParse({ ...rule, kind: 'stale' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...rule, message: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('settingsSchema', () => {
  it('accepts the defaults', () => {
    const s = defaultSettings('Australia/Sydney');
    expect(settingsSchema.parse(s)).toEqual(s);
  });

  it('rejects a bad timezone, dayStartHour out of range and a wrong id', () => {
    const s = defaultSettings('Australia/Sydney');
    expect(settingsSchema.safeParse({ ...s, timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
    for (const dayStartHour of [-1, 24, 4.5]) {
      expect(settingsSchema.safeParse({ ...s, dayStartHour }).success).toBe(false);
    }
    expect(settingsSchema.safeParse({ ...s, dayStartHour: 0 }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...s, dayStartHour: 23 }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...s, id: 'other' }).success).toBe(false);
  });

  it('stale quiet hours must be both set or both null', () => {
    const s = defaultSettings('UTC');
    expect(settingsSchema.safeParse({ ...s, staleQuietStart: '23:00' }).success).toBe(false);
    expect(
      settingsSchema.safeParse({ ...s, staleQuietStart: '23:00', staleQuietEnd: '06:00' }).success,
    ).toBe(true);
  });
});
