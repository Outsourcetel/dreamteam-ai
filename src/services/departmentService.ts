import { supabase } from '../supabase';
import type { Department } from '../lib/useDepartments';
import { writeAuditLog } from './auditLogService';

export interface DBDepartment {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  head_name: string | null;
  color: string;
  member_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function dbToDepartment(db: DBDepartment): Department {
  return {
    id:          db.id,
    name:        db.name,
    description: db.description,
    head:        db.head_name ?? '',
    memberCount: db.member_count,
    color:       db.color,
    createdAt:   db.created_at.split('T')[0],
  };
}

export const fetchDepartments = async (tenantId: string): Promise<Department[]> => {
  const { data, error } = await supabase
    .from('departments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });
  if (error) { console.error('fetchDepartments:', error.message); return []; }
  return (data as DBDepartment[]).map(dbToDepartment);
};

export const createDepartment = async (
  tenantId: string,
  payload: Pick<Department, 'name' | 'description' | 'head' | 'color'>,
  actorId?: string
): Promise<Department | null> => {
  const { data, error } = await supabase
    .from('departments')
    .insert({
      tenant_id:    tenantId,
      name:         payload.name,
      description:  payload.description,
      head_name:    payload.head || null,
      color:        payload.color,
      member_count: 0,
      created_by:   actorId ?? null,
    })
    .select()
    .single();
  if (error) { console.error('createDepartment:', error.message); return null; }
  const dept = dbToDepartment(data as DBDepartment);
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'create', entity_type: 'department',
    entity_id: dept.id, entity_name: dept.name,
  });
  return dept;
};

export const updateDepartment = async (
  id: string,
  tenantId: string,
  updates: Partial<Omit<Department, 'id' | 'createdAt'>>,
  actorId?: string
): Promise<boolean> => {
  const dbUpdates: Record<string, unknown> = {};
  if (updates.name        !== undefined) dbUpdates.name        = updates.name;
  if (updates.description !== undefined) dbUpdates.description = updates.description;
  if (updates.head        !== undefined) dbUpdates.head_name   = updates.head || null;
  if (updates.color       !== undefined) dbUpdates.color       = updates.color;
  if (updates.memberCount !== undefined) dbUpdates.member_count = updates.memberCount;

  const { error } = await supabase
    .from('departments')
    .update(dbUpdates)
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updateDepartment:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'department', entity_id: id,
    after_data: dbUpdates,
  });
  return true;
};

export const deleteDepartment = async (
  id: string,
  tenantId: string,
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('departments')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('deleteDepartment:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'delete', entity_type: 'department', entity_id: id,
  });
  return true;
};
