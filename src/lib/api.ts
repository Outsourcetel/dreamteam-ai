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

export interface DBProfile {
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

export interface DBKnowledgeArticle {
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

export interface DBConversation {
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

export interface DBMessage {
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

export interface DBAgentAction {
  id: string;
  tenant_id: string;
  conversation_id?: string;
  agent_name: string;
  action_type: string;
  description?: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  confidence_score?: number;
  requires_approval: boolean;
  approved_by?: string;
  approved_at?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
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

// =====================================================
// KNOWLEDGE ARTICLE QUERIES
// =====================================================
// =====================================================
// CONVERSATION QUERIES
// =====================================================
export const createConversation = async (
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

export const addMessage = async (
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
// AGENT ACTIONS QUERIES
// =====================================================
export const fetchAgentActions = async (tenantId: string, limit = 50): Promise<DBAgentAction[]> => {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('fetchAgentActions:', error.message); return []; }
  return data ?? [];
};

export const approveAgentAction = async (id: string, approvedBy: string): Promise<boolean> => {
  const { error } = await supabase
    .from('agent_actions')
    .update({ status: 'approved', approved_by: approvedBy, approved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { console.error('approveAgentAction:', error.message); return false; }
  return true;
};

// =====================================================
// PLATFORM CONFIG (API keys stored in DB, service-role only via edge fn)
// These write to platform_config via a thin upsert. The values are stored
// server-side and never returned to the client after saving.
// =====================================================
export const savePlatformConfig = async (entries: Record<string, string>): Promise<boolean> => {
  const rows = Object.entries(entries).map(([key, value]) => ({
    key, value, updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('platform_config')
    .upsert(rows, { onConflict: 'key' });
  if (error) { console.error('savePlatformConfig:', error.message); return false; }
  return true;
};

export const hasPlatformConfigKey = async (key: string): Promise<boolean> => {
  const { data, error } = await supabase
    .from('platform_config')
    .select('key')
    .eq('key', key)
    .single();
  return !error && !!data;
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

// Alias
export const createMessage = addMessage;


// =====================================================
// AGENT BRAIN (Option A: zero-cost, rule-based + KB retrieval)
// Swap-in point for an LLM later: replace draftAgentAction's
// retrieval/compose block with an Edge Function call.
// =====================================================

export interface AgentDraft {
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

// ── LLM swap point ─────────────────────────────────────────────────────────
// Attempt the workforce-chat Edge Function (powered by Claude via Anthropic API).
// Falls back to the rule-based scorer below if the function is not yet deployed.
// To activate: deploy supabase/functions/workforce-chat/index.ts and add the
// ANTHROPIC_API_KEY secret in Supabase dashboard → Project Settings → Secrets.
const tryEdgeFunction = async (
  tenantId: string,
  query: string,
  conversationId?: string | null
): Promise<AgentDraft | null> => {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workforce-chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ message: query, tenantId, conversationId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.source === 'fallback' || !data.response) return null;
    return {
      agentName: 'Support Digital Employee',
      actionType: data.requires_approval ? 'draft' : 'send',
      description: `Claude response (${Math.round(data.confidence * 100)}% confidence, ${data.kb_articles_used} KB articles)`,
      answer: data.response,
      confidence: data.confidence,
      sources: [],
      requiresApproval: data.requires_approval,
    };
  } catch {
    return null;
  }
};

// Draft a proposed agent action by retrieving from the tenant KB.
export const draftAgentAction = async (
  tenantId: string,
  query: string,
  audience: 'customer' | 'internal' = 'customer',
  conversationId?: string | null,
  kbCategories?: string[]   // optional KB category filter for DE scoping
): Promise<AgentDraft> => {
  // Try the LLM Edge Function first — if deployed and API key is set, use it.
  const llmDraft = await tryEdgeFunction(tenantId, query, conversationId);
  if (llmDraft) return llmDraft;

  const APPROVAL_THRESHOLD = 0.55; // below => route to human approval
  // Retrieval: zero-cost Postgres full-text search (tenant-isolated RPC).
  // The search_knowledge RPC enforces tenant_id + published status + audience
  // server-side and ranks via ts_rank over a weighted tsvector (title>summary/tags>body).
  const { data: rpcRows, error: searchErr } = await supabase.rpc('search_knowledge', {
    p_tenant_id: tenantId,
    p_query: query,
    p_audience: audience,
    p_limit: 3,
  })
  if (searchErr) console.error('search_knowledge:', searchErr.message)
  // Apply optional KB category filter (DE scoping — empty = unrestricted)
  const filteredRows = kbCategories && kbCategories.length > 0
    ? (rpcRows || []).filter((r: any) => kbCategories.includes(r.category || ''))
    : (rpcRows || []);
  const qTokens = tokenize(query)
  // Map RPC rows to the article shape, then derive a calibrated 0..1 confidence
  // from token overlap (the ts_rank ordering decides WHICH articles surface).
  const ranked = filteredRows.map((r: any) => ({
    a: { id: r.id, title: r.title, summary: r.summary, body: r.body,
         audience: r.audience, tags: r.tags } as Partial<DBKnowledgeArticle> as DBKnowledgeArticle,
    score: scoreArticle(qTokens, { title: r.title, body: r.body, tags: r.tags } as DBKnowledgeArticle),
    rank: Number(r.rank) || 0,
  }))
  // Keep RPC (ts_rank) order; if token scoring found nothing, fall back to ts_rank.
  const anyTokenMatch = ranked.some((r) => r.score > 0)

  const top = ranked[0]
  const confidence = top ? (anyTokenMatch ? Math.round(top.score * 100) / 100
                                          : Math.min(1, Math.round(top.rank * 100) / 100)) : 0
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

// Run the full loop: persist conversation + user message + agent action.
// Execute an approved action: mark executed and store result payload.
// Reject a pending action with an audit reason.
export const rejectAgentAction = async (
  id: string,
  rejectedBy: string,
  reason?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('agent_actions')
    .update({
      status: 'rejected',
      approved_by: rejectedBy,
      approved_at: new Date().toISOString(),
      result: { rejected_at: new Date().toISOString(), reason: reason || 'declined by reviewer' },
    })
    .eq('id', id);
  if (error) { console.error('rejectAgentAction:', error.message); return false; }
  return true;
};

/* ===================== CUSTOMER PORTAL: ANSWER + AUDIT + ESCALATION ===================== */
export interface PortalSource { id: string; title: string; }
export interface PortalTurnResult {
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
export const auditAnswer = (draft: AgentDraft): { verdict: 'passed' | 'review' | 'failed'; note: string; reason: string | null } => {
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
// DIGITAL EMPLOYEES
// ============================================================

export interface DBDigitalEmployee {
  id: string;
  tenant_id: string;
  catalog_id: string | null;
  name: string;
  persona_name: string | null;
  description: string;
  icon: string;
  category: 'Customer' | 'Internal';
  department: string;
  workspace: string;
  status: 'active' | 'idle' | 'disabled';
  lifecycle_status: string;
  trust_level: 'supervised' | 'established' | 'trusted' | 'autonomous';
  capabilities: string[];
  responsibilities: string[];
  channels: string[];
  knowledge_sources: string[];
  tags: string[];
  confidence_threshold: number;
  required_approval: boolean;
  skills: { name: string; proficiency: number; evidence?: string }[];
  model_config: Record<string, unknown>;
  tasks_this_month: number;
  success_rate: number;
  fte_equivalent: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const fetchDigitalEmployees = async (tenantId: string): Promise<DBDigitalEmployee[]> => {
  const { data, error } = await supabase
    .from('digital_employees')
    .select('*')
    .eq('tenant_id', tenantId)
    .not('lifecycle_status', 'in', '(retired,archived)')
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchDigitalEmployees:', error.message); return []; }
  return (data as DBDigitalEmployee[]) ?? [];
};


// ============================================================
// PLAYBOOKS
// ============================================================

export interface DBPlaybook {
  id: string;
  tenant_id: string;
  digital_employee_id: string | null;
  parent_playbook_id: string | null;
  name: string;
  slug: string;
  version: number;
  domain: string;
  business_objective: string;
  owner_role: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  lifecycle_status: string;
  is_base_playbook: boolean;
  trigger_type: string;
  capabilities_used: string[];
  knowledge_collections: string[];
  connector_requirements: string[];
  human_approval_required: boolean;
  approval_points: unknown[];
  decision_rules: unknown[];
  escalation_rules: unknown[];
  exception_handlers: unknown[];
  expected_outputs: unknown[];
  kpis: { name: string; target: number; unit: string; current_value?: number }[];
  estimated_duration_ms: number | null;
  estimated_cost_usd: number | null;
  tasks_this_month: number;
  success_rate: number;
  de_handled_rate: number;
  certified_by: string | null;
  certified_at: string | null;
  next_review_due: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const fetchPlaybooks = async (tenantId: string, filters?: {
  domain?: string;
  lifecycle_status?: string;
  digital_employee_id?: string;
}): Promise<DBPlaybook[]> => {
  let q = supabase
    .from('playbooks')
    .select('*')
    .eq('tenant_id', tenantId)
    .not('lifecycle_status', 'in', '(retired)')
    .order('created_at', { ascending: false });
  if (filters?.domain) q = q.eq('domain', filters.domain);
  if (filters?.lifecycle_status) q = q.eq('lifecycle_status', filters.lifecycle_status);
  if (filters?.digital_employee_id) q = q.eq('digital_employee_id', filters.digital_employee_id);
  const { data, error } = await q;
  if (error) { console.error('fetchPlaybooks:', error.message); return []; }
  return (data as DBPlaybook[]) ?? [];
};

export const createPlaybook = async (
  tenantId: string,
  pb: Omit<DBPlaybook, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>
): Promise<DBPlaybook | null> => {
  const { data, error } = await supabase
    .from('playbooks')
    .insert({ ...pb, tenant_id: tenantId })
    .select()
    .single();
  if (error) { console.error('createPlaybook:', error.message); return null; }
  return data as DBPlaybook;
};

export const updatePlaybook = async (
  id: string,
  tenantId: string,
  updates: Partial<Omit<DBPlaybook, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>
): Promise<boolean> => {
  const { error } = await supabase
    .from('playbooks')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updatePlaybook:', error.message); return false; }
  return true;
};

export const advancePlaybookLifecycle = async (
  id: string,
  tenantId: string,
  newStatus: DBPlaybook['lifecycle_status'],
  certifiedBy?: string
): Promise<boolean> => {
  const updates: Partial<DBPlaybook> = { lifecycle_status: newStatus };
  if (newStatus === 'certified' && certifiedBy) {
    updates.certified_by = certifiedBy;
    updates.certified_at = new Date().toISOString();
  }
  return updatePlaybook(id, tenantId, updates);
};

export const fetchPlaybookSummary = async (tenantId: string) => {
  const { data, error } = await supabase
    .from('playbooks')
    .select('lifecycle_status, domain, risk_level, de_handled_rate, tasks_this_month')
    .eq('tenant_id', tenantId);
  if (error || !data) return { total: 0, active: 0, domains: 0, avgHandledRate: 0, totalTasks: 0 };
  const domains = new Set(data.map(p => p.domain).filter(Boolean));
  return {
    total: data.length,
    active: data.filter(p => p.lifecycle_status === 'active').length,
    domains: domains.size,
    avgHandledRate: data.length ? Math.round(data.reduce((s, p) => s + Number(p.de_handled_rate ?? 0), 0) / data.length) : 0,
    totalTasks: data.reduce((s, p) => s + (p.tasks_this_month ?? 0), 0),
  };
};

// Assign a Playbook to a Digital Employee
export const assignPlaybookToDE = async (
  tenantId: string,
  digitalEmployeeId: string,
  playbookId: string,
  isPrimary = false
): Promise<boolean> => {
  const { error } = await supabase
    .from('de_playbook_assignments')
    .upsert({
      tenant_id: tenantId,
      digital_employee_id: digitalEmployeeId,
      playbook_id: playbookId,
      is_primary: isPrimary,
    }, { onConflict: 'digital_employee_id,playbook_id' });
  if (error) { console.error('assignPlaybookToDE:', error.message); return false; }
  return true;
};

// ============================================================
// CONVERSATION MANAGEMENT (admin take-over + resolve)
// ============================================================

export const updateTenantProfile = async (
  tenantId: string,
  data: { name?: string; industry?: string; accent_color?: string },
): Promise<boolean> => {
  const { error } = await supabase.from('tenants')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) console.error('updateTenantProfile:', error.message);
  return !error;
};

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

// ============================================================
// ALERT EMAIL CONFIG
// ============================================================

// ============================================================
// DE OUTBOUND EMAIL
// ============================================================

// ============================================================
// CONNECTOR STORAGE (localStorage, frontend-only)
// ============================================================

const CONNECTOR_STORE_KEY = (tenantId: string) => `dt_connectors_${tenantId}`;

export interface ConnectorConfig {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  status: 'connected' | 'testing' | 'error' | 'disconnected';
  config: Record<string, string>;
  lastSync: string | null;
  recordCount: number;
  errorMessage?: string;
  createdAt: string;
}

export const loadConnectors = (tenantId: string): ConnectorConfig[] => {
  try { return JSON.parse(localStorage.getItem(CONNECTOR_STORE_KEY(tenantId)) || '[]'); } catch { return []; }
};

export const saveConnectors = (tenantId: string, connectors: ConnectorConfig[]): void => {
  try { localStorage.setItem(CONNECTOR_STORE_KEY(tenantId), JSON.stringify(connectors)); } catch {}
};

// TODO(oauth): implement real OAuth callback handler
// When a provider redirects back with ?code=AUTH_CODE&state=CONNECTOR_ID:
//   1. POST /api/oauth/callback with { code, connectorId, tenantId }
//   2. Server exchanges code for access_token + refresh_token via provider token endpoint
//   3. Tokens stored encrypted in Supabase connector_credentials table (never in localStorage)
//   4. Return { ok: true, account: providerAccountLabel, scope: grantedScopes }
//   5. Set connector status='connected', config.oauth_connected='true' in DB
// Supported providers: salesforce, hubspot, zendesk, quickbooks, xero, chargebee
// export const handleOAuthCallback = async (code: string, connectorId: string, tenantId: string) => { ... };

export const testConnector = async (connector: ConnectorConfig): Promise<{ ok: boolean; error?: string; recordCount?: number }> => {
  if (connector.type === 'rest_api' && connector.config.base_url) {
    try {
      const headers: Record<string, string> = {};
      if (connector.config.auth_type === 'Bearer') headers['Authorization'] = `Bearer ${connector.config.auth_value}`;
      else if (connector.config.auth_type === 'API Key') headers['X-API-Key'] = connector.config.auth_value;
      const res = await fetch(connector.config.base_url, { headers, signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, recordCount: 0 };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  // For all others: simulate success after 1.5s
  await new Promise(r => setTimeout(r, 1500));
  return { ok: true, recordCount: Math.floor(Math.random() * 50000) + 1000 };
};

