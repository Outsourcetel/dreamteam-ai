// Support inbox (Phase 2) — the human side of the unified conversation=ticket.
// Reads use RLS (tenant-isolated); writes go through the migration-151 RPCs.
import { supabase } from '../supabase';
import { invokeEdge } from './invokeEdge';
import { requireTenantId } from './liveShared';

export interface SupportConversation {
  id: string;
  channel: string;
  status: 'ai_handling' | 'needs_human' | 'human_owned' | 'resolved';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** The TOPIC a triage rule assigned (mig 233). Null until a rule matches —
   *  measured 2026-08-09: 164 of 455 conversations carry one. */
  category: string | null;
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
  identity_verified: boolean | null;   // T2.3: caller proved their identity (widget HMAC)
  /** Park & snooze (mig 669). Parked is COMPUTED at read time — see
   *  src/lib/supportPark.ts isParked(); these are its two inputs. */
  snoozed_at: string | null;
  snoozed_until: string | null;
  // The newest message on the thread, embedded by the list query. The inbox
  // used to title each row `subject || end_user_name || 'Conversation'`, and
  // chat channels never set a subject — so a screenful of live conversations
  // all read "Conversation" and you had to open each one to find out what it
  // was. This is what the row is actually about.
  last_message?: { content: string; role: 'user' | 'assistant'; created_at: string }[] | null;
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

// The embedded `last_message` rides the de_messages_conversation_id_fkey
// relationship, ordered newest-first and limited to one PER PARENT ROW (that
// is what a foreignTable limit means in PostgREST) — one round trip for the
// whole list, not one per conversation.
// `category` is the TOPIC the triage rules assign (mig 233's set_category) —
// billing, access, how_to, outage… It is NOT a product list, which is why the
// inbox facet built on it is labelled "Topic". See SupportInboxPage.
const CONV_COLS = 'id, channel, status, priority, category, subject, snoozed_at, snoozed_until, detected_language, handoff_summary, end_user_name, account_external_ref, owner_user_id, csat_score, de_id, last_message_at, created_at, identity_verified, last_message:de_messages(content, role, created_at)';

export async function listSupportConversations(status?: SupportConversation['status'] | 'all'): Promise<SupportConversation[]> {
  const tid = await requireTenantId();
  let q = supabase.from('de_conversations').select(CONV_COLS).eq('tenant_id', tid)
    // Customer channels PLUS the in-app assistant dock. Dock chats aren't
    // customer tickets and are tabbed separately in the UI, but excluding
    // them from the fetch meant an escalated internal question had no
    // human-review surface anywhere in the product.
    .in('channel', ['widget', 'hosted', 'portal', 'email', 'dock'])
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false, referencedTable: 'de_messages' })
    .limit(1, { referencedTable: 'de_messages' })
    .limit(200);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as SupportConversation[];
}

// ── "What the DE already checked" (mig 667, handoff 06 §A) ────────────────
// Written by the runtime at escalation time; read-only here (RLS: tenant
// SELECT, no client write policy — fake evidence cannot be backfilled).
export interface ConversationCheck {
  id: string;
  kind: 'knowledge' | 'identity' | 'guardrail' | 'escalation_rule' | 'confidence' | 'connector';
  ok: boolean;
  label: string;
  detail: string | null;
  created_at: string;
}

