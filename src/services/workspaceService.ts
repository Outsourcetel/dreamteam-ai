import { supabase } from '../supabase';
import { writeAuditLog } from './auditLogService';

export interface DBWorkspace {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  color: string;
  status: 'active' | 'inactive' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const fetchWorkspaces = async (tenantId: string): Promise<DBWorkspace[]> => {
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('tenant_id', tenantId)
    .neq('status', 'archived')
    .order('name', { ascending: true });
  if (error) { console.error('fetchWorkspaces:', error.message); return []; }
  return (data as DBWorkspace[]) ?? [];
};

export const createWorkspace = async (
  tenantId: string,
  payload: Pick<DBWorkspace, 'name' | 'slug' | 'description' | 'icon' | 'color'>,
  actorId?: string
): Promise<DBWorkspace | null> => {
  const { data, error } = await supabase
    .from('workspaces')
    .insert({ ...payload, tenant_id: tenantId, created_by: actorId ?? null })
    .select()
    .single();
  if (error) { console.error('createWorkspace:', error.message); return null; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'create', entity_type: 'workspace',
    entity_id: (data as DBWorkspace).id, entity_name: payload.name,
  });
  return data as DBWorkspace;
};

export const updateWorkspace = async (
  id: string,
  tenantId: string,
  updates: Partial<Pick<DBWorkspace, 'name' | 'description' | 'icon' | 'color' | 'status'>>,
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('workspaces')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updateWorkspace:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'workspace', entity_id: id,
    after_data: updates as Record<string, unknown>,
  });
  return true;
};
