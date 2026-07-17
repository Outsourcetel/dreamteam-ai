import React, { useEffect, useRef, useState } from 'react';
import { PageHeader, th, td } from '../../../components/ui';
import { ConfirmDeleteModal } from '../../../components';
import {
  GoldenQA, GoldenCategory, EvalRun, EvalGate,
  listGoldenQA, createGoldenQA, updateGoldenQA, deleteGoldenQA,
  listEvalRuns, getEvalRun, getEvalGate, startEvalRun,
  generateStarterSuite, EvalRunError,
} from '../../../lib/evalApi';
import { listKnowledgeDocs } from '../../../lib/knowledgeApi';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Live Proving Ground (R3) — golden Q&A suites run against the
// REAL DE (de-answer). Grading: answer contains all expected
// fragments (case-insensitive) AND confidence >= floor.
// Dormant-honest: until ANTHROPIC_API_KEY is set, runs finish
// as 'blocked_llm' — the suite is ready and proves the loop.
// ============================================================

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const CATEGORIES: GoldenCategory[] = ['knowledge', 'procedure', 'guardrail', 'escalation', 'calibration'];

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  running:     { label: 'Running',    cls: 'bg-indigo-500/15 text-indigo-400' },
  passed:      { label: 'Passed',     cls: 'bg-emerald-500/15 text-emerald-400' },
  failed:      { label: 'Failed',     cls: 'bg-red-500/15 text-red-400' },
  blocked_llm: { label: 'Blocked — brain dormant', cls: 'bg-amber-500/15 text-amber-400' },
};

interface EditorState {
  id: string | null;
  question: string;
  fragments: string; // comma-separated in the input
  minConfidence: number;
  category: GoldenCategory;
}

const emptyEditor: EditorState = { id: null, question: '', fragments: '', minConfidence: 60, category: 'knowledge' };

