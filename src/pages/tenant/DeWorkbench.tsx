import React, { useEffect, useState } from 'react';
import {
  getDeMemory, getDeObjectives, getDeWorkItems, getDeTrace, getDeExceptions,
  getDeCertifications, getDeCertStatus, getDeTraining, getTenantCompliancePacks,
  getReplaySources, runReplay,
  getDeMemoryGrouped, forgetMemory, saveObjective, decideException,
  type MemoryRow, type ObjectiveRow, type WorkItemRow, type TraceRow, type ExceptionRow,
  type CertRow, type CertStatus, type TrainingRow, type CompliancePackRow,
  type ReplaySource, type ReplayResult, type MemoryGroup,
} from '../../lib/deWorkbenchApi';
import { extractPdf, extractUrl } from '../../lib/knowledgeApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../components/LiveDataStates';
import BookOfWorkPanel from '../../components/BookOfWorkPanel';
import CaseTimelinePanel from '../../components/CaseTimelinePanel';
import DeliverablesPanel from '../../components/DeliverablesPanel';

// ═══════════════════════════════════════════════════════════════
// DE Workbench — makes the Wave 1-3 muscles VISIBLE. Everything here
// reads real tables (migs 155-163); nothing is mock. This is the
// "what does my DE know / do / decide" surface the platform was
// missing. Empty states are honest — a fresh DE genuinely has none.
// ═══════════════════════════════════════════════════════════════

const SECTIONS = [
  { key: 'memory', label: 'Memory' },
  { key: 'work', label: 'Work' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'replay', label: 'Replay Lab' },
  { key: 'certification', label: 'Certification' },
  { key: 'training', label: 'Training' },
  { key: 'compliance', label: 'Compliance' },
] as const;
type Section = typeof SECTIONS[number]['key'];

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const card = 'bg-slate-800 border border-slate-700 rounded-xl';
const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="text-center text-slate-500 text-sm py-10">{children}</div>
);
const Loading = () => <div className="text-center text-slate-500 text-sm py-10">Loading…</div>;

