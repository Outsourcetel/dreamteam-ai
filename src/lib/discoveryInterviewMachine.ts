// discoveryInterviewMachine.ts — the PURE half of the discovery interview
// surface: what a turn does to the conversation, how much of the spine is
// left, what to say when the engine refuses, and what to say when the
// interview ends having produced nothing.
//
// PURE ON PURPOSE, exactly as src/lib/discoveryProposalPresentation.ts is: no
// supabase import, no React, no I/O. There is no component-test harness in
// this repo, so a rule that lives inside a page component is a rule nothing
// can prove. Everything here is provable by tests/discovery-interview.test.ts,
// and the page is left with rendering.
//
// ── THE THREE THINGS THIS FILE EXISTS TO STOP ────────────────────────────
//
// 1. A CODE ON SCREEN. `startFailure` turns each of the engine's real error
//    codes into a sentence a business owner can act on plus, where one
//    exists, the place to go. It branches on the CODE, never on the sentence:
//    the sentence is written for a person and will be rewritten for a person.
//
//    ⚠ CORRECTED 2026-08-17. The earlier version of this note, and the two
//    files that repeated it, said 503 `llm_not_configured` was the branch a
//    brand-new workspace would meet first — on the ground that a new
//    workspace has no AI engine key of its own. The ground is true; the
//    conclusion does not follow, and it never did. (The retracted sentence is
//    described here rather than quoted: a file repeating a false claim
//    verbatim reads, to every grep and every skim, like a file still making
//    it.) `resolve_llm_keys` (migration 576:71-96)
//    reads `coalesce(tenants.llm_key_mode, 'platform')`, so a workspace with
//    no key of its own falls through to the PLATFORM secret — and production
//    has one (`platform_config.ANTHROPIC_API_KEY` carries a `secret_id`;
//    checked against the live database, and all 18 tenants read
//    `llm_key_mode = 'platform'`). So a brand-new workspace inherits a
//    working engine and this branch does not fire for it.
//
//    What actually reaches it is a workspace explicitly switched to `byo`
//    with no key of its own, or one whose key was removed mid-conversation.
//    The HANDLING was right and stays; the RECORD was wrong. Two consequences
//    are carried below: the message names BOTH remedies the database itself
//    offers (add a key, or switch back to the platform key), and the sentence
//    branches on the PHASE, because "nothing was started" is true of `start`
//    and false of a key pulled out from under a half-answered interview.
//
// 2. AN INVENTED PROGRESS BAR. The engine returns `coverage` and `done` every
//    turn and they are the only true statement of where the conversation is.
//    `coverageProgress` counts THOSE, and it counts `parked` as still owed —
//    because the engine does (stillOwed treats parked as owed forever, which
//    is what makes "ask me later" come back). A bar that counted parked as
//    finished would show 14/14 on an interview that has closed nothing.
//
// 3. AN EMPTY SCREEN THAT MEANS SOMETHING ELSE. The engine already knows why
//    it proposed nothing — `refused`, `model_fill`, `skipped_already_proposed`
//    ride back in the response — and today those die in a console.error inside
//    an edge function nobody tails. `outcomeReport` is where they become
//    sentences. "We could not ground anything" and "you have nothing to
//    review" are opposite facts and they must never render the same.

// ── the engine's wire types, as this client actually reads them ───────────

export type DimensionState = 'heard' | 'parked' | 'skipped' | 'not_heard';

export interface CoverageEntry {
  state: DimensionState;
  evidence?: string | null;
  recorded_at?: string;
}

export type CoverageMap = Record<string, CoverageEntry>;

/** Why the model fill did or did not run — `ModelFillOutcome` in
 *  supabase/functions/discovery-interview/index.ts, verbatim. */
export type ModelFillOutcome = 'not_needed' | 'ran' | 'skipped_no_llm' | 'skipped_ai_budget';

/** What emitProposals reports back. Every field is load-bearing for
 *  `outcomeReport`; none of them may be defaulted away. */
export interface ProposalEmission {
  proposed: number;
  refused: number;
  skipped_already_proposed: boolean;
  model_fill: ModelFillOutcome;
}

export interface StartResponse {
  session_id: string;
  question: string;
}

export interface AnswerResponse {
  question: string | null;
  coverage: CoverageMap;
  done: boolean;
  proposals?: ProposalEmission;
}

export interface EndResponse {
  session_id: string;
  status: 'parked' | 'abandoned';
  previous_status?: string;
  resume_hint?: string | null;
  coverage: CoverageMap;
  owed: string[];
  owed_count: number;
  proposals: ProposalEmission;
  done: true;
}

// ── the conversation, as the screen holds it ──────────────────────────────

