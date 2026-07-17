import React, { useEffect, useState } from 'react';
import {
  getDeMemory, getDeObjectives, getDeWorkItems, getDeTrace, getDeExceptions,
  getDeCertifications, getDeTraining, getTenantCompliancePacks,
  type MemoryRow, type ObjectiveRow, type WorkItemRow, type TraceRow, type ExceptionRow,
  type CertRow, type TrainingRow, type CompliancePackRow,
} from '../../lib/deWorkbenchApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../components/LiveDataStates';

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
  const [training, setTraining] = useState<TrainingRow[]>([]);
  const [packs, setPacks] = useState<CompliancePackRow[]>([]);

  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const [m, o, w, t, e, c, tr, p] = await Promise.all([
          getDeMemory(deId), getDeObjectives(deId), getDeWorkItems(deId), getDeTrace(deId),
          getDeExceptions(deId), getDeCertifications(deId), getDeTraining(deId), getTenantCompliancePacks(),
        ]);
        if (cancelled) return;
        setMemory(m); setObjectives(o); setWorkItems(w); setTrace(t);
        setExceptions(e); setCerts(c); setTraining(tr); setPacks(p);
      } catch {
        // A failed load must NOT masquerade as an honest empty state.
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deId]);

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
            {section === 'memory' && (memory.length === 0 ? (
              <LiveEmptyState icon="◎" title="No memories yet" body="This employee records what it learns as it works and answers." />
            ) : (
              <div className="space-y-2">
                {memory.map(m => (
                  <div key={m.id} className="bg-slate-900/50 rounded-lg px-4 py-3 flex items-start gap-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 flex-shrink-0 mt-0.5">{m.kind}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-200">{m.content}</p>
                      <p className="text-[11px] text-slate-600 mt-1">{m.subject_kind}{m.subject_ref ? ` · ${m.subject_ref.slice(0, 12)}` : ''} · salience {Math.round(m.salience * 100)}% · {fmt(m.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {section === 'work' && (
              <div className="space-y-5">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Objectives (goals)</p>
                  {objectives.length === 0 ? (
                    <LiveEmptyState icon="◎" title="No objectives set" body="Objectives are goals the employee pursues over time." />
                  ) : (
                    <div className="space-y-2">{objectives.map(o => (
                      <div key={o.id} className="bg-slate-900/50 rounded-lg px-4 py-2.5 flex items-center gap-3">
                        <Pill s={o.status} /><span className="text-sm text-slate-200 flex-1">{o.title}</span>
                        <span className="text-[11px] text-slate-600">P{o.priority}{o.due_at ? ` · due ${fmt(o.due_at)}` : ''}</span>
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
                </div>
              ))}</div>
            ))}

            {section === 'certification' && (certs.length === 0 ? (
              <LiveEmptyState icon="◎" title="Not certified yet" body="A DE must pass its role's evaluation before it can go customer-facing — that record shows here." />
            ) : (
              <div className="space-y-2">{certs.map(c => (
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
