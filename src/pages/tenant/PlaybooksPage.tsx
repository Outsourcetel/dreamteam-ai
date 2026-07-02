import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { AuthUser, Tenant, Page } from '../../types'
import { StatCard } from '../../components'
import {
  fetchPlaybooks,
  createPlaybook,
  updatePlaybook,
  advancePlaybookLifecycle,
  fetchPlaybookSummary,
  fetchDigitalEmployees,
  assignPlaybookToDE,
  loadConnectors,
  type DBPlaybook,
  type DBDigitalEmployee,
  type ConnectorConfig,
} from '../../lib/api'

// ── Renewal Playbook Template ──────────────────────────────────

const RENEWAL_PLAYBOOK_STEPS = [
  { id: 's1', step: 1, title: 'Pull Contract from Gainsight', description: 'Fetch contract renewal date, ARR, health score, and CSM owner for the account.', type: 'action' as const, requires_approval: false, output_var: 'gainsight_contract', connector: 'gainsight', action: 'read_contract', timeout_seconds: 30, on_failure: 'stop' as const, mock_output: { company_name: 'TCP Inc', contract_value: 84000, health_score: 72, renewal_date: '2026-07-31', csm_owner: 'Morgan Chen' } },
  { id: 's2', step: 2, title: 'Pull Subscription from Zuora', description: 'Fetch current subscription details, MRR, and any usage overages from Zuora.', type: 'action' as const, requires_approval: false, output_var: 'zuora_subscription', connector: 'zuora', action: 'read_subscription', timeout_seconds: 30, on_failure: 'stop' as const, mock_output: { subscription_id: 'SUB-00123', mrr: 7000, overage_amount: 420, plan: 'Enterprise' } },
  { id: 's3', step: 3, title: 'Health Score Check', description: 'Route renewal based on Gainsight health score — healthy accounts go to standard renewal, at-risk accounts get CSM review.', type: 'decision' as const, requires_approval: false, condition: 'gainsight_contract.health_score >= 70', on_true: 's4', on_false: 's4b' },
  { id: 's4', step: 4, title: 'Generate Invoice in Zuora', description: 'Create renewal invoice in Zuora for the subscription amount plus any overages.', type: 'action' as const, requires_approval: true, output_var: 'invoice', connector: 'zuora', action: 'create_invoice', timeout_seconds: 60, on_failure: 'notify' as any, mock_output: { invoice_id: 'INV-20260731-TCP', amount: 84420, due_date: '2026-07-31', status: 'draft' } },
  { id: 's4b', step: 5, title: 'Flag for CSM Review', description: 'Health score below threshold — create a Gainsight CTA and notify the CSM before generating invoice.', type: 'notification' as const, requires_approval: false, assigned_to: 'csm_owner' },
  { id: 's5', step: 6, title: 'Send Renewal Email — Day 0', description: 'Send the initial renewal email with invoice link to the primary billing contact.', type: 'action' as const, requires_approval: false, connector: 'email', action: 'send_template', timeout_seconds: 30, on_failure: 'skip' as const },
  { id: 's6', step: 7, title: 'Wait 7 Days — Check Payment', description: 'Monitor Zuora for payment_received event. If unpaid after 7 days, send reminder.', type: 'condition' as const, requires_approval: false, condition: 'invoice.status === "paid"', on_true: 's9', on_false: 's7' },
  { id: 's7', step: 8, title: 'Send Payment Reminder — Day 7', description: 'Invoice still unpaid — send a friendly reminder email.', type: 'action' as const, requires_approval: false, connector: 'zuora', action: 'send_payment_reminder', timeout_seconds: 30, on_failure: 'skip' as const },
  { id: 's8', step: 9, title: 'Final Notice — Day 14', description: 'Second follow-up if still unpaid after 14 days. Notify CSM and send final notice email.', type: 'notification' as const, requires_approval: false, assigned_to: 'csm_owner' },
  { id: 's9', step: 10, title: 'Mark Invoice Paid in Zuora', description: 'Payment confirmed — update invoice status in Zuora to PAID.', type: 'action' as const, requires_approval: false, connector: 'zuora', action: 'mark_paid', timeout_seconds: 30, on_failure: 'stop' as const },
  { id: 's10', step: 11, title: 'Update Renewal Status in Gainsight', description: 'Log the successful renewal to Gainsight timeline and update renewal stage to "Renewed".', type: 'action' as const, requires_approval: false, connector: 'gainsight', action: 'update_renewal_status', timeout_seconds: 30, on_failure: 'skip' as const },
  { id: 's11', step: 12, title: 'Renewal Complete', description: 'Notify the account team that TCP renewal is complete. Log summary.', type: 'notification' as const, requires_approval: false, assigned_to: 'account_owner' },
]

