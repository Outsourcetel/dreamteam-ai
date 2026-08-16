// discoveryInterviewApi.ts — the ONLY place in the product that calls the
// `discovery-interview` edge function.
//
// ⚠ WHAT THIS FILE FIXES. Before it, `grep -rn "discovery-interview" src/`
// returned three hits and all three were COMMENTS. The engine was complete,
// deployed and exercised only by a scratch script holding the service key: no
// customer could reach it, because nothing in the product ever invoked it.
//
// ── THE CALLER IS THE SIGNED-IN HUMAN, AND NO TENANT ID IS SENT ──────────
// The function's auth block takes two shapes. A caller presenting the SERVICE
// KEY (or the dispatch secret) MUST pass `tenant_id`, and that parameter is
// then trusted outright. A caller presenting a USER JWT gets its tenant
// resolved from `profiles` via resolveTenantWithRemoteAccess.
//
// The browser is always the second kind, so `tenant_id` is never in a body
// here. Sending one from the client would be the exact "a tenant-id parameter
// IS authorisation" shape migrations 662-664 and 749 exist to close: on the
// service-key branch it is the whole authorisation, and a habit of passing it
// is how it ends up passed on a branch that trusts it.
//
// ── ERRORS ARE RETURNED, NOT THROWN ─────────────────────────────────────
// Same reasoning as discoveryApi.ts's DecisionOutcome. The screen has to put a
// reason next to the control the person was using, and a thrown error loses
// which call it was about. Every function below answers with a discriminated
// union, and the CODE — the engine's own `error` string, verbatim — rides
// alongside the friendly sentence so callers branch on the code and never on
// the wording.
import { invokeEdge, EdgeFunctionError } from './invokeEdge';
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import type {
  AnswerResponse, EndResponse, StartResponse, InterviewFailure, StopIntent, InterviewPhase,
} from './discoveryInterviewMachine';
import { startFailure } from './discoveryInterviewMachine';

/**
 * ⚠ THE DISCRIMINANT IS A STRING, NOT `ok: true | false`, AND THAT IS
 * MEASURED RATHER THAN STYLISTIC. This repo's tsconfig sets `strict: false`,
 * so `strictNullChecks` is off — and with it off TypeScript does NOT narrow a
 * BOOLEAN-literal discriminant to its `false` member. `if (!res.ok)
 * res.failure` is a compile error here, on correct code, which is how the
 * first draft of this file was found. (Proven against `tsc --strict false`
 * before changing it, not assumed.)
 *
 * A boolean union would therefore have pushed every call site into either
 * `res.ok === false` — a spelling nobody writes twice in a row — or optional
 * `data?`/`failure?` fields, which is the shape where "success with no data"
 * becomes representable and silently true. A string discriminant narrows in
 * both directions under this compiler, so `data` and `failure` can each be
 * REQUIRED on exactly the branch that has one.
 */
export type InterviewResult<T> =
  | { outcome: 'ok'; data: T }
  | { outcome: 'failed'; failure: InterviewFailure };

/**
 * Pull the engine's own refusal code out of whatever came back.
 *
 * ⚠ `invokeEdge` ALREADY READ THE BODY, which is why this can be honest. A
 * bare `supabase.functions.invoke` surfaces only "Edge Function returned a
 * non-2xx status code" and the function's own `{ok:false, error, detail}` is
 * lost inside an unread Response — so every one of the branches in
 * `startFailure` would collapse into the generic one and the 503 would render
 * as a shrug. invokeEdge reads the body once and hangs it on the error.
 *
 * ⚠ A NULL CODE IS NOT AN UNKNOWN CODE. When the request never reached the
 * function (a dead network, a gateway 401 on an expired token) there IS no
 * code, and inventing one would make a transport failure look like a decision
 * the engine took. null falls to the generic branch, which says exactly that.
 *
 * ⚠ THE PHASE IS PASSED, ALWAYS. The engine emits `llm_not_configured` from
 * BOTH the start path (index.ts:745, before any session exists) and the answer
 * path (index.ts:858, with a live session and recorded coverage behind it), and
 * the true sentence differs. Every call below names its own phase rather than
 * taking the default, so a new caller has to make the same decision out loud.
 */
