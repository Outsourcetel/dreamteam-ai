import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import { PageHeader } from '../../../components/ui';
import { CustomerApiError, listAccounts } from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import {
  PHASES, listTemplates, createTemplate, saveTemplateDraft, deleteTemplate, publishTemplate,
  installStarterTemplate, listPublishedVersions, getTemplateVersion,
  listProjects, createProject, updateItem, setProjectStatus, currentPhase, daysUntil,
} from '../../../lib/onboardingApi';
import type {
  OnboardingTemplate, TemplateVersion, TemplateItem, OnboardingProject,
  ProjectItemState, OnboardingItemStatus, OnboardingPhase,
} from '../../../lib/onboardingApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Customer Onboarding — LIVE (migration 022).
// Implementation workspace: onboarding projects run against IMMUTABLE
// published template versions. Items carry status/assignee/note;
// requires_signoff items gate through Human Tasks (review_gate) and
// the project auto-completes server-side when everything is done or
// signed off. Assignees are free text in v1 (people directory is
// still demo data). DE-assisted column mapping / config drafting is
// the R1-activation upgrade — not built yet.
// ============================================================

const inputCls = 'bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500';
const btnPrimary = 'text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors';
const btnGhost = 'text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors';

const STATUS_META: Record<OnboardingItemStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-slate-800 text-slate-400' },
  in_progress: { label: 'In progress', cls: 'bg-indigo-500/15 text-indigo-300' },
  done: { label: 'Done', cls: 'bg-emerald-500/15 text-emerald-300' },
  blocked: { label: 'Blocked', cls: 'bg-red-500/15 text-red-300' },
  signed_off: { label: 'Signed off', cls: 'bg-emerald-500/25 text-emerald-200' },
};

const PROJECT_STATUS_CLS: Record<OnboardingProject['status'], string> = {
  active: 'bg-indigo-500/15 text-indigo-300',
  on_hold: 'bg-amber-500/15 text-amber-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  cancelled: 'bg-slate-700/50 text-slate-400',
};

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-slate-300 w-9 text-right">{pct}%</span>
    </div>
  );
}

