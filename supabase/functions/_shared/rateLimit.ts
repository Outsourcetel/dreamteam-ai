// Durable (DB-backed) rate limiting for public endpoints — migration 198.
//
// The in-memory Map limiters in widget-ask/voice-relay are a free first
// line but reset per isolate and per deploy. This helper is the
// AUTHORITATIVE check: a fixed-window counter in Postgres shared by every
// isolate. Fail-open on RPC error — the in-memory limiter still applies,
// and an outage of the counter table must not take the widget down.
// deno-lint-ignore-file no-explicit-any

export async function durableRateLimited(
  admin: any,
  bucketKey: string,
  maxPerWindow: number,
  windowSeconds = 60,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc('rate_limit_hit', {
      p_bucket_key: bucketKey,
      p_window_seconds: windowSeconds,
      p_max_hits: maxPerWindow,
    });
    if (error) { console.error('rate_limit_hit:', error.message); return false; }
    return data?.allowed === false;
  } catch {
    return false;
  }
}

/** Client IP for per-IP buckets (best-effort; empty string if unknown). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  return fwd.split(',')[0].trim().slice(0, 45);
}
