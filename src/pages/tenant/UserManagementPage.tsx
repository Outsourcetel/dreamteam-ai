import React, { useState } from 'react';
import { supabase } from '../../supabase';
import type { AuthUser, Tenant } from '../../types';
import { useUsers, ROLE_LABELS, ROLE_PERMISSIONS, type TenantRole, type TeamMember } from '../../lib/useUsers';

const DEPARTMENTS = ['Leadership', 'Customer Success', 'Finance', 'HR & People', 'Legal & Compliance', 'Revenue', 'IT', 'Operations', 'Product', 'Marketing'];

const ROLE_COLOR: Record<TenantRole, string> = {
  tenant_owner: 'text-amber-400 bg-amber-400/10',
  tenant_admin: 'text-indigo-400 bg-indigo-400/10',
  tenant_manager: 'text-blue-400 bg-blue-400/10',
  knowledge_manager: 'text-emerald-400 bg-emerald-400/10',
  approver: 'text-purple-400 bg-purple-400/10',
  tenant_user: 'text-slate-300 bg-slate-700',
  read_only: 'text-slate-500 bg-slate-800',
};

const STATUS_COLOR: Record<TeamMember['status'], string> = {
  active: 'text-emerald-400 bg-emerald-400/10',
  pending: 'text-amber-400 bg-amber-400/10',
  deactivated: 'text-slate-500 bg-slate-800',
};

