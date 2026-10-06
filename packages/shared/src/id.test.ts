import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { uuidv7 } from './id';

describe('uuidv7', () => {
  it('passes z.uuid() with version 7 and the RFC 9562 variant', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7();
      expect(z.uuid().safeParse(id).success, id).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('puts the millisecond timestamp in the first 48 bits', () => {
    const ms = Date.parse('2026-10-06T00:00:00.000Z');
    const id = uuidv7(ms);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(ms);
    expect(uuidv7(0).startsWith('00000000-0000-7')).toBe(true);
    expect(uuidv7(2 ** 48 - 1).startsWith('ffffffff-ffff-7')).toBe(true);
    expect(uuidv7(1234.9).startsWith('00000000-04d2-7')).toBe(true);
  });

  it('ids sort by the timestamp argument', () => {
    const times = [
      0,
      1,
      255,
      256,
      65_535,
      65_536,
      2 ** 32 - 1,
      2 ** 32,
      Date.parse('2026-10-06T00:00:00.000Z'),
      Date.parse('2026-10-06T00:00:00.001Z'),
      Date.parse('2099-01-01T00:00:00.000Z'),
    ];
    const ids = times.map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('ids made in the same millisecond are unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1_000)));
    expect(ids.size).toBe(1000);
  });
});
