import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Statement } from '../db/client';
import { select } from '../db/queries';
import { serverConfig, type ServerConfigRow } from '../db/schema';
import { decodeBase64Url, encodeBase64Url } from './base64url';

/**
 * VAPID (RFC 8292) keys and subject, with no owner setup required.
 *
 * Keys: the `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` secrets when both are
 * set, otherwise a P-256 pair the Worker generates once and keeps in
 * `server_config`. Both use the format of `npx web-push generate-vapid-keys`:
 * the raw 65-byte public point and the 32-byte private scalar (JWK `d`), each
 * base64url without padding.
 *
 * Subject: the `VAPID_SUBJECT` secret when set, otherwise `https://<host>` of
 * the URL the app last fetched the key or registered a subscription from.
 * Apple requires the JWT `sub` to be a `mailto:` or `https:` URL.
 */

/** `server_config` key of the generated pair, a JSON `{ publicKey, privateKey }`. */
export const VAPID_KEYS_CONFIG_KEY = 'vapid_keys';
/** `server_config` key of the public origin, e.g. `https://time-tracker.example.workers.dev`. */
export const ORIGIN_CONFIG_KEY = 'origin';

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes starting 0x04), base64url. */
  publicKey: string;
  /** Private scalar (32 bytes), base64url. Never leaves the Worker. */
  privateKey: string;
}

export interface Vapid extends VapidKeys {
  /** JWT `sub`: a `mailto:` or `https:` URL. */
  subject: string;
}

/** The optional secrets that override the generated keys and the derived subject. */
export interface VapidEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export type VapidKeySource = 'env' | 'stored' | 'generated';

function logError(message: string): void {
  console.error(JSON.stringify({ level: 'error', event: 'vapid', message }));
}

/**
 * A key pair in canonical form (base64url, no padding), or null when the
 * public key is not an uncompressed P-256 point or the private key is not
 * 32 bytes. Accepts plain base64 and padding too.
 */
export function normalizeVapidKeys(publicKey: string, privateKey: string): VapidKeys | null {
  const pub = decodeBase64Url(publicKey.trim());
  const priv = decodeBase64Url(privateKey.trim());
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) return null;
  if (!priv || priv.length !== 32) return null;
  return { publicKey: encodeBase64Url(pub), privateKey: encodeBase64Url(priv) };
}

/** Keys from the secrets when both are set and well formed. */
export function envVapidKeys(env: VapidEnv): VapidKeys | null {
  const pub = env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const priv = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  if (pub === '' || priv === '') return null;
  const keys = normalizeVapidKeys(pub, priv);
  if (!keys) logError('VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is malformed; using the stored pair');
  return keys;
}

export function configValue(rows: readonly ServerConfigRow[], key: string): string | null {
  return rows.find((r) => r.key === key)?.value ?? null;
}

const storedKeysSchema = z.object({ publicKey: z.string(), privateKey: z.string() });

/** The generated pair from `server_config`, or null before one exists. */
export function storedVapidKeys(rows: readonly ServerConfigRow[]): VapidKeys | null {
  const raw = configValue(rows, VAPID_KEYS_CONFIG_KEY);
  if (raw === null) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Reported below.
  }
  const parsed = storedKeysSchema.safeParse(json);
  const keys = parsed.success
    ? normalizeVapidKeys(parsed.data.publicKey, parsed.data.privateKey)
    : null;
  if (!keys) {
    // Only a hand edit gets here. Deleting the row makes the Worker generate a new pair.
    throw new Error(`server_config ${VAPID_KEYS_CONFIG_KEY} is malformed`);
  }
  return keys;
}

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
  return 'privateKey' in key && 'publicKey' in key;
}

/** A new ECDSA P-256 pair in the `web-push generate-vapid-keys` format. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  if (!isKeyPair(pair)) throw new Error('generateKey did not return a key pair');
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!('byteLength' in raw)) throw new Error('exportKey raw did not return bytes');
  const d = 'byteLength' in jwk ? undefined : jwk.d;
  if (typeof d !== 'string') throw new Error('exportKey jwk has no private scalar');
  const keys = normalizeVapidKeys(encodeBase64Url(raw), d);
  if (!keys) throw new Error('Generated VAPID keys are malformed');
  return keys;
}

/**
 * The keys to sign with: the secrets, else the stored pair, else a new pair.
 * A new pair is written with INSERT ... ON CONFLICT DO NOTHING and read back in
 * the same batch (one D1 call), so two first requests racing each other both
 * end up with whichever pair committed first.
 *
 * `configRows` is the `server_config` table as the caller already read it.
 */
export async function resolveVapidKeys(
  db: Db,
  env: VapidEnv,
  configRows: readonly ServerConfigRow[],
  now: string,
): Promise<{ keys: VapidKeys; source: VapidKeySource }> {
  const fromEnv = envVapidKeys(env);
  if (fromEnv) return { keys: fromEnv, source: 'env' };
  const stored = storedVapidKeys(configRows);
  if (stored) return { keys: stored, source: 'stored' };

  const fresh = await generateVapidKeys();
  const [, rows] = await db.batch([
    db
      .insert(serverConfig)
      .values({ key: VAPID_KEYS_CONFIG_KEY, value: JSON.stringify(fresh), updatedAt: now })
      .onConflictDoNothing({ target: serverConfig.key }),
    select.serverConfig(db),
  ]);
  const winner = storedVapidKeys(rows);
  if (!winner) throw new Error('VAPID keys were not stored');
  return { keys: winner, source: 'generated' };
}

/** `https://<host>` of a request URL, the default VAPID subject. */
export function originOf(requestUrl: string): string {
  return `https://${new URL(requestUrl).host}`;
}

/**
 * Remember the origin the app is served from. Writes only when it changed.
 * Meant to share a batch with the read that follows it.
 */
export function recordOrigin(db: Db, requestUrl: string, now: string): Statement {
  return db
    .insert(serverConfig)
    .values({ key: ORIGIN_CONFIG_KEY, value: originOf(requestUrl), updatedAt: now })
    .onConflictDoUpdate({
      target: serverConfig.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      setWhere: sql`${serverConfig.value} <> excluded.value`,
    });
}

function isValidSubject(s: string): boolean {
  return /^mailto:\S+$/i.test(s) || /^https:\/\/\S+$/i.test(s);
}

/** `VAPID_SUBJECT`, else the recorded origin, else null (nothing has been registered yet). */
export function vapidSubject(env: VapidEnv, configRows: readonly ServerConfigRow[]): string | null {
  const fromEnv = env.VAPID_SUBJECT?.trim() ?? '';
  if (fromEnv !== '') {
    if (isValidSubject(fromEnv)) return fromEnv;
    logError('VAPID_SUBJECT must be a mailto: or https: URL; using the recorded origin');
  }
  return configValue(configRows, ORIGIN_CONFIG_KEY);
}

/** Keys and subject together, or null when there is no subject yet. */
export async function resolveVapid(
  db: Db,
  env: VapidEnv,
  configRows: readonly ServerConfigRow[],
  now: string,
): Promise<Vapid | null> {
  const subject = vapidSubject(env, configRows);
  if (subject === null) return null;
  const { keys } = await resolveVapidKeys(db, env, configRows, now);
  return { ...keys, subject };
}
