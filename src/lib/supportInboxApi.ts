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

// Live updates — RLS scopes what the subscriber receives to their tenant.
// onChange fires on any conversation/message insert or update.
export function subscribeSupport(onChange: () => void): () => void {
  const ch = supabase.channel('support-inbox')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'de_conversations' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'de_messages' }, onChange)
    .subscribe();
  return () => { void supabase.removeChannel(ch); };
}
