// Communications — the DE's voice (EXEC 0.4).
//
// A DE drafts outbound messages (outbound_drafts); approving an email draft now
// DELIVERS it via Resend (send-outbound edge fn), instead of a human copying it
// by hand. Email stays draft-for-approval — nothing sends without a person.
// Also: per-tenant sending identity, and the deliverables (reports) DEs produce.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export interface CommsSettings { from_email: string | null; from_name: string | null }

export async function getCommsSettings(): Promise<CommsSettings> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('tenant_comms_settings')
    .select('from_email, from_name').eq('tenant_id', tid).maybeSingle();
  if (error) throw new Error(error.message);
  return { from_email: data?.from_email ?? null, from_name: data?.from_name ?? null };
}

export async function setCommsSettings(fromEmail: string, fromName: string): Promise<void> {
  const { data, error } = await supabase.rpc('set_tenant_comms_settings', { p_from_email: fromEmail, p_from_name: fromName });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) {
    const e = res?.error;
    throw new Error(e === 'bad_email' ? 'That is not a valid email address.'
      : e === 'admin_role_required' ? 'Only a workspace owner or admin can set this.'
      : error?.message || e || 'Could not save.');
  }
}

/** Deliver an approved outbound draft (email → Resend). Returns a plain result. */
export async function deliverOutbound(draftId: string): Promise<{ sent: boolean; blocked: boolean; detail?: string }> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.functions.invoke('send-outbound', { body: { draft_id: draftId, tenant_id: tid } });
  if (error) throw new Error(error.message);
  const d = data as { ok?: boolean; sent?: boolean; blocked?: boolean; skipped?: boolean; detail?: string; note?: string } | null;
  return { sent: !!d?.sent, blocked: !!d?.blocked, detail: d?.detail ?? d?.note };
}

export interface Deliverable {
  id: string;
  de_id: string | null;
  objective_id: string | null;
  title: string;
  kind: 'report' | 'summary' | 'memo' | 'analysis' | 'review';
  format: string;
  content: string;
  created_at: string;
}

/** Documents a DE produced for human review (QBR prep, variance report, …). */
export async function listDeliverables(deId: string, limit = 30): Promise<Deliverable[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('de_deliverables')
    .select('id, de_id, objective_id, title, kind, format, content, created_at')
    .eq('tenant_id', tid).eq('de_id', deId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as Deliverable[];
}
