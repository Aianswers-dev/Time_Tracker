// M3 client e2e against `vite preview` on :4176. Push delivery cannot work headless, so
// PushManager and Notification are stubbed in an init script and /api/** is faked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:4176';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');

// A valid-looking 65-byte uncompressed P-256 point, base64url without padding.
const KEY_BYTES = Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 7) % 256));
const VAPID_KEY = Buffer.from(KEY_BYTES).toString('base64url');

function initScript({ standalone, pushSupported, permission, answer, sub }) {
  // Runs in the page before any app code.
  const S = sessionStorage;
  if (sub && !S.getItem('e2e-sub-init')) {
    S.setItem('e2e-sub', JSON.stringify(sub));
    S.setItem('e2e-sub-init', '1');
  }
  if (standalone) Object.defineProperty(navigator, 'standalone', { value: true });
  if (!pushSupported) {
    delete window.PushManager;
    return;
  }
  if (!S.getItem('e2e-perm')) S.setItem('e2e-perm', permission);
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => S.getItem('e2e-perm'),
  });
  Notification.requestPermission = () => {
    S.setItem('e2e-perm-calls', String(Number(S.getItem('e2e-perm-calls') ?? 0) + 1));
    S.setItem('e2e-perm', answer);
    return Promise.resolve(answer);
  };
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  function makeSub(endpoint, keyB64) {
    return {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: unb64(keyB64) },
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: {
          p256dh:
            'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      }),
      unsubscribe: () => {
        S.removeItem('e2e-sub');
        return Promise.resolve(true);
      },
    };
  }
  PushManager.prototype.getSubscription = function () {
    const raw = S.getItem('e2e-sub');
    if (!raw) return Promise.resolve(null);
    const { endpoint, key } = JSON.parse(raw);
    return Promise.resolve(makeSub(endpoint, key));
  };
  PushManager.prototype.subscribe = function (opts) {
    const endpoint = `https://web.push.apple.com/e2e-${Date.now()}`;
    const key = b64(opts.applicationServerKey);
    S.setItem('e2e-sub', JSON.stringify({ endpoint, key }));
    S.setItem('e2e-subscribe-calls', String(Number(S.getItem('e2e-subscribe-calls') ?? 0) + 1));
    return Promise.resolve(makeSub(endpoint, key));
  };
}

/** Fake server state for the push routes. */
function fakeServer(page, initial = []) {
  const server = { subs: [...initial], calls: [], nextId: initial.length + 1, testResult: null };
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    server.calls.push({ method, path: url.pathname, body, auth: req.headers().authorization });
    const json = (status, data) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/push/vapid-public-key') return json(200, { key: VAPID_KEY });
    if (url.pathname === '/api/push/subscriptions' && method === 'GET') {
      return json(200, {
        subscriptions: server.subs.map(({ endpoint: _e, ...s }) => s),
      });
    }
    if (url.pathname === '/api/push/subscriptions' && method === 'POST') {
      let row = server.subs.find((s) => s.endpoint === body.endpoint);
      if (!row) {
        row = {
          id: `sub-${server.nextId++}`,
          endpoint: body.endpoint,
          createdAt: new Date().toISOString(),
          lastSuccessAt: null,
          failureCount: 0,
          userAgent: body.userAgent ?? null,
        };
        server.subs.push(row);
      }
      return json(201, { id: row.id });
    }
    const del = url.pathname.match(/^\/api\/push\/subscriptions\/(.+)$/);
    if (del && method === 'DELETE') {
      server.subs = server.subs.filter((s) => s.id !== decodeURIComponent(del[1]));
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/push/test' && method === 'POST') {
      for (const s of server.subs) s.lastSuccessAt = new Date().toISOString();
      return json(200, server.testResult ?? { sent: server.subs.length, failed: 0 });
    }
    return json(404, { error: { code: 'not_found', message: 'Not in this fake' } });
  });
  return server;
}

async function idb(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('time-tracker');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => {
            resolve(req.result);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  );
}

async function putMeta(page, key, value) {
  await page.evaluate(
    ([key, value]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('time-tracker');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key, value });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [key, value],
  );
}

