import {
  HOUR_MS,
  MINUTE_MS,
  SEED_CATEGORIES,
  SEED_RULES,
  SETTINGS_ID,
  defaultSettings,
  localDateTimeToMs,
  type Category,
  type Rule,
} from '@time-tracker/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { CAT, resetDb, seg } from '../data/testUtils';
import {
  buildExportFile,
  CSV_COLUMNS,
  csvField,
  exportBounds,
  exportCsv,
  exportJson,
  exportRangeKeys,
  exportSegments,
  segmentsCsv,
} from './export';

const SYDNEY = 'Australia/Sydney';
const t = (iso: string) => Date.parse(iso);

function cats(...list: Array<Partial<Category> & { id: string; name: string }>) {
  return new Map(list.map((c) => [c.id, { ...(SEED_CATEGORIES[0] as Category), ...c }]));
}

describe('csvField', () => {
  it('quotes per RFC 4180 only when needed', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(42)).toBe('42');
    expect(csvField('')).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
  });
});

describe('segmentsCsv', () => {
  it('matches the export.csv columns, local times, quoting and CRLF lines', () => {
    const byId = cats({ id: 'travel', name: 'Travel, commute' }, { id: 'work', name: 'Work' });
    const csv = segmentsCsv(
      [
        seg('travel', t('2026-07-01T00:00:00.000Z'), t('2026-07-01T01:30:00.000Z'), {
          note: 'He said "hi", then\nleft',
          source: 'shortcut',
        }),
        seg('work', t('2026-07-01T01:30:00.000Z'), t('2026-07-01T14:05:30.000Z'), {
          source: 'edit',
        }),
      ],
      byId,
      SYDNEY,
      t('2026-07-02T00:00:00.000Z'),
    );
    // Sydney is UTC+10 in July.
    expect(csv).toBe(
      [
        CSV_COLUMNS.join(','),
        '2026-07-01 10:00,2026-07-01 11:30,"Travel, commute",90,"He said ""hi"", then\nleft",shortcut,2026-07-01T00:00:00.000Z',
        // Ends 00:05 the next local day; 12 h 35 m 30 s rounds down to 755 minutes.
        '2026-07-01 11:30,2026-07-02 00:05,Work,755,,edit,2026-07-01T01:30:00.000Z',
        '',
      ].join('\r\n'),
    );
    expect(CSV_COLUMNS.join(',')).toBe(
      'started_at,ended_at,category,minutes,note,source,started_at_utc',
    );
  });

  it('leaves the open segment ended_at blank and counts its minutes to now', () => {
    const byId = cats({ id: 'sleep', name: 'Sleep' });
    const start = t('2026-10-06T00:00:00.000Z');
    const csv = segmentsCsv([seg('sleep', start, null)], byId, 'UTC', start + 2 * HOUR_MS + 59_000);
    const row = csv.split('\r\n')[1]?.split(',');
    expect(row).toEqual([
      '2026-10-06 00:00',
      '',
      'Sleep',
      '120',
      '',
      'app',
      '2026-10-06T00:00:00.000Z',
    ]);
  });

  it('tells the repeated hour apart by started_at_utc when daylight saving ends', () => {
    // Sydney clocks go back from 03:00 to 02:00 on 5 April 2026, so 02:30 happens twice.
    const first = t('2026-04-04T15:30:00.000Z'); // 02:30 AEDT
    const second = t('2026-04-04T16:30:00.000Z'); // 02:30 AEST
    const byId = cats({ id: 'sleep', name: 'Sleep' });
    const lines = segmentsCsv(
      [seg('sleep', first, second), seg('sleep', second, second + 30 * MINUTE_MS)],
      byId,
      SYDNEY,
      second + HOUR_MS,
    ).split('\r\n');
    expect(lines[1]).toBe(
      '2026-04-05 02:30,2026-04-05 02:30,Sleep,60,,app,2026-04-04T15:30:00.000Z',
    );
    expect(lines[2]).toBe(
      '2026-04-05 02:30,2026-04-05 03:00,Sleep,30,,app,2026-04-04T16:30:00.000Z',
    );
  });
});

describe('exportRangeKeys and exportBounds', () => {
  it('resolves presets relative to today', () => {
    const custom = { from: '2026-09-20', to: '2026-09-01' };
    expect(exportRangeKeys('all', '2026-10-06', custom)).toBeNull();
    expect(exportRangeKeys('last30', '2026-10-06', custom)).toEqual(['2026-09-07', '2026-10-06']);
    expect(exportRangeKeys('month', '2026-10-06', custom)).toEqual(['2026-10-01', '2026-10-31']);
    expect(exportRangeKeys('lastMonth', '2026-01-15', custom)).toEqual([
      '2025-12-01',
      '2025-12-31',
    ]);
    expect(exportRangeKeys('custom', '2026-10-06', custom)).toEqual(['2026-09-01', '2026-09-20']);
  });

  it('covers whole logical days from the day start hour', () => {
    const settings = { timezone: SYDNEY, dayStartHour: 4 };
    expect(exportBounds(null, settings)).toEqual({ from: null, to: null });
    const b = exportBounds(['2026-07-01', '2026-07-02'], settings);
    expect(b.from).toBe(localDateTimeToMs('2026-07-01', '04:00', SYDNEY));
    expect(b.to).toBe(localDateTimeToMs('2026-07-03', '04:00', SYDNEY));
  });
});

