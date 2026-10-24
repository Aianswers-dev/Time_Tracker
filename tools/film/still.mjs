// Stills at a point on a route, from several cameras, without driving.
//
//   node tools/film/still.mjs "route=M2&dir=0&s=1950&hours=10" out_prefix [cab,chase,top,cinematic]
//
// Writes out_prefix_<view>.png. Uses the ?film=1 page (needs a dev server or
// SHOT_URL); each frame takes ~10-15 s in headless Chromium's software GL.
import { chromium } from 'playwright-core';

const [query = '', prefix = 'still', views = 'cab,chase'] = process.argv.slice(2);
const base = process.env.SHOT_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.SHOT_W ?? 1280), height: Number(process.env.SHOT_H ?? 720) } });
page.setDefaultTimeout(600000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + '?film=1&' + query);
await page.waitForFunction(() => window.__film?.ready, null, { timeout: 600000, polling: 1000 });
await page.waitForTimeout(Number(process.env.SETTLE ?? 4000));
for (const v of views.split(',')) {
  await page.evaluate((v) => {
    window.__film.view(v);
    window.__film.draw();
    window.__film.draw();
  }, v);
  await page.screenshot({ path: `${prefix}_${v}.png`, timeout: 600000 });
}
console.log(JSON.stringify(await page.evaluate(() => window.__film.state())));
const errs = logs.filter((l) => l.includes('error'));
if (errs.length) console.log(errs.slice(-10).join('\n'));
await browser.close();
