// The VAPID key conversion — wrong output = an opaque subscribe DOMException.
import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array, VAPID_PUBLIC_KEY } from '../src/lib/pushKeys';

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url (with - and _) and pads correctly', () => {
    // 'abc-_9' style vectors: compare against Buffer's own base64url decoder.
    for (const v of ['AQID', 'AQIDBA', '-_-_', 'SGVsbG8', VAPID_PUBLIC_KEY]) {
      expect(Array.from(urlBase64ToUint8Array(v))).toEqual(Array.from(Buffer.from(v, 'base64url')));
    }
  });
  it('our real public key decodes to 65 bytes starting 0x04 — an uncompressed P-256 point, which is what the Push API requires', () => {
    const k = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    expect(k.length).toBe(65);
    expect(k[0]).toBe(0x04);
  });
});
