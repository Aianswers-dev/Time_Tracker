// 1. Screens with iPhone 13 safe-area insets simulated (47px top, 34px bottom) by
//    rewriting env(safe-area-inset-*) in the served CSS, since Chromium reports 0.
// 2. Real-Chromium switch latency with 10,000 stored segments: click a tile and
//    time until the Now header shows the new category (IndexedDB write + render).
import { chromium, devices } from 'playwright';

const BASE = 'http://localhost:4173';
const OUT = new URL('./shots/', import.meta.url).pathname;
const browser = await chromium.launch();

async function ctx(scheme) {
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: scheme,
  });
  return context;
}

// --- insets ---
for (const scheme of ['light', 'dark']) {
  const context = await ctx(scheme);
  await context.route('**/assets/*.css', async (route) => {
    const res = await route.fetch();
    const body = (await res.text())
      .replaceAll('env(safe-area-inset-top)', '47px')
      .replaceAll('env(safe-area-inset-bottom)', '34px');
    await route.fulfill({ response: res, body });
  });
  const page = await context.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('list', { name: 'Categories' }).getByRole('button').nth(9).waitFor();
  await page.getByRole('button', { name: /^Relaxing,/ }).tap();
  await page.waitForTimeout(400);
  // Draw the notch and home indicator areas so the screenshot shows what they would cover.
  const overlay = () =>
    page.addStyleTag({
      content: `body::before{content:'';position:fixed;top:0;left:0;right:0;height:47px;background:rgba(255,0,0,.25);z-index:999;pointer-events:none}
                body::after{content:'';position:fixed;bottom:0;left:0;right:0;height:34px;background:rgba(255,0,0,.25);z-index:999;pointer-events:none}`,
    });
  await overlay();
  await page.screenshot({ path: `${OUT}insets-${scheme}-now.png` });
  await page.getByRole('button', { name: /^Relaxing,/ }).tap();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}insets-${scheme}-sheet.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Settings' }).tap();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await overlay();
  await page.screenshot({ path: `${OUT}insets-${scheme}-settings-bottom.png` });
  console.log('insets screenshots', scheme);
  await context.close();
}

// --- perf ---
{
  const context = await ctx('light');
  const page = await context.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('list', { name: 'Categories' }).getByRole('button').nth(9).waitFor();
  const seeded = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('time-tracker');
        req.onsuccess = () => {
          const db = req.result;
          const cats = db.transaction('categories').objectStore('categories').getAll();
          cats.onsuccess = () => {
            const ids = cats.result.map((c) => c.id);
            const tx = db.transaction('segments', 'readwrite');
            const store = tx.objectStore('segments');
            const N = 10_000;
            let t = Date.now() - N * 50 * 60_000;
            for (let i = 0; i < N; i++) {
              const len = (20 + ((i * 37) % 61)) * 60_000;
              const last = i === N - 1;
              const start = new Date(t).toISOString();
              store.put({
                id: crypto.randomUUID(),
                categoryId: ids[i % ids.length],
                startedAt: start,
                endedAt: last ? null : new Date(t + len).toISOString(),
                note: null,
                source: 'app',
                createdAt: start,
                updatedAt: start,
                deletedAt: null,
              });
              t += last ? 0 : len;
            }
            tx.oncomplete = () => resolve(N);
            tx.onerror = () => reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.reload();
  const header = page.getByTestId('now-header');
  await header.waitFor();
  await page.waitForTimeout(1000);
  const times = [];
  for (let i = 0; i < 12; i++) {
    const ms = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const header = document.querySelector('[data-testid=now-header]');
          const before = header.dataset.category;
          const tiles = [...document.querySelectorAll('ul[aria-label=Categories] button')];
          const target = tiles.find((b) => !b.getAttribute('aria-label').startsWith(before + ','));
          const obs = new MutationObserver(() => {
            if (header.dataset.category !== before) {
              obs.disconnect();
              resolve(performance.now() - t0);
            }
          });
          obs.observe(header, { attributes: true });
          const t0 = performance.now();
          target.click();
        }),
    );
    times.push(ms);
    await page.waitForTimeout(300);
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(
    `real chromium switch (tap to header update) with ${seeded} segments:`,
    JSON.stringify({
      first: +times[0].toFixed(1),
      median: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(1),
    }),
  );
  await context.close();
}
await browser.close();
