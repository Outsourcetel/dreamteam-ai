import { supabase } from '../supabase';

// =====================================================
// TYPES — mirror the Supabase schema
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
