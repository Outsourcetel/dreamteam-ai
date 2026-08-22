import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import type { Page } from '../../../types'
import { PageHeader } from '../../../components/ui'
import { Button, FilterBar, INPUT_CLS, SELECT_CLS } from '../../../design/primitives'
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
// ═══════════════════════════════════════════════════════════════

// ⚠ The preview trail's scaffolding was DELETED 2026-08-22, all zero-reader:
//
//   ActionType/AuditEvent   the seeded row shape. Live rows are
//        LiveAuditEvent from guardrailApi — different fields entirely
//        (created_at/actor_type/category/hash, not timestamp/actionType).
//   ACTION_TYPE_META        its badge map. LIVE_CATEGORY_META below is the
//        live one and keys on AuditCategory.
//   DE_NAMES, RETENTION     per-CompanyId seed constants ('tcp'/'pwc').
//   actorAvatar             took the seeded shape; zero render sites.
//   exportCsv               a duplicate of exportLiveCsv typed to the seeded
//        shape. The live export is wired to the "↓ Export CSV" button.
//
// Recoverable at 571868e.

// ═══════════════════════════════════════════════════════════════
// LIVE mode — real audit_events: INSERT-only, hash-chained rows
// written through the append_audit_event() RPC. "Verify chain"
// asks the database to recompute every hash server-side.
// ═══════════════════════════════════════════════════════════════

const LIVE_CATEGORY_META: Record<AuditCategory, { label: string; style: string }> = {
  resolved: { label: 'Resolved', style: 'bg-dt-ok-soft text-dt-ok' },
  escalated: { label: 'Escalated', style: 'bg-dt-warn-soft text-dt-warn' },
  approval: { label: 'Approval', style: 'bg-dt-info-soft text-dt-info' },
  guardrail_check: { label: 'Guardrail check', style: 'bg-dt-accent-soft text-dt-accent-text' },
  guardrail_block: { label: 'Guardrail block', style: 'bg-dt-danger-soft text-dt-danger' },
  config_change: { label: 'Config change', style: 'bg-dt-accent-soft text-dt-accent-text' },
  // playbook_step/invoice/connector_sync/connector_action/evidence_step: non-core
  // hues (violet/teal/cyan), kept as a category-identity badge per the mapping
  // table's "non-semantic identity hues keep their hue" rule — none of these is
  // an ok/warn/danger/info/accent status, each is a fixed EVENT-TYPE marker in
  // an 11-member vocabulary. Made opaque (was translucent /15) so the badge
  // reads correctly in both themes; doc §7 kept-hue row added.
  playbook_step: { label: 'Playbook step', style: 'bg-violet-600 text-violet-100' },
  invoice: { label: 'Invoice', style: 'bg-teal-600 text-teal-100' },
  connector_sync: { label: 'Connector sync', style: 'bg-cyan-600 text-cyan-100' },
  connector_action: { label: 'Connector action', style: 'bg-cyan-600 text-cyan-100' },
  evidence_step: { label: 'Evidence step', style: 'bg-teal-600 text-teal-100' },
  access_control: { label: 'Data access', style: 'bg-dt-danger-soft text-dt-danger' },
  // GI-10. Deliberately its own label and colour: an overturn is NOT a block,
  // and counting it as one would hide the single event type a regulator most
  // needs to find — a machine releasing content a control had stopped.
  guardrail_adjudication: { label: 'Guardrail OVERTURNED', style: 'bg-dt-warn-soft text-dt-warn font-semibold' },
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
  INSERT: 'bg-dt-ok-soft text-dt-ok',
  UPDATE: 'bg-dt-info-soft text-dt-info',
  DELETE: 'bg-dt-danger-soft text-dt-danger',
}

