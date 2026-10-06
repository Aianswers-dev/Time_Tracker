import {
  apiErrorSchema,
  healthResponseSchema,
  type Category,
  type Rule,
  type Segment,
  type Settings,
} from '@time-tracker/shared';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { bearerToken, timingSafeEqual } from '../src/auth';
import {
  categoryFromRow,
  categoryToRow,
  ruleFromRow,
  ruleToRow,
  segmentFromRow,
  segmentToRow,
  settingsFromRow,
  settingsToRow,
} from '../src/db/mapping';
import { orderForOneOpen } from '../src/db/writes';
import type { Env } from '../src/env';
import { csvField } from '../src/routes/export';
import { normalizeName } from '../src/routes/switch';
import { fromDbError } from '../src/sync/errors';

/**
 * Unit tests that need no database: they run the Hono app in Node with stub
 * bindings. Everything that touches D1 is in the other files, against workerd.
 */

function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: () => Promise.resolve(new Response('<html>pwa</html>', { status: 200 })),
    },
    AUTH_TOKEN: 'secret',
    ...overrides,
  } as unknown as Env;
}

describe('app routing', () => {
  it('GET /api/health returns ok and an ISO time, without a token', async () => {
    const res = await app.request('/api/health', {}, stubEnv());
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json()).ok).toBe(true);
  });

  it('an unknown /api route is 401 without a token and 404 not_found with one', async () => {
    const env = stubEnv();
    expect((await app.request('/api/nope', {}, env)).status).toBe(401);
    const res = await app.request(
      '/api/nope',
      { headers: { Authorization: 'Bearer secret' } },
      env,
    );
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('non-/api paths are served by the ASSETS binding', async () => {
    const res = await app.request('/some/page', {}, stubEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>pwa</html>');
  });

  it('an unset or empty AUTH_TOKEN rejects every request', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const env of [stubEnv({ AUTH_TOKEN: undefined }), stubEnv({ AUTH_TOKEN: '' })]) {
      for (const header of [undefined, 'Bearer ', 'Bearer undefined', 'Bearer x']) {
        const headers: Record<string, string> =
          header === undefined ? {} : { Authorization: header };
        const res = await app.request('/api/state', { headers }, env);
        expect(res.status).toBe(401);
      }
    }
    log.mockRestore();
  });
});

describe('timingSafeEqual', () => {
  it('compares UTF-8 bytes', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('ab', 'abc')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('café', 'café')).toBe(true);
    expect(timingSafeEqual('café', 'cafe')).toBe(false);
    // Same length in UTF-16, different bytes.
    expect(timingSafeEqual('é', 'e')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(bearerToken('Bearer abc+/=')).toBe('abc+/=');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Bearer   abc  ')).toBe('abc');
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('row mapping', () => {
  const ts = '2026-10-02T03:15:00.000Z';

  it('round-trips every synced entity and drops synced_at', () => {
    const category: Category = {
      id: '00000000-0000-7000-8000-000000000001',
      name: 'Sleep',
      color: '#5b5bd6',
      icon: 'moon',
      sortOrder: 1,
      exemptFromStaleCheck: true,
      archivedAt: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    const categoryRow = categoryToRow(category, ts);
    expect(categoryRow).toMatchObject({ exemptFromStaleCheck: 1, syncedAt: ts });
    expect(categoryFromRow(categoryRow)).toEqual(category);
    expect(categoryFromRow({ ...categoryRow, exemptFromStaleCheck: 0 }).exemptFromStaleCheck).toBe(
      false,
    );

    const segment: Segment = {
      id: '00000000-0000-7000-8000-000000000002',
      categoryId: category.id,
      startedAt: ts,
      endedAt: null,
      note: 'n',
      source: 'shortcut',
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    expect(segmentFromRow(segmentToRow(segment, ts))).toEqual(segment);

    const rule: Rule = {
      id: '00000000-0000-7000-8000-000000000003',
      categoryId: category.id,
      kind: 'daily',
      thresholdMin: 180,
      repeatEveryMin: null,
      quietStart: '23:00',
      quietEnd: '07:00',
      message: null,
      enabled: false,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: ts,
    };
    expect(ruleToRow(rule, ts).enabled).toBe(0);
    expect(ruleFromRow(ruleToRow(rule, ts))).toEqual(rule);

    const settings: Settings = {
      id: 'singleton',
      timezone: 'Australia/Sydney',
      dayStartHour: 4,
      staleEnabled: false,
      staleAfterMin: 300,
      staleRepeatMin: null,
      staleQuietStart: null,
      staleQuietEnd: null,
      updatedAt: ts,
    };
    expect(settingsToRow(settings, ts).staleEnabled).toBe(0);
    expect(settingsFromRow(settingsToRow(settings, ts))).toEqual(settings);
    expect(Object.keys(settingsFromRow(settingsToRow(settings, ts)))).not.toContain('syncedAt');
  });
});

describe('orderForOneOpen', () => {
  it('puts the row that ends up open after rows that close or delete', () => {
    const base = {
      categoryId: 'c',
      note: null,
      source: 'app' as const,
      createdAt: 't',
      updatedAt: 't',
    };
    const reopen: Segment = { ...base, id: 'a', startedAt: '1', endedAt: null, deletedAt: null };
    const remove: Segment = { ...base, id: 'b', startedAt: '2', endedAt: null, deletedAt: 'x' };
    const close: Segment = { ...base, id: 'c', startedAt: '0', endedAt: '1', deletedAt: null };
    expect(orderForOneOpen([reopen, remove, close]).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('csvField', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(42)).toBe('42');
    expect(csvField('')).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
  });
});

describe('normalizeName', () => {
  it('ignores case, surrounding whitespace and Unicode composition', () => {
    expect(normalizeName('  Relaxing\n')).toBe(normalizeName('relaxing'));
    expect(normalizeName('Café')).toBe(normalizeName('Café'));
    expect(normalizeName('Uni study')).not.toBe(normalizeName('Unistudy'));
  });
});

describe('fromDbError', () => {
  it('maps constraint failures to API codes and leaves other errors alone', () => {
    const unique = new Error(
      "D1_ERROR: UNIQUE constraint failed: index 'segments_one_open': SQLITE_CONSTRAINT",
    );
    expect(fromDbError(unique)?.code).toBe('conflict');
    const wrapped = new Error('Failed query', { cause: unique });
    expect(fromDbError(wrapped)?.code).toBe('conflict');
    expect(fromDbError(new Error('FOREIGN KEY constraint failed'))?.code).toBe('validation_failed');
    expect(fromDbError(new Error('network'))).toBeNull();
    expect(fromDbError('not an error')).toBeNull();
  });
});
