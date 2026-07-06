import { supabase } from '../supabase';

// =====================================================
// TYPES â mirror the Supabase schema
// =====================================================
export interface DBTenant {
  id: string;
  name: string;
  slug: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: 'active' | 'suspended' | 'trial';
  industry?: string;
  accent_color?: string;
  logo_url?: string;
  settings?: Record<string, unknown>;
  monthly_token_budget?: number;
  created_at: string;
  updated_at: string;
}

interface DBProfile {
  id: string;
  user_id: string;
  tenant_id?: string;
  full_name?: string;
  avatar?: string;
  role: string;
  layer: 'platform' | 'tenant';
  is_active: boolean;
  last_seen_at?: string;
  created_at: string;
}

interface DBKnowledgeArticle {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  summary?: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  audience: 'internal' | 'customer' | 'both';
  category?: string;
  tags?: string[];
  product?: string;
  module?: string;
  quality_score: number;
  freshness_score: number;
  view_count: number;
  helpful_count: number;
  not_helpful_count: number;
  created_by?: string;
  published_at?: string;
  created_at: string;
  updated_at: string;
}

interface DBConversation {
  id: string;
  tenant_id: string;
  channel: 'chat' | 'email' | 'phone' | 'api';
  status: 'open' | 'pending' | 'resolved' | 'escalated' | 'closed';
  subject?: string;
  customer_name?: string;
  customer_email?: string;
  assigned_to?: string;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'urgent';
  confidence_score?: number;
  resolution_type?: string;
  tags?: string[];
  opened_at: string;
  resolved_at?: string;
  created_at: string;
}

interface DBMessage {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'agent' | 'ai' | 'system';
  content: string;
  confidence_score?: number;
  sources?: unknown[];
  requires_approval: boolean;
  created_at: string;
}

// =====================================================
// TENANT QUERIES
// =====================================================
export const updateTenant = async (
  id: string,
  updates: Partial<Pick<DBTenant, 'name' | 'industry' | 'accent_color'>>
): Promise<boolean> => {
  const { error } = await supabase
    .from('tenants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { console.error('updateTenant:', error.message); return false; }
  return true;
};

export const fetchTenants = async (): Promise<DBTenant[]> => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('fetchTenants:', error.message); return []; }
  return data ?? [];
};

export const fetchTenantById = async (id: string): Promise<DBTenant | null> => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .single();
  if (error) { console.error('fetchTenantById:', error.message); return null; }
  return data;
};

// =====================================================
// PROFILE QUERIES
// =====================================================
export const fetchMyProfile = async (): Promise<DBProfile | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (error) { console.error('fetchMyProfile:', error.message); return null; }
  return data;
};

export interface CompleteSignupResult {
  ok: boolean;
  tenant_id?: string;
  slug?: string;
  name?: string;
  error?: string;
  detail?: string;
}

// Provisions a real tenant for the currently-authenticated caller and links
// it to their own profile. Runs server-side via a SECURITY DEFINER RPC
// (migration 049) — this is the ONLY correct place tenant creation happens;
// see LoginPage.tsx and AuthContext.tsx for why the old client-side
// `tenants` insert at signup time never worked.
export const completeSignup = async (orgName: string, industry: string): Promise<CompleteSignupResult> => {
  const { data, error } = await supabase.rpc('complete_signup', {
    p_org_name: orgName,
    p_industry: industry,
  });
  if (error) return { ok: false, error: 'rpc_error', detail: error.message };
  return data as CompleteSignupResult;
};

// =====================================================
// KNOWLEDGE ARTICLE QUERIES
// =====================================================
// =====================================================
// CONVERSATION QUERIES
// =====================================================
const createConversation = async (
  conv: Partial<DBConversation> & { tenant_id: string; channel: DBConversation['channel'] }
): Promise<DBConversation | null> => {
  const { data, error } = await supabase
    .from('conversations')
    .insert(conv)
    .select()
    .single();
  if (error) { console.error('createConversation:', error.message); return null; }
  return data;
};

const addMessage = async (
  msg: Omit<DBMessage, 'id' | 'created_at'>
): Promise<DBMessage | null> => {
  const { data, error } = await supabase
    .from('messages')
    .insert(msg)
    .select()
    .single();
  if (error) { console.error('addMessage:', error.message); return null; }
  return data;
};

// =====================================================
// PLATFORM CONFIG (API keys stored in DB, platform-admin only)
// platform_config holds platform-wide secrets (LLM provider keys, email
// provider keys, per-tenant alert emails). RLS is deny-all for
// anon/authenticated (service_role only) as of the security audit — the
// table previously had RLS disabled entirely with default anon/authenticated
// grants, meaning anyone with the public anon key could read every secret
// in it with zero authentication (confirmed live during the audit). These
// helpers now go through SECURITY DEFINER RPCs that internally re-check
// is_platform_admin() before touching the table, rather than hitting
// platform_config directly from the client.
// =====================================================
export const savePlatformConfig = async (entries: Record<string, string>): Promise<boolean> => {
  const { error } = await supabase.rpc('platform_config_set', { p_entries: entries });
  if (error) { console.error('savePlatformConfig:', error.message); return false; }
  return true;
};

