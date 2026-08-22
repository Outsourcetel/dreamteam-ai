// DiscoveryInterviewPage — the surface that finally lets a customer REACH the
// discovery interview. (docs/superpowers/specs/2026-08-12-discovery-interview-
// design.md §5 "the arc", §7 "park, resume, failure".)
//
// ⚠ WHAT THIS PAGE IS FOR, stated bluntly because it is the whole reason it
// exists: the `discovery-interview` edge function has been complete and
// deployed for days and NOTHING IN THE PRODUCT CALLED IT. Every turn of it had
// only ever been driven by a scratch script holding the service key. This is
// the first customer-reachable caller.
//
// ── IT IS A CONVERSATION, NOT A FORM ────────────────────────────────────
// One question at a time, answered in the customer's own words. The sense of
// how much is left comes from the engine's own `coverage` and `done` (read
// through coverageProgress) — never from a step counter this page invented,
// because the spine is 14 dimensions and a good answer can close three of them
// at once. A wizard with 14 steps would be exactly the surface §2 decision 5
// rejected.
//
// ── PARK IS A FIRST-CLASS ACTION, IN TWO SIZES, AND THEY ARE DIFFERENT ──
//   1. "Ask me later" on THE CURRENT QUESTION. The topic stays owed and comes
//      back. The session keeps running. See ASK_ME_LATER_TEXT for how it is
//      sent and — importantly — for the honest bound on what is guaranteed.
//   2. "Stop for now" on THE WHOLE INTERVIEW, which is the engine's 'end'
//      action with status 'parked' or 'abandoned' plus a resume note. Both
//      statuses are offered as real, separately-explained choices; neither is
//      a default that quietly relabels the other.
//
// ⚠ AND A THIRD EXIT WHICH IS THE ONLY GENUINELY RESUMABLE ONE, offered
// alongside the other two rather than hidden: leaving WITHOUT stopping. A
// 'running' session keeps its transcript and coverage and picks up at the same
// question. A 'parked' one cannot — end_discovery_session is one-way, nothing
// in the database sets status back to 'running', and 'answer' refuses a
// non-running session with a 409. The trade is real and it is stated on
// screen: stopping writes up what was heard so far (emitProposals runs on
// 'end'), leaving writes up nothing. A customer choosing between "recommendations
// now, fresh conversation later" and "no recommendations yet, same conversation
// later" is choosing between two true things.
//
// ── THE 503 MUST NOT DEAD-END ───────────────────────────────────────────
// 'start' answers 503 llm_not_configured to a workspace with no AI engine it
// can use. startFailure turns it into a sentence naming the setting, who can
// change it and BOTH remedies the database itself offers (add a key, or switch
// back to the platform key), and `fix: 'ai_engine_settings'` becomes a button
// that lands on the right Settings tab.
//
// ⚠ CORRECTED 2026-08-17: this note used to claim the 503 was "the single most
// likely first experience", because a brand-new workspace has no key. It does
// not need one — resolve_llm_keys defaults to the PLATFORM key (migration
// 576:71-96) and production holds one, so a new workspace inherits a working
// engine. What actually reaches the branch is a workspace explicitly in `byo`
// mode with no key, or a key pulled out mid-conversation. The handling was
// right; the claim about who meets it was not.
//
// ── AND THE SILENT ZERO ─────────────────────────────────────────────────
// The emitter's `refused` count, and whether the model fill ran at all, ride
// back in the response and today die in a console.error inside an edge
// function nobody tails. outcomeReport is where they become sentences: "we
// could not ground anything", "your AI engine was not available", and "you
// have nothing to review" are three different facts and this screen never
// renders them the same.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PageHeaderV2, PanelCard, Banner, Button, Chip, Modal, EmptyState, INPUT_CLS,
} from '../../design/primitives';
import { LiveLoadingSkeleton } from '../../components/LiveDataStates';
import type { Page } from '../../types';
import {
  startInterview, answerInterview, endInterview, getLatestInterviewSession,
  type InterviewSessionRow,
} from '../../lib/discoveryInterviewApi';
import {
  EMPTY_INTERVIEW, startedState, answeredState, endedState, resumedState,
  coverageProgress, progressSentence, outcomeReport, resumeOffer,
  resumeHint, ASK_ME_LATER_TEXT, STOP_CONSEQUENCE,
  type InterviewState, type InterviewFailure, type StopIntent,
} from '../../lib/discoveryInterviewMachine';

