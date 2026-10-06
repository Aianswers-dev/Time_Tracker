/**
 * base64url (RFC 4648 section 5) helpers for the VAPID public key. The key
 * arrives from `GET /api/push/vapid-public-key` as text and
 * `pushManager.subscribe` wants the raw bytes.
 */

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Decode base64url, with or without padding. Throws on anything else. */
export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.trim();
  if (!BASE64URL.test(clean)) throw new Error('Not base64url');
  const b64 = clean.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) throw new Error('Not base64url');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode bytes as unpadded base64url. */
export function bytesToBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An uncompressed P-256 public key: 0x04 followed by the 32-byte X and Y coordinates. */
export function isUncompressedP256(bytes: Uint8Array): boolean {
  return bytes.length === 65 && bytes[0] === 0x04;
}

/** True when two keys hold the same bytes. */
export function sameBytes(
  a: ArrayBuffer | ArrayBufferView,
  b: ArrayBuffer | ArrayBufferView,
): boolean {
  return bytesToBase64Url(a) === bytesToBase64Url(b);
}
