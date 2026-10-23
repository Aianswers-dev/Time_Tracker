// Headless screenshot of the running dev server.
// Usage: node tools/shot/shot.mjs "<query string>" out.png [waitMs] [keys]
//   e.g. node tools/shot/shot.mjs "route=61&cam=chase&s=600" /tmp/a.png 8000 "KeyW:3000"
// Start the dev server first: pnpm dev --port 5173 (or set SHOT_URL).
// keys: comma list of Code:holdMs pressed in order after load, e.g. "KeyW:2000,KeyD:500".
import { chromium } from 'playwright-core';

const [query = '', out = 'shot.png', wait = '8000', keys = ''] = process.argv.slice(2);
const base = process.env.SHOT_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + (query ? '?' + query : ''));
await page.waitForTimeout(Number(wait));
for (const k of keys.split(',').filter(Boolean)) {
  const [code, ms] = k.split(':');
  await page.keyboard.down(code);
  await page.waitForTimeout(Number(ms ?? 100));
  await page.keyboard.up(code);
}
if (keys) await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log(logs.slice(-30).join('\n'));
await browser.close();
