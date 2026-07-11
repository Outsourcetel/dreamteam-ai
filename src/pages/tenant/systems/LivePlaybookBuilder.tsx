import React, { useState, useEffect, useMemo } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import { CustomerApiError, listAccounts } from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import { listPlaybookRuns, RENEWAL_STEP_DEFS } from '../../../lib/playbookApi';
import { listPublishedVersions } from '../../../lib/onboardingApi';
import type { TemplateVersion } from '../../../lib/onboardingApi';
import type { PlaybookRun, RunStep } from '../../../lib/playbookApi';
import {
  PRIMITIVE_REGISTRY, TEMPLATE_VARS, UPDATE_WHITELIST, DECISION_OPERATORS, BRANCH_PRIMITIVES,
  validateStepsClient, listDefinitions, createDefinition, updateDefinition,
  publishDefinition, startDefinitionRun, previewRun, uploadPlaybookMedia, getPlaybookMediaUrlByAssetId,
  DISPATCH_MODE, WEEKDAYS, EVENT_META, describeSchedule, describeEventRule,
  listSchedules, createSchedule, setScheduleActive, deleteSchedule,
  listEventRules, createEventRule, setEventRuleActive, deleteEventRule,
  listTriggerFires, dispatchTriggersOpportunistic,
} from '../../../lib/playbookBuilderApi';
import type {
  PlaybookDefinition, DefinitionStep, PrimitiveKey, ValidationError, StepMedia,
  PlaybookSchedule, PlaybookEventRule, PlaybookTriggerFire, ScheduleCadence, EventKey,
  PreviewResult, PreviewRunStep,
} from '../../../lib/playbookBuilderApi';
import { LiveLoadingSkeleton, MissingTablesNotice } from '../../../components/LiveDataStates';

// ============================================================
// R6 — LIVE Playbooks: tenant playbook builder.
// Definitions are composed from typed step primitives, validated
// live (client mirror) and again server-side on publish. Publishing
// snapshots an immutable version; runs execute the snapshot on the
// server (playbook-execute). Legacy renewal_v1 stays available.
// ============================================================

