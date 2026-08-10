// Pure half of pushClient — importable by node tests (pushClient itself
// drags in the supabase client and cannot be).

/** Public by design — the private half lives only in the sender's secrets. */
export const VAPID_PUBLIC_KEY =
  'BLiCjli0PmNHJ1HMjTxCFyiaBo_jn0pEHSocnBosjvE62FHtN9rMFIlMq1k2vyRG3M82kkaYThXGi9ie6a5cBM0';

/** Standard VAPID key conversion: base64url → the Uint8Array PushManager
 *  wants. Pinned by a test — a wrong conversion fails subscribe with an
 *  opaque DOMException, which is a miserable thing to debug live. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