export async function listConversationChecks(conversationId: string): Promise<ConversationCheck[]> {
  const { data, error } = await supabase.from('conversation_checks')
    .select('id, kind, ok, label, detail, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ConversationCheck[];
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

// ── Park & snooze (mig 669) ──────────────────────────────────────────
// Owner-only (the RPC enforces it — parking someone else's thread would hide
// their work from them). `until` null = parked until the customer replies.
export async function parkConversation(conversationId: string, until: Date | null): Promise<void> {
  const { error } = await supabase.rpc('park_support_conversation', {
    p_conversation_id: conversationId, p_until: until ? until.toISOString() : null,
  });
  if (error) throw new Error(error.message);
}

export async function unparkConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('unpark_support_conversation', { p_conversation_id: conversationId });
  if (error) throw new Error(error.message);
}

// ── G3 handoff completion (mig 257) ──────────────────────────────────

/** Hand the thread back to its DE, optionally teaching it a lesson the DE
 *  recalls on the customer's next message (conversation-scoped memory). */
export async function handoffBackToDe(conversationId: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('handoff_back_to_de', {
    p_conversation_id: conversationId, p_note: note?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

/** A human's free-form reply on an EMAIL conversation — actually delivered
 *  via the send-email-reply edge fn (send first, record after). */
export async function sendEmailReply(conversationId: string, content: string): Promise<void> {
  const tid = await requireTenantId();
  const { data, error } = await invokeEdge('send-email-reply', {
    body: { conversation_id: conversationId, content, tenant_id: tid },
  });
  if (error) throw new Error(error.message);
  const d = data as { ok?: boolean; detail?: string; error?: string } | null;
  if (!d?.ok) throw new Error(d?.detail || d?.error || 'Reply was not sent.');
}

/** The pending DE-drafted email reply for a conversation (mig 179 gate). */
export interface PendingEmailDraft { id: string; human_task_id: string | null; body: string; subject: string | null }
export async function getPendingEmailDraft(conversationId: string): Promise<PendingEmailDraft | null> {
  const tid = await requireTenantId();
  // Includes approved-but-undelivered drafts (delivery blocked on a missing
  // key/from-address) so the inbox can retry the send once Settings is fixed.
  const { data, error } = await supabase.from('outbound_drafts')
    .select('id, human_task_id, body, subject, status, delivery_status')
    .eq('tenant_id', tid).eq('source_kind', 'conversation').eq('source_ref', conversationId)
    .in('status', ['pending_approval', 'approved'])
    .or('delivery_status.is.null,delivery_status.neq.sent')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PendingEmailDraft | null) ?? null;
}

/** Approve a DE's email draft from the inbox — the SAME loop as the
 *  Approvals desk (task decided → send-outbound delivers), plus an optional
 *  edit first. Returns delivery truth so the UI never claims a blocked send. */
export async function approveEmailDraft(
  conversationId: string, draftMessageId: string, editedContent?: string,
): Promise<{ sent: boolean; detail?: string }> {
  const draft = await getPendingEmailDraft(conversationId);
  if (!draft) throw new Error('No pending email draft found for this conversation.');
  const edited = editedContent?.trim();
  if (edited && edited !== draft.body) {
    const { error } = await supabase.rpc('edit_outbound_draft', { p_draft_id: draft.id, p_body: edited });
    if (error) throw new Error(error.message);
  }
  // decideHumanTask's own hook (customerApi, mig 216) attempts delivery on
  // approve and swallows failures — so delivery truth is read from the draft
  // row afterwards, never inferred from a second send call (which would
  // report an already-sent draft as blocked).
  let decided = false;
  if (draft.human_task_id) {
    const { data: task } = await supabase.from('human_tasks').select('*')
      .eq('id', draft.human_task_id).maybeSingle();
    if (task && task.status === 'pending') {
      const { decideHumanTask } = await import('./customerApi');
      await decideHumanTask(task, 'approved');
      decided = true;
    }
  }
  if (!decided) {
    // Task already decided earlier (or task-less draft) — this is a retry of
    // a blocked/failed delivery; send-outbound no-ops if it actually sent.
    const { deliverOutbound } = await import('./commsApi');
    await deliverOutbound(draft.id).catch(() => { /* truth read below */ });
  }
  const { data: after } = await supabase.from('outbound_drafts')
    .select('delivery_status, delivery_error').eq('id', draft.id).maybeSingle();
  const sent = after?.delivery_status === 'sent';
  if (sent) {
    // Only now does the thread bubble flip to "sent" — approve_draft_reply
    // requires delivery='draft_pending', so this is a no-op on re-runs.
    await approveDraft(draftMessageId, edited).catch(() => { /* bubble state only */ });
  }
  const friendly = after?.delivery_status === 'blocked_no_provider'
    ? 'Approved, but email sending is not connected (key or from-address missing) — the reply is saved and can be re-sent from here once Settings → Communications is set up.'
    : after?.delivery_error || undefined;
  return { sent, detail: sent ? undefined : friendly };
}

/** Display name for the conversation's DE (for the hand-back button). */
export async function getDeDisplayName(deId: string): Promise<string> {
  const { data } = await supabase.from('digital_employees')
    .select('persona_name, name').eq('id', deId).maybeSingle();
  return data?.persona_name || data?.name || 'the DE';
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
  /** WHO ANSWERS conversations this rule matches (migration 760), or null for
   *  "the workspace's usual choice" — which is what every rule created before
   *  that migration carries and what every workspace did before it. */
  owner_de_id: string | null;
}

/** List this tenant's triage rules (precedence order). */
export async function listTriageRules(): Promise<TriageRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('support_triage_rules')
    .select('id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, owner_de_id')
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
    // ⚠ mig 760 — THE OTHER HALF OF THE FOUNDER'S DECISION. The interview SEEDS
    // an owner; THIS SCREEN EDITS it, so a customer can change their mind
    // without re-running the interview. `?? null` rather than a conditional
    // spread on purpose: clearing an owner back to "whoever usually answers"
    // has to be something this form can DO, and a spread that skipped undefined
    // would make the field one-way.
    owner_de_id: r.owner_de_id ?? null,
  };
  if (r.id) {
    const { error } = await supabase.from('support_triage_rules').update(row).eq('id', r.id).eq('tenant_id', tid);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('support_triage_rules').insert(row);
    if (error) throw new Error(error.message);
  }
}

/** The DISCOVERY writer: create the triage rule a conversation_type proposal
 *  describes, as the signed-in human under RLS, linked to the proposal that
 *  proposed it. Migration 754's Path B — decide_discovery_proposal verifies this
 *  row and stamps it, and refuses it unless every field below matches the card.
 *
 *  ⚠ SEPARATE FROM upsertTriageRule, and not a flag on it, for two reasons that
 *  both matter. (1) upsertTriageRule defaults rule_order to 100, which COLLIDES
 *  with the baseline "How-to" rule every one of the 18 live workspaces carries
 *  at exactly 100 — classify_support_text orders by (rule_order, created_at) and
 *  returns on the first match, so a defaulted discovery rule loses that tie to a
 *  timestamp no screen shows. This function places the rule in the reserved
 *  200..9998 band instead, which is the band the RPC refuses anything outside
 *  of. (2) source_proposal_id must never be settable from the ordinary editor:
 *  it is the partial-unique key that makes an accept idempotent, and letting the
 *  CRUD form write it would let a hand-edited rule adopt a proposal.
 *
 *  ⚠ FIND-FIRST IS A COURTESY, NOT THE GUARANTEE. The guarantee is
 *  `support_triage_rules_source_proposal_uq` (migration 754), which is what
 *  makes a second insert for the same proposal fail rather than duplicate. This
 *  read turns that failure into a re-use for the ordinary retry — a browser that
 *  died after the insert and before the stamp — the way the guardrail writer's
 *  find does, and unlike that one it can key on an id rather than on a literal.
 *
 *  ⚠ THE POSITION IS CHOSEN, NEVER DEFAULTED, and it is chosen deterministically
 *  from what is already there: one past the highest discovery-sourced rule in
 *  this workspace, floored at 200. Ties between two of the customer's own topics
 *  are possible under a concurrent double-accept and are not refused — the RPC
 *  counts them and the card reports the count. What is refused is landing
 *  outside the band, which is the only ordering fact with a safety consequence:
 *  below 200 a topic from an interview could outrank Safety (10) or Security
 *  (20); at 9999 or above it would sit behind the pattern-less catch-all, which
 *  returns immediately, and could never fire at all. */
export async function createTriageRuleFromProposal(input: {
  proposalId: string;
  name: string;
  matchPattern: string;
  setCategory: string;
  /** The employee the card named, already resolved to an id by the caller, or
   *  null when the card named nobody (migration 760). */
  ownerDeId?: string | null;
}): Promise<{ id: string; rule_order: number; reused: boolean }> {
  const tid = await requireTenantId();

  const { data: existing, error: findErr } = await supabase
    .from('support_triage_rules')
    .select('id, rule_order')
    .eq('tenant_id', tid)
    .eq('source_proposal_id', input.proposalId)
    .limit(1);
  if (findErr) throw new Error(findErr.message);
  if (existing && existing.length > 0) {
    const row = existing[0] as { id: string; rule_order: number };
    return { id: String(row.id), rule_order: Number(row.rule_order), reused: true };
  }

  // ⚠ `.not('source_proposal_id', 'is', null)` is what confines the scan to
  // DISCOVERY rules. Reading max(rule_order) over the whole table would find the
  // 9999 catch-all every workspace has and place the new rule at 10000, behind
  // it — where a pattern-less rule has already returned and nothing below is
  // ever consulted. That is the silent version of the bug this whole band
  // exists to prevent.
  const { data: highest, error: maxErr } = await supabase
    .from('support_triage_rules')
    .select('rule_order')
    .eq('tenant_id', tid)
    .not('source_proposal_id', 'is', null)
    .lte('rule_order', 9998)
    .order('rule_order', { ascending: false })
    .limit(1);
  if (maxErr) throw new Error(maxErr.message);
  const top = highest && highest.length > 0 ? Number((highest[0] as { rule_order: number }).rule_order) : 199;
  const ruleOrder = Math.min(Math.max(200, top + 1), 9998);

  const { data, error } = await supabase
    .from('support_triage_rules')
    .insert({
      tenant_id: tid,
      rule_order: ruleOrder,
      name: input.name,
      match_pattern: input.matchPattern,
      set_category: input.setCategory,
      // ⚠ Priority and severity are NOT the model's and NOT on the card, so they
      // take the column defaults a hand-written rule would take. A topic from an
      // interview must not silently mark a class of traffic urgent: `priority`
      // drives the inbox's own ordering and `severity` is read by the support
      // reports. Nothing the customer consented to on this card said anything
      // about either.
      set_priority: 'normal',
      set_severity: 'sev3',
      active: true,
      source_proposal_id: input.proposalId,
      // ⚠ mig 760 — and this one IS the card's, unlike priority and severity.
      // decide_discovery_proposal compares it byte for byte against the owner
      // the payload named and refuses either mismatch: a rule that routes when
      // the card promised nobody, or a rule that routes nowhere when the card
      // named somebody. Undefined here would be the first of those.
      owner_de_id: input.ownerDeId ?? null,
    })
    .select('id, rule_order')
    .single();
  if (error) throw new Error(error.message);
  return { id: String(data.id), rule_order: Number(data.rule_order), reused: false };
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
