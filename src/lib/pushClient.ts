// ── pushClient — one device saying yes to pings (spec 2026-08-10) ──────────
// The subscription dance is browser-standard Web Push: register the service
// worker, ask permission (must be inside a user gesture), subscribe with our
// VAPID public key, store the endpoint row the sender will use. The row is
// owner-only under RLS; deleting it (or unsubscribing) silences this device.
//
// ⚠ iOS: Apple only delivers Web Push to apps INSTALLED to the home screen
// (iOS 16.4+). In plain Safari the API simply isn't there, so the UI must
// say "add to home screen first" rather than showing a button that cannot
// work. That detection lives here so the component stays layout-only.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from './pushKeys';
export { VAPID_PUBLIC_KEY };

export type PushState =
  | 'unsupported'          // no service worker / Push API in this browser
  | 'ios_needs_install'    // iPhone Safari, not installed to home screen
  | 'denied'               // permission refused at the browser level
  | 'off'                  // supported, not subscribed on this device
  | 'on';                  // this device is registered

export async function getPushState(): Promise<PushState> {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // On iOS the API's absence usually MEANS "not installed" — say the
    // actionable thing, not the dead-end one.
    return isIos && !standalone ? 'ios_needs_install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? 'on' : 'off';
}

/** Must be called from a click handler — browsers require the permission
 *  prompt to ride a user gesture. */
export async function enablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
  });
  const j = sub.toJSON();
  const tid = await requireTenantId();
  const { data: u } = await supabase.auth.getUser();
  // Upsert on the endpoint: re-enabling the same device updates its row
  // rather than minting a duplicate the sender would double-ping.
  const { error } = await supabase.from('push_subscriptions').upsert({
    tenant_id: tid,
    user_id: u.user?.id,
    endpoint: sub.endpoint,
    p256dh: j.keys?.p256dh ?? '',
    auth_key: j.keys?.auth ?? '',
    ua: navigator.userAgent.slice(0, 200),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) {
    // The browser now believes it is subscribed but the sender has no row —
    // unwind so the toggle never lies about what will actually happen.
    await sub.unsubscribe().catch(() => undefined);
    throw new Error(error.message);
  }
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe().catch(() => undefined);
  }
  return 'off';
}
