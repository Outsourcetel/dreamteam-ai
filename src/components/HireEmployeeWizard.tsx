// ── Hire a Digital Employee — the conversational front door ───────
// You describe the role in plain words. The product does the walking:
// drafts the employee, studies your knowledge, interviews YOU about the
// gaps it found, turns your answers into real grounding + a draft
// playbook, rehearses live in front of you, and then walks the real
// lifecycle gates as far as they honestly allow. No governance is
// bypassed — the gates just speak plain language now.
import { useState } from 'react';
import {
  draftNewHire, saveExamAsGolden, teachNewHire, runRehearsal,
  promoteAsFarAsGatesAllow, describeStage,
} from '../lib/hireApi';
import type { HireDraft, TeachResult, RehearsalResult, PromotionOutcome } from '../lib/hireApi';

type Step = 'brief' | 'meet' | 'working' | 'done';

const EXAMPLES = [
  'I need someone to answer billing questions — invoices, refunds within our 30-day policy, and payment problems. Anything about contract changes goes to a human.',
  'A support employee for our telecom customers: troubleshooting connection issues step by step, checking known outages, and escalating anything that needs a truck roll.',
  'Someone to handle order status questions for our online store — where is my order, returns, exchanges — always polite, never promises delivery dates we cannot keep.',
];