function TeamActivityLogPanel({ days }: { days: number | null }) {
  const { authedUser } = useAuth()
  const isAdmin = !!(authedUser?.tenantId && ['tenant_owner', 'tenant_admin'].includes(authedUser.role))

  const [rows, setRows] = useState<TenantActivityLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tableFilter, setTableFilter] = useState('all')
  const [detailRow, setDetailRow] = useState<TenantActivityLogRow | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    let query = supabase
      .from('tenant_activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (days != null) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      query = query.gte('created_at', since)
    }
    const { data, error: qError } = await query
    setLoading(false)
    if (qError) {
      setError(qError.message)
      return
    }
    setRows((data as TenantActivityLogRow[]) || [])
  }

  useEffect(() => {
    if (isAdmin) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, days])

  if (!isAdmin) return null

  const tablesInLog = Array.from(new Set(rows.map((r) => r.table_name))).sort()
  const visibleRows = tableFilter === 'all' ? rows : rows.filter((r) => r.table_name === tableFilter)

  return (
    <div className="bg-dt-card border border-dt-border rounded-xl overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-dt-border flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-dt-title">Team activity log</p>
          <p className="text-xs text-dt-muted mt-0.5">
            Every change your own team made across the platform — visible only to owners and admins.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tablesInLog.length > 0 && (
            <select
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="bg-dt-page border border-dt-border rounded-lg px-2 py-1.5 text-xs text-dt-support focus:outline-none focus:border-dt-accent"
            >
              <option value="all">All tables</option>
              {tablesInLog.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => void load()}
            className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        {loading && <p className="text-xs text-dt-muted py-4 text-center">Loading team activity…</p>}
        {!loading && error && <p className="text-xs text-red-400 py-2">{error}</p>}

        {!loading && !error && visibleRows.length === 0 && (
          <p className="text-xs text-dt-muted py-6 text-center">
            No team activity recorded{tableFilter !== 'all' ? ' for this table' : ''} yet.
          </p>
        )}

        {!loading && !error && visibleRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-dt-border">
                  <th className="px-3 py-2 text-xs font-medium text-dt-muted">When</th>
                  <th className="px-3 py-2 text-xs font-medium text-dt-muted">Who</th>
                  <th className="px-3 py-2 text-xs font-medium text-dt-muted">Table</th>
                  <th className="px-3 py-2 text-xs font-medium text-dt-muted">Operation</th>
                  <th className="px-3 py-2 text-xs font-medium text-dt-muted">Changed fields</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dt-border">
                {visibleRows.map((row) => {
                  const fields = activityChangedFields(row)
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setDetailRow(row)}
                      className="cursor-pointer hover:bg-dt-panel transition-colors"
                    >
                      <td className="px-3 py-2.5 text-xs text-dt-support whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                        <span className="text-dt-body font-medium">{row.actor_name || 'Team member'}</span>
                        {row.actor_role && (
                          <span className="text-dt-faint ml-1.5 capitalize">({row.actor_role.replace('tenant_', '')})</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-dt-support font-mono">{row.table_name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${activityOperationBadge[row.operation] || 'bg-dt-neutral-soft text-dt-neutral'}`}>
                          {row.operation}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-dt-support max-w-xs truncate">
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
            <div className="text-xs text-dt-support space-y-1">
              <div><span className="text-dt-muted">When:</span> {new Date(detailRow.created_at).toLocaleString()}</div>
              <div>
                <span className="text-dt-muted">Who:</span> {detailRow.actor_name || 'Team member'}
                {detailRow.actor_role && <span className="text-dt-faint capitalize"> ({detailRow.actor_role.replace('tenant_', '')})</span>}
              </div>
              <div><span className="text-dt-muted">Row:</span> <span className="font-mono">{detailRow.row_pk || '—'}</span></div>
            </div>
            <div>
              <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Changed fields</p>
              {activityChangedFields(detailRow).length === 0 ? (
                <p className="text-xs text-dt-muted">No field-level changes to show.</p>
              ) : (
                <div className="space-y-2">
                  {activityChangedFields(detailRow).map((field) => (
                    <div key={field} className="bg-dt-panel rounded-xl p-3">
                      <div className="text-xs font-mono text-dt-accent-text mb-1">{field}</div>
                      <div className="text-xs text-dt-support space-y-1">
                        <div>
                          <span className="text-dt-muted">before:</span>{' '}
                          <span className="font-mono break-all">
                            {detailRow.old_data ? JSON.stringify(detailRow.old_data[field]) : '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-dt-muted">after:</span>{' '}
                          <span className="font-mono break-all text-dt-body">
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

const RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: null },
]

function LiveAuditTrail({ setPage }: { setPage?: (p: Page) => void }) {
  const [events, setEvents] = useState<LiveAuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [missingTables, setMissingTables] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState<number | null>(7)
  const [categoryFilter, setCategoryFilter] = useState<'all' | AuditCategory>('all')
  const [actorFilter, setActorFilter] = useState('all')
  const [actorTypeFilter, setActorTypeFilter] = useState<'all' | 'de' | 'human' | 'system'>('all')
  const [search, setSearch] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verification, setVerification] = useState<ChainVerification | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      setEvents(await listAuditEvents(days))
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
  }, [days]) // eslint-disable-line react-hooks/exhaustive-deps

  const verify = async () => {
    setVerifying(true)
    setError(null)
    try { setVerification(await verifyAuditChain()) }
    catch (err) { setError((err as Error)?.message || 'Chain verification failed.') }
    finally { setVerifying(false) }
  }

  const actors = Array.from(new Set(events.map(e => e.actor)))
  const q = search.trim().toLowerCase()
  const filtered = events.filter(e =>
    (categoryFilter === 'all' || e.category === categoryFilter) &&
    (actorFilter === 'all' || e.actor === actorFilter) &&
    (actorTypeFilter === 'all' || e.actor_type === actorTypeFilter) &&
    (q === '' || e.action.toLowerCase().includes(q) || e.actor.toLowerCase().includes(q))
  )
  // Chain position: events arrive newest-first; oldest is #1.
  const positionById = new Map(events.map((e, i) => [e.id, events.length - i]))
  const rangeLabel = RANGE_OPTIONS.find(r => r.days === days)?.label ?? 'window'

  const exportLiveCsv = () => {
    const headers = ['Timestamp', 'Actor', 'Actor Type', 'Category', 'Action', 'Chain #', 'Hash']
    const rows = filtered.map(e => [
      new Date(e.created_at).toISOString(), e.actor, e.actor_type, e.category,
      `"${e.action.replace(/"/g, '""')}"`, String(positionById.get(e.id) ?? ''), e.hash,
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6">
      {/* ⚠ THE ONE SENTENCE AN OWNER WILL REPEAT TO AN AUDITOR, so it says
          exactly what the database does and nothing more. Verified by
          attempting each operation against the live table inside a rollback:
            · UPDATE — refused unconditionally, for every role including
              service_role, and refused even with the purge flag set
            · DELETE — refused, UNLESS a session sets app.allow_audit_purge
            · TRUNCATE — refused (migration 635; the older trigger is FOR EACH
              ROW and TRUNCATE produces no rows, so it never fired)
            · anon and authenticated hold SELECT and nothing else, so nothing
              in the product can even attempt a write
            · every row is hash-chained and Verify walks the chain

          ⚠ THE PURGE FLAG IS NOT A LOOPHOLE, AND MUST NOT BE CLOSED. Exactly
          one thing sets it: delete_tenant. It is how a deleted workspace's
          records go with the workspace, which is what a customer asking to be
          erased is entitled to. That is why the sentence below is scoped to
          "this product" and to the record's lifetime rather than claiming a
          flat "never deleted" — deleting the workspace does remove it, on
          purpose, and an auditor asking the follow-up question should get the
          same answer from us either way. */}
      <PageHeader
        title="The record"
        subtitle="Every DE action, guardrail check, human approval and playbook step, hash-chained in order. The database refuses to edit or truncate a record once written — nothing in this product can alter or remove one. Deleting your workspace takes its record with it."
      />
      {error && <div className="mb-4 rounded-xl border border-dt-danger-border bg-dt-danger-soft px-4 py-3 text-xs text-dt-danger">{error}</div>}

      {/* Date window — tenant-wide, defaults to the last 7 days */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide text-dt-muted mr-1">Time window</span>
        <div className="inline-flex rounded-lg border border-dt-border bg-dt-card p-0.5">
          {RANGE_OPTIONS.map(r => (
            <button key={r.label} onClick={() => setDays(r.days)}
              className={`text-xs px-3 py-1 rounded-md transition-colors ${days === r.days ? 'bg-dt-accent-soft text-dt-accent-text' : 'text-dt-support hover:text-dt-body'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <TeamActivityLogPanel days={days} />

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : events.length === 0 ? (
        <LiveEmptyState
          icon="⛓"
          title={days == null ? 'No audit events yet' : `No audit events in the last ${rangeLabel}`}
          body="Every guardrail check, invoice, approval and playbook step your digital employees perform is added here, in order, and never changed afterwards. Widen the time window to see older activity."
          primaryLabel="Go to Renewal & Expansion"
          onPrimary={() => setPage?.('entity_customer_renewal')}
        />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: `Events (${rangeLabel})`, value: String(events.length), color: 'text-dt-title' },
              { label: 'Guardrail blocks', value: String(events.filter(e => e.category === 'guardrail_block').length), color: events.some(e => e.category === 'guardrail_block') ? 'text-dt-danger' : 'text-dt-ok' },
              { label: 'Approvals', value: String(events.filter(e => e.category === 'approval').length), color: 'text-dt-info' },
              {
                label: 'Chain integrity',
                value: verification ? (verification.intact ? `Intact (${verification.checked})` : 'BROKEN') : 'Not verified',
                color: verification ? (verification.intact ? 'text-dt-ok' : 'text-dt-danger') : 'text-dt-support',
              },
            ].map(s => (
              <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          <FilterBar
            className="mb-4"
            facets={<>
              <select value={categoryFilter} aria-label="Filter by category"
                onChange={e => setCategoryFilter(e.target.value as 'all' | AuditCategory)} className={SELECT_CLS}>
                <option value="all">All categories</option>
                {(Object.keys(LIVE_CATEGORY_META) as AuditCategory[]).map(c => (
                  <option key={c} value={c}>{LIVE_CATEGORY_META[c].label}</option>
                ))}
              </select>
              <select value={actorTypeFilter} aria-label="Filter by actor type"
                onChange={e => setActorTypeFilter(e.target.value as 'all' | 'de' | 'human' | 'system')} className={SELECT_CLS}>
                <option value="all">All actor types</option>
                <option value="de">Digital Employee</option>
                <option value="human">Human</option>
                <option value="system">System</option>
              </select>
              <select value={actorFilter} aria-label="Filter by actor"
                onChange={e => setActorFilter(e.target.value)} className={SELECT_CLS}>
                <option value="all">All actors</option>
                {actors.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </>}
            search={
              <input value={search} aria-label="Search action or actor"
                onChange={e => setSearch(e.target.value)}
                placeholder="Search action or actor…" className={INPUT_CLS} />
            }
            views={<>
              <Button size="sm" onClick={exportLiveCsv}>↓ Export CSV</Button>
              {/* Was a bespoke emerald outline. The chain result already
                  announces itself in a coloured banner directly below — the
                  button that asks the question does not need to be green too. */}
              <Button size="sm" onClick={() => void verify()} disabled={verifying}>
                {verifying ? 'Verifying…' : '⛓ Verify chain'}
              </Button>
            </>}
          />

          {verification && (
            <div className={`mb-4 rounded-xl border px-4 py-3 text-xs ${verification.intact
              ? 'border-dt-ok-border bg-dt-ok-soft text-dt-ok'
              : 'border-dt-danger-border bg-dt-danger-soft text-dt-danger'}`}>
              {verification.intact
                ? `Chain intact — all ${verification.checked} events recomputed and verified server-side: every record matches its own hash, and every record is reachable from the first one.`
                : `Chain BROKEN after ${verification.checked} verified events${verification.reason ? ` — ${verification.reason}` : ''} (record ${verification.broken_at ?? 'unknown'}). This should be impossible unless the database was tampered with directly.`}
              {/* Honest footnote: "intact" with recorded anomalies is not the
                  same as a perfectly linear chain, and the founder should not
                  have to read a migration to learn that. */}
              {verification.intact && verification.known_anomalies > 0 && (
                <span className="block mt-1 text-dt-muted">
                  Includes {verification.known_anomalies} recorded concurrency {verification.known_anomalies === 1 ? 'anomaly' : 'anomalies'} from
                  before the ordering fix (migration 549), where two records were written against the same
                  predecessor. No record was altered or lost — these are recorded rather than repaired,
                  because rewriting the log is exactly what it exists to detect.
                </span>
              )}
            </div>
          )}

          <div className="rounded-2xl border border-dt-border bg-dt-card divide-y divide-dt-border">
            {filtered.map(e => (
              <div key={e.id} className="grid grid-cols-12 gap-3 px-5 py-3">
                <div className="col-span-2 text-xs text-dt-muted pt-0.5 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</div>
                <div className="col-span-2 flex items-start gap-2">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${
                    e.actor_type === 'de' ? 'bg-dt-accent-soft text-dt-accent-text font-bold'
                    : e.actor_type === 'human' ? 'bg-dt-neutral-soft text-dt-neutral'
                    : 'bg-dt-panel text-dt-muted'
                  }`}>{e.actor_type === 'de' ? e.actor.slice(0, 2).toUpperCase() : e.actor_type === 'human' ? '◉' : '⊟'}</span>
                  <div>
                    <p className="text-xs text-dt-body">{e.actor}</p>
                    <p className="text-[10px] text-dt-faint capitalize">{e.actor_type === 'de' ? 'Digital Employee' : e.actor_type}</p>
                  </div>
                </div>
                <div className="col-span-6">
                  <p className={`text-xs leading-snug ${e.category === 'guardrail_block' ? 'text-dt-danger' : 'text-dt-support'}`}>{e.action}</p>
                  <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${LIVE_CATEGORY_META[e.category]?.style ?? 'bg-dt-panel text-dt-support'}`}>
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
              <div className="py-12 text-center text-dt-faint text-sm">No events match your filters.</div>
            )}
          </div>

          <p className="mt-4 text-xs text-dt-faint text-center">
            hash = sha256(prev_hash + tenant + action + detail + timestamp), computed inside the database. UPDATE and DELETE raise an exception — even for administrators.
          </p>
        </>
      )}
    </div>
  )
}

export default function AuditTrailPage({ setPage }: { setPage?: (p: Page) => void }) {
  return <LiveAuditTrail setPage={setPage} />
}

