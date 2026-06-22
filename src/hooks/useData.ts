import { useState, useEffect, useCallback } from 'react';
import {
  fetchTenants, fetchKnowledgeArticles, fetchConversations,
  fetchDashboardStats, fetchMyProfile, fetchTenantProfiles,
  fetchAgentActions, fetchKBStats,
  DBTenant, DBKnowledgeArticle, DBConversation, DBProfile, DBAgentAction
} from '../lib/api';

// =====================================================
// Generic async hook factory
// =====================================================
function useAsync<T>(fetchFn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setData(result);
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);
  return { data, loading, error, refresh: run };
}

// =====================================================
// useTenants — list all tenants (platform admin)
// =====================================================
export const useTenants = () => {
  return useAsync<DBTenant[]>(() => fetchTenants());
};

// =====================================================
// useMyProfile — current user's profile
// =====================================================
export const useMyProfile = () => {
  return useAsync<DBProfile | null>(() => fetchMyProfile());
};

// =====================================================
// useKnowledgeArticles — per-tenant KB articles
// =====================================================
export const useKnowledgeArticles = (tenantId?: string) => {
  return useAsync<DBKnowledgeArticle[]>(() => fetchKnowledgeArticles(tenantId), [tenantId]);
};

// =====================================================
// useKBStats — summary stats for a tenant's KB
// =====================================================
export const useKBStats = (tenantId?: string) => {
  return useAsync(
    () => tenantId ? fetchKBStats(tenantId) : Promise.resolve(null),
    [tenantId]
  );
};

// =====================================================
// useConversations — per-tenant conversations
// =====================================================
export const useConversations = (tenantId?: string, status?: string) => {
  return useAsync<DBConversation[]>(
    () => fetchConversations(tenantId, status),
    [tenantId, status]
  );
};

// =====================================================
// useDashboardStats — tenant KPI stats
// =====================================================
export const useDashboardStats = (tenantId?: string) => {
  return useAsync(
    () => tenantId
      ? fetchDashboardStats(tenantId)
      : Promise.resolve(null),
    [tenantId]
  );
};

// =====================================================
// useAgentActions — per-tenant agent audit log
// =====================================================
export const useAgentActions = (tenantId?: string) => {
  return useAsync<DBAgentAction[]>(
    () => tenantId ? fetchAgentActions(tenantId) : Promise.resolve([]),
    [tenantId]
  );
};

// =====================================================
// useTenantProfiles — users within a tenant
// =====================================================
export const useTenantProfiles = (tenantId?: string) => {
  return useAsync<DBProfile[]>(
    () => tenantId ? fetchTenantProfiles(tenantId) : Promise.resolve([]),
    [tenantId]
  );
};
