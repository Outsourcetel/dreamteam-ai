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
  userId: string;
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
    id: row.user_id as string,
    userId: row.user_id as string,
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
    // profiles has no email column -- list_team_members_full() (migration
    // 089) joins auth.users for the real address; the old raw
    // .from('profiles').select('*') silently returned '' for every email,
    // breaking display, search, and the "reset password" admin action.
    const { data, error } = await supabase.rpc('list_team_members_full', { p_tenant_id: tenantId });
    if (error) {
      console.error('useUsers fetch:', error.message);
    } else {
      const rows = ((data ?? []) as Record<string, unknown>[])
        .slice()
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      setMembers(rows.map(r => profileToMember(r)));
    }
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  // Real backing as of 2026-07-09 (F3, adversarial audit fix): a
  // Postgres RPC can't create an auth.users row or send a real invite
  // email -- only the Supabase Auth Admin API can, and that's only
  // reachable with the service-role key, hence the edge function
  // rather than another migration-065-style RPC. The old version did
  // a raw signUp() + a second raw profiles insert as the INVITING
  // admin's own session -- targeting a user_id handle_new_user's
  // trigger already claimed, with no RLS path that could ever
  // succeed, and swallowed the resulting error. This throws for real
  // on any failure instead.
  const invite = useCallback(async (data: {
    fullName: string; email: string; role: TenantRole; department: string; invitedBy: string; tenantId?: string;
  }): Promise<TeamMember | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Not signed in.');

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-team-member`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        email: data.email.trim(), full_name: data.fullName.trim(),
        role: data.role, department: data.department,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.error) throw new Error(String(result.error ?? `HTTP ${res.status}`));

    writeAuditLog({
      tenant_id: data.tenantId ?? tenantId,
      actor_user_id: actorId,
      action: 'invite',
      entity_type: 'user',
      entity_name: data.fullName,
      after_data: { email: data.email, role: data.role },
    });

    await load();
    return members.find(m => m.email === data.email) ?? null;
  }, [tenantId, actorId, load, members]);

  // All four of these used to be raw table writes against ANOTHER user's
  // profile row -- no RLS policy has ever allowed that (only "own profile"
  // and "platform admin manages all" exist), so they silently did nothing
  // while the optimistic update below made it look like they worked. Now
  // real SECURITY DEFINER RPCs (migration 065) that actually check
  // membership + role. Errors are surfaced for real and the member list is
  // reloaded from the server rather than trusted from an optimistic guess.
  const updateRole = useCallback(async (id: string, role: TenantRole): Promise<string | null> => {
    const member = members.find(m => m.id === id);
    if (!member) return 'Member not found.';
    const { error } = await supabase.rpc('update_team_member_role', {
      p_target_user_id: member.userId,
      p_new_role: role,
    });
    if (error) return error.message;
    await load();
    return null;
  }, [members, load]);

  const updateDepartment = useCallback(async (id: string, department: string): Promise<string | null> => {
    const member = members.find(m => m.id === id);
    if (!member) return 'Member not found.';
    const { error } = await supabase.rpc('update_team_member_department', {
      p_target_user_id: member.userId,
      p_department: department,
    });
    if (error) return error.message;
    await load();
    return null;
  }, [members, load]);

  const toggleStatus = useCallback(async (id: string): Promise<string | null> => {
    const member = members.find(m => m.id === id);
    if (!member) return 'Member not found.';
    const newActive = member.status !== 'active';
    const { error } = await supabase.rpc('set_team_member_status', {
      p_target_user_id: member.userId,
      p_is_active: newActive,
    });
    if (error) return error.message;
    await load();
    return null;
  }, [members, load]);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    const member = members.find(m => m.id === id);
    if (!member) return 'Member not found.';
    const { error } = await supabase.rpc('remove_team_member', { p_target_user_id: member.userId });
    if (error) return error.message;
    await load();
    return null;
  }, [members, load]);

  // Only the current owner can call this (enforced server-side); hands
  // the owner seat to another active teammate and demotes the caller to
  // tenant_admin in the same atomic operation.
  const transferOwnership = useCallback(async (id: string): Promise<string | null> => {
    const member = members.find(m => m.id === id);
    if (!member) return 'Member not found.';
    const { error } = await supabase.rpc('transfer_tenant_ownership', { p_new_owner_user_id: member.userId });
    if (error) return error.message;
    await load();
    return null;
  }, [members, load]);

  const resendInvite = useCallback((id: string) => {
    console.log('Resend invite for', id);
  }, []);

  return { members, loading, invite, updateRole, updateDepartment, toggleStatus, remove, transferOwnership, resendInvite };
}
