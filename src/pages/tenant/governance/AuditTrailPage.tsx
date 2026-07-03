import React, { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import type { CompanyId } from '../../../data/companies'
import { PageHeader } from '../../../components/ui'

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
  { id: 't1', timestamp: '2026-07-03 14:22', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4821 — "How do I reset 2FA?"', entity: 'Customer', outcome: 'Resolved' },
  { id: 't2', timestamp: '2026-07-03 14:15', actor: 'CS Manager', actorType: 'human', actionType: 'approval', action: 'Approved invoice #4821 — Meridian Group $15,600', entity: 'Customer', outcome: 'Approved' },
  { id: 't3', timestamp: '2026-07-03 14:10', actor: 'Casey', actorType: 'de', actionType: 'escalated', action: 'Generated invoice — Meridian Group $15,600', entity: 'Customer', outcome: 'Pending approval' },
  { id: 't4', timestamp: '2026-07-03 13:58', actor: 'Alex', actorType: 'de', actionType: 'escalated', action: 'Escalated ticket #4819 — API auth bug', entity: 'Customer', outcome: 'Escalated to L2' },
  { id: 't5', timestamp: '2026-07-03 13:30', actor: 'Riley', actorType: 'de', actionType: 'resolved', action: 'Processed onboarding — new hire Jordan K.', entity: 'Workforce', outcome: 'Complete' },
  { id: 't6', timestamp: '2026-07-03 12:15', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Submitted KB article — "Rate limiting guide"', entity: 'Knowledge', outcome: 'Pending review' },
  { id: 't7', timestamp: '2026-07-03 11:30', actor: 'Casey', actorType: 'de', actionType: 'resolved', action: 'Sent renewal email cadence — 3 accounts', entity: 'Customer', outcome: 'Sent' },
  { id: 't8', timestamp: '2026-07-03 11:00', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4815 — billing question', entity: 'Customer', outcome: 'Resolved' },
  { id: 't9', timestamp: '2026-07-03 10:40', actor: 'HR Manager', actorType: 'human', actionType: 'approval', action: 'Approved equipment provisioning for Jordan K.', entity: 'Workforce', outcome: 'Approved' },
  { id: 't10', timestamp: '2026-07-03 09:45', actor: 'Alex', actorType: 'de', actionType: 'guardrail_violation', action: 'BLOCKED: Alex attempted SLA commitment outside standard tier — guardrail DE-R2', entity: 'Customer', outcome: 'Blocked' },
  { id: 't11', timestamp: '2026-07-03 09:12', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved ticket #4811 — password reset loop', entity: 'Customer', outcome: 'Resolved' },
  { id: 't12', timestamp: '2026-07-02 16:30', actor: 'K. Douglas (Security)', actorType: 'human', actionType: 'config_change', action: 'Guardrails updated v2.2→v2.3 — added SLA-tier restriction (Alex)', entity: 'Governance', outcome: 'Config change' },
  { id: 't13', timestamp: '2026-07-02 15:10', actor: 'Alex', actorType: 'de', actionType: 'resolved', action: 'Resolved 8 tickets — batch shift', entity: 'Customer', outcome: 'Resolved' },
  { id: 't14', timestamp: '2026-07-02 15:00', actor: 'Casey', actorType: 'de', actionType: 'escalated', action: 'Flagged at-risk — Apex Systems', entity: 'Customer', outcome: 'Escalated to AE' },
  { id: 't15', timestamp: '2026-07-02 14:00', actor: 'Riley', actorType: 'de', actionType: 'resolved', action: 'Leave request approved — M. Chen', entity: 'Workforce', outcome: 'Approved' },
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
  { id: 'p1', timestamp: '2026-07-03 14:05', actor: 'Avery', actorType: 'de', actionType: 'escalated', action: 'Completed Q2 corporate tax memo — TCP Corp', entity: 'Specialist', outcome: 'Sent to partner review' },
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
      <span className="w-6 h-6 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center text-[10px] flex-shrink-0">◉</span>
    )
  }
  return (
    <span className="w-6 h-6 rounded-full bg-slate-800 text-slate-500 flex items-center justify-center text-[10px] flex-shrink-0">⊟</span>
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

export default function AuditTrailPage() {
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
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          title="Audit Trail"
          subtitle="Immutable, hash-chained log of every DE action, human approval, config change, and guardrail block"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400">
            Retention: <span className="text-white">{RETENTION[activeCompanyId]}</span>
          </span>
          <button onClick={() => exportCsv(filtered)}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors">
            ↓ Export CSV
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats.map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className={`text-xl font-bold ${s.color || 'text-white'}`}>{s.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Actor:</span>
          {['all', ...deNames, 'humans'].map(a => (
            <button key={a} onClick={() => setActorFilter(a)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${actorFilter === a ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
              {a === 'all' ? 'All' : a === 'humans' ? 'Humans' : a}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Type:</span>
          {(['all', 'resolved', 'escalated', 'config_change', 'approval', 'guardrail_violation'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${typeFilter === t ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
              {t === 'all' ? 'All' : ACTION_TYPE_META[t].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <span className="text-xs text-slate-500 font-medium w-16">Entity:</span>
          <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-xs text-slate-200 rounded-lg px-2 py-1.5 focus:outline-none">
            <option value="all">All entities</option>
            {entities.map(e => <option key={e}>{e}</option>)}
          </select>
          <span className="text-xs text-slate-500">From</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
          <span className="text-xs text-slate-500">To</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-xs text-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
          <span className="text-xs text-slate-500 ml-auto">{filtered.length} of {events.length} events</span>
        </div>
      </div>

      {/* Event log */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-12 gap-3 px-4 py-3 border-b border-slate-800 text-[11px] font-medium text-slate-500 uppercase tracking-wide">
          <div className="col-span-2">Timestamp</div>
          <div className="col-span-2">Actor</div>
          <div className="col-span-4">Action</div>
          <div className="col-span-1">Entity</div>
          <div className="col-span-2">Outcome</div>
          <div className="col-span-1 text-right">Integrity</div>
        </div>
        <div className="divide-y divide-slate-800/50">
          {filtered.map(e => (
            <div key={e.id} className={`grid grid-cols-12 gap-3 px-4 py-3 items-start transition-colors ${e.actionType === 'guardrail_violation' ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-800/20'}`}>
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
                <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${ACTION_TYPE_META[e.actionType].style}`}>
                  {ACTION_TYPE_META[e.actionType].label}
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
