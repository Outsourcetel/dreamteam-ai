import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';
import { useAuth } from '../context/AuthContext';
import { writeAuditLog } from '../services/auditLogService';

export type TenantRole =
  | 'tenant_owner'
  | 'tenant_admin'
  | 'tenant_manager'
  | 'knowledge_manager'
  | 'approver'
  | 'tenant_user'
  | 'read_only';

export interface TeamMember {
  id: string;
  fullName: string;
  email: string;
  role: TenantRole;
  department: string;
  status: 'active' | 'pending' | 'deactivated';
  avatar: string;
  lastSeen: string;
  joinedAt: string;
  invitedBy?: string;
}

export const ROLE_LABELS: Record<TenantRole, string> = {
  tenant_owner: 'Organization Owner',
  tenant_admin: 'Organization Admin',
  tenant_manager: 'Department Manager',
  knowledge_manager: 'Knowledge Manager',
  approver: 'Approver',
  tenant_user: 'Human Employee',
  read_only: 'Read-Only Viewer',
};

export const ROLE_PERMISSIONS: Record<TenantRole, string[]> = {
  tenant_owner: ['All permissions'],
  tenant_admin: ['User management', 'DE configuration', 'Knowledge management', 'Analytics', 'Audit log'],
  tenant_manager: ['Department users', 'DE oversight', 'Approvals', 'Analytics'],
  knowledge_manager: ['Knowledge management', 'KB approval', 'Gap detection'],
  approver: ['Approval authority', 'Conversation access', 'Audit log (read)'],
  tenant_user: ['Customer conversations', 'Knowledge (read)', 'Own profile'],
  read_only: ['Analytics (read)', 'Conversations (read)'],
};

function profileToMember(row: Record<string, unknown>): TeamMember {
  const name = (row.full_name as string) || (row.email as string) || 'Unknown';
  return {
    id: row.id as string,
    fullName: name,
    email: (row.email as string) || '',
    role: (row.role as TenantRole) || 'tenant_user',
    department: (row.department as string | undefined) || '',
    status: row.is_active === false ? 'deactivated' : 'active',
    avatar: name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase(),
    lastSeen: row.last_seen_at ? new Date(row.last_seen_at as string).toLocaleDateString() : 'Never',
    joinedAt: row.created_at ? (row.created_at as string).split('T')[0] : '',
    invitedBy: (row.invited_by as string | undefined) || undefined,
  };
}

export function useUsers() {
  const { authedUser, currentTenant } = useAuth();
  const tenantId = currentTenant?.id;
  const actorId = authedUser?.id;

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('useUsers fetch:', error.message);
    } else {
      setMembers((data ?? []).map(r => profileToMember(r as Record<string, unknown>)));
    }
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const invite = useCallback(async (data: {
    fullName: string; email: string; role: TenantRole; department: string; invitedBy: string; tenantId?: string;
  }): Promise<TeamMember | null> => {
    const tid = data.tenantId ?? tenantId;
    if (!tid) return null;

    // 1. Create auth user (Supabase sends confirmation email)
    const tempPassword = Math.random().toString(36).slice(2) + 'Aa1!';
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: data.email.trim(),
      password: tempPassword,
      options: { data: { full_name: data.fullName.trim(), role: data.role, layer: 'tenant' } },
    });

    if (authError) throw authError;
    const userId = authData.user?.id;
    if (!userId) throw new Error('User creation failed');

    // 2. Insert profile linked to tenant
    const { error: profileError } = await supabase.from('profiles').insert({
      user_id: userId,
      tenant_id: tid,
      full_name: data.fullName.trim(),
      role: data.role,
      layer: 'tenant',
      department: data.department,
      invited_by: data.invitedBy,
      is_active: true,
    });

    if (profileError) console.warn('profile insert:', profileError.message);

    writeAuditLog({
      tenant_id: tid,
      actor_user_id: actorId,
      action: 'invite',
      entity_type: 'user',
      entity_name: data.fullName,
      after_data: { email: data.email, role: data.role },
    });

    await load();
    return members.find(m => m.email === data.email) ?? null;
  }, [tenantId, actorId, load, members]);

  const updateRole = useCallback(async (id: string, role: TenantRole) => {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, role } : m));
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
    if (error) console.error('updateRole:', error.message);
    else writeAuditLog({ tenant_id: tenantId, actor_user_id: actorId, action: 'update_role', entity_type: 'user', entity_id: id, after_data: { role } });
  }, [tenantId, actorId]);

  const updateDepartment = useCallback(async (id: string, department: string) => {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, department } : m));
    const { error } = await supabase.from('profiles').update({ department }).eq('id', id);
    if (error) console.error('updateDepartment:', error.message);
  }, []);

  const toggleStatus = useCallback(async (id: string) => {
    const member = members.find(m => m.id === id);
    if (!member) return;
    const newActive = member.status !== 'active';
    setMembers(prev => prev.map(m => m.id === id ? { ...m, status: newActive ? 'active' : 'deactivated' } : m));
    const { error } = await supabase.from('profiles').update({ is_active: newActive }).eq('id', id);
    if (error) console.error('toggleStatus:', error.message);
  }, [members]);

  const remove = useCallback(async (id: string) => {
    setMembers(prev => prev.filter(m => m.id !== id));
    const { error } = await supabase.from('profiles').delete().eq('id', id);
    if (error) console.error('remove user:', error.message);
  }, []);

  const resendInvite = useCallback((id: string) => {
    console.log('Resend invite for', id);
  }, []);

  return { members, loading, invite, updateRole, updateDepartment, toggleStatus, remove, resendInvite };
}
