// Screenshot every Stats range and chart in light and dark at 390x844.
// Usage: node shots.mjs [light|dark|both] [only-range]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { putSegments, realisticSegments, waitForSeed } from './seed.mjs';

const BASE = 'http://localhost:4177';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const modes =
  process.argv[2] === 'light' || process.argv[2] === 'dark' ? [process.argv[2]] : ['light', 'dark'];
const only = process.argv[3];

async function waitStats(page) {
  await page.waitForSelector('[data-testid="stats"][data-stale="false"]', { timeout: 20000 });
  await page.waitForTimeout(150);
}

const browser = await chromium.launch();
for (const mode of modes) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: mode,
    timezoneId: 'Australia/Sydney',
    locale: 'en-AU',
    serviceWorkers: 'block',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
  await page.goto(`${BASE}/`);
  await waitForSeed(page);
  const segs = await realisticSegments(page, 60);
  await putSegments(page, segs);
  console.log(mode, 'seeded', segs.length, 'segments');

  const ranges = [
    ['today', ''],
    ['week', '?range=week'],
    ['last7', '?range=last7'],
    ['month', '?range=month'],
    ['custom', '?range=custom&from=2026-08-08&to=2026-10-06'],
  ];
  for (const [name, qs] of ranges) {
    if (only && only !== name) continue;
    await page.goto(`${BASE}/stats${qs}`);
    await waitStats(page);
    await page.screenshot({ path: `${OUT}${mode}-${name}-full.png`, fullPage: true });
    await page.addStyleTag({ content: 'nav[aria-label="Main"]{display:none!important}' });
    for (const id of ['stat-tiles', 'totals', 'daily', 'heatmap', 'budgets', 'trend']) {
      const el = page.locator(`[data-testid="${id}"]`).first();
      if ((await el.count()) === 0) continue;
      await el.screenshot({ path: `${OUT}${mode}-${name}-${id}.png` });
    }
  }
  if (!only || only === 'interact') {
    // Interactions on the week view: hover a bar, tap a heat cell, open a table.
    await page.goto(`${BASE}/stats?range=last7`);
    await waitStats(page);
    await page.addStyleTag({ content: 'nav[aria-label="Main"]{display:none!important}' });
    const daily = page.locator('[data-testid="daily"]');
    await daily.scrollIntoViewIfNeeded();
    const box = await daily.locator('.chart-scrub').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await page.waitForTimeout(100);
      await daily.screenshot({ path: `${OUT}${mode}-interact-daily-hover.png` });
      await page.mouse.move(box.x + box.width * 0.93, box.y + box.height * 0.5);
      await page.waitForTimeout(100);
      await daily.screenshot({ path: `${OUT}${mode}-interact-daily-hover-right.png` });
      await page.mouse.move(0, 0);
    }
    const heat = page.locator('[data-testid="heatmap"]');
    await heat.scrollIntoViewIfNeeded();
    const row = heat.locator('.chart-scrub').nth(2);
    const rb = await row.boundingBox();
    if (rb) {
      await page.touchscreen.tap(rb.x + rb.width * 0.8, rb.y + rb.height / 2);
      await page.waitForTimeout(100);
      await heat.screenshot({ path: `${OUT}${mode}-interact-heat-tap.png` });
    }
    const budgets = page.locator('[data-testid="budgets"]');
    await budgets.scrollIntoViewIfNeeded();
    const bb = await budgets.locator('.chart-scrub').boundingBox();
    if (bb) {
      await page.touchscreen.tap(bb.x + bb.width * 0.4, bb.y + bb.height * 0.6);
      await page.waitForTimeout(100);
      await budgets.screenshot({ path: `${OUT}${mode}-interact-budget-tap.png` });
    }
    await daily.getByRole('button', { name: 'Table' }).click();
    await daily.screenshot({ path: `${OUT}${mode}-interact-daily-table.png` });
    const trend = page.locator('[data-testid="trend"]');
    await trend.scrollIntoViewIfNeeded();
    const tb = await trend.locator('.chart-scrub').boundingBox();
    if (tb) {
      await page.mouse.move(tb.x + tb.width * 0.5, tb.y + tb.height * 0.5);
      await page.waitForTimeout(100);
      await trend.screenshot({ path: `${OUT}${mode}-interact-trend-hover.png` });
    }
  }
  await context.close();
}
await browser.close();