const statusChip = (status: string) => {
  const map: Record<string, string> = {
    draft: 'bg-amber-500/15 text-amber-300',
    published: 'bg-emerald-500/15 text-emerald-300',
    archived: 'bg-slate-700 text-slate-400',
    completed: 'bg-emerald-500/15 text-emerald-300',
    waiting_approval: 'bg-amber-500/15 text-amber-300',
    resume_pending: 'bg-indigo-500/15 text-indigo-300',
    running: 'bg-indigo-500/15 text-indigo-300',
    cancelled: 'bg-red-500/15 text-red-300',
    failed: 'bg-red-500/15 text-red-300',
  };
  const label = status === 'waiting_approval' ? 'waiting on human' : status === 'resume_pending' ? 'resuming' : status;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${map[status] ?? 'bg-slate-800 text-slate-400'}`}>{label}</span>;
};

const stepIcon = (s: RunStep) =>
  s.status === 'done' ? '✓' : s.status === 'waiting' ? '⏸' : s.status === 'skipped' ? '↷'
  : s.status === 'failed' ? '✗' : s.status === 'cancelled' ? '✗' : '·';

const stepColor = (s: RunStep) =>
  s.status === 'done' ? 'text-emerald-400' : s.status === 'waiting' ? 'text-amber-400'
  : s.status === 'skipped' ? 'text-slate-500' : s.status === 'failed' || s.status === 'cancelled' ? 'text-red-400' : 'text-slate-600';

function RunTimeline({ run }: { run: PlaybookRun }) {
  return (
    <div className="space-y-1.5">
      {run.steps.map((s, i) => (
        <div key={i} className={`flex items-start gap-2 text-xs rounded-lg px-2 py-1.5 ${s.key === 'human_approval' ? 'bg-amber-500/5' : ''}`}>
          <span className={`flex-shrink-0 ${stepColor(s)}`}>{stepIcon(s)}</span>
          <span className={`flex-shrink-0 w-5 text-slate-600`}>{i + 1}.</span>
          <div className="min-w-0">
            <span className={s.status === 'pending' ? 'text-slate-600' : 'text-slate-300'}>
              {s.label}{s.key === 'human_approval' ? ' 🤝' : ''}
            </span>
            {s.detail && <p className="text-[11px] text-slate-500 mt-0.5 break-words">{s.detail}</p>}
          </div>
          {s.at && <span className="ml-auto text-[10px] text-slate-600 whitespace-nowrap">{new Date(s.at).toLocaleTimeString()}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Step param editor per primitive ───────────────────────────────

const inputCls = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-500';
const selectCls = inputCls;

function StepParamsEditor({ step, onChange }: { step: DefinitionStep; onChange: (params: Record<string, unknown>) => void }) {
  const p = step.params ?? {};
  const set = (k: string, v: unknown) => onChange({ ...p, [k]: v });
  switch (step.key) {
    case 'generate_invoice':
      return (
        <div className="flex gap-2 items-center flex-wrap">
          <select className={selectCls + ' !w-44'} value={String(p.amount_source ?? 'account_arr')} onChange={e => set('amount_source', e.target.value)}>
            <option value="account_arr">Amount = account ARR</option>
            <option value="fixed">Fixed amount</option>
          </select>
          {p.amount_source === 'fixed' && (
            <input className={inputCls + ' !w-36'} type="number" min={1} placeholder="Amount in $"
              value={typeof p.fixed_amount_cents === 'number' ? p.fixed_amount_cents / 100 : ''}
              onChange={e => set('fixed_amount_cents', Math.round(Number(e.target.value) * 100))} />
          )}
        </div>
      );
    case 'human_approval':
      return (
        <input className={inputCls} placeholder="Task title template" value={String(p.title_template ?? '')}
          onChange={e => set('title_template', e.target.value)} />
      );
    case 'connector_action':
      return (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            <select className={selectCls + ' !w-32'} value={String(p.provider ?? 'zendesk')} onChange={e => set('provider', e.target.value)}>
              <option value="zendesk">Zendesk</option>
            </select>
            <select className={selectCls + ' !w-44'} value={String(p.op ?? 'add_internal_note')} onChange={e => set('op', e.target.value)}>
              <option value="add_internal_note">Add internal note</option>
              <option value="update_status">Update status</option>
            </select>
            <input className={inputCls + ' !w-44'} placeholder="Ticket ref template (optional)"
              value={String(p.external_ref_template ?? '')} onChange={e => set('external_ref_template', e.target.value)} />
          </div>
          <input className={inputCls} placeholder="Payload template" value={String(p.payload_template ?? '')}
            onChange={e => set('payload_template', e.target.value)} />
          <p className="text-[10px] text-slate-600">No connected connector or empty ticket ref → step records as skipped and the run continues (honest degradation).</p>
        </div>
      );
    case 'update_record': {
      const table = String(p.table ?? 'renewal_invoices');
      const allowed = UPDATE_WHITELIST[table] ?? [];
      const status = String((p.set as Record<string, unknown> | undefined)?.status ?? allowed[0] ?? '');
      return (
        <div className="flex gap-2 flex-wrap">
          <select className={selectCls + ' !w-44'} value={table}
            onChange={e => onChange({ table: e.target.value, set: { status: UPDATE_WHITELIST[e.target.value][0] } })}>
            <option value="renewal_invoices">renewal_invoices</option>
            <option value="support_tickets">support_tickets</option>
          </select>
          <select className={selectCls + ' !w-36'} value={status} onChange={e => onChange({ table, set: { status: e.target.value } })}>
            {allowed.map(v => <option key={v} value={v}>status → {v}</option>)}
          </select>
        </div>
      );
    }
    case 'log_activity':
      return (
        <input className={inputCls} placeholder="Activity message template" value={String(p.text_template ?? '')}
          onChange={e => set('text_template', e.target.value)} />
      );
    case 'consult_specialist':
      return (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            <select className={selectCls + ' !w-48'} value={String(p.profile_key ?? 'technical')} onChange={e => set('profile_key', e.target.value)}>
              <option value="auto">Auto — the employee's own specialist</option>
              <option value="technical">Technical</option>
              <option value="legal">Legal</option>
              <option value="finance">Finance</option>
              <option value="people">People</option>
            </select>
            <input className={inputCls + ' !w-32'} type="number" min={0} max={100} placeholder="Min confidence"
              value={typeof p.min_confidence === 'number' ? p.min_confidence : 60}
              onChange={e => set('min_confidence', Math.max(0, Math.min(100, Number(e.target.value))))} />
            <select className={selectCls + ' !w-44'} value={String(p.on_low ?? 'escalate')} onChange={e => set('on_low', e.target.value)}>
              <option value="escalate">Below floor → escalate</option>
              <option value="continue">Below floor → continue</option>
            </select>
          </div>
          <input className={inputCls} placeholder="Question template" value={String(p.question_template ?? '')}
            onChange={e => set('question_template', e.target.value)} />
          <p className="text-[10px] text-slate-600">Missing/paused profile or dormant specialist brain → step records as skipped (honest degradation); escalation still fires when chosen.</p>
        </div>
      );
    case 'agentic_step':
      return (
        <div className="space-y-2">
          <textarea className={inputCls + ' min-h-[60px] resize-y'} placeholder="Goal — what should this step accomplish? (templates supported, e.g. {{account.name}})"
            value={String(p.goal_template ?? '')} onChange={e => set('goal_template', e.target.value)} />
          <p className="text-[10px] text-slate-600">The DE decides how to reach this goal using whatever tools it's been granted — it doesn't follow a fixed script. Every action still passes through the same access grants, guardrails, and trust dial as a Connector action step. Dormant reasoning brain → step records as skipped (honest degradation), same as Consult specialist.</p>
        </div>
      );
    case 'guardrail_check':
      return <p className="text-[11px] text-slate-500">Re-checks the invoice approval threshold and records the result in the audit chain.</p>;
    case 'checklist':
      return <ChecklistEditor step={step} onChange={onChange} />;
    case 'wait':
      return <WaitEditor step={step} onChange={onChange} />;
    case 'start_onboarding':
      return <StartOnboardingEditor step={step} onChange={onChange} />;
    default:
      return null;
  }
}

// ── Start onboarding editor: pick a published template version ────

function StartOnboardingEditor({ step, onChange }: { step: DefinitionStep; onChange: (params: Record<string, unknown>) => void }) {
  const p = step.params ?? {};
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    listPublishedVersions().then(setVersions).finally(() => setLoading(false));
  }, []);
  return (
    <div className="space-y-1.5">
      <select className={selectCls + ' !w-64'} value={String(p.template_version_id ?? '')}
        onChange={e => onChange({ ...p, template_version_id: e.target.value })} disabled={loading}>
        <option value="">{loading ? 'Loading template versions…' : 'Pick a published onboarding template…'}</option>
        {versions.map(v => <option key={v.id} value={v.id}>{v.name} · v{v.version}</option>)}
      </select>
      <input className={inputCls} placeholder="Project name override (optional — defaults to account + template name)"
        value={String(p.name ?? '')} onChange={e => onChange({ ...p, name: e.target.value })} />
      {!loading && versions.length === 0 && (
        <p className="text-[10px] text-amber-500">No published onboarding templates yet — publish one first (Onboarding → Templates).</p>
      )}
      <p className="text-[10px] text-slate-600">Creates a real onboarding project for this run's account. A deleted/unpublished template version or no account in context → step records as skipped, run continues.</p>
    </div>
  );
}

// ── Instruction step editor: title, markdown body, media upload ────

function InstructionEditor({ step, definitionId, onChange }: {
  step: DefinitionStep; definitionId: string | null; onChange: (params: Record<string, unknown>) => void;
}) {
  const p = step.params ?? {};
  const media = Array.isArray(p.media) ? (p.media as StepMedia[]) : [];
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const set = (k: string, v: unknown) => onChange({ ...p, [k]: v });

  const handleUpload = async (file: File) => {
    if (!definitionId) { setUploadErr('Save this playbook as a draft first, then attach media.'); return; }
    setUploading(true); setUploadErr(null);
    try {
      const kind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
      const asset = await uploadPlaybookMedia(file, definitionId);
      set('media', [...media, { asset_id: asset.id, kind, caption: file.name }]);
    } catch (err) { setUploadErr((err as Error).message); }
    finally { setUploading(false); }
  };

  return (
    <div className="space-y-2">
      <input className={inputCls} placeholder="Title (e.g. Before you continue)" value={String(p.title ?? '')}
        onChange={e => set('title', e.target.value)} />
      <textarea className={inputCls + ' min-h-[80px] resize-y'} placeholder="Body — markdown supported (headings, lists, **bold**, links)"
        value={String(p.body_md ?? '')} onChange={e => set('body_md', e.target.value)} />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] px-2 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 cursor-pointer transition-colors">
          {uploading ? 'Uploading…' : '+ Add image or video'}
          <input type="file" accept="image/*,video/*" className="hidden" disabled={uploading}
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ''; }} />
        </label>
        {media.map((m, i) => (
          <span key={i} className="text-[11px] px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1.5">
            {m.kind === 'video' ? '🎬' : '🖼️'} {m.caption || m.asset_id?.slice(0, 8) || 'media'}
            <button onClick={() => set('media', media.filter((_, k) => k !== i))} className="text-slate-600 hover:text-rose-400">✕</button>
          </span>
        ))}
      </div>
      {uploadErr && <p className="text-[11px] text-rose-400">✗ {uploadErr}</p>}
      <p className="text-[10px] text-slate-600">Presented to whoever reads or runs this playbook. Feeds later "Consult specialist" steps as context — dormant until the specialist brain (API key) is activated.</p>
    </div>
  );
}

// ── Checklist editor: list of items ─────────────────────────────────

function ChecklistEditor({ step, onChange }: { step: DefinitionStep; onChange: (params: Record<string, unknown>) => void }) {
  const p = step.params ?? {};
  const items = Array.isArray(p.items) ? (p.items as string[]) : [''];
  const set = (next: string[]) => onChange({ ...p, items: next });
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className={inputCls} placeholder={`Item ${i + 1}`} value={it}
            onChange={e => set(items.map((v, k) => k === i ? e.target.value : v))} />
          <button onClick={() => set(items.filter((_, k) => k !== i))} disabled={items.length <= 1}
            className="text-xs text-slate-600 hover:text-rose-400 disabled:opacity-30">✕</button>
        </div>
      ))}
      <button onClick={() => set([...items, ''])} className="text-[11px] text-indigo-400 hover:text-indigo-300">+ Add item</button>
      <p className="text-[10px] text-slate-600">Creates a Human Task — the run pauses until every item is ticked.</p>
    </div>
  );
}

// ── Wait editor ──────────────────────────────────────────────────────

function WaitEditor({ step, onChange }: { step: DefinitionStep; onChange: (params: Record<string, unknown>) => void }) {
  const p = step.params ?? {};
  return (
    <div className="flex items-center gap-2">
      <input className={inputCls + ' !w-24'} type="number" min={1} value={typeof p.duration_minutes === 'number' ? p.duration_minutes : 60}
        onChange={e => onChange({ ...p, duration_minutes: Math.max(1, Number(e.target.value) || 1) })} />
      <span className="text-xs text-slate-500">minutes, then continue automatically (checked every 5 minutes).</span>
    </div>
  );
}

// ── Sub-playbook editor ──────────────────────────────────────────────

function SubPlaybookEditor({ step, publishedDefs, onChange }: {
  step: DefinitionStep; publishedDefs: PlaybookDefinition[]; onChange: (params: Record<string, unknown>) => void;
}) {
  const p = step.params ?? {};
  return (
    <div className="space-y-1.5">
      <select className={selectCls + ' !w-64'} value={String(p.playbook_id ?? '')} onChange={e => onChange({ ...p, playbook_id: e.target.value })}>
        <option value="">Pick a published playbook…</option>
        {publishedDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <p className="text-[10px] text-slate-600">Runs as a child of this playbook — inherits this playbook's DE access (never more). Only published playbooks can be picked; no cycles allowed.</p>
    </div>
  );
}

// ── Decision editor: condition + indented then/else branches ───────

function DecisionEditor({ step, stepIndex, allSteps, onChange }: {
  step: DefinitionStep; stepIndex: number; allSteps: DefinitionStep[];
  onChange: (params: Record<string, unknown>, thenSteps: DefinitionStep[], elseSteps: DefinitionStep[]) => void;
}) {
  const p = step.params ?? {};
  const thenSteps = step.then_steps ?? [];
  const elseSteps = step.else_steps ?? [];
  const priorSteps = allSteps.slice(0, stepIndex).filter(s => s.key !== 'decision' || true);

  const setCond = (patch: Record<string, unknown>) => onChange({ ...p, ...patch }, thenSteps, elseSteps);

  const branchAdd = (side: 'then' | 'else', key: PrimitiveKey) => {
    const meta = PRIMITIVE_REGISTRY.find(m => m.key === key)!;
    const newStep: DefinitionStep = { key, params: JSON.parse(JSON.stringify(meta.defaultParams)) };
    if (side === 'then') onChange(p, [...thenSteps, newStep], elseSteps);
    else onChange(p, thenSteps, [...elseSteps, newStep]);
  };
  const branchRemove = (side: 'then' | 'else', i: number) => {
    if (side === 'then') onChange(p, thenSteps.filter((_, k) => k !== i), elseSteps);
    else onChange(p, thenSteps, elseSteps.filter((_, k) => k !== i));
  };
  const branchUpdate = (side: 'then' | 'else', i: number, params: Record<string, unknown>) => {
    if (side === 'then') onChange(p, thenSteps.map((s, k) => k === i ? { ...s, params } : s), elseSteps);
    else onChange(p, thenSteps, elseSteps.map((s, k) => k === i ? { ...s, params } : s));
  };

  const branchList = (side: 'then' | 'else', steps: DefinitionStep[]) => (
    <div className="pl-4 border-l-2 border-slate-700 space-y-1.5 mt-1.5">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{side === 'then' ? 'Then' : 'Else'}</p>
      {steps.map((bs, i) => {
        const meta = PRIMITIVE_REGISTRY.find(m => m.key === bs.key);
        return (
          <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs text-slate-300">{meta?.label ?? bs.key}</span>
              <button onClick={() => branchRemove(side, i)} className="text-xs text-slate-600 hover:text-rose-400">✕</button>
            </div>
            <StepParamsEditor step={bs} onChange={params => branchUpdate(side, i, params)} />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        {BRANCH_PRIMITIVES.map(k => (
          <button key={k} onClick={() => branchAdd(side, k)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 hover:text-slate-200 hover:border-slate-500 transition-colors">
            + {PRIMITIVE_REGISTRY.find(m => m.key === k)?.label ?? k}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap items-center">
        <select className={selectCls + ' !w-56'} value={String(p.on ?? '')} onChange={e => setCond({ on: e.target.value })}>
          <option value="">Look at step…</option>
          {priorSteps.map((s, i) => (
            <option key={i} value={`step:${i}`}>{i + 1}. {PRIMITIVE_REGISTRY.find(m => m.key === s.key)?.label ?? s.key}</option>
          ))}
        </select>
        <select className={selectCls + ' !w-52'} value={String(p.operator ?? 'exists')} onChange={e => setCond({ operator: e.target.value })}>
          {DECISION_OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {p.operator !== 'exists' && (
          <input className={inputCls + ' !w-40'} placeholder="value" value={String(p.value ?? '')} onChange={e => setCond({ value: e.target.value })} />
        )}
      </div>
      {branchList('then', thenSteps)}
      {branchList('else', elseSteps)}
      <p className="text-[10px] text-slate-600">Decisions can only look at EARLIER steps. One level of branch nesting.</p>
    </div>
  );
}

function TemplateHelp() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button onClick={() => setOpen(o => !o)} className="text-[11px] text-indigo-400 hover:text-indigo-300">
        {'{{ templates }}'} ▾
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 w-72 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <p className="text-[11px] font-medium text-slate-300 mb-2">Available template variables</p>
          {TEMPLATE_VARS.map(v => (
            <div key={v.token} className="flex gap-2 text-[11px] mb-1">
              <code className="text-indigo-300 whitespace-nowrap">{v.token}</code>
              <span className="text-slate-500">{v.meaning}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// ── Builder (create / edit a definition) ──────────────────────────

interface BuilderState {
  id: string | null;          // null = new
  name: string;
  key: string;
  description: string;
  steps: DefinitionStep[];
  status: 'draft' | 'published' | 'archived';
}

const NEW_TEMPLATE: DefinitionStep[] = [
  { key: 'check_account', params: {} },
  { key: 'generate_invoice', params: { amount_source: 'account_arr' } },
  { key: 'human_approval', params: { title_template: 'Playbook approval — {{account.name}}', task_type: 'approval_gate' } },
  { key: 'log_activity', params: { text_template: 'Playbook completed for {{account.name}} — invoice {{invoice.amount}}' } },
  { key: 'complete', params: {} },
];

// ── "Document that executes" read view — the demo money-shot. Renders
// like an SOP: numbered steps, rich instruction blocks with embedded
// media, decision branches indented, executable steps as action chips.

function MediaThumb({ m }: { m: StepMedia }) {
  const [url, setUrl] = useState<string | null>(m.url ?? null);
  useEffect(() => {
    if (m.url || !m.asset_id) return;
    void getPlaybookMediaUrlByAssetId(m.asset_id).then(setUrl).catch(() => undefined);
  }, [m.asset_id, m.url]);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 inline-block">
      {m.kind === 'video' ? (
        url ? <video src={url} controls className="max-h-40 rounded" /> : <span className="text-[11px] text-slate-500">🎬 {m.caption || 'video'}</span>
      ) : (
        url ? <img src={url} alt={m.caption || ''} className="max-h-40 rounded" /> : <span className="text-[11px] text-slate-500">🖼️ {m.caption || 'image'}</span>
      )}
      {m.caption && <p className="text-[10px] text-slate-600 mt-1">{m.caption}</p>}
    </div>
  );
}

function DocStepRow({ s, index, publishedDefs, depth = 0 }: {
  s: DefinitionStep; index: number | null; publishedDefs: PlaybookDefinition[]; depth?: number;
}) {
  const meta = PRIMITIVE_REGISTRY.find(m => m.key === s.key);
  const gate = s.key === 'human_approval' || s.key === 'checklist';
  const p = s.params ?? {};

  if (s.key === 'instruction') {
    const media = Array.isArray(p.media) ? (p.media as StepMedia[]) : [];
    return (
      <div style={{ marginLeft: depth * 20 }} className="rounded-xl border border-sky-800/30 bg-sky-500/5 p-3 mb-1.5">
        <div className="flex items-center gap-2 mb-1">
          {index !== null && <span className="w-6 h-6 rounded-lg bg-sky-500/20 text-sky-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0">{index + 1}</span>}
          <span className="text-sm font-medium text-white">{String(p.title ?? 'Instruction')}</span>
        </div>
        {p.body_md ? <p className="text-xs text-slate-300 whitespace-pre-wrap ml-8">{String(p.body_md)}</p> : null}
        {media.length > 0 && <div className="ml-8 mt-2 flex flex-wrap gap-2">{media.map((m, i) => <MediaThumb key={i} m={m} />)}</div>}
      </div>
    );
  }

  if (s.key === 'decision') {
    const then = s.then_steps ?? [];
    const els = s.else_steps ?? [];
    return (
      <div style={{ marginLeft: depth * 20 }} className="mb-1.5">
        <div className="flex items-center gap-2 rounded-xl border border-violet-800/30 bg-violet-500/5 px-3 py-2">
          {index !== null && <span className="w-6 h-6 rounded-lg bg-violet-500/20 text-violet-300 flex items-center justify-center text-[11px] font-bold flex-shrink-0">{index + 1}</span>}
          <span className="text-sm text-white">If <code className="text-violet-300">{String(p.on ?? '?')}</code> {DECISION_OPERATORS.find(o => o.value === p.operator)?.label ?? String(p.operator ?? '')} {p.operator !== 'exists' ? <code className="text-violet-300">{String(p.value ?? '')}</code> : null}</span>
        </div>
        <div className="ml-8 mt-1">
          <p className="text-[10px] uppercase tracking-wider text-slate-600 mt-1">Then</p>
          {then.length === 0 ? <p className="text-[11px] text-slate-600 ml-2">(nothing)</p> : then.map((bs, i) => <DocStepRow key={i} s={bs} index={null} publishedDefs={publishedDefs} depth={depth + 1} />)}
          <p className="text-[10px] uppercase tracking-wider text-slate-600 mt-2">Else</p>
          {els.length === 0 ? <p className="text-[11px] text-slate-600 ml-2">(nothing)</p> : els.map((bs, i) => <DocStepRow key={i} s={bs} index={null} publishedDefs={publishedDefs} depth={depth + 1} />)}
        </div>
      </div>
    );
  }

  // Everything else — a numbered "document" row with an action chip.
  return (
    <div style={{ marginLeft: depth * 20 }} className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 mb-1 ${gate ? 'bg-amber-500/5 border border-amber-500/20' : 'border border-slate-800/60'}`}>
      {index !== null && <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${gate ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>{index + 1}</span>}
      <span className="text-slate-300">{meta?.label ?? s.key}{gate ? ' 🤝' : ''}</span>
      {s.key === 'connector_action' && <span className="text-[10px] text-slate-600">{String(p.category ?? p.provider ?? '')} · {String(p.op ?? '')}</span>}
      {s.key === 'log_activity' && <span className="text-[10px] text-slate-600 truncate">{String(p.text_template ?? '')}</span>}
      {s.key === 'checklist' && <span className="text-[10px] text-slate-600">{Array.isArray(p.items) ? (p.items as string[]).length : 0} item(s)</span>}
      {s.key === 'wait' && <span className="text-[10px] text-slate-600">{String(p.duration_minutes ?? 0)} min</span>}
      {s.key === 'sub_playbook' && <span className="text-[10px] text-slate-600">→ {publishedDefs.find(d => d.id === p.playbook_id)?.name ?? 'unknown playbook'}</span>}
    </div>
  );
}

