// ── Hire a Digital Employee — the conversational front door ───────
// You describe the role in plain words. The product does the walking:
// drafts the employee, studies your knowledge, interviews YOU about the
// gaps it found, turns your answers into real grounding + a draft
// playbook, rehearses live in front of you, and then walks the real
// lifecycle gates as far as they honestly allow. No governance is
// bypassed — the gates just speak plain language now.
import { useState, useEffect, useRef } from 'react';
import { useIsTenantAdmin } from '../lib/useRoleGate';
import { useAuth } from '../context/AuthContext';
import { Modal, Banner, Button } from '../design/primitives';
import {
  draftNewHire, saveExamAsGolden, teachNewHire, runRehearsal,
  promoteAsFarAsGatesAllow, describeStage,
  listRoleArchetypes, hireFromArchetype, getSetupQuestions,
  proposeTailoredSetup, applyTailoredGuardrails,
} from '../lib/hireApi';
import type {
  HireDraft, TeachResult, RehearsalResult, PromotionOutcome,
  RoleArchetype, ArchetypeHireResult, SetupQuestion, TailoredApplyResult,
} from '../lib/hireApi';

type Step = 'brief' | 'meet' | 'working' | 'done' | 'tailor' | 'archetype_done';

// ⚠ THESE WERE UNREADABLE AS BUTTONS. Each full brief is ~160 characters and
// the chip rendered `ex.slice(0, 64)…` at 11px — cut mid-word, so you saw
// "I need someone to answer billing questions — invoices, refunds w…" and had
// to click one to find out what it was. A label says which example it is; the
// brief is what lands in the box, complete.
const EXAMPLES: { label: string; brief: string }[] = [
  { label: 'Billing questions',
    brief: 'I need someone to answer billing questions — invoices, refunds within our 30-day policy, and payment problems. Anything about contract changes goes to a human.' },
  { label: 'Technical support',
    brief: 'A support employee for our telecom customers: troubleshooting connection issues step by step, checking known outages, and escalating anything that needs a truck roll.' },
  { label: 'Order status & returns',
    brief: 'Someone to handle order status questions for our online store — where is my order, returns, exchanges — always polite, never promises delivery dates we cannot keep.' },
];

// ── Surviving a refresh ───────────────────────────────────────────────────
// ⚠ THE EMPLOYEE OUTLIVES THE TAB. draftNewHire() creates a REAL digital
// employee server-side at step one and hands back its entity_id; every later
// step (teaching, rehearsal, the promotion gates) acts on that row. So closing
// the tab never lost the employee — it lost the only route back to it, leaving
// a half-built hire sitting in the roster that nobody could finish. Measured
// 2026-08-09: 41 employees stuck at `designed`, 33 of them created in the last
// 30 days. That is roughly one abandoned hire a day.
//
// What is kept is the expensive human input — the brief you wrote and the
// interview answers about your own business — plus the results of the slow
// calls, so resuming never re-runs a rehearsal you already paid for.
const HIRE_STORE_V = 1;
const HIRE_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // a week; past that the roster has moved on

interface SavedHire {
  v: number; at: number;
  step: Step; brief: string; draft: HireDraft | null; answers: string[];
  goldenSaved: number; teach: TeachResult | null; rehearsal: RehearsalResult | null;
  promo: PromotionOutcome | null;
  showRoles: boolean; selectedRole: RoleArchetype | null; roleDeName: string;
  archResult: ArchetypeHireResult | null; setupQuestions: SetupQuestion[];
  setupAnswers: Record<string, string>; applyResult: TailoredApplyResult | null;
}

function readSavedHire(key: string): SavedHire | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedHire;
    if (s?.v !== HIRE_STORE_V || typeof s.at !== 'number' || Date.now() - s.at > HIRE_KEEP_MS) {
      localStorage.removeItem(key);
      return null;
    }
    // Nothing worth resuming unless a real employee exists or words were typed.
    if (!s.draft && !s.archResult && !s.brief?.trim()) return null;
    return s;
  } catch {
    return null; // corrupt JSON or blocked storage must never stop someone hiring
  }
}

