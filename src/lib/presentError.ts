// ============================================================================
// presentError — the one way a caught error becomes words a customer reads.
//
// ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
// Measured 2026-08-22: 125 call sites do `setSomething(e.message)` with the
// error straight out of a catch. When that error came from `.rpc()` or
// `.from()` it is a PostgrestError, and `.message` is raw Postgres:
//
//     column "de_id" of relation "human_tasks" does not exist
//     permission denied for table knowledge_docs
//     Could not find the function public.decide_human_tasks(...) in the schema cache
//
// Those reach the screen verbatim. They name our tables, leak our schema, and
// tell a customer nothing they can act on. On the same surfaces a migration
// filename was being shown as an instruction (fixed the same day), so this is
// the second half of one problem: the product talking to itself in front of a
// customer.
//
// ── THE RULE THAT MAKES THIS SAFE ──────────────────────────────────────────
// A GOVERNED REFUSAL IS NOT AN ERROR TO BE TRANSLATED. This product's whole
// pitch is that it declines things and says why, and CLAUDE.md records "a
// governed refusal reported to the user as success" as a defect this repo has
// already paid for. Replacing "This employee isn't cleared to work billing"
// with "Something went wrong" would be the same defect in a politer voice.
//
// So the split is by SQLSTATE, not by taste:
//
//   P0001 / P0002 / 23514   a plain `raise exception` or CHECK — how every
//                           governed refusal in this schema is delivered.
//                           PASSED THROUGH VERBATIM, always.
//   42501, 42P01, 42883,
//   PGRST*, 23505, 57014,   infrastructure. The customer cannot act on the
//   08*, 53*                text and should not see it. Translated.
//
// This generalises the shape already proven in src/lib/ssoApi.ts's rpcFailure,
// which got this right for one feature and was never lifted out.
//
// ── NOTHING IS EVER LOST ───────────────────────────────────────────────────
// Every translated error is console.error'd with its code and original text, so
// a developer or support engineer still has the diagnosis. Translating for the
// screen and discarding for the log would trade one failure for another.
// ============================================================================

/** Shapes we may be handed. Deliberately loose: it is a `catch` binding. */
interface ErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  name?: unknown;
  body?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const asRecord = (e: unknown): ErrorLike => (e && typeof e === 'object' ? e as ErrorLike : {});
/** An edge function's response body is arbitrary JSON, not an ErrorLike — it
 *  gets its own loose accessor so reading `detail` off it cannot be confused
 *  with PostgrestError's `details`. (Those two nearly-identical names were a
 *  real type error here before `strict`'s function-type flags were on.) */
