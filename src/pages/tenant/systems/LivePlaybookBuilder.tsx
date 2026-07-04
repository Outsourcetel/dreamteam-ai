import React, { useState, useEffect, useMemo } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import { CustomerApiError, listAccounts } from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import { listPlaybookRuns, RENEWAL_STEP_DEFS } from '../../../lib/playbookApi';
import type { PlaybookRun, RunStep } from '../../../lib/playbookApi';
import {
  PRIMITIVE_REGISTRY, TEMPLATE_VARS, UPDATE_WHITELIST,
  validateStepsClient, listDefinitions, createDefinition, updateDefinition,
  publishDefinition, startDefinitionRun,
} from '../../../lib/playbookBuilderApi';
import type { PlaybookDefinition, DefinitionStep, PrimitiveKey, ValidationError } from '../../../lib/playbookBuilderApi';
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
    case 'guardrail_check':
      return <p className="text-[11px] text-slate-500">Re-checks the invoice approval threshold and records the result in the audit chain.</p>;
    default:
      return null;
  }
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

function Builder({ initial, onDone, onCancel }: {
  initial: BuilderState;
  onDone: (published: boolean) => void;
  onCancel: () => void;
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
                  <StepParamsEditor step={s} onChange={params => {
                    const steps = [...st.steps]; steps[i] = { ...s, params }; setSt({ ...st, steps });
                  }} />
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

      {/* Add step */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {PRIMITIVE_REGISTRY.map(m => (
          <button key={m.key} onClick={() => addStep(m.key)} title={m.description}
            className="text-[11px] px-2 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors">
            + {m.label}
          </button>
        ))}
      </div>

      {globalErrs.map((e, k) => <p key={k} className="text-[11px] text-rose-400 mb-1">✗ {e.message}</p>)}
      {error && <p className="text-[11px] text-rose-400 mb-2">✗ {error}</p>}
      {serverErrors.length > 0 && <p className="text-[11px] text-amber-400 mb-2">Server validation rejected the publish — fix the flagged steps and retry.</p>}

      <div className="flex items-center gap-2 flex-wrap">
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

  const refresh = async () => {
    try {
      const [d, r, a] = await Promise.all([listDefinitions(), listPlaybookRuns(), listAccounts()]);
      setDefs(d); setRuns(r); setAccounts(a);
      setMissingTables(false); setError(null);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load playbooks.');
    } finally { setLoading(false); }
  };
  useEffect(() => {
    void refresh();
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

            {/* Steps rendered like a run timeline */}
            <div className="space-y-1.5 mb-4">
              {selectedDef.steps.map((s, i) => {
                const meta = PRIMITIVE_REGISTRY.find(m => m.key === s.key);
                const gate = s.key === 'human_approval';
                return (
                  <div key={i} className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 ${gate ? 'bg-amber-500/5 border border-amber-500/20' : ''}`}>
                    <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${gate ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>{i + 1}</span>
                    <span className="text-slate-300">{meta?.label ?? s.key}{gate ? ' 🤝' : ''}</span>
                    {s.key === 'connector_action' && <span className="text-[10px] text-slate-600">Zendesk · {String(s.params?.op ?? '')}</span>}
                    {s.key === 'log_activity' && <span className="text-[10px] text-slate-600 truncate">{String(s.params?.text_template ?? '')}</span>}
                  </div>
                );
              })}
            </div>

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
                      <td className={`${td} text-xs text-slate-500`}>manual</td>
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
