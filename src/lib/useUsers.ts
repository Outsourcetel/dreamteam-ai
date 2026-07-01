import { useState, useEffect, useCallback } from 'react';

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

const DEFAULT_MEMBERS: TeamMember[] = [
  { id: 'u1', fullName: 'Sarah Mitchell', email: 'sarah@company.com', role: 'tenant_owner', department: 'Leadership', status: 'active', avatar: 'SM', lastSeen: '2 min ago', joinedAt: '2026-01-15' },
  { id: 'u2', fullName: 'James Okafor', email: 'james@company.com', role: 'tenant_admin', department: 'IT', status: 'active', avatar: 'JO', lastSeen: '1h ago', joinedAt: '2026-01-22' },
  { id: 'u3', fullName: 'Priya Nair', email: 'priya@company.com', role: 'knowledge_manager', department: 'Operations', status: 'active', avatar: 'PN', lastSeen: '3h ago', joinedAt: '2026-02-01' },
  { id: 'u4', fullName: 'Tom Bergmann', email: 'tom@company.com', role: 'approver', department: 'Finance', status: 'active', avatar: 'TB', lastSeen: 'Yesterday', joinedAt: '2026-02-14' },
  { id: 'u5', fullName: 'Elena Vasquez', email: 'elena@company.com', role: 'tenant_manager', department: 'Customer Success', status: 'active', avatar: 'EV', lastSeen: '30 min ago', joinedAt: '2026-03-01' },
  { id: 'u6', fullName: 'Marcus Webb', email: 'marcus@company.com', role: 'tenant_user', department: 'Revenue', status: 'active', avatar: 'MW', lastSeen: '2 days ago', joinedAt: '2026-03-10' },
  { id: 'u7', fullName: 'Aisha Koroma', email: 'aisha@company.com', role: 'tenant_user', department: 'HR & People', status: 'pending', avatar: 'AK', lastSeen: 'Never', joinedAt: '2026-07-01', invitedBy: 'Sarah Mitchell' },
  { id: 'u8', fullName: 'Daniel Cho', email: 'daniel@company.com', role: 'read_only', department: 'Legal & Compliance', status: 'pending', avatar: 'DC', lastSeen: 'Never', joinedAt: '2026-07-01', invitedBy: 'James Okafor' },
];

const STORAGE_KEY = 'dt_team_members';

function load(): TeamMember[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function save(members: TeamMember[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(members)); } catch {}
}

export function useUsers() {
  const [members, setMembers] = useState<TeamMember[]>(() => load() ?? DEFAULT_MEMBERS);

  useEffect(() => { save(members); }, [members]);

  const invite = useCallback((data: { fullName: string; email: string; role: TenantRole; department: string; invitedBy: string }) => {
    const newMember: TeamMember = {
      id: 'u_' + Date.now(),
      fullName: data.fullName,
      email: data.email,
      role: data.role,
      department: data.department,
      status: 'pending',
      avatar: data.fullName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase(),
      lastSeen: 'Never',
      joinedAt: new Date().toISOString().split('T')[0],
      invitedBy: data.invitedBy,
    };
    setMembers(prev => [...prev, newMember]);
    return newMember;
  }, []);

  const updateRole = useCallback((id: string, role: TenantRole) => {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, role } : m));
  }, []);

  const updateDepartment = useCallback((id: string, department: string) => {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, department } : m));
  }, []);

  const toggleStatus = useCallback((id: string) => {
    setMembers(prev => prev.map(m =>
      m.id === id ? { ...m, status: m.status === 'active' ? 'deactivated' : 'active' } : m
    ));
  }, []);

  const remove = useCallback((id: string) => {
    setMembers(prev => prev.filter(m => m.id !== id));
  }, []);

  const resendInvite = useCallback((id: string) => {
    // In production: call Supabase to resend confirmation email
    console.log('Resend invite for', id);
  }, []);

  return { members, invite, updateRole, updateDepartment, toggleStatus, remove, resendInvite };
}