const asBag = (e: unknown): Record<string, unknown> => (e && typeof e === 'object' ? e as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** SQLSTATEs that carry a deliberate, human-authored refusal. Never rewritten. */
const GOVERNED = new Set(['P0001', 'P0002', '23514']);

/** Infra codes → a sentence the reader can act on. */
const TRANSLATIONS: Array<[RegExp, string]> = [
  [/^(PGRST202|PGRST205|42883|42P01|42703)$/,
   'This feature is not available in this workspace yet. Nothing was changed — contact support and we can switch it on.'],
  [/^42501$/,
   "You don't have permission to do that. A workspace owner or administrator can, or can grant it to you."],
  [/^23505$/,
   'That already exists. Nothing was changed.'],
  [/^23503$/,
   'That refers to something which no longer exists. Refresh the page and try again.'],
  [/^(57014|55P03)$/,
   'That took too long and was stopped before anything changed. Try again, or narrow what you asked for.'],
  [/^(08000|08003|08006|08001|08004|53300|53400)$/,
   'We could not reach the service. Nothing was changed — try again in a moment.'],
  [/^PGRST301$/,
   'Your session has expired. Sign in again and repeat that last step.'],
];

const GENERIC = 'Something went wrong and nothing was changed. Try again — if it keeps happening, contact support.';

/** Raw text that must never reach a customer even when no code is present. */
const LOOKS_INTERNAL = /(relation|column|function|schema cache|constraint|violates|syntax error at|permission denied for (table|schema|function)|pg_|PGRST|SQLSTATE|duplicate key value|null value in column)/i;

// ── The transport layer, which has no SQLSTATE ─────────────────────────────
// postgrest-js returns a PLAIN OBJECT (not a PostgrestError, and so not an
// Error) for fetch failures — PostgrestBuilder.ts:443-450 — with `code: ''`.
// A thrown TypeError from fetch has no code either. Neither reaches the code
// table above, and "TypeError: Failed to fetch" contains no internal-looking
// word, so without this it falls through to step 5 and is shown verbatim.
//
// That is a REGRESSION THIS FILE INTRODUCED and tests 14-16 caught: the sites
// converted to presentError previously read
//     setErr(e instanceof Error ? e.message : 'Could not save changes.')
// and the plain-object case fell to the author's fallback, so the user read a
// sentence. Handing them a browser exception string instead is not an
// improvement on the thing it replaced.
const NETWORK = /(failed to fetch|networkerror|network request failed|load failed|fetcherror|err_(network|internet|connection)|connection (refused|reset|closed)|socket hang up|econnrefused|etimedout|enotfound)/i;
const ABORTED = /(aborted|abortsignal|the operation was aborted|timeouterror|signal timed out)/i;

const NETWORK_SENTENCE = 'We could not reach the service. Nothing was changed — check your connection and try again.';
const ABORTED_SENTENCE = 'That took too long and was stopped before anything changed. Try again.';

/**
 * Turn any caught value into a sentence fit for a customer's screen.
 *
 * @param e        the caught value — anything
 * @param fallback what to say when nothing better can be derived
 */
export function presentError(e: unknown, fallback: string = GENERIC): string {
  const r = asRecord(e);
  const code = str(r.code);
  const message = str(r.message);

  // 1. A governed refusal is the answer, not an error. Verbatim, always.
  if (GOVERNED.has(code) && message) return message;

  // 2. An edge function's own refusal already passed through invokeEdge, which
  //    lifts `detail`/`error` out of the response body into the message. Those
  //    are authored for a reader, so they pass through too — but only when the
  //    text does not look like internals leaking from a deeper layer.
  const body = asBag(r.body);
  const bodyRefusal = str(body.detail) || str(body.error);
  if (bodyRefusal && !LOOKS_INTERNAL.test(bodyRefusal)) return bodyRefusal;

  // 3. Known infrastructure codes get a sentence, and the original goes to the
  //    console so nothing is lost.
  if (code) {
    for (const [pattern, sentence] of TRANSLATIONS) {
      if (pattern.test(code)) {
        console.error(`[presentError] ${code}: ${message}${str(r.details) ? ` | ${str(r.details)}` : ''}`);
        return sentence;
      }
    }
  }

  // 4. The transport failed. Checked BEFORE the internals filter and before the
  //    plain-message path, because these carry no code and no internal-looking
  //    word — they would otherwise be shown verbatim as a browser exception.
  //    `name` is checked too: a DOMException from AbortSignal.timeout() has the
  //    reason in its name rather than its message.
  const name = str(r.name);
  if (ABORTED.test(name) || ABORTED.test(message)) {
    console.error(`[presentError] aborted: ${name}${message ? ` — ${message}` : ''}`);
    return ABORTED_SENTENCE;
  }
  if (NETWORK.test(message) || NETWORK.test(name)) {
    console.error(`[presentError] network: ${message || name}`);
    return NETWORK_SENTENCE;
  }

  // 5. No code, but the text reads like our internals. Do not show it.
  if (message && LOOKS_INTERNAL.test(message)) {
    console.error(`[presentError] internal-looking message withheld: ${message}`);
    return fallback;
  }

  // 6. A plain Error someone wrote for a person (thrown by our own client code,
  //    an EdgeFunctionError message, a validation string). Show it.
  if (message) return message;

  // 7. Sometimes it is a bare string, or an OAuth-style body.
  if (typeof e === 'string' && e.trim() && !LOOKS_INTERNAL.test(e)) return e.trim();
  const oauth = str(r.error_description) || str(r.error);
  if (oauth && !LOOKS_INTERNAL.test(oauth)) return oauth;

  if (e !== undefined && e !== null) console.error('[presentError] unrecognised error value:', e);
  return fallback;
}

/** True when the value is a deliberate, human-authored refusal rather than a
 *  fault — for callers that render the two differently (a refusal is an answer
 *  and belongs in the flow; a fault belongs in an error banner). */
export function isGovernedRefusal(e: unknown): boolean {
  return GOVERNED.has(str(asRecord(e).code));
}
