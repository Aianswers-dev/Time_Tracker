import { describe, expect, it } from 'vitest';
import {
  describeQuiet,
  describeRule,
  describeStale,
  formatMinutes,
  joinNames,
  kindExplanation,
} from './describe';
import {
  draftToMinutes,
  durationToDraft,
  parseNudgeDraft,
  quietToDraft,
  repeatToDraft,
} from './draft';

describe('rule previews', () => {
  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(300)).toBe('5h');
  });

  it('describes session and daily rules in plain language', () => {
    expect(
      describeRule({ kind: 'session', thresholdMin: 60, repeatEveryMin: 30 }, 'Relaxing'),
    ).toBe('Nudges you after 1h of Relaxing in a row, then every 30m');
    expect(
      describeRule({ kind: 'session', thresholdMin: 90, repeatEveryMin: null }, 'Relaxing'),
    ).toBe('Nudges you once after 1h 30m of Relaxing in a row');
    expect(describeRule({ kind: 'daily', thresholdMin: 180, repeatEveryMin: 60 }, 'Relaxing')).toBe(
      'Nudges you when Relaxing reaches 3h in a day, then every 1h',
    );
    expect(describeRule({ kind: 'daily', thresholdMin: 45, repeatEveryMin: null }, 'Hobbies')).toBe(
      'Nudges you once when Hobbies reaches 45m in a day',
    );
  });

  it('describes the stale check', () => {
    const on = { staleEnabled: true, staleAfterMin: 300, staleRepeatMin: 60 };
    expect(describeStale(on, ['Sleep'])).toBe(
      'Asks “Still on it?” when anything except Sleep runs 5h without a switch, then every 1h',
    );
    expect(describeStale({ ...on, staleRepeatMin: null }, [])).toBe(
      'Asks “Still on it?” once when anything runs 5h without a switch',
    );
    expect(describeStale({ ...on, staleEnabled: false }, ['Sleep'])).toMatch(/^Off\./);
  });

  it('joins names and explains kinds and quiet hours', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Sleep'])).toBe('Sleep');
    expect(joinNames(['Sleep', 'Hobbies'])).toBe('Sleep and Hobbies');
    expect(joinNames(['Sleep', 'Uni study', 'Hobbies'])).toBe('Sleep, Uni study and Hobbies');
    expect(kindExplanation('daily', 4)).toMatch(/04:00/);
    expect(kindExplanation('session', 4)).toMatch(/unbroken/);
    expect(describeQuiet('22:00', '07:00')).toBe('Quiet 22:00–07:00');
    expect(describeQuiet(null, null)).toBeNull();
  });
});

describe('nudge drafts', () => {
  it('shows whole hours in hours and the rest in minutes', () => {
    expect(durationToDraft(120)).toEqual({ value: '2', unit: 'h' });
    expect(durationToDraft(90)).toEqual({ value: '90', unit: 'min' });
    expect(repeatToDraft(null)).toEqual({ once: true, every: '30' });
    expect(repeatToDraft(45)).toEqual({ once: false, every: '45' });
    expect(quietToDraft(null, null)).toEqual({ on: false, start: '22:00', end: '07:00' });
    expect(quietToDraft('23:00', '06:00')).toEqual({ on: true, start: '23:00', end: '06:00' });
  });

  it('converts typed durations to minutes', () => {
    expect(draftToMinutes({ value: '1.5', unit: 'h' })).toBe(90);
    expect(draftToMinutes({ value: '1,5', unit: 'h' })).toBe(90);
    expect(draftToMinutes({ value: ' 45 ', unit: 'min' })).toBe(45);
    expect(draftToMinutes({ value: '.5', unit: 'h' })).toBe(30);
    expect(draftToMinutes({ value: '2.5', unit: 'min' })).toBeNull();
    expect(draftToMinutes({ value: '', unit: 'min' })).toBeNull();
    expect(draftToMinutes({ value: 'abc', unit: 'h' })).toBeNull();
    expect(draftToMinutes({ value: '-5', unit: 'min' })).toBeNull();
    // Range checks belong to the shared schema, so 0 parses.
    expect(draftToMinutes({ value: '0', unit: 'min' })).toBe(0);
  });

  it('parses a whole form or names the inputs that are not numbers', () => {
    expect(
      parseNudgeDraft({
        threshold: { value: '1', unit: 'h' },
        repeat: { once: false, every: '30' },
        quiet: { on: true, start: '22:00', end: '07:00' },
      }),
    ).toEqual({
      ok: true,
      values: { thresholdMin: 60, repeatEveryMin: 30, quietStart: '22:00', quietEnd: '07:00' },
    });
    expect(
      parseNudgeDraft({
        threshold: { value: '20', unit: 'min' },
        repeat: { once: true, every: 'junk' },
        quiet: { on: false, start: '', end: '' },
      }),
    ).toEqual({
      ok: true,
      values: { thresholdMin: 20, repeatEveryMin: null, quietStart: null, quietEnd: null },
    });
    const bad = parseNudgeDraft({
      threshold: { value: 'x', unit: 'min' },
      repeat: { once: false, every: '' },
      quiet: { on: true, start: '22:00', end: '' },
    });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['quiet', 'repeat', 'threshold']);
  });
});
