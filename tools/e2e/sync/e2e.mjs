// End-to-end check of M2 sync against the real Worker (wrangler dev on :8788).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8788';
const TOKEN = 'e2e-token';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const NOTE = `e2e note ${Date.now()}`;
function ok(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`FAIL ${name} — ${detail}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function waitFor(fn, { timeout = 15_000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return { value: last, ms: Date.now() - start };
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out after ${timeout} ms waiting for ${label} (last: ${JSON.stringify(last)})`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function serverOpenName() {
  const { body } = await api('/api/state');
  return body.open?.category?.name ?? null;
}

async function idb(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('time-tracker');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const r = db.transaction(store, 'readonly').objectStore(store).getAll();
          r.onsuccess = () => {
            resolve(r.result);
            db.close();
          };
          r.onerror = () => reject(r.error);
        };
      }),
    store,
  );
}

async function idbPut(page, store, value) {
  return page.evaluate(
    ({ store, value }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('time-tracker');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { store, value },
  );
}

const browser = await chromium.launch();
const contextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'light',
  baseURL: BASE,
};

async function shot(page, name, opts = {}) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const path = `${SHOTS}${name}-${scheme}.png`;
    if (opts.locator) await opts.locator.screenshot({ path });
    else await page.screenshot({ path, fullPage: opts.fullPage ?? false });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function tile(page, name) {
  return page.locator(`button[aria-label^="${name},"]`);
}

async function switchTo(page, name) {
  await (await tile(page, name)).tap();
  await page
    .getByTestId('now-header')
    .and(page.locator(`[data-category="${name}"]`))
    .waitFor();
}

// ---------------------------------------------------------------- phone A
const ctxA = await browser.newContext(contextOptions);
const page = await ctxA.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console]', m.text());
});
await page.goto('/');
await page.getByRole('list', { name: 'Categories' }).waitFor();

await check('banner shows when no token is set', async () => {
  await page.getByTestId('connect-banner').waitFor({ timeout: 5000 });
  await shot(page, '01-now-banner');
});

await check('banner links to the Settings sync section', async () => {
  await page.getByTestId('connect-banner').getByRole('link').tap();
  await page.waitForURL('**/settings#sync');
  await page.getByTestId('token-input').waitFor();
  await page.waitForTimeout(300);
  await shot(page, '02-sync-not-connected');
  await shot(page, '02b-sync-not-connected-section', { locator: page.getByTestId('sync-section') });
});

await check('a wrong token is refused before saving', async () => {
  await page.getByTestId('token-input').fill('not-the-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).tap();
  await page.getByText('Your server rejected that token').waitFor({ timeout: 5000 });
  const meta = await idb(page, 'meta');
  assert(!meta.some((m) => m.key === 'token'), 'token was saved');
});

await check('connect with the right token pushes the seed and syncs', async () => {
  await page.getByTestId('token-input').fill(TOKEN);
  await page.getByRole('button', { name: 'Connect', exact: true }).tap();
  await page.getByTestId('sync-status').waitFor({ timeout: 10_000 });
  await page.getByText('Connected and synced').waitFor({ timeout: 10_000 });
  const { body } = await api('/api/categories');
  assert(Array.isArray(body) && body.length === 10, `server has ${body.length} categories`);
  const outbox = await idb(page, 'outbox');
  assert(outbox.length === 0, `outbox has ${outbox.length}`);
  await page.waitForTimeout(4200);
  await shot(page, '03-sync-connected-section', { locator: page.getByTestId('sync-section') });
  return 'server has the 10 seeded categories, outbox empty';
});

await page.goto('/');
await page.getByRole('list', { name: 'Categories' }).waitFor();

await check('banner is gone once connected', async () => {
  await page.waitForTimeout(500);
  assert((await page.getByTestId('connect-banner').count()) === 0, 'banner still shown');
});

await check('switches reach the server', async () => {
  await switchTo(page, 'Relaxing');
  const a = await waitFor(async () => (await serverOpenName()) === 'Relaxing', {
    label: 'Relaxing on server',
  });
  await page.waitForTimeout(1200);
  await switchTo(page, 'Housework');
  const b = await waitFor(async () => (await serverOpenName()) === 'Housework', {
    label: 'Housework on server',
  });
  return `Relaxing after ${a.ms} ms, Housework after ${b.ms} ms`;
});

await check('offline switches land after reconnecting', async () => {
  await ctxA.setOffline(true);
  await page.getByText('Offline').first().waitFor();
  await page.waitForTimeout(1500);
  await switchTo(page, 'Casual work');
  await page.waitForTimeout(1500);
  await switchTo(page, 'Uni study');
  await page.waitForTimeout(2500);
  assert((await serverOpenName()) === 'Housework', 'server changed while offline?');
  const pending = (await idb(page, 'outbox')).length;
  assert(pending === 2, `outbox has ${pending}`);
  await page.getByText('Offline · 2 changes pending').waitFor();
  await shot(page, '04-pill-offline', { locator: page.getByTestId('status-pill') });
  await shot(page, '04b-now-offline');
  const t0 = Date.now();
  await ctxA.setOffline(false);
  await waitFor(async () => (await serverOpenName()) === 'Uni study', {
    timeout: 30_000,
    label: 'Uni study on server',
  });
  const ms = Date.now() - t0;
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 3600_000).toISOString();
  const { body } = await api(`/api/segments?from=${from}&to=${now.toISOString()}`);
  const cats = (await api('/api/categories')).body;
  const name = (id) => cats.find((c) => c.id === id)?.name;
  const names = body.map((s) => name(s.categoryId));
  assert(names.includes('Casual work'), `server segments: ${names.join(', ')}`);
  assert((await idb(page, 'outbox')).length === 0, 'outbox not empty');
  return `both landed ${ms} ms after going online; server history: ${names.join(' → ')}`;
});

