import React, { useState } from 'react';
import type { AuthUser, Tenant } from '../../types';
import { useUsers, ROLE_LABELS, ROLE_PERMISSIONS, type TenantRole, type TeamMember } from '../../lib/useUsers';
import { useDepartments } from '../../lib/useDepartments';
import { sendPasswordReset } from '../../lib/api';

const DEPARTMENTS = ['Leadership', 'Customer Success', 'Finance', 'HR & People', 'Legal & Compliance', 'Revenue', 'IT', 'Operations', 'Product', 'Marketing'];

const DEPT_COLORS = ['#6366f1','#3b82f6','#10b981','#f59e0b','#06b6d4','#8b5cf6','#ec4899','#ef4444','#84cc16','#f97316'];

const ROLE_COLOR: Record<TenantRole, string> = {
  tenant_owner: 'text-amber-400 bg-amber-400/10',
  tenant_admin: 'text-indigo-400 bg-indigo-400/10',
  tenant_manager: 'text-blue-400 bg-blue-400/10',
  knowledge_manager: 'text-emerald-400 bg-emerald-400/10',
  approver: 'text-purple-400 bg-purple-400/10',
  tenant_user: 'text-slate-300 bg-slate-600',
  read_only: 'text-slate-500 bg-slate-700',
};

const STATUS_COLOR: Record<TeamMember['status'], string> = {
  active: 'text-emerald-400 bg-emerald-400/10',
  pending: 'text-amber-400 bg-amber-400/10',
  deactivated: 'text-slate-500 bg-slate-700',
};

