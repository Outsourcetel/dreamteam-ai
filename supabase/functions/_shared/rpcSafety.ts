/**
 * rpcSafety — make a failed database call impossible to mistake for a result.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * supabase-js `.rpc()` RESOLVES on a Postgres error. It does not throw. So:
 *
 *     const { data } = await admin.rpc('record_action_execution', {...});
 *     // data is null, execution continues, caller is told the action is logged
 *
 * A scan of the edge functions found 214 of 294 call sites discarding `error`,
 * including the entire action gate: record_action_execution (5 sites, NONE
 * checked), decide_action_execution, claim_gated_action_execution, and 17 of
 * 26 append_audit_event calls.
 *
 * This is not theoretical. It has produced three separate live defects:
 *   · migs 554-558 — a feature broken in four places; draft_responses had
 *     zero rows EVER, and the `catch` written to protect it never fired;
 *   · connector-hub telling the voice channel a booking was "human_gated"
 *     while the ledger write had silently failed on a uuid type mismatch;
 *   · voice-turn calling `.catch()` on the rpc builder — which is a thenable
 *     with no `.catch` — so a guardrail block threw and the caller got dead
 *     air instead of the safe redirect.
 *
 * ── The three shapes ────────────────────────────────────────────────────────
 * The right handling depends on what the caller does with the answer, so
 * there is no single wrapper:
 *
 *   rpcOrThrow  the caller REPORTS SUCCESS based on this write. A failure must
 *               stop the operation — never tell a customer something is
 *               recorded when it is not.
 *   rpcLoud     a side-record (audit, telemetry). Failing it must not fail the
 *               customer's answer, but it must be visible, not swallowed.
 *   budgetBlocked  a CONTROL. An unreadable answer means "no", never "yes".
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export class RpcError extends Error {
  constructor(public fn: string, public detail: string) {
    super(`${fn} failed: ${detail}`);
    this.name = 'RpcError';
  }
}

/**
 * For writes whose success the caller goes on to CLAIM. Throws on a Postgres
 * error so the claim can never outrun the record.
 */
export async function rpcOrThrow<T = unknown>(
  admin: SupabaseClient, fn: string, args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    console.error(`[rpc] ${fn} FAILED: ${error.message}`);
    throw new RpcError(fn, error.message);
  }
  return data as T;
}

/**
 * For best-effort side-records. Never throws — a blip writing telemetry must
 * not cost a customer their answer — but never silent either. Returns null on
 * failure so a caller that cares can still tell.
 */
export async function rpcLoud<T = unknown>(
  admin: SupabaseClient, fn: string, args: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { data, error } = await admin.rpc(fn, args);
    if (error) {
      console.error(`[rpc] ${fn} failed (best-effort, continuing): ${error.message}`);
      return null;
    }
    return data as T;
  } catch (e) {
    // .rpc() returns a thenable, not a Promise — it has no .catch, and a
    // transport failure rejects here rather than resolving with an error.
    console.error(`[rpc] ${fn} threw (best-effort, continuing): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The AI spend ceiling, read FAIL CLOSED.
 *
 * check_tenant_ai_budget always returns a jsonb object, so a null `data` means
 * the call errored. Every one of its call sites asked whether the returned
 * object was truthy AND its `allowed` field was false — which on an error
 * evaluates FALSE, i.e. "allowed", i.e. spend anyway. A transient database
 * problem silently switched off the monthly cap across the whole platform.
 *
 * An unreadable ceiling now means "stop", not "go". A database incident that
 * makes this unreadable has already broken knowledge retrieval and audit
 * writes, so refusing the call costs little availability that was not already
 * lost — and it cannot quietly spend a customer's money.
 */
export function budgetBlocked(err: { message: string } | null, data: unknown): boolean {
  if (err) {
    console.error(`[aiBudget] ceiling unreadable — refusing the call (fail closed): ${err.message}`);
    return true;
  }
  if (data == null) {
    console.error('[aiBudget] ceiling returned nothing — refusing the call (fail closed)');
    return true;
  }
  return (data as { allowed?: boolean }).allowed === false;
}
