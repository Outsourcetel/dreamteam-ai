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
import { supabase } from '../../../supabase'
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates'

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
  tenant_user: 'bg-slate-600 text-slate-300',
  read_only: 'bg-slate-700 text-slate-400',
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
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-600'}`}>
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
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-700">
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
            className="bg-slate-900 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
          />
          <input
            value={industry}
            onChange={e => setIndustry(e.target.value)}
            placeholder="Industry (optional)"
            className="bg-slate-900 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
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
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
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
          <tr className="border-b border-slate-700">
            <th className={th}>Name</th>
            <th className={th}>Key</th>
            <th className={th}>Scope</th>
            <th className={th}>Created</th>
            <th className={th}>Last used</th>
            <th className={th}></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {!loading && keys.length === 0 && (
            <tr><td colSpan={6} className={`${td} text-slate-500 text-xs text-center py-6`}>No API keys yet.</td></tr>
          )}
          {keys.map(k => (
            <tr key={k.id} className="hover:bg-slate-700/20 transition-colors">
              <td className={`${td} text-slate-200 text-xs font-medium`}>{k.name}</td>
              <td className={`${td} text-slate-400 text-xs font-mono`}>{k.display_hint}</td>
              <td className={`${td} text-slate-400 text-xs`}>{k.scopes.length > 0 ? k.scopes.join(', ') : '—'}</td>
              <td className={`${td} text-slate-500 text-xs`}>{new Date(k.created_at).toLocaleDateString()}</td>
              <td className={`${td} text-slate-500 text-xs`}>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
              <td className={td}>
                {k.revoked_at
                  ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500">Revoked</span>
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
                className="w-full bg-slate-900 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
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
                        : 'bg-slate-900 border-slate-600 text-slate-400 hover:border-slate-500'
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
            <div className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 font-mono text-xs text-emerald-300 break-all">
              {justCreated.rawKey}
            </div>
            <button
              onClick={() => { navigator.clipboard?.writeText(justCreated.rawKey); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors"
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
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
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
            <div key={e.id} className="flex gap-2 items-center bg-slate-900 rounded-lg px-3 py-2">
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
          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          placeholder="192.168.1.0/24" value={newIp}
          onChange={e => setNewIp(e.target.value)}
        />
        <input
          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
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

// ─────────────────────────────────────────────────────────────────
// Access & security activity — the tenant-wide, date-windowed
// timeline of who changed security-relevant configuration and when.
// Reads tenant_activity_log (migration 066/067 write-audit trigger)
// filtered to the access/security table set. Migration 152 attached
// the trigger to the API-key/session-policy/IP-allowlist tables so
// those events are captured here too (they shipped after the original
// trigger batch). RLS restricts SELECT to owner/admin, so this is
// gated to them; a platform admin viewing via Remote Access inherits
// the tenant context. Point-in-time config lives in the panels above;
// this is the "what changed over the last N days" view.
// ─────────────────────────────────────────────────────────────────
interface SecurityActivityRow {
  id: number
  actor_name: string | null
  actor_role: string | null
  table_name: string
  operation: string
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  created_at: string
}

const SECURITY_TABLE_LABELS: Record<string, string> = {
  profiles: 'Team member / role',
  tenant_api_keys: 'API key',
  tenant_session_policies: 'Session policy',
  tenant_ip_allowlists: 'IP allowlist',
  tenant_ip_allowlist_entries: 'IP allowlist entry',
  data_access_grants: 'Data-access grant',
}
const SECURITY_TABLES = Object.keys(SECURITY_TABLE_LABELS)

const SEC_RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: null },
]

const secOperationVerb: Record<string, string> = { INSERT: 'Added', UPDATE: 'Changed', DELETE: 'Removed' }
const secOperationBadge: Record<string, string> = {
  INSERT: 'bg-emerald-500/15 text-emerald-300',
  UPDATE: 'bg-blue-500/15 text-blue-300',
  DELETE: 'bg-red-500/15 text-red-300',
}

function securityChangedFields(row: SecurityActivityRow): string[] {
  if (row.operation === 'INSERT') return row.new_data ? Object.keys(row.new_data) : []
  if (row.operation === 'DELETE') return []
  if (!row.old_data || !row.new_data) return []
  const keys = new Set([...Object.keys(row.old_data), ...Object.keys(row.new_data)])
  const changed: string[] = []
  keys.forEach(k => {
    if (JSON.stringify(row.old_data?.[k]) !== JSON.stringify(row.new_data?.[k])) changed.push(k)
  })
  return changed
}

function SecurityActivityLogPanel({ canView }: { canView: boolean }) {
  const [rows, setRows] = useState<SecurityActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState<number | null>(7)
  const [typeFilter, setTypeFilter] = useState('all')
  const [opFilter, setOpFilter] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!canView) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      let query = supabase
        .from('tenant_activity_log')
        .select('id, actor_name, actor_role, table_name, operation, old_data, new_data, created_at')
        .in('table_name', SECURITY_TABLES)
        .order('created_at', { ascending: false })
        .limit(300)
      if (days != null) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        query = query.gte('created_at', since)
      }
      const { data, error: qErr } = await query
      if (cancelled) return
      setLoading(false)
      if (qErr) { setError(qErr.message); return }
      setRows((data as SecurityActivityRow[]) || [])
    }
    void load()
    return () => { cancelled = true }
  }, [canView, days])

  if (!canView) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Access &amp; Security Activity</p>
        <p className="text-xs text-slate-500">Only a workspace owner or admin can view the security activity log.</p>
      </div>
    )
  }

  const q = search.trim().toLowerCase()
  const visible = rows.filter(r =>
    (typeFilter === 'all' || r.table_name === typeFilter) &&
    (opFilter === 'all' || r.operation === opFilter) &&
    (q === '' || (r.actor_name || '').toLowerCase().includes(q) || (SECURITY_TABLE_LABELS[r.table_name] || '').toLowerCase().includes(q))
  )
  const rangeLabel = SEC_RANGE_OPTIONS.find(r => r.days === days)?.label ?? 'window'

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Access &amp; Security Activity</p>
          <p className="text-xs text-slate-500 mt-1">
            Every change to roles, MFA, API keys, session policy, IP allowlist, and data-access grants — tenant-wide, most recent first.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
          {SEC_RANGE_OPTIONS.map(r => (
            <button key={r.label} onClick={() => setDays(r.days)}
              className={`text-xs px-3 py-1 rounded-md transition-colors ${days === r.days ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 py-3 border-b border-slate-700/60 flex items-center gap-2 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search actor or event…"
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500 w-52" />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500">
          <option value="all">All event types</option>
          {SECURITY_TABLES.map(t => <option key={t} value={t}>{SECURITY_TABLE_LABELS[t]}</option>)}
        </select>
        <select value={opFilter} onChange={e => setOpFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500">
          <option value="all">All actions</option>
          <option value="INSERT">Added</option>
          <option value="UPDATE">Changed</option>
          <option value="DELETE">Removed</option>
        </select>
        <div className="flex-1" />
        <span className="text-[11px] text-slate-600">{visible.length} event{visible.length === 1 ? '' : 's'} · last {rangeLabel}</span>
      </div>

      <div className="px-5 py-4">
        {loading && <LiveLoadingSkeleton rows={3} />}
        {!loading && error && <p className="text-xs text-red-400 py-2">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <LiveEmptyState icon="◇" title="No changes in this window" body={`No security or access changes in the last ${rangeLabel}. Widen the time window to see older activity.`} />
        )}
        {!loading && !error && visible.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">When</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Who</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Event</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Action</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {visible.map(row => {
                  const fields = securityChangedFields(row)
                  return (
                    <tr key={row.id} className="hover:bg-slate-700/20 transition-colors">
                      <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                        <span className="text-white font-medium">{row.actor_name || 'Team member'}</span>
                        {row.actor_role && <span className="text-slate-600 ml-1.5 capitalize">({row.actor_role.replace('tenant_', '')})</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-300">{SECURITY_TABLE_LABELS[row.table_name] || row.table_name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${secOperationBadge[row.operation] || 'bg-slate-600 text-slate-300'}`}>
                          {secOperationVerb[row.operation] || row.operation}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-500 max-w-xs truncate">
                        {fields.length > 0 ? fields.join(', ') : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Security & Access"
          subtitle="Platform RBAC, human users, SSO, API keys, session policy, and network controls"
        />
        <button onClick={() => handleSetPage('gov_trust')}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors">
          Trust &amp; Architecture →
        </button>
      </div>

      <div className="space-y-6">
        {/* ── Manage sub-accounts (migration 050) — real tenant hierarchy, live mode only ── */}
        {isLiveTenant && authedUser?.tenantId && ['tenant_owner', 'tenant_admin'].includes(authedUser.role) && (
          <ManageSubAccountsPanel tenantId={authedUser.tenantId} />
        )}

        {/* ── RBAC permission matrix ── */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Roles & Permissions</p>
            <p className="text-xs text-slate-500 mt-1">
              What each built-in role can do — enforced by real access-control policy, not independently configurable per tenant.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className={th}>Permission area</th>
                  {ALL_ROLES.map(r => (
                    <th key={r} className={`${th} text-center whitespace-nowrap`}>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${ROLE_COLORS[r]}`}>{ROLE_LABELS[r]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {PERMISSION_AREAS.map(area => (
                  <tr key={area} className="hover:bg-slate-700/20 transition-colors">
                    <td className={`${td} text-slate-200 text-xs`}>{area}</td>
                    {ALL_ROLES.map(r => {
                      const grants = ROLE_PERMISSIONS[r]
                      const has = grants.includes('All permissions') || grants.includes(area)
                      return (
                        <td key={r} className={`${td} text-center`}>
                          {has
                            ? <span className="text-emerald-400 text-sm">✓</span>
                            : <span className="text-slate-600 text-sm">—</span>}
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
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Human Users</p>
            <span className="text-xs text-slate-500">
              {membersLoading ? 'Loading…' : `${members.length} member${members.length === 1 ? '' : 's'} · full management in Users`}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className={th}>Member</th>
                <th className={th}>Email</th>
                <th className={th}>Role</th>
                <th className={th}>MFA</th>
                <th className={th}>Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {!membersLoading && members.length === 0 && (
                <tr><td colSpan={5} className={`${td} text-slate-500 text-xs text-center py-6`}>No team members yet.</td></tr>
              )}
              {members.map(u => (
                <tr key={u.userId} className="hover:bg-slate-700/20 transition-colors">
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

        {/* ── Access & security activity timeline (tenant-wide, date-windowed) ── */}
        <SecurityActivityLogPanel canView={!!canManageSecurity} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── SSO / SAML — honest deferred state ── */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">SSO / SAML</p>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">Not available yet</span>
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
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Session Policy</p>
              {policySaved && <span className="text-[10px] text-emerald-300">Saved ✓</span>}
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2.5">
                <span className="text-xs text-slate-300">Session timeout (inactivity)</span>
                <select
                  value={timeoutMinutes}
                  disabled={!canManageSecurity}
                  onChange={e => savePolicy({ timeoutMinutes: Number(e.target.value) })}
                  className="bg-slate-800 border border-slate-600 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none disabled:opacity-50"
                >
                  <option value={60}>1h</option>
                  <option value={240}>4h</option>
                  <option value={480}>8h</option>
                  <option value={1440}>24h</option>
                </select>
              </div>
              <div className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2.5">
                <div>
                  <p className="text-xs text-slate-300">MFA required</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">Blocks the app until a human user enrolls a second factor</p>
                </div>
                <Toggle enabled={mfaRequired} onChange={v => canManageSecurity && savePolicy({ mfaRequired: v })} />
              </div>
              <div className="bg-slate-900 rounded-lg px-3 py-2.5">
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
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">API Keys</p>
            <p className="text-xs text-slate-500">Only a workspace owner or admin can view and manage API keys.</p>
          </div>
        )}

        {/* ── IP allowlist ── */}
        {canManageSecurity && currentTenant?.id ? (
          <IpAllowlistPanel tenantId={currentTenant.id} />
        ) : (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">IP Allowlist</p>
            <p className="text-xs text-slate-500">Only a workspace owner or admin can view and manage the IP allowlist.</p>
          </div>
        )}
      </div>
    </div>
  )
}
