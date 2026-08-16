// discovery-interview.test.ts — proves the discovery interview is REACHABLE,
// that its wiring is wiring rather than decoration, and that the three things
// it must say honestly (no AI engine · park · nothing came back) are said by
// code rather than by convention in a component nothing can render.
//
// ⚠⚠ WHY THIS FILE IS SHAPED THE WAY IT IS. Before this change the engine at
// supabase/functions/discovery-interview was complete, deployed, and reachable
// by NOBODY: `grep -rn "discovery-interview" src/` returned three hits and all
// three were comments. `discovery_proposals` was absent from PAGE_ACCESS, which
// is default-DENY, so the screen holding its output was closed to tenant_owner,
// tenant_admin and dt_super_admin alike. Every single piece worked and the
// feature did not exist. A suite that only exercised pure functions would have
// been entirely green throughout — which is precisely what it was.
//
// So this file has two halves and the second one is the point:
//   · PURE — the machine module, which is where all the judgement was put so
//     that it could be tested at all (there is no component-test harness here).
//   · WIRING — bounded, brace-walked extractions of the exact handler bodies
//     that make the calls, plus behaviour tests against the REAL canAccessPage
//     and the REAL AuthContext landing function.
//
// ⚠ EVERY STRUCTURAL ASSERTION IS BOUNDED TO ONE HANDLER, and each extraction
// is asserted non-null in its own case BEFORE anything is asserted about it.
// tests/discovery-proposal-batching.test.ts carries the scar this rule comes
// from: two earlier tests matched the whole file with an `s` flag, so `.*`
// spanned three hundred unrelated lines and the assertions could not fail. A
// test that reads the whole file cannot tell a gate from two statements that
// happen to mention it.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  EMPTY_INTERVIEW, startedState, answeredState, endedState, resumedState,
  normalizeCoverage, coverageProgress, progressSentence,
  startFailure, outcomeReport, resumeOffer, resumeHint,
  ASK_ME_LATER_TEXT, STOP_CONSEQUENCE, DIMENSION_STATES,
  type CoverageMap, type ProposalEmission, type ModelFillOutcome,
} from '../src/lib/discoveryInterviewMachine';

// The REAL nav gate — the same function App.tsx routes through, default-deny
// and all. Behaviour, not a text match: this cannot go vacuous.
import { canAccessPage } from '../src/lib/navAccess';
import { PAGE_TO_URL, URL_TO_PAGE } from '../src/lib/pageRoutes';

// ⚠ THE REAL ENGINE-SIDE ORACLE. `stillOwed` is what the deployed function
// actually uses to decide whether an interview is finished, and vitest CAN
// import it (Vite resolves the _shared module fine; it is only the function's
// own https: imports that Node's ESM loader rejects, which is why
// tests/discovery-sidetrack.test.ts reaches it the same way). Cross-checking
// coverageProgress against it turns "parked counts as remaining" from a claim
// in a comment into a behaviour comparison against the engine.
import { stillOwed } from '../supabase/functions/_shared/discoveryCoverage.ts';

// ── files read for the wiring half ───────────────────────────────────────
const PAGE_SRC = readFileSync('src/pages/tenant/DiscoveryInterviewPage.tsx', 'utf8');
const API_SRC = readFileSync('src/lib/discoveryInterviewApi.ts', 'utf8');
const AUTH_SRC = readFileSync('src/context/AuthContext.tsx', 'utf8');
const APP_SRC = readFileSync('src/App.tsx', 'utf8');
const SIDEBAR_SRC = readFileSync('src/components/Sidebar.tsx', 'utf8');
const ENGINE_SRC = readFileSync('supabase/functions/discovery-interview/index.ts', 'utf8');
const TENANT_STATUS_SRC = readFileSync('supabase/functions/_shared/tenantStatus.ts', 'utf8');
const NAV_SRC = readFileSync('src/lib/navAccess.ts', 'utf8');
const GUIDE_SRC = readFileSync('src/components/GettingStartedGuide.tsx', 'utf8');
const MIGRATION_741 = readFileSync('supabase/migrations/741_a_proposal_becomes_a_thing_or_says_why_not.sql', 'utf8');

/** Balanced-brace slice starting at the first `{` at or after `from`.
 *  Returns null when the braces do not balance, so a caller can assert the
 *  extraction worked instead of asserting over an empty string. */
