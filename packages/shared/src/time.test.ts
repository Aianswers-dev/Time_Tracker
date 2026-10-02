import { describe, it, expect } from 'vitest';
import { dayKeyOf } from './time';
import type { DaySettings } from './time';

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
