// Drives the built M1 app at a phone viewport, in light and dark mode.
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e.mjs [light|dark|both]
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const which = process.argv[2] ?? 'both';
const schemes = which === 'both' ? ['light', 'dark'] : [which];

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

async function longPress(page, locator, ms = 700) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function swipe(page, fromX, toX, y) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: fromX, y }],
  });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

function tile(page, name) {
  return page.getByRole('button', { name: new RegExp(`^${name},`) });
}

async function shot(page, scheme, n, name) {
  const path = `${OUT}${scheme}-${String(n).padStart(2, '0')}-${name}.png`;
  await page.waitForTimeout(250); // let sheet/toast animations settle
  await page.screenshot({ path, fullPage: false });
  log('screenshot', path);
  return path;
}

async function fullShot(page, scheme, n, name) {
  const path = `${OUT}${scheme}-${String(n).padStart(2, '0')}-${name}-full.png`;
  await page.waitForTimeout(250);
  await page.screenshot({ path, fullPage: true });
  log('screenshot', path);
  return path;
}

async function sheet(page) {
  const d = page.getByRole('dialog');
  await d.waitFor();
  return d;
}

async function run(browser, scheme) {
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: scheme,
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/api\/|Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });
  let n = 0;

  // 1. First run seeds 10 categories.
  await page.goto(BASE + '/');
  await page.getByRole('list', { name: 'Categories' }).waitFor();
  await page.getByText('What are you doing?').waitFor();
  const tiles = page.getByRole('list', { name: 'Categories' }).getByRole('button');
  await tiles.nth(9).waitFor();
  assert.equal(await tiles.count(), 10, 'ten seeded categories');
  await shot(page, scheme, ++n, 'now-first-run');

  // 2. Backdated switch from nothing: long-press Housework, "1 h".
  await longPress(page, tile(page, 'Housework'));
  let d = await sheet(page);
  assert.match(await d.getByRole('heading').innerText(), /Switch to Housework from/);
  await d.getByRole('button', { name: '1 h' }).tap();
  await d.getByTestId('backdate-summary').waitFor();
  await shot(page, scheme, ++n, 'longpress-sheet');
  await d.getByRole('button', { name: 'Switch to Housework' }).tap();
  await d.waitFor({ state: 'detached' });
  await page.locator('[data-testid=now-header][data-category="Housework"]').waitFor();
  await page
    .getByTestId('timer')
    .filter({ hasText: /^1:00:0\d$/ })
    .waitFor({ timeout: 3000 });

  // 3. Tap Relaxing: switches, timer ticks, toast offers Undo.
  await tile(page, 'Relaxing').tap();
  await page.locator('[data-testid=now-header][data-category="Relaxing"]').waitFor();
  await page.getByText('Switched to Relaxing').waitFor();
  const ta = await page.getByTestId('timer').innerText();
  await page.waitForTimeout(2100);
  const tb = await page.getByTestId('timer').innerText();
  assert.notEqual(ta, tb, 'timer ticks');
  log('timer ticked', ta, '->', tb);
  await shot(page, scheme, ++n, 'now-switched-toast');

  // 4. Undo returns to Housework.
  await page.getByRole('button', { name: 'Undo' }).tap();
  await page.locator('[data-testid=now-header][data-category="Housework"]').waitFor();
  await page.getByText('Undone').waitFor();
  assert.equal(await tile(page, 'Housework').getAttribute('aria-pressed'), 'true');

  // 5. Switch again, then backdate the running Relaxing by 15 minutes.
  await tile(page, 'Relaxing').tap();
  await page.locator('[data-testid=now-header][data-category="Relaxing"]').waitFor();
  await tile(page, 'Relaxing').tap();
  d = await sheet(page);
  assert.match(await d.getByRole('heading').innerText(), /When did Relaxing start/);
  await d.getByRole('button', { name: '15 min' }).tap();
  await d.getByText('This will also change').waitFor();
  await shot(page, scheme, ++n, 'backdate-sheet-warning');
  await d.getByRole('button', { name: 'Set start time' }).tap();
  await d.waitFor({ state: 'detached' });
  await page
    .getByTestId('timer')
    .filter({ hasText: /^0:15:0\d$/ })
    .waitFor({ timeout: 3000 });
  await page.waitForTimeout(10_500); // let the toast expire before the screenshot
  await shot(page, scheme, ++n, 'now-running');

  // 6. Today: bar, list, totals.
  await page.getByRole('link', { name: 'Today' }).tap();
  await page.getByTestId('day-bar').waitFor();
  const entries = page.getByRole('region', { name: 'Entries' }).getByRole('listitem');
  await entries.first().waitFor();
  assert.equal(await entries.count(), 2, 'two entries');
  await shot(page, scheme, ++n, 'today');

  // 6a. Tapping a bar block names it.
  await page
    .getByTestId('day-bar')
    .getByRole('button', { name: /^Housework, / })
    .tap();
  await page.getByTestId('block-info').filter({ hasText: 'Housework' }).waitFor();
  await shot(page, scheme, ++n, 'today-block-info');

  // 6b. Swipe right to yesterday, arrow back to today.
  await swipe(page, 80, 330, 640);
  await page.getByTestId('day-title').filter({ hasText: 'Yesterday' }).waitFor();
  await shot(page, scheme, ++n, 'today-yesterday');
  await page.waitForTimeout(1000); // let Chromium's synthetic fling end, or the tap only stops it
  await page.getByRole('button', { name: 'Next day' }).tap();
  await page.getByTestId('day-title').filter({ hasText: 'Today' }).waitFor();

  // 7. Edit Housework's end 5 minutes earlier: preview shows Relaxing extends.
  await entries.filter({ hasText: 'Housework' }).getByRole('button').tap();
  d = await sheet(page);
  const endTime = d.getByLabel('End time');
  const oldEnd = await endTime.inputValue();
  const [hh, mm] = oldEnd.split(':').map(Number);
  const mins = (hh * 60 + mm - 5 + 1440) % 1440;
  const newEnd = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  if (mins > hh * 60 + mm) {
    // crossed midnight backwards; move the end date back a day too
    const endDate = d.getByLabel('End date');
    const dt = new Date((await endDate.inputValue()) + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    await endDate.fill(dt.toISOString().slice(0, 10));
  }
  await endTime.fill(newEnd);
  await d.getByText('This will also change').waitFor();
  assert.match(await d.getByRole('note').innerText(), /Extends Relaxing/);
  await d.getByLabel('Note').fill('Dishes and laundry');
  await shot(page, scheme, ++n, 'edit-sheet-preview');
  await d.getByRole('button', { name: 'Save' }).tap();
  await d.waitFor({ state: 'detached' });
  await page.getByText('Dishes and laundry').waitFor();

  // 8. Split Housework into Housework + Life admin.
  await entries.filter({ hasText: 'Housework' }).getByRole('button').tap();
  d = await sheet(page);
  await d.getByRole('button', { name: 'Split' }).tap();
  await d.getByRole('heading', { name: /Split Housework/ }).waitFor();
  await d.getByLabel('Second part').selectOption({ label: 'Life admin' });
  await shot(page, scheme, ++n, 'split-sheet');
  await d.getByRole('button', { name: 'Split' }).tap();
  await d.waitFor({ state: 'detached' });
  await entries.filter({ hasText: 'Life admin' }).first().waitFor();
  assert.equal(await entries.count(), 3, 'three entries after split');

  // 9. Delete Life admin, leaving a gap.
  await entries.filter({ hasText: 'Life admin' }).getByRole('button').tap();
  d = await sheet(page);
  await d.getByRole('button', { name: 'Delete' }).tap();
  await d.getByRole('heading', { name: /Delete Life admin/ }).waitFor();
  await shot(page, scheme, ++n, 'delete-sheet');
  await d.getByRole('button', { name: 'Leave gap' }).tap();
  await d.waitFor({ state: 'detached' });
  await entries.filter({ hasText: 'Untracked' }).first().waitFor();
  await page.waitForTimeout(300);
  await shot(page, scheme, ++n, 'today-with-gap');

  // 10. Assign the gap to Hobbies.
  await entries.filter({ hasText: 'Untracked' }).getByRole('button').tap();
  d = await sheet(page);
  await d.getByRole('heading', { name: 'Assign untracked time' }).waitFor();
  await d.getByLabel('Category').selectOption({ label: 'Hobbies' });
  await shot(page, scheme, ++n, 'assign-sheet');
  await d.getByRole('button', { name: 'Assign' }).tap();
  await d.waitFor({ state: 'detached' });
  await entries.filter({ hasText: 'Hobbies' }).first().waitFor();
  assert.equal(await entries.filter({ hasText: 'Untracked' }).count(), 0, 'gap filled');
  await page.waitForTimeout(10_500);
  await fullShot(page, scheme, ++n, 'today-final');

  // 11. Settings: rename and recolour Hobbies.
  await page.getByRole('link', { name: 'Settings' }).tap();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await shot(page, scheme, ++n, 'settings');
  await page
    .getByRole('button', { name: /^Hobbies/ })
    .first()
    .tap();
  d = await sheet(page);
  await d.getByLabel('Name').fill('Hobby time');
  await d.getByRole('button', { name: 'Colour #c21470' }).tap();
  await d.getByRole('button', { name: 'Icon dumbbell' }).tap();
  await shot(page, scheme, ++n, 'category-editor');
  await d.getByRole('button', { name: 'Save' }).tap();
  await d.waitFor({ state: 'detached' });
  await page
    .getByRole('button', { name: /^Hobby time/ })
    .first()
    .waitFor();
  // Move it up one place.
  await page.getByRole('button', { name: 'Move Hobby time up' }).tap();
  await page.waitForTimeout(300);
  await fullShot(page, scheme, ++n, 'settings-after');

  await page.getByRole('link', { name: 'Stats' }).tap();
  await page.getByRole('heading', { name: 'Stats' }).waitFor();
  await shot(page, scheme, ++n, 'stats');

  // 12. Reload: everything persisted.
  await page.goto(BASE + '/');
  await page.locator('[data-testid=now-header][data-category="Relaxing"]').waitFor();
  await tile(page, 'Hobby time').waitFor();
  const order = await tiles.evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label').split(',')[0]),
  );
  assert.deepEqual(order.slice(-2), ['Hobby time', 'Socialising'], 'reorder persisted');
  const bg = await tile(page, 'Hobby time')
    .locator('span')
    .first()
    .evaluate(
      (el) => getComputedStyle(el.querySelector('span[aria-hidden]') ?? el).backgroundColor,
    );
  log('hobby badge bg', bg);
  await page.goto(BASE + '/today');
  await entries.filter({ hasText: 'Hobby time' }).first().waitFor();
  await page.getByText('Dishes and laundry').waitFor();
  assert.equal(await entries.count(), 3, 'entries persisted');

  // 13. Offline: the shell loads from the service worker.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.locator('[data-testid=now-header][data-category="Relaxing"]').waitFor();
  await page.getByText('Offline', { exact: true }).waitFor();
  await tile(page, 'Sleep').tap();
  await page.locator('[data-testid=now-header][data-category="Sleep"]').waitFor();
  await shot(page, scheme, n + 1, 'offline-now');
  await page.getByRole('link', { name: 'Today' }).tap();
  await page.getByTestId('day-bar').waitFor();
  await page.goto(BASE + '/settings').catch(() => undefined);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await context.setOffline(false);

  // Outbox contents: one op per action.
  const outbox = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('time-tracker');
        req.onsuccess = () => {
          const tx = req.result.transaction('outbox', 'readonly');
          const all = tx.objectStore('outbox').getAll();
          all.onsuccess = () => resolve(all.result.map((r) => r.op.type));
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  log('outbox op types', JSON.stringify(outbox));

  await context.close();
  return errors;
}

const browser = await chromium.launch();
let failed = false;
for (const scheme of schemes) {
  log('=== scheme', scheme);
  try {
    const errors = await run(browser, scheme);
    log(
      scheme,
      'OK',
      errors.length ? `errors: ${JSON.stringify(errors, null, 1)}` : 'no page errors',
    );
  } catch (err) {
    failed = true;
    log(scheme, 'FAILED', err);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
