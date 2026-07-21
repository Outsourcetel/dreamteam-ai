import { useEffect, useMemo, useState } from 'react';
import type { Page } from '../../../types';
import {
  getBrowserOperator, getBrowserTask, proposeBrowserTask, decideBrowserTask, listDEsLite,
  getDeOperateConfig, upsertOperateBinding, setOperateLogin, clearOperateLogin, deleteOperateBinding,
  type BrowserOperatorState, type BrowserTaskRow, type BrowserTaskDetail, type BrowserEngine,
  type CredentialPolicy, type DeLite, type DeOperateConfig, type OperateSystem,
} from '../../../lib/browserOperatorApi';

// ── status vocabulary — one glance tells you where a task is ──
const STATUS: Record<string, { label: string; dot: string; chip: string }> = {
  pending_approval: { label: 'Awaiting your approval', dot: 'bg-amber-400', chip: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  approved:         { label: 'Approved · queued',      dot: 'bg-sky-400',   chip: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
  claimed:          { label: 'Starting',               dot: 'bg-indigo-400',chip: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
  running:          { label: 'Running',                dot: 'bg-indigo-400 animate-pulse', chip: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
  done:             { label: 'Done',                   dot: 'bg-emerald-400', chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  failed:           { label: 'Failed',                 dot: 'bg-rose-400',   chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
  rejected:         { label: 'Declined',               dot: 'bg-slate-500',  chip: 'bg-slate-500/10 text-slate-400 border-slate-600/40' },
  expired:          { label: 'Expired',                dot: 'bg-slate-500',  chip: 'bg-slate-500/10 text-slate-400 border-slate-600/40' },
};
const ENGINE_LABEL: Record<BrowserEngine, string> = { browser_dom: 'Reads the page', browser_vision: 'Sees the screen', desktop: 'Full desktop' };
const CRED_LABEL: Record<CredentialPolicy, string> = { none: 'No login', vault_injected: 'Vault login', human_login: 'You log in' };

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const BrowserOperatorPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const [state, setState] = useState<BrowserOperatorState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const load = async () => {
    try { setError(''); setState(await getBrowserOperator()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const runtimeOnline = useMemo(() => (state?.runtimes ?? []).some(r => r.active), [state]);
  const tasks = state?.tasks ?? [];
  const pending = tasks.filter(t => t.status === 'pending_approval');
  const active = tasks.filter(t => ['approved', 'claimed', 'running'].includes(t.status));
  const finished = tasks.filter(t => ['done', 'failed', 'rejected', 'expired'].includes(t.status));

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 text-slate-200">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Browser Operator</h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Let a digital employee do a task in a real web browser — look something up, fill a form, check a portal —
            on the sites you allow. Nothing runs until <span className="text-slate-200">you approve it</span>, and every click is recorded.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RuntimePill online={runtimeOnline} count={(state?.runtimes ?? []).filter(r => r.active).length} />
          <button onClick={() => setShowConfig(true)}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-slate-600 text-slate-200 hover:border-slate-500 hover:bg-slate-800/60 transition-colors">
            Configure apps
          </button>
          <button onClick={() => setShowNew(true)}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
            + New task
          </button>
        </div>
      </div>

      {error && <Banner tone="rose">{error}</Banner>}
      {state && !state.enabled && (
        <Banner tone="amber">
          Browser Operator is currently <b>off</b> for this workspace — a safety default. Turn it on in Feature settings before tasks can run.
        </Banner>
      )}
      {state && state.enabled && !runtimeOnline && (
        <Banner tone="slate">
          No browser worker is connected yet, so approved tasks stay safely queued. Connect a browser runtime (free, self-hosted) and it will pick them up automatically.
        </Banner>
      )}

      {loading && !state && <div className="text-sm text-slate-500 py-16 text-center">Loading…</div>}

      {state && (
        <div className="space-y-8">
          <Section title="Waiting for you" count={pending.length} hint="Approve or decline what a digital employee wants to do.">
            {pending.length === 0
              ? <Empty>Nothing needs your approval right now.</Empty>
              : pending.map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>

          <Section title="In progress" count={active.length}>
            {active.length === 0
              ? <Empty>No tasks are running.</Empty>
              : active.map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>

          <Section title="History" count={finished.length}>
            {finished.length === 0
              ? <Empty>Completed tasks will appear here, each with a full step-by-step replay.</Empty>
              : finished.slice(0, 30).map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>
        </div>
      )}

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); load(); }} />}
      {showConfig && <OperateConfigDrawer onClose={() => setShowConfig(false)} />}
      {openTaskId && <TaskDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} onChange={load} />}

      <div className="mt-10 text-xs text-slate-600">
        Safety: tasks only run on the exact sites you allow, stop at their step limit, never see your passwords, and
        pause for your confirmation before anything irreversible. <button className="underline hover:text-slate-400" onClick={() => setPage('workforce_des')}>Back to workforce</button>
      </div>
    </div>
  );
};

// ── little pieces ──
function RuntimePill({ online, count }: { online: boolean; count: number }) {
  return (
    <span className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${online ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-700/40 text-slate-400 border-slate-600/50'}`}>
      <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-slate-500'}`} />
      {online ? `${count} browser connected` : 'No browser connected'}
    </span>
  );
}
function Banner({ tone, children }: { tone: 'rose' | 'amber' | 'slate'; children: React.ReactNode }) {
  const cls = tone === 'rose' ? 'border-rose-800/50 bg-rose-500/10 text-rose-300'
    : tone === 'amber' ? 'border-amber-700/50 bg-amber-500/10 text-amber-200'
    : 'border-slate-700 bg-slate-800/40 text-slate-300';
  return <div className={`mb-5 rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
function Section({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-slate-500">{count}</span>
        {hint && <span className="text-xs text-slate-600 ml-2">{hint}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-700/60 px-4 py-6 text-sm text-slate-500 text-center">{children}</div>;
}
function DomainChips({ domains }: { domains: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {domains.map(d => <span key={d} className="text-[11px] px-2 py-0.5 rounded bg-slate-700/50 text-slate-300 border border-slate-600/40">{d}</span>)}
    </div>
  );
}
function TaskCard({ t, onOpen }: { t: BrowserTaskRow; onOpen: () => void }) {
  const s = STATUS[t.status] ?? STATUS.pending_approval;
  return (
    <button onClick={onOpen} className="w-full text-left rounded-xl border border-slate-700/70 bg-slate-800/40 hover:bg-slate-800/70 hover:border-slate-600 transition-colors px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${s.dot}`} />
            <span className="text-sm font-medium text-slate-100 truncate">{t.title || t.goal}</span>
          </div>
          {t.title && <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{t.goal}</p>}
          <div className="mt-2"><DomainChips domains={t.allowed_domains} /></div>
        </div>
        <span className={`shrink-0 text-[11px] px-2 py-1 rounded-full border ${s.chip}`}>{s.label}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>{t.de_name ?? 'Employee'}</span>
        <span>· {ENGINE_LABEL[t.engine]}</span>
        <span>· {CRED_LABEL[t.credential_policy]}</span>
        <span>· up to {t.max_steps} steps</span>
        <span>· {t.steps} recorded</span>
        <span className="ml-auto">{timeAgo(t.created_at)}</span>
      </div>
    </button>
  );
}

// ── launch form ──
function NewTaskModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [des, setDes] = useState<DeLite[]>([]);
  const [deId, setDeId] = useState('');
  const [goal, setGoal] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState(15);
  const [engine, setEngine] = useState<BrowserEngine>('browser_dom');
  const [cred, setCred] = useState<CredentialPolicy>('none');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { listDEsLite().then(d => { setDes(d); if (d[0]) setDeId(d[0].id); }).catch(() => {}); }, []);
  const addDomain = () => {
    const d = domainInput.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (d && !domains.includes(d)) setDomains([...domains, d]);
    setDomainInput('');
  };
  const valid = deId && goal.trim().length >= 10 && domains.length >= 1;
  const submit = async () => {
    if (!valid) return;
    setBusy(true); setErr('');
    try { await proposeBrowserTask({ deId, goal: goal.trim(), allowedDomains: domains, maxSteps, engine, credentialPolicy: cred }); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not create the task.'); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="New browser task">
      <div className="space-y-4">
        <Field label="Which employee should do it?">
          <select value={deId} onChange={e => setDeId(e.target.value)} className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200">
            {des.length === 0 && <option value="">No active employees</option>}
            {des.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="What should it do?" hint="Describe the task in plain language (min 10 characters).">
          <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={3} placeholder="e.g. Log in to the shipping portal and find the tracking status for order #10432, then report it back."
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600" />
        </Field>
        <Field label="Allowed sites" hint="It can ONLY visit these. Add each site it needs.">
          <div className="flex gap-2">
            <input value={domainInput} onChange={e => setDomainInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
              placeholder="portal.example.com" className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600" />
            <button onClick={addDomain} className="px-3 py-2 rounded-lg border border-slate-600 text-slate-300 text-sm hover:border-slate-500">Add</button>
          </div>
          {domains.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {domains.map(d => <span key={d} className="text-[11px] px-2 py-0.5 rounded bg-slate-700/50 text-slate-300 border border-slate-600/40 flex items-center gap-1">
                {d}<button onClick={() => setDomains(domains.filter(x => x !== d))} className="text-slate-500 hover:text-rose-400">×</button></span>)}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="How it works" hint="Reading the page is faster & cheaper. Use 'sees the screen' only for tricky visual sites.">
            <select value={engine} onChange={e => setEngine(e.target.value as BrowserEngine)} className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200">
              <option value="browser_dom">Reads the page (recommended)</option>
              <option value="browser_vision">Sees the screen</option>
            </select>
          </Field>
          <Field label="Step limit" hint="It stops after this many actions.">
            <input type="number" min={1} max={50} value={maxSteps} onChange={e => setMaxSteps(Math.max(1, Math.min(50, Number(e.target.value) || 15)))}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200" />
          </Field>
        </div>
        <Field label="Logging in" hint="It never sees your passwords. Vault login types stored credentials for it; 'you log in' hands you the browser to sign in first.">
          <select value={cred} onChange={e => setCred(e.target.value as CredentialPolicy)} className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200">
            <option value="none">No login needed</option>
            <option value="vault_injected">Use a stored (vault) login</option>
            <option value="human_login">You log in first</option>
          </select>
        </Field>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-slate-500">This creates an approval request — nothing runs until you approve it.</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
            <button disabled={!valid || busy} onClick={submit}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors">
              {busy ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── detail + step replay ──
function TaskDrawer({ taskId, onClose, onChange }: { taskId: string; onClose: () => void; onChange: () => void }) {
  const [task, setTask] = useState<BrowserTaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const reload = async () => { try { setTask(await getBrowserTask(taskId)); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); } };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [taskId]);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!task?.human_task_id) return;
    setBusy(true); setErr('');
    try { await decideBrowserTask(task.human_task_id, decision); await reload(); onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const s = task ? (STATUS[task.status] ?? STATUS.pending_approval) : STATUS.pending_approval;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-slate-900 border-l border-slate-700 overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        {!task ? <div className="text-sm text-slate-500">Loading…</div> : (
          <>
            <div className="flex items-start justify-between gap-3 mb-4">
              <h3 className="text-lg font-semibold text-white">{task.title || 'Browser task'}</h3>
              <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <span className={`text-[11px] px-2 py-1 rounded-full border ${s.chip}`}>{s.label}</span>
            <p className="text-sm text-slate-300 mt-3">{task.goal}</p>
            <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
              <Meta k="Employee" v={task.de_name ?? '—'} />
              <Meta k="How it works" v={ENGINE_LABEL[task.engine]} />
              <Meta k="Logging in" v={CRED_LABEL[task.credential_policy]} />
              <Meta k="Step limit" v={String(task.max_steps)} />
            </div>
            <div className="mt-3"><div className="text-xs text-slate-500 mb-1">Allowed sites</div><DomainChips domains={task.allowed_domains} /></div>

            {task.status === 'pending_approval' && (
              <div className="mt-5 rounded-xl border border-amber-700/40 bg-amber-500/5 p-4">
                <p className="text-sm text-amber-200 mb-3">Approve this employee to run the task in a browser? It stays within the allowed sites and step limit.</p>
                {err && <p className="text-xs text-rose-400 mb-2">{err}</p>}
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => decide('approved')} className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white">Approve</button>
                  <button disabled={busy} onClick={() => decide('rejected')} className="px-4 py-2 text-sm rounded-lg border border-slate-600 text-slate-300 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40">Decline</button>
                </div>
              </div>
            )}

            {task.result && <div className="mt-5"><div className="text-xs text-slate-500 mb-1">Result</div><div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-sm text-slate-200 whitespace-pre-wrap">{task.result}</div></div>}

            <div className="mt-6">
              <div className="text-xs text-slate-500 mb-2">Step-by-step replay ({task.audit.length})</div>
              {task.audit.length === 0
                ? <p className="text-sm text-slate-600">No steps yet. Once approved and a browser picks it up, every action it takes appears here.</p>
                : (
                  <ol className="space-y-2">
                    {task.audit.map((step, i) => (
                      <li key={i} className="flex gap-3 rounded-lg border border-slate-700/60 bg-slate-800/30 p-3">
                        <span className="shrink-0 w-6 h-6 rounded-full bg-slate-700 text-slate-300 text-xs flex items-center justify-center">{step.step ?? i + 1}</span>
                        <div className="min-w-0">
                          <div className="text-sm text-slate-200">{step.action ?? 'action'}</div>
                          {step.url && <div className="text-[11px] text-slate-500 truncate">{step.url}</div>}
                          {step.note && <div className="text-xs text-slate-400 mt-0.5">{step.note}</div>}
                          {typeof step.screenshot_ref === 'string' && /^https?:\/\//.test(step.screenshot_ref) &&
                            <img src={step.screenshot_ref} alt={`step ${i + 1}`} className="mt-2 rounded border border-slate-700 max-h-40" />}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── operate config: which connected apps a DE may drive via its web UI ──
function OperateConfigDrawer({ onClose }: { onClose: () => void }) {
  const [des, setDes] = useState<DeLite[]>([]);
  const [deId, setDeId] = useState('');
  const [cfg, setCfg] = useState<DeOperateConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { listDEsLite().then(d => { setDes(d); if (d[0]) setDeId(d[0].id); }).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load employees.')); }, []);

  const loadCfg = async (id: string) => {
    if (!id) return;
    setLoading(true); setErr('');
    try { setCfg(await getDeOperateConfig(id)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load config.'); setCfg(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (deId) loadCfg(deId); /* eslint-disable-next-line */ }, [deId]);

  const operable = (cfg?.systems ?? []).filter(s => s.can_operate);
  const others = (cfg?.systems ?? []).filter(s => !s.can_operate);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-slate-900 border-l border-slate-700 overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-lg font-semibold text-white">Apps an employee can operate</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
        </div>
        <p className="text-sm text-slate-400 mb-5 max-w-lg">
          Give a digital employee permission to work inside a connected app's web pages — e.g. QuickBooks, Xero, Salesforce —
          when there's no direct data connection for the job. It only acts on the app you allow, always asks you first, and never sees a password.
        </p>

        <Field label="Employee">
          <select value={deId} onChange={e => setDeId(e.target.value)} className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200">
            {des.length === 0 && <option value="">No active employees</option>}
            {des.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>

        {err && <p className="text-xs text-rose-400 mt-3">{err}</p>}
        {cfg && !cfg.featureEnabled && (
          <div className="mt-4"><Banner tone="amber">Browser Operator is <b>off</b> for this workspace, so these apps won't run until it's turned on in Feature settings. You can still configure them now.</Banner></div>
        )}
        {loading && <div className="text-sm text-slate-500 py-8 text-center">Loading…</div>}

        {cfg && !loading && (
          <div className="mt-5 space-y-6">
            <div>
              <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">Can operate ({operable.length})</div>
              {operable.length === 0
                ? <Empty>No apps yet. Add one below to let {cfg.de.name} work in it.</Empty>
                : <div className="space-y-3">{operable.map(s => <SystemCard key={s.id} deId={deId} s={s} connectors={cfg.connectors} onChange={() => loadCfg(deId)} />)}</div>}
            </div>

            {others.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Connected, not operable ({others.length})</div>
                <div className="space-y-3">{others.map(s => <SystemCard key={s.id} deId={deId} s={s} connectors={cfg.connectors} onChange={() => loadCfg(deId)} />)}</div>
              </div>
            )}

            {adding
              ? <AddBindingForm deId={deId} connectors={cfg.connectors} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); loadCfg(deId); }} />
              : <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-slate-700 hover:border-indigo-500/60 text-sm text-slate-300 hover:text-indigo-300 py-3 transition-colors">+ Add an app to operate</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function SystemCard({ deId, s, connectors, onChange }: { deId: string; s: OperateSystem; connectors: DeOperateConfig['connectors']; onChange: () => void }) {
  const [label, setLabel] = useState(s.label);
  const [domain, setDomain] = useState(s.operate_domain ?? '');
  const [connectorId, setConnectorId] = useState(s.connector_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const dirty = label !== s.label || (domain || '') !== (s.operate_domain ?? '') || (connectorId || '') !== (s.connector_id ?? '');

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); onChange(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); setBusy(false); } };
  const save = (canOperate: boolean) => run(async () => { await upsertOperateBinding({ deId, systemId: s.id, label, canOperate, operateDomain: domain || null, connectorId: connectorId || null }); });

  return (
    <div className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${s.can_operate ? 'bg-emerald-400' : 'bg-slate-500'}`} />
            <span className="text-sm font-medium text-slate-100">{s.label}</span>
            <span className="text-[11px] text-slate-500 font-mono">{s.system_key}</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {s.resolved_domain ? <>Runs on <span className="text-slate-300">{s.resolved_domain}</span></> : <span className="text-amber-400">No site set — add one below</span>}
            {' · '}{s.has_login ? <span className="text-emerald-400">Stored login ✓</span> : 'You log in each time'}
          </div>
        </div>
        <button disabled={busy} onClick={() => save(!s.can_operate)}
          className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full border ${s.can_operate ? 'border-slate-600 text-slate-300 hover:border-rose-500 hover:text-rose-300' : 'border-emerald-600/50 text-emerald-300 hover:bg-emerald-500/10'} disabled:opacity-40`}>
          {s.can_operate ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Display name"
          className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
        <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="app.example.com"
          className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
      </div>
      {connectors.length > 0 && (
        <select value={connectorId} onChange={e => setConnectorId(e.target.value)}
          className="w-full mt-2 rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300">
          <option value="">No linked connector (use the site above)</option>
          {connectors.map(c => <option key={c.id} value={c.id}>{c.name}{c.base_url ? ` — ${c.base_url}` : ''}</option>)}
        </select>
      )}
      {err && <p className="text-[11px] text-rose-400 mt-2">{err}</p>}

      <div className="flex items-center gap-2 mt-3">
        {dirty && <button disabled={busy} onClick={() => save(s.can_operate)} className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Save</button>}
        <button onClick={() => setShowLogin(v => !v)} className="text-[11px] px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-500">{s.has_login ? 'Change login' : 'Set login'}</button>
        {s.has_login && <button disabled={busy} onClick={() => run(() => clearOperateLogin(s.id))} className="text-[11px] px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40">Remove login</button>}
        {s.operate_only && <button disabled={busy} onClick={() => run(() => deleteOperateBinding(s.id))} className="ml-auto text-[11px] px-3 py-1.5 rounded-lg text-slate-500 hover:text-rose-300">Delete</button>}
      </div>

      {showLogin && <LoginForm systemId={s.id} onDone={() => { setShowLogin(false); onChange(); }} onCancel={() => setShowLogin(false)} />}
    </div>
  );
}

function LoginForm({ systemId, onDone, onCancel }: { systemId: string; onDone: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!password) { setErr('Enter the password.'); return; }
    setBusy(true); setErr('');
    // Stored as the mig-243 convention: JSON {username,password} or a bare password.
    const secret = username ? JSON.stringify({ username, password }) : password;
    try { await setOperateLogin(systemId, secret); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <p className="text-[11px] text-slate-500 mb-2">Stored encrypted in the vault. The employee never sees it — the browser worker types it into the app's login for you.</p>
      <div className="grid grid-cols-2 gap-2">
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username (optional)" autoComplete="off"
          className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Password" autoComplete="new-password"
          className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
      </div>
      {err && <p className="text-[11px] text-rose-400 mt-2">{err}</p>}
      <div className="flex gap-2 mt-2">
        <button disabled={busy} onClick={save} className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Save login</button>
        <button onClick={onCancel} className="text-[11px] px-3 py-1.5 text-slate-400 hover:text-slate-200">Cancel</button>
      </div>
    </div>
  );
}

function AddBindingForm({ deId, connectors, onCancel, onDone }: { deId: string; connectors: DeOperateConfig['connectors']; onCancel: () => void; onDone: () => void }) {
  const [systemKey, setSystemKey] = useState('');
  const [label, setLabel] = useState('');
  const [domain, setDomain] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const keyOk = /^[a-z0-9_]+$/.test(systemKey);
  const valid = keyOk && (domain.trim() !== '' || connectorId !== '');

  const submit = async () => {
    if (!valid) return;
    setBusy(true); setErr('');
    try {
      await upsertOperateBinding({ deId, systemId: null, systemKey, label: label || systemKey, canOperate: true, operateDomain: domain || null, connectorId: connectorId || null });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not add.'); setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/5 p-4">
      <div className="text-sm font-medium text-slate-100 mb-3">Add an app to operate</div>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <input value={systemKey} onChange={e => setSystemKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="key e.g. quickbooks"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 font-mono" />
            {systemKey && !keyOk && <p className="text-[10px] text-rose-400 mt-0.5">lowercase letters, numbers, _ only</p>}
          </div>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Display name e.g. QuickBooks"
            className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
        </div>
        <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="Site it runs on e.g. app.qbo.intuit.com"
          className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600" />
        {connectors.length > 0 && (
          <select value={connectorId} onChange={e => setConnectorId(e.target.value)}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300">
            <option value="">Or link a connector for the site…</option>
            {connectors.map(c => <option key={c.id} value={c.id}>{c.name}{c.base_url ? ` — ${c.base_url}` : ''}</option>)}
          </select>
        )}
      </div>
      {err && <p className="text-[11px] text-rose-400 mt-2">{err}</p>}
      <div className="flex gap-2 mt-3">
        <button disabled={!valid || busy} onClick={submit} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">{busy ? 'Adding…' : 'Add app'}</button>
        <button onClick={onCancel} className="text-xs px-3 py-1.5 text-slate-400 hover:text-slate-200">Cancel</button>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-200 mb-1">{label}</label>
      {hint && <p className="text-xs text-slate-500 mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}
function Meta({ k, v }: { k: string; v: string }) {
  return <div><div className="text-slate-500">{k}</div><div className="text-slate-200">{v}</div></div>;
}

export default BrowserOperatorPage;
