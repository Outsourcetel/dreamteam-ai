// ============================================================================
// serviceCaller.ts — is this caller the platform itself?
//
// WHY THIS EXISTS. Thirteen edge functions authenticated a service caller with
//
//     bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
//
// a string equality against ONE env var that the PLATFORM owns and rotates.
// Supabase rotated it on 2026-08-18 at 08:57 UTC — together with
// SUPABASE_ANON_KEY, SUPABASE_JWKS, SUPABASE_URL, SUPABASE_DB_URL and the two
// new plural secrets — and every service call holding the previous key began
// returning `401 unauthorized: user JWT required`. The key those callers held
// was NOT invalid: it is still `role: service_role`, unexpired, and PostgREST
// accepts it today. It simply stopped being STRING-EQUAL to the one variable
// the check looked at.
//
// That is the defect. An identity check should ask "is this a service
// credential for this project", not "is this byte-identical to the single
// value I happen to have been handed". The failure is silent, arrives without
// a deploy, and reads exactly like a code bug — the worst combination.
//
// ⚠ WHAT THIS DOES NOT DO, deliberately: it does not widen the boundary. It
// compares against credentials the PLATFORM gave this function and nothing
// else. It cannot be satisfied by a user JWT, by a publishable/anon key, or by
// any value not present in one of the trusted variables below. Adding more
// known-good keys to compare against is not the same as accepting more
// callers, and the difference is the whole security argument.
//
// ⚠ SUPABASE_SECRET_KEYS IS THE NEW, PLURAL FORMAT and nothing in this repo
// read it before today. Its exact encoding is not documented here because this
// module never logs or inspects its VALUE — only whether the bearer matches an
// entry. parseKeys handles the three shapes the platform is known to use (a
// JSON array of strings, a JSON array of objects carrying `api_key`/`key`, and
// a separated list) and ignores anything it cannot read, so an unrecognised
// encoding degrades to "no extra keys" rather than to an exception on a hot
// auth path.
// ============================================================================

/** Constant-time compare. Bearer equality is an auth decision, and `===` on
 *  strings short-circuits at the first differing byte. The leak is small and
 *  the fix is three lines, so there is no reason to leave it. Length is
 *  compared first and unavoidably leaks length, which is not secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Never treat a trivially short or absent value as a credential: an empty env
 *  var must not make an empty Authorization header a valid service call. */
const USABLE = (v: string | undefined | null): v is string => typeof v === 'string' && v.trim().length >= 20;

function parseKeys(raw: string | undefined): string[] {
  if (!USABLE(raw)) return [];
  const out: string[] = [];
  const t = raw.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : [j];
      for (const e of arr) {
        if (typeof e === 'string') out.push(e);
        else if (e && typeof e === 'object') {
          for (const f of ['api_key', 'key', 'secret', 'value']) {
            const v = (e as Record<string, unknown>)[f];
            if (typeof v === 'string') { out.push(v); break; }
          }
        }
      }
    } catch { /* unreadable encoding degrades to no extra keys — never throws */ }
  }
  if (out.length === 0) for (const p of t.split(/[,\s]+/)) if (p) out.push(p);
  return out.filter(USABLE);
}

export type ServiceCallerVerdict =
  | { service: true }
  | { service: false; looksLikeStaleServiceKey: boolean };

/**
 * Is this bearer a service credential issued to THIS project?
 *
 * `looksLikeStaleServiceKey` exists so the 401 can say something true. A caller
 * holding a genuine but rotated service key gets a message naming that, rather
 * than "user JWT required" — which sent one engineer looking for a code bug for
 * an hour on 2026-08-18. It is derived from the token's own unverified
 * `role` claim and is used ONLY to choose wording; it never grants anything.
 */
export function serviceCaller(bearer: string): ServiceCallerVerdict {
  if (!USABLE(bearer)) return { service: false, looksLikeStaleServiceKey: false };

  const trusted = [
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    ...parseKeys(Deno.env.get('SUPABASE_SECRET_KEYS')),
  ].filter(USABLE);

  for (const k of trusted) if (timingSafeEqual(bearer, k)) return { service: true };

  let stale = false;
  const parts = bearer.split('.');
  if (parts.length === 3) {
    try {
      const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)));
      stale = claims?.role === 'service_role';
    } catch { stale = false; }
  }
  return { service: false, looksLikeStaleServiceKey: stale };
}

/** The message a rotated-key caller should see instead of "user JWT required". */
export const STALE_SERVICE_KEY_DETAIL =
  'this is a service_role token, but it is not one of the service credentials currently issued to this project — '
  + 'the platform rotates SUPABASE_SERVICE_ROLE_KEY without a deploy, so a locally stored copy goes stale silently. '
  + 'Refresh it from the project settings; the token itself is not invalid, it is simply no longer this project\'s.';