export interface Turn {
  role: 'interviewer' | 'you';
  text: string;
  /** ISO. Carried so a resumed transcript renders in the order it happened. */
  at?: string;
}

/** Everything the page renders, in one object.
 *
 *  ⚠ `question` is SEPARATE from `turns` and that is not redundancy. The
 *  outstanding question is the thing the composer is answering — it decides
 *  whether the input is enabled, what the Ask-me-later button parks, and
 *  whether the interview is over. Deriving it from "the last turn whose role
 *  is interviewer" would be right until the moment the engine returns
 *  `question: null` on completion, at which point the last interviewer turn is
 *  a question that has already been answered and the composer would re-open. */
export interface InterviewState {
  sessionId: string | null;
  turns: Turn[];
  /** The question awaiting an answer. null once the spine is closed or the
   *  session has ended. */
  question: string | null;
  coverage: CoverageMap;
  done: boolean;
  /** Set once the session leaves 'running' — see `endedState`. */
  ended: null | 'parked' | 'abandoned';
  /** Present only once the engine has actually reported an emission. */
  emission: ProposalEmission | null;
}

export const EMPTY_INTERVIEW: InterviewState = {
  sessionId: null,
  turns: [],
  question: null,
  coverage: {},
  done: false,
  ended: null,
  emission: null,
};

/** A fresh interview from the engine's `start` answer. */
export function startedState(res: StartResponse, at?: string): InterviewState {
  return {
    ...EMPTY_INTERVIEW,
    sessionId: res.session_id,
    turns: [{ role: 'interviewer', text: res.question, at }],
    question: res.question,
  };
}

/**
 * One turn: the customer's words, then whatever the engine said back.
 *
 * ⚠ THE ANSWER IS APPENDED HERE, NOT OPTIMISTICALLY BEFORE THE CALL. An
 * optimistic append reads better for a fraction of a second and then has to be
 * un-done on every failure path — and the failure paths here are real and
 * frequent (429 budget, 503 key removed mid-interview, 409 ended in another
 * tab). A transcript that shows an answer the engine never received, next to
 * an error saying it was not recorded, is a screen that contradicts itself.
 * The page keeps the unsent text in the composer until this returns.
 *
 * ⚠ `done` COMES FROM THE ENGINE, never from `coverageProgress`. The engine
 * computes it from the real ledger (`stillOwed(newCoverage).length === 0`) and
 * this client must not hold a second opinion about when an interview is over.
 * The progress numbers below are for a human to look at; this is the fact.
 */
export function answeredState(prev: InterviewState, answer: string, res: AnswerResponse, at?: string): InterviewState {
  const turns: Turn[] = [...prev.turns, { role: 'you' as const, text: answer, at }];
  if (res.question) turns.push({ role: 'interviewer', text: res.question, at });
  return {
    ...prev,
    turns,
    question: res.question,
    coverage: res.coverage ?? prev.coverage,
    done: res.done === true,
    // A natural completion emits proposals on the SAME response. Keeping a
    // previous emission when this one carries none would let a later turn's
    // silence overwrite nothing — but it also must never invent one.
    emission: res.proposals ?? prev.emission,
  };
}

/** A transcript turn as `discovery_sessions.transcript` actually stores it. */
export interface StoredTurn { role?: string; text?: unknown; at?: string }

/**
 * Rehydrate a still-RUNNING session from the row the engine has been writing,
 * so "come back later" means the same conversation rather than a new one.
 *
 * The stored transcript speaks the engine's words ('user' / 'assistant'); this
 * screen speaks the customer's ('you' / 'interviewer'), so the translation
 * happens here and no reader is ever shown a schema word.
 *
 * ⚠ THE OUTSTANDING QUESTION IS NOT SIMPLY "THE LAST INTERVIEWER TURN". Two
 * cases make that wrong, and both are reachable:
 *
 *  · the engine writes the transcript BEST-EFFORT after the coverage ledger
 *    (a failure there is logged and the turn still counts), so a session can
 *    legitimately end its transcript on a customer turn with the next question
 *    lost. Walking back to the previous interviewer turn re-asks it, which is
 *    right — the ledger says that dimension is still owed.
 *
 *  · a session whose spine has CLOSED but whose status never left 'running'
 *    (natural completion does not change status — only 'end' does, which is
 *    why discoveryApi's own header says so). Its last interviewer turn is a
 *    question that has already been answered. Re-opening the composer there
 *    would offer a control whose only possible outcome is the engine's
 *    "nothing is owed" early-return. So the coverage ledger decides: nothing
 *    remaining means no outstanding question, whatever the transcript ends on.
 */