const RENEWAL_PLAYBOOK_TEMPLATE: DBPlaybook = {
  id: 'pb-renewal-001',
  tenant_id: 'a0000000-0000-0000-0000-000000000001',
  digital_employee_id: null,
  parent_playbook_id: null,
  name: 'Customer Renewal Workflow',
  slug: 'customer-renewal-workflow',
  version: 1,
  domain: 'finance',
  business_objective: 'End-to-end renewal management: detect upcoming renewals, generate invoices in Zuora, send email cadence, and confirm payment.',
  owner_role: 'Finance Manager',
  risk_level: 'medium',
  lifecycle_status: 'active',
  is_base_playbook: false,
  trigger_type: 'scheduled',
  capabilities_used: ['billing', 'invoicing', 'renewal_management', 'email'],
  knowledge_collections: [],
  connector_requirements: ['zuora', 'gainsight'],
  human_approval_required: true,
  approval_points: [],
  decision_rules: RENEWAL_PLAYBOOK_STEPS as any[],
  escalation_rules: [],
  exception_handlers: [],
  expected_outputs: [],
  kpis: [
    { name: 'Renewal Rate', target: 95, unit: '%' },
    { name: 'Days to Invoice', target: 3, unit: ' days' },
  ],
  estimated_duration_ms: null,
  estimated_cost_usd: null,
  tasks_this_month: 8,
  success_rate: 94,
  de_handled_rate: 82,
  certified_by: null,
  certified_at: null,
  next_review_due: null,
  created_by: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

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

// ── Execution State Model ──────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'waiting_approval' | 'skipped'

interface StepExecution {
  stepId: string
  status: StepStatus
  startedAt?: string
  completedAt?: string
  output?: string
  error?: string
  approvedBy?: string
  subSteps?: { title: string; status: StepStatus }[]
}

interface PlaybookRun {
  id: string
  playbookId: string
  playbookName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'waiting_approval' | 'paused'
  steps: StepExecution[]
  triggeredBy: 'manual' | 'scheduled' | 'event'
  context?: Record<string, string>
}

function loadRuns(tenantId: string): PlaybookRun[] {
  try {
    return JSON.parse(localStorage.getItem(`dt_pb_runs_${tenantId}`) || '[]')
  } catch {
    return []
  }
}

function saveRuns(tenantId: string, runs: PlaybookRun[]) {
  localStorage.setItem(`dt_pb_runs_${tenantId}`, JSON.stringify(runs))
}

// ── Run Modal ─────────────────────────────────────────────────

function RunModal({
  run,
  onApprove,
  onClose,
  accentColor,
}: {
  run: PlaybookRun
  onApprove: (stepId: string) => void
  onClose: () => void
  accentColor: string
}) {
  const completedCount = run.steps.filter(s => s.status === 'completed').length
  const total = run.steps.length
  const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0
  const isRunning = run.status === 'running'
  const isWaiting = run.status === 'waiting_approval'

  const elapsed = run.completedAt
    ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)

  const barColor = run.status === 'completed'
    ? 'bg-emerald-500'
    : run.status === 'waiting_approval'
    ? 'bg-amber-500'
    : 'bg-indigo-500'

  const headerStatus = run.status === 'completed'
    ? 'Completed'
    : run.status === 'waiting_approval'
    ? 'Waiting for Approval'
    : run.status === 'failed'
    ? 'Failed'
    : 'Execution in Progress'

  const approvalCount = run.steps.filter(s => s.approvedBy).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">{run.playbookName}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{headerStatus}</p>
          </div>
          <button onClick={onClose} disabled={isRunning} className="text-slate-600 hover:text-slate-400 text-xl leading-none disabled:opacity-30">×</button>
        </div>

        {/* Progress bar */}
        <div className="px-6 pt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-slate-500">{completedCount} of {total} steps</span>
            <span className="text-xs text-slate-500">{pct}%</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Steps list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          {run.steps.map((se, idx) => {
            const isStepRunning = se.status === 'running'
            const isApproval = se.status === 'waiting_approval'
            return (
              <div key={se.stepId} className={`flex gap-3 rounded-xl p-3.5 border transition-all ${
                isStepRunning ? 'border-indigo-500/40 bg-indigo-500/5' :
                isApproval ? 'border-amber-500/40 bg-amber-500/5' :
                se.status === 'completed' ? 'border-emerald-500/20 bg-slate-900/50' :
                se.status === 'failed' ? 'border-red-500/30 bg-red-500/5' :
                'border-slate-800 bg-slate-900/30'
              }`}>
                {/* Status icon */}
                <div className="flex-shrink-0 mt-0.5">
                  {isStepRunning && (
                    <div className="w-5 h-5 border-2 border-slate-700 border-t-indigo-400 rounded-full animate-spin" />
                  )}
                  {isApproval && (
                    <div className="w-5 h-5 rounded-full border-2 border-amber-400 flex items-center justify-center">
                      <span className="text-[8px] text-amber-400">⏳</span>
                    </div>
                  )}
                  {se.status === 'completed' && (
                    <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                      <span className="text-[10px] text-white font-bold">✓</span>
                    </div>
                  )}
                  {se.status === 'failed' && (
                    <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                      <span className="text-[10px] text-white font-bold">×</span>
                    </div>
                  )}
                  {se.status === 'pending' && (
                    <div className="w-5 h-5 rounded-full border-2 border-slate-700 flex items-center justify-center">
                      <span className="text-[8px] text-slate-600">{idx + 1}</span>
                    </div>
                  )}
                  {se.status === 'skipped' && (
                    <div className="w-5 h-5 rounded-full border-2 border-slate-700 flex items-center justify-center">
                      <span className="text-[8px] text-slate-500">—</span>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-medium ${
                      se.status === 'pending' ? 'text-slate-500' :
                      se.status === 'completed' ? 'text-slate-300' :
                      se.status === 'running' ? 'text-white' :
                      se.status === 'waiting_approval' ? 'text-amber-300' :
                      'text-white'
                    }`}>Step {idx + 1}</span>
                    {se.approvedBy && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Approved</span>
                    )}
                  </div>
                  {se.output && (
                    <p className="text-xs text-slate-400 mt-0.5">{se.output}</p>
                  )}
                  {se.error && (
                    <p className="text-xs text-red-400 mt-0.5">{se.error}</p>
                  )}
                  {se.subSteps && se.subSteps.length > 0 && (
                    <div className="mt-2 space-y-1 pl-3 border-l-2 border-teal-500/30">
                      {se.subSteps.map((ss, si) => (
                        <div key={si} className="flex items-center gap-2 text-[11px]">
                          <span className="text-slate-500">└─</span>
                          <span className={`${ss.status === 'completed' ? 'text-emerald-400' : ss.status === 'running' ? 'text-white' : ss.status === 'failed' ? 'text-red-400' : 'text-slate-500'}`}>
                            Step {si + 1}: {ss.title}
                          </span>
                          <span className="text-slate-600">→</span>
                          <span className={`text-[10px] ${ss.status === 'completed' ? 'text-emerald-400' : ss.status === 'running' ? 'text-teal-300' : ss.status === 'failed' ? 'text-red-400' : 'text-slate-600'}`}>
                            {ss.status === 'completed' ? '✓' : ss.status === 'running' ? 'running...' : ss.status === 'failed' ? '✗' : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {isApproval && (
                    <div className="mt-2">
                      <p className="text-xs text-amber-400 mb-1.5">This step requires manual approval to proceed.</p>
                      <button
                        onClick={() => onApprove(se.stepId)}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 transition-all"
                      >
                        Approve &amp; Continue
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            {run.status === 'completed'
              ? `✓ Playbook completed in ${elapsed}s — ${completedCount} steps completed${approvalCount > 0 ? `, ${approvalCount} required approval` : ''}`
              : `Elapsed: ${elapsed}s`}
          </div>
          <button
            onClick={onClose}
            disabled={isRunning || isWaiting}
            className="px-4 py-1.5 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-30"
          >
            {isRunning || isWaiting ? 'Running…' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
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

type StepType = 'action' | 'decision' | 'approval' | 'notification' | 'condition' | 'playbook'

interface PlaybookStep {
  id: string
  step: number
  title: string
  description: string
  type: StepType
  requires_approval: boolean
  condition?: string
  on_true?: string
  on_false?: string
  output_var?: string
  input_vars?: string[]
  timeout_seconds?: number
  on_failure?: 'stop' | 'skip' | 'escalate'
  assigned_to?: string
  retry_count?: number
  called_playbook_id?: string
  called_playbook_name?: string
  pass_context?: boolean
  await_completion?: boolean
}

const STEP_TYPES: { value: StepType; label: string; color: string }[] = [
  { value: 'action', label: 'Action', color: 'bg-indigo-500/15 text-indigo-400' },
  { value: 'decision', label: 'Decision', color: 'bg-amber-500/15 text-amber-400' },
  { value: 'approval', label: 'Approval', color: 'bg-red-500/15 text-red-400' },
  { value: 'notification', label: 'Notification', color: 'bg-blue-500/15 text-blue-400' },
  { value: 'condition', label: 'Condition', color: 'bg-purple-500/15 text-purple-400' },
  { value: 'playbook', label: 'Call Playbook', color: 'bg-teal-500/15 text-teal-400' },
]

function stepTypeCls(t: StepType) {
  return STEP_TYPES.find(s => s.value === t)?.color ?? 'bg-slate-700/50 text-slate-400'
}

function runStatusBadge(status: PlaybookRun['status']) {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-400'
  if (status === 'running') return 'bg-indigo-500/15 text-indigo-400'
  if (status === 'waiting_approval') return 'bg-amber-500/15 text-amber-400'
  if (status === 'failed') return 'bg-red-500/15 text-red-400'
  return 'bg-slate-700/50 text-slate-400'
}

function DetailPanel({
  playbook,
  digitalEmployees,
  playbooks,
  tenantId,
  accentColor,
  onClose,
  onUpdated,
  onRunPlaybook,
}: {
  playbook: DBPlaybook
  digitalEmployees: DBDigitalEmployee[]
  playbooks: DBPlaybook[]
  tenantId: string
  accentColor: string
  onClose: () => void
  onUpdated: (pb: DBPlaybook) => void
  onRunPlaybook: (pb: DBPlaybook) => void
}) {
  const [advancing, setAdvancing] = useState(false)
  const [detailTab, setDetailTab] = useState<'trigger' | 'overview' | 'steps' | 'runs' | 'lifecycle'>('overview')
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([])
  const [runs, setRuns] = useState<PlaybookRun[]>([])

  useEffect(() => {
    setConnectors(loadConnectors(tenantId))
  }, [tenantId])

  useEffect(() => {
    if (detailTab === 'runs') {
      const all = loadRuns(tenantId)
      setRuns(all.filter(r => r.playbookId === playbook.id).slice(0, 10))
    }
  }, [tenantId, playbook.id, detailTab])

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

  // Steps
  const initSteps = (): PlaybookStep[] => {
    if (!Array.isArray(playbook.decision_rules)) return []
    return playbook.decision_rules.filter((r: any) => r && r.step && r.title) as PlaybookStep[]
  }
  const [steps, setSteps] = useState<PlaybookStep[]>(initSteps)
  const [addingStep, setAddingStep] = useState(false)
  const [newStep, setNewStep] = useState({ title: '', description: '', type: 'action' as StepType, requires_approval: false, output_var: '', timeout_seconds: 0, on_failure: 'stop' as 'stop' | 'skip' | 'escalate', condition: '', on_true: '', on_false: '', assigned_to: '', retry_count: 0, called_playbook_id: '', called_playbook_name: '', pass_context: true, await_completion: true })
  const [savingSteps, setSavingSteps] = useState(false)
  const [versionNote, setVersionNote] = useState('')
  const [versionToast, setVersionToast] = useState('')
  const [showVersionNote, setShowVersionNote] = useState(false)

  const versionKey = `dt_pb_versions_${playbook.id}`
  type PBVersion = { version: number; savedAt: string; steps: PlaybookStep[]; trigger: any; note: string }
  const loadVersions = (): PBVersion[] => { try { return JSON.parse(localStorage.getItem(versionKey) || '[]') } catch { return [] } }
  const saveVersion = () => {
    const versions = loadVersions()
    const nextVer = (versions[0]?.version ?? 0) + 1
    versions.unshift({ version: nextVer, savedAt: new Date().toISOString(), steps, trigger: { type: triggerType, schedule: triggerSchedule, event: triggerEvent }, note: versionNote.trim() })
    localStorage.setItem(versionKey, JSON.stringify(versions.slice(0, 20)))
    setVersionToast(`Version ${nextVer} saved`)
    setTimeout(() => setVersionToast(''), 3000)
    setVersionNote('')
    setShowVersionNote(false)
  }

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
      ...(newStep.output_var.trim() ? { output_var: newStep.output_var.trim() } : {}),
      ...(newStep.timeout_seconds > 0 ? { timeout_seconds: newStep.timeout_seconds } : {}),
      ...(newStep.on_failure !== 'stop' ? { on_failure: newStep.on_failure } : {}),
      ...(newStep.type === 'decision' && newStep.condition.trim() ? { condition: newStep.condition.trim() } : {}),
      ...(newStep.type === 'decision' && newStep.on_true ? { on_true: newStep.on_true } : {}),
      ...(newStep.type === 'decision' && newStep.on_false ? { on_false: newStep.on_false } : {}),
      ...(newStep.type === 'approval' && newStep.assigned_to.trim() ? { assigned_to: newStep.assigned_to.trim() } : {}),
      ...(newStep.type === 'playbook' ? {
        called_playbook_id: newStep.called_playbook_id || undefined,
        called_playbook_name: newStep.called_playbook_name || undefined,
        pass_context: newStep.pass_context,
        await_completion: newStep.await_completion,
      } : {}),
    }
    const updated = [...steps, step]
    setSteps(updated)
    await saveSteps(updated)
    setNewStep({ title: '', description: '', type: 'action', requires_approval: false, output_var: '', timeout_seconds: 0, on_failure: 'stop', condition: '', on_true: '', on_false: '', assigned_to: '', retry_count: 0, called_playbook_id: '', called_playbook_name: '', pass_context: true, await_completion: true })
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
        <div className="flex gap-1 px-6 pt-4 pb-0 border-b border-slate-800 overflow-x-auto">
          {(['trigger', 'overview', 'steps', 'runs', 'lifecycle'] as const).map(t => (
            <button key={t} onClick={() => setDetailTab(t)}
              className={`px-3 py-2 text-xs font-medium capitalize border-b-2 transition-all whitespace-nowrap ${
                detailTab === t ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
              style={detailTab === t ? { borderColor: accentColor } : {}}>
              {t}{t === 'steps' && steps.length > 0 ? ` (${steps.length})` : ''}
              {t === 'runs' && runs.length > 0 ? ` (${runs.length})` : ''}
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
                    <button onClick={e => { e.stopPropagation(); onRunPlaybook(playbook) }}
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
                {playbook.connector_requirements && playbook.connector_requirements.length > 0 && (
                  <Row label="Connectors" value={
                    <div className="flex flex-wrap gap-1.5">
                      {playbook.connector_requirements.map(req => {
                        const found = connectors.find(c => c.type === req && c.status === 'connected')
                        return found
                          ? <span key={req} className="text-xs px-2 py-0.5 bg-emerald-500/15 text-emerald-400 rounded-full">✓ {found.name}</span>
                          : <span key={req} className="text-xs px-2 py-0.5 bg-amber-500/15 text-amber-400 rounded-full">⚠ {req} not connected</span>
                      })}
                    </div>
                  } />
                )}
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
              {/* Playbook Chain */}
              {steps.some(s => s.type === 'playbook') && (
                <div className="mb-5">
                  <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-3">Playbook Chain</p>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-5 h-5 rounded bg-indigo-500/20 text-indigo-300 text-xs flex items-center justify-center font-bold">▦</span>
                      <span className="text-sm font-medium text-white">{playbook.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ml-auto ${lifecycleBadgeClass(playbook.lifecycle_status)}`}>{playbook.lifecycle_status}</span>
                    </div>
                    <div className="space-y-2 pl-5 border-l border-slate-700">
                      {steps.filter(s => s.type === 'playbook').map(s => {
                        const calledPB = playbooks.find(p => p.id === s.called_playbook_id)
                        return (
                          <div key={s.id} className="flex items-center gap-2">
                            <span className="text-teal-500 text-xs">└─</span>
                            <span className="text-xs text-teal-300">▦</span>
                            <span className="text-xs text-slate-300 flex-1">{s.called_playbook_name || 'Unknown playbook'}</span>
                            {calledPB && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${lifecycleBadgeClass(calledPB.lifecycle_status)}`}>{calledPB.lifecycle_status}</span>
                            )}
                            <span className="text-[10px] text-slate-600">View →</span>
                          </div>
                        )
                      })}
                    </div>
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

              {/* Variables panel */}
              {steps.some(s => s.output_var) && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <p className="text-xs text-slate-500 mb-2">Available variables in this playbook:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {steps.filter(s => s.output_var).map(s => (
                      <button key={s.id}
                        onClick={() => navigator.clipboard.writeText(`{{${s.output_var}}}`)}
                        className="text-xs px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono hover:border-slate-500 transition-all"
                        title="Click to copy">
                        {`{{${s.output_var}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {steps.length === 0 && !addingStep && (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">No steps defined yet.</p>
                  <p className="text-slate-600 text-xs mt-1">Add steps to design the workflow this Playbook follows.</p>
                </div>
              )}
              {steps.map((s) => (
                <div key={s.id} className="flex gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
                    style={{ backgroundColor: accentColor + '60' }}>{s.step}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-white">{s.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize ${stepTypeCls(s.type)}`}>{s.type}</span>
                      {s.requires_approval && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">needs approval</span>}
                      {s.output_var && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400 font-mono">→ {s.output_var}</span>}
                      {s.condition && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400 font-mono">if: {s.condition.slice(0, 20)}</span>}
                      {s.timeout_seconds && s.timeout_seconds > 0 ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">⏱ {s.timeout_seconds}s</span> : null}
                      {s.on_failure && s.on_failure !== 'stop' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">fail: {s.on_failure}</span>}
                    </div>
                    {s.description && <p className="text-xs text-slate-400">{s.description}</p>}
                    {s.type === 'playbook' && s.called_playbook_id && (
                      <div className="mt-1.5 flex items-center gap-2 pl-2 border-l-2 border-teal-500/40">
                        <span className="text-teal-400 text-xs">→</span>
                        <span className="text-xs text-teal-300 font-medium">▦ {s.called_playbook_name || 'Unknown playbook'}</span>
                        {s.pass_context && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">passes context</span>}
                        {!s.await_completion && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400">fire &amp; continue</span>}
                        <span className="text-[10px] text-slate-600 ml-auto">View called playbook →</span>
                      </div>
                    )}
                    {(s as any).connector && (
                      <div className="mt-1.5 flex items-center gap-1.5 pl-2 border-l-2 border-violet-500/30">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 font-mono">
                          {(s as any).connector} → {(s as any).action}
                        </span>
                        <span className="text-[9px] text-slate-600">Connector Action</span>
                      </div>
                    )}
                  </div>
                  <button onClick={() => removeStep(s.id)} className="text-slate-700 hover:text-red-400 transition-all text-sm flex-shrink-0">×</button>
                </div>
              ))}

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
                  {/* New fields — all types */}
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Output variable</label>
                      <input className={inputCls} placeholder="e.g. invoice_amount" value={newStep.output_var} onChange={e => setNewStep(p => ({ ...p, output_var: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Timeout (seconds, 0=none)</label>
                      <input type="number" min={0} className={inputCls} value={newStep.timeout_seconds} onChange={e => setNewStep(p => ({ ...p, timeout_seconds: Number(e.target.value) }))} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">On failure</label>
                      <select className={inputCls} value={newStep.on_failure} onChange={e => setNewStep(p => ({ ...p, on_failure: e.target.value as any }))}>
                        <option value="stop">Stop playbook</option>
                        <option value="skip">Skip this step</option>
                        <option value="escalate">Escalate to handler</option>
                      </select>
                    </div>
                  </div>
                  {/* Decision type extra fields */}
                  {newStep.type === 'decision' && (
                    <div className="bg-slate-800 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-amber-400 font-medium">Decision branch</p>
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">Condition expression</label>
                        <input className={inputCls} placeholder='e.g. {{invoice_amount}} > 10000' value={newStep.condition} onChange={e => setNewStep(p => ({ ...p, condition: e.target.value }))} />
                        <p className="text-xs text-slate-600 mt-1">Use {`{{var_name}}`} to reference output from previous steps.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-slate-500 block mb-1">If true → go to</label>
                          <select className={inputCls} value={newStep.on_true} onChange={e => setNewStep(p => ({ ...p, on_true: e.target.value }))}>
                            <option value="">Next step</option>
                            {steps.map(s => <option key={s.id} value={s.id}>{s.step}. {s.title}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-slate-500 block mb-1">If false → go to</label>
                          <select className={inputCls} value={newStep.on_false} onChange={e => setNewStep(p => ({ ...p, on_false: e.target.value }))}>
                            <option value="">Next step</option>
                            <option value="stop">Stop playbook</option>
                            <option value="skip">Skip</option>
                            {steps.map(s => <option key={s.id} value={s.id}>{s.step}. {s.title}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Approval type extra fields */}
                  {newStep.type === 'approval' && (
                    <div className="bg-slate-800 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-red-400 font-medium">Approval settings</p>
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">Assign to (role or leave blank for any handler)</label>
                        <input className={inputCls} placeholder="e.g. Finance Manager" value={newStep.assigned_to} onChange={e => setNewStep(p => ({ ...p, assigned_to: e.target.value }))} />
                      </div>
                    </div>
                  )}
                  {/* Playbook type extra fields */}
                  {newStep.type === 'playbook' && (() => {
                    const otherPlaybooks = playbooks.filter(pb => pb.id !== playbook.id)
                    const selectedPB = otherPlaybooks.find(pb => pb.id === newStep.called_playbook_id)
                    // Circular reference check
                    const isCircular = selectedPB && Array.isArray(selectedPB.decision_rules) &&
                      (selectedPB.decision_rules as any[]).some((r: any) => r?.type === 'playbook' && r?.called_playbook_id === playbook.id)
                    return (
                      <div className="bg-slate-800 rounded-lg p-3 space-y-3">
                        <p className="text-xs text-teal-400 font-medium">Call Playbook settings</p>
                        <div>
                          <label className="text-xs text-slate-500 block mb-1">Select playbook to call</label>
                          <select className={inputCls} value={newStep.called_playbook_id}
                            onChange={e => {
                              const pb2 = otherPlaybooks.find(p => p.id === e.target.value)
                              setNewStep(p => ({
                                ...p,
                                called_playbook_id: e.target.value,
                                called_playbook_name: pb2?.name || '',
                                title: !p.title.trim() || p.title.startsWith('Call: ') ? (pb2 ? `Call: ${pb2.name}` : p.title) : p.title,
                              }))
                            }}>
                            <option value="">— Select a playbook —</option>
                            {otherPlaybooks.map(pb2 => (
                              <option key={pb2.id} value={pb2.id}>
                                {pb2.name} — {domainLabel(pb2.domain)} [{pb2.lifecycle_status}]
                              </option>
                            ))}
                          </select>
                        </div>
                        {isCircular && (
                          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                            ⚠ Circular reference detected — {selectedPB?.name} already calls this playbook.
                          </p>
                        )}
                        <label className="flex items-start gap-3 cursor-pointer">
                          <div onClick={() => setNewStep(p => ({ ...p, pass_context: !p.pass_context }))}
                            className={`w-9 h-5 rounded-full transition-all flex-shrink-0 mt-0.5 ${newStep.pass_context ? 'bg-teal-500' : 'bg-slate-700'}`}>
                            <div className={`w-4 h-4 bg-white rounded-full shadow mt-0.5 transition-all ${newStep.pass_context ? 'ml-4' : 'ml-0.5'}`} />
                          </div>
                          <div>
                            <span className="text-xs text-white">Pass current context</span>
                            <p className="text-[10px] text-slate-500">Share variables from this run with the called playbook</p>
                          </div>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer">
                          <div onClick={() => setNewStep(p => ({ ...p, await_completion: !p.await_completion }))}
                            className={`w-9 h-5 rounded-full transition-all flex-shrink-0 mt-0.5 ${newStep.await_completion ? 'bg-teal-500' : 'bg-slate-700'}`}>
                            <div className={`w-4 h-4 bg-white rounded-full shadow mt-0.5 transition-all ${newStep.await_completion ? 'ml-4' : 'ml-0.5'}`} />
                          </div>
                          <div>
                            <span className="text-xs text-white">Wait for completion</span>
                            <p className="text-[10px] text-slate-500">{newStep.await_completion ? 'Pause this playbook until the called playbook finishes' : 'Fire and continue — called playbook runs in background'}</p>
                          </div>
                        </label>
                      </div>
                    )
                  })()}
                  <div className="flex gap-2">
                    <button onClick={() => setAddingStep(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={addStep}
                      disabled={savingSteps || !newStep.title.trim() || (newStep.type === 'playbook' && (() => {
                        const otherPlaybooks = playbooks.filter(pb2 => pb2.id !== playbook.id)
                        const selectedPB = otherPlaybooks.find(pb2 => pb2.id === newStep.called_playbook_id)
                        return !!(selectedPB && Array.isArray(selectedPB.decision_rules) &&
                          (selectedPB.decision_rules as any[]).some((r: any) => r?.type === 'playbook' && r?.called_playbook_id === playbook.id))
                      })())}
                      className="px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 transition-all"
                      style={{ backgroundColor: accentColor }}>
                      {savingSteps ? 'Saving…' : 'Add Step'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {detailTab === 'runs' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 mb-3">Last 10 execution runs for this playbook.</p>
              {runs.length === 0 && (
                <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-slate-500 text-sm">No runs yet.</p>
                  <p className="text-slate-600 text-xs mt-1">Click ▶ Run to execute this playbook.</p>
                </div>
              )}
              {runs.map(run => {
                const elapsed = run.completedAt
                  ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                  : null
                const completed = run.steps.filter(s => s.status === 'completed').length
                const approvalCount = run.steps.filter(s => s.approvedBy).length
                return (
                  <div key={run.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${runStatusBadge(run.status)}`}>{run.status.replace(/_/g, ' ')}</span>
                        <span className="text-xs text-slate-500">{new Date(run.startedAt).toLocaleString()}</span>
                      </div>
                      {elapsed !== null && <span className="text-xs text-slate-500">{elapsed}s</span>}
                    </div>
                    <div className="text-xs text-slate-400">
                      {completed} of {run.steps.length} steps completed{approvalCount > 0 ? ` · ${approvalCount} approved` : ''}
                    </div>
                    <div className="mt-2 space-y-1">
                      {run.steps.filter(s => s.output || s.error).map((se, i) => (
                        <div key={se.stepId} className="text-[10px] text-slate-500 truncate">
                          Step {i + 1}: {se.output || se.error}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
              {/* Version History */}
              {(() => {
                const versions = loadVersions()
                if (versions.length === 0) return null
                return (
                  <div className="mt-6 pt-4 border-t border-slate-800">
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-3">Version History</p>
                    <div className="space-y-2">
                      {versions.slice(0, 5).map(v => (
                        <div key={v.version} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-white">v{v.version}</span>
                              <span className="text-xs text-slate-500">{new Date(v.savedAt).toLocaleString()}</span>
                              <span className="text-xs text-slate-600">{v.steps.length} steps</span>
                            </div>
                            {v.note && <p className="text-xs text-slate-400 mt-0.5">{v.note}</p>}
                          </div>
                          <button
                            onClick={() => {
                              if (confirm(`Restore v${v.version}? This will replace your current steps.`)) {
                                setSteps(v.steps)
                                saveSteps(v.steps)
                              }
                            }}
                            className="text-xs px-2.5 py-1 rounded border border-slate-700 text-slate-400 hover:border-indigo-500 hover:text-indigo-300 transition-all flex-shrink-0"
                          >
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
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
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-slate-600">Created {new Date(playbook.created_at).toLocaleDateString()}</div>
          <div className="flex gap-2 items-center flex-wrap">
            {versionToast && <span className="text-xs text-emerald-400">{versionToast}</span>}
            {showVersionNote && (
              <input
                value={versionNote}
                onChange={e => setVersionNote(e.target.value)}
                placeholder="Version note (optional)"
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white placeholder-slate-500 focus:outline-none w-40"
              />
            )}
            <button
              onClick={() => { if (!showVersionNote) { setShowVersionNote(true) } else { saveVersion() } }}
              className="px-3 py-1.5 rounded-lg text-xs border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white transition-all"
            >
              {showVersionNote ? 'Save' : '⎘ Save Version'}
            </button>
            {showVersionNote && (
              <button onClick={() => setShowVersionNote(false)} className="text-xs text-slate-600 hover:text-slate-400">Cancel</button>
            )}
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

  // Execution state
  const [currentRun, setCurrentRun] = useState<PlaybookRun | null>(null)
  const approvalResolverRef = useRef<(() => void) | null>(null)

  const load = useCallback(async () => {
    if (!tenantId) return
    setLoading(true)
    const [pbs, des, sum] = await Promise.all([
      fetchPlaybooks(tenantId),
      fetchDigitalEmployees(tenantId),
      fetchPlaybookSummary(tenantId),
    ])
    // Inject renewal template if not already present
    const hasRenewal = pbs.some(p => p.id === RENEWAL_PLAYBOOK_TEMPLATE.id || p.name === RENEWAL_PLAYBOOK_TEMPLATE.name)
    const mergedPbs = hasRenewal ? pbs : [{ ...RENEWAL_PLAYBOOK_TEMPLATE, tenant_id: tenantId }, ...pbs]
    setPlaybooks(mergedPbs)
    setDigitalEmployees(des)
    setSummary({ ...sum, total: sum.total + (hasRenewal ? 0 : 1), active: sum.active + (hasRenewal ? 0 : 1) })
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

  // ── Execution Engine ───────────────────────────────────────

  const executePlaybook = useCallback(async (
    playbook: DBPlaybook,
    triggeredBy: PlaybookRun['triggeredBy'],
    context?: Record<string, string>
  ): Promise<PlaybookRun> => {
    const steps: PlaybookStep[] = Array.isArray(playbook.decision_rules)
      ? (playbook.decision_rules as any[]).filter((r: any) => r && r.step && r.title) as PlaybookStep[]
      : []

    const conns = loadConnectors(tenantId)
    const connectedNamesForTypes = (types: string[]) =>
      types.flatMap(t => conns.filter(c => c.type === t && c.status === 'connected').map(c => c.name))

    const run: PlaybookRun = {
      id: crypto.randomUUID(),
      playbookId: playbook.id,
      playbookName: playbook.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: steps.map(s => ({ stepId: s.id, status: 'pending' as StepStatus })),
      triggeredBy,
      context,
    }

    const allRuns = loadRuns(tenantId)
    allRuns.unshift({ ...run })
    saveRuns(tenantId, allRuns)
    setCurrentRun({ ...run })

    const persistRun = (updated: PlaybookRun) => {
      const snap = { ...updated, steps: updated.steps.map(s => ({ ...s })) }
      setCurrentRun(snap)
      const stored = loadRuns(tenantId)
      const idx = stored.findIndex(r => r.id === snap.id)
      if (idx >= 0) stored[idx] = snap
      else stored.unshift(snap)
      saveRuns(tenantId, stored)
    }

    // Safe expression evaluator — no eval()
    const evalCondition = (expr: string, ctx: Record<string, unknown>): boolean => {
      try {
        let resolved = expr
        // Replace {{var}} with values from context
        resolved = resolved.replace(/\{\{(\w+)\}\}/g, (_, key) => {
          const val = ctx[key]
          return val !== undefined ? String(val) : '0'
        })
        // Whitelist: only allow safe tokens
        if (!/^[\d\s\w"'.<>=!&|()]+$/.test(resolved)) return false
        // Use Function constructor with allowlist — safer than eval
        // eslint-disable-next-line no-new-func
        return Boolean(new Function(`return (${resolved})`)())
      } catch {
        return false
      }
    }

    const simVal = (varName: string): unknown => {
      const n = varName.toLowerCase()
      if (n.includes('amount') || n.includes('value') || n.includes('total')) return Math.floor(Math.random() * 49000) + 1000
      if (n.includes('id')) return 'ID-' + Math.floor(Math.random() * 90000 + 10000)
      if (n.includes('email')) return 'customer@example.com'
      if (n.includes('status')) return 'active'
      return 'completed'
    }

    const runCtx: Record<string, unknown> = {}

    let i = 0
    while (i < steps.length) {
      const step = steps[i]

      run.steps[i] = { ...run.steps[i], status: 'running', startedAt: new Date().toISOString() }
      run.status = 'running'
      persistRun(run)

      // Timeout race
      const timeoutSecs = step.timeout_seconds ?? 0
      const makeStepPromise = async (): Promise<{ output: string; failed?: boolean; failMsg?: string; jumpTo?: string }> => {
        if (step.type === 'approval') {
          run.steps[i] = { ...run.steps[i], status: 'waiting_approval', output: step.assigned_to ? `Awaiting approval from: ${step.assigned_to}` : 'Awaiting approval from: Any handler' }
          run.status = 'waiting_approval'
          persistRun(run)
          await new Promise<void>(resolve => { approvalResolverRef.current = resolve })
          return { output: `Approved by operator${step.assigned_to ? ` (assigned to ${step.assigned_to})` : ''}` }
        }

        const connReqs = playbook.connector_requirements ?? []
        const connNames = connectedNamesForTypes(connReqs)

        if (step.type === 'action') {
          await new Promise(r => setTimeout(r, 800 + 300 * i))
          const mockOutput = (step as any).mock_output
          const connectorRef = (step as any).connector
          let out = connectorRef
            ? `Connector action: ${connectorRef} → ${(step as any).action ?? step.title}`
            : connNames.length >= 2
              ? `Action completed: Fetched records from ${connNames[0]} · Posted to ${connNames[1]}`
              : connNames.length === 1 ? `Action completed: Fetched records from ${connNames[0]}` : `Completed: ${step.title}`
          if (step.output_var) {
            if (mockOutput) {
              runCtx[step.output_var] = mockOutput
              out += ` · Output: ${JSON.stringify(mockOutput).slice(0, 80)}…`
            } else {
              const val = simVal(step.output_var)
              runCtx[step.output_var] = val
              out += ` · Output: {{${step.output_var}}} = ${typeof val === 'number' ? '$' + val.toLocaleString() : val}`
            }
          }
          return { output: out }
        }

        if (step.type === 'decision') {
          await new Promise(r => setTimeout(r, 600))
          if (step.condition) {
            const result = evalCondition(step.condition, runCtx)
            const condDisplay = step.condition.replace(/\{\{(\w+)\}\}/g, (_, k) => runCtx[k] !== undefined ? String(runCtx[k]) : `{{${k}}}`)
            const out = `Condition: ${condDisplay} → ${result ? 'TRUE' : 'FALSE'}`
            const jumpId = result ? step.on_true : step.on_false
            if (jumpId && jumpId !== 'stop' && jumpId !== 'skip') {
              return { output: out, jumpTo: jumpId }
            }
            if (jumpId === 'stop') return { output: out + ' — stopping playbook', failed: true, failMsg: 'Condition led to stop' }
            return { output: out }
          }
          return { output: 'Decision evaluated: proceeding with default path' }
        }

        if (step.type === 'notification') {
          await new Promise(r => setTimeout(r, 400))
          return { output: 'Notification sent' }
        }
        if (step.type === 'condition') {
          await new Promise(r => setTimeout(r, 500))
          return { output: 'Condition checked: true' }
        }
        if (step.type === 'playbook') {
          const calledPB = playbooks.find(p => p.id === step.called_playbook_id)
          if (!calledPB) {
            return { output: '', failed: true, failMsg: 'Called playbook not found' }
          }
          if (!step.await_completion) {
            await new Promise(r => setTimeout(r, 300))
            return { output: `Sub-playbook '${calledPB.name}' triggered in background — continuing` }
          }
          // Execute sub-steps inline
          const subSteps: PlaybookStep[] = Array.isArray(calledPB.decision_rules)
            ? (calledPB.decision_rules as any[]).filter((r: any) => r && r.step && r.title) as PlaybookStep[]
            : []
          const subStepState: { title: string; status: StepStatus }[] = subSteps.map(ss => ({ title: ss.title, status: 'pending' as StepStatus }))
          // Show initial sub-step state
          run.steps[i] = { ...run.steps[i], subSteps: [...subStepState] }
          persistRun(run)
          for (let si = 0; si < subSteps.length; si++) {
            subStepState[si] = { ...subStepState[si], status: 'running' }
            run.steps[i] = { ...run.steps[i], subSteps: [...subStepState] }
            persistRun(run)
            await new Promise(r => setTimeout(r, 300))
            subStepState[si] = { ...subStepState[si], status: 'completed' }
            run.steps[i] = { ...run.steps[i], subSteps: [...subStepState] }
            persistRun(run)
          }
          return { output: `Sub-playbook '${calledPB.name}' completed — ${subSteps.length} steps executed` }
        }

        await new Promise(r => setTimeout(r, 400))
        return { output: `Completed: ${step.title}` }
      }

      let result: { output: string; failed?: boolean; failMsg?: string; jumpTo?: string } = { output: '' }
      try {
        if (timeoutSecs > 0) {
          const timeoutPromise = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Step timed out after ${timeoutSecs}s`)), timeoutSecs * 1000))
          result = await Promise.race([makeStepPromise(), timeoutPromise])
        } else {
          result = await makeStepPromise()
        }
      } catch (err: any) {
        const failAction = step.on_failure || 'stop'
        run.steps[i] = { ...run.steps[i], status: 'failed', completedAt: new Date().toISOString(), error: err.message }
        persistRun(run)
        if (failAction === 'stop') { run.status = 'failed'; break }
        if (failAction === 'escalate') { run.status = 'waiting_approval'; persistRun(run); await new Promise<void>(r => { approvalResolverRef.current = r }) }
        // skip: just continue
        i++; continue
      }

      if (step.type === 'approval' && !result.failed) {
        run.steps[i] = { ...run.steps[i], status: 'completed', completedAt: new Date().toISOString(), approvedBy: 'Manual', output: result.output }
        run.status = 'running'
        persistRun(run)
      } else if (result.failed) {
        run.steps[i] = { ...run.steps[i], status: 'failed', completedAt: new Date().toISOString(), error: result.failMsg }
        run.status = 'failed'
        persistRun(run)
        break
      } else {
        run.steps[i] = { ...run.steps[i], status: 'completed', completedAt: new Date().toISOString(), output: result.output }
        persistRun(run)
      }

      // Jump to a specific step if decision said so
      if (result.jumpTo) {
        const jumpIdx = steps.findIndex(s => s.id === result.jumpTo)
        if (jumpIdx >= 0) { i = jumpIdx; continue }
      }

      i++
    }

    if (run.status !== 'failed') {
      run.status = 'completed'
    }
    run.completedAt = new Date().toISOString()
    persistRun(run)

    return run
  }, [tenantId, playbooks])

  const handleRunPlaybook = useCallback((pb: DBPlaybook) => {
    executePlaybook(pb, 'manual')
  }, [executePlaybook])

  const handleApprove = useCallback((_stepId: string) => {
    if (approvalResolverRef.current) {
      approvalResolverRef.current()
      approvalResolverRef.current = null
    }
  }, [])

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
        <StatCard label="Total Playbooks"     value={String(summary.total)}         icon="▦" color="blue" />
        <StatCard label="Active"              value={String(summary.active)}         icon="◈" color="emerald" />
        <StatCard label="Domains Covered"     value={String(summary.domains)}        icon="⊞" color="purple" />
        <StatCard label="Avg DE-Handled Rate" value={`${summary.avgHandledRate}%`}  icon="⚡" color="amber" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
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

                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-slate-500">{domainLabel(pb.domain)}</span>
                  <span className="text-slate-700">·</span>
                  <span className="text-xs text-slate-500 capitalize">{pb.trigger_type.replace(/_/g, ' ')}</span>
                </div>

                {pb.business_objective && (
                  <p className="text-xs text-slate-400 leading-relaxed mb-4 line-clamp-2">
                    {pb.business_objective}
                  </p>
                )}

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
                      onClick={e => { e.stopPropagation(); handleRunPlaybook(pb) }}
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
          playbooks={playbooks}
          tenantId={tenantId}
          accentColor={accentColor}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
          onRunPlaybook={handleRunPlaybook}
        />
      )}

      {/* Run Modal */}
      {currentRun && (
        <RunModal
          run={currentRun}
          onApprove={handleApprove}
          onClose={() => setCurrentRun(null)}
          accentColor={accentColor}
        />
      )}
    </div>
  )
}