// ── Invite Modal ──────────────────────────────────────────────
const InviteModal = ({
  onClose,
  onInvite,
  currentUser,
  accentColor,
}: {
  onClose: () => void;
  onInvite: (data: { fullName: string; email: string; role: TenantRole; department: string; invitedBy: string }) => void;
  currentUser?: AuthUser;
  accentColor: string;
}) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('tenant_user');
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !email.trim()) { setError('Name and email are required.'); return; }
    setError('');
    setLoading(true);
    try {
      // Attempt real Supabase invite — graceful fallback if not configured
      await supabase.auth.signUp({
        email: email.trim(),
        password: Math.random().toString(36).slice(2) + 'Aa1!', // temp password
        options: {
          data: { full_name: fullName.trim(), role, layer: 'tenant' },
        },
      });
    } catch {
      // Non-fatal — still add to local list
    } finally {
      onInvite({ fullName: fullName.trim(), email: email.trim(), role, department, invitedBy: currentUser?.name || 'Admin' });
      setLoading(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-bold text-white">Invite Team Member</h2>
            <p className="text-xs text-slate-400 mt-0.5">They'll receive an email to set their password</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Full Name *</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Sarah Mitchell"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Work Email *</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="sarah@company.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Role</label>
              <select value={role} onChange={e => setRole(e.target.value as TenantRole)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
                {(Object.entries(ROLE_LABELS) as [TenantRole, string][])
                  .filter(([r]) => r !== 'tenant_owner') // can't invite another owner
                  .map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Department</label>
              <select value={department} onChange={e => setDepartment(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Permissions preview */}
          <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-800">
            <div className="text-xs text-slate-500 mb-2 font-medium">This role can:</div>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_PERMISSIONS[role].map(p => (
                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">{p}</span>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-800 hover:bg-slate-700 transition-all">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50"
              style={{ backgroundColor: accentColor }}>
              {loading ? 'Sending...' : 'Send Invitation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────
const UserManagementPage = ({ user, tenant }: { user?: AuthUser; tenant?: Tenant }) => {
  const { members, invite, updateRole, updateDepartment, toggleStatus, remove, resendInvite } = useUsers();
  const [showInvite, setShowInvite] = useState(false);
  const [roleFilter, setRoleFilter] = useState<'all' | TenantRole>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TeamMember['status']>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const accentColor = tenant?.primaryColor || '#6366f1';

  const filtered = members.filter(m => {
    const matchRole = roleFilter === 'all' || m.role === roleFilter;
    const matchStatus = statusFilter === 'all' || m.status === statusFilter;
    const matchSearch = !search || m.fullName.toLowerCase().includes(search.toLowerCase()) || m.email.toLowerCase().includes(search.toLowerCase()) || m.department.toLowerCase().includes(search.toLowerCase());
    return matchRole && matchStatus && matchSearch;
  });

  const active = members.filter(m => m.status === 'active').length;
  const pending = members.filter(m => m.status === 'pending').length;
  const deactivated = members.filter(m => m.status === 'deactivated').length;

  const isOwner = user?.role === 'tenant_owner' || user?.role === 'dt_super_admin';
  const isAdmin = isOwner || user?.role === 'tenant_admin';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Team Members</h1>
          <p className="text-slate-400 text-sm mt-1">Invite, manage roles, and control access across your organization</p>
        </div>
        {isAdmin && (
          <button onClick={() => setShowInvite(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: accentColor }}>
            + Invite Member
          </button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Members', value: members.length, icon: '◉', sub: 'in your organization' },
          { label: 'Active', value: active, icon: '✓', sub: 'signed in at least once', color: 'text-emerald-400' },
          { label: 'Pending Invites', value: pending, icon: '→', sub: 'awaiting activation', color: 'text-amber-400' },
          { label: 'Deactivated', value: deactivated, icon: '⊘', sub: 'access revoked', color: 'text-slate-500' },
        ].map((k, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-sm ${k.color || 'text-slate-400'}`}>{k.icon}</span>
              <span className="text-xs text-slate-500">{k.label}</span>
            </div>
            <div className={`text-2xl font-bold mb-1 ${k.color || 'text-white'}`}>{k.value}</div>
            <div className="text-xs text-slate-600">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, department..."
          className="flex-1 min-w-48 max-w-xs bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'active', 'pending', 'deactivated'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-all ${statusFilter === s ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              style={statusFilter === s ? { backgroundColor: accentColor } : {}}>
              {s}
            </button>
          ))}
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as any)}
          className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
          <option value="all">All roles</option>
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([r, l]) => (
            <option key={r} value={r}>{l}</option>
          ))}
        </select>
        <span className="text-xs text-slate-500">{filtered.length} members</span>
      </div>

      {/* Members table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="hidden lg:grid grid-cols-12 gap-4 px-5 py-3 border-b border-slate-800 text-xs font-medium text-slate-500 uppercase tracking-wide">
          <div className="col-span-3">Member</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-2">Department</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Last Seen</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        <div className="divide-y divide-slate-800/50">
          {filtered.map(m => (
            <div key={m.id} className={`px-5 py-4 hover:bg-slate-800/30 transition-all ${m.status === 'deactivated' ? 'opacity-50' : ''}`}>
              <div className="lg:grid lg:grid-cols-12 lg:gap-4 lg:items-center flex flex-col gap-3">
                {/* Member */}
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: accentColor + '30', color: accentColor }}>
                    {m.avatar}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">{m.fullName}</div>
                    <div className="text-xs text-slate-500 truncate">{m.email}</div>
                    {m.invitedBy && m.status === 'pending' && (
                      <div className="text-xs text-slate-600">Invited by {m.invitedBy}</div>
                    )}
                  </div>
                </div>

                {/* Role */}
                <div className="col-span-2">
                  {editingId === m.id && isAdmin && m.role !== 'tenant_owner' ? (
                    <select value={m.role} onChange={e => { updateRole(m.id, e.target.value as TenantRole); setEditingId(null); }}
                      onBlur={() => setEditingId(null)} autoFocus
                      className="w-full bg-slate-800 border border-indigo-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none">
                      {(Object.entries(ROLE_LABELS) as [TenantRole, string][])
                        .filter(([r]) => r !== 'tenant_owner')
                        .map(([r, l]) => <option key={r} value={r}>{l}</option>)}
                    </select>
                  ) : (
                    <button onClick={() => isAdmin && m.role !== 'tenant_owner' && setEditingId(m.id)}
                      className={`text-xs px-2 py-1 rounded font-medium ${ROLE_COLOR[m.role]} ${isAdmin && m.role !== 'tenant_owner' ? 'hover:ring-1 hover:ring-slate-600 cursor-pointer' : 'cursor-default'}`}>
                      {ROLE_LABELS[m.role]}
                    </button>
                  )}
                </div>

                {/* Department */}
                <div className="col-span-2">
                  {editingId === m.id && isAdmin ? (
                    <select value={m.department} onChange={e => { updateDepartment(m.id, e.target.value); }}
                      className="w-full bg-slate-800 border border-indigo-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none">
                      {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-400">{m.department}</span>
                  )}
                </div>

                {/* Status */}
                <div className="col-span-2 flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_COLOR[m.status]}`}>
                    {m.status}
                  </span>
                  {m.status === 'pending' && (
                    <button onClick={() => resendInvite(m.id)}
                      className="text-xs text-slate-500 hover:text-slate-300 underline transition-all">
                      Resend
                    </button>
                  )}
                </div>

                {/* Last seen */}
                <div className="col-span-2 text-xs text-slate-500">{m.lastSeen}</div>

                {/* Actions */}
                <div className="col-span-1 flex items-center justify-end gap-2">
                  {isAdmin && m.id !== user?.id && m.role !== 'tenant_owner' && (
                    <>
                      {confirmRemove === m.id ? (
                        <div className="flex gap-1">
                          <button onClick={() => { remove(m.id); setConfirmRemove(null); }}
                            className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">Remove</button>
                          <button onClick={() => setConfirmRemove(null)}
                            className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-400">Cancel</button>
                        </div>
                      ) : (
                        <>
                          <button onClick={() => toggleStatus(m.id)}
                            className="text-xs text-slate-500 hover:text-slate-300 transition-all"
                            title={m.status === 'active' ? 'Deactivate' : 'Reactivate'}>
                            {m.status === 'active' ? '⊘' : '✓'}
                          </button>
                          <button onClick={() => setConfirmRemove(m.id)}
                            className="text-xs text-slate-600 hover:text-red-400 transition-all"
                            title="Remove member">
                            ×
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="py-16 text-center">
            <div className="text-slate-600 text-sm">No members match your filter</div>
          </div>
        )}
      </div>

      {/* Role reference */}
      <div className="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Role Permissions Reference</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([role, label]) => (
            <div key={role} className="p-3 rounded-lg bg-slate-800/40">
              <span className={`text-xs px-2 py-0.5 rounded font-medium mb-2 inline-block ${ROLE_COLOR[role]}`}>{label}</span>
              <div className="space-y-1">
                {ROLE_PERMISSIONS[role].map(p => (
                  <div key={p} className="text-xs text-slate-500 flex items-center gap-1.5">
                    <span className="text-slate-700">·</span>{p}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {showInvite && (
        <InviteModal
          accentColor={accentColor}
          currentUser={user}
          onClose={() => setShowInvite(false)}
          onInvite={(data) => { invite(data); setShowInvite(false); }}
        />
      )}
    </div>
  );
};

export default UserManagementPage;