async function setup(browser, theme, opts) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(initScript, {
    standalone: true,
    pushSupported: true,
    permission: 'default',
    answer: 'granted',
    sub: null,
    ...opts,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const server = fakeServer(page, opts.subs);
  await page.goto(`${BASE}/settings`);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  if (opts.token !== false) {
    await putMeta(page, 'token', 'e2e-token');
    if (opts.meta) for (const [k, v] of Object.entries(opts.meta)) await putMeta(page, k, v);
    await page.reload();
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
  }
  return { context, page, server, errors };
}

function section(page, id) {
  return page.locator(`section[aria-labelledby="${id}-h"]`);
}

async function shot(locatorOrPage, name, theme) {
  const path = `${SHOTS}${name}-${theme}.png`;
  await locatorOrPage.screenshot({ path, animations: 'disabled' });
  console.log('  shot', path);
}

async function sheetShot(page, name, theme) {
  await page.waitForTimeout(350); // Sheet slide-in.
  await page.screenshot({ path: `${SHOTS}${name}-${theme}.png` });
  console.log('  shot', `${SHOTS}${name}-${theme}.png`);
}

const browser = await chromium.launch();
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('ok  ', name);
  } catch (err) {
    failures++;
    console.log('FAIL', name, '\n', err);
  }
}

