import { HOUR_MS, MINUTE_MS, dayKeysInRange } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  barLayout,
  compactDuration,
  dayAxisLabels,
  durationTicks,
  formatShare,
  formatTick,
  heatLevel,
  indexAt,
  roundedTopRect,
} from './chartUtils';

describe('durationTicks', () => {
  it('covers a full day in 6 hour steps', () => {
    expect(durationTicks(24 * HOUR_MS)).toEqual({
      max: 24 * HOUR_MS,
      ticks: [0, 6, 12, 18, 24].map((x) => x * HOUR_MS),
    });
  });

  it('rounds up to a clean step and never has more than four intervals', () => {
    const { max, ticks } = durationTicks(4.5 * HOUR_MS);
    expect(max).toBe(6 * HOUR_MS);
    expect(ticks).toEqual([0, 2, 4, 6].map((x) => x * HOUR_MS));
    const small = durationTicks(25 * MINUTE_MS);
    expect(small.ticks.length - 1).toBeLessThanOrEqual(4);
    expect(small.max).toBeGreaterThanOrEqual(25 * MINUTE_MS);
  });

  it('has a sensible floor for an all-zero series', () => {
    const { max, ticks } = durationTicks(0);
    expect(max).toBeGreaterThan(0);
    expect(ticks[0]).toBe(0);
  });
});

describe('formatTick and formatShare', () => {
  it('formats axis durations compactly', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(45 * MINUTE_MS)).toBe('45m');
    expect(formatTick(2 * HOUR_MS)).toBe('2h');
    expect(formatTick(90 * MINUTE_MS)).toBe('1h30');
  });

  it('compacts tile durations from 100 hours up', () => {
    expect(compactDuration(52 * HOUR_MS + MINUTE_MS)).toBe('52h 1m');
    expect(compactDuration(99 * HOUR_MS + 59 * MINUTE_MS)).toBe('99h 59m');
    expect(compactDuration(509 * HOUR_MS + 51 * MINUTE_MS)).toBe('509h');
    expect(compactDuration(1419 * HOUR_MS)).toBe(`${(1419).toLocaleString()}h`);
  });

  it('never shows a non-zero share as 0%', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.001)).toBe('<1%');
    expect(formatShare(0.334)).toBe('33%');
    expect(formatShare(1)).toBe('100%');
  });
});

describe('dayAxisLabels', () => {
  it('labels every day of a week with weekday and date', () => {
    const labels = dayAxisLabels(dayKeysInRange('2026-10-05', '2026-10-11'), 300);
    expect(labels).toHaveLength(7);
    expect(labels[0]?.sub).toBe('5');
    expect(labels[6]?.sub).toBe('11');
    expect(labels.every((l) => l.text.length > 0)).toBe(true);
  });

  it('labels Mondays in a month, plus the first day when there is room', () => {
    const keys = dayKeysInRange('2026-10-01', '2026-10-31');
    const labels = dayAxisLabels(keys, 300);
    // 1 October 2026 is a Thursday; Mondays fall on the 5th, 12th, 19th and 26th.
    expect(labels.map((l) => l.index)).toEqual([0, 4, 11, 18, 25]);
    // Four slots (39 px) fit the date but not "1 Oct", so the month moves to the 5th.
    expect(labels[0]?.text).toBe('1');
    expect(labels[1]?.text).toMatch(/^5 /);
    expect(labels[2]?.text).toBe('12');
    // On a wider plot the first label carries the month itself.
    const wide = dayAxisLabels(keys, 400);
    expect(wide[0]?.text).toMatch(/^1 /);
    expect(wide[1]?.text).toBe('5');
  });

  it('labels month starts on long ranges', () => {
    const keys = dayKeysInRange('2025-10-07', '2026-10-06');
    const labels = dayAxisLabels(keys, 300);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.length).toBeLessThanOrEqual(12);
    for (const l of labels) expect(keys[l.index]?.endsWith('-01')).toBe(true);
  });
});

describe('barLayout', () => {
  it('caps bars at 24 px and always leaves at least a 2 px gap', () => {
    for (const n of [1, 7, 31, 90, 366]) {
      const { slot, bar } = barLayout(n, 300);
      expect(bar).toBeLessThanOrEqual(24);
      expect(bar).toBeGreaterThanOrEqual(1);
      if (n > 1 && slot > 3) expect(slot - bar).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('roundedTopRect', () => {
  it('rounds the top corners only and clamps the radius to the bar', () => {
    const d = roundedTopRect(10, 20, 8, 30, 4);
    expect(d.startsWith('M10,50')).toBe(true);
    expect(d).toContain('Q10,20 14,20');
    expect(d.endsWith('V50Z')).toBe(true);
    // A 2 px tall segment gets at most a 2 px radius.
    expect(roundedTopRect(0, 0, 8, 2, 4)).toContain('Q0,0 2,0');
  });
});

describe('heatLevel', () => {
  it('maps minutes a day in an hour to six steps', () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.5)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(15)).toBe(2);
    expect(heatLevel(25)).toBe(3);
    expect(heatLevel(40)).toBe(4);
    expect(heatLevel(60)).toBe(5);
  });
});

describe('indexAt', () => {
  it('maps a pointer x to a slot, clamped to the ends', () => {
    expect(indexAt(-5, 300, 7)).toBe(0);
    expect(indexAt(0, 300, 7)).toBe(0);
    expect(indexAt(150, 300, 7)).toBe(3);
    expect(indexAt(299, 300, 7)).toBe(6);
    expect(indexAt(500, 300, 7)).toBe(6);
  });
});
