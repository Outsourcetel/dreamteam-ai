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

export const fetchTenantProfiles = async (tenantId: string): Promise<DBProfile[]> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) { console.error('fetchTenantProfiles:', error.message); return []; }
  return data ?? [];
};

// =====================================================
// KNOWLEDGE ARTICLE QUERIES
// =====================================================
export const fetchKnowledgeArticles = async (tenantId?: string): Promise<DBKnowledgeArticle[]> => {
  let query = supabase
    .from('knowledge_articles')
    .select('*')
    .order('created_at', { ascending: false });
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query;
  if (error) { console.error('fetchKnowledgeArticles:', error.message); return []; }
  return data ?? [];
};

export const fetchKBStats = async (tenantId: string) => {
  const { data, error } = await supabase
    .from('knowledge_articles')
    .select('status, audience, quality_score, freshness_score')
    .eq('tenant_id', tenantId);
  if (error || !data) return { total: 0, published: 0, draft: 0, avgQuality: 0, avgFreshness: 0 };
  return {
    total: data.length,
    published: data.filter(a => a.status === 'published').length,
    draft: data.filter(a => a.status === 'draft').length,
    avgQuality: Math.round(data.reduce((s, a) => s + (a.quality_score ?? 0), 0) / (data.length || 1)),
    avgFreshness: Math.round(data.reduce((s, a) => s + (a.freshness_score ?? 0), 0) / (data.length || 1)),
  };
};

export const upsertKnowledgeArticle = async (
  article: Partial<DBKnowledgeArticle> & { tenant_id: string; title: string; body: string }
): Promise<DBKnowledgeArticle | null> => {
  const { data, error } = await supabase
    .from('knowledge_articles')
    .upsert(article)
    .select()
    .single();
  if (error) { console.error('upsertKnowledgeArticle:', error.message); return null; }
  return data;
};

export const updateArticleStatus = async (id: string, status: DBKnowledgeArticle['status']): Promise<boolean> => {
  const { error } = await supabase
    .from('knowledge_articles')
    .update({ status })
    .eq('id', id);
  if (error) { console.error('updateArticleStatus:', error.message); return false; }
  return true;
};

// =====================================================
// CONVERSATION QUERIES
// =====================================================
export const fetchConversations = async (tenantId?: string, status?: string): Promise<DBConversation[]> => {
  let query = supabase
    .from('conversations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) { console.error('fetchConversations:', error.message); return []; }
  return data ?? [];
};

export const fetchConversationMessages = async (conversationId: string): Promise<DBMessage[]> => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchConversationMessages:', error.message); return []; }
  return data ?? [];
};

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

