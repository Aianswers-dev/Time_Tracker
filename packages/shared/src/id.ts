/** Web Crypto, present in browsers, Workers and Node 22. Declared here because this package has no DOM types. */
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/**
 * UUID v7 (RFC 9562): 48-bit Unix millisecond timestamp, version 7, then random bits.
 * Ids sort roughly by creation time, which keeps database indexes tidy.
 *
 * Uses crypto.getRandomValues, available in browsers, Cloudflare Workers and Node 22.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Timestamp, big-endian, in the first 6 bytes. Division keeps it exact past 2^32.
  let ts = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
