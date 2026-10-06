import { afterEach, describe, it, expect } from 'vitest';
import {
  addDaysToKey,
  dayKeyOf,
  dayKeysInRange,
  dayKeysRange,
  dayRange,
  formatClock,
  formatDuration,
  HOUR_MS,
  isInQuietWindow,
  localDate,
  localDateTimeToMs,
  localHHMM,
  localHour,
  monthEndKey,
  monthStartKey,
  splitByDay,
  toIso,
  toMs,
  weekdayOfKey,
  weekStartKey,
  wholeMinutes,
} from './time';
import type { DaySettings } from './time';

/** Node's process, for the runtime timezone. Declared here because this package has no Node types. */
declare const process: { env: Record<string, string | undefined> };

describe('dayKeyOf', () => {
  describe('basic timezone and dayStartHour behavior', () => {
    it('Australia/Sydney dayStartHour 4: 03:59:59 local belongs to previous day', () => {
      const settings: DaySettings = {
        timezone: 'Australia/Sydney',
        dayStartHour: 4,
      };
      // Before Oct 4 transition: AEST (UTC+10)
      // 2026-10-02 03:59:59 AEST (UTC+10) = 2026-10-01 17:59:59 UTC
      const time = '2026-10-01T17:59:59.000Z';
      expect(dayKeyOf(time, settings)).toBe('2026-10-01');
    });

    it('Australia/Sydney dayStartHour 4: 04:00:00 local belongs to same day', () => {
      const settings: DaySettings = {
        timezone: 'Australia/Sydney',
        dayStartHour: 4,
      };
      // Before Oct 4 transition: AEST (UTC+10)
      // 2026-10-02 04:00:00 AEST (UTC+10) = 2026-10-01 18:00:00 UTC
      const time = '2026-10-01T18:00:00.000Z';
      expect(dayKeyOf(time, settings)).toBe('2026-10-02');
    });

    it('Australia/Sydney dayStartHour 4: 23:30 local belongs to same day', () => {
      const settings: DaySettings = {
        timezone: 'Australia/Sydney',
        dayStartHour: 4,
      };
      // Before Oct 4 transition: AEST (UTC+10)
      // 2026-10-02 23:30:00 AEST (UTC+10) = 2026-10-02 13:30:00 UTC
      const time = '2026-10-02T13:30:00.000Z';
      expect(dayKeyOf(time, settings)).toBe('2026-10-02');
    });

    it('Australia/Sydney dayStartHour 4: 01:00 local belongs to previous day', () => {
      const settings: DaySettings = {
        timezone: 'Australia/Sydney',
        dayStartHour: 4,
      };
      // Before Oct 4 transition: AEST (UTC+10)
      // 2026-10-02 01:00:00 AEST (UTC+10) = 2026-10-01 15:00:00 UTC
      const time = '2026-10-01T15:00:00.000Z';
      expect(dayKeyOf(time, settings)).toBe('2026-10-01');
    });
  });

  describe('dayStartHour 0 returns plain local calendar date', () => {
    it('UTC timezone with dayStartHour 0', () => {
      const settings: DaySettings = {
        timezone: 'UTC',
        dayStartHour: 0,
      };
      // UTC times map directly to calendar dates
      expect(dayKeyOf('2026-10-02T00:00:00.000Z', settings)).toBe('2026-10-02');
      expect(dayKeyOf('2026-10-02T12:00:00.000Z', settings)).toBe('2026-10-02');
      expect(dayKeyOf('2026-10-02T23:59:59.000Z', settings)).toBe('2026-10-02');
    });

    it('America/New_York with dayStartHour 0', () => {
      const settings: DaySettings = {
        timezone: 'America/New_York',
        dayStartHour: 0,
      };
      // 2026-10-02 00:00:00 EDT (UTC-4) = 2026-10-02 04:00:00 UTC
      expect(dayKeyOf('2026-10-02T04:00:00.000Z', settings)).toBe('2026-10-02');
      // 2026-10-02 23:59:59 EDT (UTC-4) = 2026-10-03 03:59:59 UTC
      expect(dayKeyOf('2026-10-03T03:59:59.000Z', settings)).toBe('2026-10-02');
    });
  });

  describe('accepts both ISO string and Date', () => {
    const settings: DaySettings = {
      timezone: 'America/New_York',
      dayStartHour: 4,
    };

    it('ISO string and Date give same result', () => {
      const isoString = '2026-10-02T12:00:00.000Z';
      const date = new Date(isoString);

      const resultFromString = dayKeyOf(isoString, settings);
      const resultFromDate = dayKeyOf(date, settings);

      expect(resultFromString).toBe(resultFromDate);
    });

    it('multiple Date instances with same timestamp give same result', () => {
      const time = new Date('2026-10-02T12:00:00.000Z');
      const result1 = dayKeyOf(time, settings);
      const result2 = dayKeyOf(new Date(time.getTime()), settings);

      expect(result1).toBe(result2);
    });
  });

  describe('dayStartHour 23 edge case', () => {
    const settings: DaySettings = {
      timezone: 'America/New_York',
      dayStartHour: 23,
    };

    it('23:00:00 local belongs to same day', () => {
      // 2026-10-02 23:00:00 EDT (UTC-4) = 2026-10-03 03:00:00 UTC
      expect(dayKeyOf('2026-10-03T03:00:00.000Z', settings)).toBe('2026-10-02');
    });

    it('22:59:59 local belongs to previous day', () => {
      // 2026-10-02 22:59:59 EDT (UTC-4) = 2026-10-03 02:59:59 UTC
      expect(dayKeyOf('2026-10-03T02:59:59.000Z', settings)).toBe('2026-10-01');
    });

    it('23:59:59 local belongs to same day', () => {
      // 2026-10-02 23:59:59 EDT (UTC-4) = 2026-10-03 03:59:59 UTC
      expect(dayKeyOf('2026-10-03T03:59:59.000Z', settings)).toBe('2026-10-02');
    });
  });

  describe('daylight saving: America/New_York spring forward 2026-03-08', () => {
    const settings: DaySettings = {
      timezone: 'America/New_York',
      dayStartHour: 4,
    };

    it('03:59:59 EDT just before 04:00 after spring forward belongs to previous day', () => {
      // Transition: 02:00 EST (07:00 UTC) -> 03:00 EDT
      // 2026-03-08 03:59:59 EDT (UTC-4) = 2026-03-08 07:59:59 UTC
      // Since 03:59:59 < 4, belongs to 2026-03-07
      expect(dayKeyOf('2026-03-08T07:59:59.000Z', settings)).toBe('2026-03-07');
    });

    it('04:00:00 EDT after spring forward belongs to same day', () => {
      // 2026-03-08 04:00:00 EDT (UTC-4) = 2026-03-08 08:00:00 UTC
      // Since 04:00:00 >= 4, belongs to 2026-03-08
      expect(dayKeyOf('2026-03-08T08:00:00.000Z', settings)).toBe('2026-03-08');
    });

    it('just after the transition: 03:00 EDT belongs to previous day', () => {
      // The transition happens at 02:00 EST = 07:00 UTC, jumping to 03:00 EDT
      // 2026-03-08 03:00:00 EDT (UTC-4) = 2026-03-08 07:00:00 UTC
      // Since 03:00:00 < 4, belongs to 2026-03-07
      expect(dayKeyOf('2026-03-08T07:00:00.000Z', settings)).toBe('2026-03-07');
    });
  });

  describe('daylight saving: America/New_York fall back 2026-11-01', () => {
    const settings: DaySettings = {
      timezone: 'America/New_York',
      dayStartHour: 4,
    };

    it('01:30 EDT (first occurrence, before transition) belongs to previous day', () => {
      // 2026-11-01 01:30:00 EDT (UTC-4) = 2026-11-01 05:30:00 UTC
      // Since 01:30:00 < 4, belongs to 2026-10-31
      expect(dayKeyOf('2026-11-01T05:30:00.000Z', settings)).toBe('2026-10-31');
    });

    it('01:30 EST (second occurrence, after transition) belongs to previous day', () => {
      // The transition happens at 02:00 EDT = 06:00 UTC, falling back to 01:00 EST
      // 2026-11-01 01:30:00 EST (UTC-5) = 2026-11-01 06:30:00 UTC
      // Since 01:30:00 < 4, belongs to 2026-10-31
      expect(dayKeyOf('2026-11-01T06:30:00.000Z', settings)).toBe('2026-10-31');
    });

    it('04:00 EST after fall back belongs to same day', () => {
      // 2026-11-01 04:00:00 EST (UTC-5) = 2026-11-01 09:00:00 UTC
      // Since 04:00:00 >= 4, belongs to 2026-11-01
      expect(dayKeyOf('2026-11-01T09:00:00.000Z', settings)).toBe('2026-11-01');
    });

    it('both instances of 01:30 on fall-back day belong to previous logical day', () => {
      const edt = '2026-11-01T05:30:00.000Z'; // 01:30 EDT
      const est = '2026-11-01T06:30:00.000Z'; // 01:30 EST
      expect(dayKeyOf(edt, settings)).toBe('2026-10-31');
      expect(dayKeyOf(est, settings)).toBe('2026-10-31');
    });
  });

  describe('daylight saving: Australia/Sydney spring forward 2026-10-04', () => {
    const settings: DaySettings = {
      timezone: 'Australia/Sydney',
      dayStartHour: 4,
    };

    it('03:59:59 AEDT just before 04:00 after spring forward belongs to previous day', () => {
      // Transition: 02:00 AEST (16:00 UTC) -> 03:00 AEDT
      // 2026-10-04 03:59:59 AEDT (UTC+11) = 2026-10-03 16:59:59 UTC
      // Since 03:59:59 < 4, belongs to 2026-10-03
      expect(dayKeyOf('2026-10-03T16:59:59.000Z', settings)).toBe('2026-10-03');
    });

    it('04:00:00 AEDT after spring forward belongs to same day', () => {
      // 2026-10-04 04:00:00 AEDT (UTC+11) = 2026-10-03 17:00:00 UTC
      // Since 04:00:00 >= 4, belongs to 2026-10-04
      expect(dayKeyOf('2026-10-03T17:00:00.000Z', settings)).toBe('2026-10-04');
    });

    it('just after the transition: 03:00 AEDT belongs to previous day', () => {
      // The transition happens at 02:00 AEST = 16:00 UTC, jumping to 03:00 AEDT
      // 2026-10-04 03:00:00 AEDT (UTC+11) = 2026-10-03 16:00:00 UTC
      // Since 03:00:00 < 4, belongs to 2026-10-03
      expect(dayKeyOf('2026-10-03T16:00:00.000Z', settings)).toBe('2026-10-03');
    });
  });

  describe('daylight saving: Australia/Sydney fall back 2026-04-05', () => {
    const settings: DaySettings = {
      timezone: 'Australia/Sydney',
      dayStartHour: 4,
    };

    it('02:30 AEDT (first occurrence, before transition) belongs to previous day', () => {
      // 2026-04-05 02:30:00 AEDT (UTC+11) = 2026-04-04 15:30:00 UTC
      // Since 02:30:00 < 4, belongs to 2026-04-04
      expect(dayKeyOf('2026-04-04T15:30:00.000Z', settings)).toBe('2026-04-04');
    });

    it('02:30 AEST (second occurrence, after transition) belongs to previous day', () => {
      // The transition happens at 03:00 AEDT = 16:00 UTC, falling back to 02:00 AEST
      // 2026-04-05 02:30:00 AEST (UTC+10) = 2026-04-04 16:30:00 UTC
      // Since 02:30:00 < 4, belongs to 2026-04-04
      expect(dayKeyOf('2026-04-04T16:30:00.000Z', settings)).toBe('2026-04-04');
    });

    it('04:00 AEST after fall back belongs to same day', () => {
      // 2026-04-05 04:00:00 AEST (UTC+10) = 2026-04-04 18:00:00 UTC
      // Since 04:00:00 >= 4, belongs to 2026-04-05
      expect(dayKeyOf('2026-04-04T18:00:00.000Z', settings)).toBe('2026-04-05');
    });

    it('both instances of 02:30 on fall-back day belong to previous logical day', () => {
      const aedt = '2026-04-04T15:30:00.000Z'; // 02:30 AEDT
      const aest = '2026-04-04T16:30:00.000Z'; // 02:30 AEST
      expect(dayKeyOf(aedt, settings)).toBe('2026-04-04');
      expect(dayKeyOf(aest, settings)).toBe('2026-04-04');
    });
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
const hours = (r: { start: number; end: number }) => (r.end - r.start) / HOUR_MS;

describe('dayKeyOf, more zones', () => {
  it('Asia/Kolkata half-hour offset', () => {
    const s: DaySettings = { timezone: 'Asia/Kolkata', dayStartHour: 4 };
    // 04:00 IST is 22:30 UTC the day before.
    expect(dayKeyOf('2026-10-05T22:29:59.999Z', s)).toBe('2026-10-05');
    expect(dayKeyOf('2026-10-05T22:30:00.000Z', s)).toBe('2026-10-06');
  });

  it('dayStartHour 0 at midnight and dayStartHour 23 just before midnight', () => {
    const utc0: DaySettings = { timezone: 'UTC', dayStartHour: 0 };
    expect(dayKeyOf('2026-12-31T23:59:59.999Z', utc0)).toBe('2026-12-31');
    expect(dayKeyOf('2027-01-01T00:00:00.000Z', utc0)).toBe('2027-01-01');
    const utc23: DaySettings = { timezone: 'UTC', dayStartHour: 23 };
    expect(dayKeyOf('2027-01-01T22:59:59.999Z', utc23)).toBe('2026-12-31');
    expect(dayKeyOf('2027-01-01T23:00:00.000Z', utc23)).toBe('2027-01-01');
  });

  it('crosses month and leap-day boundaries when stepping back a day', () => {
    const s: DaySettings = { timezone: 'UTC', dayStartHour: 4 };
    expect(dayKeyOf('2028-03-01T03:00:00.000Z', s)).toBe('2028-02-29');
    expect(dayKeyOf('2027-01-01T01:00:00.000Z', s)).toBe('2026-12-31');
  });

  it('accepts epoch milliseconds', () => {
    const s: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };
    expect(dayKeyOf(Date.parse('2026-10-01T18:00:00.000Z'), s)).toBe('2026-10-02');
  });

  it('a Santiago midnight after the clocks go back belongs to the right day', () => {
    // Santiago falls back from 00:00 to 23:00 on 2026-04-05. With a 01:00 day
    // start, 00:00 on 2026-04-06 still belongs to 2026-04-05.
    const s: DaySettings = { timezone: 'America/Santiago', dayStartHour: 1 };
    expect(dayKeyOf('2026-04-06T04:00:00.000Z', s)).toBe('2026-04-05');
  });
});

describe('dayRange', () => {
  it('a normal day is 24 hours from dayStartHour local', () => {
    const r = dayRange('2026-10-06', { timezone: 'Australia/Sydney', dayStartHour: 4 });
    expect(iso(r.start)).toBe('2026-10-05T17:00:00.000Z');
    expect(iso(r.end)).toBe('2026-10-06T17:00:00.000Z');
  });

  it('Asia/Kolkata starts on the half hour in UTC', () => {
    const r = dayRange('2026-10-06', { timezone: 'Asia/Kolkata', dayStartHour: 4 });
    expect(iso(r.start)).toBe('2026-10-05T22:30:00.000Z');
    expect(hours(r)).toBe(24);
  });

  it('dayStartHour 23', () => {
    const r = dayRange('2026-10-02', { timezone: 'America/New_York', dayStartHour: 23 });
    expect(iso(r.start)).toBe('2026-10-03T03:00:00.000Z');
    expect(iso(r.end)).toBe('2026-10-04T03:00:00.000Z');
  });

  it('crosses month and year ends', () => {
    const r = dayRange('2026-12-31', { timezone: 'UTC', dayStartHour: 0 });
    expect(iso(r.end)).toBe('2027-01-01T00:00:00.000Z');
    const leap = dayRange('2028-02-29', { timezone: 'UTC', dayStartHour: 4 });
    expect(iso(leap.start)).toBe('2028-02-29T04:00:00.000Z');
    expect(iso(leap.end)).toBe('2028-03-01T04:00:00.000Z');
  });

  it('Sydney spring forward 2026-10-04 makes a 23 hour day', () => {
    const midnight: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 0 };
    const r = dayRange('2026-10-04', midnight);
    expect(iso(r.start)).toBe('2026-10-03T14:00:00.000Z');
    expect(iso(r.end)).toBe('2026-10-04T13:00:00.000Z');
    expect(hours(r)).toBe(23);
    // With a 04:00 day start the short day is the logical day before.
    const four: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };
    expect(hours(dayRange('2026-10-03', four))).toBe(23);
    expect(hours(dayRange('2026-10-04', four))).toBe(24);
  });

  it('Sydney fall back 2027-04-04 makes a 25 hour day', () => {
    const midnight: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 0 };
    const r = dayRange('2027-04-04', midnight);
    expect(iso(r.start)).toBe('2027-04-03T13:00:00.000Z');
    expect(iso(r.end)).toBe('2027-04-04T14:00:00.000Z');
    expect(hours(r)).toBe(25);
    const four: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };
    expect(hours(dayRange('2027-04-03', four))).toBe(25);
    expect(hours(dayRange('2027-04-04', four))).toBe(24);
  });

  it('New York spring forward 2026-03-08 and fall back 2026-11-01', () => {
    const midnight: DaySettings = { timezone: 'America/New_York', dayStartHour: 0 };
    const spring = dayRange('2026-03-08', midnight);
    expect(iso(spring.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(spring.end)).toBe('2026-03-09T04:00:00.000Z');
    expect(hours(spring)).toBe(23);
    const fall = dayRange('2026-11-01', midnight);
    expect(iso(fall.start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(fall.end)).toBe('2026-11-02T05:00:00.000Z');
    expect(hours(fall)).toBe(25);
    const four: DaySettings = { timezone: 'America/New_York', dayStartHour: 4 };
    expect(hours(dayRange('2026-03-07', four))).toBe(23);
    expect(hours(dayRange('2026-10-31', four))).toBe(25);
  });

  it('a day start inside the skipped hour begins when the clocks jump', () => {
    const s: DaySettings = { timezone: 'America/New_York', dayStartHour: 2 };
    expect(iso(dayRange('2026-03-08', s).start)).toBe('2026-03-08T07:00:00.000Z');
    const syd: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 2 };
    expect(iso(dayRange('2026-10-04', syd).start)).toBe('2026-10-03T16:00:00.000Z');
  });

  it('a day start inside the repeated hour begins at its first occurrence', () => {
    // Sydney falls back from 03:00 AEDT to 02:00 AEST, so 02:00 happens twice.
    const syd: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 2 };
    const r = dayRange('2026-04-05', syd);
    expect(iso(r.start)).toBe('2026-04-04T15:00:00.000Z');
    expect(dayKeyOf(r.start - 1, syd)).toBe('2026-04-04');
    expect(iso(dayRange('2026-04-04', syd).end)).toBe('2026-04-04T15:00:00.000Z');
    // New York falls back from 02:00 EDT to 01:00 EST.
    const ny: DaySettings = { timezone: 'America/New_York', dayStartHour: 1 };
    expect(iso(dayRange('2026-11-01', ny).start)).toBe('2026-11-01T05:00:00.000Z');
    // London falls back from 02:00 BST to 01:00 GMT.
    const lon: DaySettings = { timezone: 'Europe/London', dayStartHour: 1 };
    expect(iso(dayRange('2026-10-25', lon).start)).toBe('2026-10-25T00:00:00.000Z');
  });

  it('agrees with dayKeyOf at every boundary, in every zone, for every dayStartHour', () => {
    const zones = [
      'Australia/Sydney',
      'America/New_York',
      'Asia/Kolkata',
      'Europe/London',
      'America/Santiago',
      'Australia/Lord_Howe',
      'Pacific/Auckland',
      'UTC',
    ];
    // Days around each zone's 2026 and 2027 clock changes.
    const pivots = [
      '2026-03-08',
      '2026-03-29',
      '2026-04-05',
      '2026-09-06',
      '2026-09-27',
      '2026-10-04',
      '2026-10-25',
      '2026-11-01',
      '2027-04-04',
    ];
    const problems: string[] = [];
    for (const timezone of zones) {
      for (let dayStartHour = 0; dayStartHour < 24; dayStartHour++) {
        const s: DaySettings = { timezone, dayStartHour };
        for (const pivot of pivots) {
          for (
            let k = addDaysToKey(pivot, -1);
            k <= addDaysToKey(pivot, 1);
            k = addDaysToKey(k, 1)
          ) {
            const r = dayRange(k, s);
            const prev = addDaysToKey(k, -1);
            if (
              dayKeyOf(r.start, s) !== k ||
              dayKeyOf(r.start - 1, s) !== prev ||
              dayKeyOf(r.end - 1, s) !== k ||
              dayRange(prev, s).end !== r.start ||
              hours(r) < 22 ||
              hours(r) > 26
            ) {
              problems.push(`${timezone} h${dayStartHour} ${k} ${iso(r.start)}..${iso(r.end)}`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('results do not depend on the runtime timezone', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  function compute() {
    return {
      sydRange: dayRange('2026-04-05', { timezone: 'Australia/Sydney', dayStartHour: 2 }),
      sclRange: dayRange('2026-04-05', { timezone: 'America/Santiago', dayStartHour: 0 }),
      sclKey: dayKeyOf('2026-04-06T04:00:00.000Z', {
        timezone: 'America/Santiago',
        dayStartHour: 1,
      }),
      sydLocal: localDateTimeToMs('2026-04-05', '02:30', 'Australia/Sydney'),
      nyLocal: localDateTimeToMs('2026-11-01', '01:30', 'America/New_York'),
      nyGap: localDateTimeToMs('2026-03-08', '02:30', 'America/New_York'),
    };
  }

  it('matches what a UTC server computes when run on a phone in Sydney or New York', () => {
    process.env.TZ = 'UTC';
    const server = compute();
    expect(server.sclKey).toBe('2026-04-05');
    expect(iso(server.sclRange.start)).toBe('2026-04-05T04:00:00.000Z');
    for (const tz of ['Australia/Sydney', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      expect(compute(), `runtime TZ ${tz}`).toEqual(server);
    }
  });
});

describe('addDaysToKey', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToKey('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDaysToKey('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDaysToKey('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDaysToKey('2028-02-29', 366)).toBe('2029-03-01');
    expect(addDaysToKey('2026-10-06', 0)).toBe('2026-10-06');
  });

  it('is not affected by daylight saving', () => {
    expect(addDaysToKey('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDaysToKey('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('rejects a malformed key', () => {
    expect(() => addDaysToKey('2026-1-1', 1)).toThrow();
    expect(() => addDaysToKey('nope', 1)).toThrow();
  });
});

describe('dayKeysInRange', () => {
  it('is inclusive at both ends', () => {
    expect(dayKeysInRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(dayKeysInRange('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
    expect(dayKeysInRange('2028-02-28', '2028-03-01')).toHaveLength(3);
  });

  it('a single day and an inverted range', () => {
    expect(dayKeysInRange('2026-10-06', '2026-10-06')).toEqual(['2026-10-06']);
    expect(dayKeysInRange('2026-10-07', '2026-10-06')).toEqual([]);
  });
});

describe('dayKeysRange', () => {
  it('spans from the first day start to the last day end', () => {
    const s: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };
    const r = dayKeysRange('2026-10-03', '2026-10-04', s);
    expect(r.start).toBe(dayRange('2026-10-03', s).start);
    expect(r.end).toBe(dayRange('2026-10-04', s).end);
    expect(hours(r)).toBe(47);
  });
});

describe('weeks and months', () => {
  it('weeks start on Monday', () => {
    expect(weekdayOfKey('2026-10-05')).toBe(0);
    expect(weekdayOfKey('2026-10-11')).toBe(6);
    expect(weekStartKey('2026-10-05')).toBe('2026-10-05');
    expect(weekStartKey('2026-10-06')).toBe('2026-10-05');
    expect(weekStartKey('2026-10-11')).toBe('2026-10-05');
    expect(weekStartKey('2026-10-12')).toBe('2026-10-12');
    expect(weekStartKey('2027-01-01')).toBe('2026-12-28');
    expect(weekStartKey('2028-03-01')).toBe('2028-02-28');
  });

  it('month start and end', () => {
    expect(monthStartKey('2026-02-15')).toBe('2026-02-01');
    expect(monthEndKey('2026-02-15')).toBe('2026-02-28');
    expect(monthEndKey('2028-02-01')).toBe('2028-02-29');
    expect(monthEndKey('2026-12-31')).toBe('2026-12-31');
    expect(monthStartKey('2026-12-31')).toBe('2026-12-01');
    expect(monthEndKey('2026-04-01')).toBe('2026-04-30');
    expect(monthEndKey('2026-01-31')).toBe('2026-01-31');
  });
});

describe('splitByDay', () => {
  const syd: DaySettings = { timezone: 'Australia/Sydney', dayStartHour: 4 };

  it('returns nothing for an empty or inverted span', () => {
    const t = Date.parse('2026-10-06T00:00:00.000Z');
    expect(splitByDay(t, t, syd)).toEqual([]);
    expect(splitByDay(t, t - 1, syd)).toEqual([]);
  });

  it('splits at dayStartHour', () => {
    // 02:00 to 06:00 AEDT on 2026-10-06.
    const pieces = splitByDay(
      Date.parse('2026-10-05T15:00:00.000Z'),
      Date.parse('2026-10-05T19:00:00.000Z'),
      syd,
    );
    expect(pieces.map((p) => [p.dayKey, iso(p.start), iso(p.end)])).toEqual([
      ['2026-10-05', '2026-10-05T15:00:00.000Z', '2026-10-05T17:00:00.000Z'],
      ['2026-10-06', '2026-10-05T17:00:00.000Z', '2026-10-05T19:00:00.000Z'],
    ]);
  });

  it('a span ending exactly at a day start stays in one day', () => {
    const r = dayRange('2026-10-06', syd);
    expect(splitByDay(r.start - HOUR_MS, r.start, syd)).toEqual([
      { dayKey: '2026-10-05', start: r.start - HOUR_MS, end: r.start },
    ]);
  });

  it('pieces are contiguous, sum to the span and match dayKeyOf, across clock changes', () => {
    const cases: Array<[DaySettings, string, string]> = [
      [syd, '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z'],
      [
        { timezone: 'Australia/Sydney', dayStartHour: 2 },
        '2026-04-02T00:00:00.000Z',
        '2026-04-08T00:00:00.000Z',
      ],
      [
        { timezone: 'America/New_York', dayStartHour: 0 },
        '2026-10-30T00:00:00.000Z',
        '2026-11-03T00:00:00.000Z',
      ],
      [
        { timezone: 'America/New_York', dayStartHour: 1 },
        '2026-10-30T00:00:00.000Z',
        '2026-11-03T00:00:00.000Z',
      ],
      [
        { timezone: 'Asia/Kolkata', dayStartHour: 23 },
        '2026-10-01T00:00:00.000Z',
        '2026-10-04T00:00:00.000Z',
      ],
    ];
    for (const [s, from, to] of cases) {
      const start = Date.parse(from);
      const end = Date.parse(to) + 1234;
      const pieces = splitByDay(start, end, s);
      expect(pieces[0]?.start).toBe(start);
      expect(pieces[pieces.length - 1]?.end).toBe(end);
      let total = 0;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (!p) continue;
        total += p.end - p.start;
        expect(p.end).toBeGreaterThan(p.start);
        if (i > 0) expect(p.start).toBe(pieces[i - 1]?.end);
        expect(dayKeyOf(p.start, s)).toBe(p.dayKey);
        expect(dayKeyOf(p.end - 1, s)).toBe(p.dayKey);
        const r = dayRange(p.dayKey, s);
        expect(p.start).toBeGreaterThanOrEqual(r.start);
        expect(p.end).toBeLessThanOrEqual(r.end);
      }
      expect(total).toBe(end - start);
      expect(new Set(pieces.map((p) => p.dayKey)).size).toBe(pieces.length);
    }
  });
});

describe('local wall-clock helpers', () => {
  it('localDateTimeToMs round-trips through localDate and localHHMM', () => {
    const zones = ['Australia/Sydney', 'America/New_York', 'Asia/Kolkata', 'UTC'];
    const dates = [
      '2026-01-15',
      '2026-03-08',
      '2026-04-05',
      '2026-10-04',
      '2026-11-01',
      '2028-02-29',
    ];
    const times = ['00:00', '01:30', '04:00', '12:34', '23:59'];
    for (const tz of zones) {
      for (const d of dates) {
        for (const t of times) {
          const ms = localDateTimeToMs(d, t, tz);
          expect(localDate(ms, tz), `${tz} ${d} ${t}`).toBe(d);
          expect(localHHMM(ms, tz), `${tz} ${d} ${t}`).toBe(t);
          expect(localHour(ms, tz)).toBe(Number(t.slice(0, 2)));
        }
      }
    }
  });

  it('accepts seconds', () => {
    expect(iso(localDateTimeToMs('2026-10-06', '04:05:06', 'Asia/Kolkata'))).toBe(
      '2026-10-05T22:35:06.000Z',
    );
  });

  it('a repeated time resolves to its first occurrence', () => {
    expect(iso(localDateTimeToMs('2026-04-05', '02:30', 'Australia/Sydney'))).toBe(
      '2026-04-04T15:30:00.000Z',
    );
    expect(iso(localDateTimeToMs('2026-11-01', '01:30', 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('a skipped time moves forward by the gap', () => {
    const ms = localDateTimeToMs('2026-03-08', '02:30', 'America/New_York');
    expect(iso(ms)).toBe('2026-03-08T07:30:00.000Z');
    expect(localHHMM(ms, 'America/New_York')).toBe('03:30');
    const syd = localDateTimeToMs('2026-10-04', '02:15', 'Australia/Sydney');
    expect(localHHMM(syd, 'Australia/Sydney')).toBe('03:15');
  });

  it('rejects malformed input', () => {
    expect(() => localDateTimeToMs('2026-10-06', '4:00', 'UTC')).toThrow();
    expect(() => localDateTimeToMs('06/10/2026', '04:00', 'UTC')).toThrow();
    expect(() => localDateTimeToMs('2026-10-06', '04:00', 'Not/AZone')).toThrow();
  });

  it('localHHMM and localHour in a half-hour zone', () => {
    expect(localHHMM('2026-10-05T22:29:00.000Z', 'Asia/Kolkata')).toBe('03:59');
    expect(localHour('2026-10-05T22:30:00.000Z', 'Asia/Kolkata')).toBe(4);
  });
});

describe('isInQuietWindow', () => {
  it('a window within one day is [start, end)', () => {
    expect(isInQuietWindow('11:59', '12:00', '14:00')).toBe(false);
    expect(isInQuietWindow('12:00', '12:00', '14:00')).toBe(true);
    expect(isInQuietWindow('13:59', '12:00', '14:00')).toBe(true);
    expect(isInQuietWindow('14:00', '12:00', '14:00')).toBe(false);
  });

  it('a window crossing midnight', () => {
    expect(isInQuietWindow('21:59', '22:00', '07:00')).toBe(false);
    expect(isInQuietWindow('22:00', '22:00', '07:00')).toBe(true);
    expect(isInQuietWindow('23:59', '22:00', '07:00')).toBe(true);
    expect(isInQuietWindow('00:00', '22:00', '07:00')).toBe(true);
    expect(isInQuietWindow('06:59', '22:00', '07:00')).toBe(true);
    expect(isInQuietWindow('07:00', '22:00', '07:00')).toBe(false);
    expect(isInQuietWindow('12:00', '22:00', '07:00')).toBe(false);
  });

  it('a window ending at midnight', () => {
    expect(isInQuietWindow('23:00', '22:00', '00:00')).toBe(true);
    expect(isInQuietWindow('00:00', '22:00', '00:00')).toBe(false);
  });

  it('equal start and end, or unset, is no window', () => {
    expect(isInQuietWindow('22:00', '22:00', '22:00')).toBe(false);
    expect(isInQuietWindow('03:00', '22:00', '22:00')).toBe(false);
    expect(isInQuietWindow('03:00', null, null)).toBe(false);
    expect(isInQuietWindow('03:00', '00:00', null)).toBe(false);
    expect(isInQuietWindow('03:00', null, '23:00')).toBe(false);
  });
});

describe('formatting', () => {
  it('formatDuration rounds down to whole minutes', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(59_999)).toBe('0m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(59 * 60_000 + 59_999)).toBe('59m');
    expect(formatDuration(HOUR_MS)).toBe('1h 0m');
    expect(formatDuration(72 * 60_000)).toBe('1h 12m');
    expect(formatDuration(25 * HOUR_MS)).toBe('25h 0m');
    expect(formatDuration(-5_000)).toBe('0m');
  });

  it('formatClock', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(999)).toBe('0:00:00');
    expect(formatClock(45_000)).toBe('0:00:45');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(100 * HOUR_MS)).toBe('100:00:00');
    expect(formatClock(-1)).toBe('0:00:00');
  });

  it('wholeMinutes', () => {
    expect(wholeMinutes(119_999)).toBe(1);
    expect(wholeMinutes(-1)).toBe(0);
  });
});

describe('toMs and toIso', () => {
  it('normalise strings, dates and numbers', () => {
    expect(toIso('2026-10-02T03:15:00Z')).toBe('2026-10-02T03:15:00.000Z');
    expect(toIso(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toMs(1234)).toBe(1234);
    expect(toMs('1970-01-01T00:00:01.000Z')).toBe(1000);
    expect(toMs(new Date(5))).toBe(5);
  });
});