export default function HireEmployeeWizard({ onClose, onFinished }: { onClose: () => void; onFinished: () => void }) {
  // Hiring calls create_digital_employee / advance_de_lifecycle / install_role_systems — all owner/admin. The workforce pages that open this wizard are ALL_TENANT.
  const isTenantAdmin = useIsTenantAdmin();
  const { authedUser } = useAuth();

  // ⚠⚠ SCOPED TO TENANT **AND** USER. entity_id names a row in ONE workspace;
  // restoring it under another would point the rest of the wizard — teaching,
  // rehearsal, the promotion gates — at somebody else's employee.
  const storeKey = `dt.hire.${authedUser?.tenantId ?? 'none'}.${authedUser?.id ?? 'anon'}`;
  // App.tsx renders this only past its `if (!authedUser) return`, so the
  // identity is known on the FIRST render and the restore can happen in the
  // initialisers below — no flash of an empty step one before it lands.
  const [restored] = useState(() => readSavedHire(storeKey));
  const [resumed, setResumed] = useState(!!restored);

  const [step, setStep] = useState<Step>(restored?.step ?? 'brief');
  const [commsCopied, setCommsCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [brief, setBrief] = useState(restored?.brief ?? '');
  const [draft, setDraft] = useState<HireDraft | null>(restored?.draft ?? null);
  const [answers, setAnswers] = useState<string[]>(restored?.answers ?? []);
  const [goldenSaved, setGoldenSaved] = useState(restored?.goldenSaved ?? 0);
  const [teach, setTeach] = useState<TeachResult | null>(restored?.teach ?? null);
  const [rehearsal, setRehearsal] = useState<RehearsalResult | null>(restored?.rehearsal ?? null);
  const [rehearsalError, setRehearsalError] = useState<string | null>(null);
  const [promo, setPromo] = useState<PromotionOutcome | null>(restored?.promo ?? null);
  const [showScenarios, setShowScenarios] = useState(false);

  // ── Archetype-hire mode: hire a ready-made role (Renewals, Billing…) ──
  const [showRoles, setShowRoles] = useState(restored?.showRoles ?? false);
  const [archetypes, setArchetypes] = useState<RoleArchetype[]>([]);
  const [selectedRole, setSelectedRole] = useState<RoleArchetype | null>(restored?.selectedRole ?? null);
  const [roleDeName, setRoleDeName] = useState(restored?.roleDeName ?? '');
  const [archResult, setArchResult] = useState<ArchetypeHireResult | null>(restored?.archResult ?? null);
  const [setupQuestions, setSetupQuestions] = useState<SetupQuestion[]>(restored?.setupQuestions ?? []);
  const [setupAnswers, setSetupAnswers] = useState<Record<string, string>>(restored?.setupAnswers ?? {});
  const [applyResult, setApplyResult] = useState<TailoredApplyResult | null>(restored?.applyResult ?? null);
  const [applyBusy, setApplyBusy] = useState(false);

  const saveTimer = useRef<number | null>(null);

  // ⚠ busy / phase / error / applyBusy are DELIBERATELY not restored above and
  // not saved below. A `busy: true` that survived a refresh would reopen the
  // wizard permanently mid-spinner with nothing actually running behind it.
  useEffect(() => {
    if (!draft && !archResult && !brief.trim()) {
      try { localStorage.removeItem(storeKey); } catch { /* storage unavailable */ }
      return;
    }
    // ⚠ DEBOUNCED ON PURPOSE. The blob carries the whole draft, including the
    // generated exam, and the interview step is a set of long free-text
    // answers — serialising all of it on every keystroke puts real work in the
    // typing path. 400ms costs nothing on a refresh and keeps typing smooth.
    saveTimer.current = window.setTimeout(() => {
      const body: SavedHire = {
        v: HIRE_STORE_V, at: Date.now(),
        step, brief, draft, answers, goldenSaved, teach, rehearsal, promo,
        showRoles, selectedRole, roleDeName, archResult, setupQuestions, setupAnswers, applyResult,
      };
      try { localStorage.setItem(storeKey, JSON.stringify(body)); }
      catch { /* quota or private browsing — hiring must still work without it */ }
    }, 400);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [storeKey, step, brief, draft, answers, goldenSaved, teach, rehearsal, promo,
      showRoles, selectedRole, roleDeName, archResult, setupQuestions, setupAnswers, applyResult]);

  const forgetDraft = () => {
    // ⚠ KILL THE PENDING WRITE FIRST. A debounced save queued moments before
    // the hire completed would otherwise land 400ms later and resurrect the
    // draft we just deleted — so the next visit would offer to resume an
    // employee that is already finished. Unmounting happens to clear this too,
    // but correctness here should not depend on the caller navigating away.
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    try { localStorage.removeItem(storeKey); } catch { /* storage unavailable */ }
  };

  /** Abandon this hire in the browser. ⚠ It does NOT delete the employee —
   *  it is already in the roster and only the workforce page can retire it.
   *  The button says so, because a control that implies a cleanup it does not
   *  perform is worse than no button. */
  const startDifferentHire = () => {
    forgetDraft();
    setStep('brief'); setBrief(''); setDraft(null); setAnswers([]); setGoldenSaved(0);
    setTeach(null); setRehearsal(null); setRehearsalError(null); setPromo(null);
    setShowRoles(false); setSelectedRole(null); setRoleDeName(''); setArchResult(null);
    setSetupQuestions([]); setSetupAnswers({}); setApplyResult(null);
    setError(null); setResumed(false);
  };

  useEffect(() => {
    if (showRoles && archetypes.length === 0) {
      listRoleArchetypes()
        .then(setArchetypes)
        .catch(() => setError('Could not load the role templates.'));
    }
  }, [showRoles, archetypes.length]);

  const persona = draft?.config.persona_name || 'Your new employee';
  const roleName = draft?.config.name || 'New Digital Employee';
  // Who the resumed draft is ABOUT — null when only a typed brief was saved
  // and no employee exists yet, because then there is nothing in the roster.
  const resumeSubject = draft ? roleName
    : archResult ? (roleDeName.trim() || selectedRole?.name || 'An employee')
    : null;

  const tailoredProposal = proposeTailoredSetup(setupQuestions, setupAnswers);
  const hasProposal =
    tailoredProposal.discountPct != null || tailoredProposal.approvalCents != null ||
    tailoredProposal.systems.length > 0 || !!tailoredProposal.partyScope;

  const doApplyTailored = async () => {
    if (!archResult) return;
    setApplyBusy(true); setError(null);
    try {
      setApplyResult(await applyTailoredGuardrails(archResult.deId, tailoredProposal));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply the adjustments.');
    } finally { setApplyBusy(false); }
  };

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

  const doArchetypeHire = async () => {
    if (!selectedRole) return;
    const name = roleDeName.trim() || selectedRole.name;
    setBusy(true); setError(null); setPhase(`Hiring ${name} from the ${selectedRole.name} template…`);
    try {
      const res = await hireFromArchetype(selectedRole.key, name);
      setArchResult(res);
      const qs = await getSetupQuestions(selectedRole.key);
      setSetupQuestions(qs);
      setSetupAnswers(Object.fromEntries(qs.map((q) => [q.key, ''])));
      setStep(qs.length > 0 ? 'tailor' : 'archetype_done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not hire from this role template.');
    } finally { setBusy(false); setPhase(''); }
  };

  // P1.3 — the interview answers become tailored grounding + a draft SOP,
  // through the SAME teach machinery the from-scratch hire uses.
  const doTailorSetup = async () => {
    if (!archResult || !selectedRole) { setStep('archetype_done'); return; }
    const qa = setupQuestions.map((q) => ({ question: q.question, answer: setupAnswers[q.key] ?? '' }));
    if (!qa.some((x) => x.answer.trim())) { setStep('archetype_done'); return; }
    setBusy(true); setError(null);
    setPhase(`${roleDeName.trim() || selectedRole.name} is drafting its tailored setup from your answers…`);
    try {
      setTeach(await teachNewHire(archResult.deId, roleDeName.trim() || selectedRole.name, selectedRole.description, qa));
    } catch (e) {
      setTeach({ knowledgeDocId: null, embeddedChunks: 0, playbookName: null, playbookError: e instanceof Error ? e.message : 'draft failed' });
    } finally { setBusy(false); setPhase(''); setStep('archetype_done'); }
  };

  const answeredCount = answers.filter((a) => a.trim()).length;

  return (
    // ── THIS IS A PAGE NOW, NOT A MODAL (handoff 11) ────────────────────────
    //
    // Five steps of conversation — describe the role, meet who it drafted,
    // resolve a knowledge conflict, answer two interview questions, hire —
    // is not dialog work. It was a Modal at size="2xl", which meant a
    // backdrop click or Escape threw away everything typed, and the design
    // system's own rule is: modals for confirmations and short forms, pages
    // for anything with steps you might leave and come back to.
    //
    // ⚠ The work itself was never as fragile as it looked. draftNewHire()
    // creates a REAL entity server-side at step one and returns its
    // entity_id, so an abandoned wizard leaves a `designed` employee rather
    // than nothing — 41 of those exist across the platform, 33 from the last
    // 30 days. What a stray click destroyed was the local state: the brief you
    // typed, your answers, and which step you were on. That IS now persisted
    // (see readSavedHire above), so leaving and coming back resumes the same
    // hire instead of starting a second one beside it.
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={() => { if (!busy) onClose(); }}
        className="text-xs text-dt-support hover:text-dt-body mb-4 inline-flex items-center gap-1.5">
        ← Back to your workforce
      </button>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-dt-title">Hire a digital employee</h1>
        <p className="text-sm text-dt-support mt-1">Describe the role. The rest is a conversation.</p>
      </div>
      {resumed && (
        <Banner tone="info" className="mb-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="flex-1 min-w-[18rem]">
              <span className="font-medium">Picking up where you left off.</span>{' '}
              {resumeSubject
                ? `${resumeSubject} already exists in your roster as an unfinished hire — carry on here to finish it.`
                : 'The description you wrote was saved on this device.'}
            </p>
            <span className="flex items-center gap-2 shrink-0">
              <Button kind="ghost" size="sm" onClick={() => setResumed(false)}>Carry on</Button>
              <Button size="sm" onClick={startDifferentHire}
                title={resumeSubject
                  ? `Starts a blank hire. ${resumeSubject} stays in your roster — finish or retire it from the workforce page.`
                  : 'Clears the saved description and starts a blank hire.'}>
                Start a different hire
              </Button>
            </span>
          </div>
        </Banner>
      )}
        <div className="px-6 pb-6 space-y-5">
          {error && <div className="rounded-xl border border-dt-danger-border bg-dt-danger-soft px-3 py-2 text-xs text-dt-danger">{error}</div>}

          {/* ── Step 1: describe the role ── */}
          {step === 'brief' && (
            <>
              <p className="text-sm text-dt-support">
                Tell me about the role in your own words — what should this employee handle,
                and where should they stop and hand over to a human?
              </p>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={5}
                placeholder="e.g. I need someone to answer billing questions…"
                className="w-full bg-dt-card border border-dt-border rounded-xl px-4 py-3 text-sm text-dt-body focus:border-indigo-500 focus:outline-none resize-none"
              />
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex, i) => (
                  <button key={i} onClick={() => setBrief(ex.brief)} title={ex.brief}
                    className="text-xs px-3 py-1.5 rounded-lg bg-dt-card border border-dt-border text-dt-support hover:text-dt-body hover:border-dt-border-strong">
                    {ex.label}
                  </button>
                ))}
              </div>
              <button onClick={doDraft} disabled={busy || !isTenantAdmin}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors">
                {busy ? phase || 'Working…' : 'Draft my new employee'}
              </button>

              {/* Or hire a ready-made role (same DE, from a template) */}
              <div className="pt-3 border-t border-dt-border">
                <button onClick={() => setShowRoles((v) => !v)} disabled={busy}
                  className="text-xs text-dt-support hover:text-dt-body transition-colors">
                  {showRoles ? '▾ Hide ready-made roles' : '▸ Or hire from a ready-made role (Renewals, Billing, Sales…)'}
                </button>
                {showRoles && (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-dt-muted">
                      These come pre-built with a proven procedure, a book of work, and guardrails.
                      Pick one and the employee helps tailor it to your business next.
                    </p>
                    {archetypes.length === 0 ? (
                      <p className="text-xs text-dt-muted">Loading roles…</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {archetypes.map((a) => (
                          <button key={a.key} onClick={() => { setSelectedRole(a); setRoleDeName(a.name); }}
                            className={`text-left rounded-xl border p-3 transition-colors ${selectedRole?.key === a.key ? 'border-indigo-500 bg-indigo-500/10' : 'border-dt-border bg-dt-card hover:border-dt-border-strong'}`}>
                            <p className="text-xs font-semibold text-dt-title">{a.name}</p>
                            <p className="text-[11px] text-dt-muted">{a.domain}</p>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedRole && (
                      <div className="space-y-2">
                        <p className="text-xs text-dt-support">{selectedRole.description}</p>
                        <label className="block">
                          <span className="text-[11px] text-dt-muted">Name this employee</span>
                          <input value={roleDeName} onChange={(e) => setRoleDeName(e.target.value)}
                            className="mt-1 w-full bg-dt-card border border-dt-border rounded-lg px-3 py-2 text-xs text-dt-body focus:border-indigo-500 focus:outline-none" />
                        </label>
                        <button onClick={doArchetypeHire} disabled={busy || !isTenantAdmin}
                          className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-60 transition-colors">
                          {busy ? phase || 'Hiring…' : `Hire ${roleDeName.trim() || selectedRole.name}`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Step 2: meet the draft + interview ── */}
          {step === 'meet' && draft && (
            <>
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 flex gap-3">
                <div className="w-11 h-11 rounded-xl bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-dt-accent-text text-lg font-bold flex-shrink-0">
                  {persona.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-dt-title">{persona} — {roleName}</p>
                  <p className="text-xs text-dt-support mt-1">{draft.config.purpose_statement || draft.config.description}</p>
                </div>
              </div>

              {/* ── What you are actually signing up for (docs/17 C5) ──────
                  Four real facts, in the words someone would use out loud.
                  ⚠ An earlier design pass proposed replacing these with two
                  capability lists — "she'll be able to…" and "she'll always
                  ask you first". That is wrong on the facts: at hire she is
                  fully supervised and drafts only, so there is nothing she
                  does alone yet and the first list would have been empty or,
                  worse, invented. These four stay; only the words change.
                  The labels were 11px over 12px body — the reassuring half
                  set smaller than the claim it reassures about. */}
              <div className="rounded-xl bg-dt-card border border-dt-border p-4 grid sm:grid-cols-2 gap-x-5 gap-y-3">
                <div>
                  <p className="text-xs font-medium text-dt-body">On her first day</p>
                  <p className="text-xs text-dt-support mt-0.5">She drafts everything and sends nothing. You approve every message until she's earned more.</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-dt-body">How she earns more</p>
                  {/* The most reassuring sentence in the product, and it was
                      the smallest thing on the card. */}
                  <p className="text-xs text-dt-support mt-0.5">By getting things right — test scores and real accuracy. Never by you flipping a switch.</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-dt-body">What she costs</p>
                  <p className="text-xs text-dt-support mt-0.5">A fraction of a cent per answer, capped by the monthly budget you set.</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-dt-body">What she can't do</p>
                  <p className="text-xs text-dt-support mt-0.5">Your rules apply from her first answer, and {persona} can't switch them off.</p>
                </div>
              </div>

              {/* ⚠ THE BUY-VS-BUILD CITATION BLOCK WAS HERE AND IS DELIBERATELY
                  GONE. Four external links (MIT NANDA, Gartner, competitor
                  pricing teardowns) sat mid-setup, on the screen AFTER someone
                  had already clicked Hire. Selling to a customer who has
                  bought costs their attention at the exact moment they are
                  being asked to check a name, resolve a knowledge conflict and
                  answer two questions — and three of the four links led out of
                  the product. The argument belongs on a marketing page, not in
                  a setup flow. */}

              {draft.study.coverage && (
                <div className="rounded-xl bg-dt-card border border-dt-border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">What I found in your knowledge</p>
                  <p className="text-xs text-dt-support">{draft.study.coverage}</p>
                </div>
              )}

              {draft.study.contradictions.length > 0 && (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-amber-400">Conflicts worth fixing</p>
                  {draft.study.contradictions.map((c, i) => (
                    <p key={i} className="text-xs text-dt-warn">
                      The role expects <span className="font-medium">{c.role_expects}</span>, but “{c.source_title}” says <span className="font-medium">{c.kb_says}</span>.
                    </p>
                  ))}
                </div>
              )}

              {draft.study.questions.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-dt-support">
                    Before {persona} starts, they have {draft.study.questions.length} questions for you.
                    Answer any of them — every answer becomes knowledge {persona} will actually use.
                    You can also skip and answer later.
                  </p>
                  {draft.study.questions.map((q, i) => (
                    <label key={i} className="block">
                      <span className="text-xs text-dt-support">{i + 1}. {q}</span>
                      <textarea
                        value={answers[i] ?? ''}
                        onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
                        rows={2}
                        placeholder="Your answer (optional)"
                        className="mt-1 w-full bg-dt-card border border-dt-border rounded-lg px-3 py-2 text-xs text-dt-body focus:border-indigo-500 focus:outline-none resize-none"
                      />
                    </label>
                  ))}
                </div>
              )}

              {goldenSaved > 0 && (
                <p className="text-[11px] text-dt-muted">
                  {goldenSaved} exam questions were prepared from this role — they become {persona}’s certification test.
                </p>
              )}

              <div className="flex gap-3">
                {/* advance_de_lifecycle is owner/admin, like the two buttons
                    earlier in this wizard. This one was missed when they were
                    gated — the whole point of the checker. */}
                <button onClick={doTeachAndRehearse} disabled={!isTenantAdmin}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-40">
                  {answeredCount > 0 ? `Teach ${persona} & run the rehearsal` : 'Run the rehearsal'}
                </button>
                {answeredCount === 0 && draft.study.questions.length > 0 && (
                  <span className="self-center text-[11px] text-dt-muted">No answers yet — that’s fine.</span>
                )}
              </div>
            </>
          )}

          {/* ── Step 3: working ── */}
          {step === 'working' && (
            <div className="py-10 text-center space-y-4">
              <div className="mx-auto w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
              <p className="text-sm text-dt-support">{phase || 'Working…'}</p>
              <p className="text-[11px] text-dt-muted">This is a real rehearsal — live answers, really judged. Usually under a minute.</p>
            </div>
          )}

          {/* ── Step 4: results ── */}
          {step === 'done' && draft && (
            <>
              <div className="rounded-xl border border-dt-border bg-dt-card p-4">
                <p className="text-sm font-semibold text-dt-title mb-1">{persona} is {describeStage(promo?.reachedStage ?? 'designed')}.</p>
                {teach?.knowledgeDocId && (
                  <p className="text-xs text-dt-support">✓ Your interview answers were saved as company knowledge{teach.embeddedChunks > 0 ? ' and indexed' : ' (indexing finishes automatically)'}.</p>
                )}
                {teach?.playbookName && (
                  <p className="text-xs text-dt-support">✓ A draft playbook “{teach.playbookName}” was written from your answers — review it in the Playbook Builder when ready.</p>
                )}
                {teach?.playbookError && (
                  <p className="text-xs text-amber-400/80">The playbook draft didn’t complete ({teach.playbookError}) — your answers are still saved as knowledge.</p>
                )}
              </div>

              {rehearsal && (
                <div className={`rounded-xl border p-4 ${rehearsal.passed === rehearsal.total && rehearsal.total > 0 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
                  <p className="text-sm text-dt-title font-medium">
                    Rehearsal: {rehearsal.passed} of {rehearsal.total} answers passed the judge (average score {Math.round(rehearsal.avgScore)}).
                  </p>
                  <button onClick={() => setShowScenarios((v) => !v)} className="text-[11px] text-dt-support hover:text-dt-body underline mt-1">
                    {showScenarios ? 'Hide the questions and answers' : 'See every question and answer'}
                  </button>
                  {showScenarios && (
                    <div className="mt-3 space-y-3">
                      {rehearsal.scenarios.map((s, i) => (
                        <div key={i} className="rounded-lg bg-dt-inset p-3">
                          <p className="text-xs text-dt-support font-medium">Q: {s.question}</p>
                          <p className="text-xs text-dt-support mt-1 whitespace-pre-wrap">{s.answer.slice(0, 500)}{s.answer.length > 500 ? '…' : ''}</p>
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
                  <p className="text-xs text-dt-warn">The live rehearsal couldn’t run: {rehearsalError}. {persona} was still created — rehearse from their profile when ready.</p>
                </div>
              )}

              {promo && (promo.todo.length > 0 || promo.blockedAt) && (
                <div className="rounded-xl border border-dt-border bg-dt-card p-4">
                  <p className="text-xs text-dt-support font-medium mb-2">
                    To reach the next stage{promo.blockedAt ? ` (${promo.blockedAt})` : ''}, {persona} still needs:
                  </p>
                  {promo.todo.length > 0 ? (
                    <ul className="space-y-1">
                      {promo.todo.map((t, i) => <li key={i} className="text-xs text-dt-support">• {t}</li>)}
                    </ul>
                  ) : (
                    <p className="text-xs text-dt-support">{promo.message || 'See the employee profile for details.'}</p>
                  )}
                </div>
              )}

              {/* docs/17 C5: Day-1 wins + the "what changes for the team" note. */}
              <div className="rounded-xl border border-dt-border bg-dt-card p-4">
                <p className="text-xs text-dt-support font-medium mb-2">Day-1 wins — five minutes that make {persona} real:</p>
                <ul className="space-y-1 text-xs text-dt-support">
                  <li>• Ask {persona} three real customer questions in chat and watch it cite your knowledge.</li>
                  <li>• Connect one system it should read from (Connected systems).</li>
                  <li>• Skim its guardrails on its Governance tab, so you know exactly where it must stop.</li>
                  <li>• Review its first drafts in Approvals — your edits are how it learns your voice.</li>
                </ul>
                <button
                  onClick={() => {
                    const note = `${persona} just joined as a digital employee. What changes: routine questions get first drafts from ${persona}, and a human reviews everything it sends until it earns trust. What doesn't change: you own every decision — ${persona} escalates anything uncertain to you. If it gets something wrong, edit the draft or its knowledge; that's how it learns.`;
                    void navigator.clipboard?.writeText(note);
                    setCommsCopied(true); setTimeout(() => setCommsCopied(false), 2000);
                  }}
                  className="mt-3 text-[11px] px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-indigo-500 hover:text-dt-body transition-colors">
                  {commsCopied ? 'Copied ✓' : 'Copy a "what changes for the team" note'}
                </button>
              </div>

              <button onClick={() => { forgetDraft(); onFinished(); onClose(); }}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                Done — take me to the team
              </button>
            </>
          )}

          {/* ── Archetype tailoring interview (AI-led, role-defined) ── */}
          {step === 'tailor' && selectedRole && (
            <>
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4">
                <p className="text-sm font-semibold text-dt-title mb-1">
                  {roleDeName.trim() || selectedRole.name} is hired — now let’s tailor it to your business.
                </p>
                <p className="text-xs text-dt-support">
                  A few questions about how your renewals actually run. Your answers become its systems, rules and procedure — which you’ll approve before anything goes live.
                </p>
              </div>

              <div className="space-y-4">
                {setupQuestions.map((q, i) => (
                  <div key={q.key}>
                    <p className="text-xs text-dt-support mb-1">{i + 1}. {q.question}</p>
                    {q.help && <p className="text-[11px] text-dt-muted mb-1">{q.help}</p>}
                    {q.kind === 'choice' && q.options ? (
                      <div className="flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                          <button key={opt} onClick={() => setSetupAnswers((prev) => ({ ...prev, [q.key]: opt }))}
                            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${setupAnswers[q.key] === opt ? 'border-dt-accent bg-dt-accent-soft text-dt-accent-text' : 'border-dt-border bg-dt-card text-dt-support hover:border-dt-border-strong'}`}>
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <textarea value={setupAnswers[q.key] ?? ''} rows={2}
                        onChange={(e) => setSetupAnswers((prev) => ({ ...prev, [q.key]: e.target.value }))}
                        placeholder="Your answer (optional)"
                        className="w-full bg-dt-card border border-dt-border rounded-lg px-3 py-2 text-xs text-dt-body focus:border-indigo-500 focus:outline-none resize-none" />
                    )}
                  </div>
                ))}
              </div>

              <button onClick={doTailorSetup} disabled={busy}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-60 transition-colors">
                {busy ? phase || 'Drafting…' : 'Draft my tailored setup'}
              </button>
              <p className="text-[11px] text-dt-muted text-center">
                Your answers become {roleDeName.trim() || selectedRole.name}’s grounding and a tailored draft SOP — which you review and publish before it goes live.
              </p>
            </>
          )}

          {/* ── Archetype hire result ── */}
          {step === 'archetype_done' && selectedRole && archResult && (
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                <p className="text-sm font-semibold text-dt-title mb-1">
                  {roleDeName.trim() || selectedRole.name} is hired from the {selectedRole.name} template.
                </p>
                <p className="text-xs text-dt-support">
                  It’s set up like a real employee — at designed/supervised — ready to be tailored to your business and walked through the certification gates.
                </p>
              </div>

              <div className="rounded-xl border border-dt-border bg-dt-card p-4 space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">What came with the role</p>
                <p className="text-xs text-dt-support">• {archResult.watchersCreated} book-of-work watcher(s) — what lands on its desk</p>
                <p className="text-xs text-dt-support">• Its standard operating procedure (SOP){archResult.sopPlaybookId ? '' : ' (draft)'}</p>
                <p className="text-xs text-dt-support">• {archResult.guardrailsCreated} guardrail(s) — its authority limits</p>
                <p className="text-xs text-dt-support">• {archResult.systemsInstalled} connected-system binding(s) — where it works</p>
              </div>

              {teach && (teach.knowledgeDocId || teach.playbookName || teach.playbookError) && (
                <div className="rounded-xl border border-dt-border bg-dt-card p-4 space-y-1">
                  <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Drafted from your answers</p>
                  {teach.knowledgeDocId && (
                    <p className="text-xs text-dt-support">✓ Your answers were saved as this employee’s knowledge{teach.embeddedChunks > 0 ? ' and indexed' : ' (indexing finishes automatically)'}.</p>
                  )}
                  {teach.playbookName && (
                    <p className="text-xs text-dt-support">✓ A tailored draft SOP “{teach.playbookName}” was written — review and publish it in the Playbook Builder.</p>
                  )}
                  {teach.playbookError && (
                    <p className="text-xs text-amber-400/80">The SOP draft didn’t complete ({teach.playbookError}) — your answers are still saved as knowledge.</p>
                  )}
                </div>
              )}

              {hasProposal && (
                <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-dt-accent-text mb-1">Proposed from your answers — you approve before it applies</p>
                  {tailoredProposal.partyScope && <p className="text-xs text-dt-support">• Scope: <span className="text-dt-title font-medium">{tailoredProposal.partyScope}</span></p>}
                  {tailoredProposal.discountPct != null && <p className="text-xs text-dt-support">• Discount allowed without approval: <span className="text-dt-title font-medium">{tailoredProposal.discountPct}%</span></p>}
                  {tailoredProposal.approvalCents != null && <p className="text-xs text-dt-support">• Human approval required above: <span className="text-dt-title font-medium">${(tailoredProposal.approvalCents / 100).toLocaleString()}</span></p>}
                  {tailoredProposal.systems.length > 0 && <p className="text-xs text-dt-support">• Systems to connect: <span className="text-dt-title font-medium">{tailoredProposal.systems.join(', ')}</span></p>}

                  {applyResult ? (
                    <p className="text-xs text-dt-ok pt-1">
                      ✓ Applied{(applyResult.discountUpdated || applyResult.approvalUpdated) ? ' — its discount/approval guardrails now match your answers.' : '.'}
                      {tailoredProposal.systems.length > 0 ? ` Connect ${tailoredProposal.systems.join(', ')} in Settings → Connectors so it can work your real records.` : ''}
                    </p>
                  ) : (tailoredProposal.discountPct != null || tailoredProposal.approvalCents != null) ? (
                    <button onClick={doApplyTailored} disabled={applyBusy}
                      className="mt-1 text-xs px-3 py-1.5 rounded-lg border text-dt-accent-text border-dt-accent-border hover:border-dt-accent disabled:opacity-50 transition-all">
                      {applyBusy ? 'Applying…' : 'Apply these guardrail thresholds'}
                    </button>
                  ) : tailoredProposal.systems.length > 0 ? (
                    <p className="text-[11px] text-dt-support pt-1">Connect {tailoredProposal.systems.join(', ')} in Settings → Connectors so it can work your real records.</p>
                  ) : null}
                </div>
              )}

              <p className="text-[11px] text-dt-muted">
                You can refine its rules, watchers, SOP and connections any time from the employee’s profile — the setup stays editable as your business changes.
              </p>

              <button onClick={() => { forgetDraft(); onFinished(); onClose(); }}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                Done — take me to the team
              </button>
            </>
          )}
        </div>
    </div>
  );
}
