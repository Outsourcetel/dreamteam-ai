import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  listPlatformTeam, updatePlatformTeamRole, setPlatformTeamActive,
  listPlatformCapabilityGrants, setPlatformCapabilityGrant, revokePlatformCapabilityGrant,
  PLATFORM_INVITE_ROLE_LABELS, PLATFORM_CAPABILITIES, PLATFORM_CAPABILITY_LABELS,
  sendPasswordReset,
} from '../../lib/api';
import type { PlatformTeamMember, PlatformInviteRole, PlatformCapability, PlatformCapabilityGrant } from '../../lib/api';
import PlatformInvitesPanel from './PlatformInvitesPanel';

const ROLE_OPTIONS: PlatformInviteRole[] = ['platform_support', 'platform_billing', 'platform_super_admin'];

const inputCls = 'bg-dt-panel border border-dt-border-strong text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500';

// ─────────────────────────────────────────────────────────────────
// The real team roster (active accounts, not just pending invites),
// with role editing, active/inactive control, and a per-person
// capability-grant editor. Every mutation goes through the guarded
// RPCs from migration 077 — this page is a thin client over them, the
// same discipline the tenant-side User Management page already uses.
// ─────────────────────────────────────────────────────────────────
const PlatformTeamPage = () => {
  const { authedUser } = useAuth();
  const [members, setMembers] = useState<PlatformTeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [permissionsFor, setPermissionsFor] = useState<PlatformTeamMember | null>(null);

  const load = () => {
    setLoading(true);
    listPlatformTeam().then((res) => {
      if (res.ok) setMembers(res.members);
      else setErr(res.error || 'Could not load the platform team.');
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleRoleChange = async (userId: string, newRole: PlatformInviteRole) => {
    setBusyId(userId); setErr(null);
    const res = await updatePlatformTeamRole(userId, newRole);
    setBusyId(null); setEditingRoleId(null);
    if (!res.ok) { setErr(res.error || 'Could not change that role.'); return; }
    load();
  };

  const handleToggleActive = async (m: PlatformTeamMember) => {
    setBusyId(m.user_id); setErr(null);
    const res = await setPlatformTeamActive(m.user_id, !m.is_active);
    setBusyId(null);
    if (!res.ok) { setErr(res.error || 'Could not change that account\'s active status.'); return; }
    load();
  };

  const handleResetPassword = async (m: PlatformTeamMember) => {
    setBusyId(m.user_id); setErr(null);
    const res = await sendPasswordReset(m.email);
    setBusyId(null);
    if (!res.ok) { setErr(res.error || 'Could not send the reset email.'); return; }
    setToast(`Password reset email sent to ${m.email}.`);
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Team & Permissions</h1>
        <p className="text-dt-support text-sm mt-1">
          Who has access to this platform, and exactly what each person can do.
        </p>
      </div>

      {toast && <div className="mb-4 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-300">✓ {toast}</div>}
      {err && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">{err}</div>}

      <PlatformInvitesPanel />

      <div className="bg-dt-card border border-dt-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-dt-border">
          <h2 className="text-sm font-semibold text-white">Platform team</h2>
          <p className="text-xs text-dt-muted mt-0.5">Everyone with platform-level access today — not just pending invites.</p>
        </div>
        {loading ? (
          <p className="text-xs text-dt-muted text-center py-6">Loading team…</p>
        ) : members.length === 0 ? (
          <p className="text-xs text-dt-muted text-center py-6">No platform team members found.</p>
        ) : (
          <div className="divide-y divide-slate-700/50">
            {members.map((m) => {
              const isSelf = authedUser?.id === m.user_id;
              const busy = busyId === m.user_id;
              return (
                <div key={m.user_id} className={`px-5 py-3 flex items-center gap-3 flex-wrap ${!m.is_active ? 'opacity-50' : ''}`}>
                  <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                    {(m.full_name || m.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-[160px] flex-1">
                    <p className="text-sm text-white truncate">{m.full_name || m.email}{isSelf && <span className="text-[10px] text-dt-muted ml-1.5">(you)</span>}</p>
                    <p className="text-[11px] text-dt-muted truncate">{m.email}</p>
                  </div>

                  {editingRoleId === m.user_id ? (
                    <select
                      value={m.role} disabled={busy} autoFocus
                      onChange={(e) => void handleRoleChange(m.user_id, e.target.value as PlatformInviteRole)}
                      onBlur={() => setEditingRoleId(null)}
                      className={inputCls}
                    >
                      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{PLATFORM_INVITE_ROLE_LABELS[r]}</option>)}
                    </select>
                  ) : (
                    <button
                      onClick={() => !isSelf && setEditingRoleId(m.user_id)}
                      disabled={isSelf}
                      className={`text-[11px] px-2 py-1 rounded-lg bg-dt-panel text-dt-support ${isSelf ? 'cursor-default opacity-60' : 'hover:ring-1 hover:ring-slate-600 cursor-pointer'}`}
                      title={isSelf ? 'You cannot change your own role' : 'Click to change role'}
                    >
                      {PLATFORM_INVITE_ROLE_LABELS[m.role]}
                    </button>
                  )}

                  <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${m.is_active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-600 text-dt-support'}`}>
                    {m.is_active ? 'active' : 'inactive'}
                  </span>

                  <span className="text-[11px] text-dt-faint whitespace-nowrap">
                    {m.last_sign_in_at ? `last seen ${new Date(m.last_sign_in_at).toLocaleDateString()}` : 'never signed in'}
                  </span>

                  <button
                    onClick={() => setPermissionsFor(m)}
                    className="text-[11px] px-2 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors"
                  >
                    Manage permissions
                  </button>

                  {!isSelf && (
                    <button
                      onClick={() => void handleResetPassword(m)}
                      disabled={busy}
                      className="text-[11px] px-2 py-1 rounded-lg text-dt-support hover:bg-dt-panel transition-colors"
                      title="Email this person a password reset link"
                    >
                      Reset password
                    </button>
                  )}

                  {!isSelf && (
                    <button
                      onClick={() => void handleToggleActive(m)}
                      disabled={busy}
                      className={`text-[11px] px-2 py-1 rounded-lg transition-colors ${m.is_active ? 'text-rose-400 hover:bg-rose-500/10' : 'text-emerald-400 hover:bg-emerald-500/10'}`}
                      title={m.is_active ? 'Revoke access' : 'Restore access'}
                    >
                      {m.is_active ? 'Revoke access' : 'Restore access'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {permissionsFor && (
        <PermissionsModal
          member={permissionsFor}
          onClose={() => setPermissionsFor(null)}
          onChanged={() => setToast(`Permissions updated for ${permissionsFor.full_name || permissionsFor.email}.`)}
        />
      )}
    </div>
  );
};

// ── Per-person capability editor ───────────────────────────────────
const ROLE_DEFAULTS: Record<PlatformInviteRole, PlatformCapability[]> = {
  platform_super_admin: [...PLATFORM_CAPABILITIES],
  platform_support: ['tenants.view', 'remote_access.use', 'remote_access.audit', 'support.cross_tenant'],
  platform_billing: ['tenants.view', 'remote_access.audit', 'billing.manage'],
};

function PermissionsModal({ member, onClose, onChanged }: {
  member: PlatformTeamMember; onClose: () => void; onChanged: () => void;
}) {
  const [grants, setGrants] = useState<PlatformCapabilityGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCap, setBusyCap] = useState<PlatformCapability | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listPlatformCapabilityGrants(member.user_id).then((res) => {
      if (res.ok) setGrants(res.grants);
      else setErr(res.error || 'Could not load permissions.');
      setLoading(false);
    });
  };
  useEffect(() => { load(); }, [member.user_id]);

  const roleDefault = ROLE_DEFAULTS[member.role] ?? [];

  const cycle = async (cap: PlatformCapability, current: 'grant' | 'deny' | 'default') => {
    setBusyCap(cap); setErr(null);
    // role default -> explicit grant -> explicit deny -> back to role default
    let res;
    if (current === 'default') res = await setPlatformCapabilityGrant(member.user_id, cap, 'grant');
    else if (current === 'grant') res = await setPlatformCapabilityGrant(member.user_id, cap, 'deny');
    else res = await revokePlatformCapabilityGrant(member.user_id, cap);
    setBusyCap(null);
    if (!res.ok) { setErr(res.error || 'Could not change that permission.'); return; }
    load();
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-dt-card border border-dt-border-strong rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-white font-semibold">Permissions — {member.full_name || member.email}</h3>
          <button onClick={onClose} className="text-dt-muted hover:text-white text-lg leading-none">✕</button>
        </div>
        <p className="text-[11px] text-dt-muted mb-4">
          {PLATFORM_INVITE_ROLE_LABELS[member.role]} by default. Click a permission to override it for this person specifically — grant something their role wouldn't normally include, or deny something it would.
        </p>
        {err && <p className="text-[11px] text-rose-400 mb-3">✗ {err}</p>}
        {loading ? (
          <p className="text-xs text-dt-muted text-center py-6">Loading…</p>
        ) : (
          <div className="space-y-1.5">
            {PLATFORM_CAPABILITIES.map((cap) => {
              const override = grants.find((g) => g.capability === cap);
              const state: 'grant' | 'deny' | 'default' = override ? override.effect : 'default';
              const effective = override ? override.effect === 'grant' : roleDefault.includes(cap);
              const busy = busyCap === cap;
              return (
                <button
                  key={cap}
                  onClick={() => void cycle(cap, state)}
                  disabled={busy}
                  className={`w-full flex items-center justify-between gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                    effective ? 'border-emerald-800/50 bg-emerald-500/5' : 'border-dt-border bg-dt-inset'
                  } ${busy ? 'opacity-50' : 'hover:border-dt-border-strong'}`}
                >
                  <span className="text-xs text-dt-body">{PLATFORM_CAPABILITY_LABELS[cap]}</span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${effective ? 'bg-emerald-500/15 text-emerald-300' : 'bg-dt-panel text-dt-muted'}`}>
                      {effective ? 'allowed' : 'not allowed'}
                    </span>
                    <span className="text-[10px] text-dt-faint w-24 text-right">
                      {state === 'default' ? '(role default)' : state === 'grant' ? '(explicit grant)' : '(explicit deny)'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[10px] text-dt-faint mt-4">Click a row to cycle: role default → explicit grant → explicit deny → back to role default.</p>
      </div>
    </div>
  );
}

export default PlatformTeamPage;
