import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, isUncompressedP256, sameBytes } from './base64';

describe('base64url', () => {
  it('decodes unpadded and padded input', () => {
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes('AQI')]).toEqual([1, 2]);
    expect([...base64UrlToBytes('AQI=')]).toEqual([1, 2]);
    expect([...base64UrlToBytes('AQ')]).toEqual([1]);
    expect([...base64UrlToBytes('AQ==')]).toEqual([1]);
    expect([...base64UrlToBytes('')]).toEqual([]);
  });

  it('uses the URL-safe alphabet', () => {
    // 0xfb 0xff 0xbf is "+/+/" in standard base64 and "-_-_" in base64url.
    expect([...base64UrlToBytes('-_-_')]).toEqual([0xfb, 0xff, 0xbf]);
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(() => base64UrlToBytes('+/+/')).toThrow();
  });

  it('rejects input that is not base64url', () => {
    expect(() => base64UrlToBytes('a b')).toThrow();
    expect(() => base64UrlToBytes('abcde')).toThrow(); // A single leftover character.
    expect(() => base64UrlToBytes('ab==cd')).toThrow();
  });

  it('round-trips a VAPID public key', () => {
    // A real P-256 public key from the web-push docs.
    const key =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const bytes = base64UrlToBytes(key);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(65);
    expect(bytes[0]).toBe(0x04);
    expect(isUncompressedP256(bytes)).toBe(true);
    expect(bytesToBase64Url(bytes)).toBe(key);
    expect(bytesToBase64Url(bytes.buffer)).toBe(key);
  });

  it('checks the key shape', () => {
    expect(isUncompressedP256(new Uint8Array(65))).toBe(false);
    expect(isUncompressedP256(new Uint8Array([4, 1, 2]))).toBe(false);
  });

  it('compares keys byte for byte across buffer types', () => {
    const a = new Uint8Array([4, 5, 6]);
    expect(sameBytes(a, a.buffer)).toBe(true);
    expect(sameBytes(a, new Uint8Array([4, 5, 7]))).toBe(false);
    const view = new Uint8Array([9, 4, 5, 6]).subarray(1);
    expect(sameBytes(a, view)).toBe(true);
  });
});