export function resumedState(session: {
  id: string;
  coverage?: Record<string, { state?: unknown; evidence?: unknown }> | null;
  transcript?: unknown;
}): InterviewState {
  const raw = Array.isArray(session.transcript) ? (session.transcript as StoredTurn[]) : [];
  const turns: Turn[] = raw
    .filter((t) => t && typeof t.text === 'string' && t.text.trim().length > 0)
    .map((t) => ({
      role: t.role === 'user' ? ('you' as const) : ('interviewer' as const),
      text: String(t.text),
      at: t.at,
    }));
  const coverage = normalizeCoverage(session.coverage);
  const remaining = coverageProgress(coverage).remaining;
  let question: string | null = null;
  if (remaining > 0) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'interviewer') { question = turns[i].text; break; }
    }
  }
  return {
    ...EMPTY_INTERVIEW,
    sessionId: session.id,
    turns,
    question,
    coverage,
    // A running session with nothing owed IS done — the engine would say so on
    // the next call. Saying it here avoids offering a composer that can only
    // ever be answered with "there is nothing left to ask".
    done: remaining === 0 && Object.keys(coverage).length > 0,
  };
}

/**
 * The session stopped. `end` is the only path out of 'running', and both of
 * its statuses are real, different things: 'parked' means the customer means
 * to come back, 'abandoned' means they do not.
 *
 * ⚠ THE QUESTION IS CLEARED. An ended session refuses another answer (409
 * `session_not_running`), so leaving the composer open would offer a control
 * whose every use is a refusal — the exact "looks live, does nothing" shape
 * this programme keeps finding.
 */
export function endedState(prev: InterviewState, res: EndResponse): InterviewState {
  return {
    ...prev,
    question: null,
    coverage: res.coverage ?? prev.coverage,
    ended: res.status,
    done: true,
    emission: res.proposals ?? prev.emission,
  };
}

// ── where the conversation actually is ────────────────────────────────────

export interface CoverageProgress {
  total: number;
  heard: number;
  parked: number;
  skipped: number;
  notHeard: number;
  /** Dimensions the engine will not ask about again: heard + skipped. */
  closed: number;
  /** What `stillOwed` owes: not_heard + parked. Never zero while parked > 0. */
  remaining: number;
  /** 0-100, of `closed` over `total`. 0 when the spine is not loaded yet. */
  percent: number;
}

/**
 * Count the engine's own ledger.
 *
 * ⚠ `parked` COUNTS AS REMAINING, and getting this backwards is the whole
 * defect. supabase/functions/_shared/discoveryCoverage.ts's `stillOwed` returns
 * every dimension that is `not_heard` OR `parked` — that is what makes "ask me
 * later" come back rather than quietly vanishing, and it is why an interview
 * with a single parked dimension can never reach done:true on its own. A bar
 * that shaded parked as progress would tell a customer they had finished a
 * conversation the engine considers open.
 *
 * ⚠ `skipped` COUNTS AS CLOSED, and that is the OTHER half of §7's four
 * states. "Not relevant to us" stops the asking; collapsing it into parked
 * would nag someone who already declined, and collapsing parked into skipped
 * would bin something they meant to return to.
 */
export const DIMENSION_STATES: readonly DimensionState[] = ['heard', 'parked', 'skipped', 'not_heard'];

/**
 * Coerce a coverage map read off the wire into the four states this screen
 * knows, so an unrecognised one cannot be counted as progress.
 *
 * ⚠ AN UNKNOWN STATE BECOMES `not_heard`, NOT DROPPED, AND THE DIRECTION IS
 * THE POINT. Dropping it would shrink `total` and quietly RAISE the percentage
 * — a workspace whose ledger held something this build has never seen would be
 * told it had covered more of the interview than it had. Counting it as owed
 * understates progress instead, which is the safe direction and the one the
 * engine itself takes (`stillOwed` returns anything that is not heard or
 * skipped).
 *
 * The database makes this unreachable today: migration 737's
 * `discovery_sessions_coverage_states` CHECK refuses any state outside the
 * four, and migration 738 probes it in both directions. It is here because the
 * wire type is `string` and a client that trusts a server's enum is a client
 * that breaks the day the enum grows.
 */
export function normalizeCoverage(
  raw: Record<string, { state?: unknown; evidence?: unknown }> | null | undefined,
): CoverageMap {
  const out: CoverageMap = {};
  for (const [key, entry] of Object.entries(raw ?? {})) {
    const state = typeof entry?.state === 'string' && (DIMENSION_STATES as readonly string[]).includes(entry.state)
      ? (entry.state as DimensionState)
      : 'not_heard';
    out[key] = { state, evidence: typeof entry?.evidence === 'string' ? entry.evidence : null };
  }
  return out;
}