// Draft a proposed agent action by retrieving from the tenant KB.
export const draftAgentAction = async (
  tenantId: string,
  query: string,
  audience: 'customer' | 'internal' = 'customer'
): Promise<AgentDraft> => {
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
  const qTokens = tokenize(query)
  // Map RPC rows to the article shape, then derive a calibrated 0..1 confidence
  // from token overlap (the ts_rank ordering decides WHICH articles surface).
  const ranked = (rpcRows || []).map((r: any) => ({
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
export const runAgentLoop = async (
  tenantId: string,
  query: string,
  opts: { customerName?: string; audience?: 'customer' | 'internal' } = {}
): Promise<{ action: DBAgentAction | null; draft: AgentDraft; conversationId: string | null }> => {
  const audience = opts.audience || 'customer';
  const draft = await draftAgentAction(tenantId, query, audience);

  const conv = await createConversation({
    tenant_id: tenantId,
    channel: 'chat',
    status: draft.requiresApproval ? 'pending' : 'open',
    subject: query.slice(0, 120),
    customer_name: opts.customerName || 'Web Visitor',
    confidence_score: draft.confidence,
  });
  const conversationId = conv?.id || null;

  if (conversationId) {
    await addMessage({
      conversation_id: conversationId,
      tenant_id: tenantId,
      role: 'user',
      content: query,
      requires_approval: false,
    });
    await addMessage({
      conversation_id: conversationId,
      tenant_id: tenantId,
      role: 'agent',
      content: draft.answer,
      confidence_score: draft.confidence,
      requires_approval: draft.requiresApproval,
      sources: draft.sources,
    });
  }

  const { data, error } = await supabase
    .from('agent_actions')
    .insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      agent_name: draft.agentName,
      action_type: draft.actionType,
      description: draft.description,
      status: draft.requiresApproval ? 'pending' : 'approved',
      confidence_score: draft.confidence,
      requires_approval: draft.requiresApproval,
      payload: { query, answer: draft.answer, sources: draft.sources, audience },
    })
    .select()
    .single();
  if (error) {
    console.error('runAgentLoop:', error.message);
    return { action: null, draft, conversationId };
  }
  return { action: data as DBAgentAction, draft, conversationId };
};

// Execute an approved action: mark executed and store result payload.
export const executeAgentAction = async (
  id: string,
  approvedBy: string
): Promise<DBAgentAction | null> => {
  const { data, error } = await supabase
    .from('agent_actions')
    .update({
      status: 'executed',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      result: { executed_at: new Date().toISOString(), delivered: true },
    })
    .eq('id', id)
    .select()
    .single();
  if (error) { console.error('executeAgentAction:', error.message); return null; }
  return data as DBAgentAction;
};

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


// ============================================================
// FINANCE OPERATIONS CONTROL TOWER (Month-End Close + Reconciliation)
// All sensitive mutations go through SECURITY DEFINER RPCs (server-side).
// ============================================================
export interface FinanceWorkspace {
  id: string; name: string; period_start: string; period_end: string;
  status: string; currency: string
}
export interface FinanceException {
  id: string; workspace_id: string; exception_type: string; severity: string;
  title: string; detail: string | null; amount: number | null;
  ai_reasoning: string | null; confidence: number; proposed_action: string | null;
  is_risky: boolean; status: string; final_treatment: string | null;
  resolved_at: string | null; created_at: string
}

export const fetchFinanceWorkspaces = async (tenantId: string): Promise<FinanceWorkspace[]> => {
  const { data, error } = await supabase.from('close_workspaces')
    .select('*').eq('tenant_id', tenantId).order('period_end', { ascending: false })
  if (error) { console.error('fetchFinanceWorkspaces:', error.message); return [] }
  return (data || []) as FinanceWorkspace[]
}

export const fetchExceptions = async (tenantId: string, workspaceId: string): Promise<FinanceException[]> => {
  const { data, error } = await supabase.from('exceptions')
    .select('*').eq('tenant_id', tenantId).eq('workspace_id', workspaceId)
    .order('severity', { ascending: false }).order('confidence', { ascending: false })
  if (error) { console.error('fetchExceptions:', error.message); return [] }
  return (data || []) as FinanceException[]
}

export const fetchCloseTasks = async (tenantId: string, workspaceId: string) => {
  const { data, error } = await supabase.from('close_tasks')
    .select('*').eq('tenant_id', tenantId).eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: true })
  if (error) { console.error('fetchCloseTasks:', error.message); return [] }
  return data || []
}

export const fetchAuditEvidence = async (tenantId: string, workspaceId: string) => {
  const { data, error } = await supabase.from('audit_evidence')
    .select('*').eq('tenant_id', tenantId).eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchAuditEvidence:', error.message); return [] }
  return data || []
}

