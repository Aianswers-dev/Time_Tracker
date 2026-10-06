// Full-stack check of the nudge chain against `wrangler dev` on :8790.
import { webcrypto } from 'node:crypto';

const shared = await import('../../../packages/shared/src/index.ts');
const { SEED_CATEGORIES, SEED_RULES, SEED_CATEGORY_IDS, defaultSettings, uuidv7, opSchema } =
  shared;

const BASE = 'http://localhost:8790';
const H = { Authorization: 'Bearer it-token', 'Content-Type': 'application/json' };
const now = new Date().toISOString();

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function op(type: string, payload: unknown) {
  return opSchema.parse({ opId: uuidv7(), createdAt: now, type, payload });
}

// 1. The phone's first sync: settings, seed categories, and a 1-minute session rule on Relaxing.
const rule = {
  ...SEED_RULES[0],
  id: uuidv7(),
  thresholdMin: 1,
  repeatEveryMin: null,
  updatedAt: now,
  createdAt: now,
};
const ops = [
  op('settings.upsert', defaultSettings('Australia/Sydney')),
  ...SEED_CATEGORIES.map((c: unknown) => op('category.upsert', c)),
  op('rule.upsert', rule),
];
let pending = ops;
while (pending.length) {
  const r = await call('/api/ops', { method: 'POST', body: JSON.stringify({ ops: pending }) });
  if (r.status !== 200) throw new Error(`ops ${r.status} ${JSON.stringify(r.body)}`);
  const bad = r.body.results.filter((x: { ok: boolean }) => !x.ok);
  if (bad.length) throw new Error(`refused: ${JSON.stringify(bad)}`);
  pending = pending.slice(r.body.results.length);
}
console.log('ops applied:', ops.length);

// 2. A Shortcut switch to Relaxing, backdated 3 minutes.
const sw = await call('/api/switch', {
  method: 'POST',
  body: JSON.stringify({
    categoryName: 'relaxing',
    at: new Date(Date.now() - 3 * 60_000).toISOString(),
  }),
});
console.log('switch:', sw.status, sw.body.message);

// 3. A push subscription with real P-256 keys (the endpoint is unreachable on purpose).
const key = await call('/api/push/vapid-public-key');
console.log('vapid key bytes:', Buffer.from(key.body.key, 'base64url').length);
const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
]);
const p256dh = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'base64url',
);
const auth = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
const sub = await call('/api/push/subscriptions', {
  method: 'POST',
  body: JSON.stringify({
    endpoint: 'https://push.invalid/it-test',
    expirationTime: null,
    keys: { p256dh, auth },
    userAgent: 'it',
  }),
});
console.log('subscription:', sub.status, sub.body);

// 4. State as the widget sees it.
const state = await call('/api/state');
console.log('state:', state.body.open?.category.name, state.body.open?.elapsedMin, 'min');
console.log(
  'relaxing id matches seed:',
  state.body.open?.category.id === SEED_CATEGORY_IDS.relaxing,
);
