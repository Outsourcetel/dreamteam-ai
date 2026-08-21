import { DEFAULT_ACCENT } from '../../design/branding';
import React, { useState, useEffect } from 'react';
import EmployeeProfileDrawer from '../../components/EmployeeProfileDrawer';
import { Modal } from '../../design/primitives';
import type { AuthUser, Tenant } from '../../types';
import { useUsers, ROLE_LABELS, ROLE_PERMISSIONS, type TenantRole, type TeamMember } from '../../lib/useUsers';
import { roleCannot } from '../../lib/navAccess';
import { sendPasswordReset } from '../../lib/api';
import { loadOrgTree } from '../../lib/orgApi';
import type { OrgUnit } from '../../lib/orgApi';
import type { Page } from '../../types';
import { LiveEmptyState } from '../../components/LiveDataStates';


const DEPT_COLORS = [DEFAULT_ACCENT,'#3b82f6','#10b981','#f59e0b','#06b6d4','#8b5cf6','#ec4899','#ef4444','#84cc16','#f97316'];

const ROLE_COLOR: Record<TenantRole, string> = {
  tenant_owner: 'text-amber-400 bg-amber-400/10',
  tenant_admin: 'text-indigo-400 bg-indigo-400/10',
  tenant_manager: 'text-blue-400 bg-blue-400/10',
  knowledge_manager: 'text-emerald-400 bg-emerald-400/10',
  approver: 'text-purple-400 bg-purple-400/10',
  // Default role (useUsers.ts falls back to it), renders on every
  // non-privileged member row and in the Role Permissions Reference — the
  // highest-traffic badge on the page, so it keeps an opaque fill rather
  // than the neutral-soft tint the true fallback (read_only) can afford.
  // Matches the identical tenant_user precedent in SecurityAccessPage
  // (bg-dt-border-strong text-dt-title, ~10:1 contrast in light).
  tenant_user: 'text-dt-title bg-dt-border-strong',
  read_only: 'text-dt-muted bg-dt-panel',
};

const STATUS_COLOR: Record<TeamMember['status'], string> = {
  active: 'text-emerald-400 bg-emerald-400/10',
  pending: 'text-amber-400 bg-amber-400/10',
  deactivated: 'text-dt-muted bg-dt-panel',
};

// "pending" is the column value, not the fact. The fact is that an invitation
// went out and nobody has clicked it — which is a thing the owner might need
// to chase, and reads as nothing at all when it says "pending".
const STATUS_WORD: Record<TeamMember['status'], string> = {
  active: 'active',
  pending: 'invite not accepted yet',
  deactivated: 'switched off',
};

