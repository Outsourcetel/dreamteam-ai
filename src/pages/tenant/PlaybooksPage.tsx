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

type StepType = 'action' | 'decision' | 'approval' | 'notification' | 'condition'

interface PlaybookStep {
  id: string
  step: number
  title: string
  description: string
  type: StepType
  requires_approval: boolean
}

const STEP_TYPES: { value: StepType; label: string; color: string }[] = [
  { value: 'action', label: 'Action', color: 'bg-indigo-500/15 text-indigo-400' },
  { value: 'decision', label: 'Decision', color: 'bg-amber-500/15 text-amber-400' },
  { value: 'approval', label: 'Approval', color: 'bg-red-500/15 text-red-400' },
  { value: 'notification', label: 'Notification', color: 'bg-blue-500/15 text-blue-400' },
  { value: 'condition', label: 'Condition', color: 'bg-purple-500/15 text-purple-400' },
]

function stepTypeCls(t: StepType) {
  return STEP_TYPES.find(s => s.value === t)?.color ?? 'bg-slate-700/50 text-slate-400'
}

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
  const [detailTab, setDetailTab] = useState<'trigger' | 'overview' | 'steps' | 'lifecycle'>('overview')
  // Trigger tab state
  const initTrigger = () => {
    const rules = playbook.decision_rules as any
    const t = rules?.trigger
    return { type: (t?.type as 'manual' | 'scheduled' | 'event') || 'manual', schedule: t?.schedule || 'daily', event: t?.event || '' }
  }
  const initTrig = initTrigger()
  const [triggerType, setTriggerType] = useState<'manual' | 'scheduled' | 'event'>(initTrig.type)
  const [triggerSchedule, setTriggerSchedule] = useState(initTrig.schedule)
  const [triggerEvent, setTriggerEvent] = useState(initTrig.event)
  const [triggerSaving, setTriggerSaving] = useState(false)
  const [triggerToast, setTriggerToast] = useState('')

  const saveTrigger = async () => {
    setTriggerSaving(true)
    const existingSteps = Array.isArray(playbook.decision_rules) ? (playbook.decision_rules as any[]).filter((r: any) => r?.step && r?.title) : []
    const newRules = { steps: existingSteps, trigger: { type: triggerType, schedule: triggerSchedule, event: triggerEvent } }
    await updatePlaybook(playbook.id, tenantId, { decision_rules: [newRules] as any[] })
    setTriggerSaving(false)
    setTriggerToast('Trigger saved')
    setTimeout(() => setTriggerToast(''), 3000)
  }
  const nextStage = LIFECYCLE_NEXT[playbook.lifecycle_status]
  const assignedDE = digitalEmployees.find(d => d.id === playbook.digital_employee_id)

  // Steps — stored in decision_rules as PlaybookStep[]
  const initSteps = (): PlaybookStep[] => {
    if (!Array.isArray(playbook.decision_rules)) return []
    return playbook.decision_rules.filter((r: any) => r && r.step && r.title) as PlaybookStep[]
  }
  const [steps, setSteps] = useState<PlaybookStep[]>(initSteps)
  const [addingStep, setAddingStep] = useState(false)
  const [newStep, setNewStep] = useState({ title: '', description: '', type: 'action' as StepType, requires_approval: false })
  const [savingSteps, setSavingSteps] = useState(false)

  const saveSteps = async (updated: PlaybookStep[]) => {
    setSavingSteps(true)
    const ok = await updatePlaybook(playbook.id, tenantId, { decision_rules: updated as any[] })
    if (ok) onUpdated({ ...playbook, decision_rules: updated as any[] })
    setSavingSteps(false)
  }

  const addStep = async () => {
    if (!newStep.title.trim()) return
    const step: PlaybookStep = {
      id: Date.now().toString(),
      step: steps.length + 1,
      title: newStep.title.trim(),
      description: newStep.description.trim(),
      type: newStep.type,
      requires_approval: newStep.requires_approval,
    }
    const updated = [...steps, step]
    setSteps(updated)
    await saveSteps(updated)
    setNewStep({ title: '', description: '', type: 'action', requires_approval: false })
    setAddingStep(false)
  }

  const removeStep = async (id: string) => {
    const updated = steps.filter(s => s.id !== id).map((s, i) => ({ ...s, step: i + 1 }))
    setSteps(updated)
    await saveSteps(updated)
  }

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

  const inputCls = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-500 transition-colors'

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

        {/* Sub-tabs */}
        <div className="flex gap-1 px-6 pt-4 pb-0 border-b border-slate-800">
          {(['trigger', 'overview', 'steps', 'lifecycle'] as const).map(t => (
            <button key={t} onClick={() => setDetailTab(t)}
              className={`px-3 py-2 text-xs font-medium capitalize border-b-2 transition-all ${
                detailTab === t ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
              style={detailTab === t ? { borderColor: accentColor } : {}}>
              {t} {t === 'steps' && steps.length > 0 ? `(${steps.length})` : ''}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">

          {detailTab === 'trigger' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">Choose how this playbook gets started.</p>
              {triggerToast && <div className="text-xs text-emerald-400">{triggerToast}</div>}
              {[
                { type: 'manual' as const, label: 'Manual', desc: 'Run this playbook on demand' },
                { type: 'scheduled' as const, label: 'Scheduled', desc: 'Run automatically on a schedule' },
                { type: 'event' as const, label: 'Event', desc: 'Run when a condition is met' },
              ].map(opt => (
                <div key={opt.type} onClick={() => setTriggerType(opt.type)}
                  className={`rounded-xl border p-4 cursor-pointer transition-all ${triggerType === opt.type ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-600'}`}
                  style={triggerType === opt.type ? { borderColor: accentColor, backgroundColor: accentColor + '15' } : {}}>
                  <div className="flex items-center gap-3">
                    <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${triggerType === opt.type ? 'border-indigo-400 bg-indigo-400' : 'border-slate-600'}`} style={triggerType === opt.type ? { borderColor: accentColor, backgroundColor: accentColor } : {}} />
                    <div>
                      <div className="text-sm font-medium text-white">{opt.label}</div>
                      <div className="text-xs text-slate-400">{opt.desc}</div>
                    </div>
                  </div>
                  {triggerType === opt.type && opt.type === 'manual' && (
                    <button onClick={e => { e.stopPropagation(); setTriggerToast(`${playbook.name} triggered — ${steps.length || 0} steps queued`); setTimeout(() => setTriggerToast(''), 3000); }}
                      className="mt-3 px-3 py-1.5 text-xs font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>Run Now</button>
                  )}
                  {triggerType === opt.type && opt.type === 'scheduled' && (
                    <div className="mt-3">
                      <select value={triggerSchedule} onChange={e => setTriggerSchedule(e.target.value)} onClick={e => e.stopPropagation()}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                        <option value="daily">Daily</option>
                        <option value="weekly_monday">Weekly (Monday)</option>
                        <option value="monthly_1st">Monthly (1st)</option>
                        <option value="custom">Custom cron</option>
                      </select>
                      <p className="text-xs text-slate-500 mt-2">Next run: {triggerSchedule === 'daily' ? 'Tomorrow' : triggerSchedule === 'weekly_monday' ? 'Next Monday' : triggerSchedule === 'monthly_1st' ? '1st of next month' : 'Per cron expression'}</p>
                    </div>
                  )}
                  {triggerType === opt.type && opt.type === 'event' && (
                    <div className="mt-3">
                      <input value={triggerEvent} onChange={e => setTriggerEvent(e.target.value)} onClick={e => e.stopPropagation()}
                        placeholder='e.g. "invoice.due_date is 7 days away"'
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
                      <p className="text-xs text-slate-500 mt-1">Examples: "payment.status changes to overdue" · "invoice.due_date is 7 days away"</p>
                    </div>
                  )}
                </div>
              ))}
              <button onClick={saveTrigger} disabled={triggerSaving}
                className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>
                {triggerSaving ? 'Saving…' : 'Save Trigger'}
              </button>
            </div>
          )}

          {detailTab === 'overview' && (
            <>
              {playbook.business_objective && (
                <div className="mb-5 bg-slate-900 rounded-xl p-4 border border-slate-800">
                  <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">Business Objective</p>
                  <p className="text-sm text-slate-300 leading-relaxed">{playbook.business_objective}</p>
                </div>
              )}
              <div className="mb-5">
                <Row label="Trigger" value={<span className="capitalize">{playbook.trigger_type.replace(/_/g, ' ')}</span>} />
                <Row label="Owner Role" value={playbook.owner_role} />
                <Row label="Digital Employee" value={assignedDE ? (
                  <span className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-300 text-xs flex items-center justify-center font-bold">{assignedDE.icon}</span>
                    {assignedDE.name}
                  </span>
                ) : null} />
                <Row label="Approval Required" value={playbook.human_approval_required ? <span className="text-amber-400">Yes</span> : 'No'} />
                <Row label="Base Playbook" value={playbook.is_base_playbook ? 'Yes — can be inherited' : 'No'} />
                <Row label="Performance" value={playbook.tasks_this_month > 0 ? (
                  <span className="flex items-center gap-3">
                    <span>{playbook.tasks_this_month} tasks</span>
                    <span className="text-emerald-400">{playbook.de_handled_rate}% DE-handled</span>
                    <span className="text-slate-400">{playbook.success_rate}% success</span>
                  </span>
                ) : <span className="text-slate-600">No executions yet</span>} />
              </div>
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
            </>
          )}

          {detailTab === 'steps' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500">Define the workflow steps this Playbook executes in sequence.</p>
                {!addingStep && (
                  <button onClick={() => setAddingStep(true)}
                    className="text-xs px-3 py-1.5 rounded-lg text-white transition-all"
                    style={{ backgroundColor: accentColor }}>+ Add Step</button>
                )}
              </div>

              {/* Existing steps */}
              {steps.length === 0 && !addingStep && (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">No steps defined yet.</p>
                  <p className="text-slate-600 text-xs mt-1">Add steps to design the workflow this Playbook follows.</p>
                </div>
              )}
              {steps.map((s, i) => (
                <div key={s.id} className="flex gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
                    style={{ backgroundColor: accentColor + '60' }}>{s.step}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-white">{s.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize ${stepTypeCls(s.type)}`}>{s.type}</span>
                      {s.requires_approval && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">needs approval</span>}
                    </div>
                    {s.description && <p className="text-xs text-slate-400">{s.description}</p>}
                  </div>
                  <button onClick={() => removeStep(s.id)} className="text-slate-700 hover:text-red-400 transition-all text-sm flex-shrink-0">×</button>
                </div>
              ))}

              {/* Add step form */}
              {addingStep && (
                <div className="bg-slate-900 border border-indigo-500/30 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">New Step {steps.length + 1}</p>
                  <input className={inputCls} placeholder="Step title (e.g. Validate customer identity)" value={newStep.title} onChange={e => setNewStep(p => ({ ...p, title: e.target.value }))} />
                  <textarea className={inputCls + ' resize-none'} rows={2} placeholder="What happens in this step?" value={newStep.description} onChange={e => setNewStep(p => ({ ...p, description: e.target.value }))} />
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-slate-500 block mb-1">Step Type</label>
                      <select className={inputCls} value={newStep.type} onChange={e => setNewStep(p => ({ ...p, type: e.target.value as StepType }))}>
                        {STEP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    <div className="flex items-end gap-2 pb-0.5">
                      <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-400">
                        <input type="checkbox" checked={newStep.requires_approval} onChange={e => setNewStep(p => ({ ...p, requires_approval: e.target.checked }))} />
                        Needs approval
                      </label>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setAddingStep(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={addStep} disabled={savingSteps || !newStep.title.trim()}
                      className="px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 transition-all"
                      style={{ backgroundColor: accentColor }}>
                      {savingSteps ? 'Saving…' : 'Add Step'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {detailTab === 'lifecycle' && (
            <div>
              <p className="text-xs text-slate-500 mb-4">Track this Playbook through its operational lifecycle — from design to active deployment.</p>
              <div className="space-y-2">
                {LIFECYCLE_STAGES.map((s, i) => {
                  const idx = LIFECYCLE_STAGES.indexOf(playbook.lifecycle_status)
                  const thisIdx = LIFECYCLE_STAGES.indexOf(s)
                  const isPast = thisIdx < idx
                  const isCurrent = s === playbook.lifecycle_status
                  return (
                    <div key={s} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                      isCurrent ? 'border-indigo-500/40 bg-indigo-500/10' :
                      isPast ? 'border-slate-800 bg-slate-900/30' :
                      'border-slate-800/40 bg-slate-900/10'
                    }`}>
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                        isCurrent ? 'text-white' : isPast ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-600'
                      }`} style={isCurrent ? { backgroundColor: accentColor } : {}}>
                        {isPast ? '✓' : String(i + 1)}
                      </div>
                      <span className={`text-sm capitalize font-medium ${isCurrent ? 'text-white' : isPast ? 'text-slate-400 line-through' : 'text-slate-600'}`}>
                        {s}
                      </span>
                      {isCurrent && <span className="ml-auto text-xs text-indigo-400">Current</span>}
                    </div>
                  )
                })}
              </div>
              {playbook.next_review_due && (
                <div className="mt-4 text-xs text-slate-500">
                  Next review due: <span className="text-slate-300">{playbook.next_review_due}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600">Created {new Date(playbook.created_at).toLocaleDateString()}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors">Close</button>
            {nextStage && (
              <button onClick={advance} disabled={advancing}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-50 capitalize"
                style={{ backgroundColor: accentColor }}>
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
  const [runToast, setRunToast] = useState('')

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

      {/* Run toast */}
      {runToast && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{runToast}</div>
      )}

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
                  <div className="flex items-center gap-2">
                    {pb.tasks_this_month > 0 && (
                      <span className="text-xs text-emerald-400">{pb.de_handled_rate}% handled</span>
                    )}
                    <span className="text-xs text-slate-600">v{pb.version}</span>
                    <button
                      onClick={e => { e.stopPropagation(); setRunToast(`${pb.name} triggered — ${Array.isArray(pb.decision_rules) ? pb.decision_rules.filter((r: any) => r?.step).length : 0} steps queued`); setTimeout(() => setRunToast(''), 3000); }}
                      className="px-2 py-0.5 text-[10px] rounded border border-slate-700 text-slate-400 hover:border-indigo-500 hover:text-indigo-300 transition-all">▶ Run</button>
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
