import { localDate, localHHMM, uuidv7, type Category, type Segment } from '@time-tracker/shared';
import { describe, expect, it } from 'vitest';
import { localDateTimeFormatter, segmentsCsv } from '../src/routes/export';
import { makeCategory } from './harness';

/**
 * The CSV export formats two local times per segment. Workers Free allows
 * 10 ms of CPU per request, so this has to cost microseconds per segment, not
 * the ~80 µs that building a TZDate and running date-fns `format` four times
 * per row costs (a year of segments took over 400 ms).
 */

const ZONES = [
  'UTC',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Europe/London',
  'America/New_York',
  'America/St_Johns',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Africa/Casablanca',
  'America/Santiago',
  'Antarctica/Troll',
];

describe('localDateTimeFormatter', () => {
  it('matches the shared localDate and localHHMM, across daylight saving changes', () => {
    const start = Date.parse('2025-12-31T00:00:00.000Z');
    // Every 97 minutes for a bit over a year lands on every time of day and every DST change day.
    for (const tz of ZONES) {
      const format = localDateTimeFormatter(tz);
      for (let ms = start; ms < start + 400 * 86_400_000; ms += 97 * 60_000) {
        const expected = `${localDate(ms, tz)} ${localHHMM(ms, tz)}`;
        if (format(ms) !== expected) {
          expect(format(ms), `${tz} ${new Date(ms).toISOString()}`).toBe(expected);
        }
      }
    }
  });

  it('matches the shared helpers from 1970 to 2040', () => {
    const start = Date.parse('1970-01-01T00:00:00.000Z');
    const end = Date.parse('2040-01-01T00:00:00.000Z');
    for (const tz of ZONES) {
      const format = localDateTimeFormatter(tz);
      // Every 9 days, 7 hours and 11 minutes lands on every time of day.
      for (let ms = start; ms < end; ms += ((9 * 24 + 7) * 60 + 11) * 60_000) {
        const expected = `${localDate(ms, tz)} ${localHHMM(ms, tz)}`;
        if (format(ms) !== expected) {
          expect(format(ms), `${tz} ${new Date(ms).toISOString()}`).toBe(expected);
        }
      }
    }
  });

  it('matches at the edges of the timestamp range the schemas accept', () => {
    for (const iso of [
      '0000-01-01T00:00:00.000Z',
      '0999-12-31T23:59:59.999Z',
      '1000-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
    ]) {
      for (const tz of ['UTC', 'Australia/Sydney', 'America/New_York']) {
        expect(localDateTimeFormatter(tz)(Date.parse(iso)), `${tz} ${iso}`).toBe(
          `${localDate(iso, tz)} ${localHHMM(iso, tz)}`,
        );
      }
    }
  });
});

describe('segmentsCsv', () => {
  it('formats a year of segments well within the Workers CPU budget', () => {
    const cat = makeCategory();
    const categories = new Map<string, Category>([[cat.id, cat]]);
    const start = Date.parse('2025-10-01T00:00:00.000Z');
    const n = 4000;
    const step = Math.floor((365 * 86_400_000) / n);
    const segments: Segment[] = Array.from({ length: n }, (_, i) => ({
      id: uuidv7(),
      categoryId: cat.id,
      startedAt: new Date(start + i * step).toISOString(),
      endedAt: new Date(start + (i + 1) * step).toISOString(),
      note: null,
      source: 'app',
      createdAt: new Date(start).toISOString(),
      updatedAt: new Date(start).toISOString(),
      deletedAt: null,
    }));
    segmentsCsv(segments.slice(0, 20), categories, 'Australia/Sydney', Date.now());
    const t = performance.now();
    const csv = segmentsCsv(segments, categories, 'Australia/Sydney', Date.now());
    const elapsed = performance.now() - t;
    expect(csv.split('\r\n')).toHaveLength(n + 2);
    // Generous for slow CI; the date-fns version took 300 to 550 ms here.
    expect(elapsed).toBeLessThan(150);
  });
});