export default function DiscoveryInterviewPage({ setPage }: { setPage?: (p: Page) => void }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<InterviewSessionRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [state, setState] = useState<InterviewState>(EMPTY_INTERVIEW);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InterviewFailure | null>(null);

  const [stopOpen, setStopOpen] = useState(false);
  const [stopIntent, setStopIntent] = useState<StopIntent>('parked');
  const [stopNote, setStopNote] = useState('');

  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setExisting(await getLatestInterviewSession());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [state.turns.length, busy]);

  const inConversation = state.sessionId !== null;
  // ⚠ NO CAST. coverageProgress takes the LOOSE wire shape and normalises it
  // itself, precisely so a state this build has never seen cannot be counted as
  // progress — casting the row into CoverageMap here would assert the enum was
  // safe rather than making it safe. See normalizeCoverage.
  const progress = coverageProgress(inConversation ? state.coverage : existing?.coverage);
  // ⚠ THE THIRD ARGUMENT IS THE DURABLE OUTCOME, and it is `?? null` rather
  // than `?? 0` on purpose. A session read that could not take the count hands
  // back null, and resumeOffer says "we could not check" for null and "it wrote
  // up nothing" for zero — two different true things.
  const offer = resumeOffer(existing, progress, existing?.proposal_count ?? null);

  // ── the three calls ──────────────────────────────────────────────────────

  const begin = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const res = await startInterview();
    if (res.outcome === 'failed') setFailure(res.failure);
    else setState(startedState(res.data, new Date().toISOString()));
    setBusy(false);
  }, []);

  /** Continue a session that is genuinely still running — transcript and
   *  coverage read straight off the row the engine has been writing. No engine
   *  call is needed or possible here: there is no 'resume' action, because a
   *  running session never stopped.
   *
   *  ⚠ THE STATUS CHECK IS NOT DECORATION. `resumedState` will happily
   *  rehydrate any row it is handed, and handing it a 'parked' one would put a
   *  composer in front of somebody whose every answer the engine refuses with a
   *  409. `resumeOffer` already labels the control "Start a new interview" for
   *  those, and this is the second half of that promise. */
  const resumeRunning = useCallback(() => {
    if (!existing || existing.status !== 'running') return;
    setFailure(null);
    setState(resumedState(existing));
  }, [existing]);

  /**
   * Abandon the interview in progress and begin a new one.
   *
   * ⚠ IT CLOSES THE OLD SESSION FIRST, and that is not tidiness. A second
   * 'running' session is perfectly legal — start_discovery_session always
   * INSERTs — and `getLatestInterviewSession` only ever returns the newest, so
   * the abandoned one becomes invisible AND stays 'running' forever: it never
   * reaches the emitter, so whatever the customer had already told it is lost
   * with no record that it existed. That is the invisible pile §7 names, minted
   * by a button labelled "start over". Ending it as 'abandoned' writes up what
   * WAS heard and leaves an honest status behind.
   *
   * ⚠ A FAILURE TO CLOSE DOES NOT BLOCK THE NEW ONE, but it is said out loud
   * rather than swallowed. Refusing to start because the tidy-up failed would
   * trap somebody on a screen whose only action is broken; starting silently
   * would hide a stranded session. So: start anyway, and report.
   */
  const startOver = useCallback(async () => {
    if (!existing || existing.status !== 'running') { void begin(); return; }
    setBusy(true);
    setFailure(null);
    const closed = await endInterview(existing.id, 'abandoned', 'Replaced by a new interview.');
    setBusy(false);
    await begin();
    if (closed.outcome === 'failed') {
      setFailure({
        ...closed.failure,
        message: `Your new interview has started. We could not close the previous one, though: ${closed.failure.message}`,
      });
    }
  }, [existing, begin]);

  /**
   * THE ONE CONTROL WHOSE LABEL IS DYNAMIC, AND THEREFORE THE ONE WHOSE ACTION
   * MUST NOT BE.
   *
   * ⚠ WHY THIS IS A NAMED FUNCTION AND NOT AN INLINE TERNARY. It was an inline
   * ternary — `offer.kind === 'running' ? resumeRunning() : void begin()` — and
   * that had two faults, one live and one waiting. Live: for a brand-new
   * workspace `existing` is null, so a reviewer's mutation replacing the whole
   * expression with `resumeRunning()` left "Start the interview" doing NOTHING
   * (resumeRunning early-returns without an existing running session) and the
   * suite stayed 95/95 green — a button whose label and behaviour are decided
   * by two different expressions, with only one of them pinned. Waiting: adding
   * a third `kind` puts it in the else branch silently, which is exactly what
   * happened to `finished`.
   *
   * The label and the action now come from the SAME object (`resumeOffer`
   * decides both), this reads the action rather than re-deriving it from the
   * kind, and the test suite pins the handler AND the element that calls it.
   *
   * ⚠ 'start' GOES THROUGH startOver, NEVER begin. `finished` is a session that
   * is still 'running' as far as the database is concerned (natural completion
   * never changes status), so begin() here would leave it 'running' and
   * invisible forever — the same orphaning startOver exists to stop. startOver
   * already degrades to a plain begin() when there is nothing to close.
   */
  const runPrimary = useCallback(() => {
    if (offer.primaryAction === 'proposals') { setPage?.('discovery_proposals'); return; }
    if (offer.primaryAction === 'resume') { resumeRunning(); return; }
    // 'start' — and, deliberately, anything a later `ResumeAction` adds
    // without editing this function. Beginning a conversation is the safe
    // fallback: startOver closes a live session before opening a new one, so
    // an unhandled action costs a click and can never strand an interview.
    // (The machine-side suite pins the ResumeAction union at three members, so
    // a fourth is a decision somebody has to take rather than a silent
    // fallthrough.)
    void startOver();
  }, [offer.primaryAction, resumeRunning, startOver, setPage]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || !state.sessionId || busy) return;
    setBusy(true);
    setFailure(null);
    const res = await answerInterview(state.sessionId, message);
    if (res.outcome === 'failed') {
      // ⚠ THE COMPOSER KEEPS THE TEXT. The answer is only appended to the
      // transcript once the engine has actually taken it — a transcript showing
      // words the engine never received, above an error saying they were not
      // recorded, is a screen contradicting itself.
      setFailure(res.failure);
    } else {
      setState((prev) => answeredState(prev, message, res.data, new Date().toISOString()));
      setInput('');
    }
    setBusy(false);
  }, [state.sessionId, busy]);

  const stop = useCallback(async () => {
    if (!state.sessionId) return;
    setStopOpen(false);
    setBusy(true);
    setFailure(null);
    const res = await endInterview(state.sessionId, stopIntent, resumeHint(stopNote));
    if (res.outcome === 'failed') setFailure(res.failure);
    else setState((prev) => endedState(prev, res.data));
    setBusy(false);
    await load();
  }, [state.sessionId, stopIntent, stopNote, load]);

  // ── what a failure lets you do about it ──────────────────────────────────

  const goToAiEngine = () => {
    // The deep-link hand-off SettingsPage already reads — the same mechanism
    // GettingStartedGuide uses for the Widget tab. Not a new channel.
    try { localStorage.setItem('dt_settings_tab', 'ai_engine'); } catch { /* private mode — the tab just opens on its default */ }
    setPage?.('settings');
  };

  const failureActions = (f: InterviewFailure) => (
    <div className="flex items-center gap-2 flex-wrap mt-3">
      {f.fix === 'ai_engine_settings' && (
        <Button kind="primary" size="sm" onClick={goToAiEngine}>Open Settings → AI Engine</Button>
      )}
      {f.fix === 'reload' && (
        <Button kind="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button>
      )}
      {f.fix === 'restart' && (
        <Button kind="secondary" size="sm" disabled={busy} onClick={() => { setState(EMPTY_INTERVIEW); setFailure(null); void load(); }}>
          Start a new interview
        </Button>
      )}
      {f.retryable && state.sessionId && (
        <Button kind="secondary" size="sm" disabled={busy || !input.trim()} onClick={() => void send(input)}>
          Try that answer again
        </Button>
      )}
      <Button kind="ghost" size="sm" onClick={() => setPage?.('dashboard')}>Not now — take me to the dashboard</Button>
    </div>
  );

  // ── render ───────────────────────────────────────────────────────────────

  const finished = state.ended !== null || (state.done && state.question === null);
  const report = finished ? outcomeReport(state.emission) : null;

  return (
    <div className="px-6 pt-8 pb-10 max-w-dt-content mx-auto space-y-6">
      <PageHeaderV2
        title="Tell us about your business"
        subtitle="A short conversation in plain English. We draft the setup that fits what you actually do — and nothing is created until you approve it."
        actions={
          // ⚠ ALWAYS PRESENT, on every state of this page. Landing a new
          // customer in an interview with no way out is worse than the empty
          // dashboard it replaces, and this is the way out. It is a link, not a
          // decision: a running interview stays exactly where it is and this
          // page will offer to continue it next time.
          <Button kind="ghost" size="sm" onClick={() => setPage?.('dashboard')}>Skip for now</Button>
        }
      />

      {loading && <LiveLoadingSkeleton rows={4} />}

      {!loading && loadError && !inConversation && (
        <Banner tone="danger">
          <div className="flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button kind="secondary" size="sm" onClick={() => void load()}>Retry</Button>
          </div>
        </Banner>
      )}

      {/* ── the offer, before anything has started ───────────────────────── */}
      {!loading && !inConversation && (
        <PanelCard title={offer.headline}>
          <p className="text-sm text-dt-support leading-relaxed">{offer.body}</p>

          {failure && (
            <div className="mt-4">
              <Banner tone="danger">{failure.message}</Banner>
              {failureActions(failure)}
            </div>
          )}

          {!failure && (
            <div className="flex items-center gap-2 flex-wrap mt-4">
              <Button
                kind="primary"
                size="sm"
                disabled={busy}
                onClick={runPrimary}
              >
                {busy ? 'Starting…' : offer.primaryLabel}
              </Button>
              {/* ⚠ startOver, NOT begin. See startOver's own note: calling
                  begin() here leaves the interview in progress 'running' and
                  invisible forever, losing everything it had heard with no
                  record that it existed. */}
              {offer.kind === 'running' && (
                <Button kind="secondary" size="sm" disabled={busy} onClick={() => void startOver()}>
                  Start over instead
                </Button>
              )}
              {/* A finished interview whose recommendations are the primary
                  action still needs the other door — some people want to run it
                  again rather than read what came out. startOver, for the same
                  reason as above: the finished session is still 'running'. */}
              {offer.kind === 'finished' && offer.primaryAction === 'proposals' && (
                <Button kind="secondary" size="sm" disabled={busy} onClick={() => void startOver()}>
                  Run another interview
                </Button>
              )}
              {offer.kind === 'closed' && (
                <Button kind="secondary" size="sm" onClick={() => setPage?.('discovery_proposals')}>
                  See what we already recommend
                </Button>
              )}
            </div>
          )}

          {/* ⚠ THE INTERVIEW DOES NOT DO EVERYTHING COMPANY SETUP DOES, and
              saying so here is cheaper than a customer discovering it. The old
              wizard also writes the industry onto the workspace (with its
              vocabulary, pipeline stages and customer-record fields) and holds
              the branding and brand-identity cards. None of that is in the
              spine, and this page does not quietly replace it. */}
          <p className="text-xs text-dt-muted leading-relaxed mt-5 pt-4 border-t border-dt-border">
            This conversation covers what your business does and who should do it. Your industry, workspace
            vocabulary, pipeline stages and branding still live under{' '}
            <button className="underline hover:text-dt-body" onClick={() => setPage?.('company_setup')}>Company Setup</button>
            {' '}— the interview does not set those.
          </p>
        </PanelCard>
      )}

      {/* ── the conversation ─────────────────────────────────────────────── */}
      {inConversation && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <Chip tone={progress.remaining === 0 ? 'ok' : 'info'}>{progressSentence(progress)}</Chip>
            {progress.skipped > 0 && (
              <Chip tone="neutral">{progress.skipped} not relevant to you</Chip>
            )}
          </div>

          <PanelCard title="Your setup conversation">
            <div className="space-y-4 max-h-[52vh] overflow-y-auto pr-1">
              {state.turns.map((t, i) => (
                <div key={i} className={t.role === 'you' ? 'flex justify-end' : ''}>
                  <div
                    className={
                      t.role === 'you'
                        ? 'bg-dt-panel border border-dt-border rounded-xl px-4 py-2.5 max-w-[85%] text-sm text-dt-body whitespace-pre-wrap'
                        : 'max-w-[95%] text-sm text-dt-body whitespace-pre-wrap leading-relaxed'
                    }
                  >
                    {t.role === 'interviewer' && (
                      <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">Setup</div>
                    )}
                    {t.text}
                  </div>
                </div>
              ))}
              {busy && <p className="text-xs text-dt-muted">Thinking about what you said…</p>}
              <div ref={endRef} />
            </div>
          </PanelCard>

          {failure && (
            <div>
              <Banner tone="danger">{failure.message}</Banner>
              {failureActions(failure)}
            </div>
          )}

          {/* ── composer, only while a question is actually outstanding ──── */}
          {state.question !== null && state.ended === null && (
            <PanelCard title="Your answer">
              <textarea
                className={INPUT_CLS}
                rows={4}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(input); }
                }}
                placeholder="In your own words — the more specific, the better. Names, numbers, what actually happens."
                aria-label="Your answer"
                disabled={busy}
              />
              <div className="flex items-center gap-2 flex-wrap mt-3">
                <Button kind="primary" size="sm" disabled={busy || !input.trim()} onClick={() => void send(input)}>
                  {busy ? 'Sending…' : 'Send'}
                </Button>
                {/* ⚠ PARK, PER QUESTION — a first-class control sitting next to
                    Send, not something buried. It sends the phrasing the
                    engine's own prompt names as the park trigger, and the topic
                    comes back either way: an answer with no concrete fact in it
                    cannot close a dimension, because coverageAfter refuses a
                    'heard' or 'skipped' entry with no evidence. */}
                <Button kind="secondary" size="sm" disabled={busy} onClick={() => void send(ASK_ME_LATER_TEXT)}>
                  Ask me later
                </Button>
                {/* ⚠ THE INTENT RESETS TO 'parked' EVERY TIME. It is state,
                    and state remembers: somebody who picked "I am done", backed
                    out, and reopened the dialog later would find the
                    irreversible option pre-selected from a decision they had
                    already abandoned. The recoverable choice is the default. */}
                <Button kind="ghost" size="sm" disabled={busy} onClick={() => { setStopNote(''); setStopIntent('parked'); setStopOpen(true); }}>
                  Stop for now
                </Button>
                <span className="text-xs text-dt-muted ml-auto">Ctrl/⌘ + Enter sends</span>
              </div>
              {/* The honest third exit, stated rather than implied. */}
              <p className="text-xs text-dt-muted mt-3 leading-relaxed">
                You can also just leave this page — the conversation stays exactly where it is and this screen will
                offer to carry on next time. Nothing is written up until you stop or finish, though.
              </p>
            </PanelCard>
          )}

          {/* ── it's over — say what actually came out of it ───────────────── */}
          {finished && report && (
            <PanelCard title={state.ended === 'abandoned' ? 'Interview stopped' : state.ended === 'parked' ? 'Interview set aside' : 'That is everything we needed'}>
              <Banner tone={report.tone === 'ok' ? 'info' : report.tone === 'warn' ? 'warn' : 'danger'}>
                <div className="font-medium">{report.headline}</div>
                <p className="mt-1 leading-relaxed">{report.body}</p>
              </Banner>

              {progress.remaining > 0 && (
                <p className="text-sm text-dt-support mt-4 leading-relaxed">
                  {progress.remaining} topic{progress.remaining === 1 ? '' : 's'} were never covered
                  {progress.parked > 0 ? ` (${progress.parked} you asked to come back to)` : ''} — so the setup we drafted
                  is shaped by what we did hear, and says nothing about the rest. That is recorded rather than guessed at.
                </p>
              )}

              <div className="flex items-center gap-2 flex-wrap mt-4">
                {report.hasProposals && (
                  <Button kind="primary" size="sm" onClick={() => setPage?.('discovery_proposals')}>
                    See what we recommend
                  </Button>
                )}
                <Button kind="secondary" size="sm" disabled={busy} onClick={() => { setState(EMPTY_INTERVIEW); setFailure(null); setInput(''); void load(); }}>
                  {report.hasProposals ? 'Run another interview' : 'Try the interview again'}
                </Button>
                <Button kind="ghost" size="sm" onClick={() => setPage?.('dashboard')}>Back to the dashboard</Button>
              </div>
            </PanelCard>
          )}
        </>
      )}

      {!loading && !inConversation && offer.kind === 'none' && !failure && (
        <EmptyState headline="Nothing has been set up from a conversation yet">
          Once the interview has heard something about your business, everything it recommends waits for you under
          “What we recommend” — accepted item by item, never in one click.
        </EmptyState>
      )}

      {/* ── stopping: two real choices, each with its consequence ────────── */}
      {stopOpen && (
        <Modal size="md" title="Stopping the interview" onClose={() => setStopOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-dt-support leading-relaxed">
              {progressSentence(progress)} Whichever you choose, we write up what you have told us so far —
              you will have recommendations to look at either way.
            </p>

            {/* ⚠ TWO STATUSES, NOT ONE WITH A NICER NAME. 'parked' and
                'abandoned' land differently in the database and migration 739's
                own probes assert it. Collapsing them here would make the
                distinction decorative. */}
            <div className="space-y-2">
              {(['parked', 'abandoned'] as StopIntent[]).map((intent) => (
                <button
                  key={intent}
                  onClick={() => setStopIntent(intent)}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                    stopIntent === intent
                      ? 'border-dt-accent bg-dt-accent-soft'
                      : 'border-dt-border bg-dt-card hover:border-dt-border-strong'
                  }`}
                >
                  <div className="text-sm font-medium text-dt-body">
                    {intent === 'parked' ? 'I want to come back to this' : 'I am done — do not ask me again'}
                  </div>
                  <p className="text-xs text-dt-support mt-1 leading-relaxed">{STOP_CONSEQUENCE[intent]}</p>
                </button>
              ))}
            </div>

            <div>
              <label className="block text-sm font-medium text-dt-body mb-1">
                Where did you get to? <span className="text-dt-muted font-normal">(optional)</span>
              </label>
              <p className="text-xs text-dt-muted mb-1.5">
                Saved with the interview so whoever picks this up knows what was left — it is the only record of that.
              </p>
              <textarea
                className={INPUT_CLS}
                rows={3}
                value={stopNote}
                onChange={(e) => setStopNote(e.target.value)}
                placeholder="Need to check the numbers with our accountant before answering the money questions…"
                aria-label="Where you got to"
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button kind="ghost" size="sm" onClick={() => setStopOpen(false)}>Keep going</Button>
              <Button kind="primary" size="sm" disabled={busy} onClick={() => void stop()}>
                {stopIntent === 'parked' ? 'Set it aside' : 'Stop for good'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
