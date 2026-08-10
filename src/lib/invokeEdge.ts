import { supabase } from '../supabase';

/**
 * invokeEdge — the one way this app calls a Supabase edge function.
 *
 * Exists because of a live failure (2026-08-10): an access token that expired
 * while the tab sat idle was rejected by the gateway's verify_jwt with a bare
 * 401 — the request never reached the function, and supabase-js surfaced only
 * "Edge Function returned a non-2xx status code". Two duties live here so no
 * call site can forget either:
 *
 *  1. getSession() BEFORE invoking — it refreshes an expired token, and the
 *     token is passed explicitly so the call cannot race the client's own
 *     auth-state propagation into functions.setAuth.
 *  2. On failure, the response body is read ONCE and the function's own
 *     refusal (detail/error) becomes the error message — or plain language
 *     for a bare gateway 401. The parsed body stays on the error for callers
 *     whose functions answer non-2xx with a structured result they still use.
 *
 * tenant_id stays a CALLER concern: a platform operator has no tenant of
 * their own, so callers that support operator sessions pass tenant_id in the
 * body from getSessionTenantId() exactly as before.
 */
export class EdgeFunctionError extends Error {
  /** HTTP status when a response arrived; undefined when the fetch itself failed. */
  status?: number;
  /** Parsed JSON body of the non-2xx response, when it was JSON. */
  body: Record<string, unknown> | null;
  /** Raw (truncated) body text when the response was not JSON. */
  bodyText?: string;

  constructor(message: string, opts: { status?: number; body?: Record<string, unknown> | null; bodyText?: string; name?: string }) {
    super(message);
    // The underlying class name survives (FunctionsHttpError / FunctionsFetchError /
    // FunctionsRelayError) — callers distinguish "the request never completed"
    // from "the function refused" by it.
    this.name = opts.name ?? 'EdgeFunctionError';
    this.status = opts.status;
    this.body = opts.body ?? null;
    this.bodyText = opts.bodyText;
  }
}

export interface EdgeInvokeOptions {
  body?: unknown;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
}

export async function invokeEdge<T = unknown>(
  name: string,
  options: EdgeInvokeOptions = {},
): Promise<{ data: T | null; error: EdgeFunctionError | null }> {
  const { data: sess } = await supabase.auth.getSession();
  const { data, error } = await supabase.functions.invoke(name, {
    ...options,
    ...(sess?.session ? { headers: { Authorization: `Bearer ${sess.session.access_token}` } } : {}),
  });
  if (!error) return { data: (data ?? null) as T | null, error: null };

  const ctx = (error as { context?: Response }).context;
  const status = typeof ctx?.status === 'number' ? ctx.status : undefined;
  let body: Record<string, unknown> | null = null;
  let bodyText: string | undefined;
  try {
    const text = ((await ctx?.text?.()) ?? '').slice(0, 2000);
    try { body = JSON.parse(text) as Record<string, unknown>; }
    catch { bodyText = text.trim() || undefined; }
  } catch { /* body absent or already consumed — keep the wrapper message */ }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const message =
    str(body?.detail) ?? str(body?.error)
    // A bare gateway 401 carries only {code, msg} — the sign-in token expired
    // before the function ever ran.
    ?? (status === 401 ? 'your sign-in expired — try again, or reload the page' : undefined)
    ?? str(body?.msg) ?? bodyText ?? (error as Error).message ?? 'unknown error';

  return {
    data: (data ?? null) as T | null,
    error: new EdgeFunctionError(message, { status, body, bodyText, name: (error as Error).name }),
  };
}
