// Break down the year-range cost with the app's User Timing entries.
import { chromium } from 'playwright';
import { putSegments, syntheticSegments, waitForSeed } from './seed.mjs';

const BASE = 'http://localhost:4177';
const throttle = Number(process.argv[2] ?? 4);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  timezoneId: 'Australia/Sydney',
  serviceWorkers: 'block',
});
const page = await context.newPage();
await page.goto(`${BASE}/`);
await waitForSeed(page);
await putSegments(page, syntheticSegments(10000));
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
for (const qs of ['range=month', 'range=custom&from=2025-10-07&to=2026-10-06']) {
  await page.goto(`${BASE}/stats?${qs}`);
  await page.waitForSelector('[data-testid="stats"][data-stale="false"]', { timeout: 60000 });
  await page.waitForTimeout(500);
  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter((e) => e.name.startsWith('stats:'))
      .map((e) => `${e.name} ${Math.round(e.duration)}ms`),
  );
  const nodes = await page.evaluate(
    () => document.querySelectorAll('[data-testid="stats"] *').length,
  );
  console.log(qs, `throttle ${throttle}x`, entries.join(', '), `| DOM nodes ${nodes}`);
}
await browser.close();
