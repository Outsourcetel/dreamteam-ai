import { useEffect, useMemo, useState } from 'react';
import type { Page } from '../../../types';
import {
  getBrowserOperator, getBrowserTask, proposeBrowserTask, decideBrowserTask, listDEsLite,
  getDeOperateConfig, upsertOperateBinding, setOperateLogin, clearOperateLogin, deleteOperateBinding,
  type BrowserOperatorState, type BrowserTaskRow, type BrowserTaskDetail, type BrowserEngine,
  type CredentialPolicy, type DeLite, type DeOperateConfig, type OperateSystem,
} from '../../../lib/browserOperatorApi';
import {
  Chip, Banner, Button, Field, INPUT_CLS, EmptyState, Modal, Drawer, TimelineStep, type Tone,
} from '../../../design/primitives';

// ── status vocabulary — one glance tells you where a task is (Chip tones) ──
const STATUS: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  pending_approval: { label: 'Awaiting your approval', tone: 'warn' },
  approved:         { label: 'Approved · queued',      tone: 'info' },
  claimed:          { label: 'Starting',               tone: 'accent' },
  running:          { label: 'Running',                tone: 'accent', pulse: true },
  done:             { label: 'Done',                   tone: 'ok' },
  failed:           { label: 'Failed',                 tone: 'danger' },
  rejected:         { label: 'Declined',               tone: 'neutral' },
  expired:          { label: 'Expired',                tone: 'neutral' },
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
    <div className="px-6 py-8 text-dt-body">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-dt-title">Browser Operator</h1>
          <p className="text-sm text-dt-support mt-1 max-w-2xl">
            Let a digital employee do a task in a real web browser — look something up, fill a form, check a portal —
            on the sites you allow. Nothing runs until <span className="text-dt-body">you approve it</span>, and every click is recorded.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Chip tone={runtimeOnline ? 'ok' : 'neutral'} dot pulse={runtimeOnline}>
            {runtimeOnline ? `${(state?.runtimes ?? []).filter(r => r.active).length} browser connected` : 'No browser connected'}
          </Chip>
          <Button kind="secondary" onClick={() => setShowConfig(true)}>Configure apps</Button>
          <Button kind="primary" onClick={() => setShowNew(true)}>+ New task</Button>
        </div>
      </div>

      {error && <Banner tone="danger" className="mb-5">{error}</Banner>}
      {state && !state.enabled && (
        <Banner tone="warn" className="mb-5">
          Browser Operator is currently <b>off</b> for this workspace — a safety default. Turn it on in Feature settings before tasks can run.
        </Banner>
      )}
      {state && state.enabled && !runtimeOnline && (
        <Banner tone="neutral" className="mb-5">
          No browser worker is connected yet, so approved tasks stay safely queued. Connect a browser runtime (free, self-hosted) and it will pick them up automatically.
        </Banner>
      )}

      {loading && !state && <div className="text-sm text-dt-muted py-16 text-center">Loading…</div>}

      {state && (
        <div className="space-y-8">
          <Section title="Waiting for you" count={pending.length} hint="Approve or decline what a digital employee wants to do.">
            {pending.length === 0
              ? <EmptyState headline="Nothing needs your approval right now." />
              : pending.map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>

          <Section title="In progress" count={active.length}>
            {active.length === 0
              ? <EmptyState headline="No tasks are running." />
              : active.map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>

          <Section title="History" count={finished.length}>
            {finished.length === 0
              ? <EmptyState headline="Completed tasks will appear here, each with a full step-by-step replay." />
              : finished.slice(0, 30).map(t => <TaskCard key={t.id} t={t} onOpen={() => setOpenTaskId(t.id)} />)}
          </Section>
        </div>
      )}

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); load(); }} />}
      {showConfig && <OperateConfigDrawer onClose={() => setShowConfig(false)} />}
      {openTaskId && <TaskDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} onChange={load} />}

      <div className="mt-10 text-xs text-dt-muted">
        Safety: tasks only run on the exact sites you allow, stop at their step limit, never see your passwords, and
        pause for your confirmation before anything irreversible. <button className="underline hover:text-dt-support" onClick={() => setPage('workforce_des')}>Back to workforce</button>
      </div>
    </div>
  );
};