export function coverageProgress(
  coverage: Record<string, { state?: unknown; evidence?: unknown }> | null | undefined,
): CoverageProgress {
  const entries = Object.values(normalizeCoverage(coverage));
  const count = (s: DimensionState) => entries.filter((e) => e.state === s).length;
  const heard = count('heard');
  const parked = count('parked');
  const skipped = count('skipped');
  const notHeard = count('not_heard');
  const total = entries.length;
  const closed = heard + skipped;
  return {
    total,
    heard,
    parked,
    skipped,
    notHeard,
    closed,
    remaining: notHeard + parked,
    percent: total > 0 ? Math.round((closed / total) * 100) : 0,
  };
}

/** The progress line, in the customer's language rather than the schema's.
 *  Never "14 dimensions" — the spine is our word, not theirs. */
export function progressSentence(p: CoverageProgress): string {
  if (p.total === 0) return 'Getting started…';
  if (p.remaining === 0) return `All ${p.total} topics covered.`;
  const parts = [`${p.closed} of ${p.total} topics covered`];
  if (p.parked > 0) parts.push(`${p.parked} set aside to come back to`);
  return `${parts.join(' · ')}.`;
}

// ── when the engine says no ───────────────────────────────────────────────

/** The engine's own machine-readable refusal codes, from
 *  supabase/functions/discovery-interview/index.ts's `fail()` calls plus the
 *  shared tenant gate. Listed as a type so a code the screen has never heard
 *  of falls to the generic branch rather than silently matching nothing. */
export type InterviewErrorCode =
  | 'llm_not_configured'
  | 'ai_budget_exceeded'
  | 'tenant_suspended'
  | 'no_tenant'
  | 'unauthorized'
  | 'no_dimensions'
  | 'dimensions_unavailable'
  | 'session_not_found'
  | 'session_not_running'
  | 'bad_request'
  | 'internal_error';

/** Somewhere the customer can be sent to fix it themselves. `null` when there
 *  is nothing they can usefully do, which is a real and common answer — a
 *  button that goes nowhere useful is worse than no button. */
export type InterviewFixTarget = null | 'ai_engine_settings' | 'restart' | 'reload';

export interface InterviewFailure {
  /** The engine's code, verbatim and untranslated, or null when the failure
   *  never reached the function (a dead network, a gateway 401). Branch on
   *  THIS; never grep `message`. */
  code: string | null;
  /** Plain language, already friendly, safe to render as-is. */
  message: string;
  fix: InterviewFixTarget;
  /** True when trying the same thing again could plausibly work. */
  retryable: boolean;
}

/**
 * WHICH CALL FAILED. The engine answers some codes on more than one action,
 * and the true sentence is not the same on each — see `llm_not_configured`
 * below, which is the reason this parameter exists at all.
 *
 * ⚠ IT IS NOT A COSMETIC. `startFailure` is shared by all three calls in
 * discoveryInterviewApi.ts, and until 2026-08-17 a key removed MID-interview
 * rendered "Nothing was started, so nothing is half-finished" over a
 * transcript full of recorded coverage — a sentence that is true of `start`
 * (the engine checks `hasLLMProvider` before `start_discovery_session`, so the
 * refusal really is clean) and flatly false of `answer`, which refuses at
 * index.ts:858 with a live session behind it.
 */
export type InterviewPhase = 'start' | 'answer' | 'end';

/**
 * Turn an engine refusal into something a business owner can act on.
 *
 * ⚠ THE 503, AND WHAT IT REALLY MEANS. Measured, not assumed:
 * `resolve_llm_keys` defaults a workspace to the PLATFORM key
 * (`coalesce(v_mode, 'platform')`, migration 576:71-96) and production holds
 * one, so this branch does NOT fire for a brand-new workspace — the claim it
 * used to carry. It fires for a workspace deliberately in `byo` mode with no
 * key of its own, and for one whose key was removed while somebody was
 * answering. Both remedies are named because the DATABASE names both in its
 * own refusal text ("Add it in Settings > AI Engine, or switch the workspace
 * to the platform key"), and a UI that offers one of two ways out sends half
 * the people who hit it down a road they did not need to take.
 *
 * ⚠ `session_not_running` is NOT retryable and NOT a bug. Nothing in the
 * database moves a session from 'parked' or 'abandoned' back to 'running' —
 * `end_discovery_session` is one-way and there is no reopen function — so an
 * interview that ended in another tab cannot take another answer, ever. Saying
 * "try again" there would be false.
 */
