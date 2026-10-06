import { chromium } from 'playwright';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://localhost:4173/');
await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller);
const cdp = await context.newCDPSession(page);
const errors = await cdp.send('Page.getInstallabilityErrors');
const manifest = await cdp.send('Page.getAppManifest');
console.log('installability errors:', JSON.stringify(errors.installabilityErrors));
console.log('manifest errors:', JSON.stringify(manifest.errors));
for (const p of [
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/maskable-512x512.png',
  '/apple-touch-icon-180x180.png',
]) {
  const r = await page.request.get('http://localhost:4173' + p);
  console.log(p, r.status(), r.headers()['content-type']);
}
await browser.close();