export const hasPlatformConfigKey = async (key: string): Promise<boolean> => {
  const { data, error } = await supabase.rpc('platform_config_has_key', { p_key: key });
  if (error) return false;
  return !!data;
};

// =====================================================
// TENANT AI USAGE
// =====================================================
export interface TenantUsage {
  tenant_id: string;
  year_month: string;
  tokens_used: number;
}

export const fetchAllTenantsUsage = async (): Promise<TenantUsage[]> => {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const { data, error } = await supabase
    .from('tenant_ai_usage')
    .select('tenant_id, year_month, tokens_used')
    .eq('year_month', yearMonth);
  if (error) { console.error('fetchAllTenantsUsage:', error.message); return []; }
  return data ?? [];
};

export const updateTenantBudget = async (tenantId: string, monthlyTokenBudget: number): Promise<boolean> => {
  const { error } = await supabase
    .from('tenants')
    .update({ monthly_token_budget: monthlyTokenBudget, updated_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) { console.error('updateTenantBudget:', error.message); return false; }
  return true;
};

// =====================================================
// DASHBOARD STATS
// =====================================================
export const fetchDashboardStats = async (tenantId: string) => {
  const [convResult, kbResult, actionResult] = await Promise.all([
    supabase.from('conversations').select('status, sentiment, channel').eq('tenant_id', tenantId),
    supabase.from('knowledge_articles').select('status').eq('tenant_id', tenantId),
    supabase.from('agent_actions').select('status, requires_approval').eq('tenant_id', tenantId),
  ]);

  const convs = convResult.data ?? [];
  const articles = kbResult.data ?? [];
  const actions = actionResult.data ?? [];

  return {
    totalConversations: convs.length,
    openConversations: convs.filter(c => c.status === 'open').length,
    resolvedConversations: convs.filter(c => c.status === 'resolved').length,
    totalArticles: articles.length,
    publishedArticles: articles.filter(a => a.status === 'published').length,
    pendingApprovals: actions.filter(a => a.requires_approval && a.status === 'pending').length,
    autoResolved: convs.filter(c => c.status === 'resolved').length,
    channelBreakdown: {
      chat: convs.filter(c => c.channel === 'chat').length,
      email: convs.filter(c => c.channel === 'email').length,
      phone: convs.filter(c => c.channel === 'phone').length,
    },
    sentimentBreakdown: {
      positive: convs.filter(c => c.sentiment === 'positive').length,
      neutral: convs.filter(c => c.sentiment === 'neutral').length,
      negative: convs.filter(c => c.sentiment === 'negative').length,
    },
  };
};

// =====================================================
// AGENT BRAIN (Option A: zero-cost, rule-based + KB retrieval)
// Swap-in point for an LLM later: replace draftAgentAction's
// retrieval/compose block with an Edge Function call.
// =====================================================

interface AgentDraft {
  agentName: string;
  actionType: string;
  description: string;
  answer: string;
  confidence: number; // 0..1
  sources: { id: string; title: string }[];
  requiresApproval: boolean;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','to','of','in',
  'on','for','with','my','i','me','can','you','your','do','does','how','what',
  'why','when','where','please','need','want','help','about','it','this','that',
]);

const tokenize = (s: string): string[] =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

// Score a query against an article by token overlap across title/tags/body.
const scoreArticle = (queryTokens: string[], a: DBKnowledgeArticle): number => {
  if (queryTokens.length === 0) return 0;
  const title = tokenize(a.title);
  const tags = (a.tags || []).flatMap((t) => tokenize(t));
  const body = tokenize(a.body).slice(0, 400);
  let hits = 0;
  let weighted = 0;
  for (const q of queryTokens) {
    if (title.includes(q)) { weighted += 3; hits++; }
    else if (tags.includes(q)) { weighted += 2; hits++; }
    else if (body.includes(q)) { weighted += 1; hits++; }
  }
  const coverage = hits / queryTokens.length; // how much of the query we matched
  const density = weighted / (queryTokens.length * 3); // normalized strength
  return Math.min(1, coverage * 0.6 + density * 0.4);
};