export function startFailure(
  code: string | null,
  detail?: string | null,
  phase: InterviewPhase = 'start',
): InterviewFailure {
  switch (code) {
    case 'llm_not_configured': {
      // Both remedies, in the database's own order. See the header.
      const remedy =
        'A workspace owner or admin can fix that under Settings → AI Engine — either add a key for this workspace, '
        + 'or switch the workspace back to the platform key.';
      return {
        code,
        message: phase === 'start'
          ? 'The interview needs an AI engine to ask you anything, and this workspace has none it can use right now. '
            + `${remedy} `
            + 'Nothing was started, so nothing is half-finished.'
          : 'This workspace has no AI engine it can use right now, so the interview cannot ask the next question. '
            + `${remedy} `
            + 'Everything you have already told us is recorded and this conversation is still open — it picks up at the same question once a key is back.',
        fix: 'ai_engine_settings',
        // Only the mid-conversation shape can be retried: on `start` there is
        // nothing to retry until the key exists, and the composer that hosts
        // "Try that answer again" is not on screen anyway.
        retryable: phase !== 'start',
      };
    }
    case 'ai_budget_exceeded':
      return {
        code,
        message:
          'This workspace has reached its AI spending limit for now, so the interview cannot ask the next question. '
          + 'Everything you have already told us is saved. An owner or admin can raise the limit under Settings, and you can pick this up where you left off.',
        fix: null,
        retryable: true,
      };
    case 'tenant_suspended':
      return {
        code,
        message:
          detail
          || 'This workspace is suspended — its trial has ended or billing is paused. An owner can reactivate it from Settings, or contact support@outsourcetel.com.',
        fix: null,
        retryable: false,
      };
    case 'no_tenant':
    case 'unauthorized':
      return {
        code,
        message:
          'We could not tell which workspace you are setting up. Sign out and back in, and if it keeps happening your workspace owner should check your account.',
        fix: 'reload',
        retryable: false,
      };
    case 'no_dimensions':
    case 'dimensions_unavailable':
      return {
        code,
        message:
          'The interview has no questions to ask — the question set is missing from this environment. This is our problem, not yours, and support@outsourcetel.com can fix it.',
        fix: null,
        retryable: false,
      };
    case 'session_not_found':
      return {
        code,
        message:
          'That conversation is no longer there — it may have been cleared while this page was open. Starting a new one is safe: anything already recommended is still waiting for you.',
        fix: 'restart',
        retryable: false,
      };
    case 'session_not_running':
      return {
        code,
        message:
          'This interview has already been closed — probably in another tab or on another device. It cannot take another answer. '
          + 'What it heard before it closed is saved, and anything it recommended is waiting under What we recommend. Starting a new interview begins a fresh conversation.',
        fix: 'restart',
        retryable: false,
      };
    case 'bad_request':
      return {
        code,
        message: detail || 'That answer could not be sent as it was written. Try rephrasing it a little shorter.',
        fix: null,
        retryable: true,
      };
    default:
      // Includes `internal_error`, a gateway 401, and a dead network — none of
      // which the customer can distinguish or act on differently.
      return {
        code,
        message:
          (detail && detail.trim())
            ? `The interview could not continue: ${detail.trim()}`
            : 'The interview could not continue, and we did not get a reason. Your answers so far are saved — try again in a moment.',
        fix: null,
        retryable: true,
      };
  }
}

// ── what actually came out of it ──────────────────────────────────────────

export type OutcomeTone = 'ok' | 'warn' | 'danger';

export interface OutcomeReport {
  tone: OutcomeTone;
  /** One line naming the outcome. */
  headline: string;
  /** Why, in the customer's terms. Always non-empty — see the header. */
  body: string;
  /** True when there is something on the proposals screen to go and look at. */
  hasProposals: boolean;
}

/**
 * WHAT CAME BACK, AND WHY IT DID NOT.
 *
 * ⚠ THIS IS THE WHOLE OF POINT E, AND IT IS THE ONE THIS PROGRAMME KEEPS
 * FINDING. The emitter already counts its refusals and already knows whether
 * the model fill ran — `refused`, `model_fill` and `skipped_already_proposed`
 * are returned in the response body — and every one of them currently ends its
 * life in a `console.error` inside an edge function nobody tails. So a
 * workspace whose employees were ALL refused for want of grounding, and a
 * workspace whose interview simply heard nothing worth acting on, and a
 * workspace that ran out of AI budget at the last moment, are shown the same
 * empty screen. Three different problems, three different fixes, one blank
 * page.
 *
 * The order of the branches below is the order of blame, and it is deliberate:
 * a platform-side cause (no key, no budget) is named BEFORE anything that
 * could be read as the customer not having said enough. Telling somebody to
 * "describe your business in more detail" when the real cause was our billing
 * limit is the misdirect the Quick Start page's own comments record having
 * lost real signups to.
 *
 * ⚠ `null` IS NOT AN OUTCOME. An interview that ended without the engine
 * reporting an emission at all (a network failure on the last call, a session
 * that never reached the emitter) gets the honest "we do not know" branch
 * rather than a cheerful zero.
 */
