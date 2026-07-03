// ============================================================
// Widget & API — publishable widget keys + end-user sessions.
// Keys are generated CLIENT-SIDE (32 random bytes, base64url,
// prefixed dtw_) and shown ONCE; only the SHA-256 hash is stored.
// ============================================================
import { supabase } from '../supabase';
import { SUPABASE_URL } from './env';

export interface WidgetKeyRow {
  id: string;
  tenant_id: string;
  label: string;
  active: boolean;
  request_count: number;
  last_used_at: string | null;
  created_at: string;
}

export interface EndUserSessionRow {
  id: string;
  account_external_ref: string | null;
  end_user_ref: string | null;
  display_name: string | null;
  created_at: string;
  last_seen_at: string;
}

export const WIDGET_ASK_URL = `${SUPABASE_URL}/functions/v1/widget-ask`;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a new publishable widget key. Returns the PLAINTEXT key exactly once —
 *  only its sha256 hash is persisted. */
export async function generateWidgetKey(tenantId: string, label: string): Promise<string | null> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const plaintext = `dtw_${toBase64Url(raw)}`;
  const key_hash = await sha256Hex(plaintext);
  const { error } = await supabase.from('widget_keys').insert({
    tenant_id: tenantId,
    key_hash,
    label: label.trim() || 'Default key',
  });
  if (error) {
    console.error('generateWidgetKey failed:', error.message);
    return null;
  }
  return plaintext;
}

export async function fetchWidgetKeys(tenantId: string): Promise<WidgetKeyRow[]> {
  const { data, error } = await supabase
    .from('widget_keys')
    .select('id, tenant_id, label, active, request_count, last_used_at, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchWidgetKeys failed:', error.message);
    return [];
  }
  return (data ?? []) as WidgetKeyRow[];
}

export async function revokeWidgetKey(keyId: string): Promise<boolean> {
  const { error } = await supabase.from('widget_keys').update({ active: false }).eq('id', keyId);
  if (error) console.error('revokeWidgetKey failed:', error.message);
  return !error;
}

export async function fetchEndUserSessions(tenantId: string, limit = 20): Promise<EndUserSessionRow[]> {
  const { data, error } = await supabase
    .from('end_user_sessions')
    .select('id, account_external_ref, end_user_ref, display_name, created_at, last_seen_at')
    .eq('tenant_id', tenantId)
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('fetchEndUserSessions failed:', error.message);
    return [];
  }
  return (data ?? []) as EndUserSessionRow[];
}
