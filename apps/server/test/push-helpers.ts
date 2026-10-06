import { uuidv7 } from '@time-tracker/shared';
import { decodeBase64Url, encodeBase64Url } from '../src/push/base64url';

/**
 * Test-side Web Push: a browser's subscription (an ECDH P-256 key pair and an
 * auth secret) and an RFC 8291 decryptor written independently of the library
 * under test, using WebCrypto's own HKDF.
 */

const utf8 = new TextEncoder();

export function bytes(text: string): Uint8Array {
  const out = decodeBase64Url(text.replace(/\s+/g, ''));
  if (!out) throw new Error(`Not base64url: ${text}`);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The user agent's ECDH private key, to decrypt what was sent. */
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  authSecret: Uint8Array;
}

/** What `PushSubscription.toJSON()` gives a page, plus the private half for decrypting. */
export async function makeBrowserSubscription(
  endpoint = `https://web.push.apple.com/${uuidv7()}`,
): Promise<BrowserSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint,
    keys: { p256dh: encodeBase64Url(publicKey), auth: encodeBase64Url(authSecret) },
    privateKey: pair.privateKey,
    publicKey,
    authSecret,
  };
}

/** A user agent private key from its raw scalar and public point (RFC 8291 Appendix A). */
export async function importEcdhPrivateKey(d: string, publicPoint: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(publicPoint.slice(1, 33)),
      y: encodeBase64Url(publicPoint.slice(33, 65)),
      d,
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const algorithm = { name: 'HKDF', hash: 'SHA-256', salt, info };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, key, length * 8));
}

export interface DecryptedPush {
  plaintext: string;
  recordSize: number;
  /** The sender's ephemeral ECDH public key (the header's key id). */
  senderPublicKey: Uint8Array;
}

/** RFC 8291 §3 and RFC 8188: decrypt a single-record aes128gcm body as the user agent. */
export async function decryptPushBody(
  body: Uint8Array,
  ua: { privateKey: CryptoKey; publicKey: Uint8Array; authSecret: Uint8Array },
): Promise<DecryptedPush> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20] ?? 0;
  const senderPublicKey = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);

  const senderKey = await crypto.subtle.importKey(
    'raw',
    senderPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // Node names the peer key `public`; workers-types calls it `$public`.
  const ecdh = { name: 'ECDH', public: senderKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ua.privateKey, 256));

  const keyInfo = concat(utf8.encode('WebPush: info\0'), ua.publicKey, senderPublicKey);
  const ikm = await hkdf(ua.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext),
  );
  // The last record ends with 0x02 followed only by zero padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error('No last-record delimiter');
  return {
    plaintext: new TextDecoder().decode(padded.slice(0, end)),
    recordSize,
    senderPublicKey,
  };
}

export interface VerifiedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** Check an ES256 JWT's signature against a raw P-256 public key; throws when it does not verify. */
export async function verifyEs256Jwt(jwt: string, publicKey: string): Promise<VerifiedJwt> {
  const [h, p, s] = jwt.split('.');
  if (h === undefined || p === undefined || s === undefined) throw new Error('Not a JWT');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes(s),
    utf8.encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('JWT signature does not verify');
  const json = (part: string) =>
    JSON.parse(new TextDecoder().decode(bytes(part))) as Record<string, unknown>;
  return { header: json(h), claims: json(p) };
}