const LiveProvingGround = () => {
  const [qas, setQas] = useState<GoldenQA[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [gate, setGate] = useState<EvalGate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<EvalRun | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GoldenQA | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setQas(await listGoldenQA());
      setRuns(await listEvalRuns());
      setGate(await getEvalGate());
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const save = async () => {
    if (!editor || !editor.question.trim() || saving) return;
    const fragments = editor.fragments.split(',').map((f) => f.trim()).filter(Boolean);
    if (fragments.length === 0) { setError('At least one expected fragment is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      if (editor.id) {
        await updateGoldenQA(editor.id, {
          question: editor.question.trim(), expected_fragments: fragments,
          min_confidence: editor.minConfidence, category: editor.category,
        });
      } else {
        await createGoldenQA({
          question: editor.question.trim(), expected_fragments: fragments,
          min_confidence: editor.minConfidence, category: editor.category,
        });
      }
      setEditor(null);
      setQas(await listGoldenQA());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (qa: GoldenQA) => {
    try {
      await updateGoldenQA(qa.id, { active: !qa.active });
      setQas((prev) => prev.map((q) => (q.id === qa.id ? { ...q, active: !q.active } : q)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteGoldenQA(id);
      setQas((prev) => prev.filter((q) => q.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const generateStarters = async () => {
    setGenerating(true);
    setError(null);
    try {
      const docs = await listKnowledgeDocs();
      if (docs.length === 0) {
        setError('No knowledge documents yet — add some in Knowledge → Library first, then generate the starter suite.');
        return;
      }
      await generateStarterSuite(docs.map((d) => d.title));
      setQas(await listGoldenQA());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const runEvals = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setLiveRun(null);
    // Live-poll the newest run row while the edge function works.
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      try {
        const latest = await listEvalRuns(1);
        const r = latest[0];
        if (r && new Date(r.started_at).getTime() >= startedAt - 15_000) {
          setLiveRun(r);
          setExpandedRunId(r.id);
        }
      } catch { /* transient poll errors are fine */ }
    }, 1500);
    try {
      const { run_id } = await startEvalRun('manual');
      const final = await getEvalRun(run_id);
      if (final) { setLiveRun(final); setExpandedRunId(final.id); }
    } catch (err) {
      if (err instanceof EvalRunError && err.code === 'no_questions') {
        setError('No active golden questions — add some (or generate the starter suite) first.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      setRunning(false);
      setRuns(await listEvalRuns().catch(() => []));
      setGate(await getEvalGate());
    }
  };

  if (missingTables) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
        <PageHeader title="Proving Ground" subtitle="Golden Q&A evals run against your live Digital Employee." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-slate-400">
            The eval tables haven't been created yet. Apply
            <code className="mx-1 text-slate-300">supabase/migrations/018_proving_ground.sql</code>
            in the Supabase SQL Editor, then reload.
          </p>
        </div>
      </div>
    );
  }

  const activeCount = qas.filter((q) => q.active).length;
  const latestShown = liveRun ?? runs[0] ?? null;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
      <PageHeader
        title="Proving Ground"
        subtitle="Your DE's exam: golden questions run against the LIVE answer path. A failing run gates knowledge publishes."
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>
      )}

      {/* Gate banner */}
      {gate?.status === 'failed' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
          <p className="text-sm text-red-300 font-medium">Publishing gated — last eval run failed {gate.passed}/{gate.total}</p>
          <p className="text-xs text-slate-400 mt-0.5">Knowledge publishes will ask for an explicit override until a run passes. Fix the failing answers or update the suite, then re-run.</p>
        </div>
      )}
      {gate?.status === 'blocked_llm' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
          <p className="text-sm text-amber-300 font-medium">DE brain not activated — suite is ready and will run on activation.</p>
          <p className="text-xs text-slate-400 mt-0.5">The last run reached the live DE but the LLM key isn't set yet, so grading couldn't execute. Nothing is simulated.</p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setEditor({ ...emptyEditor })}
          className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          + Add question
        </button>
        <button
          onClick={() => void runEvals()}
          disabled={running || activeCount === 0}
          className="text-sm px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors"
        >
          {running ? 'Running evals…' : `Run evals (${activeCount})`}
        </button>
        <span className="text-xs text-slate-500 ml-auto">{qas.length} question{qas.length === 1 ? '' : 's'} · {activeCount} active · cap 50 per run</span>
      </div>

      {/* Suite editor table / empty state */}
      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : qas.length === 0 ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-10 text-center mb-6">
          <p className="text-sm text-slate-300 font-medium mb-1">Create your DE's exam</p>
          <p className="text-xs text-slate-500 mb-4 max-w-md mx-auto">
            Golden questions are asked to your live DE and graded: the answer must contain the expected fragments and clear the confidence floor.
            Generate 5 starter questions from your knowledge doc titles — honest templates, fully editable.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => void generateStarters()}
              disabled={generating}
              className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
            >
              {generating ? 'Generating…' : 'Generate 5 starter questions'}
            </button>
            <button
              onClick={() => setEditor({ ...emptyEditor })}
              className="text-sm px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-500 transition-colors"
            >
              Write my own
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden mb-6">
          <table className="w-full text-sm text-slate-300">
            <thead className="bg-slate-800 border-b border-slate-700">
              <tr>
                <th className={th}>Question</th>
                <th className={th}>Expected fragments</th>
                <th className={th}>Confidence floor</th>
                <th className={th}>Category</th>
                <th className={th}>Active</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {qas.map((qa) => (
                <tr key={qa.id} className="border-b border-slate-700/60 hover:bg-slate-700/40 transition-colors">
                  <td className={`${td} text-white max-w-sm`}>{qa.question}</td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {qa.expected_fragments.map((f) => (
                        <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">"{f}"</span>
                      ))}
                    </div>
                  </td>
                  <td className={`${td} text-xs`}>≥ {qa.min_confidence}%</td>
                  <td className={td}>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">{qa.category}</span>
                  </td>
                  <td className={td}>
                    <button
                      onClick={() => void toggleActive(qa)}
                      className={`text-xs px-2 py-0.5 rounded-full transition-colors ${qa.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}
                    >
                      {qa.active ? 'Active' : 'Off'}
                    </button>
                  </td>
                  <td className={td}>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditor({
                          id: qa.id, question: qa.question,
                          fragments: qa.expected_fragments.join(', '),
                          minConfidence: qa.min_confidence, category: qa.category,
                        })}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button onClick={() => setRemoveTarget(qa)} className="text-xs text-red-400/80 hover:text-red-300 transition-colors">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Latest run detail */}
      {latestShown && (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm font-semibold text-white">Latest run</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CHIP[latestShown.status]?.cls ?? ''}`}>
              {STATUS_CHIP[latestShown.status]?.label ?? latestShown.status}
            </span>
            {latestShown.status !== 'blocked_llm' && latestShown.status !== 'running' && (
              <span className="text-xs text-slate-400">{latestShown.passed}/{latestShown.total} passed</span>
            )}
            <span className="text-xs text-slate-600 ml-auto">{fmtTime(latestShown.started_at)}</span>
          </div>
          {latestShown.status === 'blocked_llm' && (
            <p className="text-xs text-amber-300 mb-3">
              DE brain not activated — suite is ready and will run on activation. The runner reached the live DE and stopped honestly at the LLM gate.
            </p>
          )}
          <div className="space-y-2">
            {latestShown.results.map((r, i) => (
              <div key={`${r.qa_id}-${i}`} className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.passed ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                    {r.passed ? 'PASS' : 'FAIL'}
                  </span>
                  <span className="text-xs text-slate-200 flex-1">{r.question}</span>
                  {typeof r.confidence === 'number' && (
                    <span className="text-[10px] text-slate-500">conf {r.confidence}%</span>
                  )}
                </div>
                {r.answer && (
                  <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">"{r.answer}"</p>
                )}
                <p className="text-[10px] text-slate-500 mt-0.5">{r.reason}</p>
              </div>
            ))}
            {running && latestShown.results.length < latestShown.total && (
              <p className="text-xs text-slate-500 animate-pulse">Asking the live DE… {latestShown.results.length}/{latestShown.total}</p>
            )}
          </div>
        </div>
      )}

      {/* Run history */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-white">Run history</h2>
        </div>
        {runs.length === 0 ? (
          <LiveEmptyState icon="◎" title="No runs yet" body={'The first "Run evals" lands here.'} />
        ) : (
          <table className="w-full text-sm text-slate-300">
            <thead className="bg-slate-800 border-b border-slate-700">
              <tr>
                <th className={th}>Started</th>
                <th className={th}>Trigger</th>
                <th className={th}>Result</th>
                <th className={th}>Status</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="border-b border-slate-700/60 hover:bg-slate-700/40 transition-colors">
                    <td className={`${td} text-xs`}>{fmtTime(r.started_at)}</td>
                    <td className={td}><span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">{r.trigger}</span></td>
                    <td className={`${td} text-xs`}>{r.status === 'blocked_llm' ? '—' : `${r.passed}/${r.total} passed`}</td>
                    <td className={td}>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CHIP[r.status]?.cls ?? ''}`}>
                        {STATUS_CHIP[r.status]?.label ?? r.status}
                      </span>
                    </td>
                    <td className={td}>
                      <button
                        onClick={() => setExpandedRunId(expandedRunId === r.id ? null : r.id)}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        {expandedRunId === r.id ? 'Hide' : 'Detail'}
                      </button>
                    </td>
                  </tr>
                  {expandedRunId === r.id && (
                    <tr className="border-b border-slate-700/60">
                      <td colSpan={5} className="px-5 py-3 bg-slate-900/50">
                        <div className="space-y-1.5">
                          {r.results.map((res, i) => (
                            <div key={`${res.qa_id}-${i}`} className="flex items-start gap-2 text-[11px]">
                              <span className={`px-1.5 py-0.5 rounded flex-shrink-0 ${res.passed ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                                {res.passed ? 'PASS' : 'FAIL'}
                              </span>
                              <div className="min-w-0">
                                <p className="text-slate-300">{res.question}{typeof res.confidence === 'number' ? ` · conf ${res.confidence}%` : ''}</p>
                                <p className="text-slate-500">{res.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[10px] text-slate-600 mt-4">
        Grader v1: fragment matching + confidence calibration (LLM-judge grading is the upgrade). Publish gate is client-side soft (server-side hard gate is the hardening step).
      </p>

      {/* Editor modal */}
      {editor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => !saving && setEditor(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-xl bg-slate-800 border border-slate-600 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-4">{editor.id ? 'Edit question' : 'Add golden question'}</h2>
            <label className="block text-xs text-slate-500 mb-1">Question (asked to the live DE)</label>
            <input
              value={editor.question}
              onChange={(e) => setEditor({ ...editor, question: e.target.value })}
              placeholder="e.g. What is our refund window?"
              className="w-full mb-3 text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <label className="block text-xs text-slate-500 mb-1">Expected fragments (comma-separated — the answer must contain ALL, case-insensitive)</label>
            <input
              value={editor.fragments}
              onChange={(e) => setEditor({ ...editor, fragments: e.target.value })}
              placeholder="30 days, full refund"
              className="w-full mb-3 text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex gap-3 mb-5">
              <div className="flex-1">
                <label className="block text-xs text-slate-500 mb-1">Confidence floor ({editor.minConfidence}%)</label>
                <input
                  type="range" min={0} max={100} step={5}
                  value={editor.minConfidence}
                  onChange={(e) => setEditor({ ...editor, minConfidence: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Category</label>
                <select
                  value={editor.category}
                  onChange={(e) => setEditor({ ...editor, category: e.target.value as GoldenCategory })}
                  className="text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditor(null)}
                disabled={saving}
                className="text-sm px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-500 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !editor.question.trim() || !editor.fragments.trim()}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
              >
                {saving ? 'Saving…' : editor.id ? 'Save changes' : 'Add question'}
              </button>
            </div>
          </div>
        </div>
      )}
      {removeTarget && (
        <ConfirmDeleteModal
          title="Delete golden question"
          message={`Delete "${removeTarget.question}"? This removes it from every future eval run — this can't be undone.`}
          confirmLabel="Delete"
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => { await remove(removeTarget.id); setRemoveTarget(null); }}
        />
      )}
    </div>
  );
};

export default LiveProvingGround;
