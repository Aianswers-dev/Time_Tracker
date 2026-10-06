import { chromium, devices } from 'playwright';
const BASE = 'http://localhost:8788';
const H = { Authorization: 'Bearer e2e-token', 'Content-Type': 'application/json' };
const api = async (p, init = {}) => (await fetch(BASE + p, { ...init, headers: H })).json();
const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices['iPhone 13'],
  viewport: { width: 390, height: 844 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/settings#sync');
await page.locator('input[type="password"]').fill('e2e-token');
await page.getByRole('button', { name: /^Connect/ }).click();
await page.getByText('Connected').first().waitFor({ timeout: 20000 });
await page.goto(BASE + '/');
await page
  .getByRole('button', { name: /Relaxing/ })
  .first()
  .click();
await page.waitForTimeout(2500);
console.log('online switch on server:', (await api('/api/state')).open?.category.name);

await ctx.setOffline(true);
await page
  .getByRole('button', { name: /Housework/ })
  .first()
  .click();
const offlineAt = Date.now();
await page.waitForTimeout(3000);
const sc = await api('/api/switch', {
  method: 'POST',
  body: JSON.stringify({ categoryName: 'Casual work' }),
});
console.log('shortcut while phone offline:', sc.message);
await page.waitForTimeout(1000);
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(6000);

const from = new Date(offlineAt - 60_000).toISOString();
const to = new Date(Date.now() + 60_000).toISOString();
const segs = await api(
  `/api/segments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
);
const cats = Object.fromEntries((await api('/api/categories')).map((c) => [c.id, c.name]));
const list = (Array.isArray(segs) ? segs : (segs.segments ?? [])).map(
  (s) =>
    `${cats[s.categoryId]} ${s.startedAt.slice(11, 19)}-${s.endedAt ? s.endedAt.slice(11, 19) : 'open'}`,
);
console.log('server timeline:', list.join(' | '));
const state = await api('/api/state');
console.log('server open now:', state.open?.category.name);
// Let the phone pull and compare.
await page.reload();
await page.waitForTimeout(4000);
const header = await page.locator('main').first().innerText();
console.log(
  'phone header shows Casual work:',
  /Casual work/.test(header.split('\n').slice(0, 3).join(' ')),
);
console.log(errors.length ? 'PAGE ERRORS ' + errors.join('; ') : 'no page errors');
await browser.close();
