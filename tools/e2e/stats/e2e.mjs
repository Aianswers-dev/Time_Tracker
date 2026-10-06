// Perf with 10,000 segments, tap-through to Today, export download, empty and day-one states.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { CAT, putSegments, realisticSegments, syntheticSegments, waitForSeed } from './seed.mjs';

const BASE = 'http://localhost:4177';
const OUT = new URL('./shots/', import.meta.url).pathname;
const DL = new URL('./downloads/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
mkdirSync(DL, { recursive: true });

const browser = await chromium.launch();
const ctxOpts = (mode = 'light') => ({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: mode,
  timezoneId: 'Australia/Sydney',
  locale: 'en-AU',
  serviceWorkers: 'block',
  hasTouch: true,
  acceptDownloads: true,
});
const results = {};
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitStats(page) {
  await page.waitForSelector('[data-testid="stats"][data-stale="false"]', { timeout: 30000 });
}

/** Time from a click (run in the page) until the new range has rendered and painted. */
async function timeSwitch(page, action, prefix) {
  return page.evaluate(
    ({ action, prefix }) =>
      new Promise((resolve) => {
        const done = () => {
          const r = document.querySelector('[data-testid="stats"]');
          return r && r.dataset.stale === 'false' && r.dataset.rangeKey.startsWith(prefix);
        };
        const t0 = performance.now();
        const finish = () =>
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
        const obs = new MutationObserver(() => {
          if (done()) {
            obs.disconnect();
            finish();
          }
        });
        obs.observe(document.body, { subtree: true, attributes: true, childList: true });
        if (action.kind === 'tab') {
          document.querySelector(`[data-range="${action.range}"]`).click();
        } else {
          const input = document.querySelector('[data-testid="custom-from"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, action.value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }),
    { action, prefix },
  );
}

// ---- 1. Performance with 10,000 segments over a year --------------------------------
for (const throttle of [1, 4]) {
  const context = await browser.newContext(ctxOpts());
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`${BASE}/`);
  await waitForSeed(page);
  const segs = syntheticSegments(10000);
  await putSegments(page, segs);
  const count = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('time-tracker');
        req.onsuccess = () => {
          const c = req.result.transaction('segments').objectStore('segments').count();
          c.onsuccess = () => resolve(c.result);
        };
      }),
  );
  check(`seeded 10,000 segments (throttle ${throttle}x)`, count === 10000, String(count));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  const t0 = Date.now();
  await page.goto(`${BASE}/stats?range=month`);
  await waitStats(page);
  const cold = Date.now() - t0;
  const timings = { coldLoadMonth: cold };
  // Switch through every range in the app, as the owner would.
  for (const range of ['today', 'week', 'last7', 'month']) {
    // Go somewhere else first so each switch really reloads.
    const other = range === 'today' ? 'week' : 'today';
    await timeSwitch(page, { kind: 'tab', range: other }, `${other}:`);
    timings[range] = Math.round(await timeSwitch(page, { kind: 'tab', range }, `${range}:`));
  }
  await timeSwitch(page, { kind: 'tab', range: 'custom' }, 'custom:');
  timings.customYear = Math.round(
    await timeSwitch(page, { kind: 'from', value: '2025-10-07' }, 'custom:2025-10-07'),
  );
  const yearDays = await page.evaluate(
    () => document.querySelector('[data-testid="range-label"]').textContent,
  );
  results[`throttle${throttle}x`] = timings;
  console.log(`10k segments, CPU ${throttle}x:`, JSON.stringify(timings), '|', yearDays);
  for (const [k, v] of Object.entries(timings)) {
    if (k === 'coldLoadMonth') continue;
    // The requirement is unthrottled Chromium; at 4x only the presets are gated.
    if (throttle === 1 || k !== 'customYear')
      check(`render ${k} under 1 s at ${throttle}x`, v < 1000, `${v} ms`);
    else console.log(`INFO render ${k} at ${throttle}x — ${v} ms`);
  }
  if (throttle === 1) {
    await page.screenshot({ path: `${OUT}light-perf-year.png`, fullPage: false });
  }
  await context.close();
}

// ---- 2. Realistic data: tap a bar to open Today, export downloads -------------------
{
  const context = await browser.newContext(ctxOpts());
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`${BASE}/`);
  await waitForSeed(page);
  const segs = await realisticSegments(page, 60);
  await putSegments(page, segs);

  await page.goto(`${BASE}/stats?range=last7`);
  await waitStats(page);
  const daily = page.locator('[data-testid="daily"]');
  await daily.scrollIntoViewIfNeeded();
  const box = await daily.locator('.chart-scrub').boundingBox();
  // Third bar of seven.
  await page.touchscreen.tap(box.x + box.width * (2.5 / 7), box.y + box.height * 0.5);
  await page.waitForURL(/\/today\?day=/, { timeout: 5000 });
  const url = new URL(page.url());
  const day = url.searchParams.get('day');
  const title = await page.locator('[data-testid="day-title"]').textContent();
  check(
    'tapping a daily bar opens Today on that day',
    /^\d{4}-\d{2}-\d{2}$/.test(day ?? ''),
    `${day} → "${title}"`,
  );
  await page.goBack();
  await waitStats(page);
  check('back returns to the same Stats range', page.url().includes('range=last7'), page.url());

  // A sideways drag inspects instead of navigating.
  await daily.scrollIntoViewIfNeeded();
  const b2 = await daily.locator('.chart-scrub').boundingBox();
  await cdpTouchDrag(
    context,
    page,
    b2.x + b2.width * 0.1,
    b2.x + b2.width * 0.6,
    b2.y + b2.height * 0.5,
  );
  check('a sideways drag on the bars stays on Stats', page.url().includes('/stats'), page.url());
  await page.addStyleTag({ content: 'nav[aria-label="Main"]{display:none!important}' });
  await daily.screenshot({ path: `${OUT}light-interact-daily-scrub.png` });

  // Export: Chromium on Linux cannot share files, so it downloads.
  await page.goto(`${BASE}/settings`);
  const exp = page.locator('[data-testid="export"]');
  await exp.scrollIntoViewIfNeeded();
  const [csvDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('[data-testid="export-csv"]'),
  ]);
  const csvPath = `${DL}${csvDl.suggestedFilename()}`;
  await csvDl.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf8');
  const lines = csv.split('\r\n');
  check(
    'CSV download name',
    /^time-tracker-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()),
    csvDl.suggestedFilename(),
  );
  check(
    'CSV header',
    lines[0] === 'started_at,ended_at,category,minutes,note,source,started_at_utc',
    lines[0],
  );
  check(
    'CSV has one row per segment plus header and final CRLF',
    lines.length === segs.length + 2,
    `${lines.length} lines for ${segs.length} segments`,
  );
  const quoted = lines.find((l) => l.includes('""The Bear""'));
  check('CSV quotes notes with commas and quotes', Boolean(quoted), quoted ?? '');
  check('CSV keeps a newline inside a quoted note', csv.includes('"YouTube; then\nscrolling"'));
  const last = lines[lines.length - 2].split(',');
  check('open segment has a blank ended_at', last[1] === '', lines[lines.length - 2]);
  await exp.screenshot({ path: `${OUT}light-export-ready.png` });

  await page.selectOption('[data-testid="export-range"]', 'last30');
  const [jsonDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('[data-testid="export-json"]'),
  ]);
  const jsonPath = `${DL}${jsonDl.suggestedFilename()}`;
  await jsonDl.saveAs(jsonPath);
  const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
  check(
    'JSON keys',
    JSON.stringify(Object.keys(json)) === '["categories","segments","rules","settings"]',
    Object.keys(json).join(','),
  );
  check(
    'JSON last 30 days is a subset',
    json.segments.length > 0 && json.segments.length < segs.length,
    `${json.segments.length} of ${segs.length}`,
  );
  check(
    'JSON settings timezone',
    json.settings?.timezone === 'Australia/Sydney',
    json.settings?.timezone,
  );
  await context.close();
}

