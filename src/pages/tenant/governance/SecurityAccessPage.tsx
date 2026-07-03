import React, { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import type { CompanyId } from '../../../data/companies'
import { PageHeader, th, td } from '../../../components/ui'

// ═══════════════════════════════════════════════════════════════
// GOVERNANCE — Security & Access (gov_security)
// Migrated from the legacy SecurityPage: RBAC matrix, human users,
// SSO/SAML config, API keys, session policy, and IP allowlist
// (now properly read on mount + persisted on change).
// ═══════════════════════════════════════════════════════════════

const ROLES = [
  { id: 'tenant_owner', label: 'Owner', color: 'bg-red-500/15 text-red-300' },
  { id: 'tenant_admin', label: 'Admin', color: 'bg-amber-500/15 text-amber-300' },
  { id: 'tenant_manager', label: 'Manager', color: 'bg-blue-500/15 text-blue-300' },
  { id: 'tenant_user', label: 'User', color: 'bg-slate-700 text-slate-300' },
]

// Permission matrix — harvested from the legacy SecurityPage RBAC view
const PERMISSIONS: { label: string; grants: Record<string, boolean> }[] = [
  { label: 'View dashboards & analytics', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: true, tenant_user: true } },
  { label: 'Approve DE actions (human tasks)', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: true, tenant_user: false } },
  { label: 'Configure Digital Employees', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: false, tenant_user: false } },
  { label: 'Edit guardrails & compliance', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: false, tenant_user: false } },
  { label: 'Manage connectors & systems', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: false, tenant_user: false } },
  { label: 'Manage knowledge library', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: true, tenant_user: false } },
  { label: 'Export audit trail', grants: { tenant_owner: true, tenant_admin: false, tenant_manager: false, tenant_user: false } },
  { label: 'Manage users & API keys', grants: { tenant_owner: true, tenant_admin: true, tenant_manager: false, tenant_user: false } },
  { label: 'Billing & plan management', grants: { tenant_owner: true, tenant_admin: false, tenant_manager: false, tenant_user: false } },
]

interface HumanUser { name: string; email: string; role: string; lastActive: string; mfa: boolean }

const HUMAN_USERS: Record<CompanyId, HumanUser[]> = {
  tcp: [
    { name: 'Priya Sharma', email: 'priya.sharma@tcpsoftware.com', role: 'tenant_owner', lastActive: '2 min ago', mfa: true },
    { name: 'K. Douglas', email: 'k.douglas@tcpsoftware.com', role: 'tenant_admin', lastActive: '35 min ago', mfa: true },
    { name: 'Taylor Smith', email: 'taylor.smith@tcpsoftware.com', role: 'tenant_manager', lastActive: '1 hr ago', mfa: true },
    { name: 'Maya Osei', email: 'm.osei@tcpsoftware.com', role: 'tenant_manager', lastActive: '25 min ago', mfa: true },
    { name: 'Jai Patel', email: 'j.patel@tcpsoftware.com', role: 'tenant_manager', lastActive: '3 hr ago', mfa: true },
    { name: 'Jordan Lee', email: 'jordan.lee@tcpsoftware.com', role: 'tenant_user', lastActive: '1 day ago', mfa: false },
    { name: 'Dana Whitfield', email: 'dana.whitfield@tcpsoftware.com', role: 'tenant_user', lastActive: '3 days ago', mfa: true },
  ],
  pwc: [
    { name: 'James Whitfield', email: 'j.whitfield@pwc.com', role: 'tenant_owner', lastActive: '10 min ago', mfa: true },
    { name: 'Aisha Osei', email: 'a.osei@pwc.com', role: 'tenant_admin', lastActive: '1 hr ago', mfa: true },
    { name: 'Rina Tanaka', email: 'r.tanaka@pwc.com', role: 'tenant_manager', lastActive: '4 hr ago', mfa: true },
    { name: 'Liam Brennan', email: 'l.brennan@pwc.com', role: 'tenant_user', lastActive: '2 days ago', mfa: true },
  ],
}

interface ApiKeyRow { name: string; masked: string; scope: string; created: string; lastUsed: string }