// ── Project detail (phase-grouped checklist) ─────────────────────
function ProjectDetail({ project, onBack, onChanged, setPage }: {
  project: OnboardingProject; onBack: () => void; onChanged: () => void;
  setPage?: (p: Page) => void;
}) {
  const [version, setVersion] = useState<TemplateVersion | null>(null);
  const [proj, setProj] = useState<OnboardingProject>(project);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [assigneeDrafts, setAssigneeDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try { setVersion(await getTemplateVersion(project.template_version_id)); }
      catch (e) { setErr((e as Error).message); }
    })();
  }, [project.template_version_id]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const stateOf = useCallback(
    (key: string): ProjectItemState => proj.items_state.find(s => s.key === key)
      ?? { key, status: 'pending', assignee: null },
    [proj.items_state],
  );

  const applyUpdate = async (key: string, changes: { status?: OnboardingItemStatus; assignee?: string; note?: string }) => {
    setBusyKey(key); setErr(null);
    try {
      const res = await updateItem(proj.id, key, changes);
      setProj(res.project);
      if (res.signoff_task_id) setToast('Item done — a sign-off task was created in Human Tasks. The item locks in once a human approves it.');
      if (res.completed) setToast('All items complete — project marked completed. 🎉');
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusyKey(null); }
  };

  const changeProjectStatus = async (status: 'active' | 'on_hold' | 'cancelled') => {
    if (status === 'cancelled' && !window.confirm('Cancel this onboarding project? This cannot be undone.')) return;
    setStatusBusy(true); setErr(null);
    try {
      await setProjectStatus(proj.id, status);
      setProj({ ...proj, status });
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setStatusBusy(false); }
  };

  const days = daysUntil(proj.target_golive);
  const phase = version ? currentPhase(version.items, proj.items_state) : null;
  const editable = proj.status === 'active';

  return (
    <div>
      <button onClick={onBack} className="text-xs text-slate-400 hover:text-white mb-3 transition-colors">← All projects</button>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-4">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
          <div>
            <h3 className="text-white font-semibold">{proj.name}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {proj.customer_accounts?.name || project.customer_accounts?.name || 'Account'}
              {version && <> · {version.name} v{version.version}</>}
              {proj.target_golive && (
                <> · target go-live {proj.target_golive}
                  {days !== null && proj.status === 'active' && (
                    <span className={days < 0 ? 'text-red-300' : days <= 7 ? 'text-amber-300' : 'text-slate-500'}>
                      {' '}({days < 0 ? `${-days}d overdue` : `${days}d left`})
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full ${PROJECT_STATUS_CLS[proj.status]}`}>{proj.status.replace('_', ' ')}</span>
            {proj.status === 'active' && (
              <>
                <button onClick={() => void changeProjectStatus('on_hold')} disabled={statusBusy} className={btnGhost}>Hold</button>
                <button onClick={() => void changeProjectStatus('cancelled')} disabled={statusBusy} className={`${btnGhost} !text-red-300 hover:!border-red-800`}>Cancel</button>
              </>
            )}
            {proj.status === 'on_hold' && (
              <button onClick={() => void changeProjectStatus('active')} disabled={statusBusy} className={btnPrimary}>Resume</button>
            )}
          </div>
        </div>
        <ProgressBar pct={proj.progress_pct} />
        {phase && proj.status === 'active' && (
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {PHASES.map(p => {
              const active = p.key === phase;
              const past = PHASES.findIndex(x => x.key === p.key) < PHASES.findIndex(x => x.key === phase);
              return (
                <span key={p.key} className={`text-[10px] px-2 py-0.5 rounded-full border ${
                  active ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                  : past ? 'border-emerald-800/50 bg-emerald-500/10 text-emerald-300' : 'border-slate-800 text-slate-500'
                }`}>{past ? '✓ ' : ''}{p.label}</span>
              );
            })}
          </div>
        )}
      </div>

      {toast && <div className="mb-3 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-300">✓ {toast}</div>}
      {err && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">{err}</div>}

      {!version ? <LiveLoadingSkeleton rows={5} /> : (
        PHASES.map(p => {
          const items = version.items.filter(i => i.phase === p.key);
          if (items.length === 0) return null;
          return (
            <div key={p.key} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">{p.label}</p>
              <div className="space-y-2">
                {items.map(item => {
                  const st = stateOf(item.key);
                  const busy = busyKey === item.key;
                  const locked = st.status === 'signed_off' || !editable;
                  const awaitingSignoff = st.status === 'done' && item.requires_signoff && !!st.signoff_task_id;
                  return (
                    <div key={item.key} className={`rounded-xl border p-3 ${awaitingSignoff ? 'border-amber-800/50 bg-amber-500/5' : 'border-slate-800 bg-slate-950/50'}`}>
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex-1 min-w-[180px]">
                          <p className="text-sm text-white">{item.label}
                            {item.requires_signoff && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 align-middle">sign-off</span>}
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 align-middle">{item.owner_type}</span>
                          </p>
                          {item.description && <p className="text-[11px] text-slate-500 mt-0.5">{item.description}</p>}
                          {st.note && <p className="text-[11px] text-amber-200/80 mt-1">📝 {st.note}</p>}
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_META[st.status].cls}`}>{STATUS_META[st.status].label}</span>
                        {!locked && !awaitingSignoff && (
                          <select
                            value={st.status === 'signed_off' ? 'done' : st.status}
                            disabled={busy}
                            onChange={e => void applyUpdate(item.key, { status: e.target.value as OnboardingItemStatus })}
                            className={`${inputCls} !py-1 !px-2 !text-xs !rounded-lg`}
                          >
                            <option value="pending">Pending</option>
                            <option value="in_progress">In progress</option>
                            <option value="blocked">Blocked</option>
                            <option value="done">Done{item.requires_signoff ? ' → sign-off' : ''}</option>
                          </select>
                        )}
                        {!locked && (
                          <input
                            placeholder="Assignee"
                            defaultValue={st.assignee ?? ''}
                            disabled={busy}
                            onChange={e => setAssigneeDrafts(d => ({ ...d, [item.key]: e.target.value }))}
                            onBlur={() => {
                              const v = assigneeDrafts[item.key];
                              if (v !== undefined && v !== (st.assignee ?? '')) void applyUpdate(item.key, { assignee: v });
                            }}
                            className={`${inputCls} !py-1 !px-2 !text-xs !rounded-lg w-28`}
                            title="Free-text in v1 — the people directory is still demo data"
                          />
                        )}
                        {!locked && (
                          <button onClick={() => { setNoteKey(noteKey === item.key ? null : item.key); setNoteDraft(st.note ?? ''); }}
                            className="text-xs text-slate-500 hover:text-white transition-colors" disabled={busy}>
                            {st.note ? 'Edit note' : '+ Note'}
                          </button>
                        )}
                      </div>
                      {awaitingSignoff && (
                        <p className="text-[11px] text-amber-300 mt-2">
                          ⚠ Awaiting human sign-off — decide it in{' '}
                          <button className="underline hover:text-amber-200" onClick={() => setPage?.('ops_human_tasks')}>Human Tasks</button>, then reload this page.
                        </p>
                      )}
                      {noteKey === item.key && (
                        <div className="flex gap-2 mt-2">
                          <input value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="Add a note for this item…" className={`${inputCls} flex-1 !py-1.5 !text-xs`} />
                          <button className={btnPrimary} disabled={busy}
                            onClick={() => { void applyUpdate(item.key, { note: noteDraft }); setNoteKey(null); }}>Save</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── New project modal ─────────────────────────────────────────────
function NewProjectModal({ accounts, versions, onClose, onCreated }: {
  accounts: CustomerAccount[]; versions: TemplateVersion[];
  onClose: () => void; onCreated: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // latest version per template only
  const latest = useMemo(() => {
    const seen = new Set<string>();
    return versions.filter(v => {
      if (seen.has(v.template_id)) return false;
      seen.add(v.template_id);
      return true;
    });
  }, [versions]);

  const create = async () => {
    if (!accountId || !versionId) return;
    setSaving(true); setErr(null);
    try {
      await createProject(accountId, versionId, name.trim() || undefined, target || undefined);
      onCreated();
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-white font-semibold mb-4">New onboarding project</h3>
        <div className="space-y-3 mb-5">
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Customer account</label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)} className={`w-full ${inputCls}`}>
              <option value="">Pick an account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Template (published)</label>
            <select value={versionId} onChange={e => setVersionId(e.target.value)} className={`w-full ${inputCls}`}>
              {latest.map(v => <option key={v.id} value={v.id}>{v.name} · v{v.version} ({v.items.length} items)</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Project name (optional)</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Defaults to account — template" className={`w-full ${inputCls}`} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Target go-live (optional)</label>
            <input type="date" value={target} onChange={e => setTarget(e.target.value)} className={`w-full ${inputCls}`} />
          </div>
        </div>
        {err && <p className="text-[11px] text-rose-400 mb-3">✗ {err}</p>}
        <div className="flex gap-3">
          <button onClick={() => void create()} disabled={saving || !accountId || !versionId}
            className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all">
            {saving ? 'Creating…' : 'Create project'}
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Template editor ───────────────────────────────────────────────
function TemplateEditor({ template, onClose, onSaved }: {
  template: OnboardingTemplate; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [items, setItems] = useState<TemplateItem[]>(template.items);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const addItem = () => {
    let n = items.length + 1;
    while (items.some(i => i.key === `item_${n}`)) n++;
    setItems([...items, { key: `item_${n}`, label: '', phase: 'kickoff', owner_type: 'human', requires_signoff: false }]);
  };
  const setItem = (idx: number, patch: Partial<TemplateItem>) =>
    setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next);
  };
  const remove = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const save = async (): Promise<boolean> => {
    setBusy('save'); setErrors([]); setMsg(null);
    try {
      // derive stable-ish keys from labels for new items still named item_N
      const normalized = items.map(it => ({
        ...it,
        key: it.key.startsWith('item_') && it.label.trim()
          ? it.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || it.key
          : it.key,
      }));
      await saveTemplateDraft(template.id, { name, description, items: normalized });
      setItems(normalized);
      setMsg('Draft saved.');
      onSaved();
      return true;
    } catch (e) { setErrors([(e as Error).message]); return false; }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!(await save())) return;
    setBusy('publish'); setErrors([]); setMsg(null);
    try {
      const res = await publishTemplate(template.id);
      if (res.errors?.length) { setErrors(res.errors); return; }
      setMsg(`Published v${res.version}. Projects created from now on bind to this snapshot.`);
      onSaved();
    } catch (e) { setErrors([(e as Error).message]); }
    finally { setBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-white font-semibold">Edit template</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Template name" className={inputCls} />
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" className={inputCls} />
        </div>

        <div className="space-y-2 mb-4">
          {items.map((it, idx) => (
            <div key={idx} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 flex items-center gap-2 flex-wrap">
              <div className="flex flex-col gap-0.5">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-slate-600 hover:text-white disabled:opacity-30 text-xs leading-none">▲</button>
                <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1} className="text-slate-600 hover:text-white disabled:opacity-30 text-xs leading-none">▼</button>
              </div>
              <input value={it.label} onChange={e => setItem(idx, { label: e.target.value })} placeholder="Item label" className={`${inputCls} flex-1 min-w-[160px] !py-1.5 !text-xs`} />
              <select value={it.phase} onChange={e => setItem(idx, { phase: e.target.value as OnboardingPhase })} className={`${inputCls} !py-1.5 !text-xs`}>
                {PHASES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <select value={it.owner_type} onChange={e => setItem(idx, { owner_type: e.target.value as TemplateItem['owner_type'] })} className={`${inputCls} !py-1.5 !text-xs`}>
                <option value="human">Human</option>
                <option value="de">DE</option>
                <option value="either">Either</option>
              </select>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400 whitespace-nowrap">
                <input type="checkbox" checked={it.requires_signoff} onChange={e => setItem(idx, { requires_signoff: e.target.checked })} className="accent-amber-500" />
                sign-off
              </label>
              <button onClick={() => remove(idx)} className="text-slate-600 hover:text-red-300 text-sm">✕</button>
            </div>
          ))}
          <button onClick={addItem} className={btnGhost}>+ Add item</button>
        </div>

        {errors.length > 0 && (
          <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-2.5">
            {errors.map((e, i) => <p key={i} className="text-xs text-rose-300">✗ {e}</p>)}
          </div>
        )}
        {msg && <p className="text-xs text-emerald-300 mb-3">✓ {msg}</p>}

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => void save()} disabled={busy !== null} className={btnGhost}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
          <button onClick={() => void publish()} disabled={busy !== null} className={btnPrimary}>{busy === 'publish' ? 'Publishing…' : `Publish v${template.version + 1}`}</button>
          <p className="text-[10px] text-slate-600">Publishing snapshots the checklist — running projects keep the version they started on. Sign-off items must be owned by human or either.</p>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────
export default function CustomerOnboardingLive({ setPage }: { setPage?: (p: Page) => void }) {
  const { liveTenantName } = useAuth();
  const [tab, setTab] = useState<'projects' | 'templates'>('projects');
  const [projects, setProjects] = useState<OnboardingProject[]>([]);
  const [templates, setTemplates] = useState<OnboardingTemplate[]>([]);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<OnboardingProject | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editTemplate, setEditTemplate] = useState<OnboardingTemplate | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [p, t, v, a] = await Promise.all([listProjects(), listTemplates(), listPublishedVersions(), listAccounts()]);
      setProjects(p); setTemplates(t); setVersions(v); setAccounts(a);
      setMissingTables(false);
      setDetail(d => (d ? p.find(x => x.id === d.id) ?? d : d));
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load onboarding data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const installStarter = async () => {
    setBusy(true); setError(null);
    try {
      const res = await installStarterTemplate();
      setToast(res.already_installed ? 'Starter template already installed.' : 'Starter template installed and published — create your first project.');
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const createBlankTemplate = async () => {
    setBusy(true); setError(null);
    try {
      const t = await createTemplate('New onboarding template', '');
      await refresh();
      setEditTemplate(t);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const removeTemplate = async (t: OnboardingTemplate) => {
    if (!window.confirm(`Delete template "${t.name}"? Published versions already used by projects are kept.`)) return;
    setBusy(true);
    try { await deleteTemplate(t.id); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const activeProjects = projects.filter(p => p.status === 'active');
  const hasPublished = versions.length > 0;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <PageHeader
          title="Onboarding — Customer Lifecycle"
          subtitle={`${liveTenantName || 'Your company'} · implementation projects on templated checklists with human sign-off gates`}
        />
        {!missingTables && !loading && !detail && (
          <div className="flex gap-2">
            {tab === 'projects' && hasPublished && accounts.length > 0 && (
              <button onClick={() => setShowNew(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors">+ New project</button>
            )}
            {tab === 'templates' && (
              <>
                <button onClick={() => void installStarter()} disabled={busy} className={btnGhost}>Install starter template</button>
                <button onClick={() => void createBlankTemplate()} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-40">+ New template</button>
              </>
            )}
          </div>
        )}
      </div>

      {toast && <div className="mb-4 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">✓ {toast}</div>}
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? <LiveLoadingSkeleton rows={5} /> : missingTables ? <MissingTablesNotice /> : detail ? (
        <ProjectDetail project={detail} setPage={setPage}
          onBack={() => { setDetail(null); void refresh(); }} onChanged={() => void refresh()} />
      ) : (
        <>
          <div className="flex gap-1 mb-5 border-b border-slate-800">
            {(['projects', 'templates'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}>
                {t === 'projects' ? `Projects (${projects.length})` : `Templates (${templates.length})`}
              </button>
            ))}
          </div>

          {tab === 'projects' && (
            projects.length === 0 ? (
              <LiveEmptyState
                icon="▤"
                title="No onboarding projects yet"
                body={hasPublished
                  ? 'Create your first implementation project — pick a customer account and a published checklist template.'
                  : 'Start by installing the 10-step starter template (kickoff → data → config → validation → go-live with human sign-off gates), then create your first project.'}
                primaryLabel={hasPublished ? (accounts.length > 0 ? 'New project' : undefined) : 'Install starter template'}
                onPrimary={hasPublished ? (accounts.length > 0 ? () => setShowNew(true) : undefined) : () => void installStarter()}
                secondaryLabel={!hasPublished ? 'Build a template from scratch' : undefined}
                onSecondary={!hasPublished ? () => { setTab('templates'); void createBlankTemplate(); } : undefined}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                  {[
                    { label: 'Active projects', value: String(activeProjects.length), color: 'text-white' },
                    { label: 'Completed', value: String(projects.filter(p => p.status === 'completed').length), color: 'text-emerald-300' },
                    { label: 'Avg progress (active)', value: activeProjects.length ? `${Math.round(activeProjects.reduce((s, p) => s + p.progress_pct, 0) / activeProjects.length)}%` : '—', color: 'text-indigo-300' },
                    { label: 'Go-lives in 14d', value: String(activeProjects.filter(p => { const d = daysUntil(p.target_golive); return d !== null && d >= 0 && d <= 14; }).length), color: 'text-amber-300' },
                  ].map(s => (
                    <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
                      <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                    </div>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {projects.map(p => {
                    const days = daysUntil(p.target_golive);
                    return (
                      <button key={p.id} onClick={() => setDetail(p)}
                        className="text-left rounded-2xl border border-slate-800 bg-slate-900/50 p-4 hover:border-slate-600 transition-colors">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="text-sm font-medium text-white truncate">{p.customer_accounts?.name || p.name}</p>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${PROJECT_STATUS_CLS[p.status]}`}>{p.status.replace('_', ' ')}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 truncate mb-3">{p.name}</p>
                        <ProgressBar pct={p.progress_pct} />
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] text-slate-600">{p.items_state.filter(s => s.status === 'done' || s.status === 'signed_off').length}/{p.items_state.length} items</span>
                          {p.status === 'active' && days !== null && (
                            <span className={`text-[10px] ${days < 0 ? 'text-red-300' : days <= 7 ? 'text-amber-300' : 'text-slate-500'}`}>
                              go-live {days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : `in ${days}d`}
                            </span>
                          )}
                          {p.status === 'completed' && p.completed_at && (
                            <span className="text-[10px] text-emerald-400">✓ {new Date(p.completed_at).toLocaleDateString()}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )
          )}

          {tab === 'templates' && (
            templates.length === 0 ? (
              <LiveEmptyState
                icon="≡"
                title="No templates yet"
                body="Templates are your reusable implementation checklists. Install the SaaS starter (10 items, 4 sign-off gates) or build one from scratch."
                primaryLabel="Install starter template"
                onPrimary={() => void installStarter()}
                secondaryLabel="New template"
                onSecondary={() => void createBlankTemplate()}
              />
            ) : (
              <div className="space-y-2">
                {templates.map(t => (
                  <div key={t.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[200px]">
                      <p className="text-sm font-medium text-white">{t.name}
                        <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded align-middle ${t.status === 'published' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                          {t.status === 'published' ? `published v${t.version}` : t.version > 0 ? `draft (v${t.version} live)` : 'draft'}
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{t.items.length} items · {t.items.filter(i => i.requires_signoff).length} sign-off gates{t.description ? ` · ${t.description}` : ''}</p>
                    </div>
                    <button onClick={() => setEditTemplate(t)} className={btnGhost}>Edit</button>
                    <button onClick={() => void removeTemplate(t)} className={`${btnGhost} !text-red-300 hover:!border-red-800`} disabled={busy}>Delete</button>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {showNew && (
        <NewProjectModal accounts={accounts} versions={versions}
          onClose={() => setShowNew(false)} onCreated={() => { setToast('Project created.'); void refresh(); }} />
      )}
      {editTemplate && (
        <TemplateEditor template={editTemplate} onClose={() => setEditTemplate(null)} onSaved={() => void refresh()} />
      )}
    </div>
  );
}
