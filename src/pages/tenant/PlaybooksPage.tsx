import React, { useState, useEffect, useCallback } from 'react'
import type { AuthUser, Tenant, Page } from '../../types'
import { StatCard, Badge } from '../../components'
import {
  fetchPlaybooks,
  createPlaybook,
  updatePlaybook,
  advancePlaybookLifecycle,
  fetchPlaybookSummary,
  fetchDigitalEmployees,
  assignPlaybookToDE,
  type DBPlaybook,
  type DBDigitalEmployee,
} from '../../lib/api'

// ── Constants ──────────────────────────────────────────────────

const DOMAINS = [
  { value: 'customer_support',     label: 'Customer Support' },
  { value: 'technical_support',    label: 'Technical Support' },
  { value: 'customer_success',     label: 'Customer Success' },
  { value: 'onboarding',           label: 'Customer Onboarding' },
  { value: 'business_development', label: 'Business Development' },
  { value: 'revenue_operations',   label: 'Revenue Operations' },
  { value: 'billing_operations',   label: 'Billing Operations' },
  { value: 'accounting',           label: 'Accounting Operations' },
  { value: 'finance',              label: 'Finance Operations' },
  { value: 'knowledge_management', label: 'Knowledge Management' },
  { value: 'learning_training',    label: 'Learning & Training' },
  { value: 'quality_assurance',    label: 'Quality Assurance' },
  { value: 'executive_operations', label: 'Executive Operations' },
]

const TRIGGER_TYPES = [
  { value: 'inbound_request',  label: 'Inbound Request' },
  { value: 'api_call',         label: 'API Call' },
  { value: 'scheduled',        label: 'Scheduled' },
  { value: 'event',            label: 'Event' },
  { value: 'human_initiated',  label: 'Human Initiated' },
  { value: 'threshold_breach', label: 'Threshold Breach' },
]

const LIFECYCLE_STAGES: DBPlaybook['lifecycle_status'][] = [
  'designed', 'drafted', 'configured', 'tested', 'simulated',
  'certified', 'published', 'assigned', 'active', 'improving', 'deprecated', 'retired',
]

const LIFECYCLE_NEXT: Record<string, DBPlaybook['lifecycle_status'] | null> = {
  designed:   'drafted',
  drafted:    'configured',
  configured: 'tested',
  tested:     'simulated',
  simulated:  'certified',
  certified:  'published',
  published:  'assigned',
  assigned:   'active',
  active:     'improving',
  improving:  'active',
  deprecated: 'retired',
  retired:    null,
}

function lifecycleBadgeClass(s: string) {
  if (['active', 'improving'].includes(s)) return 'bg-emerald-500/15 text-emerald-400'
  if (['published', 'assigned'].includes(s)) return 'bg-indigo-500/15 text-indigo-400'
  if (s === 'certified') return 'bg-amber-500/15 text-amber-400'
  if (s === 'simulated') return 'bg-purple-500/15 text-purple-400'
  if (['configured', 'tested'].includes(s)) return 'bg-blue-500/15 text-blue-400'
  if (['deprecated', 'retired'].includes(s)) return 'bg-red-500/15 text-red-400'
  return 'bg-slate-700/50 text-slate-400'
}

function riskBadgeClass(r: string) {
  if (r === 'critical') return 'bg-red-500/15 text-red-400'
  if (r === 'high')     return 'bg-orange-500/15 text-orange-400'
  if (r === 'medium')   return 'bg-amber-500/15 text-amber-400'
  return 'bg-emerald-500/15 text-emerald-400'
}