// ── page-specific pieces (compose from primitives) ──
function Section({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-semibold text-dt-body uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-dt-muted">{count}</span>
        {hint && <span className="text-xs text-dt-faint ml-2">{hint}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function DomainChips({ domains }: { domains: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {domains.map(d => <Chip key={d} tone="neutral">{d}</Chip>)}
    </div>
  );
}
function TaskCard({ t, onOpen }: { t: BrowserTaskRow; onOpen: () => void }) {
  const s = STATUS[t.status] ?? STATUS.pending_approval;
  return (
    <button onClick={onOpen} className="w-full text-left rounded-xl border border-dt-border bg-dt-card hover:bg-dt-panel hover:border-dt-border-strong transition-colors px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-dt-title truncate block">{t.title || t.goal}</span>
          {t.title && <p className="text-xs text-dt-support mt-0.5 line-clamp-1">{t.goal}</p>}
          <div className="mt-2"><DomainChips domains={t.allowed_domains} /></div>
        </div>
        <Chip tone={s.tone} dot pulse={s.pulse} className="shrink-0">{s.label}</Chip>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dt-muted">
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
          <select value={deId} onChange={e => setDeId(e.target.value)} className={INPUT_CLS}>
            {des.length === 0 && <option value="">No active employees</option>}
            {des.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="What should it do?" hint="Describe the task in plain language (min 10 characters).">
          <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={3} placeholder="e.g. Log in to the shipping portal and find the tracking status for order #10432, then report it back."
            className={INPUT_CLS} />
        </Field>
        <Field label="Allowed sites" hint="It can ONLY visit these. Add each site it needs.">
          <div className="flex gap-2">
            <input value={domainInput} onChange={e => setDomainInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
              placeholder="portal.example.com" className={INPUT_CLS} />
            <Button kind="secondary" onClick={addDomain}>Add</Button>
          </div>
          {domains.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {domains.map(d => (
                <Chip key={d} tone="neutral">
                  {d}<button onClick={() => setDomains(domains.filter(x => x !== d))} className="text-dt-muted hover:text-dt-danger ml-0.5">×</button>
                </Chip>
              ))}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="How it works" hint="Reading the page is faster & cheaper. Use 'sees the screen' only for tricky visual sites.">
            <select value={engine} onChange={e => setEngine(e.target.value as BrowserEngine)} className={INPUT_CLS}>
              <option value="browser_dom">Reads the page (recommended)</option>
              <option value="browser_vision">Sees the screen</option>
            </select>
          </Field>
          <Field label="Step limit" hint="It stops after this many actions.">
            <input type="number" min={1} max={50} value={maxSteps} onChange={e => setMaxSteps(Math.max(1, Math.min(50, Number(e.target.value) || 15)))}
              className={INPUT_CLS} />
          </Field>
        </div>
        <Field label="Logging in" hint="It never sees your passwords. Vault login types stored credentials for it; 'you log in' hands you the browser to sign in first.">
          <select value={cred} onChange={e => setCred(e.target.value as CredentialPolicy)} className={INPUT_CLS}>
            <option value="none">No login needed</option>
            <option value="vault_injected">Use a stored (vault) login</option>
            <option value="human_login">You log in first</option>
          </select>
        </Field>
        {err && <p className="text-xs text-dt-danger">{err}</p>}
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-dt-muted">This creates an approval request — nothing runs until you approve it.</p>
          <div className="flex gap-2">
            <Button kind="ghost" onClick={onClose}>Cancel</Button>
            <Button kind="primary" disabled={!valid || busy} onClick={submit}>{busy ? 'Creating…' : 'Create task'}</Button>
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
    <Drawer title={task ? (task.title || 'Browser task') : 'Browser task'} onClose={onClose}>
      {!task ? <div className="text-sm text-dt-muted">Loading…</div> : (
        <>
          <Chip tone={s.tone} dot pulse={s.pulse}>{s.label}</Chip>
          <p className="text-sm text-dt-body mt-3">{task.goal}</p>
          <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
            <Meta k="Employee" v={task.de_name ?? '—'} />
            <Meta k="How it works" v={ENGINE_LABEL[task.engine]} />
            <Meta k="Logging in" v={CRED_LABEL[task.credential_policy]} />
            <Meta k="Step limit" v={String(task.max_steps)} />
          </div>
          <div className="mt-3"><div className="text-xs text-dt-muted mb-1">Allowed sites</div><DomainChips domains={task.allowed_domains} /></div>

          {task.status === 'pending_approval' && (
            <div className="mt-5 rounded-xl border border-dt-warn-border bg-dt-warn-soft p-4">
              <p className="text-sm text-dt-warn mb-3">Approve this employee to run the task in a browser? It stays within the allowed sites and step limit.</p>
              {err && <p className="text-xs text-dt-danger mb-2">{err}</p>}
              <div className="flex gap-2">
                <Button kind="success" disabled={busy} onClick={() => decide('approved')}>Approve</Button>
                <Button kind="secondary" disabled={busy} onClick={() => decide('rejected')}>Decline</Button>
              </div>
            </div>
          )}

          {task.result && <div className="mt-5"><div className="text-xs text-dt-muted mb-1">Result</div><div className="rounded-lg border border-dt-border bg-dt-card p-3 text-sm text-dt-body whitespace-pre-wrap">{task.result}</div></div>}

          <div className="mt-6">
            <div className="text-xs text-dt-muted mb-2">Step-by-step replay ({task.audit.length})</div>
            {task.audit.length === 0
              ? <p className="text-sm text-dt-muted">No steps yet. Once approved and a browser picks it up, every action it takes appears here.</p>
              : (
                <ol className="space-y-2">
                  {task.audit.map((step, i) => (
                    <TimelineStep key={i} n={step.step ?? i + 1}
                      action={step.action ?? 'action'}
                      detail={<>
                        {step.url && <span className="block text-[11px] text-dt-muted truncate">{step.url}</span>}
                        {step.note && <span className="block mt-0.5">{step.note}</span>}
                        {typeof step.screenshot_ref === 'string' && /^https?:\/\//.test(step.screenshot_ref) &&
                          <img src={step.screenshot_ref} alt={`step ${i + 1}`} className="mt-2 rounded border border-dt-border max-h-40" />}
                      </>}
                    />
                  ))}
                </ol>
              )}
          </div>
        </>
      )}
    </Drawer>
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
    <Drawer title="Apps an employee can operate" onClose={onClose}>
      <p className="text-sm text-dt-support mb-5 max-w-lg -mt-2">
        Give a digital employee permission to work inside a connected app's web pages — e.g. QuickBooks, Xero, Salesforce —
        when there's no direct data connection for the job. It only acts on the app you allow, always asks you first, and never sees a password.
      </p>

      <Field label="Employee">
        <select value={deId} onChange={e => setDeId(e.target.value)} className={INPUT_CLS}>
          {des.length === 0 && <option value="">No active employees</option>}
          {des.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>

      {err && <p className="text-xs text-dt-danger mt-3">{err}</p>}
      {cfg && !cfg.featureEnabled && (
        <Banner tone="warn" className="mt-4">Browser Operator is <b>off</b> for this workspace, so these apps won't run until it's turned on in Feature settings. You can still configure them now.</Banner>
      )}
      {loading && <div className="text-sm text-dt-muted py-8 text-center">Loading…</div>}

      {cfg && !loading && (
        <div className="mt-5 space-y-6">
          <div>
            <div className="text-[10px] font-semibold text-dt-support uppercase tracking-wide mb-2">Can operate ({operable.length})</div>
            {operable.length === 0
              ? <EmptyState headline={`No apps yet — add one below to let ${cfg.de.name} work in it.`} />
              : <div className="space-y-3">{operable.map(s => <SystemCard key={s.id} deId={deId} s={s} connectors={cfg.connectors} onChange={() => loadCfg(deId)} />)}</div>}
          </div>

          {others.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-dt-muted uppercase tracking-wide mb-2">Connected, not operable ({others.length})</div>
              <div className="space-y-3">{others.map(s => <SystemCard key={s.id} deId={deId} s={s} connectors={cfg.connectors} onChange={() => loadCfg(deId)} />)}</div>
            </div>
          )}

          {adding
            ? <AddBindingForm deId={deId} connectors={cfg.connectors} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); loadCfg(deId); }} />
            : <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-dt-border hover:border-dt-accent/60 text-sm text-dt-support hover:text-dt-accent-text py-3 transition-colors">+ Add an app to operate</button>}
        </div>
      )}
    </Drawer>
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
    <div className="rounded-xl border border-dt-border bg-dt-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${s.can_operate ? 'bg-dt-ok' : 'bg-dt-faint'}`} />
            <span className="text-sm font-medium text-dt-title">{s.label}</span>
            <span className="text-[11px] text-dt-muted font-mono">{s.system_key}</span>
          </div>
          <div className="text-[11px] text-dt-muted mt-1">
            {s.resolved_domain ? <>Runs on <span className="text-dt-support">{s.resolved_domain}</span></> : <span className="text-dt-warn">No site set — add one below</span>}
            {' · '}{s.has_login ? <span className="text-dt-ok">Stored login ✓</span> : 'You log in each time'}
          </div>
        </div>
        <Button kind={s.can_operate ? 'ghost' : 'secondary'} size="sm" disabled={busy} onClick={() => save(!s.can_operate)}>
          {s.can_operate ? 'Turn off' : 'Turn on'}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Display name" className={INPUT_CLS} />
        <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="app.example.com" className={INPUT_CLS} />
      </div>
      {connectors.length > 0 && (
        <select value={connectorId} onChange={e => setConnectorId(e.target.value)} className={`${INPUT_CLS} mt-2`}>
          <option value="">No linked connector (use the site above)</option>
          {connectors.map(c => <option key={c.id} value={c.id}>{c.name}{c.base_url ? ` — ${c.base_url}` : ''}</option>)}
        </select>
      )}
      {err && <p className="text-[11px] text-dt-danger mt-2">{err}</p>}

      <div className="flex items-center gap-2 mt-3">
        {dirty && <Button kind="primary" size="sm" disabled={busy} onClick={() => save(s.can_operate)}>Save</Button>}
        <Button kind="secondary" size="sm" onClick={() => setShowLogin(v => !v)}>{s.has_login ? 'Change login' : 'Set login'}</Button>
        {s.has_login && <Button kind="ghost" size="sm" disabled={busy} onClick={() => run(() => clearOperateLogin(s.id))}>Remove login</Button>}
        {s.operate_only && <Button kind="ghost" size="sm" disabled={busy} className="ml-auto hover:text-dt-danger" onClick={() => run(() => deleteOperateBinding(s.id))}>Delete</Button>}
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
    <div className="mt-3 rounded-lg border border-dt-border bg-dt-inset p-3">
      <p className="text-[11px] text-dt-muted mb-2">Stored encrypted in the vault. The employee never sees it — the browser worker types it into the app's login for you.</p>
      <div className="grid grid-cols-2 gap-2">
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username (optional)" autoComplete="off" className={INPUT_CLS} />
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Password" autoComplete="new-password" className={INPUT_CLS} />
      </div>
      {err && <p className="text-[11px] text-dt-danger mt-2">{err}</p>}
      <div className="flex gap-2 mt-2">
        <Button kind="primary" size="sm" disabled={busy} onClick={save}>Save login</Button>
        <Button kind="ghost" size="sm" onClick={onCancel}>Cancel</Button>
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
    <div className="rounded-xl border border-dt-accent/40 bg-dt-accent-soft p-4">
      <div className="text-sm font-medium text-dt-title mb-3">Add an app to operate</div>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <input value={systemKey} onChange={e => setSystemKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="key e.g. quickbooks"
              className={`${INPUT_CLS} font-mono`} />
            {systemKey && !keyOk && <p className="text-[10px] text-dt-danger mt-0.5">lowercase letters, numbers, _ only</p>}
          </div>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Display name e.g. QuickBooks" className={INPUT_CLS} />
        </div>
        <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="Site it runs on e.g. app.qbo.intuit.com" className={INPUT_CLS} />
        {connectors.length > 0 && (
          <select value={connectorId} onChange={e => setConnectorId(e.target.value)} className={INPUT_CLS}>
            <option value="">Or link a connector for the site…</option>
            {connectors.map(c => <option key={c.id} value={c.id}>{c.name}{c.base_url ? ` — ${c.base_url}` : ''}</option>)}
          </select>
        )}
      </div>
      {err && <p className="text-[11px] text-dt-danger mt-2">{err}</p>}
      <div className="flex gap-2 mt-3">
        <Button kind="primary" size="sm" disabled={!valid || busy} onClick={submit}>{busy ? 'Adding…' : 'Add app'}</Button>
        <Button kind="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return <div><div className="text-dt-muted">{k}</div><div className="text-dt-body">{v}</div></div>;
}

export default BrowserOperatorPage;