export function outcomeReport(emission: ProposalEmission | null | undefined): OutcomeReport {
  if (!emission) {
    return {
      tone: 'warn',
      headline: 'We could not confirm what came out of this',
      body:
        'The interview finished but we did not get a report back on what it recommended. '
        + 'Open What we recommend to see for yourself — if it is empty, nothing was created, and starting a new interview is safe.',
      hasProposals: false,
    };
  }

  const { proposed, refused, model_fill: fill, skipped_already_proposed: already } = emission;

  // ── platform-side causes first, because they are not the customer's fault ──
  if (fill === 'skipped_no_llm') {
    return {
      tone: 'danger',
      headline: 'Your AI engine was not available, so most recommendations were lost',
      body:
        'Every recommendation that needs the AI engine to write its detail — people to hire, guardrails, procedures and trust rules — was dropped, '
        + `because this workspace had no AI engine key when the interview finished${refused > 0 ? ` (${refused} in total)` : ''}. `
        + 'This is not something you said or did not say. An owner or admin should add a key under Settings → AI Engine. '
        + '⚠ This interview will not try again — the recommendations have to come from a new one.',
      hasProposals: proposed > 0,
    };
  }
  if (fill === 'skipped_ai_budget') {
    return {
      tone: 'danger',
      headline: 'This workspace hit its AI spending limit before the recommendations were written',
      body:
        'Every recommendation that needs the AI engine to write its detail — people to hire, guardrails, procedures and trust rules — was dropped '
        + `for that reason${refused > 0 ? ` (${refused} in total)` : ''}, not because of anything you said. `
        + 'An owner or admin can raise the limit under Settings. '
        + '⚠ This interview will not try again — the recommendations have to come from a new one.',
      hasProposals: proposed > 0,
    };
  }
  if (already) {
    return {
      tone: 'ok',
      headline: 'This interview had already been written up',
      body:
        'Its recommendations were produced earlier and are waiting for you under What we recommend. Nothing was written twice.',
      hasProposals: true,
    };
  }

  // ── then the customer-side ones, which are legitimate outcomes ────────────
  if (proposed === 0 && refused === 0) {
    return {
      tone: 'warn',
      headline: 'We did not find anything concrete enough to recommend',
      body:
        'Recommendations are only made from specifics — a named system, a real number, a thing that actually happens in your week. '
        + 'Nothing in this conversation was concrete enough for us to suggest without guessing, and guessing is what this replaced. '
        + 'Running the interview again and answering with examples usually fixes it.',
      hasProposals: false,
    };
  }
  if (proposed === 0 && refused > 0) {
    return {
      tone: 'warn',
      headline: `We drafted ${refused} recommendation${refused === 1 ? '' : 's'} and could not stand behind any of ${refused === 1 ? 'it' : 'them'}`,
      body:
        'Each one was dropped because we could not point at something you actually said to justify it — a rule with no wording to match, '
        + 'a role with nothing in the conversation behind it, a limit with no amount. We would rather show you nothing than a recommendation we made up. '
        + 'Running the interview again and answering with specifics — names, numbers, what happens today — is what changes this.',
      hasProposals: false,
    };
  }
  if (refused > 0) {
    return {
      tone: 'warn',
      headline: `${proposed} recommendation${proposed === 1 ? '' : 's'} ready — and ${refused} we would not stand behind`,
      body:
        `We dropped ${refused} draft${refused === 1 ? '' : 's'} because we could not point at something you said to justify ${refused === 1 ? 'it' : 'them'}. `
        + 'That is deliberate, not a failure — it is why the ones you can see are worth reading. Go through them and accept what fits.',
      hasProposals: true,
    };
  }
  return {
    tone: 'ok',
    headline: `${proposed} recommendation${proposed === 1 ? '' : 's'} ready for you`,
    body: 'Nothing is live until you accept it — each one says exactly what it would change before you decide.',
    hasProposals: true,
  };
}

// ── park, and the two things it means ─────────────────────────────────────

/**
 * The literal text an "Ask me later" button sends as the customer's answer.
 *
 * ⚠ WHY A SENTENCE AND NOT AN API CALL, said plainly rather than hidden. The
 * engine's 'answer' action takes `{ session_id, text }` and nothing else;
 * `record_dimension_state` is REVOKEd from `authenticated` and only the edge
 * function may call it. So there is no client-side way to mark one dimension
 * parked, and inventing one would need a migration this task may not write.
 *
 * The engine's own system prompt names this exact phrasing as the park
 * trigger: '"parked" is for "ask me later"'. So the button says the thing the
 * model is instructed to read as a park.
 *
 * ⚠ AND THE HONEST BOUND, because a soft rail sold as a hard one is worse than
 * no rail. Whether this turn is recorded as `parked` is the MODEL's decision,
 * not ours. What is guaranteed regardless is the thing the customer actually
 * cares about: this answer cannot CLOSE the topic. `coverageAfter` refuses any
 * 'heard' or 'skipped' entry with no evidence, and there is no concrete fact
 * in this sentence to quote — so the dimension stays owed either way, and
 * `stillOwed` brings it back. Park versus not-heard is a difference in how it
 * is reported, never in whether it returns.
 */