for (const theme of THEMES) {
  console.log(`\n== ${theme} ==`);

  await step(`${theme}: not standalone on iPhone Safari shows install steps only`, async () => {
    const { context, page } = await setup(browser, theme, {
      standalone: false,
      pushSupported: false,
      token: false,
    });
    const s = section(page, 'notifications');
    await s.getByText('Install to Home Screen first').waitFor();
    assert.equal(await s.getByRole('switch').count(), 0);
    assert.equal(await s.getByText('Connect to your server first').count(), 0);
    await s.scrollIntoViewIfNeeded();
    await shot(s, 'notif-1-not-standalone', theme);
    await context.close();
  });

  await step(`${theme}: desktop browser with push can still try it`, async () => {
    const { context, page } = await setup(browser, theme, { standalone: false });
    const s = section(page, 'notifications');
    await s.getByText('Install to Home Screen first').waitFor();
    await s.getByText('you can still turn notifications on here').waitFor();
    await s.getByRole('switch', { name: /Nudges on this phone/ }).waitFor();
    await shot(s, 'notif-1b-not-standalone-desktop', theme);
    await context.close();
  });

  await step(`${theme}: standalone without a token asks to connect first`, async () => {
    const { context, page } = await setup(browser, theme, { token: false });
    const s = section(page, 'notifications');
    await s.getByText('Connect to your server first').waitFor();
    assert.equal(await s.getByText('Install to Home Screen first').count(), 0);
    await shot(s, 'notif-2-not-connected', theme);
    await context.close();
  });

  await step(`${theme}: ready, enable posts a subscription, test button sends`, async () => {
    const { context, page, server, errors } = await setup(browser, theme, {});
    const s = section(page, 'notifications');
    const toggle = s.getByRole('switch', { name: /Nudges on this phone/ });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await shot(s, 'notif-3-ready-off', theme);

    await toggle.click();
    await s.getByText('Last delivered').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    const perms = await page.evaluate(() => sessionStorage.getItem('e2e-perm-calls'));
    assert.equal(perms, '1');
    const post = server.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/push/subscriptions',
    );
    assert.ok(post, 'POSTed the subscription');
    assert.equal(post.auth, 'Bearer e2e-token');
    assert.match(post.body.endpoint, /^https:\/\/web\.push\.apple\.com\/e2e-/);
    assert.ok(post.body.keys.p256dh && post.body.keys.auth);
    assert.match(post.body.userAgent, /iPhone/);
    const meta = await idb(page, 'meta');
    assert.equal(meta.find((m) => m.key === 'pushSubscriptionId')?.value, 'sub-1');
    await s.getByText('Nothing yet').waitFor();
    await shot(s, 'notif-4-enabled', theme);

    await s.getByRole('button', { name: 'Send test notification' }).click();
    await page.getByText('Test sent. It should arrive in a few seconds.').waitFor();
    assert.ok(server.calls.some((c) => c.method === 'POST' && c.path === '/api/push/test'));
    await s.getByText('just now').waitFor();
    await page.waitForTimeout(200);
    await shot(s, 'notif-5-test-sent', theme);
    await page.screenshot({ path: `${SHOTS}notif-5b-toast-${theme}.png` });

    // Reload: the health check finds everything in order and changes nothing.
    const before = server.calls.length;
    await page.reload();
    await s.getByText('Last delivered').waitFor();
    await page.waitForTimeout(300);
    const after = server.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(
      after.filter((c) => !c.startsWith('GET')),
      [],
      `no writes on a healthy reload: ${after}`,
    );

    // Turn off: DELETE on the server, meta cleared.
    await toggle.click();
    await page.getByText('Notifications are off').waitFor();
    assert.ok(
      server.calls.some((c) => c.method === 'DELETE' && c.path === '/api/push/subscriptions/sub-1'),
    );
    assert.equal(
      (await idb(page, 'meta')).some((m) => m.key === 'pushSubscriptionId'),
      false,
    );
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step(`${theme}: denied shows how to re-enable in iOS Settings`, async () => {
    const { context, page } = await setup(browser, theme, { permission: 'denied' });
    const s = section(page, 'notifications');
    await s.getByText('Notifications are blocked').waitFor();
    await s.getByText('Tap Notifications, then Time Tracker').waitFor();
    assert.equal(await s.getByRole('switch').count(), 0);
    await shot(s, 'notif-6-denied', theme);
    await context.close();
  });

  await step(`${theme}: dismissing the prompt explains how to retry`, async () => {
    const { context, page, server } = await setup(browser, theme, { answer: 'default' });
    const s = section(page, 'notifications');
    await s.getByRole('switch', { name: /Nudges on this phone/ }).click();
    await s.getByText('Notifications weren’t allowed').waitFor();
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0);
    await shot(s, 'notif-7-dismissed', theme);
    await context.close();
  });

  await step(`${theme}: failing delivery and another device`, async () => {
    const endpoint = 'https://web.push.apple.com/existing';
    const { context, page } = await setup(browser, theme, {
      permission: 'granted',
      sub: { endpoint, key: Buffer.from(KEY_BYTES).toString('base64') },
      meta: { pushSubscriptionId: 'sub-1', pushEndpoint: endpoint },
      subs: [
        {
          id: 'sub-1',
          endpoint,
          createdAt: '2026-10-01T00:00:00.000Z',
          lastSuccessAt: null,
          failureCount: 3,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
        },
        {
          id: 'sub-2',
          endpoint: 'https://fcm.googleapis.com/x',
          createdAt: '2026-10-02T00:00:00.000Z',
          lastSuccessAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
          failureCount: 0,
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
      ],
    });
    const s = section(page, 'notifications');
    await s.getByText('Not delivering').waitFor();
    await s.getByText('Also sending to 1 other device').waitFor();
    await s.getByText('Chrome on Mac').waitFor();
    await shot(s, 'notif-8-not-delivering', theme);
    await context.close();
  });

  await step(`${theme}: health check re-subscribes when the server key changed`, async () => {
    const endpoint = 'https://web.push.apple.com/old-key';
    const oldKey = Buffer.from(KEY_BYTES.map((b, i) => (i === 0 ? 4 : 255 - b))).toString('base64');
    const { context, page, server } = await setup(browser, theme, {
      permission: 'granted',
      sub: { endpoint, key: oldKey },
      meta: { pushSubscriptionId: 'sub-1', pushEndpoint: endpoint },
      subs: [
        {
          id: 'sub-1',
          endpoint,
          createdAt: '2026-10-01T00:00:00.000Z',
          lastSuccessAt: null,
          failureCount: 0,
          userAgent: 'iPhone',
        },
      ],
    });
    const s = section(page, 'notifications');
    await s.getByText('Your server’s push key changed').waitFor();
    assert.ok(
      server.calls.some((c) => c.method === 'DELETE' && c.path === '/api/push/subscriptions/sub-1'),
    );
    const meta = await idb(page, 'meta');
    assert.equal(meta.find((m) => m.key === 'pushSubscriptionId')?.value, 'sub-2');
    await s.getByText('Last delivered').waitFor();
    await shot(s, 'notif-9-rekeyed', theme);
    await context.close();
  });

  await step(`${theme}: rules add, validate, edit, toggle, delete`, async () => {
    const { context, page, errors } = await setup(browser, theme, { token: false });
    const s = section(page, 'rules');
    await s.getByText('Nudges you after 1h of Relaxing in a row, then every 30m').waitFor();
    await s.getByText('Nudges you when Relaxing reaches 3h in a day, then every 1h').waitFor();
    await s.scrollIntoViewIfNeeded();
    await shot(s, 'rules-1-list', theme);
    const opsBefore = (await idb(page, 'outbox')).length;

    // Add: invalid first, then valid.
    await s.getByRole('button', { name: 'Add rule' }).click();
    const sheet = page.getByRole('dialog', { name: 'New rule' });
    await sheet.waitFor();
    await sheet.locator('select').first().selectOption({ label: 'Uni study' });
    await sheet.getByRole('radio', { name: /Daily budget/ }).click();
    await sheet.getByText('Nudges you when Uni study reaches 3h in a day, then every 1h').waitFor();
    await sheetShot(page, 'rules-2-add-sheet', theme);
    await sheet.getByLabel('Daily budget', { exact: true }).fill('0');
    await sheet.getByRole('button', { name: 'Add rule' }).click();
    await sheet.getByText('The limit must be at least 1 minute').waitFor();
    await sheet.getByLabel('Daily budget', { exact: true }).fill('4');
    await sheet.getByRole('radio', { name: 'Once' }).click();
    await sheet.getByRole('switch', { name: /Quiet hours/ }).click();
    await sheet.getByLabel('To', { exact: true }).fill('22:00');
    await sheet.getByRole('button', { name: 'Add rule' }).click();
    await sheet.getByText('Start and end are the same').waitFor();
    await sheet.getByText('Start and end are the same').scrollIntoViewIfNeeded();
    await sheetShot(page, 'rules-3-add-error', theme);
    await sheet.getByLabel('To', { exact: true }).fill('07:00');
    await sheet.getByLabel(/Custom message/).fill('Enough study, go outside');
    await sheet.getByRole('button', { name: 'Add rule' }).click();
    await sheet.waitFor({ state: 'detached' });
    await s.getByText('Nudges you once when Uni study reaches 4h in a day').waitFor();
    let ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 1, 'one op for the add');
    assert.equal(ops[0].op.type, 'rule.upsert');
    assert.equal(ops[0].op.payload.thresholdMin, 240);
    assert.equal(ops[0].op.payload.repeatEveryMin, null);
    assert.equal(ops[0].op.payload.quietStart, '22:00');
    assert.equal(ops[0].op.payload.quietEnd, '07:00');
    assert.equal(ops[0].op.payload.message, 'Enough study, go outside');
    const newId = ops[0].op.payload.id;

    // Edit the seeded session rule.
    await s.getByRole('button', { name: /Session limit.*Nudges you after 1h of Relaxing/ }).click();
    const edit = page.getByRole('dialog', { name: 'Edit rule' });
    await edit.waitFor();
    await edit.getByLabel('Nudge after unit').selectOption('min');
    await edit.getByLabel('Nudge after', { exact: true }).fill('45');
    await edit.getByLabel('Every').fill('15');
    await edit.getByText('Nudges you after 45m of Relaxing in a row, then every 15m').waitFor();
    await sheetShot(page, 'rules-4-edit-sheet', theme);
    await edit.getByRole('button', { name: 'Save' }).click();
    await edit.waitFor({ state: 'detached' });
    await s.getByText('Nudges you after 45m of Relaxing in a row, then every 15m').waitFor();
    ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 2, 'one op for the edit');
    assert.equal(ops[1].op.payload.thresholdMin, 45);
    assert.equal(ops[1].op.payload.repeatEveryMin, 15);

    // Toggle the daily rule off from the list.
    await s.getByRole('switch', { name: 'Daily budget for Relaxing' }).click();
    await s.getByText('Daily budget · Off').waitFor();
    ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 3, 'one op for the toggle');
    assert.equal(ops[2].op.payload.enabled, false);
    await shot(s, 'rules-5-list-after', theme);

    // Delete the new rule.
    await s.getByRole('button', { name: /Daily budget.*Uni study reaches 4h/ }).click();
    const del = page.getByRole('dialog', { name: 'Edit rule' });
    await del.getByRole('button', { name: 'Delete rule' }).click();
    await del.getByText('Delete this rule?').waitFor();
    await sheetShot(page, 'rules-6-delete-confirm', theme);
    await del.getByRole('button', { name: 'Delete', exact: true }).click();
    await del.waitFor({ state: 'detached' });
    assert.equal(await s.getByText('Uni study reaches 4h').count(), 0);
    ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 4, 'one op for the delete');
    assert.equal(ops[3].op.payload.id, newId);
    assert.ok(ops[3].op.payload.deletedAt);
    const rules = await idb(page, 'rules');
    assert.ok(rules.find((r) => r.id === newId).deletedAt);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step(`${theme}: archived category rules are greyed`, async () => {
    const { context, page } = await setup(browser, theme, { token: false });
    // Archive Relaxing through the category editor.
    await page.getByRole('button', { name: 'Relaxing', exact: false }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Edit Relaxing' });
    await sheet.getByRole('button', { name: 'Archive' }).click();
    await sheet.waitFor({ state: 'detached' });
    const s = section(page, 'rules');
    await s.getByText('Archived · won’t nudge').waitFor();
    await shot(s, 'rules-7-archived', theme);
    await context.close();
  });

  await step(`${theme}: stale check edits`, async () => {
    const { context, page } = await setup(browser, theme, { token: false });
    const s = section(page, 'stale');
    await s
      .getByText(
        'Asks “Still on it?” when anything except Sleep runs 5h without a switch, then every 1h',
      )
      .waitFor();
    await s.scrollIntoViewIfNeeded();
    await shot(s, 'stale-1-default', theme);
    const opsBefore = (await idb(page, 'outbox')).length;

    await s
      .getByRole('button', { name: /Stale check/ })
      .first()
      .click();
    const sheet = page.getByRole('dialog', { name: 'Still on it?' });
    await sheet.waitFor();
    await sheet.getByLabel('Ask after one stretch of', { exact: true }).fill('4');
    await sheet.getByLabel('Every').fill('');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await sheet.getByText('Enter a whole number of minutes').waitFor();
    await sheet.getByLabel('Every').fill('90');
    await sheet.getByRole('switch', { name: /Quiet hours/ }).click();
    await sheet.getByLabel('From').fill('23:00');
    await sheet.getByLabel('To', { exact: true }).fill('06:30');
    await sheet.getByText('Runs overnight, past midnight.').waitFor();
    await sheetShot(page, 'stale-2-sheet', theme);
    await sheet.getByRole('button', { name: 'Save' }).click();
    await sheet.waitFor({ state: 'detached' });
    await s.getByText('runs 4h without a switch, then every 1h 30m').waitFor();
    await s.getByText('Quiet 23:00–06:30').waitFor();
    let ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op.type, 'settings.upsert');
    assert.equal(ops[0].op.payload.staleAfterMin, 240);
    assert.equal(ops[0].op.payload.staleRepeatMin, 90);
    assert.equal(ops[0].op.payload.staleQuietStart, '23:00');
    assert.equal(ops[0].op.payload.staleQuietEnd, '06:30');
    await shot(s, 'stale-3-edited', theme);

    await s.getByRole('switch', { name: 'Stale check' }).click();
    await s.getByText(/^Off\./).waitFor();
    ops = (await idb(page, 'outbox')).slice(opsBefore);
    assert.equal(ops.length, 2);
    assert.equal(ops[1].op.payload.staleEnabled, false);
    await shot(s, 'stale-4-off', theme);
    await context.close();
  });
}

await browser.close();
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
