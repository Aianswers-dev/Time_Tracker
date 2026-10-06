import { chromium, devices } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices['iPhone 13'],
  viewport: { width: 390, height: 844 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8788/');
await page.getByText('Relaxing').first().waitFor();
await page
  .getByRole('button', { name: /Relaxing/ })
  .first()
  .click();
for (const [path, text] of [
  ['/today', 'Today'],
  ['/stats', 'Today'],
  ['/settings', 'Notifications'],
]) {
  await page.goto('http://localhost:8788' + path);
  await page.getByText(text).first().waitFor({ timeout: 10000 });
  console.log('OK', path);
}
const headings = await page.locator('h2').allInnerTexts();
console.log('settings sections:', headings.join(' | '));
await page.screenshot({ path: 'final-settings.png', fullPage: true });
console.log(errors.length ? 'PAGE ERRORS: ' + errors.join('; ') : 'no page errors');
await browser.close();
