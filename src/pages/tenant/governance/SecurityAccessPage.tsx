import React, { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { PageHeader, th, td } from '../../../components/ui'
import ConfirmDeleteModal from '../../../components/ConfirmDeleteModal'
import Modal from '../../../components/Modal'
import {
  requestSubtenant, fetchTenantDescendants, listTeamMfaStatus,
  listTenantApiKeys, createTenantApiKey, revokeTenantApiKey,
  getTenantSessionPolicy, setTenantSessionPolicy,
  getTenantIpAllowlist, setTenantIpAllowlistEnabled, addTenantIpAllowlistEntry, removeTenantIpAllowlistEntry,
  type TenantAncestryRow, type TeamMfaStatusRow, type TenantApiKey, type TenantIpAllowlistEntry,
} from '../../../lib/api'
import { useUsers, ROLE_LABELS, ROLE_PERMISSIONS, type TenantRole } from '../../../lib/useUsers'

// ═══════════════════════════════════════════════════════════════
// GOVERNANCE — Security & Access (gov_security)
// Migrated from the legacy SecurityPage, then rebuilt against real data
// (2026-07-08 readiness-review page rebuild): human users/roles/MFA and
// the permission reference now come from the real profiles/auth.users/
// auth.mfa_factors tables (migration 089) instead of a hardcoded mock
// list. SSO/API keys/session policy/IP allowlist are being rebuilt in
// the same pass; see their own migrations as each lands.
// ═══════════════════════════════════════════════════════════════

const ROLE_COLORS: Record<TenantRole, string> = {
  tenant_owner: 'bg-red-500/15 text-red-300',
  tenant_admin: 'bg-amber-500/15 text-amber-300',
  tenant_manager: 'bg-blue-500/15 text-blue-300',
  knowledge_manager: 'bg-purple-500/15 text-purple-300',
  approver: 'bg-cyan-500/15 text-cyan-300',
  tenant_user: 'bg-slate-700 text-slate-300',
  read_only: 'bg-slate-800 text-slate-400',
}

// The real permission areas each role carries, straight from useUsers.ts's
// ROLE_PERMISSIONS — the same source the invite-role picker uses. This is
// a reference to what's server-enforced (RLS policies gated on these
// roles, e.g. migration 064), not an independently editable table; there
// is no per-tenant custom RBAC today.
const PERMISSION_AREAS = Array.from(
  new Set(Object.values(ROLE_PERMISSIONS).flat().filter(a => a !== 'All permissions'))
)
const ALL_ROLES = Object.keys(ROLE_LABELS) as TenantRole[]

const API_KEY_SCOPES = ['read:analytics', 'read:knowledge', 'read:conversations', 'write:knowledge'] as const

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-700'}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────
// Manage sub-accounts — tenant-side self-serve entry point (migration
// 050). A tenant owner/admin can request a sub-tenant here. Depending on
// whether the platform has enabled self-serve for this tenant, the
// request either creates the sub-account immediately or is submitted to
// DreamTeam AI for approval — plain language either way, no jargon about
// "provisioning workflows."
// ─────────────────────────────────────────────────────────────────
function ManageSubAccountsPanel({ tenantId }: { tenantId: string }) {
  const [descendants, setDescendants] = useState<TenantAncestryRow[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'created' | 'submitted' | 'error'; message: string } | null>(null)

  const load = () => {
    setLoadingList(true)
    fetchTenantDescendants(tenantId).then(rows => {
      setDescendants(rows)
      setLoadingList(false)
    })
  }

  useEffect(() => { load() }, [tenantId])

  const handleSubmit = async () => {
    if (!name.trim()) return
    setBusy(true)
    setResult(null)
    const res = await requestSubtenant(tenantId, name.trim(), industry.trim() || undefined)
    setBusy(false)
    if (!res.ok) {
      setResult({ kind: 'error', message: res.error || 'Something went wrong — please try again.' })
      return
    }
    if (res.path === 'self_serve') {
      setResult({ kind: 'created', message: `"${name.trim()}" was created right away as a sub-account.` })
      setName('')
      setIndustry('')
      load()
    } else {
      setResult({ kind: 'submitted', message: `Submitted for DreamTeam AI approval — we'll let you know once it's reviewed.` })
      setName('')
      setIndustry('')
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Manage Sub-Accounts</p>
        <p className="text-xs text-slate-500 mt-1">
          Create a smaller workspace under your account for one of your own customers — they get limited,
          customer-focused access, and your data stays separate from theirs.
        </p>
      </div>

      <div className="p-5 space-y-4">
        {!loadingList && descendants.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">{descendants.length} existing sub-account{descendants.length === 1 ? '' : 's'}</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Sub-account name (e.g. Acme Customer Portal)"
            className="bg-slate-950 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
          />
          <input
            value={industry}
            onChange={e => setIndustry(e.target.value)}
            placeholder="Industry (optional)"
            className="bg-slate-950 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={busy || !name.trim()}
          className="px-5 py-2.5 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all"
        >
          {busy ? 'Submitting…' : 'Request sub-account'}
        </button>

        {result && (
          <div className={`text-xs rounded-lg p-3 ${
            result.kind === 'created' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
            : result.kind === 'submitted' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300'
            : 'bg-red-500/10 border border-red-500/30 text-red-300'
          }`}>
            {result.message}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// API keys (migration 090) — real generation/hashing/revocation.
// Owner/admin of the tenant, or a platform admin viewing via Remote
// Access, matching the server-side gate on every RPC this calls.
// ─────────────────────────────────────────────────────────────────
function ApiKeysPanel({ tenantId }: { tenantId: string }) {
  const [keys, setKeys] = useState<TenantApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newScopes, setNewScopes] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [justCreated, setJustCreated] = useState<{ rawKey: string; name: string } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<TenantApiKey | null>(null)

  const load = () => {
    setLoading(true)
    listTenantApiKeys(tenantId).then(rows => { setKeys(rows); setLoading(false) })
  }
  useEffect(() => { load() }, [tenantId])

  const toggleScope = (s: string) =>
    setNewScopes(cur => cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s])

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setCreateError('')
    const res = await createTenantApiKey(tenantId, newName.trim(), newScopes)
    setCreating(false)
    if ('rawKey' in res) {
      setJustCreated({ rawKey: res.rawKey, name: newName.trim() })
      setShowCreate(false)
      setNewName('')
      setNewScopes([])
      load()
    } else {
      setCreateError(res.error)
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">API Keys</p>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
        >
          + Create key
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800">
            <th className={th}>Name</th>
            <th className={th}>Key</th>
            <th className={th}>Scope</th>
            <th className={th}>Created</th>
            <th className={th}>Last used</th>
            <th className={th}></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {!loading && keys.length === 0 && (
            <tr><td colSpan={6} className={`${td} text-slate-500 text-xs text-center py-6`}>No API keys yet.</td></tr>
          )}
          {keys.map(k => (
            <tr key={k.id} className="hover:bg-slate-800/20 transition-colors">
              <td className={`${td} text-slate-200 text-xs font-medium`}>{k.name}</td>
              <td className={`${td} text-slate-400 text-xs font-mono`}>{k.display_hint}</td>
              <td className={`${td} text-slate-400 text-xs`}>{k.scopes.length > 0 ? k.scopes.join(', ') : '—'}</td>
              <td className={`${td} text-slate-500 text-xs`}>{new Date(k.created_at).toLocaleDateString()}</td>
              <td className={`${td} text-slate-500 text-xs`}>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
              <td className={td}>
                {k.revoked_at
                  ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">Revoked</span>
                  : (
                    <button onClick={() => setRevokeTarget(k)} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                      Revoke
                    </button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showCreate && (
        <Modal title="Create API key" onClose={() => { if (!creating) setShowCreate(false) }}>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Name</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Analytics export"
                className="w-full bg-slate-950 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Scope</label>
              <div className="flex flex-wrap gap-2">
                {API_KEY_SCOPES.map(s => (
                  <button
                    key={s}
                    onClick={() => toggleScope(s)}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                      newScopes.includes(s)
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-slate-950 border-slate-700 text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="px-5 py-2.5 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all"
            >
              {creating ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </Modal>
      )}

      {justCreated && (
        <Modal title="API key created" onClose={() => setJustCreated(null)}>
          <div className="space-y-4">
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              Copy this key now — for security, it's shown only once and can't be retrieved again.
            </div>
            <div className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 font-mono text-xs text-emerald-300 break-all">
              {justCreated.rawKey}
            </div>
            <button
              onClick={() => { navigator.clipboard?.writeText(justCreated.rawKey); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Copy to clipboard
            </button>
          </div>
        </Modal>
      )}

      {revokeTarget && (
        <ConfirmDeleteModal
          title="Revoke API key"
          message={`Revoke "${revokeTarget.name}"? Anything using this key will stop working immediately. This can't be undone.`}
          confirmLabel="Revoke"
          onClose={() => setRevokeTarget(null)}
          onConfirm={async () => {
            await revokeTenantApiKey(revokeTarget.id)
            setRevokeTarget(null)
            load()
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// IP allowlist (migration 092) — real, client-side enforced (see
// check-ip-allowlist edge function's header for why not Edge Middleware).
// Owner/admin of the tenant, or a platform admin via Remote Access.
// ─────────────────────────────────────────────────────────────────
function IpAllowlistPanel({ tenantId }: { tenantId: string }) {
  const [enabled, setEnabled] = useState(false)
  const [entries, setEntries] = useState<TenantIpAllowlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [newIp, setNewIp] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [addError, setAddError] = useState('')
  const [toggleError, setToggleError] = useState('')
  const [removeTarget, setRemoveTarget] = useState<TenantIpAllowlistEntry | null>(null)

  const load = () => {
    setLoading(true)
    getTenantIpAllowlist(tenantId).then(a => { setEnabled(a.enabled); setEntries(a.entries); setLoading(false) })
  }
  useEffect(() => { load() }, [tenantId])

  const handleToggle = async (v: boolean) => {
    setToggleError('')
    const res = await setTenantIpAllowlistEnabled(tenantId, v)
    if (!res.ok) { setToggleError(res.error ?? 'Could not update.'); return }
    setEnabled(v)
  }

  const handleAdd = async () => {
    if (!newIp.trim()) return
    setAddError('')
    const res = await addTenantIpAllowlistEntry(tenantId, newIp.trim(), newLabel.trim())
    if (!res.ok) { setAddError(res.error ?? 'Could not add that range.'); return }
    setNewIp('')
    setNewLabel('')
    load()
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">IP Allowlist</p>
          <p className="text-xs text-slate-500 mt-1">
            Restrict sign-in to approved network ranges — checked once per session, not on every request.
          </p>
        </div>
        <Toggle enabled={enabled} onChange={handleToggle} />
      </div>
      {toggleError && <p className="text-xs text-red-400 mb-2">{toggleError}</p>}
      {!enabled && !loading && <p className="text-xs text-slate-500">All networks allowed while disabled.</p>}
      {enabled && (
        <div className="space-y-2">
          {entries.length === 0 && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
              No ranges added — add at least one before this can stay enabled.
            </div>
          )}
          {entries.map(e => (
            <div key={e.id} className="flex gap-2 items-center bg-slate-950 rounded-lg px-3 py-2">
              <span className="flex-1 font-mono text-xs text-slate-200">{e.ip_range}</span>
              <span className="flex-1 text-xs text-slate-500">{e.label || '—'}</span>
              <button
                onClick={() => setRemoveTarget(e)}
                className="text-slate-500 hover:text-red-400 text-xs px-2 transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-center mt-3">
        <input
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          placeholder="192.168.1.0/24" value={newIp}
          onChange={e => setNewIp(e.target.value)}
        />
        <input
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          placeholder="Label (e.g. Office WiFi)" value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
        />
        <button
          onClick={handleAdd}
          disabled={!newIp.trim()}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          + Add range
        </button>
      </div>
      {addError && <p className="text-xs text-red-400 mt-2">{addError}</p>}

      {removeTarget && (
        <ConfirmDeleteModal
          title="Remove IP range"
          message={`Remove "${removeTarget.ip_range}"${removeTarget.label ? ` (${removeTarget.label})` : ''}? Anyone signing in from this range will need a different one, if the allowlist is enabled.`}
          confirmLabel="Remove"
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => {
            await removeTenantIpAllowlistEntry(removeTarget.id)
            setRemoveTarget(null)
            load()
          }}
        />
      )}
    </div>
  )
}

export default function SecurityAccessPage() {
  const { handleSetPage, authedUser, currentTenant, isLiveTenant, isDTUser } = useAuth()

  // ── Real team roster (migration 089's list_team_members_full, via useUsers) ──
  const { members, loading: membersLoading } = useUsers()
  // Matches the server-side gate on list_team_mfa_status / the API-key
  // RPCs (migrations 089/090): the tenant's own owner/admin, or a
  // platform admin viewing via Remote Access.
  const canManageSecurity = isLiveTenant && !!currentTenant?.id && (
    isDTUser || (authedUser?.role && ['tenant_owner', 'tenant_admin'].includes(authedUser.role))
  )
  const [mfaStatus, setMfaStatus] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!canManageSecurity || !currentTenant?.id) return
    listTeamMfaStatus(currentTenant.id).then(rows => {
      const map: Record<string, boolean> = {}
      rows.forEach((r: TeamMfaStatusRow) => { map[r.user_id] = r.mfa_verified })
      setMfaStatus(map)
    })
  }, [canManageSecurity, currentTenant?.id, members.length])

  // ── Session policy (migration 091) — real timeout + MFA-required, ──
  // enforced in AuthContext (inactivity auto-signout, MFA gate). Any
  // tenant member can view it; only owner/admin/platform-admin can save.
  const [timeoutMinutes, setTimeoutMinutes] = useState(480)
  const [mfaRequired, setMfaRequired] = useState(false)
  const [policySaved, setPolicySaved] = useState(false)
  useEffect(() => {
    if (!currentTenant?.id) return
    getTenantSessionPolicy(currentTenant.id).then(p => {
      if (p) { setTimeoutMinutes(p.timeout_minutes); setMfaRequired(p.mfa_required) }
    })
  }, [currentTenant?.id])
  const savePolicy = async (patch: { timeoutMinutes?: number; mfaRequired?: boolean }) => {
    if (!currentTenant?.id || !canManageSecurity) return
    const next = { timeoutMinutes, mfaRequired, ...patch }
    setTimeoutMinutes(next.timeoutMinutes)
    setMfaRequired(next.mfaRequired)
    const res = await setTenantSessionPolicy(currentTenant.id, next.timeoutMinutes, next.mfaRequired)
    if (res.ok) { setPolicySaved(true); setTimeout(() => setPolicySaved(false), 2500) }
  }


  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Security & Access"
          subtitle="Platform RBAC, human users, SSO, API keys, session policy, and network controls"
        />
        <button onClick={() => handleSetPage('gov_trust')}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors">
          Trust &amp; Architecture →
        </button>
      </div>

      <div className="space-y-6">
        {/* ── Manage sub-accounts (migration 050) — real tenant hierarchy, live mode only ── */}
        {isLiveTenant && authedUser?.tenantId && ['tenant_owner', 'tenant_admin'].includes(authedUser.role) && (
          <ManageSubAccountsPanel tenantId={authedUser.tenantId} />
        )}

        {/* ── RBAC permission matrix ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Roles & Permissions</p>
            <p className="text-xs text-slate-500 mt-1">
              What each built-in role can do — enforced by real access-control policy, not independently configurable per tenant.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className={th}>Permission area</th>
                  {ALL_ROLES.map(r => (
                    <th key={r} className={`${th} text-center whitespace-nowrap`}>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${ROLE_COLORS[r]}`}>{ROLE_LABELS[r]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {PERMISSION_AREAS.map(area => (
                  <tr key={area} className="hover:bg-slate-800/20 transition-colors">
                    <td className={`${td} text-slate-200 text-xs`}>{area}</td>
                    {ALL_ROLES.map(r => {
                      const grants = ROLE_PERMISSIONS[r]
                      const has = grants.includes('All permissions') || grants.includes(area)
                      return (
                        <td key={r} className={`${td} text-center`}>
                          {has
                            ? <span className="text-emerald-400 text-sm">✓</span>
                            : <span className="text-slate-700 text-sm">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Human users (real profiles + auth.users email + auth.mfa_factors, migration 089) ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Human Users</p>
            <span className="text-xs text-slate-500">
              {membersLoading ? 'Loading…' : `${members.length} member${members.length === 1 ? '' : 's'} · full management in Users`}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className={th}>Member</th>
                <th className={th}>Email</th>
                <th className={th}>Role</th>
                <th className={th}>MFA</th>
                <th className={th}>Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {!membersLoading && members.length === 0 && (
                <tr><td colSpan={5} className={`${td} text-slate-500 text-xs text-center py-6`}>No team members yet.</td></tr>
              )}
              {members.map(u => (
                <tr key={u.userId} className="hover:bg-slate-800/20 transition-colors">
                  <td className={td}>
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold">
                        {u.avatar}
                      </span>
                      <span className="text-slate-200 text-xs font-medium">{u.fullName}</span>
                    </div>
                  </td>
                  <td className={`${td} text-slate-400 text-xs`}>{u.email}</td>
                  <td className={td}>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${ROLE_COLORS[u.role] ?? ROLE_COLORS.tenant_user}`}>{ROLE_LABELS[u.role] ?? u.role}</span>
                  </td>
                  <td className={td}>
                    {!canManageSecurity
                      ? <span className="text-[10px] text-slate-600">Owner/admin only</span>
                      : mfaStatus[u.userId]
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">Enabled</span>
                        : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Missing</span>}
                  </td>
                  <td className={`${td} text-slate-500 text-xs`}>{u.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── SSO / SAML — honest deferred state ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">SSO / SAML</p>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">Not available yet</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Supabase Auth (the identity system behind this app) has native SAML 2.0 support ready to use —
              it just requires a Supabase Pro plan or above. This workspace is currently on the Free plan,
              which doesn't support SSO at all.
            </p>
            <p className="text-xs text-slate-600 mt-3">
              Upgrade the Supabase project to enable this — no rebuild needed once that's done.
            </p>
          </div>

          {/* ── Session policy card (migration 091) — real, enforced ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Session Policy</p>
              {policySaved && <span className="text-[10px] text-emerald-300">Saved ✓</span>}
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                <span className="text-xs text-slate-300">Session timeout (inactivity)</span>
                <select
                  value={timeoutMinutes}
                  disabled={!canManageSecurity}
                  onChange={e => savePolicy({ timeoutMinutes: Number(e.target.value) })}
                  className="bg-slate-900 border border-slate-700 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none disabled:opacity-50"
                >
                  <option value={60}>1h</option>
                  <option value={240}>4h</option>
                  <option value={480}>8h</option>
                  <option value={1440}>24h</option>
                </select>
              </div>
              <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                <div>
                  <p className="text-xs text-slate-300">MFA required</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">Blocks the app until a human user enrolls a second factor</p>
                </div>
                <Toggle enabled={mfaRequired} onChange={v => canManageSecurity && savePolicy({ mfaRequired: v })} />
              </div>
              <div className="bg-slate-950 rounded-lg px-3 py-2.5">
                <span className="text-xs text-slate-300">Re-auth for sensitive areas</span>
                <p className="text-[10px] text-slate-600 mt-1">
                  Not yet enforced for regular workspace actions. Platform-level Remote Access already requires a
                  verified 2FA code once an operator enrolls one.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── API keys (migration 090) — real generation/hashing/revocation ── */}
        {canManageSecurity && currentTenant?.id ? (
          <ApiKeysPanel tenantId={currentTenant.id} />
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">API Keys</p>
            <p className="text-xs text-slate-500">Only a workspace owner or admin can view and manage API keys.</p>
          </div>
        )}

        {/* ── IP allowlist ── */}
        {canManageSecurity && currentTenant?.id ? (
          <IpAllowlistPanel tenantId={currentTenant.id} />
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">IP Allowlist</p>
            <p className="text-xs text-slate-500">Only a workspace owner or admin can view and manage the IP allowlist.</p>
          </div>
        )}
      </div>
    </div>
  )
}
