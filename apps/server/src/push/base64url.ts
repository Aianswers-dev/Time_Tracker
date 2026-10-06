/**
 * Base64url (RFC 4648 §5) without padding, the encoding Web Push uses for
 * keys. `atob` and `btoa` exist in workerd and Node 22.
 */

export function encodeBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url or plain base64, padded or not. Null when `text` is neither. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  const base64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (base64.length % 4 === 1) return null;
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