function failureFrom(err: EdgeFunctionError, phase: InterviewPhase): InterviewFailure {
  const body = err.body ?? {};
  const code = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : null;
  const detail = typeof body.detail === 'string' ? body.detail : err.message;
  return startFailure(code, detail, phase);
}

/**
 * Begin a new interview.
 *
 * ⚠ THIS IS THE CLEAN-REFUSAL PATH. `start` checks `hasLLMProvider` BEFORE
 * calling `start_discovery_session`, precisely so a workspace with no usable
 * AI engine does not end up holding a stray session it could never continue.
 * So the refusal really is clean — nothing was created — and `startFailure`'s
 * llm_not_configured branch is allowed to say "nothing is half-finished" on
 * THIS phase, because that is a property of the engine rather than a hope.
 *
 * ⚠ AND THE PREMISE THAT WAS WRONG, corrected 2026-08-17. This header used to
 * present the 503 as the path a brand-new workspace would take, because a new
 * workspace has no AI engine key of its own. It does not need one:
 * `resolve_llm_keys` falls back to the PLATFORM key unless the workspace is
 * explicitly in `byo` mode (migration 576:71-96), and production carries a
 * platform key. The 503 is a real and handled path; it is not the common one.
 */
export async function startInterview(): Promise<InterviewResult<StartResponse>> {
  const { data, error } = await invokeEdge<StartResponse>('discovery-interview', {
    body: { action: 'start' },
  });
  if (error) return { outcome: 'failed', failure: failureFrom(error, 'start') };
  if (!data?.session_id || typeof data.question !== 'string') {
    return {
      outcome: 'failed',
      failure: startFailure(null, 'the interview started but did not send back a first question', 'start'),
    };
  }
  return { outcome: 'ok', data };
}

/** Send the customer's answer and get the next question — or `question: null`
 *  and `done: true` when the spine has closed, in which case `proposals` rides
 *  back on the same response. */
export async function answerInterview(sessionId: string, text: string): Promise<InterviewResult<AnswerResponse>> {
  const { data, error } = await invokeEdge<AnswerResponse>('discovery-interview', {
    body: { action: 'answer', session_id: sessionId, text },
  });
  if (error) return { outcome: 'failed', failure: failureFrom(error, 'answer') };
  if (!data || typeof data.done !== 'boolean') {
    return { outcome: 'failed', failure: startFailure(null, 'the interview answered in a shape this screen could not read', 'answer') };
  }
  return { outcome: 'ok', data };
}

/**
 * Stop the conversation — the ONLY path out of 'running'.
 *
 * ⚠ BOTH STATUSES ARE REAL AND THE DIFFERENCE IS KEPT. 'parked' means the
 * customer means to come back; 'abandoned' means they do not. Migration 739's
 * own probes assert the two land differently, and §7 refuses to collapse them.
 * The caller passes the customer's intent, never a default that quietly makes
 * every stop look like a park.
 *
 * ⚠ IT ALSO WRITES UP WHAT WAS HEARD. `end` runs emitProposals for a session
 * that was genuinely running, so stopping is how a partially-answered
 * interview turns into something the customer can actually look at. Leaving
 * the page instead produces nothing at all — which is why the screen offers
 * this rather than only a Back button.
 */
export async function endInterview(
  sessionId: string,
  status: StopIntent,
  resumeHintText: string | null,
): Promise<InterviewResult<EndResponse>> {
  const { data, error } = await invokeEdge<EndResponse>('discovery-interview', {
    body: {
      action: 'end',
      session_id: sessionId,
      status,
      ...(resumeHintText ? { resume_hint: resumeHintText } : {}),
    },
  });
  if (error) return { outcome: 'failed', failure: failureFrom(error, 'end') };
  if (!data?.session_id) {
    return { outcome: 'failed', failure: startFailure(null, 'the interview did not confirm that it stopped', 'end') };
  }
  return { outcome: 'ok', data };
}

// ── reading a session back, so "come back later" means something ──────────