await check('"N changes pending" when the server cannot be reached for over 10 s', async () => {
  await page.route('**/api/ops', (route) => route.abort('connectionrefused'));
  await page.waitForTimeout(1200);
  await switchTo(page, 'Life admin');
  await page.getByText('1 change pending').waitFor({ timeout: 20_000 });
  await shot(page, '05-pill-pending', { locator: page.getByTestId('status-pill') });
  const outbox = await idb(page, 'outbox');
  assert(
    outbox[0]?.attempts >= 1 && outbox[0]?.lastError,
    `attempts not recorded: ${JSON.stringify(outbox[0])}`,
  );
  await page.unroute('**/api/ops');
  const r = await waitFor(async () => (await serverOpenName()) === 'Life admin', {
    timeout: 70_000,
    label: 'Life admin on server after backoff',
  });
  await page.getByTestId('status-pill').waitFor({ state: 'detached', timeout: 5000 });
  return `retry landed ${r.ms} ms after the server came back (attempts ${outbox[0].attempts})`;
});

await check('a segment edit reaches the server', async () => {
  await page.goto('/today');
  await page.getByRole('heading', { name: 'Entries' }).waitFor();
  const rows = page.locator('section[aria-labelledby="entries-h"] li button');
  // Newest first: the second row is the closed Uni study segment.
  await rows.nth(1).tap();
  await page.getByLabel('Note').fill(NOTE);
  await page.getByRole('button', { name: 'Save' }).tap();
  const r = await waitFor(
    async () => {
      const now = new Date();
      const from = new Date(now.getTime() - 3 * 3600_000).toISOString();
      const { body } = await api(`/api/segments?from=${from}&to=${now.toISOString()}`);
      return body.find((s) => s.note === NOTE);
    },
    { label: 'note on server' },
  );
  return `note on server after ${r.ms} ms`;
});

await check('a Shortcut switch (POST /api/switch by name) shows up after a pull', async () => {
  await page.goto('/');
  await page.getByRole('list', { name: 'Categories' }).waitFor();
  await page.waitForTimeout(1500);
  const { status, body } = await api('/api/switch', {
    method: 'POST',
    body: JSON.stringify({ categoryName: 'hobbies' }),
  });
  assert(
    status === 200 && body.message === 'Switched to Hobbies',
    `switch: ${status} ${JSON.stringify(body)}`,
  );
  const r = await waitFor(
    async () => (await page.getByTestId('now-header').getAttribute('data-category')) === 'Hobbies',
    { timeout: 40_000, interval: 500, label: 'Hobbies in the app' },
  );
  return `app showed Hobbies ${r.ms} ms later (30 s interval pull)`;
});

await check(
  'a pull merges cleanly (no duplicate open segments, local matches server)',
  async () => {
    const local = (await idb(page, 'segments')).filter((s) => s.deletedAt === null);
    const open = local.filter((s) => s.endedAt === null);
    assert(open.length === 1, `local open segments: ${open.length}`);
    const now = new Date();
    const { body } = await api(
      `/api/segments?from=${new Date(now.getTime() - 3 * 3600_000).toISOString()}&to=${now.toISOString()}`,
    );
    const serverIds = body
      .map((s) => s.id)
      .sort()
      .join();
    const localIds = local
      .map((s) => s.id)
      .sort()
      .join();
    assert(serverIds === localIds, 'segment ids differ');
    return `${local.length} live segments, same ids on both sides`;
  },
);