const statusPill: Record<string, string> = {
  queued: 'bg-slate-600 text-slate-200', running: 'bg-blue-500/20 text-blue-300', done: 'bg-emerald-500/20 text-emerald-300',
  failed: 'bg-rose-500/20 text-rose-300', waiting_human: 'bg-amber-500/20 text-amber-300', cancelled: 'bg-slate-700 text-slate-400',
  open: 'bg-blue-500/20 text-blue-300', in_progress: 'bg-blue-500/20 text-blue-300', achieved: 'bg-emerald-500/20 text-emerald-300',
  blocked: 'bg-amber-500/20 text-amber-300', abandoned: 'bg-slate-700 text-slate-400',
  passed: 'bg-emerald-500/20 text-emerald-300', proposed: 'bg-amber-500/20 text-amber-300',
  approved: 'bg-emerald-500/20 text-emerald-300', denied: 'bg-rose-500/20 text-rose-300',
  completed: 'bg-emerald-500/20 text-emerald-300', assigned: 'bg-slate-600 text-slate-200',
};
const Pill = ({ s }: { s: string }) => (
  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${statusPill[s] ?? 'bg-slate-700 text-slate-400'}`}>{s.replace(/_/g, ' ')}</span>
);

export default function DeWorkbenchPanel({ deId }: { deId: string }) {
  const [section, setSection] = useState<Section>('memory');
  const [loading, setLoading] = useState(true);
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [objectives, setObjectives] = useState<ObjectiveRow[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRow[]>([]);
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [certs, setCerts] = useState<CertRow[]>([]);
  const [certStatus, setCertStatus] = useState<CertStatus | null>(null);
  const [training, setTraining] = useState<TrainingRow[]>([]);
  // Replay Lab
  const [replaySources, setReplaySources] = useState<ReplaySource[]>([]);
  const [replaySel, setReplaySel] = useState<ReplaySource | null>(null);
  const [replayQ, setReplayQ] = useState('');
  const [replayCk, setReplayCk] = useState('');
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [packs, setPacks] = useState<CompliancePackRow[]>([]);

  const [loadError, setLoadError] = useState(false);

  // ── Wave 3: the workbench can now write, not just read. ──
  const [memoryGroups, setMemoryGroups] = useState<MemoryGroup[]>([]);
  const [openMemory, setOpenMemory] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [objOpen, setObjOpen] = useState(false);
  const [objEditId, setObjEditId] = useState<string | null>(null);
  const [objTitle, setObjTitle] = useState('');
  const [objPriority, setObjPriority] = useState(3);
  const [objSaving, setObjSaving] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [excOutcome, setExcOutcome] = useState<Record<string, string>>({});
  const [excLearn, setExcLearn] = useState<Record<string, boolean>>({});
  const [ckLoading, setCkLoading] = useState<null | 'file' | 'url'>(null);
  const [ckUrl, setCkUrl] = useState('');
  const [ckNote, setCkNote] = useState<string | null>(null);
  const [ckError, setCkError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const [m, o, w, t, e, c, cs, tr, p, rs, mg] = await Promise.all([
          getDeMemory(deId), getDeObjectives(deId), getDeWorkItems(deId), getDeTrace(deId),
          getDeExceptions(deId), getDeCertifications(deId), getDeCertStatus(deId), getDeTraining(deId), getTenantCompliancePacks(),
          getReplaySources(deId), getDeMemoryGrouped(deId),
        ]);
        if (cancelled) return;
        setMemory(m); setObjectives(o); setWorkItems(w); setTrace(t);
        setExceptions(e); setCerts(c); setCertStatus(cs); setTraining(tr); setPacks(p);
        setReplaySources(rs); setMemoryGroups(mg);
      } catch {
        // A failed load must NOT masquerade as an honest empty state.
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deId]);

  // ── Write handlers (Wave 3) ────────────────────────────────────
  const reloadMemory = async () => {
    try { setMemoryGroups(await getDeMemoryGrouped(deId)); } catch { /* keep what is shown */ }
  };

  const handleForget = async (memoryId: string) => {
    setForgetting(memoryId); setWriteError(null);
    try { await forgetMemory(memoryId); await reloadMemory(); }
    catch (err) { setWriteError((err as Error).message); }
    setForgetting(null);
  };

  const handleSaveObjective = async () => {
    if (!objTitle.trim()) return;
    setObjSaving(true); setWriteError(null);
    try {
      await saveObjective({ deId, title: objTitle.trim(), id: objEditId ?? undefined, priority: objPriority });
      setObjectives(await getDeObjectives(deId));
      setObjOpen(false); setObjEditId(null); setObjTitle('');
    } catch (err) { setWriteError((err as Error).message); }
    setObjSaving(false);
  };

  const handleCloseObjective = async (o: ObjectiveRow) => {
    setWriteError(null);
    try {
      await saveObjective({ deId, id: o.id, title: o.title, priority: o.priority, status: 'achieved' });
      setObjectives(await getDeObjectives(deId));
    } catch (err) { setWriteError((err as Error).message); }
  };

  const handleDecide = async (exceptionId: string, decision: 'approved' | 'rejected') => {
    setDeciding(exceptionId); setWriteError(null);
    try {
      await decideException({
        exceptionId, decision,
        outcome: excOutcome[exceptionId]?.trim() || undefined,
        learned: !!excLearn[exceptionId],
      });
      setExceptions(await getDeExceptions(deId));
    } catch (err) { setWriteError((err as Error).message); }
    setDeciding(null);
  };

  // Replay counterfactual knowledge can come from a real document or page,
  // not just hand-typed text — same extractors the Knowledge Library uses.
  const handleCkFile = async (file: File) => {
    setCkLoading('file'); setCkError(null); setCkNote(null);
    try {
      const isPdf = /\.pdf$/i.test(file.name);
      const text = isPdf ? (await extractPdf(file)).text : await file.text();
      if (!text.trim()) throw new Error('That file had no readable text in it.');
      setReplayCk(text.slice(0, 20000));
      setCkNote(`Loaded ${file.name} — ${text.length.toLocaleString()} characters${text.length > 20000 ? ' (trimmed to 20,000)' : ''}.`);
    } catch (err) { setCkError((err as Error).message); }
    setCkLoading(null);
  };

  const handleCkUrl = async () => {
    const url = ckUrl.trim();
    if (!url) return;
    setCkLoading('url'); setCkError(null); setCkNote(null);
    try {
      const res = await extractUrl(url);
      if (!res.text?.trim()) throw new Error('Nothing readable came back from that link.');
      setReplayCk(res.text.slice(0, 20000));
      setCkNote(`Loaded "${res.title || url}" — ${res.text.length.toLocaleString()} characters${res.text.length > 20000 ? ' (trimmed to 20,000)' : ''}.`);
      setCkUrl('');
    } catch (err) { setCkError((err as Error).message); }
    setCkLoading(null);
  };

  // Group decision-trace rows by run so a "task" reads as one reasoning chain.
  const runs = React.useMemo(() => {
    const map = new Map<string, TraceRow[]>();
    trace.forEach(r => { const k = r.run_ref ?? r.id; if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); });
    return Array.from(map.entries()).map(([ref, rows]) => ({ ref, rows: rows.sort((a, b) => a.seq - b.seq), kind: rows[0]?.run_kind, at: rows[0]?.created_at }));
  }, [trace]);

  return (
    <div className={`${card} overflow-hidden`}>
      <div className="px-5 py-4 border-b border-slate-700">
        <p className="text-sm font-semibold text-white">Workbench</p>
        <p className="text-xs text-slate-500 mt-0.5">What this employee remembers, works on, decides, and has been certified & trained to do — all live.</p>
      </div>
      <div className="flex flex-wrap gap-1 px-3 pt-3">
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${section === s.key ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="p-5">
        {loading ? <LiveLoadingSkeleton rows={4} /> : loadError ? (
          <div className="text-center py-10">
            <p className="text-sm text-rose-300">Couldn't load this employee's workbench.</p>
            <p className="text-xs text-slate-500 mt-1">Check your connection and reopen this tab to retry.</p>
          </div>
        ) : (
          <>
            {writeError && (
              <div className="mb-3 rounded-lg border border-rose-800/60 bg-rose-900/25 px-3 py-2 text-xs text-rose-200">{writeError}</div>
            )}
            {section === 'memory' && (memoryGroups.length === 0 ? (
              <LiveEmptyState icon="◎" title="No memories yet" body="This employee records what it learns as it works and answers." />
            ) : (
              // Grouped by what each memory is ABOUT. A flat list of 40 rows
              // was unreadable — you could not tell what the employee knew
              // about any one customer without scanning all of it.
              <div className="space-y-2">
                {memoryGroups.map((g, gi) => {
                  const key = `${g.subject_kind ?? 'general'}:${g.subject_ref ?? gi}`;
                  const open = openMemory === key;
                  return (
                    <div key={key} className="bg-slate-900/50 rounded-lg overflow-hidden">
                      <button onClick={() => setOpenMemory(open ? null : key)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/40 transition-colors">
                        <span className="text-slate-600 text-xs">{open ? '▾' : '▸'}</span>
                        <span className="text-sm text-slate-200 flex-1 truncate">
                          {g.subject_ref || g.subject_kind || 'General'}
                          <span className="text-slate-600 text-xs ml-2">{g.subject_kind && g.subject_ref ? g.subject_kind : ''}</span>
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {g.item_count} remembered · strongest {Math.round((g.top_salience ?? 0) * 100)}%
                        </span>
                      </button>
                      {open && (
                        <div className="px-4 pb-3 space-y-2 border-t border-slate-800">
                          {(g.items ?? []).map(it => (
                            <div key={it.id} className="flex items-start gap-3 pt-2">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 flex-shrink-0 mt-0.5">{it.kind}</span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-slate-200">{it.content}</p>
                                <p className="text-[11px] text-slate-600 mt-1">
                                  salience {Math.round(it.salience * 100)}% · {it.source} · {fmt(it.created_at)}
                                </p>
                              </div>
                              {/* A wrong memory keeps steering answers until removed. */}
                              <button
                                onClick={() => void handleForget(it.id)}
                                disabled={forgetting === it.id}
                                title="Remove this memory"
                                className="text-[10px] text-slate-600 hover:text-rose-300 flex-shrink-0 disabled:opacity-40">
                                {forgetting === it.id ? '…' : 'Forget'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {section === 'work' && (
              <div className="space-y-5">
                <BookOfWorkPanel deId={deId} />
                <CaseTimelinePanel deId={deId} />
                <DeliverablesPanel deId={deId} />
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Objectives (goals)</p>
                    <button onClick={() => { setObjOpen(true); setObjEditId(null); setObjTitle(''); setObjPriority(3); }}
                      className="ml-auto text-[11px] text-indigo-400 hover:text-indigo-300">+ Set an objective</button>
                  </div>
                  {objOpen && (
                    <div className="mb-2 rounded-lg border border-slate-600 bg-slate-900/70 p-3 space-y-2">
                      <input value={objTitle} onChange={e => setObjTitle(e.target.value)} autoFocus
                        placeholder="What should this employee be working towards?"
                        className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] text-slate-500">Priority</label>
                        <select value={objPriority} onChange={e => setObjPriority(Number(e.target.value))}
                          className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
                          {[1, 2, 3, 4, 5].map(p => <option key={p} value={p}>P{p}{p === 1 ? ' (highest)' : p === 5 ? ' (lowest)' : ''}</option>)}
                        </select>
                        <button onClick={() => void handleSaveObjective()} disabled={objSaving || !objTitle.trim()}
                          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
                          {objSaving ? 'Saving…' : objEditId ? 'Save changes' : 'Add objective'}
                        </button>
                        <button onClick={() => setObjOpen(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                      </div>
                    </div>
                  )}
                  {objectives.length === 0 && !objOpen ? (
                    <LiveEmptyState icon="◎" title="No objectives set" body="Objectives are goals the employee pursues over time." />
                  ) : (
                    <div className="space-y-2">{objectives.map(o => (
                      <div key={o.id} className="bg-slate-900/50 rounded-lg px-4 py-2.5 flex items-center gap-3">
                        <Pill s={o.status} /><span className="text-sm text-slate-200 flex-1">{o.title}</span>
                        <span className="text-[11px] text-slate-600">P{o.priority}{o.due_at ? ` · due ${fmt(o.due_at)}` : ''}</span>
                        <button onClick={() => { setObjOpen(true); setObjEditId(o.id); setObjTitle(o.title); setObjPriority(o.priority || 3); }}
                          className="text-[10px] text-slate-600 hover:text-indigo-300">Edit</button>
                        {o.status === 'active' && (
                          <button onClick={() => void handleCloseObjective(o)}
                            className="text-[10px] text-slate-600 hover:text-emerald-300">Done</button>
                        )}
                      </div>
                    ))}</div>
                  )}
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Work queue (tasks)</p>
                  {workItems.length === 0 ? (
                    <LiveEmptyState icon="◎" title="Nothing queued" body="Tasks the employee works autonomously appear here." />
                  ) : (
                    <div className="space-y-2">{workItems.map(w => (
                      <div key={w.id} className="bg-slate-900/50 rounded-lg px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <Pill s={w.status} /><span className="text-sm text-slate-200 flex-1">{w.title}</span>
                          <span className="text-[11px] text-slate-600">{w.kind}{w.attempts > 1 ? ` · ${w.attempts} tries` : ''} · {fmt(w.scheduled_for)}</span>
                        </div>
                        {w.result?.summary ? <p className="text-xs text-slate-400 mt-1.5 pl-1">{String(w.result.summary).slice(0, 240)}</p> : null}
                        {w.last_error ? <p className="text-xs text-rose-400/80 mt-1 pl-1">{w.last_error}</p> : null}
                      </div>
                    ))}</div>
                  )}
                </div>
              </div>
            )}

            {section === 'reasoning' && (runs.length === 0 ? (
              <LiveEmptyState icon="◎" title="No decision traces yet" body="When this employee works a task, every step it takes and why is recorded here." />
            ) : (
              <div className="space-y-4">
                {runs.map(run => (
                  <div key={run.ref} className="bg-slate-900/50 rounded-lg p-4">
                    <p className="text-[11px] text-slate-500 mb-2">{run.kind} · {fmt(run.at)}</p>
                    <ol className="space-y-1.5">
                      {run.rows.map(r => (
                        <li key={r.id} className="flex items-start gap-2 text-xs">
                          <span className="text-slate-600 font-mono flex-shrink-0">{r.seq}.</span>
                          <div className="min-w-0">
                            {r.tool && <span className="text-indigo-300 font-medium">{r.tool}</span>}
                            {r.thought && <span className="text-slate-300">{r.tool ? ' — ' : ''}{r.thought}</span>}
                            {r.outputs ? <span className="text-slate-600"> → {JSON.stringify(r.outputs).slice(0, 100)}</span> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            ))}

            {section === 'exceptions' && (exceptions.length === 0 ? (
              <LiveEmptyState icon="◎" title="No exceptions raised" body="When the employee hits an edge case, it proposes how to handle it here for review." />
            ) : (
              <div className="space-y-2">{exceptions.map(e => (
                <div key={e.id} className="bg-slate-900/50 rounded-lg px-4 py-3">
                  <div className="flex items-center gap-2 mb-1"><Pill s={e.status} />{e.learned && <span className="text-[10px] text-emerald-400">learned ✓</span>}<span className="text-[11px] text-slate-600 ml-auto">{fmt(e.created_at)}</span></div>
                  <p className="text-sm text-slate-200">{e.situation}</p>
                  {e.proposed_action && <p className="text-xs text-slate-400 mt-1">Proposed: {e.proposed_action}</p>}
                  {e.justification && <p className="text-xs text-slate-500 mt-0.5 italic">"{e.justification}"</p>}
                  {e.outcome && <p className="text-xs text-emerald-400/80 mt-1">Outcome: {e.outcome}</p>}
                  {/* An exception is the employee asking a question. Until now
                      there was no way to answer it, so it sat pending forever. */}
                  {e.status === 'pending' && (
                    <div className="mt-2 pt-2 border-t border-slate-800 flex items-center gap-2 flex-wrap">
                      <input value={excOutcome[e.id] ?? ''} onChange={ev => setExcOutcome(s => ({ ...s, [e.id]: ev.target.value }))}
                        placeholder="What should happen? (optional note)"
                        className="flex-1 min-w-[180px] bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500" />
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <input type="checkbox" checked={excLearn[e.id] ?? false}
                          onChange={() => setExcLearn(s => ({ ...s, [e.id]: !s[e.id] }))}
                          className="accent-indigo-500" />
                        remember this
                      </label>
                      <button onClick={() => void handleDecide(e.id, 'approved')} disabled={deciding === e.id}
                        className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white disabled:opacity-40">
                        Approve
                      </button>
                      <button onClick={() => void handleDecide(e.id, 'rejected')} disabled={deciding === e.id}
                        className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-rose-600/60 text-slate-200 disabled:opacity-40">
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}</div>
            ))}

            {section === 'replay' && (
              <div className="space-y-4">
                <div className="bg-slate-900/50 rounded-lg px-4 py-2.5 text-[12px] text-slate-400">
                  Re-run a past question — as-is, edited, or with "what if it knew this?" knowledge injected.
                  Replays are dry runs: nothing is saved, cached, remembered, or escalated.
                </div>

                {replaySources.length > 0 && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Start from a past exchange</p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {replaySources.map((s, i) => (
                        <button key={i}
                          onClick={() => { setReplaySel(s); setReplayQ(s.question); setReplayResult(null); setReplayError(null); }}
                          className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${replaySel === s ? 'bg-indigo-500/15 text-indigo-200' : 'bg-slate-900/50 text-slate-300 hover:bg-slate-700/40'}`}>
                          <span className="flex items-center gap-2">
                            {s.kind === 'failed_judgment' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 flex-shrink-0">failed {s.original_score != null ? Math.round(s.original_score) : ''}</span>
                            )}
                            <span className="truncate">{s.question}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Question</p>
                    <textarea value={replayQ} onChange={e => setReplayQ(e.target.value)} rows={2}
                      placeholder="Type any question, or pick one above and edit it…"
                      className="w-full bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 resize-y" />
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Counterfactual knowledge <span className="normal-case text-slate-600">(optional — "what if it knew this?")</span></p>
                    {/* Paste, upload a PDF, or pull a page — same extractors the
                        Knowledge Library uses, so the replay can be fed a real
                        document instead of only hand-typed text. */}
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <label className={`text-[11px] px-2 py-1 rounded-md border cursor-pointer transition-colors ${
                        ckLoading ? 'border-slate-700 text-slate-600' : 'border-slate-700 text-slate-400 hover:text-indigo-200 hover:border-indigo-500/50'}`}>
                        {ckLoading === 'file' ? 'Reading…' : '↑ Upload a document'}
                        <input type="file" accept=".pdf,.txt,.md,.markdown" className="hidden" disabled={!!ckLoading}
                          onChange={e => { const f = e.target.files?.[0]; if (f) void handleCkFile(f); e.target.value = ''; }} />
                      </label>
                      <input value={ckUrl} onChange={e => setCkUrl(e.target.value)} placeholder="…or paste a link"
                        onKeyDown={e => { if (e.key === 'Enter') void handleCkUrl(); }}
                        className="flex-1 min-w-[160px] bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50" />
                      <button onClick={() => void handleCkUrl()} disabled={!!ckLoading || !ckUrl.trim()}
                        className="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-400 hover:text-indigo-200 hover:border-indigo-500/50 disabled:opacity-40">
                        {ckLoading === 'url' ? 'Fetching…' : 'Fetch'}
                      </button>
                    </div>
                    {ckNote && <p className="text-[11px] text-slate-500 mb-1.5">{ckNote}</p>}
                    {ckError && <p className="text-[11px] text-rose-300 mb-1.5">{ckError}</p>}
                    <textarea value={replayCk} onChange={e => setReplayCk(e.target.value)} rows={3}
                      placeholder="Paste a policy, fact, or article the employee doesn't have yet — the replay answers as if it did."
                      className="w-full bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 resize-y" />
                  </div>
                  <button disabled={replayRunning || replayQ.trim().length < 4}
                    onClick={async () => {
                      setReplayRunning(true); setReplayResult(null); setReplayError(null);
                      try { setReplayResult(await runReplay(deId, replayQ.trim(), replayCk)); }
                      catch (err) { setReplayError(err instanceof Error ? err.message : 'Replay failed — try again.'); }
                      finally { setReplayRunning(false); }
                    }}
                    className="px-4 py-2 bg-indigo-500/20 text-indigo-200 text-sm rounded-lg hover:bg-indigo-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {replayRunning ? 'Replaying…' : 'Run replay'}
                  </button>
                  {replayError && <p className="text-xs text-rose-300">{replayError}</p>}
                </div>

                {(replayResult || (replaySel && replaySel.original_answer)) && (
                  <div className={`grid gap-3 ${replaySel?.original_answer && replayResult ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
                    {replaySel?.original_answer && replayResult && (
                      <div className="bg-slate-900/50 border border-rose-500/20 rounded-lg p-4">
                        <p className="text-[11px] uppercase tracking-wide text-rose-300/80 mb-2">Original answer{replaySel.original_score != null ? ` · scored ${Math.round(replaySel.original_score)}/100` : ''}</p>
                        <p className="text-sm text-slate-300 whitespace-pre-wrap">{replaySel.original_answer}</p>
                        {replaySel.rationale && <p className="text-[11px] text-slate-500 mt-2">Why it failed: {replaySel.rationale}</p>}
                      </div>
                    )}
                    {replayResult && (
                      <div className="bg-slate-900/50 border border-indigo-500/25 rounded-lg p-4">
                        <p className="text-[11px] uppercase tracking-wide text-indigo-300/90 mb-2">Replay answer · confidence {Math.round(replayResult.confidence)}%{replayResult.needs_escalation ? ' · would escalate' : ''}</p>
                        <p className="text-sm text-slate-200 whitespace-pre-wrap">{replayResult.answer}</p>
                        {replayResult.sources.length > 0 && <p className="text-[11px] text-slate-500 mt-2">Sources: {replayResult.sources.join(', ')}</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {section === 'certification' && (certs.length === 0 ? (
              <LiveEmptyState icon="◎" title="Not certified yet" body="A DE must pass its role's evaluation before it can go customer-facing — that record shows here." />
            ) : (
              <div className="space-y-2">
                {certStatus?.state === 'stale' && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 text-amber-300 text-sm font-semibold">⚠ Certification is stale</div>
                    <p className="text-[12px] text-amber-200/80 mt-1">This employee's configuration changed since it last passed. The certification below no longer vouches for its current setup — re-run its evaluation or simulation and re-certify before promoting it. Its go-live gate will block promotion until then.</p>
                  </div>
                )}
                {certStatus?.state === 'certified' && (
                  <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-4 py-2.5 text-[12px] text-emerald-300">✓ Certified for its current configuration — the passing evaluation below still applies.</div>
                )}
                {certs.map(c => (
                <div key={c.id} className="bg-slate-900/50 rounded-lg px-4 py-3 flex items-center gap-3">
                  <Pill s={c.status} />
                  <span className="text-sm text-slate-200 flex-1">{c.archetype_key ?? 'Role'} certification</span>
                  <span className={`text-sm font-semibold ${c.status === 'passed' ? 'text-emerald-300' : 'text-rose-300'}`}>{Math.round(c.score_pct)}%</span>
                  <span className="text-[11px] text-slate-600">need {c.threshold_pct}% · {fmt(c.evaluated_at ?? c.created_at)}</span>
                </div>
              ))}</div>
            ))}

            {section === 'training' && (training.length === 0 ? (
              <LiveEmptyState icon="◎" title="No training assigned" body="A role's curriculum (SOPs, tools, policies) is tracked here." />
            ) : (
              <div className="space-y-2">{training.map(t => (
                <div key={t.module_key} className="bg-slate-900/50 rounded-lg px-4 py-2.5 flex items-center gap-3">
                  <Pill s={t.status} />
                  <span className="text-sm text-slate-200 flex-1">{t.module_key.replace(/_/g, ' ')}</span>
                  {t.completed_at && <span className="text-[11px] text-slate-600">{fmt(t.completed_at)}</span>}
                </div>
              ))}</div>
            ))}

            {section === 'compliance' && (packs.length === 0 ? (
              <LiveEmptyState icon="◎" title="No compliance packs attached" body="Packs (HIPAA, TCPA, financial controls) enforce un-toggleable guardrails on every DE." />
            ) : (
              <div className="space-y-2">{packs.map(p => (
                <div key={p.pack_key} className="bg-slate-900/50 rounded-lg px-4 py-3 flex items-center gap-3">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">un-toggleable</span>
                  <span className="text-sm text-slate-200 flex-1">{p.name ?? p.pack_key}{p.domain ? ` · ${p.domain}` : ''}</span>
                  <span className="text-[11px] text-slate-600">attached {fmt(p.attached_at)}</span>
                </div>
              ))}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