// Draft a proposed agent action by retrieving from the tenant KB.
//
// NOTE: this previously tried a `workforce-chat` Edge Function first (an
// unauthenticated, service-role-backed function that trusted a
// client-supplied tenantId with zero verification — a live cross-tenant
// data-leak vector if ever deployed). It was never actually deployed, but
// kept the vulnerable source file and this call site around as a landmine.
// Removed as part of the pre-launch security audit.
//
// CONSOLIDATED (found live during a founder product-demo walkthrough): this
// used to query the LEGACY knowledge_articles table via the search_knowledge
// RPC — pure Postgres full-text search, no semantic understanding, and a
// completely separate system from the one the real production DE pipeline
// (de-answer / widget-ask / specialist-consult) actually uses. On the live
// demo, knowledge_articles held exactly 3 rows total, all for a different
// tenant — the tenant being demoed had ZERO rows there, so every question
// correctly (but uselessly) escalated. This now calls hybrid_match_knowledge
// (migration 046) — the SAME shared retrieval RPC every other consumer uses,
// over the real knowledge_docs/knowledge_doc_chunks tables — combining
// lexical (ts_rank) and semantic (gte-small embeddings) signal via
// Reciprocal Rank Fusion. The browser cannot compute a gte-small embedding
// itself (that model only runs inside the Supabase.ai edge runtime), so
// p_query_embedding is omitted here and the RPC gracefully degrades to
// lexical-only ranking for this call site — still a real improvement over
// the old path (same production doc set, not a dead duplicate table), and
// still paraphrase-robust wherever a semantic-capable caller (de-answer,
// widget-ask, specialist-consult) already answered the same question and
// left embedded chunks behind. Only the RETRIEVAL changed — the
// confidence-gating/escalation logic below (auditAnswer, runPortalTurn) is
// untouched.
const draftAgentAction = async (
  tenantId: string,
  query: string,
  audience: 'customer' | 'internal' = 'customer',
  conversationId?: string | null,
  kbCategories?: string[]   // optional KB category filter for DE scoping (currently unused by hybrid_match_knowledge; retained for signature compat)
): Promise<AgentDraft> => {
  const APPROVAL_THRESHOLD = 0.55; // below => route to human approval
  const { data: rpcRows, error: searchErr } = await supabase.rpc('hybrid_match_knowledge', {
    p_tenant_id: tenantId,
    p_query_text: query,
    p_account_id: null,
    p_query_embedding: null, // browser can't run gte-small; lexical-only for this caller
    p_match_count: 3,
    p_subject_kind: null,
    p_subject_id: null,
  })
  if (searchErr) console.error('hybrid_match_knowledge:', searchErr.message)
  const rows: any[] = rpcRows || []
  const qTokens = tokenize(query)
  // Map RPC rows (doc_id/doc_title/content) to the article shape the rest of
  // this function expects, then derive a calibrated 0..1 confidence from
  // token overlap. RRF `score` is a small fused number (each component is
  // 1/(60+rank), max ~0.033 combined) — not itself a 0..1 confidence, so it
  // is only used to preserve fusion order, same role `rank` (ts_rank) played
  // before; the token-overlap score is still the primary confidence signal.
  const ranked = rows.map((r: any) => ({
    a: { id: r.doc_id, title: r.doc_title, summary: undefined, body: r.content || '',
         audience: audience, tags: [] } as Partial<DBKnowledgeArticle> as DBKnowledgeArticle,
    score: scoreArticle(qTokens, { title: r.doc_title, body: r.content, tags: [] } as DBKnowledgeArticle),
    rrfScore: Number(r.score) || 0,
  }))
  // Keep RPC (RRF) order; if token scoring found nothing, fall back to a
  // scaled RRF score (comparable role to the old ts_rank fallback).
  const anyTokenMatch = ranked.some((r) => r.score > 0)

  const top = ranked[0]
  const confidence = top ? (anyTokenMatch ? Math.round(top.score * 100) / 100
                                          : Math.min(1, Math.round(top.rrfScore * 30 * 100) / 100)) : 0
  const sources = ranked.map((r) => ({ id: r.a.id, title: r.a.title }));

  let answer: string;
  if (top && confidence >= 0.25) {
    const summary = top.a.summary || top.a.body.slice(0, 280);
    answer = summary + (ranked.length > 1 ? '' : '');
  } else {
    answer =
      'I could not find a confident answer in the knowledge base for this request. ' +
      'Routing to a human teammate for review.';
  }

  const requiresApproval = confidence < APPROVAL_THRESHOLD;
  const agentName =
    audience === 'customer' ? 'Support Agent' : 'Internal Assist Agent';
  const actionType = requiresApproval ? 'draft' : 'send';
  const description =
    (top ? `Drafted reply citing "${top.a.title}"` : 'No KB match found') +
    ` (confidence ${Math.round(confidence * 100)}%)`;

  return {
    agentName,
    actionType,
    description,
    answer,
    confidence,
    sources,
    requiresApproval,
  };
};