export default function HireEmployeeWizard({ onClose, onFinished }: { onClose: () => void; onFinished: () => void }) {
  const [step, setStep] = useState<Step>('brief');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [brief, setBrief] = useState('');
  const [draft, setDraft] = useState<HireDraft | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [goldenSaved, setGoldenSaved] = useState(0);
  const [teach, setTeach] = useState<TeachResult | null>(null);
  const [rehearsal, setRehearsal] = useState<RehearsalResult | null>(null);
  const [rehearsalError, setRehearsalError] = useState<string | null>(null);
  const [promo, setPromo] = useState<PromotionOutcome | null>(null);
  const [showScenarios, setShowScenarios] = useState(false);

  const persona = draft?.config.persona_name || 'Your new employee';
  const roleName = draft?.config.name || 'New Digital Employee';

  const doDraft = async () => {
    if (brief.trim().length < 30) { setError('Say a little more — a sentence or two about what this employee should do.'); return; }
    setBusy(true); setError(null); setPhase('Reading your description and studying your company knowledge…');
    try {
      const d = await draftNewHire(brief.trim());
      setDraft(d);
      setAnswers(d.study.questions.map(() => ''));
      setGoldenSaved(await saveExamAsGolden(d.study.exam));
      setStep('meet');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong drafting the employee.');
    } finally { setBusy(false); setPhase(''); }
  };

  const doTeachAndRehearse = async () => {
    if (!draft) return;
    setStep('working'); setBusy(true); setError(null);
    const qa = draft.study.questions.map((q, i) => ({ question: q, answer: answers[i] ?? '' }));
    try {
      if (qa.some((x) => x.answer.trim())) {
        setPhase(`Teaching ${persona} from your answers — saving them as company knowledge…`);
        setTeach(await teachNewHire(draft.entity_id, roleName, brief.trim(), qa));
      }
    } catch (e) {
      // Teaching failure shouldn't kill the hire — record and continue.
      setTeach({ knowledgeDocId: null, embeddedChunks: 0, playbookName: null, playbookError: e instanceof Error ? e.message : 'teaching failed' });
    }
    try {
      setPhase(`Rehearsal — ${persona} is answering realistic customer questions, each one scored by an independent judge…`);
      setRehearsal(await runRehearsal(draft.entity_id));
    } catch (e) {
      setRehearsalError(e instanceof Error ? e.message : 'The rehearsal could not run.');
    }
    try {
      setPhase('Walking the promotion gates…');
      setPromo(await promoteAsFarAsGatesAllow(draft.entity_id, 'designed'));
    } catch (e) {
      setPromo({ reachedStage: 'designed', blockedAt: null, todo: [], message: e instanceof Error ? e.message : 'promotion failed' });
    }
    setBusy(false); setPhase(''); setStep('done');
  };

  const answeredCount = answers.filter((a) => a.trim()).length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/70">
          <div>
            <h2 className="text-base font-semibold text-white">✨ Hire a Digital Employee</h2>
            <p className="text-xs text-slate-500 mt-0.5">Describe the role. The rest is a conversation.</p>
          </div>
          {!busy && (
            <button onClick={onClose} className="text-slate-500 hover:text-white text-sm px-2 py-1">✕</button>
          )}
        </div>

        <div className="p-6 space-y-5">
          {error && <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}

          {/* ── Step 1: describe the role ── */}
          {step === 'brief' && (
            <>
              <p className="text-sm text-slate-300">
                Tell me about the role in your own words — what should this employee handle,
                and where should they stop and hand over to a human?
              </p>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={5}
                placeholder="e.g. I need someone to answer billing questions…"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none resize-none"
              />
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex, i) => (
                  <button key={i} onClick={() => setBrief(ex)}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 text-left max-w-full truncate"
                    style={{ maxWidth: '100%' }}>
                    {ex.slice(0, 64)}…
                  </button>
                ))}
              </div>
              <button onClick={doDraft} disabled={busy}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors">
                {busy ? phase || 'Working…' : 'Draft my new employee'}
              </button>
            </>
          )}

          {/* ── Step 2: meet the draft + interview ── */}
          {step === 'meet' && draft && (
            <>
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 flex gap-3">
                <div className="w-11 h-11 rounded-xl bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-indigo-300 text-lg font-bold flex-shrink-0">
                  {persona.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{persona} — {roleName}</p>
                  <p className="text-xs text-slate-400 mt-1">{draft.config.purpose_statement || draft.config.description}</p>
                </div>
              </div>

              {draft.study.coverage && (
                <div className="rounded-xl bg-slate-800/60 border border-slate-700 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">What I found in your knowledge</p>
                  <p className="text-xs text-slate-300">{draft.study.coverage}</p>
                </div>
              )}

              {draft.study.contradictions.length > 0 && (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-amber-400">Conflicts worth fixing</p>
                  {draft.study.contradictions.map((c, i) => (
                    <p key={i} className="text-xs text-amber-200/90">
                      The role expects <span className="font-medium">{c.role_expects}</span>, but “{c.source_title}” says <span className="font-medium">{c.kb_says}</span>.
                    </p>
                  ))}
                </div>
              )}

              {draft.study.questions.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-slate-300">
                    Before {persona} starts, they have {draft.study.questions.length} questions for you.
                    Answer any of them — every answer becomes knowledge {persona} will actually use.
                    You can also skip and answer later.
                  </p>
                  {draft.study.questions.map((q, i) => (
                    <label key={i} className="block">
                      <span className="text-xs text-slate-300">{i + 1}. {q}</span>
                      <textarea
                        value={answers[i] ?? ''}
                        onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
                        rows={2}
                        placeholder="Your answer (optional)"
                        className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none resize-none"
                      />
                    </label>
                  ))}
                </div>
              )}

              {goldenSaved > 0 && (
                <p className="text-[11px] text-slate-500">
                  {goldenSaved} exam questions were prepared from this role — they become {persona}’s certification test.
                </p>
              )}

              <div className="flex gap-3">
                <button onClick={doTeachAndRehearse}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                  {answeredCount > 0 ? `Teach ${persona} & run the rehearsal` : 'Run the rehearsal'}
                </button>
                {answeredCount === 0 && draft.study.questions.length > 0 && (
                  <span className="self-center text-[11px] text-slate-500">No answers yet — that’s fine.</span>
                )}
              </div>
            </>
          )}

          {/* ── Step 3: working ── */}
          {step === 'working' && (
            <div className="py-10 text-center space-y-4">
              <div className="mx-auto w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
              <p className="text-sm text-slate-300">{phase || 'Working…'}</p>
              <p className="text-[11px] text-slate-500">This is a real rehearsal — live answers, really judged. Usually under a minute.</p>
            </div>
          )}

          {/* ── Step 4: results ── */}
          {step === 'done' && draft && (
            <>
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
                <p className="text-sm font-semibold text-white mb-1">{persona} is {describeStage(promo?.reachedStage ?? 'designed')}.</p>
                {teach?.knowledgeDocId && (
                  <p className="text-xs text-slate-400">✓ Your interview answers were saved as company knowledge{teach.embeddedChunks > 0 ? ' and indexed' : ' (indexing finishes automatically)'}.</p>
                )}
                {teach?.playbookName && (
                  <p className="text-xs text-slate-400">✓ A draft playbook “{teach.playbookName}” was written from your answers — review it in the Playbook Builder when ready.</p>
                )}
                {teach?.playbookError && (
                  <p className="text-xs text-amber-400/80">The playbook draft didn’t complete ({teach.playbookError}) — your answers are still saved as knowledge.</p>
                )}
              </div>

              {rehearsal && (
                <div className={`rounded-xl border p-4 ${rehearsal.passed === rehearsal.total && rehearsal.total > 0 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
                  <p className="text-sm text-white font-medium">
                    Rehearsal: {rehearsal.passed} of {rehearsal.total} answers passed the judge (average score {Math.round(rehearsal.avgScore)}).
                  </p>
                  <button onClick={() => setShowScenarios((v) => !v)} className="text-[11px] text-slate-400 hover:text-slate-200 underline mt-1">
                    {showScenarios ? 'Hide the questions and answers' : 'See every question and answer'}
                  </button>
                  {showScenarios && (
                    <div className="mt-3 space-y-3">
                      {rehearsal.scenarios.map((s, i) => (
                        <div key={i} className="rounded-lg bg-slate-900/60 p-3">
                          <p className="text-xs text-slate-300 font-medium">Q: {s.question}</p>
                          <p className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{s.answer.slice(0, 500)}{s.answer.length > 500 ? '…' : ''}</p>
                          <p className={`text-[11px] mt-1 ${s.verdict === 'pass' ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {s.verdict === 'pass' ? '✓ passed' : '✗ needs work'} · score {Math.round(s.score)}{s.rationale ? ` — ${s.rationale.slice(0, 140)}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {rehearsalError && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-xs text-amber-300">The live rehearsal couldn’t run: {rehearsalError}. {persona} was still created — rehearse from their profile when ready.</p>
                </div>
              )}

              {promo && (promo.todo.length > 0 || promo.blockedAt) && (
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
                  <p className="text-xs text-slate-300 font-medium mb-2">
                    To reach the next stage{promo.blockedAt ? ` (${promo.blockedAt})` : ''}, {persona} still needs:
                  </p>
                  {promo.todo.length > 0 ? (
                    <ul className="space-y-1">
                      {promo.todo.map((t, i) => <li key={i} className="text-xs text-slate-400">• {t}</li>)}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400">{promo.message || 'See the employee profile for details.'}</p>
                  )}
                </div>
              )}

              <button onClick={() => { onFinished(); onClose(); }}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                Done — take me to the team
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
