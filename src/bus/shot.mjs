// Screenshot helper for the bus preview (adapted from tools/shot/shot.mjs).
// Usage: node src/bus/shot.mjs "<query>" out.png [waitMs] [evalExpr]
//   SHOT_URL defaults to http://localhost:5176/src/bus/preview.html
import { chromium } from 'playwright-core';

const [query = '', out = 'shot.png', wait = '6000', expr = ''] = process.argv.slice(2);
const base = process.env.SHOT_URL ?? 'http://localhost:5176/src/bus/preview.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + (query ? '?' + query : ''));
await page.waitForTimeout(Number(wait));
if (expr) {
  const r = JSON.stringify(await page.evaluate(expr));
  logs.push('[eval] ' + r);
  console.log('[eval] ' + r);
}
await page.screenshot({ path: out, timeout: 180000 });
console.log(logs.filter((l) => !l.includes('vite')).slice(-30).join('\n'));
await browser.close();