// Dashboard metrics derived from the finance objects.
export const fetchFinanceMetrics = async (tenantId: string, workspaceId: string) => {
  const [inv, bills, bank, tasks, exc] = await Promise.all([
    supabase.from('invoices').select('amount,amount_paid,status,due_date').eq('tenant_id', tenantId).eq('workspace_id', workspaceId),
    supabase.from('bills').select('amount,amount_paid,status,due_date').eq('tenant_id', tenantId).eq('workspace_id', workspaceId),
    supabase.from('bank_transactions').select('amount,is_matched').eq('tenant_id', tenantId).eq('workspace_id', workspaceId),
    supabase.from('close_tasks').select('status').eq('tenant_id', tenantId).eq('workspace_id', workspaceId),
    supabase.from('exceptions').select('status,severity').eq('tenant_id', tenantId).eq('workspace_id', workspaceId),
  ])
  const invoices = inv.data || []; const billRows = bills.data || []; const bankRows = bank.data || []
  const taskRows = tasks.data || []; const excRows = exc.data || []
  const num = (v: any) => Number(v) || 0
  const arOverdue = invoices.filter((i: any) => i.status === 'overdue' || (i.status !== 'paid' && i.due_date)).reduce((s: number, i: any) => s + (num(i.amount) - num(i.amount_paid)), 0)
  const apDue = billRows.filter((b: any) => b.status !== 'paid' && b.status !== 'void').reduce((s: number, b: any) => s + (num(b.amount) - num(b.amount_paid)), 0)
  const cashPosition = bankRows.reduce((s: number, t: any) => s + num(t.amount), 0)
  const unmatched = bankRows.filter((t: any) => !t.is_matched).length
  const tasksDone = taskRows.filter((t: any) => t.status === 'done').length
  const closeProgress = taskRows.length ? Math.round((tasksDone / taskRows.length) * 100) : 0
  const openExceptions = excRows.filter((e: any) => e.status === 'open').length
  const resolvedExceptions = excRows.filter((e: any) => e.status !== 'open').length
  const totalExceptions = excRows.length
  const evidenceCompleteness = totalExceptions ? Math.round((resolvedExceptions / totalExceptions) * 100) : 100
  return { arOverdue, apDue, cashPosition, unmatched, closeProgress, tasksDone, tasksTotal: taskRows.length,
    openExceptions, resolvedExceptions, totalExceptions, evidenceCompleteness }
}

// Run the rule-based exception engine (server-side RPC).
export const runExceptionDetection = async (tenantId: string, workspaceId: string): Promise<number> => {
  const { data, error } = await supabase.rpc('detect_exceptions', { p_tenant_id: tenantId, p_workspace_id: workspaceId })
  if (error) { console.error('runExceptionDetection:', error.message); return 0 }
  return Number(data) || 0
}

// Human approves/rejects a proposed action -> writes immutable audit evidence (server-side RPC).
export const resolveException = async (
  exceptionId: string, decision: 'approved' | 'rejected', finalTreatment: string,
  approver: string, approverName: string
): Promise<{ ok: boolean; evidenceId?: string; error?: string }> => {
  const { data, error } = await supabase.rpc('resolve_exception', {
    p_exception_id: exceptionId, p_decision: decision, p_final_treatment: finalTreatment,
    p_approver: approver, p_approver_name: approverName,
  })
  if (error) { console.error('resolveException:', error.message); return { ok: false, error: error.message } }
  return { ok: true, evidenceId: data as string }
}

/* ===================== DOCUMENT INGESTION ===================== */
export interface FinanceDocument {
  id: string; doc_type: string; filename: string; status: string;
  row_count: number; ingested_count: number; parse_summary: string | null; created_at: string;
}

export const FIN_DOC_TYPES: { value: string; label: string; hint: string }[] = [
  { value: 'bank_statement', label: 'Bank statement', hint: 'date, description, amount, [category], [ref]' },
  { value: 'ar_aging', label: 'AR aging (invoices)', hint: 'invoice_number, issue_date, due_date, amount, [amount_paid], [status]' },
  { value: 'ap_aging', label: 'AP aging (bills)', hint: 'bill_number, issue_date, due_date, amount, [amount_paid], [has_receipt]' },
  { value: 'stripe_export', label: 'Stripe / processor payout', hint: 'date, amount, [ref]' },
  { value: 'general_ledger', label: 'General ledger', hint: 'date, account_code, memo, debit, credit' },
  { value: 'payroll_summary', label: 'Payroll summary', hint: 'date, amount, [memo]' },
  { value: 'invoice_pdf', label: 'Invoice / receipt PDF', hint: 'stored for manual review (no auto-extraction)' },
];

/* Zero-cost in-browser CSV parser: returns array of row objects keyed by header. */
export const parseCsvClientSide = (text: string): Record<string, string>[] => {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const splitRow = (row: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') { if (q && row[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else { cur += c; }
    }
    out.push(cur); return out;
  };
  const headers = splitRow(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
};