function braceSlice(src: string, from: number): string | null {
  const start = src.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** The body of a `const <name> = useCallback(... => { … })` declaration. */
function callbackBody(src: string, name: string): string | null {
  const at = src.indexOf(`const ${name} = useCallback(`);
  if (at === -1) return null;
  const arrow = src.indexOf('=> {', at);
  if (arrow === -1) return null;
  return braceSlice(src, arrow + 2);
}

/** Balanced-paren slice starting at the first `(` at or after `from`. Needed
 *  for arrow functions whose body is JSX in parentheses rather than a block —
 *  braceSlice on one of those grabs the first JSX expression container and
 *  stops, which is how the first draft of this file "proved" something about
 *  three lines of a twenty-line render. */
function parenSlice(src: string, from: number): string | null {
  const start = src.indexOf('(', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** The onClick body of the <Button> whose visible label is `label`.
 *
 *  ⚠ THE LABEL MUST BE MATCHED AS BUTTON TEXT, not as a substring of the file.
 *  Every one of these labels also appears in this page's header comment, which
 *  documents the controls — so a plain indexOf finds the PROSE, walks backwards
 *  for an onClick that is not there, and returns null. That null then makes
 *  every assertion about the handler either vacuous or confusingly red. `>\s*
 *  label \s*<` is the JSX child position and nothing else. */
function onClickForLabel(src: string, label: string): string | null {
  const m = new RegExp(`>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`).exec(src);
  if (!m) return null;
  const open = src.lastIndexOf('onClick={', m.index);
  if (open === -1) return null;
  return braceSlice(src, open + 'onClick='.length);
}

/** The parenthesised body of a conditional JSX render — `{<gate> && (` … `)`.
 *
 *  ⚠ THE GATE IS PART OF THE EXTRACTION, and that is the whole point of this
 *  helper. Three renders on this page were "proved" by assertions that read the
 *  handler bodies and the map expressions those renders CONTAIN — all of which
 *  survive `{false && (…)}` untouched, because deleting a render deletes
 *  nothing a text search over the file can see. Anchoring on the gate means the
 *  extraction itself fails when the gate is changed or removed, and every
 *  assertion below it is written against the extracted block rather than the
 *  file. Returns null when the gate is not found, which each caller asserts
 *  before asserting anything else. */
function conditionalRender(src: string, gate: RegExp): string | null {
  const m = gate.exec(src);
  if (!m) return null;
  // m[0] must end at the opening paren of the rendered expression.
  return parenSlice(src, m.index + m[0].length - 1);
}

/** The `<Button …>` opening tag whose child expression is `child`, so an
 *  assertion about which handler a control calls cannot be satisfied by any
 *  other control on the page. `onClickForLabel` cannot reach this one: its
 *  label is `{offer.primaryLabel}`, an expression, not text. */
function buttonWithChild(src: string, child: string): string | null {
  const at = src.indexOf(child);
  if (at === -1) return null;
  const open = src.lastIndexOf('<Button', at);
  if (open === -1) return null;
  return src.slice(open, at);
}

/** The `{ … }` body object of a named invokeEdge call, so an assertion about
 *  what is SENT cannot be satisfied or defeated by anything else in the file. */
function edgeBodies(src: string, fnName: string): string[] {
  // ⚠ ANCHORED ON THE CALL, NOT ON THE IDENTIFIER. The first draft scanned for
  // every occurrence of `invokeEdge` and then searched FORWARD for the function
  // name — so the IMPORT statement found the first real call's name and emitted
  // a duplicate body. Five bodies for three calls, and a duplicate is exactly
  // the kind of miscount that makes a later "all of them are clean" claim
  // meaningless.
  const out: string[] = [];
  const re = new RegExp(`invokeEdge(?:<[^>]*>)?\\(\\s*'${fnName}'\\s*,`, 'g');
  for (const m of src.matchAll(re)) {
    const call = braceSlice(src, m.index! + m[0].length);
    if (!call) continue;
    const bodyAt = call.indexOf('body:');
    if (bodyAt === -1) continue;
    const body = braceSlice(call, bodyAt);
    if (body) out.push(body);
  }
  return out;
}

/** Strip // and /* *\/ comments so an assertion about CODE cannot be satisfied
 *  — or defeated — by prose. Deliberately crude; it only has to be right about
 *  the two small, comment-heavy files it is pointed at. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => {
      const i = l.indexOf('//');
      // Not inside a string literal — good enough for these files, and the
      // assertion below would fail loudly rather than quietly if it were not.
      if (i === -1) return l;
      const before = l.slice(0, i);
      const quotes = (before.match(/'/g) ?? []).length + (before.match(/"/g) ?? []).length;
      return quotes % 2 === 0 ? before : l;
    })
    .join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
// PART 1 — THE PURE MACHINE
// ═════════════════════════════════════════════════════════════════════════

describe('coverageProgress — the engine\'s own ledger, counted the engine\'s way', () => {
  const map = (states: string[]): CoverageMap => Object.fromEntries(
    states.map((s, i) => [`d${i}`, { state: s as CoverageMap[string]['state'], evidence: null }]),
  );

  it('parked counts as REMAINING, not as progress — RED if a parked dimension is ever shaded as covered', () => {
    const p = coverageProgress(map(['heard', 'parked', 'not_heard']));
    expect(p.remaining).toBe(2);
    expect(p.closed).toBe(1);
    expect(p.parked).toBe(1);
  });

  it('skipped counts as CLOSED — RED if "not relevant to us" starts being nagged about again', () => {
    const p = coverageProgress(map(['heard', 'skipped', 'not_heard']));
    expect(p.closed).toBe(2);
    expect(p.remaining).toBe(1);
  });

  // ⚠ THE COMPARISON THAT MATTERS. Not "we believe parked is owed" but "we
  // agree with the function the deployed engine actually calls". Every
  // permutation of the four states over three dimensions — 64 comparisons,
  // counted and asserted, because zero findings from zero comparisons looks
  // exactly like a clean result.
  it('agrees with the REAL stillOwed on every permutation — RED on the first disagreement', () => {
    let compared = 0;
    for (const a of DIMENSION_STATES) {
      for (const b of DIMENSION_STATES) {
        for (const c of DIMENSION_STATES) {
          const cov = map([a, b, c]);
          expect(coverageProgress(cov).remaining, `states ${a}/${b}/${c}`).toBe(stillOwed(cov as never).length);
          compared++;
        }
      }
    }
    expect(compared, 'the permutation loop did not run — a clean result from zero comparisons is not a clean result').toBe(64);
  });

  it('an empty map is 0 percent and not a crash or a NaN — RED if a fresh page divides by zero', () => {
    const p = coverageProgress({});
    expect(p.percent).toBe(0);
    expect(p.total).toBe(0);
    expect(Number.isNaN(p.percent)).toBe(false);
  });

  it('null and undefined are the same as empty — RED if the page throws before the first load lands', () => {
    expect(coverageProgress(null).total).toBe(0);
    expect(coverageProgress(undefined).total).toBe(0);
  });
});

describe('normalizeCoverage — an unknown state may never become progress', () => {
  it('an unrecognised state is counted as owed, NOT dropped — RED if total shrinks and the percentage rises', () => {
    const cov = normalizeCoverage({ a: { state: 'heard' }, b: { state: 'maybe_later' } });
    expect(Object.keys(cov)).toHaveLength(2);
    expect(cov.b.state).toBe('not_heard');
    const p = coverageProgress(cov);
    expect(p.total).toBe(2);
    expect(p.percent).toBe(50);
  });

  it('a non-string state degrades the same way — RED if `null` or a number reaches a counter', () => {
    const cov = normalizeCoverage({ a: { state: null }, b: { state: 42 }, c: {} });
    expect(Object.values(cov).every((e) => e.state === 'not_heard')).toBe(true);
  });

  it('evidence survives only when it is genuinely a string — RED if an object renders as "[object Object]"', () => {
    const cov = normalizeCoverage({ a: { state: 'heard', evidence: 'they run two clinics' }, b: { state: 'heard', evidence: {} } });
    expect(cov.a.evidence).toBe('they run two clinics');
    expect(cov.b.evidence).toBeNull();
  });
});

describe('progressSentence — the customer\'s words, never the schema\'s', () => {
  it('names the parked ones separately — RED if "set aside" silently merges into "covered"', () => {
    const s = progressSentence(coverageProgress({
      a: { state: 'heard' }, b: { state: 'parked' }, c: { state: 'not_heard' },
    }));
    expect(s).toContain('1 of 3');
    expect(s).toMatch(/set aside/i);
  });

  it('never uses the word "dimension" — RED if the spine\'s vocabulary leaks onto a customer screen', () => {
    for (const states of [['heard'], ['parked'], ['skipped'], ['not_heard'], ['heard', 'heard']]) {
      const s = progressSentence(coverageProgress(Object.fromEntries(states.map((x, i) => [`d${i}`, { state: x }]))));
      expect(s.toLowerCase()).not.toContain('dimension');
    }
  });

  it('a fully covered spine says so — RED if it still reports work remaining at 100%', () => {
    expect(progressSentence(coverageProgress({ a: { state: 'heard' }, b: { state: 'skipped' } })))
      .toMatch(/all 2 topics covered/i);
  });
});

describe('startFailure — a code the customer can act on, never a code on the screen', () => {
  // ⚠ THE ONE THAT MATTERS MOST. 'start' answers 503 llm_not_configured to any
  // workspace with no AI engine key — which is EVERY brand-new workspace, i.e.
  // exactly the customer this whole feature exists for. Landing them on a dead
  // end there is worse than the empty dashboard it replaced.
  it('llm_not_configured names the setting, who can change it, and gives a way there — RED if it degrades to a code or a shrug', () => {
    const f = startFailure('llm_not_configured', 'no AI engine key configured for this workspace yet');
    expect(f.message).toMatch(/Settings.*AI Engine/i);
    expect(f.message).toMatch(/owner or admin/i);
    expect(f.fix).toBe('ai_engine_settings');
    expect(f.message).not.toMatch(/llm_not_configured/);
    expect(f.message).not.toMatch(/503/);
  });

  it('llm_not_configured promises nothing is half-finished, which is a property of the ENGINE — RED if that claim is made for a code where it is false', () => {
    // The engine checks hasLLMProvider BEFORE start_discovery_session, which is
    // what makes the sentence true. That ordering is pinned separately below.
    expect(startFailure('llm_not_configured').message).toMatch(/nothing is half-finished/i);
    expect(startFailure('ai_budget_exceeded').message).not.toMatch(/nothing is half-finished/i);
  });

  // ⚠ THE SAME CODE, TWO DIFFERENT TRUTHS. The engine emits
  // llm_not_configured from the start path (index.ts:745, before any session
  // exists) AND from the answer path (index.ts:858, with a live session and
  // recorded coverage behind it). One sentence for both rendered "Nothing was
  // started, so nothing is half-finished" over a half-answered interview.
  it('a key removed MID-interview does not claim nothing was started — RED if the start-path sentence is shown over recorded coverage', () => {
    const mid = startFailure('llm_not_configured', null, 'answer');
    expect(mid.message).not.toMatch(/nothing is half-finished/i);
    expect(mid.message).not.toMatch(/nothing was started/i);
    expect(mid.message).toMatch(/already told us is recorded|still open/i);
    // And it stays actionable: same fix target, and retryable because adding a
    // key genuinely lets the same answer through.
    expect(mid.fix).toBe('ai_engine_settings');
    expect(mid.retryable).toBe(true);
  });

  it('the start path keeps its own sentence, so the branch is genuinely a branch — RED if both phases collapse back into one message', () => {
    const start = startFailure('llm_not_configured', null, 'start');
    const answer = startFailure('llm_not_configured', null, 'answer');
    const end = startFailure('llm_not_configured', null, 'end');
    expect(start.message).not.toBe(answer.message);
    expect(answer.message).toBe(end.message); // 'end' is mid-conversation too
    expect(start.retryable).toBe(false);
  });

  it('the phase changes NOTHING for the other codes — RED if a parameter added for one branch starts quietly rewriting the rest', () => {
    let compared = 0;
    for (const c of ['ai_budget_exceeded', 'tenant_suspended', 'no_tenant', 'session_not_running', 'bad_request', null]) {
      expect(startFailure(c, 'd', 'start').message, `code ${c}`).toBe(startFailure(c, 'd', 'answer').message);
      compared++;
    }
    expect(compared).toBe(6);
  });

  // ⚠ M1 — THE PREMISE THAT WAS WRONG, and the remedy that was missing with
  // it. resolve_llm_keys reads `coalesce(v_mode, 'platform')` and falls
  // through to the PLATFORM secret, so a workspace with no key of its own is
  // not a workspace with no engine. The database's own refusal text names both
  // ways out; a UI naming one sends half the people who reach it down a road
  // they did not need to take.
  it('the 503 names BOTH remedies the database offers — RED if the platform-key half is dropped and byo workspaces are told only to buy a key', () => {
    const migration = readFileSync('supabase/migrations/576_resolve_every_llm_key_in_one_trip.sql', 'utf8');
    // The premise, read from the migration rather than believed.
    expect(migration, 'the platform default is gone — the copy below needs revisiting').toContain("coalesce(v_mode, 'platform')");
    expect(migration).toMatch(/switch the workspace to the platform key/i);
    for (const phase of ['start', 'answer'] as const) {
      const m = startFailure('llm_not_configured', null, phase).message;
      expect(m, `${phase}: no "add a key" remedy`).toMatch(/add a key/i);
      expect(m, `${phase}: no "platform key" remedy`).toMatch(/platform key/i);
    }
  });

  it('no file still claims a brand-new workspace is the one that meets the 503 — RED if the false premise creeps back into the record', () => {
    const MACHINE_SRC = readFileSync('src/lib/discoveryInterviewMachine.ts', 'utf8');
    let compared = 0;
    for (const [name, src] of [['machine', MACHINE_SRC], ['api', API_SRC], ['page', PAGE_SRC]] as const) {
      expect(src, `${name} still calls the 503 the most likely first experience`)
        .not.toMatch(/single most likely first experience/i);
      compared++;
    }
    expect(compared).toBe(3);
    // ...and the correction is recorded rather than merely deleted: each file
    // names the platform fallback that makes the old claim false.
    expect(MACHINE_SRC).toMatch(/576:71-96/);
  });

  it('session_not_running is NOT retryable — RED if the screen offers "try again" for a session the database cannot reopen', () => {
    // end_discovery_session is one-way and nothing sets status back to
    // 'running'. Telling somebody to retry there would be false.
    const f = startFailure('session_not_running');
    expect(f.retryable).toBe(false);
    expect(f.fix).toBe('restart');
    expect(f.message).toMatch(/fresh conversation|new interview/i);
  });

  it('ai_budget_exceeded IS retryable and says the answers are kept — RED if a recoverable stop reads as a loss', () => {
    const f = startFailure('ai_budget_exceeded');
    expect(f.retryable).toBe(true);
    expect(f.message).toMatch(/saved/i);
  });

  it('a null code (dead network, gateway 401) never pretends the engine decided something — RED if it invents a code', () => {
    const f = startFailure(null);
    expect(f.code).toBeNull();
    expect(f.message).toMatch(/did not get a reason|could not continue/i);
    expect(f.retryable).toBe(true);
  });

  it('an unrecognised code falls to the generic branch rather than rendering blank — RED if a future engine code produces an empty banner', () => {
    const f = startFailure('some_code_this_build_has_never_heard_of', 'the engine said something new');
    expect(f.message.length).toBeGreaterThan(20);
    expect(f.code).toBe('some_code_this_build_has_never_heard_of');
  });

  // ⚠ THE CODES ARE READ FROM THE ENGINE, NEVER TYPED OUT HERE. A hand-written
  // list would go stale silently, which is the failure mode this whole file is
  // about. `handled` is derived by BEHAVIOUR — a code whose message differs
  // from the generic one has a branch — so the two can never drift apart the
  // way a parallel array and a switch statement do.
  const ENGINE_CODES = [...new Set([...ENGINE_SRC.matchAll(/fail\(\s*'([a-z_]+)'/g)].map((m) => m[1]))];
  const GENERIC = startFailure('a_code_no_build_will_ever_emit').message;
  const handled = ENGINE_CODES.filter((c) => startFailure(c).message !== GENERIC);
  const generic = ENGINE_CODES.filter((c) => startFailure(c).message === GENERIC);

  it('the engine codes were actually found — RED if the extraction breaks and the three cases below pass over an empty list', () => {
    expect(ENGINE_CODES.length, 'no fail() codes found in the engine source — the extraction is broken, not the engine').toBeGreaterThan(5);
    expect(handled.length, 'not one engine code has a branch — startFailure has been gutted').toBeGreaterThan(4);
  });

  it('every code the engine can emit produces a non-empty sentence — RED if any of them renders a blank banner', () => {
    let compared = 0;
    for (const c of ENGINE_CODES) {
      expect(startFailure(c).message.length, `code ${c} produced an empty message`).toBeGreaterThan(20);
      compared++;
    }
    expect(compared).toBe(ENGINE_CODES.length);
  });

  // ⚠ TWO PAIRS SHARE A SENTENCE ON PURPOSE, and they are named here rather
  // than allowed to hide inside a loose count. `unauthorized`/`no_tenant` are
  // one thing to a customer ("we could not tell who you are"), and
  // `no_dimensions`/`dimensions_unavailable` are one thing too ("the question
  // set is missing"). Splitting either into two sentences would be a
  // distinction only an engineer can act on.
  const DELIBERATE_SYNONYMS: ReadonlyArray<readonly [string, string]> = [
    ['unauthorized', 'no_tenant'],
    ['no_dimensions', 'dimensions_unavailable'],
  ];

  it('the two deliberate synonym pairs really are synonyms — RED if one drifts and a customer gets two stories for one problem', () => {
    for (const [a, b] of DELIBERATE_SYNONYMS) {
      expect(startFailure(a).message, `${a} vs ${b}`).toBe(startFailure(b).message);
    }
  });

  it('every OTHER branch says something different — RED if two unrelated refusals collapse into one sentence', () => {
    const paired = new Set(DELIBERATE_SYNONYMS.map(([, b]) => b));
    const distinct = handled.filter((c) => !paired.has(c));
    const msgs = distinct.map((c) => startFailure(c).message);
    expect(new Set(msgs).size, `these codes share a sentence: ${distinct.join(', ')}`).toBe(distinct.length);
    // ⚠ And the pruning must not have emptied the set — a comparison count of
    // zero looks exactly like a clean result.
    expect(distinct.length).toBeGreaterThan(4);
  });

  // ⚠ THE LIST OF DELIBERATE FALLTHROUGHS IS PINNED, so a code ADDED to the
  // engine without a decision here turns this red rather than quietly joining
  // the generic bucket. Each of the four is a considered choice:
  //   · method_not_allowed  — unreachable from this client; it only ever POSTs.
  //   · session_unavailable — a failed read of the session row. There is
  //                           nothing a customer can do differently, and the
  //                           generic "try again in a moment" is the true
  //                           advice.
  //   · internal_error      — carries its own `detail`, which the generic
  //                           branch renders verbatim, and is by definition
  //                           unclassifiable. A fixed sentence here would
  //                           replace a specific reason with a vague one.
  it('only the three deliberate fallthroughs are generic — RED if a NEW engine code slips into the generic bucket unnoticed', () => {
    expect([...generic].sort()).toEqual(
      ['internal_error', 'method_not_allowed', 'session_unavailable'].sort(),
    );
  });
});

describe('outcomeReport — when nothing comes back, say WHICH nothing', () => {
  const base: ProposalEmission = { proposed: 0, refused: 0, skipped_already_proposed: false, model_fill: 'ran' };

  // ⚠ THIS IS THE WHOLE OF POINT E. `refused`, `model_fill` and
  // `skipped_already_proposed` currently end their lives in a console.error
  // inside an edge function nobody tails, so a workspace whose employees were
  // ALL refused, one that ran out of AI budget, and one that simply said
  // nothing concrete, are shown the same blank page.
  it('no AI engine is blamed on the PLATFORM, not on what the customer said — RED if it tells them to describe their business better', () => {
    const r = outcomeReport({ ...base, model_fill: 'skipped_no_llm', refused: 12 });
    expect(r.tone).toBe('danger');
    expect(r.body).toMatch(/not something you said/i);
    expect(r.body).toMatch(/AI Engine/i);
    expect(r.body).toContain('12');
    expect(r.body).not.toMatch(/more detail|describe your/i);
  });

  // ⚠ HEADLINE AND BODY TOGETHER, because that is what a person reads. The
  // first draft asserted on `body` alone and went red on correct code — the
  // phrase it was looking for was in the headline. An assertion that can be
  // wrong about the GOOD case cannot be trusted about the bad one.
  const said = (e: ProposalEmission) => {
    const r = outcomeReport(e);
    return `${r.headline} ${r.body}`;
  };

  it('over budget is likewise a platform cause and says the loss is not retried — RED if a customer waits for a retry that never comes', () => {
    const e = { ...base, model_fill: 'skipped_ai_budget' as ModelFillOutcome, refused: 9 };
    expect(outcomeReport(e).tone).toBe('danger');
    expect(said(e)).toMatch(/spending limit|budget/i);
    expect(said(e)).toMatch(/will not try again/i);
    expect(said(e)).toContain('9');
  });

  it('the two platform causes OUTRANK a zero count — RED if "we heard nothing concrete" is printed over a billing problem', () => {
    // Both of these have proposed === 0 and refused === 0, which is exactly the
    // shape of the "you were too vague" branch. Order of blame is the fix.
    expect(said({ ...base, model_fill: 'skipped_no_llm' })).toMatch(/AI Engine/i);
    expect(said({ ...base, model_fill: 'skipped_ai_budget' })).toMatch(/spending limit/i);
    for (const fill of ['skipped_no_llm', 'skipped_ai_budget'] as ModelFillOutcome[]) {
      expect(said({ ...base, model_fill: fill }), fill).not.toMatch(/concrete enough/i);
    }
  });

  it('everything refused reads as OUR refusal to overclaim, not as the customer failing — RED if it goes silent or blames them', () => {
    const r = outcomeReport({ ...base, refused: 7 });
    expect(r.headline).toContain('7');
    expect(r.body).toMatch(/could not point at something you/i);
    expect(r.hasProposals).toBe(false);
  });

  it('some through and some refused says BOTH numbers — RED if the refusals are rounded away into a success message', () => {
    const r = outcomeReport({ ...base, proposed: 11, refused: 4 });
    expect(r.headline).toContain('11');
    expect(r.headline).toContain('4');
    expect(r.hasProposals).toBe(true);
  });

  it('a clean run says so without mentioning refusals — RED if it narrates a non-event', () => {
    const r = outcomeReport({ ...base, proposed: 12 });
    expect(r.tone).toBe('ok');
    expect(r.body).not.toMatch(/refus|drop/i);
    expect(r.hasProposals).toBe(true);
  });

  it('a genuinely empty interview is distinguished from a refused one — RED if the two collapse into one message', () => {
    const empty = outcomeReport({ ...base });
    const refused = outcomeReport({ ...base, refused: 3 });
    expect(empty.headline).not.toBe(refused.headline);
    expect(empty.body).not.toBe(refused.body);
  });

  it('already-proposed is a calm fact, not an error — RED if re-ending a session looks like a failure', () => {
    const r = outcomeReport({ ...base, skipped_already_proposed: true });
    expect(r.tone).toBe('ok');
    expect(r.hasProposals).toBe(true);
    expect(r.body).toMatch(/nothing was written twice/i);
  });

  // ⚠ `null` IS NOT AN OUTCOME. An interview whose last call failed has no
  // emission at all, and a cheerful zero there is a manufactured fact.
  it('no emission at all says we do not know — RED if absent is rendered as "nothing was recommended"', () => {
    const r = outcomeReport(null);
    expect(r.tone).toBe('warn');
    expect(r.body).toMatch(/did not get a report back/i);
    expect(r.hasProposals).toBe(false);
  });

  it('all four model_fill values produce a report and the two skips are distinct — RED if a new value falls through to nothing', () => {
    const fills: ModelFillOutcome[] = ['not_needed', 'ran', 'skipped_no_llm', 'skipped_ai_budget'];
    let compared = 0;
    const bodies: string[] = [];
    for (const f of fills) {
      const r = outcomeReport({ ...base, proposed: 3, model_fill: f });
      expect(r.body.length).toBeGreaterThan(20);
      bodies.push(r.body);
      compared++;
    }
    expect(compared).toBe(4);
    expect(bodies[2]).not.toBe(bodies[3]);
    expect(bodies[0]).toBe(bodies[1]); // not_needed and ran are the same story
  });
});

describe('resumeOffer — "continue" is only ever offered for a session that can continue', () => {
  const p = coverageProgress({ a: { state: 'heard' }, b: { state: 'not_heard' } });

  it('a RUNNING session is genuinely continuable and says so — RED if it offers a fresh start over live work', () => {
    const o = resumeOffer({ status: 'running' }, p);
    expect(o.kind).toBe('running');
    expect(o.primaryLabel).toMatch(/continue/i);
    expect(o.body).toMatch(/nothing you have already told us is lost/i);
  });

  // ⚠ THE LIE THIS FUNCTION EXISTS TO PREVENT. end_discovery_session moves
  // running -> parked/abandoned ONE WAY, nothing anywhere sets status back to
  // 'running', and start_discovery_session always INSERTs a new row with
  // freshly seeded coverage. "Continue where you left off" is true for a
  // running session and a lie for a parked one.
  it('a PARKED session is NOT offered as continuable — RED if the word "continue" ever appears for one', () => {
    const o = resumeOffer({ status: 'parked', resume_hint: 'need to ask our accountant' }, p);
    expect(o.kind).toBe('closed');
    expect(o.primaryLabel).toMatch(/new interview/i);
    expect(o.primaryLabel.toLowerCase()).not.toContain('continue');
    expect(o.body).toMatch(/cannot be picked up/i);
    expect(o.body).toContain('need to ask our accountant');
  });

  it('an ABANDONED session is closed too, and worded differently from parked — RED if the two read identically', () => {
    const parked = resumeOffer({ status: 'parked' }, p);
    const abandoned = resumeOffer({ status: 'abandoned' }, p);
    expect(abandoned.kind).toBe('closed');
    expect(abandoned.headline).not.toBe(parked.headline);
  });

  it('a status this build has never seen is treated as closed, never as continuable — RED if an unknown status opens a composer', () => {
    for (const status of ['proposed', 'accepted', 'something_new']) {
      expect(resumeOffer({ status }, p).kind, `status ${status}`).toBe('closed');
    }
  });

  it('no session at all invites a start and explains what it is for — RED if a first-time customer meets a bare button', () => {
    const o = resumeOffer(null, coverageProgress({}));
    expect(o.kind).toBe('none');
    expect(o.primaryLabel).toMatch(/start/i);
    expect(o.body).toMatch(/nothing is created until you approve it/i);
  });

  it('a closed session points at the recommendations it already produced — RED if its output becomes unfindable', () => {
    expect(resumeOffer({ status: 'parked' }, p).body).toMatch(/what we recommend/i);
  });

  // ══ THE THIRD STATE — a session that is 'running' and FINISHED ══════════
  //
  // ⚠ THE DEFECT THIS BLOCK EXISTS FOR, and it shipped. Natural completion
  // NEVER moves status off 'running' — the 'answer' action writes only the
  // transcript and the coverage ledger (index.ts:988, 999-1009); only 'end'
  // changes status. resumeOffer branched on `status` alone while already
  // holding `progress`, so a customer who had answered every question came
  // back to "You have an interview in progress · All 14 topics covered ·
  // Continue where you left off", and continuing landed them on a done screen
  // with no route to the recommendations at all.
  const done = coverageProgress({ a: { state: 'heard' }, b: { state: 'skipped' } });

  it('a RUNNING session with nothing left owed is FINISHED, not in progress — RED if a completed interview is offered as one to carry on', () => {
    const o = resumeOffer({ status: 'running' }, done, 4);
    expect(o.kind).toBe('finished');
    expect(o.headline.toLowerCase()).not.toContain('in progress');
    expect(o.primaryLabel).toMatch(/see what we recommend/i);
    expect(o.primaryAction).toBe('proposals');
    expect(o.body).toContain('4');
  });

  it('...and it does NOT promise to carry on from the same question — RED if the "continue" wording survives onto a finished interview', () => {
    const o = resumeOffer({ status: 'running' }, done, 4);
    expect(o.primaryLabel.toLowerCase()).not.toContain('continue');
    expect(o.body).not.toMatch(/same question|nothing you have already told us is lost/i);
  });

  // ⚠ INVERT IT. If the finished branch swallowed every running session, the
  // three cases above would pass and the genuinely resumable case would be
  // broken instead.
  it('a RUNNING session with work left is STILL in progress — RED if the finished branch has eaten the resumable one', () => {
    const o = resumeOffer({ status: 'running' }, p);
    expect(o.kind).toBe('running');
    expect(o.primaryAction).toBe('resume');
  });

  // ⚠ AN EMPTY LEDGER IS NOT A FINISHED ONE. coverageProgress({}) has
  // remaining === 0 for the same reason 0 of 0 is covered, so a session whose
  // coverage failed to load, or one read before anything was recorded, would
  // be announced as finished by a check on `remaining` alone.
  it('a running session with an EMPTY coverage map is not called finished — RED if a failed coverage read is rendered as a completed interview', () => {
    const o = resumeOffer({ status: 'running' }, coverageProgress({}), null);
    expect(o.kind).toBe('running');
  });

  // ⚠ THE THREE COUNTS ARE THREE DIFFERENT FACTS. `null` is "we did not manage
  // to look", 0 is "it wrote up nothing", and n is "n are waiting". A zero that
  // stands in for an unknown is a manufactured fact — the same rule
  // outcomeReport(null) already follows.
  it('zero, unknown and some are three different offers — RED if "we could not check" collapses into "nothing was created"', () => {
    const none = resumeOffer({ status: 'running' }, done, 0);
    const unknown = resumeOffer({ status: 'running' }, done, null);
    const some = resumeOffer({ status: 'running' }, done, 3);
    expect(new Set([none.headline, unknown.headline, some.headline]).size).toBeGreaterThan(1);
    expect(new Set([none.body, unknown.body, some.body]).size).toBe(3);
    // Zero must not send anybody to a page it already knows is empty.
    expect(none.primaryAction).toBe('start');
    // Unknown must; going to look IS the honest action when we could not.
    expect(unknown.primaryAction).toBe('proposals');
    expect(unknown.body).toMatch(/could not check/i);
  });

  it('a finished interview that wrote nothing says so without blaming a count it does not have — RED if it invents a refusal count that is not stored anywhere', () => {
    const o = resumeOffer({ status: 'running' }, done, 0);
    expect(o.body).toMatch(/concrete enough/i);
    // `refused` and `model_fill` are counted in memory by emitProposals and
    // never written to a row. Nothing may claim a number for them after a
    // reload.
    expect(o.body).not.toMatch(/\b\d+ (draft|recommendation)s? (were|was) (dropped|refused)/i);
  });

  it('a CLOSED session carries the durable count too — RED if "anything it recommended is waiting" is printed over a session that wrote nothing', () => {
    expect(resumeOffer({ status: 'parked' }, p, 0).body).toMatch(/wrote up nothing/i);
    expect(resumeOffer({ status: 'parked' }, p, 6).body).toContain('6');
    expect(resumeOffer({ status: 'parked' }, p, 6).body).toMatch(/what we recommend/i);
  });

  // ⚠ EVERY KIND MUST CARRY AN ACTION, and no kind may carry one that
  // contradicts its own label. This is the pairing the page used to re-derive
  // with an inline ternary, which is how `finished` silently became "start".
  it('every offer names an action, and no label promises something its action does not do — RED if a label and its handler drift apart', () => {
    const cases: Array<[string, ReturnType<typeof resumeOffer>]> = [
      ['none', resumeOffer(null, coverageProgress({}))],
      ['running', resumeOffer({ status: 'running' }, p)],
      ['finished/some', resumeOffer({ status: 'running' }, done, 2)],
      ['finished/none', resumeOffer({ status: 'running' }, done, 0)],
      ['closed', resumeOffer({ status: 'parked' }, p)],
    ];
    let compared = 0;
    for (const [name, o] of cases) {
      expect(['start', 'resume', 'proposals'], name).toContain(o.primaryAction);
      if (o.primaryAction === 'proposals') expect(o.primaryLabel, name).toMatch(/recommend/i);
      if (o.primaryAction === 'resume') expect(o.primaryLabel, name).toMatch(/continue/i);
      if (o.primaryAction === 'start') expect(o.primaryLabel, name).toMatch(/start/i);
      compared++;
    }
    expect(compared, 'the offer loop did not run — five kinds checked zero times looks exactly like five clean ones').toBe(5);
    expect(new Set(cases.map(([, o]) => o.kind)).size, 'the five cases collapsed into fewer kinds').toBe(4);
  });
});

describe('the interview state machine', () => {
  const start = startedState({ session_id: 's1', question: 'What do you do?' });

  it('starting seeds the transcript with the opening question and leaves it outstanding', () => {
    expect(start.sessionId).toBe('s1');
    expect(start.turns).toHaveLength(1);
    expect(start.question).toBe('What do you do?');
    expect(start.done).toBe(false);
    expect(start.emission).toBeNull();
  });

  it('an answer appends BOTH turns and carries the engine\'s next question', () => {
    const next = answeredState(start, 'We run two dental clinics.', {
      question: 'How do people reach you?', coverage: { a: { state: 'heard' } } as CoverageMap, done: false,
    });
    expect(next.turns.map((t) => t.role)).toEqual(['interviewer', 'you', 'interviewer']);
    expect(next.question).toBe('How do people reach you?');
  });

  // ⚠ `done` COMES FROM THE ENGINE. This client must not hold a second opinion
  // about when an interview is over — the engine computes it from the real
  // ledger, and a client that recomputed it could declare an interview
  // finished that the engine would still ask questions in.
  it('done is taken from the engine, not re-derived from coverage — RED if the client starts second-guessing it', () => {
    const cov = { a: { state: 'not_heard' } } as CoverageMap;
    const next = answeredState(start, 'x', { question: null, coverage: cov, done: true });
    expect(next.done).toBe(true);
    expect(coverageProgress(cov).remaining).toBe(1); // the ledger disagrees; the engine still wins
  });

  it('a final turn with no next question closes the composer and keeps the emission', () => {
    const next = answeredState(start, 'x', {
      question: null, coverage: {} as CoverageMap, done: true,
      proposals: { proposed: 5, refused: 1, skipped_already_proposed: false, model_fill: 'ran' },
    });
    expect(next.question).toBeNull();
    expect(next.emission?.proposed).toBe(5);
  });

  it('a later turn carrying no emission does not erase an earlier one — RED if silence overwrites a real count', () => {
    const withEmission = answeredState(start, 'x', {
      question: 'more?', coverage: {} as CoverageMap, done: false,
      proposals: { proposed: 5, refused: 0, skipped_already_proposed: false, model_fill: 'ran' },
    });
    const after = answeredState(withEmission, 'y', { question: null, coverage: {} as CoverageMap, done: true });
    expect(after.emission?.proposed).toBe(5);
  });

  it('ending clears the outstanding question — RED if a composer survives into a session that refuses every answer', () => {
    const ended = endedState(start, {
      session_id: 's1', status: 'parked', coverage: {} as CoverageMap, owed: ['money_in'], owed_count: 1,
      proposals: { proposed: 2, refused: 0, skipped_already_proposed: false, model_fill: 'ran' }, done: true,
    });
    expect(ended.question).toBeNull();
    expect(ended.ended).toBe('parked');
    expect(ended.done).toBe(true);
  });

  it('EMPTY_INTERVIEW is genuinely empty — RED if a stale session id survives a reset and the next answer goes to the wrong interview', () => {
    expect(EMPTY_INTERVIEW.sessionId).toBeNull();
    expect(EMPTY_INTERVIEW.turns).toHaveLength(0);
    expect(EMPTY_INTERVIEW.emission).toBeNull();
    expect(EMPTY_INTERVIEW.ended).toBeNull();
  });
});

describe('resumedState — picking a running conversation back up', () => {
  const transcript = [
    { role: 'assistant', text: 'What do you do?' },
    { role: 'user', text: 'Two dental clinics.' },
    { role: 'assistant', text: 'How do patients reach you?' },
  ];

  it('translates the stored roles and re-asks the outstanding question', () => {
    const s = resumedState({ id: 's1', transcript, coverage: { a: { state: 'heard' }, b: { state: 'not_heard' } } });
    expect(s.turns.map((t) => t.role)).toEqual(['interviewer', 'you', 'interviewer']);
    expect(s.question).toBe('How do patients reach you?');
    expect(s.sessionId).toBe('s1');
  });

  // The engine writes the transcript BEST-EFFORT after the ledger, so a
  // transcript ending on a customer turn is a real, reachable shape.
  it('a transcript ending on the customer re-asks the previous question — RED if the composer opens with nothing to answer', () => {
    const s = resumedState({ id: 's1', transcript: transcript.slice(0, 2), coverage: { a: { state: 'not_heard' } } });
    expect(s.question).toBe('What do you do?');
  });

  // ⚠ A running session whose spine has closed. Natural completion never moves
  // status off 'running' — only 'end' does — so this is not hypothetical.
  it('a closed spine offers NO question even though the transcript ends on one — RED if it offers a composer the engine will refuse to use', () => {
    const s = resumedState({ id: 's1', transcript, coverage: { a: { state: 'heard' }, b: { state: 'skipped' } } });
    expect(s.question).toBeNull();
    expect(s.done).toBe(true);
  });

  it('a parked dimension keeps the conversation open — RED if "ask me later" is treated as finished', () => {
    const s = resumedState({ id: 's1', transcript, coverage: { a: { state: 'heard' }, b: { state: 'parked' } } });
    expect(s.question).toBe('How do patients reach you?');
    expect(s.done).toBe(false);
  });

  it('a missing or malformed transcript does not crash the resume — RED if a best-effort write failure takes the page down', () => {
    expect(resumedState({ id: 's1' }).turns).toHaveLength(0);
    expect(resumedState({ id: 's1', transcript: 'not an array' }).turns).toHaveLength(0);
    expect(resumedState({ id: 's1', transcript: [{ role: 'user' }, { role: 'assistant', text: '  ' }] }).turns).toHaveLength(0);
  });

  it('an empty coverage map is not read as "finished" — RED if a session that never recorded anything says it is done', () => {
    expect(resumedState({ id: 's1', transcript, coverage: {} }).done).toBe(false);
  });
});

describe('park — two sizes, and the honest bound on each', () => {
  it('the ask-me-later text is the phrasing the ENGINE names as its park trigger — RED if it drifts away from the prompt', () => {
    expect(ASK_ME_LATER_TEXT.toLowerCase()).toContain('ask me later');
    // The engine's own system prompt: '"parked" is for "ask me later"'.
    expect(ENGINE_SRC).toContain('"parked" is for "ask me later"');
  });

  it('the ask-me-later text carries NO concrete fact, so it cannot close a topic — RED if it ever gains one', () => {
    // coverageAfter refuses a 'heard' or 'skipped' entry with no evidence, so a
    // sentence with nothing quotable in it cannot terminate a dimension however
    // the model reads it. That is the hard guarantee behind the soft rail.
    expect(ASK_ME_LATER_TEXT).not.toMatch(/\d/);
    expect(ASK_ME_LATER_TEXT.length).toBeLessThan(120);
  });

  it('both stop intents state their consequence, and both admit the conversation closes — RED if "come back later" promises a resume the database cannot do', () => {
    expect(STOP_CONSEQUENCE.parked).toMatch(/closes/i);
    expect(STOP_CONSEQUENCE.abandoned).toMatch(/closes/i);
    expect(STOP_CONSEQUENCE.parked).toMatch(/fresh one/i);
    expect(STOP_CONSEQUENCE.parked).not.toBe(STOP_CONSEQUENCE.abandoned);
  });

  it('both intents promise the write-up, because end() really does emit proposals — RED if a customer stops expecting nothing', () => {
    expect(STOP_CONSEQUENCE.parked).toMatch(/write up/i);
    expect(STOP_CONSEQUENCE.abandoned).toMatch(/write up/i);
  });

  it('a blank resume note becomes null, never an empty string — RED if a blank textarea is stored as a note', () => {
    expect(resumeHint('')).toBeNull();
    expect(resumeHint('   \n ')).toBeNull();
    expect(resumeHint('  where we got to  ')).toBe('where we got to');
  });

  it('a very long note is bounded client-side rather than silently truncated by the server — RED if the cap moves off 500', () => {
    expect(resumeHint('x'.repeat(900))).toHaveLength(500);
    // The engine's own slice, so the two agree rather than one trusting the other.
    expect(ENGINE_SRC).toContain('String(body.resume_hint).trim().slice(0, 500)');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// PART 2 — THE WIRING. Everything above could be perfect and the feature
// still unreachable; that was the state of this repo before this change.
// ═════════════════════════════════════════════════════════════════════════

describe('the access gate — behaviour against the REAL canAccessPage', () => {
  // ⚠ NOT A TEXT MATCH ON navAccess.ts. This calls the same function App.tsx
  // routes through, so it cannot pass on a page whose entry was written into a
  // comment or a different map.
  it('the deny that hid this feature is closed — tenant_owner, tenant_admin AND a platform operator can all open both pages', () => {
    for (const page of ['discovery_interview', 'discovery_proposals'] as const) {
      expect(canAccessPage('tenant_owner', page, 'tenant'), `owner / ${page}`).toBe(true);
      expect(canAccessPage('tenant_admin', page, 'tenant'), `admin / ${page}`).toBe(true);
      expect(canAccessPage('dt_super_admin', page, 'platform'), `platform / ${page}`).toBe(true);
    }
  });

  // ⚠⚠ THIS TEST WAS NAMED "matches the authority that ALREADY exists —
  // everyone decide_discovery_proposal refuses is kept out". That name was
  // FALSE, and so was the sentence in navAccess.ts it was written from. Read
  // from migration 741 rather than believed:
  //   · the tenant_owner/tenant_admin check sits INSIDE
  //     `if p_decision = 'accepted' then` (741:310-319);
  //   · EXECUTE is granted to `authenticated` (741:573);
  //   · the function's own exception says "declining and parking are open to
  //     anyone in the workspace".
  // So the database gates ONE of three decisions, and the engine that runs the
  // interview gates none of them (index.ts:709-723 admits any tenant member).
  // The ADMIN tier is a deliberate product NARROWING — defensible on what the
  // cards carry, which is the argument navAccess actually makes — and calling
  // it a mirror of the database was the over-claim. The tier does not move;
  // the description of why does.
  it('the ADMIN tier is a deliberate narrowing, and the roles below really are shut out — RED if the page quietly widens to match the database instead', () => {
    const narrowed = ['tenant_manager', 'knowledge_manager', 'approver', 'tenant_user', 'read_only'] as const;
    let compared = 0;
    for (const page of ['discovery_interview', 'discovery_proposals'] as const) {
      for (const role of narrowed) {
        expect(canAccessPage(role, page, 'tenant'), `${role} / ${page}`).toBe(false);
        compared++;
      }
    }
    expect(compared, 'the role loop did not run').toBe(10);
  });

  it('the database really is wider than the tier, so the narrowing is recorded as one — RED if either the migration or the comment starts telling the other story', () => {
    // The role bar is inside the accept branch, not around the whole function.
    const acceptGate = MIGRATION_741.indexOf("if p_decision = 'accepted' then");
    const roleCheck = MIGRATION_741.indexOf("p.role in ('tenant_owner', 'tenant_admin')");
    expect(acceptGate, 'could not find the accept branch in migration 741').toBeGreaterThan(-1);
    expect(roleCheck, 'could not find the role check in migration 741').toBeGreaterThan(-1);
    expect(roleCheck, 'the role check is no longer inside the accept branch — the old comment may now be true').toBeGreaterThan(acceptGate);
    expect(MIGRATION_741).toMatch(/declining and parking are open to anyone in the workspace/);
    expect(MIGRATION_741).toMatch(/grant execute on function public\.decide_discovery_proposal[\s\S]{0,120}to authenticated/);
    // ...and the comment beside the tier no longer claims the database does
    // the gating for us.
    expect(NAV_SRC, 'navAccess still claims decide_discovery_proposal refuses non-admins outright')
      .not.toMatch(/refuses anyone who is not/);
    expect(NAV_SRC).toMatch(/NARROWER than the DATABASE|narrower than the database/i);
  });

  // ⚠ INVERT THE PIN. If canAccessPage started answering `true` for everything,
  // every assertion above would pass and mean nothing.
  it('the gate still refuses a page nobody has decided about — RED if default-DENY has stopped working and the tests above are vacuous', () => {
    expect(canAccessPage('tenant_owner', 'a_page_that_does_not_exist' as never, 'tenant')).toBe(false);
    expect(canAccessPage('read_only', 'settings', 'tenant')).toBe(false);
  });
});

describe('the routes and the doors', () => {
  it('both pages have a URL, and no two pages share one — RED if a duplicate silently shadows a route', () => {
    expect(PAGE_TO_URL.discovery_interview).toBe('/setup/discovery');
    expect(PAGE_TO_URL.discovery_proposals).toBe('/setup/discovery-proposals');
    const urls = Object.values(PAGE_TO_URL);
    expect(new Set(urls).size, 'two pages map to the same URL').toBe(urls.length);
    expect(URL_TO_PAGE['/setup/discovery']).toBe('discovery_interview');
  });

  it('App.tsx actually routes the interview to its component — RED if the case is missing and the page falls through to the dashboard', () => {
    expect(APP_SRC).toMatch(/case 'discovery_interview':\s*\r?\n\s*return <DiscoveryInterviewPage/);
    expect(APP_SRC).toContain("import DiscoveryInterviewPage from './pages/tenant/DiscoveryInterviewPage'");
  });

  // ⚠ THE RE-OPENABLE HALF of the founder's ruling. First login fires once and
  // is remembered in localStorage, so without a nav entry a customer who
  // skipped would have no way back at all.
  it('both pages are offered in the Setup nav — RED if the only way in is a URL nobody types', () => {
    expect(SIDEBAR_SRC).toMatch(/page:\s*'discovery_interview'/);
    expect(SIDEBAR_SRC).toMatch(/page:\s*'discovery_proposals'/);
  });
});

describe('first login — every landing decision in AuthContext, not just the ones already using the helper', () => {
  // ⚠ AuthContext cannot be imported here: it pulls in ../supabase, which reads
  // import.meta.env at module load. So the landing rule was extracted into a
  // pure exported function and this suite reads the FILE.
  //
  // ⚠⚠ WHY THIS TEST WAS REWRITTEN, because the version it replaces is the
  // exact shape CLAUDE.md calls theatre. It asserted "exactly TWO first-login
  // landings exist and BOTH go through firstLoginLanding" — a count of the
  // call sites that were ALREADY correct. A third landing decision written as
  // a plain `setCurrentPage('dashboard')` was invisible to it, and there was
  // one: `completeOrgSetup`, the page a BRAND-NEW workspace actually lands on
  // after complete_signup. So the assertion did not merely miss the defect, it
  // institutionalised it — "there are two" was the reason not to look for a
  // third. Counting the calls that go through the helper can never find a call
  // that does not.
  //
  // What is counted now is EVERY `setCurrentPage(` in the file, by its
  // argument. A new landing of any shape changes this list.
  // ⚠ COMMENTS STRIPPED FIRST, and this file's own history is why: AuthContext
  // now DISCUSSES `setCurrentPage('dashboard')` in the paragraph explaining the
  // defect, and a census that counted prose would have found an extra landing
  // that does not exist — a checker made red by the note describing what it
  // checks is no better than one that cannot go red at all.
  const AUTH_CODE = stripComments(AUTH_SRC);
  const CALL_ARGS = [...AUTH_CODE.matchAll(/setCurrentPage\(\s*'?([A-Za-z_][\w.]*)/g)].map((m) => m[1]);

  it('every setCurrentPage call site in AuthContext is accounted for — RED the moment a landing decision is added, moved or removed, whatever shape it is written in', () => {
    // Each entry is a decision somebody made on purpose:
    //   firstLoginLanding ×3 — session restore, fresh sign-in, and the
    //                          brand-new-workspace path (completeOrgSetup).
    //   'dashboard'       ×4 — forced sign-out (deactivated), SIGNED_OUT,
    //                          entering Remote Access, and logout.
    //   'platform_home'   ×2 — the two platform-operator branches.
    //   prev              ×1 — the functional update in the deep-link guard.
    //   p                 ×1 — handleSetPage, which is navigation, not landing.
    expect([...CALL_ARGS].sort()).toEqual([
      'dashboard', 'dashboard', 'dashboard', 'dashboard',
      'firstLoginLanding', 'firstLoginLanding', 'firstLoginLanding',
      'p',
      'platform_home', 'platform_home',
      'prev',
    ]);
  });

  it('the census actually found the calls — RED if the regex breaks and the list above is compared against nothing', () => {
    expect(CALL_ARGS.length, 'no setCurrentPage calls matched at all — the extraction is broken, not the file').toBeGreaterThan(8);
    // Every call in the CODE must have been readable by the census — otherwise
    // a landing written in a shape the regex cannot parse would be silently
    // exempt from the list above, which is the whole failure this replaces.
    expect((AUTH_CODE.match(/setCurrentPage\(/g) ?? []).length, 'a setCurrentPage call has an argument shape the census cannot read')
      .toBe(CALL_ARGS.length);
    // And the stripper did real work rather than returning the file unchanged.
    expect(AUTH_CODE.length).toBeLessThan(AUTH_SRC.length);
    expect(AUTH_CODE).not.toContain('THE THIRD FIRST-LOGIN LANDING');
    expect(AUTH_CODE).toContain('const completeOrgSetup');
  });

  // ⚠ THE BLOCKER ITSELF. A brand-new workspace never met the interview:
  // sign-up creates an auth user with no tenant, the first sign-in BURNS the
  // dt_onboarded flag and picks discovery_interview, App.tsx renders
  // OrgSetupScreen instead because the profile has no tenant, and
  // completeOrgSetup then went to the dashboard with the flag already spent.
  it('completeOrgSetup lands through firstLoginLanding — RED if the one path a new workspace actually takes goes back to the dashboard', () => {
    const fn = braceSlice(AUTH_SRC, AUTH_SRC.indexOf('const completeOrgSetup = async'));
    expect(fn, 'could not isolate completeOrgSetup — every assertion here would pass over nothing').toBeTruthy();
    expect(fn!).toMatch(/setCurrentPage\(firstLoginLanding\(/);
    expect(fn!, 'completeOrgSetup still lands on a literal page').not.toMatch(/setCurrentPage\(\s*'/);
    // It must pass firstLogin = true: the localStorage flag was already spent
    // by the sign-in that got here, so probing it again would always say no.
    expect(fn!).toMatch(/firstLoginLanding\(\s*true\s*,/);
    // ...and the role complete_signup has just made true, not the stale one
    // from signup metadata.
    expect(fn!).toMatch(/firstLoginLanding\(\s*true\s*,\s*'tenant_owner'/);
  });

  it('the two sign-in paths still go through the helper too — RED if fixing the third quietly regressed the first two', () => {
    const viaHelper = AUTH_SRC.match(/setCurrentPage\(firstLoginLanding\(/g) ?? [];
    expect(viaHelper, `expected 3 calls through firstLoginLanding, found ${viaHelper.length}`).toHaveLength(3);
    // And the shape it replaced must be gone, not merely outnumbered.
    expect(AUTH_SRC).not.toMatch(/firstLogin\s*\?\s*'/);
    expect(AUTH_SRC).not.toMatch(/setCurrentPage\(\s*firstLogin\b/);
  });

  it('the two localStorage first-login probes are still both present — RED if one path stopped detecting first login at all, which would make the assertion above vacuous', () => {
    expect((AUTH_SRC.match(/dt_onboarded_/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('the landing is the interview, not the old wizard — RED if company_setup creeps back as the first-login destination', () => {
    const fn = braceSlice(AUTH_SRC, AUTH_SRC.indexOf('export function firstLoginLanding'));
    expect(fn, 'could not locate firstLoginLanding — every assertion here would pass over nothing').toBeTruthy();
    expect(fn!).toContain("'discovery_interview'");
    expect(fn!).not.toContain("'company_setup'");
  });

  it('the landing asks canAccessPage — RED if a first-login tenant_user is dropped onto an ADMIN page nothing else would let them open', () => {
    const fn = braceSlice(AUTH_SRC, AUTH_SRC.indexOf('export function firstLoginLanding'))!;
    // These call sites use setCurrentPage directly, NOT handleSetPage, so
    // nothing else on this path consults PAGE_ACCESS.
    expect(fn).toMatch(/canAccessPage\(\s*role\s*,\s*'discovery_interview'/);
    expect(fn).toContain("'dashboard'");
  });

  // ⚠ THE OLD WIZARD IS NOT RETIRED HERE. It still collects things the
  // interview does not (industry, vocabulary, pipeline stages, entity fields,
  // branding), and retiring it is Plan 4 of the spec — after this replacement
  // is proven.
  it('company_setup keeps its route, its nav entry and its tier — RED if this change quietly retired a wizard it was not asked to', () => {
    expect(PAGE_TO_URL.company_setup).toBe('/setup');
    expect(SIDEBAR_SRC).toMatch(/page:\s*'company_setup'/);
    expect(canAccessPage('tenant_owner', 'company_setup', 'tenant')).toBe(true);
  });

  // ⚠ THE OTHER FIRST-LOGIN SURFACE, and the one that is reachable when the
  // landing is not. First login fires once and burns a localStorage flag;
  // somebody who skipped it, or whose workspace predates it, meets the Getting
  // Started guide on an empty dashboard instead. Its step 1 was the only
  // "start here" affordance there, and it went on pointing at Quick Start —
  // the surface this replaces — which is how a replacement replaces nothing.
  const firstStep = braceSlice(GUIDE_SRC, GUIDE_SRC.indexOf('const steps: Step[] = state ?'));

  it('the guide\'s first step could be isolated — RED if the extraction breaks and the case below passes over nothing', () => {
    expect(firstStep, 'could not isolate the first step of GettingStartedGuide').toBeTruthy();
    expect(firstStep!).toContain('title:');
    expect(firstStep!).toContain('primary:');
    // One step, not the whole array — a slice that ran on would let step 2's
    // actions satisfy assertions written about step 1.
    expect(firstStep!, 'the slice ran past the first step').not.toContain('Teach it your business');
  });

  it('its PRIMARY action opens the interview — RED if the empty dashboard goes back to sending new customers to the surface this replaced', () => {
    expect(firstStep!).toMatch(/primary:\s*\{[^}]*go\('discovery_interview'/);
  });

  it('...and Quick Start is kept as the secondary rather than deleted — RED if this change retired a page it was not asked to retire', () => {
    expect(firstStep!).toMatch(/secondary:\s*\{[^}]*go\('onboarding_architect'/);
    expect(canAccessPage('tenant_owner', 'onboarding_architect', 'tenant')).toBe(true);
    expect(PAGE_TO_URL.onboarding_architect).toBe('/setup/quick-start');
  });
});

describe('the page ACTUALLY calls the engine — bounded to one handler each', () => {
  const begin = callbackBody(PAGE_SRC, 'begin');
  const send = callbackBody(PAGE_SRC, 'send');
  const stop = callbackBody(PAGE_SRC, 'stop');

  it('all three handlers could be isolated — RED if any extraction breaks, which would make every assertion below vacuous', () => {
    expect(begin, 'could not isolate the begin handler').toBeTruthy();
    expect(send, 'could not isolate the send handler').toBeTruthy();
    expect(stop, 'could not isolate the stop handler').toBeTruthy();
    for (const b of [begin, send, stop]) expect(b!.length).toBeGreaterThan(60);
  });

  // ⚠ THE ONE THAT DID NOT EXIST BEFORE THIS CHANGE. There was no
  // functions.invoke('discovery-interview') anywhere in src/.
  it('the product invokes the engine by name — RED if the only caller goes back to being a scratch script', () => {
    expect(API_SRC).toMatch(/invokeEdge<[^>]*>\('discovery-interview'/);
    expect((API_SRC.match(/'discovery-interview'/g) ?? []).length).toBe(3); // start, answer, end
  });

  it('begin calls startInterview and only sets state on the success branch — RED if a refusal is rendered as a started interview', () => {
    expect(begin!).toContain('await startInterview()');
    expect(begin!).toMatch(/if\s*\(res\.outcome === 'failed'\)\s*setFailure/);
    expect(begin!).toMatch(/else\s+setState\(startedState/);
  });

  it('send calls answerInterview and appends the answer ONLY after the engine took it — RED if the transcript can show words the engine refused', () => {
    expect(send!).toContain('await answerInterview(state.sessionId, message)');
    const failAt = send!.indexOf("res.outcome === 'failed'");
    const appendAt = send!.indexOf('answeredState');
    expect(failAt, 'send does not branch on the refusal at all').toBeGreaterThan(-1);
    expect(appendAt, 'send never appends the turn').toBeGreaterThan(failAt);
    expect(send!).toMatch(/else\s*\{[\s\S]{0,200}answeredState/);
  });

  it('stop passes the customer\'s CHOSEN intent, not a hardcoded one — RED if "I am done" is silently recorded as a park', () => {
    expect(stop!).toContain('endInterview(state.sessionId, stopIntent, resumeHint(stopNote))');
    // A literal would make the two options on the modal decorative.
    expect(stop!).not.toMatch(/endInterview\([^)]*'parked'/);
    expect(stop!).not.toMatch(/endInterview\([^)]*'abandoned'/);
  });

  // ⚠ A DEFECT INTRODUCED AND THEN CLOSED IN THIS CHANGE. "Start over" wired
  // straight to begin() leaves the interview in progress at 'running' —
  // start_discovery_session always INSERTs, and the session reader only returns
  // the newest — so the old one becomes invisible AND never reaches the
  // emitter. Everything it had heard is lost with no record it existed: the
  // invisible pile §7 names, minted by a button.
  it('Start over CLOSES the running session before beginning a new one — RED if it goes back to orphaning a live interview', () => {
    const startOver = callbackBody(PAGE_SRC, 'startOver');
    expect(startOver, 'could not isolate startOver').toBeTruthy();
    expect(startOver!).toMatch(/endInterview\(existing\.id, 'abandoned'/);
    const endAt = startOver!.indexOf('endInterview');
    const beginAt = startOver!.indexOf('await begin()');
    expect(beginAt, 'startOver never starts a new interview').toBeGreaterThan(-1);
    expect(endAt, 'the old session is not closed before the new one starts').toBeLessThan(beginAt);
    // And the control must actually call it.
    const btn = onClickForLabel(PAGE_SRC, 'Start over instead');
    expect(btn, 'no "Start over instead" control found').toBeTruthy();
    expect(btn!).toContain('startOver()');
    expect(btn!).not.toMatch(/void begin\(\)/);
  });

  it('a failed tidy-up still starts the new interview and says so — RED if a broken cleanup traps the customer, or is swallowed', () => {
    const startOver = callbackBody(PAGE_SRC, 'startOver')!;
    expect(startOver).toMatch(/closed\.outcome === 'failed'/);
    // The report comes AFTER begin(), i.e. the new interview is not blocked.
    expect(startOver.indexOf('await begin()')).toBeLessThan(startOver.indexOf("closed.outcome === 'failed'"));
    expect(startOver).toContain('setFailure(');
  });

});

// ═════════════════════════════════════════════════════════════════════════
// PART 2b — THE RENDERS. Everything in PART 2 could pass on a page that
// draws none of it.
// ═════════════════════════════════════════════════════════════════════════

describe('the three renders that could be deleted without going red', () => {
  // ⚠⚠ WHY THIS BLOCK EXISTS, and it is not hypothetical. Each of the three
  // was proven unpinned by a reviewer MUTATION, and every one of those
  // mutations left the suite 95/95 GREEN:
  //
  //   · the primary button's onClick replaced with `() => resumeRunning()`.
  //     For a new workspace `existing` is null, so resumeRunning early-returns
  //     and "Start the interview" does nothing at all. `begin`'s body and the
  //     "Start over instead" control were both pinned; the one control with a
  //     DYNAMIC label — the only one onClickForLabel cannot reach — was not.
  //   · `outcomeReport(state.emission)` replaced with a hardcoded
  //     `{proposed: 99, refused: 0}`. outcomeReport has ten unit tests above
  //     and not one of them reaches the render, so "say WHICH nothing came
  //     back" was proven in the module and unproven on the page.
  //   · `{stopOpen && (<Modal…>)}` replaced with `{false && (…)}`. The park
  //     dialog's assertions read the handler body and the `['parked',
  //     'abandoned'].map` expression — both of which a deleted render leaves
  //     exactly where they were.
  //
  // The common fault: every assertion was about a piece of CODE the render
  // uses, never about the render. So each case below anchors on the render's
  // own gate or element, asserts the extraction succeeded FIRST, and then
  // asserts only against the extracted slice.

  // ── I1 · the one control whose label is an expression ──────────────────
  const primaryBtn = buttonWithChild(PAGE_SRC, 'offer.primaryLabel');
  const runPrimary = callbackBody(PAGE_SRC, 'runPrimary');

  it('the primary control and its handler could both be isolated — RED if either extraction breaks and the cases below pass over nothing', () => {
    expect(primaryBtn, 'no <Button> renders offer.primaryLabel').toBeTruthy();
    expect(runPrimary, 'could not isolate runPrimary').toBeTruthy();
    expect(primaryBtn!).toContain('<Button');
    expect(runPrimary!.length).toBeGreaterThan(60);
  });

  it('the primary control calls runPrimary and nothing else — RED if its onClick is rewired to a handler that does nothing for a new workspace', () => {
    expect(primaryBtn!).toMatch(/onClick=\{\s*runPrimary\s*\}/);
    // The mutation that stayed green: an inline handler naming one of the
    // three actions directly. The label is decided by resumeOffer; the action
    // must be too.
    expect(primaryBtn!, 'the primary control has gone back to deciding its own action inline').not.toMatch(/onClick=\{\s*\(\)/);
  });

  it('runPrimary does all three things the offer can ask for — RED if a branch is dropped and one label stops working, which is how `finished` shipped as "start"', () => {
    let compared = 0;
    for (const [action, call] of [
      ['proposals', /setPage\?\.\('discovery_proposals'\)/],
      ['resume', /resumeRunning\(\)/],
      ['start', /startOver\(\)/],
    ] as const) {
      expect(runPrimary!, `runPrimary's ${action} branch does not do the thing`).toMatch(call);
      compared++;
    }
    expect(compared).toBe(3);
    // The two explicitly-tested actions must be named; 'start' is the
    // deliberate fallthrough (see runPrimary's own note), pinned instead by
    // the ResumeAction union count below.
    for (const named of ['proposals', 'resume']) {
      expect(runPrimary!, `runPrimary has no branch for ${named}`).toContain(`'${named}'`);
    }
    // ⚠ startOver, NOT begin: a `finished` session is still 'running' in the
    // database, so begin() here would orphan it exactly as "Start over" used
    // to. See runPrimary's own note.
    expect(runPrimary!, 'runPrimary starts a new interview without closing the old one').not.toMatch(/\bbegin\(\)/);
  });

  // ⚠ THE EXHAUSTIVENESS PIN, and it lives here rather than in runPrimary
  // because the fallthrough is deliberate. A FOURTH action added to the union
  // would land in runPrimary's "start" tail silently — a button reading
  // something new that starts an interview. This makes adding one a decision
  // somebody has to take in the open.
  it('ResumeAction still has exactly the three members the page handles — RED if a fourth is added and quietly inherits the start branch', () => {
    const MACHINE_SRC = readFileSync('src/lib/discoveryInterviewMachine.ts', 'utf8');
    const decl = /export type ResumeAction =([^;]+);/.exec(MACHINE_SRC);
    expect(decl, 'could not find the ResumeAction declaration').toBeTruthy();
    const members = [...decl![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(members).toEqual(['proposals', 'resume', 'start']);
  });

  it('it reads offer.primaryAction rather than re-deriving from offer.kind — RED if the label and the behaviour go back to being two separate decisions', () => {
    expect(runPrimary!).toContain('offer.primaryAction');
    expect(runPrimary!, 'runPrimary is branching on kind again').not.toContain('offer.kind');
  });

  it('the page hands the durable count to resumeOffer, as null when absent — RED if a session whose count could not be read is told it created nothing', () => {
    const offerDecl = /const offer = [^;]+;/.exec(PAGE_SRC);
    expect(offerDecl, 'could not find the `const offer = …` declaration').toBeTruthy();
    expect(offerDecl![0]).toMatch(/resumeOffer\(existing, progress, existing\?\.proposal_count \?\? null\)/);
    expect(offerDecl![0], 'an unknown count is being defaulted to zero').not.toMatch(/\?\?\s*0/);
  });

  // ── I2 · the outcome, on the page rather than in the module ────────────
  const reportDecl = /const report = [^;]+;/.exec(PAGE_SRC);
  const finishedBlock = conditionalRender(PAGE_SRC, /\{finished && report && \(/);

  it('the outcome declaration and its render block could both be isolated — RED if either extraction breaks', () => {
    expect(reportDecl, 'could not find the `const report = …` declaration').toBeTruthy();
    expect(finishedBlock, 'could not isolate the finished-interview render block').toBeTruthy();
    expect(finishedBlock!.length).toBeGreaterThan(400);
    expect(finishedBlock!).toContain('</PanelCard>');
  });

  it('the report is computed from the ENGINE\'S OWN emission — RED if it is hardcoded, defaulted, or built from anything the engine did not send', () => {
    expect(reportDecl![0]).toContain('outcomeReport(state.emission)');
    // A literal in that expression is the mutation that stayed green.
    expect(reportDecl![0], 'the report is being built from a literal').not.toMatch(/proposed\s*:/);
    expect(reportDecl![0], 'the report is being built from a literal').not.toMatch(/refused\s*:/);
  });

  it('both halves of the report actually reach the screen — RED if the sentence explaining WHICH nothing came back is computed and then not drawn', () => {
    expect(finishedBlock!).toContain('{report.headline}');
    expect(finishedBlock!).toContain('{report.body}');
    expect(finishedBlock!, 'the tone is computed and discarded').toContain('report.tone');
  });

  // ⚠ THIS ASSERTION HAD TO BE TIGHTENED, and the reason is worth recording.
  // Its first draft was `finishedBlock.toContain('report.hasProposals')`, and
  // the mutation `{report.hasProposals && (` → `{true && (` stayed GREEN —
  // because the same expression also appears a few lines below as the
  // secondary button's label ternary. A gate and a label that mention the same
  // field are indistinguishable to a substring match. So the GATE is extracted
  // and the assertion is made against what it wraps.
  const proposalsGate = finishedBlock ? conditionalRender(finishedBlock, /\{report\.hasProposals && \(/) : null;

  it('the route to the recommendations is GATED on there being some — RED if the guard is removed and an empty page is offered as a destination', () => {
    expect(proposalsGate, 'no `{report.hasProposals && (…)}` guard in the finished block').toBeTruthy();
    expect(proposalsGate!).toMatch(/setPage\?\.\('discovery_proposals'\)/);
    expect(proposalsGate!).toMatch(/See what we recommend/);
  });

  it('...and the other two controls sit OUTSIDE that guard — RED if a customer with nothing to review loses their way off the screen', () => {
    const outside = finishedBlock!.replace(proposalsGate!, '');
    expect(outside, 'no way to run the interview again').toMatch(/setState\(EMPTY_INTERVIEW\)/);
    expect(outside, 'no way back to the dashboard').toMatch(/setPage\?\.\('dashboard'\)/);
  });

  // ── I3 · the park dialog ──────────────────────────────────────────────
  const stopBlock = conditionalRender(PAGE_SRC, /\{stopOpen && \(/);

  it('the stop dialog is genuinely rendered, gated on stopOpen — RED if the render is deleted or its gate hardcoded false', () => {
    expect(stopBlock, 'no `{stopOpen && (…)}` render found — the park dialog is not on the page').toBeTruthy();
    expect(stopBlock!).toContain('<Modal');
    expect(stopBlock!).toContain('</Modal>');
    expect(stopBlock!.length).toBeGreaterThan(600);
  });

  // ⚠ MOVED INSIDE THE RENDER BLOCK. These two assertions used to read the
  // whole FILE, which is the scar tests/discovery-proposal-batching.test.ts
  // carries: a `.map` expression and a constant lookup survive the deletion of
  // the element that renders them, so a file-wide match proved nothing about
  // whether either was ever drawn.
  it('the dialog offers BOTH intents as real, separately-explained choices — RED if one of them stops being selectable', () => {
    expect(stopBlock!).toMatch(/\(\['parked', 'abandoned'\] as StopIntent\[\]\)\.map/);
    expect(stopBlock!).toContain('STOP_CONSEQUENCE[intent]');
    expect(stopBlock!).toContain('setStopIntent(intent)');
  });

  it('the dialog can be dismissed and can commit, and the commit sends the chosen intent — RED if the only way out of it is to reload', () => {
    expect(stopBlock!).toContain('setStopOpen(false)');
    expect(stopBlock!).toMatch(/void stop\(\)/);
    expect(stopBlock!).toContain('setStopNote');
  });
});

describe('park, on the page rather than in a comment', () => {
  const askLater = onClickForLabel(PAGE_SRC, 'Ask me later');

  it('the Ask me later control exists and its handler could be isolated — RED if park stops being a first-class action on the screen', () => {
    expect(askLater, 'no "Ask me later" button with an onClick was found on the page').toBeTruthy();
    expect(askLater!.length).toBeGreaterThan(10);
  });

  it('it sends the shared constant, not a re-typed sentence — RED if the button and the engine\'s park phrasing drift apart', () => {
    expect(askLater!).toContain('send(ASK_ME_LATER_TEXT)');
    expect(askLater!).not.toMatch(/send\('/);
  });

  it('Stop for now opens the choice rather than ending straight away — RED if one click abandons an interview with no confirmation', () => {
    const stopBtn = onClickForLabel(PAGE_SRC, 'Stop for now');
    expect(stopBtn, 'no "Stop for now" control found').toBeTruthy();
    expect(stopBtn!).toContain('setStopOpen(true)');
    expect(stopBtn!).not.toContain('stop()');
  });
});

describe('the no-AI-engine path does not dead-end', () => {
  // ⚠ parenSlice, NOT braceSlice. failureActions' body is JSX wrapped in
  // parentheses, so a brace walk stops at the end of its FIRST expression
  // container — three lines of a twenty-line render. The first draft of this
  // suite did exactly that and its "every failure keeps a way off the page"
  // case went red against a page that has one.
  const actions = parenSlice(PAGE_SRC, PAGE_SRC.indexOf('const failureActions = (f: InterviewFailure) =>') + 'const failureActions = (f: InterviewFailure) =>'.length);
  const goTo = braceSlice(PAGE_SRC, PAGE_SRC.indexOf('const goToAiEngine = () =>'));

  it('both blocks could be isolated, WHOLE — RED if the extraction breaks and the assertions below pass over a fragment', () => {
    expect(goTo, 'could not isolate goToAiEngine').toBeTruthy();
    expect(actions, 'could not isolate failureActions').toBeTruthy();
    // A fragment would still be truthy, so pin the shape: the slice must reach
    // the closing tag of the element it opens.
    expect(actions!).toContain('</div>');
    expect(actions!.length).toBeGreaterThan(400);
  });

  it('a failure with fix=ai_engine_settings renders a control that goes there — RED if the 503 becomes a banner with no way out', () => {
    expect(actions!).toMatch(/f\.fix === 'ai_engine_settings'/);
    expect(actions!).toContain('onClick={goToAiEngine}');
  });

  it('that control lands on the AI Engine tab, through the hand-off Settings already reads — RED if it dumps the customer on a generic Settings page', () => {
    expect(goTo!).toContain("localStorage.setItem('dt_settings_tab', 'ai_engine')");
    expect(goTo!).toContain("setPage?.('settings')");
  });

  it('every failure keeps a way off the page — RED if a customer can be trapped on a screen whose only action failed', () => {
    expect(actions!).toContain("setPage?.('dashboard')");
  });

  // ⚠ ALWAYS, not only on failure. Landing a new customer in an interview with
  // no way out is worse than the empty dashboard it replaces.
  it('the header carries a Skip control on every state of the page — RED if the only exit is conditional', () => {
    const headerAt = PAGE_SRC.indexOf('<PageHeaderV2');
    const actionsAt = PAGE_SRC.indexOf('actions={', headerAt);
    const headerActions = braceSlice(PAGE_SRC, actionsAt + 'actions='.length);
    expect(headerActions, 'could not isolate the page header actions').toBeTruthy();
    expect(headerActions!).toContain('Skip for now');
    expect(headerActions!).toContain("setPage?.('dashboard')");
  });
});

describe('the tenant boundary — the client never supplies its own tenant', () => {
  // ⚠ The engine's auth block TRUSTS body.tenant_id outright on the service-key
  // branch. The browser is never that caller, and a habit of passing the
  // parameter is how it ends up passed on a branch that trusts it — the exact
  // shape migrations 662-664 and 749 exist to close.
  const bodies = edgeBodies(stripComments(API_SRC), 'discovery-interview');

  it('all three request bodies could be isolated — RED if the extraction breaks and the assertion below inspects nothing', () => {
    expect(bodies, `expected 3 discovery-interview request bodies, found ${bodies.length}`).toHaveLength(3);
    for (const b of bodies) expect(b).toMatch(/action:/);
  });

  it('no tenant_id is sent in any interview call — RED if one appears in a request body', () => {
    for (const b of bodies) expect(b, `body ${b}`).not.toMatch(/tenant_id/);
  });

  // ⚠ NARROWED TO THE BODIES ON PURPOSE, and this case says why. The file
  // legitimately contains `tenant_id` — the session READ is `.eq('tenant_id',
  // tenantId)`, which is a query narrowing under RLS and has nothing to do with
  // the edge function's auth. A file-wide assertion was the first draft, and it
  // went red on correct code; widening the rule to the whole file would have
  // meant deleting a correct filter to satisfy a test.
  it('...and the file DOES use tenant_id elsewhere, so the assertion above is genuinely narrow rather than trivially true', () => {
    expect(stripComments(API_SRC)).toContain("eq('tenant_id', tenantId)");
  });

  it('the comment-stripper is doing real work — RED if it returns everything, or nothing, and the cases above become meaningless', () => {
    const code = stripComments(API_SRC);
    expect(code).toContain('invokeEdge');
    expect(code.length).toBeGreaterThan(600);
    // The header discusses tenant_id at length; that prose must be gone while
    // the code above survives.
    expect(code).not.toContain('THE CALLER IS THE SIGNED-IN HUMAN');
  });

  it('the session read is still tenant-narrowed and deterministically ordered — RED if "your last interview" starts changing between page loads', () => {
    const code = stripComments(API_SRC);
    expect(code).toContain(".from('discovery_sessions')");
    expect(code).toMatch(/\.order\('updated_at', \{ ascending: false \}\)/);
    expect(code).toMatch(/\.order\('id', \{ ascending: false \}\)/);
  });

  // ⚠ THE DURABLE HALF OF THE OUTCOME. The engine's emission rides back on ONE
  // response and is never persisted — emitProposals counts refusals in a local
  // and writes no row for them — so after a reload the ONLY recoverable fact
  // about what an interview produced is how many proposals it left behind.
  // Before this, `getLatestInterviewSession` read none of that, so the
  // explanation of what came out of an interview survived exactly one page
  // load and was unrecoverable afterwards.
  const countFn = braceSlice(API_SRC, API_SRC.indexOf('async function countSessionProposals'));

  it('the count function could be isolated — RED if the extraction breaks and the cases below pass over nothing', () => {
    expect(countFn, 'could not isolate countSessionProposals').toBeTruthy();
    expect(countFn!.length).toBeGreaterThan(120);
  });

  it('the outcome is re-read from discovery_proposals, tenant- and session-narrowed — RED if it starts counting another workspace\'s proposals, or every session\'s', () => {
    expect(countFn!).toContain(".from('discovery_proposals')");
    expect(countFn!).toMatch(/count:\s*'exact'/);
    expect(countFn!).toMatch(/\.eq\('tenant_id', tenantId\)/);
    expect(countFn!).toMatch(/\.eq\('session_id', sessionId\)/);
  });

  // ⚠ A FAILED COUNT IS NOT A COUNT OF ZERO. resumeOffer renders "it wrote up
  // nothing" for a zero — a manufactured fact when what happened is that we
  // did not manage to look. Same rule outcomeReport(null) already follows.
  it('a failed count returns null, never 0, and never takes the page down — RED if "we could not check" is rendered as "nothing was created"', () => {
    expect(countFn!).toMatch(/if \(error \|\| typeof count !== 'number'\) return null;/);
    expect(countFn!, 'a secondary count failure now throws over a session that read fine').not.toContain('throw');
    expect(countFn!, 'a failed count degrades to zero').not.toMatch(/return 0/);
  });

  it('the session read actually attaches it — RED if the count is computed and the offer never sees it', () => {
    const code = stripComments(API_SRC);
    expect(code).toMatch(/proposal_count:\s*await countSessionProposals\(row\.id, tenantId\)/);
  });
});

describe('drift guards — this client\'s copy of the engine contract', () => {
  // The edge function cannot be imported (Node's ESM loader rejects its https:
  // imports before any of its code runs), so its SOURCE is the oracle — the
  // same technique tests/discovery-proposal-batching.test.ts uses.

  it('the three actions still have the names this client sends — RED if the engine renames one and the page silently 400s', () => {
    expect(ENGINE_SRC).toContain("action !== 'start' && action !== 'answer' && action !== 'end'");
    for (const a of ['start', 'answer', 'end']) {
      expect(stripComments(API_SRC), `action ${a}`).toContain(`action: '${a}'`);
    }
  });

  it('every response field outcomeReport reads still exists in the engine — RED if a rename turns an honest report into silence', () => {
    let compared = 0;
    for (const field of ['proposed', 'refused', 'skipped_already_proposed', 'model_fill']) {
      expect(ENGINE_SRC, `EmitProposalsResult.${field}`).toMatch(new RegExp(`${field}\\s*:`));
      compared++;
    }
    for (const v of ['not_needed', 'ran', 'skipped_no_llm', 'skipped_ai_budget']) {
      expect(ENGINE_SRC, `ModelFillOutcome value ${v}`).toContain(`'${v}'`);
      compared++;
    }
    expect(compared).toBe(8);
  });

  it('the end response still carries owed and resume_hint — RED if the honest half of "we stopped" disappears', () => {
    expect(ENGINE_SRC).toMatch(/owed_count:\s*owed\.length/);
    expect(ENGINE_SRC).toContain('previous_status');
    expect(ENGINE_SRC).toMatch(/p_resume_hint:\s*resumeHint/);
  });

  // ⚠ THE ORDERING THIS CLIENT MAKES A PROMISE ABOUT. startFailure's
  // llm_not_configured branch tells the customer "nothing is half-finished",
  // and that is only true because the engine checks for a provider BEFORE it
  // creates a session. If those two ever swap, the sentence becomes a lie and
  // a stray unreachable session is left behind.
  it('start still checks for an AI engine BEFORE creating a session — RED if the order flips and the 503 message becomes false', () => {
    const startBlock = braceSlice(ENGINE_SRC, ENGINE_SRC.indexOf("if (action === 'start')"));
    expect(startBlock, 'could not isolate the start action block').toBeTruthy();
    const providerAt = startBlock!.indexOf('hasLLMProvider');
    const createAt = startBlock!.indexOf('start_discovery_session');
    expect(providerAt, 'start no longer checks hasLLMProvider at all').toBeGreaterThan(-1);
    expect(createAt, 'start no longer creates a session — the extraction is wrong').toBeGreaterThan(-1);
    expect(providerAt).toBeLessThan(createAt);
    expect(startBlock!).toContain("'llm_not_configured'");
  });

  it('the suspended-workspace sentence is still the shared one — RED if this client starts inventing its own billing copy', () => {
    expect(TENANT_STATUS_SRC).toContain("error: 'tenant_suspended'");
    const detail = TENANT_STATUS_SRC.match(/detail:\s*'([^']+)'/)?.[1];
    expect(detail, 'could not read the shared suspended detail').toBeTruthy();
    expect(startFailure('tenant_suspended', detail!).message).toBe(detail);
  });

  // ⚠ THE FACT THE WHOLE RESUME STORY RESTS ON. If a reopen path is ever
  // added, resumeOffer's "cannot be picked up" becomes wrong in the pessimistic
  // direction — which is the good direction, but it should be noticed.
  it('nothing moves a session back to running, so a parked one really cannot resume — RED if a reopen path appears and the copy is not revisited', () => {
    const migration = readFileSync('supabase/migrations/739_an_interview_that_can_end.sql', 'utf8');
    expect(migration).toContain("p_status not in ('parked', 'abandoned')");
    expect(migration).toMatch(/v_status <> 'running' and v_status <> p_status/);
    // The engine refuses another answer on a non-running session.
    expect(ENGINE_SRC).toMatch(/if \(session\.status !== 'running'\)[\s\S]{0,160}session_not_running/);
  });
});