const API_KEYS: Record<CompanyId, ApiKeyRow[]> = {
  tcp: [
    { name: 'Zendesk sync', masked: 'dt_live_••••••••3f8a', scope: 'read:conversations, write:conversations', created: '2026-02-12', lastUsed: '4 min ago' },
    { name: 'Analytics export', masked: 'dt_live_••••••••91c2', scope: 'read:analytics', created: '2026-04-03', lastUsed: '2 hrs ago' },
    { name: 'CI deploy hook', masked: 'dt_live_••••••••d05e', scope: 'read:agents', created: '2026-05-20', lastUsed: '1 day ago' },
  ],
  pwc: [
    { name: 'SharePoint bridge', masked: 'dt_live_••••••••7ab1', scope: 'read:knowledge, write:knowledge', created: '2026-01-30', lastUsed: '20 min ago' },
    { name: 'Risk reporting feed', masked: 'dt_live_••••••••2e44', scope: 'read:analytics', created: '2026-03-18', lastUsed: '6 hrs ago' },
  ],
}

interface IpEntry { id: string; ip: string; label: string }
interface IpAllowlistState { enabled: boolean; list: IpEntry[] }

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-700'}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )
}

export default function SecurityAccessPage() {
  const { activeCompanyId } = useAuth()
  const companyId = activeCompanyId
  const users = HUMAN_USERS[companyId]
  const apiKeys = API_KEYS[companyId]

  // ── Session policy (persisted) ──
  const policyKey = `dt_gov_session_policy_${companyId}`
  const savedPolicy: { timeout?: string; mfaRequired?: boolean } = (() => {
    try { const s = localStorage.getItem(policyKey); return s ? JSON.parse(s) : {} } catch { return {} }
  })()
  const [timeout_, setTimeout_] = useState(savedPolicy.timeout ?? (companyId === 'pwc' ? '4h' : '8h'))
  const [mfaRequired, setMfaRequired] = useState<boolean>(savedPolicy.mfaRequired ?? true)
  const savePolicy = (patch: { timeout?: string; mfaRequired?: boolean }) => {
    const next = { timeout: timeout_, mfaRequired, ...patch }
    try { localStorage.setItem(policyKey, JSON.stringify(next)) } catch { /* noop */ }
  }

  // ── IP allowlist — read on mount, persist on change ──
  const ipKey = `dt_gov_ip_allowlist_${companyId}`
  const [ipState, setIpState] = useState<IpAllowlistState>(() => {
    try {
      const s = localStorage.getItem(ipKey)
      if (s) return JSON.parse(s)
    } catch { /* noop */ }
    return { enabled: false, list: [] }
  })
  const saveIp = (next: IpAllowlistState) => {
    setIpState(next)
    try { localStorage.setItem(ipKey, JSON.stringify(next)) } catch { /* noop */ }
  }

  const roleMeta = (id: string) => ROLES.find(r => r.id === id) ?? ROLES[3]

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Security & Access"
        subtitle="Platform RBAC, human users, SSO, API keys, session policy, and network controls"
      />

      <div className="space-y-6">
        {/* ── RBAC permission matrix ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">RBAC — Roles & Permissions</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className={th}>Permission</th>
                {ROLES.map(r => (
                  <th key={r.id} className={`${th} text-center`}>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${r.color}`}>{r.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {PERMISSIONS.map(p => (
                <tr key={p.label} className="hover:bg-slate-800/20 transition-colors">
                  <td className={`${td} text-slate-200 text-xs`}>{p.label}</td>
                  {ROLES.map(r => (
                    <td key={r.id} className={`${td} text-center`}>
                      {p.grants[r.id]
                        ? <span className="text-emerald-400 text-sm">✓</span>
                        : <span className="text-slate-700 text-sm">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Human users ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Human Users</p>
            <span className="text-xs text-slate-500">{users.length} members · full management in Users</span>
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
              {users.map(u => (
                <tr key={u.email} className="hover:bg-slate-800/20 transition-colors">
                  <td className={td}>
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold">
                        {u.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </span>
                      <span className="text-slate-200 text-xs font-medium">{u.name}</span>
                    </div>
                  </td>
                  <td className={`${td} text-slate-400 text-xs`}>{u.email}</td>
                  <td className={td}>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${roleMeta(u.role).color}`}>{roleMeta(u.role).label}</span>
                  </td>
                  <td className={td}>
                    {u.mfa
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">Enabled</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Missing</span>}
                  </td>
                  <td className={`${td} text-slate-500 text-xs`}>{u.lastActive}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── SSO / SAML card ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">SSO / SAML</p>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${companyId === 'pwc' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {companyId === 'pwc' ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <div className="space-y-2 text-xs">
              {[
                ['Protocol', companyId === 'pwc' ? 'SAML 2.0' : '—'],
                ['Identity provider', companyId === 'pwc' ? 'Azure AD (pwc.com)' : '—'],
                ['SP entity ID', `https://app.dreamteam.ai/saml/metadata/${companyId}`],
                ['ACS URL', `https://app.dreamteam.ai/saml/acs/${companyId}`],
                ['JIT provisioning', companyId === 'pwc' ? 'Enabled — default role: User' : 'Disabled'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 bg-slate-950 rounded-lg px-3 py-2">
                  <span className="text-slate-500 flex-shrink-0">{k}</span>
                  <span className="text-slate-300 text-right break-all">{v}</span>
                </div>
              ))}
            </div>
            <button className="mt-4 text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors">
              {companyId === 'pwc' ? 'Edit configuration' : 'Configure SSO'}
            </button>
          </div>

          {/* ── Session policy card ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-4">Session Policy</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                <span className="text-xs text-slate-300">Session timeout</span>
                <select value={timeout_} onChange={e => { setTimeout_(e.target.value); savePolicy({ timeout: e.target.value }) }}
                  className="bg-slate-900 border border-slate-700 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none">
                  {['1h', '4h', '8h', '24h'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                <div>
                  <p className="text-xs text-slate-300">MFA required</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">All human users must enroll a second factor</p>
                </div>
                <Toggle enabled={mfaRequired} onChange={v => { setMfaRequired(v); savePolicy({ mfaRequired: v }) }} />
              </div>
              <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
                <span className="text-xs text-slate-300">Re-auth for sensitive areas</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">Always on</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── API keys ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">API Keys</p>
            <button className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">+ Create key</button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className={th}>Name</th>
                <th className={th}>Key</th>
                <th className={th}>Scope</th>
                <th className={th}>Created</th>
                <th className={th}>Last used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {apiKeys.map(k => (
                <tr key={k.name} className="hover:bg-slate-800/20 transition-colors">
                  <td className={`${td} text-slate-200 text-xs font-medium`}>{k.name}</td>
                  <td className={`${td} text-slate-400 text-xs font-mono`}>{k.masked}</td>
                  <td className={`${td} text-slate-400 text-xs`}>{k.scope}</td>
                  <td className={`${td} text-slate-500 text-xs`}>{k.created}</td>
                  <td className={`${td} text-slate-500 text-xs`}>{k.lastUsed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── IP allowlist ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">IP Allowlist</p>
              <p className="text-xs text-slate-500 mt-1">Restrict console access to approved network ranges</p>
            </div>
            <Toggle enabled={ipState.enabled} onChange={v => saveIp({ ...ipState, enabled: v })} />
          </div>
          {!ipState.enabled && <p className="text-xs text-slate-500">All IPs allowed while disabled.</p>}
          {ipState.enabled && (
            <div className="space-y-2">
              {ipState.list.length === 0 && (
                <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                  No IPs added — all access will be blocked. Add at least one range before enforcing.
                </div>
              )}
              {ipState.list.map(entry => (
                <div key={entry.id} className="flex gap-2 items-center">
                  <input
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
                    placeholder="192.168.1.0/24" value={entry.ip}
                    onChange={e => saveIp({ ...ipState, list: ipState.list.map(x => x.id === entry.id ? { ...x, ip: e.target.value } : x) })} />
                  <input
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
                    placeholder="Label (e.g. Office WiFi)" value={entry.label}
                    onChange={e => saveIp({ ...ipState, list: ipState.list.map(x => x.id === entry.id ? { ...x, label: e.target.value } : x) })} />
                  <button className="text-slate-500 hover:text-red-400 text-xs px-2 transition-colors"
                    onClick={() => saveIp({ ...ipState, list: ipState.list.filter(x => x.id !== entry.id) })}>✕</button>
                </div>
              ))}
              <button className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                onClick={() => saveIp({ ...ipState, list: [...ipState.list, { id: `ip_${Date.now()}`, ip: '', label: '' }] })}>
                + Add IP range
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