function PlaybookDocumentView({ steps, publishedDefs }: { steps: DefinitionStep[]; publishedDefs: PlaybookDefinition[] }) {
  return (
    <div className="space-y-1 mb-4">
      {steps.map((s, i) => <DocStepRow key={i} s={s} index={i} publishedDefs={publishedDefs} />)}
    </div>
  );
}

function Builder({ initial, onDone, onCancel, publishedDefs, accounts }: {
  initial: BuilderState;
  onDone: (published: boolean) => void;
  onCancel: () => void;
  publishedDefs: PlaybookDefinition[];
  accounts: CustomerAccount[];
}) {
  const [st, setSt] = useState<BuilderState>(initial);
  const [serverErrors, setServerErrors] = useState<ValidationError[]>([]);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientErrors = useMemo(() => validateStepsClient(st.steps), [st.steps]);
  const errsFor = (i: number) => [...clientErrors, ...serverErrors].filter(e => e.index === i);
  const globalErrs = [...clientErrors, ...serverErrors].filter(e => e.index === -1);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= st.steps.length) return;
    const steps = [...st.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setSt({ ...st, steps });
  };
  const remove = (i: number) => setSt({ ...st, steps: st.steps.filter((_, k) => k !== i) });
  const addStep = (key: PrimitiveKey) => {
    const meta = PRIMITIVE_REGISTRY.find(m => m.key === key)!;
    const steps = [...st.steps];
    // insert before the trailing complete step when present
    const idx = steps.length > 0 && steps[steps.length - 1].key === 'complete' ? steps.length - 1 : steps.length;
    steps.splice(idx, 0, { key, params: JSON.parse(JSON.stringify(meta.defaultParams)) });
    setSt({ ...st, steps });
  };

  const persist = async (): Promise<string | null> => {
    if (!st.name.trim() || !st.key.trim()) { setError('Name and key are required.'); return null; }
    if (st.id) {
      await updateDefinition(st.id, { name: st.name.trim(), description: st.description, steps: st.steps });
      return st.id;
    }
    const def = await createDefinition({
      key: st.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
      name: st.name.trim(), description: st.description, steps: st.steps,
    });
    setSt(s => ({ ...s, id: def.id }));
    return def.id;
  };

  const saveDraft = async () => {
    setBusy('save'); setError(null);
    try { if (await persist()) onDone(false); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (clientErrors.length > 0) return;
    setBusy('publish'); setError(null); setServerErrors([]);
    try {
      const id = await persist();
      if (!id) return;
      const res = await publishDefinition(id);
      if (res.published) onDone(true);
      else if (res.errors) setServerErrors(res.errors);
      else setError(res.error ?? 'Publish failed.');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h3 className="text-sm font-semibold text-white">{st.id ? `Edit — ${st.name}` : 'New playbook'}</h3>
        <TemplateHelp />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mb-3">
        <input className={inputCls} placeholder="Playbook name" value={st.name} onChange={e => setSt({ ...st, name: e.target.value })} />
        <input className={inputCls + (st.id ? ' opacity-60' : '')} placeholder="key (slug, e.g. renewal_followup)" disabled={!!st.id}
          value={st.key} onChange={e => setSt({ ...st, key: e.target.value })} />
      </div>
      <input className={inputCls + ' mb-4'} placeholder="Description" value={st.description} onChange={e => setSt({ ...st, description: e.target.value })} />

      {/* Step list */}
      <div className="space-y-2 mb-3">
        {st.steps.map((s, i) => {
          const meta = PRIMITIVE_REGISTRY.find(m => m.key === s.key);
          const errs = errsFor(i);
          const isGate = s.key === 'human_approval';
          return (
            <div key={i} className={`rounded-xl border p-3 ${isGate ? 'border-amber-500/30 bg-amber-500/5' : errs.length ? 'border-rose-700/50 bg-rose-500/5' : 'border-slate-800 bg-slate-900'}`}>
              <div className="flex items-start gap-3">
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${isGate ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-medium text-white">{meta?.label ?? s.key}</span>
                    {isGate && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-700/30">Human Gate</span>}
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2">{meta?.description}</p>
                  {s.key === 'instruction' ? (
                    <InstructionEditor step={s} definitionId={st.id} onChange={params => {
                      const steps = [...st.steps]; steps[i] = { ...s, params }; setSt({ ...st, steps });
                    }} />
                  ) : s.key === 'sub_playbook' ? (
                    <SubPlaybookEditor step={s} publishedDefs={publishedDefs.filter(d => d.id !== st.id)} onChange={params => {
                      const steps = [...st.steps]; steps[i] = { ...s, params }; setSt({ ...st, steps });
                    }} />
                  ) : s.key === 'decision' ? (
                    <DecisionEditor step={s} stepIndex={i} allSteps={st.steps} onChange={(params, thenSteps, elseSteps) => {
                      const steps = [...st.steps]; steps[i] = { ...s, params, then_steps: thenSteps, else_steps: elseSteps }; setSt({ ...st, steps });
                    }} />
                  ) : (
                    <StepParamsEditor step={s} onChange={params => {
                      const steps = [...st.steps]; steps[i] = { ...s, params }; setSt({ ...st, steps });
                    }} />
                  )}
                  {errs.map((e, k) => <p key={k} className="text-[11px] text-rose-400 mt-1.5">✗ {e.message}</p>)}
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === st.steps.length - 1} className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30">↓</button>
                  <button onClick={() => remove(i)} className="text-xs text-slate-600 hover:text-rose-400">✕</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add step — grouped: Do something / Guide & explain / Flow control */}
      <div className="space-y-2 mb-4">
        {([
          ['work', 'Do something'],
          ['guide', 'Guide & explain'],
          ['flow', 'Flow control'],
        ] as const).map(([group, label]) => (
          <div key={group} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-600 w-32 flex-shrink-0">{label}</span>
            {PRIMITIVE_REGISTRY.filter(m => m.group === group).map(m => (
              <button key={m.key} onClick={() => addStep(m.key)} title={m.description}
                className="text-[11px] px-2 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors">
                + {m.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {globalErrs.map((e, k) => <p key={k} className="text-[11px] text-rose-400 mb-1">✗ {e.message}</p>)}
      {error && <p className="text-[11px] text-rose-400 mb-2">✗ {error}</p>}
      {serverErrors.length > 0 && <p className="text-[11px] text-amber-400 mb-2">Server validation rejected the publish — fix the flagged steps and retry.</p>}

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <button onClick={saveDraft} disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors">
          {busy === 'save' ? 'Saving…' : 'Save draft'}
        </button>
        <button onClick={publish} disabled={busy !== null || clientErrors.length > 0}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {busy === 'publish' ? 'Publishing…' : st.status === 'published' ? `Publish v${'{next}'.replace('{next}', '↑')}` : 'Publish'}
        </button>
        <button onClick={onCancel} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
        <span className="ml-auto text-[10px] text-slate-600">Publishing validates server-side and snapshots an immutable version — running playbooks never see later edits.</span>
      </div>

      <DryRunPreview steps={st.steps} definitionId={st.id} accounts={accounts} disabled={clientErrors.length > 0} />
    </div>
  );
}

// ── Dry-run preview: executes the draft with writes/connectors/gates
// SIMULATED. No persistence — the trace is returned in-memory only. ──

function PreviewStepRow({ s, depth = 0 }: { s: PreviewRunStep; depth?: number }) {
  const branch = s.branch_taken != null ? (s.branch_taken === 'then' ? s.then_steps : s.else_steps) : null;
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className={`flex items-start gap-2 text-xs rounded-lg px-2 py-1.5 ${s.status === 'failed' ? 'bg-rose-500/5' : s.status === 'waiting' ? 'bg-amber-500/5' : ''}`}>
        <span className={`flex-shrink-0 ${s.status === 'done' ? 'text-emerald-400' : s.status === 'skipped' ? 'text-slate-500' : s.status === 'failed' ? 'text-rose-400' : s.status === 'waiting' ? 'text-amber-400' : 'text-slate-600'}`}>
          {s.status === 'done' ? '✓' : s.status === 'skipped' ? '↷' : s.status === 'failed' ? '✗' : s.status === 'waiting' ? '⏸' : '·'}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-slate-300">{s.label}</span>
          {s.detail && <p className="text-[11px] text-slate-500 mt-0.5 break-words">{s.detail}</p>}
        </div>
      </div>
      {branch && branch.map((bs, i) => <PreviewStepRow key={i} s={bs} depth={depth + 1} />)}
    </div>
  );
}

function DryRunPreview({ steps, definitionId, accounts, disabled }: {
  steps: DefinitionStep[]; definitionId: string | null; accounts: CustomerAccount[]; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!accountId) return;
    setRunning(true); setErr(null); setResult(null);
    try {
      const res = await previewRun({ definitionId: definitionId ?? undefined, steps: definitionId ? undefined : steps, accountId });
      setResult(res);
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  };

  return (
    <div className="rounded-xl border border-indigo-800/40 bg-indigo-500/5 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-xs font-medium text-indigo-300">Dry-run preview</p>
          <p className="text-[10px] text-slate-500">Simulates connector calls and writes — nothing is called externally, nothing is persisted, human gates never pause.</p>
        </div>
        <button onClick={() => setOpen(o => !o)} disabled={disabled}
          className="text-xs px-3 py-1.5 rounded-lg border border-indigo-700/50 text-indigo-300 hover:border-indigo-500 disabled:opacity-40 transition-colors">
          {open ? 'Hide' : 'Try it'}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <select className={selectCls + ' !w-56'} value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">Pick an account to simulate…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button onClick={() => void run()} disabled={running || !accountId}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors">
              {running ? 'Running…' : 'Run preview'}
            </button>
          </div>
          {err && <p className="text-[11px] text-rose-400 mb-2">✗ {err}</p>}
          {result?.errors && result.errors.length > 0 && (
            <div className="mb-2">{result.errors.map((e, k) => <p key={k} className="text-[11px] text-rose-400">✗ {e.message}</p>)}</div>
          )}
          {result?.steps && (
            <div className="space-y-1 bg-slate-950/50 rounded-lg p-2">
              {result.steps.map((s, i) => <PreviewStepRow key={i} s={s} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── R7: Triggers section (schedules + event rules + fires log) ────

function fireChip(status: PlaybookTriggerFire['status']) {
  const map: Record<string, string> = {
    started: 'bg-emerald-500/15 text-emerald-300',
    pending_start: 'bg-indigo-500/15 text-indigo-300',
    skipped_dedup: 'bg-slate-700 text-slate-400',
    error: 'bg-red-500/15 text-red-300',
  };
  const label = status === 'skipped_dedup' ? 'deduped' : status === 'pending_start' ? 'pending' : status;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${map[status]}`}>{label}</span>;
}

function TriggersSection({ def, schedules, rules, fires, accounts, onChanged, onOpenRun }: {
  def: PlaybookDefinition;
  schedules: PlaybookSchedule[];
  rules: PlaybookEventRule[];
  fires: PlaybookTriggerFire[];
  accounts: CustomerAccount[];
  onChanged: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [adding, setAdding] = useState<'schedule' | 'event' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // schedule form
  const [cadence, setCadence] = useState<ScheduleCadence>('daily');
  const [hour, setHour] = useState(9);
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [monthlyDay, setMonthlyDay] = useState(1);
  const [selMode, setSelMode] = useState<'all_eligible' | 'single'>('all_eligible');
  const [selAccount, setSelAccount] = useState('');
  const [withinDays, setWithinDays] = useState(60);

  // event form
  const [eventKey, setEventKey] = useState<EventKey>('invoice_overdue');
  const [overdueDays, setOverdueDays] = useState(7);
  const [priority, setPriority] = useState('p1');
  const [minArr, setMinArr] = useState(0); // dollars; 0 = any ARR
  const [minAmount, setMinAmount] = useState(0); // dollars; 0 = any deal size
  const [cooldown, setCooldown] = useState(24);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); setAdding(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const addSchedule = () => guard(() => createSchedule({
    definition_id: def.id, cadence, run_at_hour: hour,
    weekly_day: cadence === 'weekly' ? weeklyDay : null,
    monthly_day: cadence === 'monthly' ? monthlyDay : null,
    account_selector: selMode === 'single'
      ? { mode: 'single', account_id: selAccount }
      : { mode: 'all_eligible', renewal_within_days: withinDays },
  }));

  const addRule = () => guard(() => createEventRule({
    definition_id: def.id, event_key: eventKey,
    params: eventKey === 'invoice_overdue' ? { overdue_days: overdueDays }
      : eventKey === 'account_at_risk' ? { min_arr_cents: Math.max(0, Math.round(minArr)) * 100 }
      : eventKey === 'opportunity_won' ? { min_amount_cents: Math.max(0, Math.round(minAmount)) * 100 }
      : { priority },
    cooldown_hours: cooldown,
  }));

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h3 className="text-sm font-semibold text-white">Triggers</h3>
        <div className="flex gap-2">
          <button onClick={() => setAdding(adding === 'schedule' ? null : 'schedule')}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors">
            ⏰ Add schedule
          </button>
          <button onClick={() => setAdding(adding === 'event' ? null : 'event')}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors">
            ⚡ Add event rule
          </button>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        {DISPATCH_MODE === 'cron'
          ? 'Dispatcher runs server-side every 5 minutes (pg_cron) — triggers fire even with every browser closed.'
          : 'Scheduled triggers fire when the workspace is active — always-on dispatch arrives with infrastructure cron.'}
      </p>
      {def.status !== 'published' && (
        <p className="text-[11px] text-amber-400 mb-3">This playbook is not published — triggers will not start runs until it is.</p>
      )}
      {err && <p className="text-[11px] text-rose-400 mb-2">✗ {err}</p>}

      {adding === 'schedule' && (
        <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 mb-3 space-y-2">
          <div className="flex gap-2 flex-wrap items-center">
            <select className={selectCls + ' !w-32'} value={cadence} onChange={e => setCadence(e.target.value as ScheduleCadence)}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
            {cadence === 'weekly' && (
              <select className={selectCls + ' !w-36'} value={weeklyDay} onChange={e => setWeeklyDay(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {cadence === 'monthly' && (
              <select className={selectCls + ' !w-32'} value={monthlyDay} onChange={e => setMonthlyDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>day {d}</option>)}
              </select>
            )}
            <select className={selectCls + ' !w-32'} value={hour} onChange={e => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>)}
            </select>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <select className={selectCls + ' !w-56'} value={selMode} onChange={e => setSelMode(e.target.value as 'all_eligible' | 'single')}>
              <option value="all_eligible">All accounts nearing renewal</option>
              <option value="single">A single account</option>
            </select>
            {selMode === 'single' ? (
              <select className={selectCls + ' !w-56'} value={selAccount} onChange={e => setSelAccount(e.target.value)}>
                <option value="">Pick an account…</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : (
              <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
                renewal within
                <input className={inputCls + ' !w-16'} type="number" min={1} max={365} value={withinDays} onChange={e => setWithinDays(Number(e.target.value))} />
                days
              </label>
            )}
          </div>
          <button onClick={() => void addSchedule()} disabled={busy || (selMode === 'single' && !selAccount)}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors">
            {busy ? 'Adding…' : 'Add schedule'}
          </button>
        </div>
      )}

      {adding === 'event' && (
        <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 mb-3 space-y-2">
          <div className="flex gap-2 flex-wrap items-center">
            <select className={selectCls + ' !w-64'} value={eventKey} onChange={e => setEventKey(e.target.value as EventKey)}>
              {(Object.keys(EVENT_META) as EventKey[]).map(k => <option key={k} value={k}>{EVENT_META[k].label}</option>)}
            </select>
            {eventKey === 'invoice_overdue' ? (
              <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
                overdue by
                <input className={inputCls + ' !w-16'} type="number" min={1} max={90} value={overdueDays} onChange={e => setOverdueDays(Number(e.target.value))} />
                days
              </label>
            ) : eventKey === 'account_at_risk' ? (
              <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
                min ARR $
                <input className={inputCls + ' !w-24'} type="number" min={0} step={1000} value={minArr} onChange={e => setMinArr(Number(e.target.value))} />
                (0 = any)
              </label>
            ) : eventKey === 'opportunity_won' ? (
              <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
                min deal $
                <input className={inputCls + ' !w-24'} type="number" min={0} step={1000} value={minAmount} onChange={e => setMinAmount(Number(e.target.value))} />
                (0 = any)
              </label>
            ) : (
              <select className={selectCls + ' !w-28'} value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="p1">p1</option><option value="p2">p2</option>
              </select>
            )}
            <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
              cooldown
              <input className={inputCls + ' !w-16'} type="number" min={1} max={720} value={cooldown} onChange={e => setCooldown(Number(e.target.value))} />
              h per target
            </label>
          </div>
          <p className="text-[10px] text-slate-600">{EVENT_META[eventKey].description}</p>
          <button onClick={() => void addRule()} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors">
            {busy ? 'Adding…' : 'Add event rule'}
          </button>
        </div>
      )}

      {/* Existing triggers */}
      {schedules.length === 0 && rules.length === 0 ? (
        <p className="text-xs text-slate-500 mb-2">No triggers — this playbook only runs manually.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {schedules.map(s => (
            <div key={s.id} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 bg-slate-950/50 flex-wrap">
              <span className="text-slate-300">⏰ {describeSchedule(s)}</span>
              <span className="text-[10px] text-slate-600">
                {s.account_selector.mode === 'single' ? 'single account' : `renewals within ${s.account_selector.renewal_within_days ?? 60}d`}
              </span>
              {s.active && s.next_fire_at && (
                <span className="text-[10px] text-indigo-300">next fire {new Date(s.next_fire_at).toLocaleString()}</span>
              )}
              {!s.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">paused</span>}
              <span className="ml-auto flex gap-2">
                <button onClick={() => guard(() => setScheduleActive(s.id, !s.active))}
                  className="text-[11px] text-slate-500 hover:text-slate-300">{s.active ? 'pause' : 'resume'}</button>
                <button onClick={() => guard(() => deleteSchedule(s.id))}
                  className="text-[11px] text-slate-600 hover:text-rose-400">delete</button>
              </span>
            </div>
          ))}
          {rules.map(r => (
            <div key={r.id} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 bg-slate-950/50 flex-wrap">
              <span className="text-slate-300">⚡ {describeEventRule(r)}</span>
              <span className="text-[10px] text-slate-600">cooldown {r.cooldown_hours}h per target</span>
              {!r.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">paused</span>}
              <span className="ml-auto flex gap-2">
                <button onClick={() => guard(() => setEventRuleActive(r.id, !r.active))}
                  className="text-[11px] text-slate-500 hover:text-slate-300">{r.active ? 'pause' : 'resume'}</button>
                <button onClick={() => guard(() => deleteEventRule(r.id))}
                  className="text-[11px] text-slate-600 hover:text-rose-400">delete</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Fires history */}
      {fires.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">Trigger fires</p>
          <div className="space-y-1">
            {fires.slice(0, 10).map(f => (
              <div key={f.id} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded-lg bg-slate-950/40 flex-wrap">
                <span className="text-slate-500 whitespace-nowrap">{new Date(f.fired_at).toLocaleString()}</span>
                <span className="text-slate-400">{f.source === 'schedule' ? '⏰' : '⚡'}</span>
                {fireChip(f.status)}
                <span className="text-slate-500 truncate max-w-[24rem]">{f.detail}</span>
                {f.run_id && (
                  <button onClick={() => onOpenRun(f.run_id!)} className="ml-auto text-indigo-400 hover:text-indigo-300 whitespace-nowrap">view run →</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function LivePlaybookBuilder({ setPage }: { setPage: (p: Page) => void }) {
  const [defs, setDefs] = useState<PlaybookDefinition[]>([]);
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [selectedDefId, setSelectedDefId] = useState<string | null>(null);
  const [runAccountId, setRunAccountId] = useState('');
  const [starting, setStarting] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<PlaybookSchedule[]>([]);
  const [eventRules, setEventRules] = useState<PlaybookEventRule[]>([]);
  const [fires, setFires] = useState<PlaybookTriggerFire[]>([]);

  const refresh = async () => {
    try {
      const [d, r, a, s, er, f] = await Promise.all([
        listDefinitions(), listPlaybookRuns(), listAccounts(),
        listSchedules(), listEventRules(), listTriggerFires(),
      ]);
      setDefs(d); setRuns(r); setAccounts(a);
      setSchedules(s); setEventRules(er); setFires(f);
      setMissingTables(false); setError(null);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load playbooks.');
    } finally { setLoading(false); }
  };
  useEffect(() => {
    void refresh();
    // R7 opportunistic dispatch — the backup path behind the pg_cron
    // primary. Fire-and-forget; a refresh follows if anything fired.
    void dispatchTriggersOpportunistic();
    const onChange = () => void refresh();
    window.addEventListener('dt-state-changed', onChange);
    return () => window.removeEventListener('dt-state-changed', onChange);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const selectedDef = defs.find(d => d.id === selectedDefId) ?? null;
  const defRuns = selectedDef ? runs.filter(r => r.definition_id === selectedDef.id) : [];

  const startRun = async () => {
    if (!selectedDef || !runAccountId) return;
    setStarting(true);
    try {
      const res = await startDefinitionRun(selectedDef.id, runAccountId);
      setToast(res.status === 'waiting_approval'
        ? 'Run started — paused at the human approval gate (see Human Tasks)'
        : `Run ${res.status}`);
      await refresh();
      setOpenRunId(res.run_id);
    } catch (err) { setError((err as Error).message); }
    finally { setStarting(false); }
  };

  const archive = async (def: PlaybookDefinition) => {
    await updateDefinition(def.id, { status: 'archived' });
    setSelectedDefId(null);
    await refresh();
    setToast(`"${def.name}" archived`);
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Playbooks"
        subtitle="Build playbooks from typed step primitives — validated, versioned, executed server-side with guardrails and human gates"
      />
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? <LiveLoadingSkeleton rows={3} /> : missingTables ? <MissingTablesNotice /> : builder ? (
        <Builder
          initial={builder}
          onCancel={() => setBuilder(null)}
          onDone={async (published) => {
            setBuilder(null);
            await refresh();
            setToast(published ? 'Published — immutable version snapshot created' : 'Draft saved');
          }}
          publishedDefs={defs.filter(d => d.status === 'published')}
          accounts={accounts}
        />
      ) : selectedDef ? (
        <div>
          <button onClick={() => { setSelectedDefId(null); setOpenRunId(null); }} className="text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">← Back to library</button>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-white">{selectedDef.name}</h2>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">{selectedDef.key}</span>
                {statusChip(selectedDef.status)}
                {selectedDef.status === 'published' && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">v{selectedDef.version}</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setBuilder({ id: selectedDef.id, name: selectedDef.name, key: selectedDef.key, description: selectedDef.description, steps: selectedDef.steps, status: selectedDef.status })}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors">
                  {selectedDef.status === 'published' ? `Edit (next publish → v${selectedDef.version + 1})` : 'Edit draft'}
                </button>
                <button onClick={() => void archive(selectedDef)} className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 text-slate-500 hover:text-rose-300 hover:border-rose-800 transition-colors">Archive</button>
              </div>
            </div>
            {selectedDef.description && <p className="text-sm text-slate-400 mb-3">{selectedDef.description}</p>}

            {/* The "document that executes" — an SOP-style read view */}
            <PlaybookDocumentView steps={selectedDef.steps} publishedDefs={defs} />

            {/* Run controls */}
            {selectedDef.status === 'published' ? (
              <div className="flex items-center gap-2 flex-wrap">
                <select className={selectCls + ' !w-64'} value={runAccountId} onChange={e => setRunAccountId(e.target.value)}>
                  <option value="">Pick an account…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} — ${Math.round(a.arr_cents / 100).toLocaleString()}</option>)}
                </select>
                <button onClick={() => void startRun()} disabled={!runAccountId || starting}
                  className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors">
                  {starting ? 'Running…' : `▶ Run v${selectedDef.version}`}
                </button>
                <span className="text-[10px] text-slate-600">Runs execute the published v{selectedDef.version} snapshot server-side — later edits never touch in-flight runs.</span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">Publish this draft to run it. Drafts are never executable.</p>
            )}
          </div>

          {/* R7 Triggers */}
          <TriggersSection
            def={selectedDef}
            schedules={schedules.filter(s => s.definition_id === selectedDef.id)}
            rules={eventRules.filter(r => r.definition_id === selectedDef.id)}
            fires={fires.filter(f => f.definition_id === selectedDef.id)}
            accounts={accounts}
            onChanged={() => void refresh()}
            onOpenRun={(runId) => setOpenRunId(runId)}
          />

          {/* Run history for this definition */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Runs</h3>
            {defRuns.length === 0 ? <p className="text-xs text-slate-500">No runs yet.</p> : (
              <div className="space-y-2">
                {defRuns.map(r => (
                  <div key={r.id} className="rounded-xl border border-slate-800 bg-slate-950/50">
                    <button onClick={() => setOpenRunId(openRunId === r.id ? null : r.id)} className="w-full flex items-center gap-3 px-3 py-2 text-left">
                      <span className="text-xs text-slate-500 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</span>
                      {statusChip(r.status)}
                      <span className="text-[10px] font-mono text-slate-600">v{r.definition_version}</span>
                      <span className="text-xs text-slate-400 ml-auto">{r.steps.filter(s => s.status === 'done' || s.status === 'skipped').length}/{r.steps.length} steps {openRunId === r.id ? '▴' : '▾'}</span>
                    </button>
                    {openRunId === r.id && <div className="px-3 pb-3"><RunTimeline run={r} /></div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Definitions library */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden mb-6">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Your playbooks</p>
              <button onClick={() => setBuilder({ id: null, name: '', key: '', description: '', steps: [...NEW_TEMPLATE.map(s => ({ ...s, params: { ...s.params } }))], status: 'draft' })}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors">
                + New playbook
              </button>
            </div>
            {defs.filter(d => d.status !== 'archived').length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-500">No playbooks yet — build your first from typed step primitives. Guardrails and human gates are enforced by the server on every run.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-950/60">
                  <tr>
                    <th className={th}>Playbook</th><th className={th}>Key</th><th className={th}>Status</th>
                    <th className={th}>Version</th><th className={th}>Steps</th><th className={th}>Trigger</th><th className={th}>Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {defs.filter(d => d.status !== 'archived').map(d => (
                    <tr key={d.id} onClick={() => setSelectedDefId(d.id)}
                      className="border-t border-slate-800/60 hover:bg-slate-800/30 cursor-pointer transition-colors">
                      <td className={`${td} text-slate-200 font-medium`}>{d.name}</td>
                      <td className={`${td} text-xs font-mono text-slate-500`}>{d.key}</td>
                      <td className={td}>{statusChip(d.status)}</td>
                      <td className={`${td} text-xs font-mono text-slate-400`}>{d.status === 'published' ? `v${d.version}` : '—'}</td>
                      <td className={`${td} text-xs text-slate-400`}>{d.steps.length}{d.steps.some(s => s.key === 'human_approval') ? ' · human gate' : ''}</td>
                      <td className={`${td} text-xs text-slate-500`}>
                        <span className="flex flex-wrap gap-1">
                          {schedules.filter(s => s.definition_id === d.id && s.active).map(s => (
                            <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 whitespace-nowrap">⏰ {describeSchedule(s)}</span>
                          ))}
                          {eventRules.filter(r => r.definition_id === d.id && r.active).map(r => (
                            <span key={r.id} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 whitespace-nowrap">⚡ {describeEventRule(r)}</span>
                          ))}
                          {!schedules.some(s => s.definition_id === d.id && s.active) && !eventRules.some(r => r.definition_id === d.id && r.active) && 'manual'}
                        </span>
                      </td>
                      <td className={`${td} text-xs text-slate-400`}>{runs.filter(r => r.definition_id === d.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Legacy built-in playbook */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-white">Renewal Lifecycle</h3>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">BUILT-IN</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">renewal_v1</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  The original server-executed renewal playbook — check account → invoice → guardrail → human gate → send. Every step lands in the immutable audit trail.
                </p>
              </div>
              <button onClick={() => setPage('entity_customer_renewal')}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors">
                Run from Renewal &amp; Expansion →
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {RENEWAL_STEP_DEFS.map((s, i) => (
                <span key={s.key} className="text-[11px] px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                  {i + 1}. {s.label}{s.key === 'human_approval' ? ' 🤝' : ''}
                </span>
              ))}
            </div>
          </div>

          {/* All-runs history */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-sm font-semibold text-white mb-3">Run history</h3>
            {runs.length === 0 ? <p className="text-xs text-slate-500">No runs yet.</p> : (
              <div className="space-y-2">
                {runs.map(r => (
                  <div key={r.id} className="rounded-xl border border-slate-800 bg-slate-950/50">
                    <button onClick={() => setOpenRunId(openRunId === r.id ? null : r.id)} className="w-full flex items-center gap-3 px-3 py-2 text-left flex-wrap">
                      <span className="text-xs text-slate-500 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</span>
                      <span className="text-xs font-mono text-slate-300">{r.playbook_key}</span>
                      {r.definition_version ? <span className="text-[10px] font-mono text-slate-600">v{r.definition_version}</span> : null}
                      {statusChip(r.status)}
                      <span className="text-xs text-slate-400 ml-auto">{r.steps.filter(s => s.status === 'done' || s.status === 'skipped').length}/{r.steps.length} steps {openRunId === r.id ? '▴' : '▾'}</span>
                    </button>
                    {openRunId === r.id && <div className="px-3 pb-3"><RunTimeline run={r} /></div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-800 border border-emerald-500/40 text-sm text-slate-100 rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