export const ASK_ME_LATER_TEXT = 'Ask me later — I would rather come back to this one.';

export type StopIntent = 'parked' | 'abandoned';

/** What stopping actually does, per intent, in the customer's words. Rendered
 *  beside each choice so the decision is informed rather than guessed.
 *
 *  ⚠ BOTH SENTENCES CARRY THE SAME UNCOMFORTABLE FACT, because it is true and
 *  because hiding it is how a park button becomes an invisible pile. Stopping
 *  writes up what was heard and CLOSES the conversation: `end_discovery_session`
 *  moves 'running' → 'parked'/'abandoned' one way only, nothing reopens it, and
 *  the 'answer' action refuses a session that is not running (409). "Come back
 *  to it" therefore means a NEW conversation, not this one continued — and the
 *  screen says so rather than promising a resume that does not exist.
 *
 *  The genuinely resumable option is a third one the page offers alongside
 *  these two: leave without stopping. A 'running' session keeps its transcript
 *  and its coverage and picks up at the same question. */
export const STOP_CONSEQUENCE: Record<StopIntent, string> = {
  parked:
    'We write up what you have told us so far as recommendations you can look at now, and record which topics we never got to. '
    + 'This conversation closes — coming back starts a fresh one, and anything you have already accepted stays.',
  abandoned:
    'We write up what you have told us so far as recommendations you can look at now, and we stop asking. '
    + 'This conversation closes for good; nothing you accepted is undone.',
};

/** Trim and bound a resume note before it goes to the engine.
 *  `end_discovery_session` stores it verbatim and the edge function slices at
 *  500 characters — done here too so the customer is not silently truncated
 *  by a server they cannot see. Empty becomes null: the column is nullable and
 *  a blank string is not a note. */
export function resumeHint(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  return t.slice(0, 500);
}

// ── resuming ──────────────────────────────────────────────────────────────

export type ResumeKind = 'running' | 'finished' | 'closed' | 'none';

/**
 * WHAT THE PRIMARY CONTROL DOES, decided here beside the label rather than
 * re-derived from `kind` at the render.
 *
 * ⚠ THIS FIELD IS THE FIX, not decoration. The page used to write the action
 * as an inline ternary — `offer.kind === 'running' ? resumeRunning() :
 * begin()` — so the label and the behaviour were decided in two places by two
 * different expressions. Adding a third kind to this function would have left
 * a button reading "See what we recommend" that started a new interview. A
 * label and an action that can disagree WILL disagree.
 */
export type ResumeAction = 'start' | 'resume' | 'proposals';

export interface ResumeOffer {
  kind: ResumeKind;
  headline: string;
  body: string;
  /** The label on the primary control, so the page cannot promise "Continue"
   *  for a session that can only be replaced. */
  primaryLabel: string;
  /** What that control must do. Never inferred from `kind` — see ResumeAction. */
  primaryAction: ResumeAction;
}

/**
 * What to offer somebody who already has a session.
 *
 * ⚠ 'running' AND 'parked' ARE NOT THE SAME OFFER, and this is the single
 * most misleading thing this screen could get wrong. Measured from the
 * migrations, not assumed:
 *   · a 'running' session takes another answer — the 'answer' action's only
 *     status check is `session.status !== 'running'`, so continuing genuinely
 *     continues, transcript and coverage intact;
 *   · a 'parked' or 'abandoned' session does NOT. `end_discovery_session` is
 *     one-way (`v_status <> 'running'` refuses), nothing anywhere sets status
 *     back to 'running', and `start_discovery_session` always INSERTs a new
 *     row with freshly seeded coverage. There is no reopen.
 * So "Continue where you left off" is true for the first and a lie for the
 * second, and this function is where the two are kept apart.
 *
 * ⚠ AND 'running' IS NOT ONE STATE. THIS IS THE DEFECT THAT SHIPPED. Branching
 * on `status` ALONE — while already holding `progress` — meant a NATURALLY
 * COMPLETED interview was offered as one in progress. Natural completion never
 * leaves 'running': the 'answer' action writes only the transcript and the
 * coverage ledger (index.ts:988, 999-1009); only the 'end' action moves the
 * status. So a customer who answered every question came back to "You have an
 * interview in progress / All 14 topics covered / Continue where you left off",
 * clicked it, landed on a done screen headed "That is everything we needed"
 * above a banner saying we could not confirm anything came of it — with NO way
 * through to the recommendations, because that button asks for a live emission
 * this page load does not have. `progress.remaining === 0` is the third state
 * and it gets its own offer.
 *
 * ⚠ `proposalCount` IS THE DURABLE HALF, and it is honest about what it can
 * and cannot recover. The engine's emission (`proposed`/`refused`/`model_fill`)
 * rides back on ONE response and is never persisted: refused drafts are
 * counted in memory and thrown away (emitProposals never writes a row for
 * them), so `refused` and `model_fill` are UNRECOVERABLE after a reload — no
 * amount of re-reading brings them back. What the database can still answer is
 * "how many proposals does this session have", read straight off
 * `discovery_proposals`. So: the rich report (`outcomeReport`) is rendered on
 * the page load that actually finished the interview, and this durable, poorer
 * one is what a reload gets. `null` means we could not count, and it is a third
 * answer rather than a zero — same rule `outcomeReport(null)` already follows.
 */