describe('export from Dexie', () => {
  const D = (h: number) => t('2026-10-01T00:00:00.000Z') + h * HOUR_MS;

  beforeEach(async () => {
    await resetDb();
    await db.categories.bulkPut([
      ...SEED_CATEGORIES,
      { ...(SEED_CATEGORIES[9] as Category), archivedAt: '2026-01-01T00:00:00.000Z' },
      {
        ...(SEED_CATEGORIES[0] as Category),
        id: 'gone',
        name: 'Gone',
        deletedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await db.rules.bulkPut([
      ...SEED_RULES,
      { ...(SEED_RULES[0] as Rule), id: 'r-del', deletedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await db.settings.put(defaultSettings('UTC'));
    await db.segments.bulkPut([
      seg(CAT.sleep, D(0), D(8)), // reaches into a range starting at D(6)
      seg(CAT.housework, D(8), D(9), { note: 'Breakfast, eggs' }),
      seg(CAT.relaxing, D(9), D(10), { deletedAt: '2026-10-02T00:00:00.000Z' }),
      seg(CAT.travel, D(10), D(11)),
      seg(CAT.contractWork, D(30), null), // open
    ]);
  });

  it('exports live segments overlapping the range, whole and oldest first', async () => {
    const inRange = await exportSegments({ from: D(6), to: D(10.5) });
    expect(inRange.map((s) => s.categoryId)).toEqual([CAT.sleep, CAT.housework, CAT.travel]);
    expect(inRange[0]?.startedAt).toBe(new Date(D(0)).toISOString());

    // A range that ends exactly where a segment starts leaves it out.
    const touching = await exportSegments({ from: D(8), to: D(10) });
    expect(touching.map((s) => s.categoryId)).toEqual([CAT.housework]);

    // The open segment overlaps anything after its start.
    const late = await exportSegments({ from: D(40), to: D(50) });
    expect(late.map((s) => s.categoryId)).toEqual([CAT.contractWork]);

    const all = await exportSegments({ from: null, to: null });
    expect(all).toHaveLength(4);
  });

  it('builds the JSON shape of export.json', async () => {
    const json = await exportJson({ from: D(6), to: D(9) });
    expect(Object.keys(json)).toEqual(['categories', 'segments', 'rules', 'settings']);
    // Archived categories are included, deleted ones are not.
    expect(json.categories).toHaveLength(10);
    expect(json.categories.some((c) => c.archivedAt !== null)).toBe(true);
    expect(json.categories.map((c) => c.sortOrder)).toEqual(
      [...json.categories.map((c) => c.sortOrder)].sort((a, b) => a - b),
    );
    expect(json.rules.map((r) => r.id).sort()).toEqual(SEED_RULES.map((r) => r.id).sort());
    expect(json.segments.map((s) => s.categoryId)).toEqual([CAT.sleep, CAT.housework]);
    expect(json.settings?.id).toBe(SETTINGS_ID);

    await db.settings.clear();
    expect((await exportJson({ from: null, to: null })).settings).toBeNull();
  });

  it('builds the CSV in the stored timezone, UTC without settings', async () => {
    await db.settings.put({ ...defaultSettings(SYDNEY) });
    const { text, count } = await exportCsv({ from: D(8), to: D(9) }, D(31));
    expect(count).toBe(1);
    // 08:00 UTC on 1 October is 18:00 in Sydney (AEST, UTC+10).
    expect(text.split('\r\n')[1]).toBe(
      '2026-10-01 18:00,2026-10-01 19:00,Housework,60,"Breakfast, eggs",app,2026-10-01T08:00:00.000Z',
    );
    await db.settings.clear();
    const utc = await exportCsv({ from: D(30), to: null }, D(31) + 30_000);
    expect(utc.text.split('\r\n')[1]).toBe(
      '2026-10-02 06:00,,Contract work,60,,app,2026-10-02T06:00:00.000Z',
    );
  });

  it('wraps the export in a named file', async () => {
    const csv = await buildExportFile('csv', { from: null, to: null }, '2026-10-06', D(31));
    expect(csv.file.name).toBe('time-tracker-2026-10-06.csv');
    expect(csv.file.type).toMatch(/^text\/csv/);
    expect(csv.count).toBe(4);
    expect((await csv.file.text()).startsWith(CSV_COLUMNS.join(','))).toBe(true);

    const json = await buildExportFile('json', { from: D(6), to: D(9) }, '2026-10-06', D(31));
    expect(json.file.name).toBe('time-tracker-2026-10-06.json');
    expect(json.file.type).toBe('application/json');
    const parsed = JSON.parse(await json.file.text()) as { segments: unknown[] };
    expect(parsed.segments).toHaveLength(2);
    expect(json.count).toBe(2);
  });
});