export const fetchDocuments = async (tenantId: string, workspaceId: string): Promise<FinanceDocument[]> => {
  const { data, error } = await supabase.from('fin_documents').select('*')
    .eq('tenant_id', tenantId).eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (error) { console.error('fetchDocuments:', error.message); return []; }
  return (data as FinanceDocument[]) || [];
};

/* Normalizes parsed rows into finance objects server-side (tenant-guarded SECURITY DEFINER RPC). */
export const ingestDocument = async (
  tenantId: string, workspaceId: string, docType: string, filename: string,
  rows: Record<string, string>[], uploadedBy: string | null
): Promise<{ ok: boolean; documentId?: string; ingested?: number; total?: number; status?: string; error?: string }> => {
  const { data, error } = await supabase.rpc('ingest_document', {
    p_tenant_id: tenantId, p_workspace_id: workspaceId, p_doc_type: docType,
    p_filename: filename, p_rows: rows, p_uploaded_by: uploadedBy,
  });
  if (error) { console.error('ingestDocument:', error.message); return { ok: false, error: error.message }; }
  const d = (data || {}) as any;
  return { ok: true, documentId: d.document_id, ingested: d.ingested, total: d.total, status: d.status };
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
export const escalateConversation = async (
  tenantId: string, conversationId: string, question: string
): Promise<{ ok: boolean; escalationId?: string; error?: string }> => {
  const { data, error } = await supabase.from('escalations').insert({
    tenant_id: tenantId, conversation_id: conversationId,
    reason: 'customer_request', question, status: 'open',
  }).select().single();
  if (error) { console.error('escalateConversation:', error.message); return { ok: false, error: error.message }; }
  await supabase.from('conversations').update({ status: 'pending' }).eq('id', conversationId).eq('tenant_id', tenantId);
  return { ok: true, escalationId: (data as any).id };
};

export interface PortalEscalation { id: string; reason: string; question: string | null; confidence: number | null; status: string; created_at: string; conversation_id: string | null; }
export const fetchEscalations = async (tenantId: string, status?: string): Promise<PortalEscalation[]> => {
  let q = supabase.from('escalations').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) { console.error('fetchEscalations:', error.message); return []; }
  return (data as PortalEscalation[]) || [];
};


// ----- human escalation inbox: claim + resolve (staff-facing, RLS-gated) -----
export const claimEscalation = async (
  escalationId: string,
  assignedTo: string,
): Promise<{ ok: boolean; error?: string }> => {
  const { error } = await supabase
    .from('escalations')
    .update({ status: 'assigned', assigned_to: assignedTo })
    .eq('id', escalationId)
    .eq('status', 'open');
  if (error) { console.error('claimEscalation', error.message); return { ok: false, error: error.message }; }
  return { ok: true };
};

// Resolve an escalation: post the human reply into the conversation as an agent message,
// flip the escalation to resolved and re-open/resolve the linked conversation.
export const resolveEscalation = async (args: {
  escalationId: string;
  tenantId: string;
  conversationId: string | null;
  reply: string;
  resolvedBy: string;
}): Promise<{ ok: boolean; error?: string }> => {
  const reply = (args.reply || '').trim();
  if (!reply) return { ok: false, error: 'Reply is empty' };
  // 1) post the human answer into the conversation thread
  if (args.conversationId) {
    const msg = await addMessage({
      conversation_id: args.conversationId,
      tenant_id: args.tenantId,
      role: 'agent',
      content: reply,
      requires_approval: false,
    } as Omit<DBMessage, 'id' | 'created_at'>);
    if (!msg) return { ok: false, error: 'Could not post reply' };
  }
  // 2) mark escalation resolved
  const { error: e1 } = await supabase
    .from('escalations')
    .update({ status: 'resolved', assigned_to: args.resolvedBy, resolved_at: new Date().toISOString() })
    .eq('id', args.escalationId);
  if (e1) { console.error('resolveEscalation', e1.message); return { ok: false, error: e1.message }; }
  // 3) resolve the linked conversation
  if (args.conversationId) {
    await supabase.from('conversations').update({ status: 'resolved', resolution_type: 'human' }).eq('id', args.conversationId);
  }
  return { ok: true };
};