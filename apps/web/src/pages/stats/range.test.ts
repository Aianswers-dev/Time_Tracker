import { HOUR_MS, dayKeyOf } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  isDayKey,
  MAX_CUSTOM_DAYS,
  normaliseCustom,
  rangeBounds,
  rangeLabel,
  resolveRange,
} from './range';

const SYDNEY = { timezone: 'Australia/Sydney', dayStartHour: 4 };
const UTC = { timezone: 'UTC', dayStartHour: 0 };

describe('rangeBounds', () => {
  it('Today is the current logical day', () => {
    expect(rangeBounds('today', '2026-10-06')).toEqual(['2026-10-06', '2026-10-06']);
  });

  it('This week starts on Monday and runs to Sunday, future days included', () => {
    // 2026-10-06 is a Tuesday.
    expect(rangeBounds('week', '2026-10-06')).toEqual(['2026-10-05', '2026-10-11']);
    // On a Monday the week starts today; on a Sunday it started six days ago.
    expect(rangeBounds('week', '2026-10-05')).toEqual(['2026-10-05', '2026-10-11']);
    expect(rangeBounds('week', '2026-10-11')).toEqual(['2026-10-05', '2026-10-11']);
    // Across a month and a year boundary.
    expect(rangeBounds('week', '2027-01-01')).toEqual(['2026-12-28', '2027-01-03']);
  });

  it('Last 7 days ends today', () => {
    expect(rangeBounds('last7', '2026-10-06')).toEqual(['2026-09-30', '2026-10-06']);
  });

  it('This month is the whole calendar month', () => {
    expect(rangeBounds('month', '2026-10-06')).toEqual(['2026-10-01', '2026-10-31']);
    expect(rangeBounds('month', '2028-02-10')).toEqual(['2028-02-01', '2028-02-29']);
    expect(rangeBounds('month', '2026-02-28')).toEqual(['2026-02-01', '2026-02-28']);
  });

  it('Custom swaps reversed dates and keeps valid ones', () => {
    expect(rangeBounds('custom', '2026-10-06', { from: '2026-09-20', to: '2026-09-01' })).toEqual([
      '2026-09-01',
      '2026-09-20',
    ]);
  });
});

describe('normaliseCustom', () => {
  const today = '2026-10-06';

  it('falls back to the last 30 days when nothing valid is given', () => {
    expect(normaliseCustom({ from: null, to: null }, today)).toEqual(['2026-09-07', today]);
    expect(normaliseCustom({ from: 'nope', to: '2026-02-31' }, today)).toEqual([
      '2026-09-07',
      today,
    ]);
  });

  it('clamps the end to today', () => {
    expect(normaliseCustom({ from: '2026-10-01', to: '2026-12-25' }, today)).toEqual([
      '2026-10-01',
      today,
    ]);
    expect(normaliseCustom({ from: '2026-11-01', to: '2026-12-01' }, today)).toEqual([
      today,
      today,
    ]);
  });

  it('fills a missing bound', () => {
    expect(normaliseCustom({ from: '2026-09-15', to: null }, today)).toEqual(['2026-09-15', today]);
    expect(normaliseCustom({ from: null, to: '2026-09-15' }, today)).toEqual([
      '2026-09-15',
      '2026-09-15',
    ]);
  });

  it(`caps a custom range at ${MAX_CUSTOM_DAYS} days, keeping the end`, () => {
    const [from, to] = normaliseCustom({ from: '2020-01-01', to: '2026-10-06' }, today);
    expect(to).toBe(today);
    expect(resolveRange('custom', today, UTC, { from, to }).dayKeys).toHaveLength(MAX_CUSTOM_DAYS);
  });
});

describe('isDayKey', () => {
  it('accepts real calendar dates only', () => {
    expect(isDayKey('2026-10-06')).toBe(true);
    expect(isDayKey('2028-02-29')).toBe(true);
    expect(isDayKey('2026-02-29')).toBe(false);
    expect(isDayKey('2026-13-01')).toBe(false);
    expect(isDayKey('2026-1-1')).toBe(false);
    expect(isDayKey(null)).toBe(false);
  });
});

describe('resolveRange', () => {
  it('turns logical days into instants at the day start hour', () => {
    const r = resolveRange('today', '2026-07-01', SYDNEY);
    // Sydney is UTC+10 in July: 04:00 local is 18:00 UTC the day before.
    expect(new Date(r.start).toISOString()).toBe('2026-06-30T18:00:00.000Z');
    expect(r.end - r.start).toBe(24 * HOUR_MS);
    expect(r.dayKeys).toEqual(['2026-07-01']);
  });

  it('gives a week with a daylight saving start 167 hours', () => {
    // Sydney clocks go forward at 02:00 on Sunday 4 October 2026. That night
    // belongs to logical day Saturday 3 October, so the week of 28 September
    // is an hour short.
    const r = resolveRange('week', '2026-10-01', SYDNEY);
    expect(r.fromKey).toBe('2026-09-28');
    expect(r.toKey).toBe('2026-10-04');
    expect(r.end - r.start).toBe(167 * HOUR_MS);
    expect(dayKeyOf(r.start, SYDNEY)).toBe('2026-09-28');
    expect(dayKeyOf(r.end - 1, SYDNEY)).toBe('2026-10-04');
    expect(dayKeyOf(r.end, SYDNEY)).toBe('2026-10-05');
  });

  it('gives a month with a daylight saving end one hour longer', () => {
    // Clocks go back at 03:00 on Sunday 5 April 2026.
    const r = resolveRange('month', '2026-04-20', SYDNEY);
    expect(r.dayKeys).toHaveLength(30);
    expect(r.end - r.start).toBe((30 * 24 + 1) * HOUR_MS);
  });

  it('starts the day when the clocks jump if the start hour is skipped', () => {
    const r = resolveRange('today', '2026-10-04', {
      timezone: 'Australia/Sydney',
      dayStartHour: 2,
    });
    // 02:00 does not exist on 4 October; the day starts at 03:00 AEDT (16:00 UTC).
    expect(new Date(r.start).toISOString()).toBe('2026-10-03T16:00:00.000Z');
  });

  it('keys ranges by kind, days and day settings', () => {
    const a = resolveRange('last7', '2026-10-06', SYDNEY);
    const b = resolveRange('last7', '2026-10-06', { ...SYDNEY, dayStartHour: 5 });
    const c = resolveRange('week', '2026-10-06', SYDNEY);
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    expect(resolveRange('last7', '2026-10-06', SYDNEY).key).toBe(a.key);
  });
});

describe('rangeLabel', () => {
  it('names one day, a month, or a span', () => {
    expect(rangeLabel(resolveRange('today', '2026-10-06', UTC))).toMatch(/6/);
    expect(rangeLabel(resolveRange('month', '2026-10-06', UTC))).toMatch(/2026/);
    const span = rangeLabel(resolveRange('week', '2026-10-06', UTC));
    expect(span).toContain('–');
    expect(span).toMatch(/5/);
    expect(span).toMatch(/11/);
    const year = rangeLabel(
      resolveRange('custom', '2026-10-06', UTC, { from: '2025-10-07', to: '2026-10-06' }),
    );
    expect(year).toMatch(/2025.*–.*2026/);
  });
});
