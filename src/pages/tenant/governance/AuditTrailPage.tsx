import React, { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import type { CompanyId } from '../../../data/companies'
import type { Page } from '../../../types'
import { PageHeader } from '../../../components/ui'
import { useDataMode } from '../../../lib/dataMode'
import { CustomerApiError } from '../../../lib/customerApi'
import { listAuditEvents, verifyAuditChain } from '../../../lib/guardrailApi'
import type { AuditEvent as LiveAuditEvent, AuditCategory, ChainVerification } from '../../../lib/guardrailApi'
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates'
import { supabase } from '../../../supabase'
import Modal from '../../../components/Modal'

// ═══════════════════════════════════════════════════════════════
// GOVERNANCE — Audit Trail (gov_audit)
// Immutable, hash-chained event log of every DE action, human
// approval, config change, and guardrail block.
// Seed events are consistent with the per-DE audit logs in
// WorkforceDEsPage (Alex tickets, Casey invoices, Riley onboarding,
// Morgan KYC, Avery memos).
// ═══════════════════════════════════════════════════════════════

type ActionType = 'resolved' | 'escalated' | 'config_change' | 'approval' | 'guardrail_violation'

interface AuditEvent {
  id: string
  timestamp: string // 'YYYY-MM-DD HH:MM'
  actor: string
  actorType: 'de' | 'human' | 'system'
  actionType: ActionType
  action: string
  entity: string
  outcome: string
}

const TCP_EVENTS: AuditEvent[] = [
  { id: 't1', timestamp: '2026-07-03 14:22', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Alex resolved — "How do I reset 2FA?"', entity: 'Customer', outcome: 'Resolved' },
  { id: 't2', timestamp: '2026-07-03 14:16', actor: 'Alex', actorType: 'de', actionType: 'escalated', action: 'Alex escalated — API auth bug to L2', entity: 'Customer', outcome: 'Escalated to L2' },
  { id: 't3', timestamp: '2026-07-03 14:10', actor: 'Casey', actorType: 'de', actionType: 'escalated', action: 'Generated invoice — Meridian Group $15,600', entity: 'Customer', outcome: 'Pending approval' },
  { id: 't4', timestamp: '2026-07-03 14:02', actor: 'Casey', actorType: 'de', actionType: 'resolved', action: 'Casey sent renewal invoice — Harbor Tech $67K', entity: 'Customer', outcome: 'Sent' },
  { id: 't5', timestamp: '2026-07-03 13:00', actor: 'Riley', actorType: 'de', actionType: 'resolved', action: 'Riley processed onboarding — new hire Jordan K.', entity: 'Workforce', outcome: 'Complete' },
  { id: 't6', timestamp: '2026-07-03 12:15', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Submitted KB article — "Rate limiting guide"', entity: 'Knowledge', outcome: 'Pending review' },
  { id: 't7', timestamp: '2026-07-03 11:30', actor: 'Casey', actorType: 'de', actionType: 'resolved', action: 'Sent renewal email cadence — 3 accounts', entity: 'Customer', outcome: 'Sent' },
  { id: 't8', timestamp: '2026-07-03 11:47', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Alex resolved ticket #4815 — billing question', entity: 'Customer', outcome: 'Resolved' },
  { id: 't9', timestamp: '2026-07-03 10:40', actor: 'HR Manager', actorType: 'human', actionType: 'approval', action: 'Approved equipment provisioning for Jordan K.', entity: 'Workforce', outcome: 'Approved' },
  { id: 't10', timestamp: '2026-07-03 09:45', actor: 'Alex', actorType: 'de', actionType: 'guardrail_violation', action: 'BLOCKED: Alex attempted SLA commitment outside standard tier — guardrail DE-R2', entity: 'Customer', outcome: 'Blocked' },
  { id: 't11', timestamp: '2026-07-03 09:12', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4811 — password reset loop', entity: 'Customer', outcome: 'Resolved' },
  { id: 't12', timestamp: '2026-07-02 16:30', actor: 'K. Douglas (Security)', actorType: 'human', actionType: 'config_change', action: 'Guardrails updated v2.2→v2.3 — added SLA-tier restriction (Alex)', entity: 'Governance', outcome: 'Config change' },
  { id: 't13', timestamp: '2026-07-02 15:10', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved 8 tickets — batch shift', entity: 'Customer', outcome: 'Resolved' },
  { id: 't14', timestamp: '2026-07-02 15:00', actor: 'Casey', actorType: 'de', actionType: 'escalated', action: 'Flagged at-risk — Apex Systems', entity: 'Customer', outcome: 'Escalated to AE' },
  { id: 't15', timestamp: '2026-07-02 14:00', actor: 'Riley', actorType: 'de', actionType: 'resolved', action: 'Leave request approved — P. Sharma', entity: 'Workforce', outcome: 'Approved' },
  { id: 't16', timestamp: '2026-07-02 11:20', actor: 'Renewal Manager', actorType: 'human', actionType: 'approval', action: 'Approved renewal terms — Northwind Labs (24 months)', entity: 'Customer', outcome: 'Approved' },
  { id: 't17', timestamp: '2026-07-02 10:05', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4802 — webhook configuration', entity: 'Customer', outcome: 'Resolved' },
  { id: 't18', timestamp: '2026-07-02 09:00', actor: 'Alex', actorType: 'de', actionType: 'escalated', action: 'KB gap flagged — "Webhook retry logic"', entity: 'Knowledge', outcome: 'Gap logged' },
  { id: 't19', timestamp: '2026-07-01 16:45', actor: 'System', actorType: 'system', actionType: 'config_change', action: 'Quarterly access review cycle opened — 3 systems', entity: 'Governance', outcome: 'Scheduled' },
  { id: 't20', timestamp: '2026-07-01 14:30', actor: 'Riley', actorType: 'de', actionType: 'escalated', action: 'Compensation query routed to HRBP — restriction DE-R1', entity: 'Workforce', outcome: 'Escalated to HRBP' },
  { id: 't21', timestamp: '2026-07-01 11:00', actor: 'Riley', actorType: 'de', actionType: 'escalated', action: 'Recertification overdue — flagged', entity: 'Workforce', outcome: 'Needs recertification' },
  { id: 't22', timestamp: '2026-07-01 09:00', actor: 'Casey', actorType: 'de', actionType: 'resolved', action: 'Renewal close — Harbor Tech $67,000', entity: 'Customer', outcome: 'Closed Won' },
  { id: 't23', timestamp: '2026-06-30 15:40', actor: 'Finance Manager', actorType: 'human', actionType: 'approval', action: 'Approved 15% renewal discount — Harbor Tech', entity: 'Customer', outcome: 'Approved' },
  { id: 't24', timestamp: '2026-06-30 13:10', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4790 — SSO login failure', entity: 'Customer', outcome: 'Resolved' },
  { id: 't25', timestamp: '2026-06-30 10:30', actor: 'Admin', actorType: 'human', actionType: 'config_change', action: 'Customer override edited — "Never quote competitor pricing" scope confirmed as All DEs', entity: 'Governance', outcome: 'Config change' },
  { id: 't26', timestamp: '2026-06-29 16:20', actor: 'Riley', actorType: 'de', actionType: 'resolved', action: 'Offboarding checklist completed — contractor T. Nguyen', entity: 'Workforce', outcome: 'Complete' },
  { id: 't27', timestamp: '2026-06-29 11:15', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4784 — API rate limit increase request', entity: 'Customer', outcome: 'Resolved' },
]

const PWC_EVENTS: AuditEvent[] = [
  { id: 'p1', timestamp: '2026-07-03 14:05', actor: 'Avery', actorType: 'de', actionType: 'escalated', action: 'Completed Q2 corporate tax memo — Crestline Corp', entity: 'Specialist', outcome: 'Sent to partner review' },
  { id: 'p2', timestamp: '2026-07-03 14:00', actor: 'Morgan', actorType: 'de', actionType: 'escalated', action: 'GDPR request — overdue response escalated', entity: 'Customer', outcome: 'Escalated to partner' },
  { id: 'p3', timestamp: '2026-07-03 11:00', actor: 'Morgan', actorType: 'de', actionType: 'resolved', action: 'KYC completed — new engagement #E-2247', entity: 'Customer', outcome: 'Passed' },
  { id: 'p4', timestamp: '2026-07-03 10:15', actor: 'Engagement Partner', actorType: 'human', actionType: 'approval', action: 'Partner sign-off — engagement letter #E-2247', entity: 'Customer', outcome: 'Approved' },
  { id: 'p5', timestamp: '2026-07-03 09:00', actor: 'Avery', actorType: 'de', actionType: 'escalated', action: 'Research — FATCA dual-national issue', entity: 'Knowledge', outcome: 'KB gap logged' },
  { id: 'p6', timestamp: '2026-07-02 16:00', actor: 'Morgan', actorType: 'de', actionType: 'resolved', action: 'Sent engagement update — Harbor Financial', entity: 'Customer', outcome: 'Sent' },
  { id: 'p7', timestamp: '2026-07-02 14:30', actor: 'Managing Partner', actorType: 'human', actionType: 'approval', action: 'Approved fee adjustment — Sterling Trust ($4,200)', entity: 'Customer', outcome: 'Approved' },
  { id: 'p8', timestamp: '2026-07-02 15:00', actor: 'Avery', actorType: 'de', actionType: 'resolved', action: 'Memo completed — R&D credit analysis', entity: 'Specialist', outcome: 'Delivered' },
  { id: 'p9', timestamp: '2026-07-02 11:45', actor: 'Morgan', actorType: 'de', actionType: 'resolved', action: 'Quarterly client review scheduled — 6 engagements', entity: 'Customer', outcome: 'Scheduled' },
  { id: 'p10', timestamp: '2026-07-02 09:30', actor: 'Quality & Risk', actorType: 'human', actionType: 'config_change', action: 'Independence attestation reminder issued — Harbor Financial expansion', entity: 'Governance', outcome: 'Pending' },
  { id: 'p11', timestamp: '2026-07-01 16:10', actor: 'Avery', actorType: 'de', actionType: 'resolved', action: 'Reviewed IRS Notice 2026-14', entity: 'Specialist', outcome: 'Summary filed' },
  { id: 'p12', timestamp: '2026-07-01 13:00', actor: 'Partner (Tax)', actorType: 'human', actionType: 'approval', action: 'Partner review passed — state nexus memo', entity: 'Specialist', outcome: 'Approved' },
  { id: 'p13', timestamp: '2026-07-01 10:20', actor: 'Morgan', actorType: 'de', actionType: 'resolved', action: 'AML screening completed — 2 new client entities', entity: 'Customer', outcome: 'Passed' },
  { id: 'p14', timestamp: '2026-06-30 15:00', actor: 'Quality & Risk', actorType: 'human', actionType: 'config_change', action: 'Guardrails updated v2.3→v2.4 — PCAOB independence conflict rule (Avery)', entity: 'Governance', outcome: 'Config change' },
  { id: 'p15', timestamp: '2026-06-30 11:30', actor: 'Morgan', actorType: 'de', actionType: 'escalated', action: 'Client complaint routed — SLA breach concern, Sterling Trust', entity: 'Customer', outcome: 'Escalated to partner' },
  { id: 'p16', timestamp: '2026-06-29 14:00', actor: 'Avery', actorType: 'de', actionType: 'resolved', action: 'Memo completed — transfer pricing documentation review', entity: 'Specialist', outcome: 'Delivered' },
  { id: 'p17', timestamp: '2026-06-29 09:45', actor: 'Morgan', actorType: 'de', actionType: 'resolved', action: 'Engagement intake completed — Beacon Capital advisory', entity: 'Customer', outcome: 'Complete' },
]

const ACTION_TYPE_META: Record<ActionType, { label: string; style: string }> = {
  resolved: { label: 'Resolved', style: 'bg-emerald-500/15 text-emerald-300' },
  escalated: { label: 'Escalated', style: 'bg-amber-500/15 text-amber-300' },
  config_change: { label: 'Config change', style: 'bg-indigo-500/15 text-indigo-300' },
  approval: { label: 'Approval', style: 'bg-blue-500/15 text-blue-300' },
  guardrail_violation: { label: 'Guardrail block', style: 'bg-red-500/15 text-red-300' },
}

const DE_NAMES: Record<CompanyId, string[]> = {
  tcp: ['Alex', 'Casey', 'Riley'],
  pwc: ['Morgan', 'Avery'],
}

const RETENTION: Record<CompanyId, string> = { tcp: '2 years', pwc: '7 years' }

function actorAvatar(e: AuditEvent) {
  if (e.actorType === 'de') {
    return (
      <span className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold flex-shrink-0">
        {e.actor.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  if (e.actorType === 'human') {
    return (
      <span className="w-6 h-6 rounded-full bg-slate-600 text-slate-300 flex items-center justify-center text-[10px] flex-shrink-0">◉</span>
    )
  }
  return (
    <span className="w-6 h-6 rounded-full bg-slate-700 text-slate-500 flex items-center justify-center text-[10px] flex-shrink-0">⊟</span>
  )
}

const exportCsv = (events: AuditEvent[]) => {
  const headers = ['Timestamp', 'Actor', 'Actor Type', 'Action Type', 'Action', 'Entity', 'Outcome']
  const rows = events.map(e => [e.timestamp, e.actor, e.actorType, e.actionType, `"${e.action.replace(/"/g, '""')}"`, e.entity, e.outcome])
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ═══════════════════════════════════════════════════════════════
// LIVE mode — real audit_events: INSERT-only, hash-chained rows
// written through the append_audit_event() RPC. "Verify chain"
// asks the database to recompute every hash server-side.
// ═══════════════════════════════════════════════════════════════

const LIVE_CATEGORY_META: Record<AuditCategory, { label: string; style: string }> = {
  resolved: { label: 'Resolved', style: 'bg-emerald-500/15 text-emerald-300' },
  escalated: { label: 'Escalated', style: 'bg-amber-500/15 text-amber-300' },
  approval: { label: 'Approval', style: 'bg-blue-500/15 text-blue-300' },
  guardrail_check: { label: 'Guardrail check', style: 'bg-indigo-500/15 text-indigo-300' },
  guardrail_block: { label: 'Guardrail block', style: 'bg-red-500/15 text-red-300' },
  config_change: { label: 'Config change', style: 'bg-indigo-500/15 text-indigo-300' },
  playbook_step: { label: 'Playbook step', style: 'bg-violet-500/15 text-violet-300' },
  invoice: { label: 'Invoice', style: 'bg-teal-500/15 text-teal-300' },
  connector_sync: { label: 'Connector sync', style: 'bg-cyan-500/15 text-cyan-300' },
  connector_action: { label: 'Connector action', style: 'bg-cyan-500/15 text-cyan-300' },
  evidence_step: { label: 'Evidence step', style: 'bg-teal-500/15 text-teal-300' },
  access_control: { label: 'Data access', style: 'bg-rose-500/15 text-rose-300' },
}

// ─────────────────────────────────────────────────────────────────
// Team activity log — every write made by this tenant's OWN team is
// logged server-side by the trg_tenant_activity_log trigger (migrations
// 066/067). This panel is the tenant owner/admin's window into that
// log: who on their team changed what, in which table, and (at a
// glance) which fields changed. RLS on tenant_activity_log already
// restricts SELECT to tenant_owner/tenant_admin of that tenant, so this
// query is safe as-is -- but we also gate rendering client-side so a
// non-admin sees a clear message instead of a confusingly-empty panel.
// Mirrors the "changed fields" pattern used by the platform-side
// Remote Access write-audit panel (PlatformConsolePage.tsx), replicated
// inline here rather than imported since that's a different layer.
// ─────────────────────────────────────────────────────────────────
interface TenantActivityLogRow {
  id: number
  tenant_id: string
  actor_user_id: string
  actor_name: string | null
  actor_role: string | null
  table_name: string
  operation: string
  row_pk: string | null
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  created_at: string
}

const activityChangedFields = (row: TenantActivityLogRow): string[] => {
  if (row.operation === 'INSERT') return row.new_data ? Object.keys(row.new_data) : []
  if (row.operation === 'DELETE') return []
  if (!row.old_data || !row.new_data) return []
  const keys = new Set([...Object.keys(row.old_data), ...Object.keys(row.new_data)])
  const changed: string[] = []
  keys.forEach((k) => {
    const before = JSON.stringify(row.old_data ? row.old_data[k] : undefined)
    const after = JSON.stringify(row.new_data ? row.new_data[k] : undefined)
    if (before !== after) changed.push(k)
  })
  return changed
}

const activityOperationBadge: Record<string, string> = {
  INSERT: 'bg-emerald-500/15 text-emerald-300',
  UPDATE: 'bg-blue-500/15 text-blue-300',
  DELETE: 'bg-red-500/15 text-red-300',
}

function TeamActivityLogPanel() {
  const { authedUser } = useAuth()
  const isAdmin = !!(authedUser?.tenantId && ['tenant_owner', 'tenant_admin'].includes(authedUser.role))

  const [rows, setRows] = useState<TenantActivityLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [tableFilter, setTableFilter] = useState('all')
  const [detailRow, setDetailRow] = useState<TenantActivityLogRow | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    const { data, error: qError } = await supabase
      .from('tenant_activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setLoading(false)
    setLoaded(true)
    if (qError) {
      setError(qError.message)
      return
    }
    setRows((data as TenantActivityLogRow[]) || [])
  }

  useEffect(() => {
    if (isAdmin && !loaded) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  if (!isAdmin) return null

  const tablesInLog = Array.from(new Set(rows.map((r) => r.table_name))).sort()
  const visibleRows = tableFilter === 'all' ? rows : rows.filter((r) => r.table_name === tableFilter)

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-white">Team activity log</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Every change your own team made across the platform — visible only to owners and admins.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tablesInLog.length > 0 && (
            <select
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">All tables</option>
              {tablesInLog.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => void load()}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        {loading && <p className="text-xs text-slate-500 py-4 text-center">Loading team activity…</p>}
        {!loading && error && <p className="text-xs text-red-400 py-2">{error}</p>}

        {!loading && !error && visibleRows.length === 0 && (
          <p className="text-xs text-slate-500 py-6 text-center">
            No team activity recorded{tableFilter !== 'all' ? ' for this table' : ''} yet.
          </p>
        )}

        {!loading && !error && visibleRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">When</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Who</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Table</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Operation</th>
                  <th className="px-3 py-2 text-xs font-medium text-slate-500">Changed fields</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {visibleRows.map((row) => {
                  const fields = activityChangedFields(row)
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setDetailRow(row)}
                      className="cursor-pointer hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                        <span className="text-white font-medium">{row.actor_name || 'Team member'}</span>
                        {row.actor_role && (
                          <span className="text-slate-600 ml-1.5 capitalize">({row.actor_role.replace('tenant_', '')})</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-300 font-mono">{row.table_name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${activityOperationBadge[row.operation] || 'bg-slate-600 text-slate-300'}`}>
                          {row.operation}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-400 max-w-xs truncate">
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

      {detailRow && (
        <Modal
          title={`${detailRow.table_name} · ${detailRow.operation}`}
          onClose={() => setDetailRow(null)}
        >
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            <div className="text-xs text-slate-400 space-y-1">
              <div><span className="text-slate-500">When:</span> {new Date(detailRow.created_at).toLocaleString()}</div>
              <div>
                <span className="text-slate-500">Who:</span> {detailRow.actor_name || 'Team member'}
                {detailRow.actor_role && <span className="text-slate-600 capitalize"> ({detailRow.actor_role.replace('tenant_', '')})</span>}
              </div>
              <div><span className="text-slate-500">Row:</span> <span className="font-mono">{detailRow.row_pk || '—'}</span></div>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Changed fields</p>
              {activityChangedFields(detailRow).length === 0 ? (
                <p className="text-xs text-slate-500">No field-level changes to show.</p>
              ) : (
                <div className="space-y-2">
                  {activityChangedFields(detailRow).map((field) => (
                    <div key={field} className="bg-slate-700 rounded-xl p-3">
                      <div className="text-xs font-mono text-indigo-300 mb-1">{field}</div>
                      <div className="text-xs text-slate-400 space-y-1">
                        <div>
                          <span className="text-slate-500">before:</span>{' '}
                          <span className="font-mono break-all">
                            {detailRow.old_data ? JSON.stringify(detailRow.old_data[field]) : '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">after:</span>{' '}
                          <span className="font-mono break-all text-white">
                            {detailRow.new_data ? JSON.stringify(detailRow.new_data[field]) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function LiveAuditTrail({ setPage }: { setPage?: (p: Page) => void }) {
  const [events, setEvents] = useState<LiveAuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [missingTables, setMissingTables] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<'all' | AuditCategory>('all')
  const [actorFilter, setActorFilter] = useState('all')
  const [verifying, setVerifying] = useState(false)
  const [verification, setVerification] = useState<ChainVerification | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      setEvents(await listAuditEvents(200))
      setMissingTables(false)
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true)
      else setError((err as Error)?.message || 'Failed to load audit events.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener('dt-state-changed', onChange)
    return () => window.removeEventListener('dt-state-changed', onChange)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const verify = async () => {
    setVerifying(true)
    setError(null)
    try { setVerification(await verifyAuditChain()) }
    catch (err) { setError((err as Error)?.message || 'Chain verification failed.') }
    finally { setVerifying(false) }
  }

  const actors = Array.from(new Set(events.map(e => e.actor)))
  const filtered = events.filter(e =>
    (categoryFilter === 'all' || e.category === categoryFilter) &&
    (actorFilter === 'all' || e.actor === actorFilter)
  )
  // Chain position: events arrive newest-first; oldest is #1.
  const positionById = new Map(events.map((e, i) => [e.id, events.length - i]))

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <PageHeader
        title="Audit Trail"
        subtitle="Immutable, hash-chained record of every DE action, guardrail check, human approval, and playbook step — records can only be appended, never edited or deleted"
      />
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      <TeamActivityLogPanel />

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : events.length === 0 ? (
        <LiveEmptyState
          icon="⛓"
          title="No audit events yet"
          body="Every guardrail check, invoice, approval, and playbook step your Digital Employees perform is appended here as a hash-chained, immutable record."
          primaryLabel="Go to Renewal & Expansion"
          onPrimary={() => setPage?.('entity_customer_renewal')}
        />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Events (latest 200)', value: String(events.length), color: 'text-white' },
              { label: 'Guardrail blocks', value: String(events.filter(e => e.category === 'guardrail_block').length), color: events.some(e => e.category === 'guardrail_block') ? 'text-red-300' : 'text-emerald-300' },
              { label: 'Approvals', value: String(events.filter(e => e.category === 'approval').length), color: 'text-blue-300' },
              {
                label: 'Chain integrity',
                value: verification ? (verification.intact ? `Intact (${verification.checked})` : 'BROKEN') : 'Not verified',
                color: verification ? (verification.intact ? 'text-emerald-300' : 'text-red-300') : 'text-slate-400',
              },
            ].map(s => (
              <div key={s.label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as 'all' | AuditCategory)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500">
              <option value="all">All categories</option>
              {(Object.keys(LIVE_CATEGORY_META) as AuditCategory[]).map(c => (
                <option key={c} value={c}>{LIVE_CATEGORY_META[c].label}</option>
              ))}
            </select>
            <select value={actorFilter} onChange={e => setActorFilter(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500">
              <option value="all">All actors</option>
              {actors.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <div className="flex-1" />
            <button onClick={() => void verify()} disabled={verifying}
              className="text-xs px-3 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300 hover:border-emerald-500 disabled:opacity-50 transition-colors">
              {verifying ? 'Verifying…' : '⛓ Verify chain'}
            </button>
          </div>

          {verification && (
            <div className={`mb-4 rounded-xl border px-4 py-3 text-xs ${verification.intact
              ? 'border-emerald-800/50 bg-emerald-500/10 text-emerald-300'
              : 'border-red-800/50 bg-red-500/10 text-red-300'}`}>
              {verification.intact
                ? `Chain intact — all ${verification.checked} events recomputed and verified server-side.`
                : `Chain BROKEN after ${verification.checked} verified events (record ${verification.broken_at ?? 'unknown'}). This should be impossible unless the database was tampered with directly.`}
            </div>
          )}

          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 divide-y divide-slate-700/60">
            {filtered.map(e => (
              <div key={e.id} className="grid grid-cols-12 gap-3 px-5 py-3">
                <div className="col-span-2 text-xs text-slate-500 pt-0.5 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</div>
                <div className="col-span-2 flex items-start gap-2">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${
                    e.actor_type === 'de' ? 'bg-indigo-500/20 text-indigo-300 font-bold'
                    : e.actor_type === 'human' ? 'bg-slate-600 text-slate-300'
                    : 'bg-slate-700 text-slate-500'
                  }`}>{e.actor_type === 'de' ? e.actor.slice(0, 2).toUpperCase() : e.actor_type === 'human' ? '◉' : '⊟'}</span>
                  <div>
                    <p className="text-xs text-slate-200">{e.actor}</p>
                    <p className="text-[10px] text-slate-600 capitalize">{e.actor_type === 'de' ? 'Digital Employee' : e.actor_type}</p>
                  </div>
                </div>
                <div className="col-span-6">
                  <p className={`text-xs leading-snug ${e.category === 'guardrail_block' ? 'text-red-300' : 'text-slate-300'}`}>{e.action}</p>
                  <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${LIVE_CATEGORY_META[e.category]?.style ?? 'bg-slate-700 text-slate-400'}`}>
                    {LIVE_CATEGORY_META[e.category]?.label ?? e.category}
                  </span>
                </div>
                <div className="col-span-2 text-right pt-0.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 whitespace-nowrap font-mono"
                    title={`Chain position #${positionById.get(e.id)} — hash ${e.hash}\nprev ${e.prev_hash || '(genesis)'}`}
                  >
                    ⛓ #{positionById.get(e.id)} · {e.hash.slice(0, 8)}
                  </span>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-600 text-sm">No events match your filters.</div>
            )}
          </div>

          <p className="mt-4 text-xs text-slate-600 text-center">
            hash = sha256(prev_hash + tenant + action + detail + timestamp), computed inside the database. UPDATE and DELETE raise an exception — even for administrators.
          </p>
        </>
      )}
    </div>
  )
}

export default function AuditTrailPage({ setPage }: { setPage?: (p: Page) => void }) {
  const dataMode = useDataMode()
  if (dataMode === 'live') return <LiveAuditTrail setPage={setPage} />
  return <DemoAuditTrailPage setPage={setPage} />
}

function DemoAuditTrailPage({ setPage }: { setPage?: (p: Page) => void }) {
  const { activeCompanyId } = useAuth()
  const events = activeCompanyId === 'tcp' ? TCP_EVENTS : PWC_EVENTS
  const deNames = DE_NAMES[activeCompanyId]

  const [actorFilter, setActorFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState<'all' | ActionType>('all')
  const [entityFilter, setEntityFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const entities = Array.from(new Set(events.map(e => e.entity)))

  const filtered = events.filter(e => {
    if (actorFilter === 'humans' && e.actorType !== 'human') return false
    if (actorFilter !== 'all' && actorFilter !== 'humans' && e.actor !== actorFilter) return false
    if (typeFilter !== 'all' && e.actionType !== typeFilter) return false
    if (entityFilter !== 'all' && e.entity !== entityFilter) return false
    const day = e.timestamp.slice(0, 10)
    if (dateFrom && day < dateFrom) return false
    if (dateTo && day > dateTo) return false
    return true
  })

  // Stats — "today" is 2026-07-03 in seed data
  const today = '2026-07-03'
  const eventsToday = events.filter(e => e.timestamp.startsWith(today)).length
  const deActions = events.filter(e => e.actorType === 'de').length
  const humanActions = events.filter(e => e.actorType === 'human').length
  const guardrailBlocks = events.filter(e => e.actionType === 'guardrail_violation').length

  const stats = [
    { label: 'Events today', value: String(eventsToday) },
    { label: 'DE vs human actions', value: `${deActions} : ${humanActions}` },
    { label: 'Guardrail blocks (this month)', value: String(guardrailBlocks), color: guardrailBlocks > 0 ? 'text-red-300' : 'text-emerald-300' },
    { label: 'Chain integrity', value: '100%', color: 'text-emerald-300' },
  ]

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          title="Audit Trail"
          subtitle="Immutable, hash-chained log of every DE action, human approval, config change, and guardrail block"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400">
            Retention: <span className="text-white">{RETENTION[activeCompanyId]}</span>
          </span>
          <button onClick={() => exportCsv(filtered)}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors">
            ↓ Export CSV
          </button>
        </div>
      </div>
      <p className="-mt-3 mb-5 text-xs text-slate-500">
        Immutable compliance record with hash-chain verification. For the live operational stream, see the{' '}
        <button onClick={() => setPage && setPage('ops_activity')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
          Activity Log →
        </button>
      </p>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats.map(s => (
          <div key={s.label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className={`text-xl font-bold ${s.color || 'text-white'}`}>{s.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Actor:</span>
          {['all', ...deNames, 'humans'].map(a => (
            <button key={a} onClick={() => setActorFilter(a)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${actorFilter === a ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-600 text-slate-400 hover:text-white'}`}>
              {a === 'all' ? 'All' : a === 'humans' ? 'Humans' : a}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Type:</span>
          {(['all', 'resolved', 'escalated', 'config_change', 'approval', 'guardrail_violation'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${typeFilter === t ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-600 text-slate-400 hover:text-white'}`}>
              {t === 'all' ? 'All' : ACTION_TYPE_META[t].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Entity:</span>
          <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
            className="bg-slate-900 border border-slate-600 text-xs text-slate-200 rounded-lg px-2 py-1.5 focus:outline-none">
            <option value="all">All entities</option>
            {entities.map(e => <option key={e}>{e}</option>)}
          </select>
          <span className="text-xs text-slate-500">From</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="bg-slate-900 border border-slate-600 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
          <span className="text-xs text-slate-500">To</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="bg-slate-900 border border-slate-600 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
          <span className="text-xs text-slate-500 ml-auto">{filtered.length} of {events.length} events</span>
        </div>
      </div>

      {/* Event log */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="grid grid-cols-12 gap-3 px-4 py-3 border-b border-slate-700 text-[11px] font-medium text-slate-500 uppercase tracking-wide">
          <div className="col-span-2">Timestamp</div>
          <div className="col-span-2">Actor</div>
          <div className="col-span-4">Action</div>
          <div className="col-span-1">Entity</div>
          <div className="col-span-2">Outcome</div>
          <div className="col-span-1 text-right">Integrity</div>
        </div>
        <div className="divide-y divide-slate-700/50">
          {filtered.map(e => (
            <div key={e.id} className={`grid grid-cols-12 gap-3 px-4 py-3 items-start transition-colors ${e.actionType === 'guardrail_violation' ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-700/20'}`}>
              <div className="col-span-2 text-xs text-slate-500 font-mono pt-0.5">{e.timestamp}</div>
              <div className="col-span-2 flex items-center gap-2 min-w-0">
                {actorAvatar(e)}
                <div className="min-w-0">
                  <p className="text-xs text-white font-medium truncate">{e.actor}</p>
                  <p className="text-[10px] text-slate-600 capitalize">{e.actorType === 'de' ? 'Digital Employee' : e.actorType}</p>
                </div>
              </div>
              <div className="col-span-4">
                <p className={`text-xs leading-snug ${e.actionType === 'guardrail_violation' ? 'text-red-300' : 'text-slate-300'}`}>{e.action}</p>
                <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${ACTION_TYPE_META[e.actionType]?.style}`}>
                  {ACTION_TYPE_META[e.actionType]?.label ?? e.actionType}
                </span>
              </div>
              <div className="col-span-1 text-xs text-slate-400 pt-0.5">{e.entity}</div>
              <div className="col-span-2 text-xs text-slate-400 pt-0.5">{e.outcome}</div>
              <div className="col-span-1 text-right pt-0.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 whitespace-nowrap" title="Hash-chain verified — this entry is cryptographically linked to the previous one and cannot be altered">
                  ⛓ verified
                </span>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-12 text-center text-slate-600 text-sm">No events match your filters.</div>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-600 text-center">
        Every entry is hash-chained to its predecessor — records cannot be edited or deleted, only appended.
      </p>
    </div>
  )
}