export interface InterviewSessionRow {
  id: string;
  status: 'running' | 'proposed' | 'accepted' | 'parked' | 'abandoned';
  coverage: Record<string, { state: string; evidence: string | null }>;
  transcript: Array<{ role: string; text: string; at?: string }>;
  resume_hint: string | null;
  created_at: string;
  updated_at: string;
  /**
   * How many proposals this session actually wrote — counted from
   * `discovery_proposals`, NOT a column on this row.
   *
   * ⚠ THIS IS THE ONLY DURABLE PART OF THE OUTCOME, and saying which part is
   * the whole point. The engine's emission carries `proposed`, `refused`,
   * `model_fill` and `skipped_already_proposed` on ONE response and nothing
   * persists three of them: a refused draft is counted in memory and dropped
   * without a row (emitProposals' `keepOrRefuse` increments a local and logs),
   * so after a reload there is no way, anywhere, to learn that 12 drafts were
   * refused or that the model fill never ran. Only the survivors exist. This
   * count is therefore an honest floor on the outcome and never a substitute
   * for `outcomeReport` — see resumeOffer's header for how the two are split.
   *
   * `null` when the count could not be taken. Not zero: "we did not ask" and
   * "the answer was none" are different facts and the offer says different
   * things for each.
   */
  proposal_count: number | null;
}

/**
 * The most recently touched session for this workspace, whatever state it is
 * in — so the screen can offer the right thing rather than always offering
 * "start".
 *
 * ⚠ NOT FILTERED TO 'running', deliberately. `resumeOffer` needs to tell a
 * continuable session apart from a closed one and say two different true
 * things; filtering here would hide the closed case and the screen would
 * silently offer a fresh start to somebody who had parked one an hour ago
 * with a note explaining where they got to.
 *
 * ⚠ READ, NEVER WRITTEN, FROM THE BROWSER. Migration 737 grants
 * `authenticated` SELECT on discovery_sessions under a tenant-scoped policy
 * and REVOKEs insert/update/delete outright — the interview is driven
 * server-side and this client holds no opinion about that.
 */
export async function getLatestInterviewSession(): Promise<InterviewSessionRow | null> {
  const tenantId = await getSessionTenantId();
  if (!tenantId) {
    throw new CustomerApiError(
      'This is a live-workspace screen — sign into your live workspace to run the setup interview.',
      false,
    );
  }
  const { data, error } = await supabase
    .from('discovery_sessions')
    .select('id, status, coverage, transcript, resume_hint, created_at, updated_at')
    // ⚠ The tenant filter is a NARROWING, not the boundary. RLS
    // (discovery_sessions_tenant_read) is what actually stops a cross-workspace
    // read; this only keeps the query honest about what it wants.
    .eq('tenant_id', tenantId)
    // ⚠ A TOTAL ORDER HAS TO BE TOTAL. `updated_at` alone can tie — two rows
    // touched in the same millisecond by the same request would come back in
    // an arbitrary order, so "your last interview" would change between page
    // loads. `id` breaks the tie deterministically, the same rule
    // src/lib/connectorSelection's own header states and the same fix
    // acceptConnectorProposal already carries.
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  const row = data && data.length > 0 ? (data[0] as InterviewSessionRow) : null;
  if (!row) return null;
  return { ...row, proposal_count: await countSessionProposals(row.id, tenantId) };
}

/**
 * How many proposals a session wrote, read back from the table.
 *
 * ⚠ A FAILED COUNT RETURNS null, NOT 0, AND DOES NOT THROW. This is a
 * secondary fact about a session the caller has already successfully read —
 * turning a count failure into a page-level error would replace a working
 * screen with a red banner over a detail. And returning 0 would be worse than
 * either: `resumeOffer` renders "it wrote up nothing" for a zero, which is a
 * manufactured fact when what actually happened is that we did not manage to
 * look. The same rule `outcomeReport(null)` follows.
 *
 * `head: true` means no rows cross the wire — PostgREST answers with the
 * count in the Content-Range header alone.
 */
async function countSessionProposals(sessionId: string, tenantId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('discovery_proposals')
    .select('id', { count: 'exact', head: true })
    // Same narrowing-not-boundary rule as above: discovery_proposals_tenant_read
    // is what actually stops a cross-workspace count.
    .eq('tenant_id', tenantId)
    .eq('session_id', sessionId);
  if (error || typeof count !== 'number') return null;
  return count;
}