// ── Invite Modal ──────────────────────────────────────────────
const InviteModal = ({
  onClose,
  onInvite,
  currentUser,
  accentColor,
  units,
}: {
  onClose: () => void;
  onInvite: (data: { fullName: string; email: string; role: TenantRole; department: string; invitedBy: string }) => Promise<void>;
  currentUser?: AuthUser;
  accentColor: string;
  /** Real departments and teams from the org tree. There is deliberately no
   *  fallback list — a hard-coded one is exactly what let somebody sit in a
   *  department the picker could not offer. */
  units: OrgUnit[];
}) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('tenant_user');
  const [department, setDepartment] = useState('');
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
    <Modal
      size="md"
      padded={false}
      onClose={onClose}
      title={
        <span className="block">
          Invite team member
          <span className="block text-xs font-normal text-dt-support mt-0.5">
            They'll receive an email to set their password
          </span>
        </span>
      }
    >
      <>
        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
          <div>
            <label className="text-xs text-dt-support mb-1.5 block">Full Name *</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Sarah Mitchell"
              className="w-full bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="text-xs text-dt-support mb-1.5 block">Work Email *</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="sarah@company.com"
              className="w-full bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-dt-support mb-1.5 block">Role</label>
              <select value={role} onChange={e => setRole(e.target.value as TenantRole)}
                className="w-full bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500">
                {(Object.entries(ROLE_LABELS) as [TenantRole, string][])
                  .filter(([r]) => r !== 'tenant_owner') // can't invite another owner
                  .map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-dt-support mb-1.5 block">Department</label>
              <select value={department} onChange={e => setDepartment(e.target.value)}
                className="w-full bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500">
                <option value="">No department</option>
                {units.filter(u => u.kind === 'department' || u.kind === 'team').map(u => (
                  <option key={u.id} value={u.name}>{u.path}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Permissions preview — both halves. The "can" list is curated
              prose; the "can't" list is DERIVED from canAccessPage (handoff
              09), so it moves by itself when a tier changes and cannot drift
              into flattery. An invite is exactly the moment someone needs the
              boundary: the surprise "why can't Priya open Settings?" question
              lands a week later otherwise. */}
          <div className="p-3 rounded-xl bg-dt-panel border border-dt-border">
            <div className="text-xs text-dt-muted mb-2 font-medium">This role can:</div>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_PERMISSIONS[role].map(p => (
                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-dt-neutral-soft text-dt-support">{p}</span>
              ))}
            </div>
            {roleCannot(role).length > 0 && (
              <>
                <div className="text-xs text-dt-muted mt-3 mb-1.5 font-medium">Can't open:</div>
                <p className="text-xs text-dt-support leading-relaxed">
                  {roleCannot(role).join(' · ')}
                </p>
              </>
            )}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm text-dt-support bg-dt-panel hover:bg-dt-panel transition-all">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50"
              style={{ backgroundColor: accentColor }}>
              {loading ? 'Sending...' : 'Send Invitation'}
            </button>
          </div>
        </form>
      </>
    </Modal>
  );
};