export function resumeOffer(
  session: { status: string; updated_at?: string; resume_hint?: string | null } | null,
  progress: CoverageProgress,
  proposalCount: number | null = null,
): ResumeOffer {
  if (!session) {
    return {
      kind: 'none',
      headline: 'Tell us about your business',
      body:
        'A short conversation — a handful of questions in plain English — and we will draft the digital employees, procedures, '
        + 'systems, guardrails and limits that fit what you actually do. Nothing is created until you approve it, item by item.',
      primaryLabel: 'Start the interview',
      primaryAction: 'start',
    };
  }
  if (session.status === 'running') {
    // ⚠ `progress.total > 0` IS LOAD-BEARING, not a paranoid guard. An empty
    // coverage map counts as remaining === 0, so a session whose coverage
    // failed to load, or one read before the first turn recorded anything,
    // would otherwise be announced as finished. `resumedState` takes the
    // identical precaution for the identical reason.
    if (progress.total > 0 && progress.remaining === 0) {
      if (proposalCount === null) {
        return {
          kind: 'finished',
          headline: 'Your interview is finished',
          body:
            `${progressSentence(progress)} We could not check from here what it wrote up — open What we recommend and see for `
            + 'yourself. If it is empty, nothing was created and running a new interview is safe.',
          primaryLabel: 'See what we recommend',
          primaryAction: 'proposals',
        };
      }
      if (proposalCount === 0) {
        return {
          kind: 'finished',
          headline: 'Your interview finished without recommending anything',
          body:
            `${progressSentence(progress)} Nothing it heard was concrete enough for us to recommend without guessing, and `
            + 'guessing is what this replaced. Running the interview again and answering with specifics — names, numbers, what '
            + 'actually happens in your week — is what changes that. (Why each individual draft was dropped is only said once, '
            + 'on the screen you finish the interview on; it is not kept.)',
          primaryLabel: 'Start a new interview',
          primaryAction: 'start',
        };
      }
      return {
        kind: 'finished',
        headline: 'Your interview is finished',
        body:
          `${progressSentence(progress)} ${proposalCount} recommendation${proposalCount === 1 ? '' : 's'} came out of it and `
          + `${proposalCount === 1 ? 'is' : 'are'} waiting for you under What we recommend. Nothing is live until you accept `
          + 'it, item by item.',
        primaryLabel: 'See what we recommend',
        primaryAction: 'proposals',
      };
    }
    return {
      kind: 'running',
      headline: 'You have an interview in progress',
      body:
        `${progressSentence(progress)} Picking it up carries on from the same question — nothing you have already told us is lost.`,
      primaryLabel: 'Continue where you left off',
      primaryAction: 'resume',
    };
  }
  const note = (session.resume_hint ?? '').trim();
  // ⚠ Named for what it is. This session is finished, and the honest offer is a
  // NEW conversation — never "Continue", which the database cannot do.
  return {
    kind: 'closed',
    headline: session.status === 'parked' ? 'Your last interview was set aside' : 'Your last interview was stopped',
    body:
      `${progressSentence(progress)}`
      + (note ? ` You left a note: “${note}”.` : '')
      + ' That conversation is closed and cannot be picked up mid-sentence — starting again begins a fresh one. '
      + (proposalCount === 0
        ? 'It wrote up nothing, so there is nothing from it under What we recommend — no draft was concrete enough for us to stand behind.'
        : proposalCount === null
          ? 'Anything it already recommended is still waiting for you under What we recommend.'
          : `The ${proposalCount} recommendation${proposalCount === 1 ? '' : 's'} it wrote up ${proposalCount === 1 ? 'is' : 'are'} still waiting for you under What we recommend.`),
    primaryLabel: 'Start a new interview',
    primaryAction: 'start',
  };
}