/* ===================== CUSTOMER PORTAL: ANSWER + AUDIT + ESCALATION ===================== */
interface PortalSource { id: string; title: string; }
interface PortalTurnResult {
  conversationId: string | null;
  answer: string;
  confidence: number;            // 0..1
  sources: PortalSource[];
  agentName: string;
  auditVerdict: 'passed' | 'review' | 'failed';
  auditNote: string;
  escalated: boolean;
  escalationId: string | null;
  escalationReason: string | null;
}

/* Bot audit review: a second-pass validator that runs BEFORE the answer is shown to the
   customer. It checks that the drafted answer is grounded (has sources), confident enough,
   and not the no-answer fallback. Deterministic + zero-cost; swap for an LLM critic later. */
const auditAnswer = (draft: AgentDraft): { verdict: 'passed' | 'review' | 'failed'; note: string; reason: string | null } => {
  const noAnswer = /could not find a confident answer/i.test(draft.answer || '');
  if (noAnswer || (draft.sources || []).length === 0) {
    return { verdict: 'failed', note: 'No grounded source found in the knowledge base; answer is not supported.', reason: 'no_answer' };
  }
  if (draft.confidence < 0.55) {
    return { verdict: 'failed', note: 'Confidence ' + Math.round(draft.confidence * 100) + '% is below the 55% auto-answer threshold.', reason: 'low_confidence' };
  }
  if (draft.confidence < 0.75) {
    return { verdict: 'review', note: 'Answer cites ' + draft.sources.length + ' source(s) but moderate confidence (' + Math.round(draft.confidence * 100) + '%); shown with a caution flag.', reason: null };
  }
  return { verdict: 'passed', note: 'Grounded in ' + draft.sources.length + ' source(s) at ' + Math.round(draft.confidence * 100) + '% confidence.', reason: null };
};

/* Full portal turn: retrieve -> audit -> persist -> auto-escalate on failure. */
export const runPortalTurn = async (
  tenantId: string, query: string,
  opts: { conversationId?: string | null; customerName?: string } = {}
): Promise<PortalTurnResult> => {
  const draft = await draftAgentAction(tenantId, query, 'customer');
  const audit = auditAnswer(draft);
  const escalate = audit.verdict === 'failed';

  // 1) conversation (reuse existing or create)
  let conversationId = opts.conversationId || null;
  if (!conversationId) {
    const conv = await createConversation({
      tenant_id: tenantId, channel: 'chat',
      status: escalate ? 'pending' : 'open',
      subject: query.slice(0, 120),
      customer_name: opts.customerName || 'Web Visitor',
      confidence_score: draft.confidence,
    } as any);
    conversationId = (conv && (conv as any).id) || null;
  }

  // 2) persist the customer message + the audited agent answer
  if (conversationId) {
    await addMessage({ conversation_id: conversationId, tenant_id: tenantId, role: 'user', content: query, requires_approval: false } as any);
    await addMessage({
      conversation_id: conversationId, tenant_id: tenantId, role: 'agent',
      content: draft.answer, confidence_score: draft.confidence,
      requires_approval: escalate, sources: draft.sources,
      audit_verdict: audit.verdict, audit_note: audit.note,
    } as any);
  }

  // 3) auto-escalate to a human when the audit fails
  let escalationId: string | null = null;
  if (escalate && conversationId) {
    const { data, error } = await supabase.from('escalations').insert({
      tenant_id: tenantId, conversation_id: conversationId,
      reason: audit.reason || 'low_confidence', question: query,
      draft_answer: draft.answer, confidence: draft.confidence, status: 'open',
    }).select().single();
    if (error) { console.error('runPortalTurn escalate:', error.message); }
    else { escalationId = (data as any).id; }
  }

  return {
    conversationId, answer: draft.answer, confidence: draft.confidence,
    sources: draft.sources, agentName: draft.agentName,
    auditVerdict: audit.verdict, auditNote: audit.note,
    escalated: escalate, escalationId, escalationReason: audit.reason,
  };
};

/* Manual escalation triggered by the customer or agent (always-available path). */

// ----- human escalation inbox: claim + resolve (staff-facing, RLS-gated) -----
// Resolve an escalation: post the human reply into the conversation as an agent message,
// flip the escalation to resolved and re-open/resolve the linked conversation.

// ============================================================
// CONVERSATION MANAGEMENT (admin take-over + resolve)
// ============================================================

// ============================================================
// CSAT
// ============================================================

export const submitCSAT = async (
  conversationId: string,
  tenantId: string,
  score: 1 | -1,
): Promise<boolean> => {
  const { error } = await supabase
    .from('conversations')
    .update({ csat_score: score, csat_submitted_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('tenant_id', tenantId);
  if (error) console.error('submitCSAT:', error.message);
  return !error;
};