// ------------------------------------------------- phone B: site data cleared
const ctxB = await browser.newContext(contextOptions);
const pageB = await ctxB.newPage();
await pageB.goto('/settings#sync');
await pageB.getByTestId('token-input').waitFor();

await check('after clearing site data, reconnecting restores the full history', async () => {
  const before = (await api('/api/snapshot')).body;
  await pageB.getByTestId('token-input').fill(TOKEN);
  await pageB.getByRole('button', { name: 'Connect', exact: true }).tap();
  await pageB.getByText('Connected and synced').waitFor({ timeout: 15_000 });
  const cats = (await idb(pageB, 'categories')).filter((c) => c.deletedAt === null);
  const names = cats.map((c) => c.name);
  assert(new Set(names).size === names.length, `duplicate categories: ${names.join(', ')}`);
  assert(cats.length === 10, `${cats.length} categories`);
  const segs = await idb(pageB, 'segments');
  assert(
    segs.length === before.segments.length,
    `local ${segs.length} vs server ${before.segments.length}`,
  );
  const notes = segs.filter((s) => s.note === NOTE).length;
  assert(notes === 1, 'edited note missing');
  await pageB.goto('/');
  await pageB.getByTestId('now-header').and(pageB.locator('[data-category="Hobbies"]')).waitFor();
  const serverAfter = (await api('/api/categories')).body;
  assert(serverAfter.length === 10, `server now has ${serverAfter.length} categories`);
  return `${segs.length} segments and 10 categories back, open segment Hobbies, server still has 10 categories`;
});

await check('Today on the restored phone shows the history', async () => {
  await pageB.goto('/today');
  await pageB.getByRole('heading', { name: 'Entries' }).waitFor();
  const n = await pageB.locator('section[aria-labelledby="entries-h"] li').count();
  assert(n >= 5, `only ${n} entries`);
  await shot(pageB, '06-today-restored', { fullPage: true });
  return `${n} entries listed`;
});

await check('reset local data and re-download', async () => {
  await pageB.goto('/settings#sync');
  await pageB.getByTestId('sync-status').waitFor();
  await pageB.getByRole('button', { name: /^Reset local data and re/ }).tap();
  await pageB.getByRole('dialog').waitFor();
  await shot(pageB, '07-reset-sheet');
  await pageB.getByRole('button', { name: 'Reset and re-download' }).tap();
  await pageB.getByText('Re-downloaded everything from your server').waitFor({ timeout: 10_000 });
  const segs = await idb(pageB, 'segments');
  const server = (await api('/api/snapshot')).body;
  assert(
    segs.length === server.segments.length,
    `local ${segs.length} vs server ${server.segments.length}`,
  );
});

// ------------------------------------------------- phone C: token rejected
const ctxC = await browser.newContext(contextOptions);
const pageC = await ctxC.newPage();
await pageC.goto('/');
await pageC.getByRole('list', { name: 'Categories' }).waitFor();

await check('a rejected stored token shows "token rejected" and "Sync problem"', async () => {
  await idbPut(pageC, 'meta', { key: 'token', value: 'rotated-old-token' });
  await pageC.reload();
  await pageC.getByText('Sync problem').waitFor({ timeout: 10_000 });
  await shot(pageC, '08-pill-sync-problem', { locator: pageC.getByTestId('status-pill') });
  await shot(pageC, '08b-now-sync-problem');
  await pageC.getByText('Sync problem').tap();
  await pageC.waitForURL('**/settings#sync');
  await pageC.getByTestId('token-rejected').waitFor();
  const text = await pageC.getByTestId('token-rejected').innerText();
  assert(text.includes('Token rejected — paste it again'), text);
  await pageC.waitForTimeout(300);
  await shot(pageC, '09-sync-rejected-section', { locator: pageC.getByTestId('sync-section') });
  await shot(pageC, '09b-sync-rejected');
});

await check('pasting the right token again recovers', async () => {
  await pageC.getByTestId('token-input').fill(TOKEN);
  await pageC.getByRole('button', { name: 'Connect', exact: true }).tap();
  await pageC.getByText('Connected and synced').waitFor({ timeout: 15_000 });
  await pageC.goto('/');
  await pageC.getByTestId('now-header').and(pageC.locator('[data-category="Hobbies"]')).waitFor();
  assert((await pageC.getByText('Sync problem').count()) === 0, 'still shows Sync problem');
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
