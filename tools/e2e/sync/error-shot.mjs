// Screenshot the Sync section while the server is unreachable (retry state).
import { chromium } from 'playwright';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  baseURL: 'http://localhost:8788',
});
const page = await ctx.newPage();
await page.goto('/settings#sync');
await page.getByTestId('token-input').fill('e2e-token');
await page.getByRole('button', { name: 'Connect', exact: true }).tap();
await page.getByText('Connected and synced').waitFor({ timeout: 15_000 });
await page.route('**/api/**', (r) => r.abort('connectionrefused'));
await page.goto('/');
await page.locator('button[aria-label^="Socialising,"]').tap();
await page.waitForTimeout(2500);
await page.getByTestId('status-pill').waitFor({ timeout: 15_000 });
await page.goto('/settings#sync');
await page.getByTestId('sync-error').waitFor({ timeout: 10_000 });
await page.waitForTimeout(500);
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(150);
  await page
    .getByTestId('sync-section')
    .screenshot({ path: `${SHOTS}10-sync-retrying-${scheme}.png` });
}
console.log(await page.getByTestId('sync-error').innerText());
await browser.close();
