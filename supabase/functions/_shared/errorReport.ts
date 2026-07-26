// ============================================================
// errorReport.ts — make edge function crashes visible.
//
// Before this, a crash in any of the 56 edge functions produced a console.error
// in the Supabase function log and nothing else. That log has short retention
// and nobody reads it unless they already suspect a problem, so the business
// logic — answering customers, running the work engine, writing back to CRMs —
// failed silently. The frontend has real Sentry reporting; the backend had none.
//
// BEST-EFFORT BY CONTRACT, exactly like otel.ts: reporting an error must never
// itself throw, and must never change the response the caller gets. If the
// report fails we are already in a failure path — making it worse helps nobody.
//
// The dedupe lives SERVER-side in report_edge_error (mig 368), not here: 56
// copies of a rate-limiting rule is 56 chances for one to be wrong, and a
// reporting path that floods ops_alerts during an outage is its own incident.
// ============================================================
// deno-lint-ignore-file no-explicit-any

/**
 * Record an edge function failure as an ops_alert. Never throws.
 *
 * @param fnName  the function's own name, e.g. 'de-answer'
 * @param err     the caught error
 * @param context anything that helps diagnose it — ids, not payloads (see below)
 * @param tenantId optional tenant the failure belongs to
 */
export async function reportEdgeError(
  fnName: string,
  err: unknown,
  context: Record<string, unknown> = {},
  tenantId?: string | null,
): Promise<void> {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;

    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? null : null;

    // Called over PostgREST rather than through a supabase-js client so this
    // helper stays dependency-free and can be imported by any function without
    // caring how that function builds its own client.
    await fetch(`${url}/rest/v1/rpc/report_edge_error`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        p_function: fnName,
        p_message: message,
        p_detail: {
          ...context,
          // Truncated: a stack is for locating the fault, and an unbounded one
          // bloats every alert row.
          stack: stack ? stack.slice(0, 2000) : null,
        },
        p_tenant: tenantId ?? null,
      }),
      // Do not let a hanging reporter hold the function open past its deadline.
      signal: AbortSignal.timeout(5000),
    });
  } catch (reportErr) {
    // Deliberately swallowed — see the contract above. Logged so a reporting
    // outage is at least discoverable from the function log.
    console.error(`reportEdgeError failed for ${fnName}:`, reportErr);
  }
}

// A note on what NOT to put in `context`:
// These alerts are readable by platform admins across every tenant. Pass IDs
// (conversation_id, de_id, task_id) — never message bodies, customer text,
// credentials, or anything from a request payload. An error reporter that
// quietly becomes a cross-tenant data channel is worse than no reporter.