function domainLabel(v: string) {
  return DOMAINS.find(d => d.value === v)?.label ?? v
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── Create Modal ───────────────────────────────────────────────

interface CreateModalProps {
  tenantId: string
  accentColor: string
  digitalEmployees: DBDigitalEmployee[]
  onClose: () => void
  onCreated: (pb: DBPlaybook) => void
}

const EMPTY_FORM = {
  name: '',
  domain: 'customer_support',
  trigger_type: 'inbound_request' as DBPlaybook['trigger_type'],
  risk_level: 'low' as DBPlaybook['risk_level'],
  business_objective: '',
  owner_role: '',
  digital_employee_id: '',
  is_base_playbook: false,
}

function CreateModal({ tenantId, accentColor, digitalEmployees, onClose, onCreated }: CreateModalProps) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof typeof EMPTY_FORM, v: unknown) =>
    setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Playbook name is required.'); return }
    if (!form.business_objective.trim()) { setError('Business objective is required.'); return }
    setSaving(true); setError('')

    const pb = await createPlaybook(tenantId, {
      digital_employee_id: form.digital_employee_id || null,
      parent_playbook_id: null,
      name: form.name.trim(),
      slug: slugify(form.name.trim()),
      version: 1,
      domain: form.domain,
      business_objective: form.business_objective.trim(),
      owner_role: form.owner_role.trim() || null,
      risk_level: form.risk_level,
      lifecycle_status: 'designed',
      is_base_playbook: form.is_base_playbook,
      trigger_type: form.trigger_type,
      capabilities_used: [],
      knowledge_collections: [],
      connector_requirements: [],
      human_approval_required: false,
      approval_points: [],
      decision_rules: [],
      escalation_rules: [],
      exception_handlers: [],
      expected_outputs: [],
      kpis: [],
      estimated_duration_ms: null,
      estimated_cost_usd: null,
      tasks_this_month: 0,
      success_rate: 0,
      de_handled_rate: 0,
      certified_by: null,
      certified_at: null,
      next_review_due: null,
      created_by: null,
    })

    setSaving(false)
    if (!pb) { setError('Failed to create playbook. Try again.'); return }

    // If a DE was selected, create the assignment
    if (form.digital_employee_id && pb.id) {
      await assignPlaybookToDE(tenantId, form.digital_employee_id, pb.id, true)
    }

    onCreated(pb)
  }

  const inputCls = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-500 transition-colors'
  const labelCls = 'block text-xs font-medium text-slate-400 mb-1.5'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white">New Operational Playbook</h2>
            <p className="text-xs text-slate-500 mt-0.5">Define the business process specification</p>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className={labelCls}>Playbook Name *</label>
            <input className={inputCls} placeholder="e.g. Handle Billing Dispute"
              value={form.name} onChange={e => set('name', e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Operational Domain *</label>
              <select className={inputCls} value={form.domain} onChange={e => set('domain', e.target.value)}>
                {DOMAINS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Trigger Type</label>
              <select className={inputCls} value={form.trigger_type} onChange={e => set('trigger_type', e.target.value as DBPlaybook['trigger_type'])}>
                {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Business Objective *</label>
            <textarea className={inputCls + ' resize-none'} rows={3}
              placeholder="What does this Playbook exist to achieve? Write for the Playbook owner, not for engineers."
              value={form.business_objective} onChange={e => set('business_objective', e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Risk Level</label>
              <select className={inputCls} value={form.risk_level} onChange={e => set('risk_level', e.target.value as DBPlaybook['risk_level'])}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Owner Role</label>
              <input className={inputCls} placeholder="e.g. Finance Manager"
                value={form.owner_role} onChange={e => set('owner_role', e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Assign to Digital Employee</label>
            <select className={inputCls} value={form.digital_employee_id} onChange={e => set('digital_employee_id', e.target.value)}>
              <option value="">— Unassigned —</option>
              {digitalEmployees.map(de => (
                <option key={de.id} value={de.id}>{de.name} ({de.department})</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div
              onClick={() => set('is_base_playbook', !form.is_base_playbook)}
              className={`w-9 h-5 rounded-full transition-all flex-shrink-0 ${form.is_base_playbook ? 'bg-indigo-500' : 'bg-slate-700'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full shadow mt-0.5 transition-all ${form.is_base_playbook ? 'ml-4' : 'ml-0.5'}`} />
            </div>
            <div>
              <span className="text-sm text-white">Base Playbook</span>
              <p className="text-xs text-slate-500">Can be inherited by client-specific Playbooks</p>
            </div>
          </label>

          {error && <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>}
        </form>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={handleSubmit as unknown as React.MouseEventHandler}
            disabled={saving}
            className="px-5 py-2 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50"
            style={{ backgroundColor: accentColor }}
          >
            {saving ? 'Creating…' : 'Create Playbook'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Detail Panel ───────────────────────────────────────────────

function DetailPanel({
  playbook,
  digitalEmployees,
  tenantId,
  accentColor,
  onClose,
  onUpdated,
}: {
  playbook: DBPlaybook
  digitalEmployees: DBDigitalEmployee[]
  tenantId: string
  accentColor: string
  onClose: () => void
  onUpdated: (pb: DBPlaybook) => void
}) {
  const [advancing, setAdvancing] = useState(false)
  const nextStage = LIFECYCLE_NEXT[playbook.lifecycle_status]
  const assignedDE = digitalEmployees.find(d => d.id === playbook.digital_employee_id)

  const advance = async () => {
    if (!nextStage) return
    setAdvancing(true)
    const ok = await advancePlaybookLifecycle(playbook.id, tenantId, nextStage)
    if (ok) onUpdated({ ...playbook, lifecycle_status: nextStage })
    setAdvancing(false)
  }

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-start gap-4 py-3 border-b border-slate-800/60 last:border-0">
      <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-white flex-1">{value ?? <span className="text-slate-600">—</span>}</span>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${lifecycleBadgeClass(playbook.lifecycle_status)}`}>
                {playbook.lifecycle_status}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${riskBadgeClass(playbook.risk_level)}`}>
                {playbook.risk_level} risk
              </span>
              {playbook.is_base_playbook && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 font-medium">Base</span>
              )}
            </div>
            <h2 className="text-lg font-semibold text-white leading-snug">{playbook.name}</h2>
            <p className="text-xs text-slate-500 mt-1">{domainLabel(playbook.domain)} · v{playbook.version}</p>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Business Objective */}
          {playbook.business_objective && (
            <div className="mb-5 bg-slate-900 rounded-xl p-4 border border-slate-800">
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">Business Objective</p>
              <p className="text-sm text-slate-300 leading-relaxed">{playbook.business_objective}</p>
            </div>
          )}

          {/* Core fields */}
          <div className="mb-5">
            <Row label="Trigger" value={<span className="capitalize">{playbook.trigger_type.replace(/_/g, ' ')}</span>} />
            <Row label="Owner Role" value={playbook.owner_role} />
            <Row label="Digital Employee" value={assignedDE ? (
              <span className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-300 text-xs flex items-center justify-center font-bold">
                  {assignedDE.icon}
                </span>
                {assignedDE.name}
              </span>
            ) : null} />
            <Row label="Approval Required" value={playbook.human_approval_required ? (
              <span className="text-amber-400">Yes</span>
            ) : 'No'} />
            <Row label="Base Playbook" value={playbook.is_base_playbook ? 'Yes — can be inherited' : 'No'} />
            <Row label="Performance" value={playbook.tasks_this_month > 0 ? (
              <span className="flex items-center gap-3">
                <span>{playbook.tasks_this_month} tasks</span>
                <span className="text-emerald-400">{playbook.de_handled_rate}% DE-handled</span>
                <span className="text-slate-400">{playbook.success_rate}% success</span>
              </span>
            ) : <span className="text-slate-600">No executions yet</span>} />
          </div>

          {/* Capabilities */}
          {playbook.capabilities_used.length > 0 && (
            <div className="mb-5">
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">Capabilities Used</p>
              <div className="flex flex-wrap gap-2">
                {playbook.capabilities_used.map(c => (
                  <span key={c} className="text-xs px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg">{c}</span>
                ))}
              </div>
            </div>
          )}

          {/* Knowledge */}
          {playbook.knowledge_collections.length > 0 && (
            <div className="mb-5">
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">Knowledge Collections</p>
              <div className="flex flex-wrap gap-2">
                {playbook.knowledge_collections.map(k => (
                  <span key={k} className="text-xs px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg">{k}</span>
                ))}
              </div>
            </div>
          )}

          {/* KPIs */}
          {playbook.kpis.length > 0 && (
            <div className="mb-5">
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">KPI Targets</p>
              <div className="space-y-2">
                {playbook.kpis.map((kpi, i) => (
                  <div key={i} className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2">
                    <span className="text-sm text-slate-300">{kpi.name}</span>
                    <span className="text-sm font-medium text-white">{kpi.target}{kpi.unit}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lifecycle progress */}
          <div className="mb-4">
            <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-3">Lifecycle</p>
            <div className="flex items-center gap-1 flex-wrap">
              {LIFECYCLE_STAGES.filter(s => !['deprecated', 'retired'].includes(s)).map((s, i) => {
                const idx = LIFECYCLE_STAGES.indexOf(playbook.lifecycle_status)
                const thisIdx = LIFECYCLE_STAGES.indexOf(s)
                const isPast = thisIdx < idx
                const isCurrent = s === playbook.lifecycle_status
                return (
                  <React.Fragment key={s}>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize transition-all ${
                      isCurrent ? lifecycleBadgeClass(s) :
                      isPast ? 'bg-slate-800 text-slate-500 line-through' :
                      'bg-slate-900 text-slate-600'
                    }`}>{s}</span>
                    {i < LIFECYCLE_STAGES.filter(s => !['deprecated', 'retired'].includes(s)).length - 1 && (
                      <span className="text-slate-700 text-xs">›</span>
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          </div>

          {playbook.next_review_due && (
            <div className="text-xs text-slate-500 mt-2">
              Next review due: <span className="text-slate-300">{playbook.next_review_due}</span>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            Created {new Date(playbook.created_at).toLocaleDateString()}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors">
              Close
            </button>
            {nextStage && (
              <button
                onClick={advance}
                disabled={advancing}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-50 capitalize"
                style={{ backgroundColor: accentColor }}
              >
                {advancing ? 'Advancing…' : `Advance → ${nextStage}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────

export default function PlaybooksPage({
  user,
  tenant,
}: {
  user?: AuthUser
  tenant?: Tenant
  page?: Page
  setPage?: (p: Page) => void
  accentColor?: string
}) {
  const tenantId = tenant?.id ?? ''
  const accentColor = tenant?.primaryColor ?? '#6366f1'

  const [playbooks, setPlaybooks] = useState<DBPlaybook[]>([])
  const [digitalEmployees, setDigitalEmployees] = useState<DBDigitalEmployee[]>([])
  const [summary, setSummary] = useState({ total: 0, active: 0, domains: 0, avgHandledRate: 0, totalTasks: 0 })
  const [loading, setLoading] = useState(true)

  const [domainFilter, setDomainFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<DBPlaybook | null>(null)

  const load = useCallback(async () => {
    if (!tenantId) return
    setLoading(true)
    const [pbs, des, sum] = await Promise.all([
      fetchPlaybooks(tenantId),
      fetchDigitalEmployees(tenantId),
      fetchPlaybookSummary(tenantId),
    ])
    setPlaybooks(pbs)
    setDigitalEmployees(des)
    setSummary(sum)
    setLoading(false)
  }, [tenantId])

  useEffect(() => { load() }, [load])

  const filtered = playbooks.filter(pb => {
    if (domainFilter !== 'all' && pb.domain !== domainFilter) return false
    if (statusFilter !== 'all' && pb.lifecycle_status !== statusFilter) return false
    return true
  })

  const activeDomains = [...new Set(playbooks.map(p => p.domain).filter(Boolean))]

  const handleCreated = (pb: DBPlaybook) => {
    setPlaybooks(prev => [pb, ...prev])
    setSummary(prev => ({ ...prev, total: prev.total + 1 }))
    setShowCreate(false)
    setSelected(pb)
  }

  const handleUpdated = (pb: DBPlaybook) => {
    setPlaybooks(prev => prev.map(p => p.id === pb.id ? pb : p))
    if (selected?.id === pb.id) setSelected(pb)
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Operational Playbooks</h1>
          <p className="text-slate-400 text-sm mt-1">
            Governing business process specifications for every Digital Employee operation
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + New Playbook
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Playbooks"     value={String(summary.total)}          icon="▦" color="blue" />
        <StatCard label="Active"              value={String(summary.active)}          icon="◈" color="emerald" />
        <StatCard label="Domains Covered"     value={String(summary.domains)}         icon="⊞" color="purple" />
        <StatCard label="Avg DE-Handled Rate" value={`${summary.avgHandledRate}%`}   icon="⚡" color="amber" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {/* Domain filter */}
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          <button
            onClick={() => setDomainFilter('all')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${domainFilter === 'all' ? 'text-white' : 'text-slate-400 hover:text-white'}`}
            style={domainFilter === 'all' ? { backgroundColor: accentColor } : {}}
          >All Domains</button>
          {activeDomains.map(d => (
            <button key={d}
              onClick={() => setDomainFilter(d)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${domainFilter === d ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              style={domainFilter === d ? { backgroundColor: accentColor } : {}}
            >{domainLabel(d)}</button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'designed', 'active', 'certified', 'published'] as const).map(s => (
            <button key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${statusFilter === s ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              style={statusFilter === s ? { backgroundColor: accentColor } : {}}
            >{s === 'all' ? 'All Status' : s}</button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-3xl mb-4">▦</div>
          <h2 className="text-lg font-semibold text-white mb-2">No Playbooks yet</h2>
          <p className="text-slate-500 text-sm max-w-sm mb-6">
            Playbooks govern how your Digital Employees operate. Create your first Playbook to start encoding operational excellence.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-5 py-2.5 rounded-xl text-sm font-medium text-white"
            style={{ backgroundColor: accentColor }}
          >
            Create First Playbook
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <div className="w-6 h-6 border-2 border-slate-700 border-t-slate-400 rounded-full animate-spin" />
        </div>
      )}

      {/* Playbook grid */}
      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(pb => {
            const de = digitalEmployees.find(d => d.id === pb.digital_employee_id)
            return (
              <div
                key={pb.id}
                onClick={() => setSelected(pb)}
                className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 cursor-pointer transition-all group"
              >
                {/* Top row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${lifecycleBadgeClass(pb.lifecycle_status)}`}>
                        {pb.lifecycle_status}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${riskBadgeClass(pb.risk_level)}`}>
                        {pb.risk_level}
                      </span>
                      {pb.is_base_playbook && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 font-medium">Base</span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-white leading-snug group-hover:text-indigo-300 transition-colors">
                      {pb.name}
                    </h3>
                  </div>
                </div>

                {/* Domain + trigger */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-slate-500">{domainLabel(pb.domain)}</span>
                  <span className="text-slate-700">·</span>
                  <span className="text-xs text-slate-500 capitalize">{pb.trigger_type.replace(/_/g, ' ')}</span>
                </div>

                {/* Business objective */}
                {pb.business_objective && (
                  <p className="text-xs text-slate-400 leading-relaxed mb-4 line-clamp-2">
                    {pb.business_objective}
                  </p>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                  <div className="flex items-center gap-2">
                    {de ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-md bg-indigo-500/20 text-indigo-300 text-xs flex items-center justify-center font-bold">
                          {de.icon}
                        </div>
                        <span className="text-xs text-slate-500 truncate max-w-[100px]">{de.name}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-600">Unassigned</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {pb.tasks_this_month > 0 && (
                      <span className="text-xs text-emerald-400">{pb.de_handled_rate}% handled</span>
                    )}
                    <span className="text-xs text-slate-600">v{pb.version}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateModal
          tenantId={tenantId}
          accentColor={accentColor}
          digitalEmployees={digitalEmployees}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          playbook={selected}
          digitalEmployees={digitalEmployees}
          tenantId={tenantId}
          accentColor={accentColor}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  )
}