// ── Invite Modal ──────────────────────────────────────────────
const InviteModal = ({
  onClose,
  onInvite,
  currentUser,
  accentColor,
}: {
  onClose: () => void;
  onInvite: (data: { fullName: string; email: string; role: TenantRole; department: string; invitedBy: string }) => Promise<void>;
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
      await onInvite({ fullName: fullName.trim(), email: email.trim(), role, department, invitedBy: currentUser?.name || 'Admin' });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Invitation failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-700">
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
              className="w-full bg-slate-700 border border-slate-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Work Email *</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="sarah@company.com"
              className="w-full bg-slate-700 border border-slate-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Role</label>
              <select value={role} onChange={e => setRole(e.target.value as TenantRole)}
                className="w-full bg-slate-700 border border-slate-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
                {(Object.entries(ROLE_LABELS) as [TenantRole, string][])
                  .filter(([r]) => r !== 'tenant_owner') // can't invite another owner
                  .map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Department</label>
              <select value={department} onChange={e => setDepartment(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Permissions preview */}
          <div className="p-3 rounded-xl bg-slate-700/50 border border-slate-700">
            <div className="text-xs text-slate-500 mb-2 font-medium">This role can:</div>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_PERMISSIONS[role].map(p => (
                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-slate-600 text-slate-300">{p}</span>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-700 hover:bg-slate-600 transition-all">
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
  const { departments, addDepartment, updateDepartment: updateDept, removeDepartment } = useDepartments();
  const [showInvite, setShowInvite] = useState(false);
  const [showAddDept, setShowAddDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptDesc, setNewDeptDesc] = useState('');
  const [newDeptHead, setNewDeptHead] = useState('');
  const [newDeptColor, setNewDeptColor] = useState(DEPT_COLORS[0]);
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<'all' | TenantRole>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TeamMember['status']>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resettingId, setResettingId] = useState<string | null>(null);

  const runAction = async (action: () => Promise<string | null>) => {
    const err = await action();
    setActionError(err || '');
  };

  const handleResetPassword = async (m: TeamMember) => {
    setResettingId(m.id); setActionError(''); setResetMsg('');
    const res = await sendPasswordReset(m.email);
    setResettingId(null);
    if (!res.ok) { setActionError(res.error || 'Could not send the reset email.'); return; }
    setResetMsg(`Password reset email sent to ${m.email}.`);
    setTimeout(() => setResetMsg(''), 5000);
  };

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
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
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

      {actionError && (
        <div className="mb-4 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="text-red-400 hover:text-red-300">×</button>
        </div>
      )}
      {resetMsg && (
        <div className="mb-4 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
          ✓ {resetMsg}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Members', value: members.length, icon: '◉', sub: 'in your organization' },
          { label: 'Active', value: active, icon: '✓', sub: 'signed in at least once', color: 'text-emerald-400' },
          { label: 'Pending Invites', value: pending, icon: '→', sub: 'awaiting activation', color: 'text-amber-400' },
          { label: 'Deactivated', value: deactivated, icon: '⊘', sub: 'access revoked', color: 'text-slate-500' },
        ].map((k, i) => (
          <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
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
          className="flex-1 min-w-48 max-w-xs bg-slate-700 border border-slate-600 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-slate-700 rounded-lg p-1">
          {(['all', 'active', 'pending', 'deactivated'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-all ${statusFilter === s ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              style={statusFilter === s ? { backgroundColor: accentColor } : {}}>
              {s}
            </button>
          ))}
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as any)}
          className="bg-slate-700 border border-slate-600 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
          <option value="all">All roles</option>
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([r, l]) => (
            <option key={r} value={r}>{l}</option>
          ))}
        </select>
        <span className="text-xs text-slate-500">{filtered.length} members</span>
      </div>

      {/* Members table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="hidden lg:grid grid-cols-12 gap-4 px-5 py-3 border-b border-slate-700 text-xs font-medium text-slate-500 uppercase tracking-wide">
          <div className="col-span-3">Member</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-2">Department</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Last Seen</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        <div className="divide-y divide-slate-700/50">
          {filtered.map(m => (
            <div key={m.id} className={`px-5 py-4 hover:bg-slate-700/30 transition-all ${m.status === 'deactivated' ? 'opacity-50' : ''}`}>
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
                    <select value={m.role} onChange={e => { runAction(() => updateRole(m.id, e.target.value as TenantRole)); setEditingId(null); }}
                      onBlur={() => setEditingId(null)} autoFocus
                      className="w-full bg-slate-700 border border-indigo-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none">
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
                    <select value={m.department} onChange={e => { runAction(() => updateDepartment(m.id, e.target.value)); }}
                      className="w-full bg-slate-700 border border-indigo-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none">
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
                  {isAdmin && m.userId !== user?.id && m.role !== 'tenant_owner' && (
                    <>
                      {confirmRemove === m.id ? (
                        <div className="flex gap-1">
                          <button onClick={() => { runAction(() => remove(m.id)); setConfirmRemove(null); }}
                            className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">Remove</button>
                          <button onClick={() => setConfirmRemove(null)}
                            className="text-xs px-2 py-1 rounded bg-slate-600 text-slate-400">Cancel</button>
                        </div>
                      ) : (
                        <>
                          {m.status === 'active' && (
                            <button onClick={() => void handleResetPassword(m)}
                              disabled={resettingId === m.id}
                              className="text-xs text-slate-500 hover:text-slate-300 transition-all disabled:opacity-50"
                              title="Email a password reset link">
                              🔑
                            </button>
                          )}
                          <button onClick={() => runAction(() => toggleStatus(m.id))}
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
      <div className="mt-6 bg-slate-800 border border-slate-700 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Role Permissions Reference</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([role, label]) => (
            <div key={role} className="p-3 rounded-lg bg-slate-700/40">
              <span className={`text-xs px-2 py-0.5 rounded font-medium mb-2 inline-block ${ROLE_COLOR[role]}`}>{label}</span>
              <div className="space-y-1">
                {ROLE_PERMISSIONS[role].map(p => (
                  <div key={p} className="text-xs text-slate-500 flex items-center gap-1.5">
                    <span className="text-slate-600">·</span>{p}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Department Management */}
      <div className="mt-6 bg-slate-800 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Departments</h2>
            <p className="text-xs text-slate-500 mt-0.5">Organise your team and Digital Employees by department</p>
          </div>
          {isAdmin && (
            <button
              onClick={() => setShowAddDept(v => !v)}
              className="text-xs px-3 py-1.5 rounded-lg text-white transition-all"
              style={{ backgroundColor: accentColor }}
            >
              + Add Department
            </button>
          )}
        </div>

        {showAddDept && (
          <div className="mb-4 p-4 bg-slate-700/60 rounded-xl border border-slate-600 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Name</label>
                <input value={newDeptName} onChange={e => setNewDeptName(e.target.value)}
                  placeholder="e.g. Product"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Head of Department</label>
                <select value={newDeptHead} onChange={e => setNewDeptHead(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="">None assigned</option>
                  {members.filter(m => m.status === 'active').map(m => (
                    <option key={m.id} value={m.fullName}>{m.fullName}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Description</label>
              <input value={newDeptDesc} onChange={e => setNewDeptDesc(e.target.value)}
                placeholder="Short description of this department's function"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Colour</label>
              <div className="flex items-center gap-2">
                {DEPT_COLORS.map(c => (
                  <button key={c} onClick={() => setNewDeptColor(c)}
                    className={`w-6 h-6 rounded-full border-2 transition-all ${newDeptColor === c ? 'border-white scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!newDeptName.trim()) return;
                  addDepartment({ name: newDeptName.trim(), description: newDeptDesc.trim(), head: newDeptHead, color: newDeptColor });
                  setNewDeptName(''); setNewDeptDesc(''); setNewDeptHead(''); setNewDeptColor(DEPT_COLORS[0]);
                  setShowAddDept(false);
                }}
                className="px-4 py-1.5 text-sm text-white rounded-lg transition-all"
                style={{ backgroundColor: accentColor }}
              >Create</button>
              <button onClick={() => setShowAddDept(false)} className="px-4 py-1.5 text-sm text-slate-400 hover:text-white bg-slate-600 rounded-lg transition-all">Cancel</button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {departments.map(dept => {
            const deptMembers = members.filter(m => m.department === dept.name && m.status === 'active');
            return (
              <div key={dept.id} className="bg-slate-700/40 rounded-xl p-4 border border-slate-600/50 hover:border-slate-600 transition-all group">
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
                    style={{ backgroundColor: dept.color + '30', color: dept.color }}>
                    {dept.name[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-white truncate">{dept.name}</div>
                    {dept.head && <div className="text-xs text-slate-500 truncate">Lead: {dept.head}</div>}
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => removeDepartment(dept.id)}
                      className="text-slate-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Remove department"
                    >✕</button>
                  )}
                </div>
                {dept.description && <p className="text-xs text-slate-500 mb-3 line-clamp-2">{dept.description}</p>}
                <div className="flex items-center justify-between">
                  <div className="flex -space-x-1">
                    {deptMembers.slice(0, 4).map(m => (
                      <div key={m.id} title={m.fullName}
                        className="w-5 h-5 rounded-full border border-slate-800 text-xs flex items-center justify-center font-bold text-white"
                        style={{ backgroundColor: dept.color + '60', color: dept.color }}>
                        {m.avatar[0]}
                      </div>
                    ))}
                    {deptMembers.length > 4 && (
                      <div className="w-5 h-5 rounded-full bg-slate-600 border border-slate-800 text-xs flex items-center justify-center text-slate-400">+{deptMembers.length - 4}</div>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">{deptMembers.length} active</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showInvite && (
        <InviteModal
          accentColor={accentColor}
          currentUser={user}
          onClose={() => setShowInvite(false)}
          onInvite={async (data) => { await invite({ ...data, tenantId: tenant?.id }); }}
        />
      )}
    </div>
  );
};

export default UserManagementPage;