// ── Main Page ─────────────────────────────────────────────────
const UserManagementPage = ({ user, tenant, setPage }: { user?: AuthUser; tenant?: Tenant; setPage?: (p: Page) => void }) => {
  const { members, invite, updateRole, updateDepartment, toggleStatus, remove, resendInvite } = useUsers();
  const [showInvite, setShowInvite] = useState(false);
  const [roleFilter, setRoleFilter] = useState<'all' | TenantRole>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TeamMember['status']>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // The full employee record (mig 594). Until now a "user" here was a login,
  // a display name and a role — no job title, no start date, no manager, no
  // phone, and an email column reading a field `profiles` never had.
  const [openRecordFor, setOpenRecordFor] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resettingId, setResettingId] = useState<string | null>(null);

  useEffect(() => {
    // Departments come from the one hierarchy. If this fails the pickers show
    // nothing rather than falling back to invented names.
    loadOrgTree().then(setUnits).catch(() => setUnits([]));
  }, []);

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

  const accentColor = tenant?.primaryColor || DEFAULT_ACCENT;

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
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-dt-title">Team Members</h1>
          <p className="text-dt-support text-sm mt-1">Invite, manage roles, and control access across your organization</p>
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
          <button onClick={() => setActionError('')} className="text-red-400 hover:text-dt-danger">×</button>
        </div>
      )}
      {resetMsg && (
        <div className="mb-4 px-4 py-2.5 rounded-xl bg-dt-ok-soft border border-dt-ok-border text-xs text-dt-ok">
          ✓ {resetMsg}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Members', value: members.length, icon: '◉', sub: 'in your organization' },
          { label: 'Active', value: active, icon: '✓', sub: 'signed in at least once', color: 'text-emerald-400' },
          { label: 'Pending Invites', value: pending, icon: '→', sub: 'awaiting activation', color: 'text-amber-400' },
          { label: 'Deactivated', value: deactivated, icon: '⊘', sub: 'access revoked', color: 'text-dt-muted' },
        ].map((k, i) => (
          <div key={i} className="bg-dt-card border border-dt-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-sm ${k.color || 'text-dt-support'}`}>{k.icon}</span>
              <span className="text-xs text-dt-muted">{k.label}</span>
            </div>
            <div className={`text-2xl font-bold mb-1 ${k.color || 'text-dt-title'}`}>{k.value}</div>
            <div className="text-xs text-dt-faint">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, department..."
          className="flex-1 min-w-48 max-w-xs bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2 text-sm text-dt-body placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-1 bg-dt-panel rounded-lg p-1">
          {(['all', 'active', 'pending', 'deactivated'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-all ${statusFilter === s ? 'text-white' : 'text-dt-support hover:text-dt-body'}`}
              style={statusFilter === s ? { backgroundColor: accentColor } : {}}>
              {s}
            </button>
          ))}
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as any)}
          className="bg-dt-panel border border-dt-border-strong rounded-xl px-3 py-2 text-sm text-dt-body focus:outline-none focus:border-indigo-500">
          <option value="all">All roles</option>
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([r, l]) => (
            <option key={r} value={r}>{l}</option>
          ))}
        </select>
        <span className="text-xs text-dt-muted">{filtered.length} members</span>
      </div>

      {/* Members table */}
      <div className="bg-dt-card border border-dt-border rounded-xl overflow-hidden">
        <div className="hidden lg:grid grid-cols-12 gap-4 px-5 py-3 border-b border-dt-border text-xs font-medium text-dt-muted uppercase tracking-wide">
          <div className="col-span-3">Member</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-2">Department</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Last Seen</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        <div className="divide-y divide-dt-border">
          {filtered.map(m => (
            <div key={m.id} className={`px-5 py-4 hover:bg-dt-panel transition-all ${m.status === 'deactivated' ? 'opacity-50' : ''}`}>
              <div className="lg:grid lg:grid-cols-12 lg:gap-4 lg:items-center flex flex-col gap-3">
                {/* Member */}
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: accentColor + '30', color: accentColor }}>
                    {m.avatar}
                  </div>
                  <div className="min-w-0">
                    <button
                      onClick={() => setOpenRecordFor(m.userId)}
                      className="text-sm font-medium text-dt-title truncate hover:text-dt-accent-text text-left"
                      title="Open employee record"
                    >{m.fullName}</button>
                    <div className="text-xs text-dt-muted truncate">{m.email}</div>
                    {m.invitedBy && m.status === 'pending' && (
                      <div className="text-xs text-dt-faint">Invited by {m.invitedBy}</div>
                    )}
                  </div>
                </div>

                {/* Role */}
                <div className="col-span-2">
                  {editingId === m.id && isAdmin && m.role !== 'tenant_owner' ? (
                    <select value={m.role} onChange={e => { runAction(() => updateRole(m.id, e.target.value as TenantRole)); setEditingId(null); }}
                      onBlur={() => setEditingId(null)} autoFocus
                      className="w-full bg-dt-panel border border-indigo-500 rounded-lg px-2 py-1 text-xs text-dt-body focus:outline-none">
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
                    <select value={m.orgUnitId ?? ''} onChange={e => { runAction(() => updateDepartment(m.id, e.target.value || null)); }}
                      className="w-full bg-dt-panel border border-indigo-500 rounded-lg px-2 py-1 text-xs text-dt-body focus:outline-none">
                      <option value="">No department</option>
                      {units.filter(u => u.kind === 'department' || u.kind === 'team').map(u => (
                        <option key={u.id} value={u.id}>{u.path}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-dt-support">{m.department}</span>
                  )}
                </div>

                {/* Status */}
                <div className="col-span-2 flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_COLOR[m.status]}`}>
                    {STATUS_WORD[m.status]}
                  </span>
                  {m.status === 'pending' && (
                    <button onClick={() => resendInvite(m.id)}
                      className="text-xs text-dt-muted hover:text-dt-support underline transition-all">
                      Resend
                    </button>
                  )}
                </div>

                {/* Last seen */}
                <div className="col-span-2 text-xs text-dt-muted">{m.lastSeen}</div>

                {/* Actions */}
                <div className="col-span-1 flex items-center justify-end gap-2">
                  {/* The employee record was reachable only by clicking a person's
                      NAME, which nobody discovers — the founder reported not being
                      able to find it at all, including their own. A labelled
                      control, on every row, for everyone. */}
                  <button
                    onClick={() => setOpenRecordFor(m.userId)}
                    className="text-xs px-2 py-1 rounded bg-dt-panel text-dt-support hover:text-dt-body transition-all"
                    title={m.userId === user?.id ? 'Open your record' : `Open ${m.fullName}'s record`}
                  >
                    {m.userId === user?.id ? 'My record' : 'Record'}
                  </button>
                  {isAdmin && m.userId !== user?.id && m.role !== 'tenant_owner' && (
                    <>
                      {confirmRemove === m.id ? (
                        <div className="flex gap-1">
                          <button onClick={() => { runAction(() => remove(m.id)); setConfirmRemove(null); }}
                            className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">Remove</button>
                          <button onClick={() => setConfirmRemove(null)}
                            className="text-xs px-2 py-1 rounded bg-dt-border-strong text-dt-title">Cancel</button>
                        </div>
                      ) : (
                        <>
                          {m.status === 'active' && (
                            <button onClick={() => void handleResetPassword(m)}
                              disabled={resettingId === m.id}
                              className="text-xs text-dt-muted hover:text-dt-support transition-all disabled:opacity-50"
                              title="Email a password reset link">
                              🔑
                            </button>
                          )}
                          <button onClick={() => runAction(() => toggleStatus(m.id))}
                            className="text-xs text-dt-muted hover:text-dt-support transition-all"
                            title={m.status === 'active' ? 'Deactivate' : 'Reactivate'}>
                            {m.status === 'active' ? '⊘' : '✓'}
                          </button>
                          <button onClick={() => setConfirmRemove(m.id)}
                            className="text-xs text-dt-faint hover:text-red-400 transition-all"
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
          <LiveEmptyState icon="◎" title="No members match your filter" body="Try a different search or filter." />
        )}
      </div>

      {/* Role reference */}
      <div className="mt-6 bg-dt-card border border-dt-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-dt-title mb-4">Role Permissions Reference</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(Object.entries(ROLE_LABELS) as [TenantRole, string][]).map(([role, label]) => (
            <div key={role} className="p-3 rounded-lg bg-dt-panel">
              <span className={`text-xs px-2 py-0.5 rounded font-medium mb-2 inline-block ${ROLE_COLOR[role]}`}>{label}</span>
              <div className="space-y-1">
                {ROLE_PERMISSIONS[role].map(p => (
                  <div key={p} className="text-xs text-dt-muted flex items-center gap-1.5">
                    <span className="text-dt-faint">·</span>{p}
                  </div>
                ))}
              </div>
              {roleCannot(role).length > 0 && (
                <div className="mt-2 pt-2 border-t border-dt-border space-y-1">
                  {roleCannot(role).map(a => (
                    <div key={a} className="text-xs text-dt-faint flex items-start gap-1.5">
                      <span aria-hidden>✕</span>{a}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Departments live in ONE place now (mig 597).
          This panel used to add, rename, delete and assign a head to rows in
          the `departments` table — a different set of rows from the tree on
          the Organisation page, with its own hard-coded name list. That is
          how somebody could be in "Customer Success" while the department
          picker could not offer it. Both were true, about different lists. */}
      <div className="mt-6 bg-dt-card border border-dt-border rounded-xl p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-dt-title">Departments and teams</h2>
            <p className="text-xs text-dt-muted mt-0.5">
              Locations, departments and teams are managed on the Organisation page, together with who works in each one.
            </p>
          </div>
          <button
            onClick={() => setPage?.('organisation')}
            className="text-xs px-3 py-1.5 rounded-lg text-white transition-all shrink-0"
            style={{ backgroundColor: accentColor }}
          >
            Open Organisation
          </button>
        </div>
      </div>

      {showInvite && (
        <InviteModal
          accentColor={accentColor}
          currentUser={user}
          onClose={() => setShowInvite(false)}
          units={units}
          onInvite={async (data) => { await invite({ ...data, tenantId: tenant?.id }); }}
        />
      )}

      {openRecordFor && (
        <EmployeeProfileDrawer userId={openRecordFor} onClose={() => setOpenRecordFor(null)} />
      )}
    </div>
  );
};

export default UserManagementPage;
