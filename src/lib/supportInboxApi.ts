// Support inbox (Phase 2) — the human side of the unified conversation=ticket.
// Reads use RLS (tenant-isolated); writes go through the migration-151 RPCs.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export interface SupportConversation {
  id: string;
  channel: string;
  status: 'ai_handling' | 'needs_human' | 'human_owned' | 'resolved';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  subject: string | null;
  detected_language: string | null;
  handoff_summary: string | null;
  end_user_name: string | null;
  account_external_ref: string | null;
  owner_user_id: string | null;
  csat_score: number | null;
  de_id: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  confidence: number | null;
  escalated: boolean;
  delivery: 'sent' | 'draft_pending' | 'blocked';
  lang: string | null;
  created_at: string;
}

const CONV_COLS = 'id, channel, status, priority, subject, detected_language, handoff_summary, end_user_name, account_external_ref, owner_user_id, csat_score, de_id, last_message_at, created_at';

export async function listSupportConversations(status?: SupportConversation['status'] | 'all'): Promise<SupportConversation[]> {
  const tid = await requireTenantId();
  let q = supabase.from('de_conversations').select(CONV_COLS).eq('tenant_id', tid)
    // Customer channels PLUS the in-app assistant dock. Dock chats aren't
    // customer tickets and are tabbed separately in the UI, but excluding
    // them from the fetch meant an escalated internal question had no
    // human-review surface anywhere in the product.
    .in('channel', ['widget', 'hosted', 'portal', 'email', 'dock'])
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as SupportConversation[];
}

export async function getConversationThread(conversationId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase.from('de_messages')
    .select('id, conversation_id, role, content, confidence, escalated, delivery, lang, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SupportMessage[];
}

export async function claimConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('claim_support_conversation', { p_conversation_id: conversationId });
  if (error) throw new Error(error.message);
}

export async function sendHumanReply(conversationId: string, content: string): Promise<void> {
  const { error } = await supabase.rpc('send_human_reply', { p_conversation_id: conversationId, p_content: content });
  if (error) throw new Error(error.message);
}

export async function approveDraft(messageId: string, editedContent?: string): Promise<void> {
  const { error } = await supabase.rpc('approve_draft_reply', { p_message_id: messageId, p_edited_content: editedContent ?? null });
  if (error) throw new Error(error.message);
}

export async function setConversationState(conversationId: string, state: { status?: SupportConversation['status']; priority?: SupportConversation['priority'] }): Promise<void> {
  const { error } = await supabase.rpc('set_support_conversation_state', {
    p_conversation_id: conversationId, p_status: state.status ?? null, p_priority: state.priority ?? null,
  });
  if (error) throw new Error(error.message);
}

// ── Support Command Center — operator-wide aggregates ────────────────
export interface SupportOverview {
  total: number;
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  byPriority: Record<string, number>;
  bySeverity: Record<string, number>;   // empty when triage (mig 233) isn't applied
  byCategory: Record<string, number>;   // empty when triage isn't applied
  needsHuman: number;
  openEscalations: number;
  draftsPending: number;
  triageEnabled: boolean;
}

type OverviewRow = { status?: string | null; channel?: string | null; priority?: string | null; category?: string | null; severity?: string | null };
const SUPPORT_CHANNELS = ['widget', 'hosted', 'portal', 'email', 'dock'];

/** Tenant-wide support aggregates for the Command Center. Resilient: if the
 *  triage columns (mig 233) aren't applied yet, severity/category come back
 *  empty and triageEnabled=false rather than erroring. */
export async function getSupportOverview(): Promise<SupportOverview> {
  const tid = await requireTenantId();
  let rows: OverviewRow[] = [];
  let triageEnabled = true;

  const withTriage = await supabase.from('de_conversations')
    .select('status, channel, priority, category, severity')
    .eq('tenant_id', tid).in('channel', SUPPORT_CHANNELS).limit(1000);
  if (withTriage.error) {
    triageEnabled = false;
    const base = await supabase.from('de_conversations')
      .select('status, channel, priority')
      .eq('tenant_id', tid).in('channel', SUPPORT_CHANNELS).limit(1000);
    if (base.error) throw new Error(base.error.message);
    rows = (base.data ?? []) as OverviewRow[];
  } else {
    rows = (withTriage.data ?? []) as OverviewRow[];
  }

  const countBy = (sel: (r: OverviewRow) => string | null | undefined) =>
    rows.reduce<Record<string, number>>((m, r) => { const k = sel(r) ?? 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});

  const byStatus = countBy((r) => r.status);

  let openEscalations = 0;
  try {
    const { count } = await supabase.from('human_tasks').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('type', 'escalation').eq('status', 'pending');
    openEscalations = count ?? 0;
  } catch { /* tolerate */ }

  let draftsPending = 0;
  try {
    const { count } = await supabase.from('de_messages').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('delivery', 'draft_pending');
    draftsPending = count ?? 0;
  } catch { /* tolerate */ }

  return {
    total: rows.length,
    byStatus,
    byChannel: countBy((r) => r.channel),
    byPriority: countBy((r) => r.priority),
    bySeverity: triageEnabled ? countBy((r) => r.severity) : {},
    byCategory: triageEnabled ? countBy((r) => r.category) : {},
    needsHuman: byStatus['needs_human'] ?? 0,
    openEscalations,
    draftsPending,
    triageEnabled,
  };
}

// ── Support triage rules — config editor (mig 233) ───────────────────
export interface TriageRule {
  id: string;
  rule_order: number;
  name: string;
  match_pattern: string | null;
  set_category: string;
  set_priority: 'low' | 'normal' | 'high' | 'urgent';
  set_severity: string;
  active: boolean;
}

/** List this tenant's triage rules (precedence order). */
export async function listTriageRules(): Promise<TriageRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('support_triage_rules')
    .select('id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active')
    .eq('tenant_id', tid)
    .order('rule_order', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TriageRule[];
}

/** Create or update a triage rule (RLS restricts writes to owner/admin/manager). */
export async function upsertTriageRule(r: Partial<TriageRule> & { name: string; set_category: string }): Promise<void> {
  const tid = await requireTenantId();
  const row = {
    tenant_id: tid,
    rule_order: r.rule_order ?? 100,
    name: r.name.trim(),
    match_pattern: r.match_pattern?.trim() || null,
    set_category: r.set_category.trim(),
    set_priority: r.set_priority ?? 'normal',
    set_severity: (r.set_severity || 'sev3').trim(),
    active: r.active ?? true,
  };
  if (r.id) {
    const { error } = await supabase.from('support_triage_rules').update(row).eq('id', r.id).eq('tenant_id', tid);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('support_triage_rules').insert(row);
    if (error) throw new Error(error.message);
  }
}

export async function deleteTriageRule(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('support_triage_rules').delete().eq('id', id).eq('tenant_id', tid);
  if (error) throw new Error(error.message);
}

// Live updates — RLS scopes what the subscriber receives to their tenant.
// onChange fires on any conversation/message insert or update.
export function subscribeSupport(onChange: () => void): () => void {
  const ch = supabase.channel('support-inbox')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'de_conversations' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'de_messages' }, onChange)
    .subscribe();
  return () => { void supabase.removeChannel(ch); };
}
