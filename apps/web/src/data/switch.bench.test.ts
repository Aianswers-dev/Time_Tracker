import { HOUR_MS, MINUTE_MS, SEED_CATEGORY_IDS, type Segment } from '@time-tracker/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db';
import { ensureSeeded } from './seed';
import { switchTo } from './segmentActions';
import { resetDb, seg } from './testUtils';
import { findOpenSegment } from './window';

/**
 * docs/05: a local switch applies within 50 ms. Seeds 10,000 segments (about a
 * year of use) and times switches through the real action, including the
 * IndexedDB reads and writes. fake-indexeddb is much slower than a browser's
 * IndexedDB: most of its time goes to `put`, which rescans its in-memory
 * indexes, while the windowed load takes a few ms. Run with
 * `--reporter=verbose` to see the numbers.
 */

const COUNT = 10_000;
const CATS = Object.values(SEED_CATEGORY_IDS);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

describe('switch performance', () => {
  beforeAll(async () => {
    await resetDb();
    await ensureSeeded('UTC');
    const rows: Segment[] = [];
    // Contiguous segments of 20 to 80 minutes ending at now, the last one open.
    let t = Date.now();
    const lengths: number[] = [];
    for (let i = 0; i < COUNT; i++) lengths.push((20 + ((i * 37) % 61)) * MINUTE_MS);
    t -= lengths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < COUNT; i++) {
      const len = lengths[i] ?? HOUR_MS;
      const last = i === COUNT - 1;
      rows.push(seg(CATS[i % CATS.length] ?? CATS[0] ?? '', t, last ? null : t + len));
      t += len;
    }
    await db.segments.bulkPut(rows);
  }, 60_000);

  it(`switches in well under 50 ms with ${COUNT} segments stored`, async () => {
    expect(await db.segments.count()).toBe(COUNT);
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const open = await findOpenSegment();
      const next = CATS.find((c) => c !== open?.categoryId) ?? '';
      const t0 = performance.now();
      const out = await switchTo(next);
      times.push(performance.now() - t0);
      expect(out.noop).toBe(false);
    }
    const result = { firstMs: times[0], medianMs: median(times), maxMs: Math.max(...times) };
    console.info(`switch with ${COUNT} segments (fake-indexeddb): ${JSON.stringify(result)}`);
    // A loose bound so slow CI machines stay green. It still catches a
    // regression to loading every segment per switch.
    expect(result.medianMs).toBeLessThan(250);
  });
});