// ---- 3. Empty and day-one states in both modes ---------------------------------------
for (const mode of ['light', 'dark']) {
  const context = await browser.newContext(ctxOpts(mode));
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await waitForSeed(page);
  await page.goto(`${BASE}/stats`);
  await waitStats(page);
  check(
    `empty state shows (${mode})`,
    (await page.locator('[data-testid="stats-empty"]').count()) === 1,
  );
  await page.screenshot({ path: `${OUT}${mode}-empty.png` });

  // Day one: tracking began 3 hours ago, with a switch an hour ago.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (id, cat, s, e) => ({
    id,
    categoryId: cat,
    startedAt: iso(s),
    endedAt: e === null ? null : iso(e),
    note: null,
    source: 'app',
    createdAt: iso(s),
    updatedAt: iso(s),
    deletedAt: null,
  });
  await putSegments(page, [
    mk('d1', CAT.contractWork, now - 3 * 3600e3, now - 3600e3),
    mk('d2', CAT.relaxing, now - 3600e3, null),
  ]);
  for (const range of ['today', 'week']) {
    await page.goto(`${BASE}/stats${range === 'today' ? '' : '?range=week'}`);
    await waitStats(page);
    await page.screenshot({ path: `${OUT}${mode}-dayone-${range}.png`, fullPage: true });
  }
  await context.close();
}

async function cdpTouchDrag(context, page, x0, x1, y) {
  const cdp = await context.newCDPSession(page);
  const steps = 8;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
}

console.log('RESULTS', JSON.stringify(results));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
