/**
 * mcp-client — real MCP (Model Context Protocol) client over
 * Streamable HTTP. Replaces the ping-only mcp_test in specialist-consult.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST (Streamable HTTP transport,
 * protocol version 2025-03-26):
 *   1. initialize            → capture Mcp-Session-Id response header
 *   2. notifications/initialized (fire-and-forget notification)
 *   3. tools/list            → tool inventory
 *   4. tools/call            → invoke a tool
 * Servers may answer application/json OR text/event-stream (SSE) —
 * both are parsed here.
 *
 * Actions:
 *   { action: 'handshake', connector_id }
 *     Full initialize → tools/list. Stores a tool-list SUMMARY
 *     (names + descriptions, no payloads) on the connector row
 *     (config.mcp), audits the handshake. Honest structured failure on
 *     unreachable/broken servers.
 *   { action: 'call_tool', connector_id, tool, args? }
 *     CLOSED — returns 403. Calling an MCP tool directly would bypass the
 *     action gate (approval, guardrails, trust dial, spend caps). Register the
 *     tool as a governed action_definition instead.
 *
 * Auth to the MCP server: optional bearer secret from
 * connector_secrets_decrypted, a service-role-only view over Vault-encrypted
 * storage, sent under the configured header name (default Authorization: Bearer …).
 *
 * ⚠ THIS HEADER WAS STALE UNTIL 2026-08-22 and described a function that no
 * longer existed. It documented `source_id` as the parameter and
 * specialist_source_secrets_decrypted as the credential source — both belong to
 * the specialist-source path, which migration 611 removed along with the
 * specialist role. A caller following it got a 410. `source_id` is still
 * ACCEPTED, but only to answer it with that 410 and an explanation; the live
 * parameter is `connector_id`.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { rpcLoud } from '../_shared/rpcSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Jul-2026 MCP spec (#16): offer the latest revision; ADOPT whatever the
// server negotiates down to in its initialize reply, and send THAT on every
// subsequent request (per spec, the header must carry the negotiated
// version — the old code pinned the constant). Older servers keep working.
const LATEST_PROTOCOL_VERSION = '2026-07-28';
const TIMEOUT_MS = 12000;
// Tasks (new in the 2026 spec): a tools/call may return a long-running
// task instead of an immediate result. Bounded polling, then honest timeout.
const TASK_POLLS = 5;
const TASK_POLL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RpcResult { ok: boolean; result?: unknown; error?: string; sessionId?: string; status?: number }

/** Parse a Streamable HTTP response body — plain JSON or SSE frames. */
async function parseRpcResponse(res: Response): Promise<{ parsed: unknown; snippet: string }> {
  const text = await res.text();
  const snippet = text.slice(0, 200);
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    // Take the last data: frame that parses as a JSON-RPC response.
    // Lines may be CRLF-terminated; frames may also be multi-line.
    let last: unknown = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1].trim()) {
        try {
          const p = JSON.parse(m[1].trim());
          if (p && typeof p === 'object' && ('result' in p || 'error' in p)) last = p;
        } catch { /* skip non-JSON frames */ }
      }
    }
    return { parsed: last, snippet };
  }
  try { return { parsed: JSON.parse(text), snippet }; } catch { return { parsed: null, snippet }; }
}

async function rpc(
  endpoint: string, headers: Record<string, string>,
  method: string, params: unknown, id: number | null, sessionId?: string,
  protocolVersion: string = LATEST_PROTOCOL_VERSION,
): Promise<RpcResult> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id; // null id = notification
  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
    ...headers,
  };
  if (sessionId) hdrs['Mcp-Session-Id'] = sessionId;
  // SSRF guard at the actual fetch chokepoint. `endpoint` comes from
  // connectors.config.mcp_url / base_url, writable by a tenant admin, so this
  // is what stands between a tenant user and a fetch against loopback /
  // RFC1918 / cloud-metadata addresses. Callers also pre-check on the way in;
  // this re-checks per request (endpoint is a parameter and every MCP call
  // funnels through here).
  // (Was described as specialist_sources.config until 2026-08-22 — that table
  // was dropped in migration 611; the guard itself is unchanged and still the
  // one that matters.)
  if (!isSafeExternalUrl(endpoint)) {
    return { ok: false, error: 'endpoint blocked by safety policy (must be a public http(s) address)' };
  }
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers: hdrs, body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `unreachable: ${String(e).slice(0, 160)}` };
  }
  const newSession = res.headers.get('mcp-session-id') ?? sessionId;
  if (id === null) return { ok: res.status < 400, sessionId: newSession, status: res.status }; // notification: no body expected
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `http_${res.status}: ${t.slice(0, 160)}`, sessionId: newSession, status: res.status };
  }
  const { parsed: parsedRaw, snippet } = await parseRpcResponse(res);
  const parsed = parsedRaw as { result?: unknown; error?: { message?: string; code?: number } } | null;
  if (!parsed) return { ok: false, error: `unparseable_response: ${snippet.slice(0, 120)}`, sessionId: newSession, status: res.status };
  if (parsed.error) return { ok: false, error: `rpc_error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown'}`, sessionId: newSession, status: res.status };
  return { ok: true, result: parsed.result, sessionId: newSession, status: res.status };
}

/**
 * MCP tool annotations (spec: readOnlyHint / destructiveHint / idempotentHint).
 * These are the RISK SIGNAL the governed-connector build maps onto
 * action_definitions.risk — a read-only tool may auto-execute under trust, a
 * destructive one is floored to a human. Captured verbatim; interpretation
 * (incl. the fail-safe for absent annotations) belongs to the caller.
 */
interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
/** Full tool definition. The handshake RETURNS these; it still STORES only the
 *  name/description summary on the source row (no payloads), as before. */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}
interface McpServerInfo { name?: string; version?: string; protocolVersion?: string }

async function mcpSession(endpoint: string, headers: Record<string, string>): Promise<
  { ok: true; sessionId?: string; serverInfo: McpServerInfo; tools: McpToolDef[]; protocolVersion: string } |
  { ok: false; error: string; stage: string }
> {
  // 1. initialize — offer the latest spec + declare the tasks capability;
  // adopt the server's negotiated version for every subsequent request.
  const init = await rpc(endpoint, headers, 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tasks: {} },
    clientInfo: { name: 'dreamteam-mcp-client', version: '2.0.0' },
  }, 1);
  if (!init.ok) return { ok: false, error: init.error ?? 'initialize_failed', stage: 'initialize' };
  const initRes = (init.result ?? {}) as { serverInfo?: McpServerInfo; protocolVersion?: string };
  const sessionId = init.sessionId;
  const negotiated = typeof initRes.protocolVersion === 'string' && initRes.protocolVersion
    ? initRes.protocolVersion : LATEST_PROTOCOL_VERSION;

  // 2. notifications/initialized (best-effort)
  await rpc(endpoint, headers, 'notifications/initialized', undefined, null, sessionId, negotiated);

  // 3. tools/list
  const list = await rpc(endpoint, headers, 'tools/list', {}, 2, sessionId, negotiated);
  if (!list.ok) return { ok: false, error: list.error ?? 'tools_list_failed', stage: 'tools/list' };
  const toolsRaw = ((list.result ?? {}) as { tools?: Array<Record<string, unknown>> }).tools ?? [];
  return {
    ok: true, sessionId, protocolVersion: negotiated,
    serverInfo: { ...(initRes.serverInfo ?? {}), protocolVersion: negotiated },
    // Full defs: annotations + inputSchema are what the governed-connector
    // registration needs (risk classification + param_schema). Previously this
    // dropped both, keeping only name/description.
    tools: toolsRaw.slice(0, 40).map((t) => ({
      name: String(t.name ?? ''),
      description: String(t.description ?? '').slice(0, 200),
      inputSchema: (t.inputSchema ?? (t as Record<string, unknown>).input_schema) as Record<string, unknown> | undefined,
      annotations: t.annotations as McpToolAnnotations | undefined,
    })),
  };
}

/**
 * Constant-time comparison for shared secrets.
 *
 * Both sides must be NON-EMPTY. That is the entire point: '' === '' is true, so
 * comparing an absent header against an unset environment variable
 * AUTHENTICATES THE CALLER. Every secret check in this file goes through here
 * so that trap cannot be reintroduced one call site at a time.
 */
function secretMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? '';
    const sourceId: string = String(body.source_id ?? '');
    // GOVERNED-CONNECTOR PATH (docs/mcp-governed-connector-design.md): an MCP
    // server may now be a first-class connector (provider 'mcp') instead of a
    // specialist source. Same protocol, same SSRF + allowlist guards; the
    // difference is that a connector's tools get REGISTERED as gated
    // action_definitions rather than called ad hoc.
    const connectorId: string = String(body.connector_id ?? '');
    if (!action) return json({ error: 'action_required' }, 400);
    if (!sourceId && !connectorId) return json({ error: 'source_id_or_connector_id_required' }, 400);
    // mig 652/611: the specialist-source path is gone. Migration 611 retired the
    // specialist role and DROPPED specialist_sources; the two queries further
    // down still name it, so a caller passing source_id got an opaque PGRST205
    // about a missing relation. Refuse at the door with a reason instead. This
    // is the second half of the code→schema gap the debt map found — the first
    // was media_assets, which had live callers and was restored.
    if (sourceId && !connectorId) {
      return json({
        error: 'specialist_sources_retired',
        detail: 'MCP servers are connectors now. Pass connector_id — source_id referred to the specialist source table, which was removed when the specialist role was retired.',
      }, 410);
    }

    const admin: SupabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or a trusted machine caller + tenant_id ──
    //
    // The machine path used to be "present the service-role key as the bearer
    // token". Supabase retired the legacy service_role JWT, so that path stopped
    // authenticating anything and this function had NO working non-human entry
    // point — internal callers got a flat 401 with nothing in the code to say why.
    //
    // Fixed by adopting the house idiom rather than inventing a third one:
    // x-dispatch-secret checked against PLAYBOOK_DISPATCH_SECRET, exactly as every
    // pg_cron dispatcher already does (see mig 350). The legacy key comparison
    // stays as a fallback for any caller still using it — it simply never matches
    // once the key is gone, which is correct for a retired credential.
    //
    // ⚠ BOTH go through secretMatches, which refuses empty operands. The original
    // strict-equality check was one misconfiguration away from fail-open: set
    // SUPABASE_SERVICE_ROLE_KEY to the empty string and a request with NO
    // Authorization header authenticates as a service call, then takes tenant_id
    // straight from the request body — any tenant it cares to name.
    // ⚠ The `\s` here was a bare `s` until 2026-08-22, so the pattern matched the
    // literal text "Bearers+" and stripped nothing. The prefix stayed on the token,
    // auth.getUser() below was handed "Bearer eyJ..." and 401'd every time — this
    // function had no working interactive entry point at all. It failed CLOSED, so
    // nothing was exposed; it was simply dead for humans. All 54 other Bearer
    // strippers in supabase/functions use /^Bearer\s+/i; this was the lone outlier.
    // Repairing it does NOT reopen the ungoverned MCP write path: `call_tool` is
    // refused unconditionally at its own guard below, which never consulted this.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const machineCaller =
      secretMatches(req.headers.get('x-dispatch-secret'), Deno.env.get('PLAYBOOK_DISPATCH_SECRET')) ||
      secretMatches(jwt, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));

    let tenantId: string | null = null;
    if (machineCaller) {
      tenantId = body.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for machine calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Source row (tenant-checked) + optional bearer secret ──
    // Specialists are Digital Employees now (migrations 208/211); resolve the
    // source's tenant via its owning specialist DE.
    let cfg: Record<string, unknown> = {};
    let endpoint = '';
    let secretText: string | null = null;

    if (connectorId) {
      // Connector path — tenant-scoped exactly like connector-hub does it.
      const { data: conn } = await admin.from('connectors')
        .select('id, provider, base_url, config')
        .eq('id', connectorId).eq('tenant_id', tenantId).maybeSingle();
      if (!conn) return json({ error: 'connector_not_found' }, 404);
      if (conn.provider !== 'mcp') return json({ error: 'not_an_mcp_connector' }, 400);
      cfg = (conn.config ?? {}) as Record<string, unknown>;
      endpoint = String(cfg.mcp_url ?? conn.base_url ?? '');
      const { data: cSecret } = await admin.from('connector_secrets_decrypted')
        .select('secret').eq('connector_id', connectorId).maybeSingle();
      if (cSecret?.secret) {
        // Connector secrets are a JSON bag; an MCP server's bearer lives under
        // `token` (fall back to the raw string for a bare-token secret).
        try {
          const parsed = JSON.parse(cSecret.secret) as Record<string, unknown>;
          secretText = String(parsed.token ?? parsed.api_key ?? parsed.access_token ?? '') || null;
        } catch { secretText = cSecret.secret; }
      }
    }
    // ⚠ The `else` that stood here was UNREACHABLE and queried two DROPPED
    // tables (specialist_sources, specialist_source_secrets_decrypted, gone with
    // the specialist role in migration 611). Removed 2026-08-22.
    //
    // Proven, not assumed: `!sourceId && !connectorId` returns 400 above, and
    // `sourceId && !connectorId` returns 410 above, so by this line connectorId
    // is always a non-empty string and the else could never be entered. The 410
    // is the real, reachable answer for a source_id caller and it stays.
    //
    // This was the last of the code->schema gap the debt map opened with. The
    // first, media_assets, had LIVE callers and was restored; this one had none,
    // which is why it is deleted rather than revived. Recoverable at 5c76d8a.
    if (!endpoint) return json({ error: 'no_endpoint_configured' }, 400);
    // Reject unsafe endpoints up front with an actionable message (rpc()
    // re-checks at the fetch itself). Without this, a tenant member could
    // point an MCP source at loopback/RFC1918/link-local metadata and use
    // this function as an SSRF proxy -- the response is returned to them.
    if (!isSafeExternalUrl(endpoint)) {
      return json({
        error: 'unsafe_endpoint',
        detail: 'MCP endpoint must be a public http(s) address. Private, loopback, and link-local addresses are blocked.',
      }, 400);
    }
    // Injection firewall (#9, mig 174): tenant MCP allowlist. Opt-in — a
    // tenant with no allowlist rows keeps open (SSRF-guarded) behavior;
    // one row flips them to host∈allowlist enforcement.
    try {
      const host = new URL(endpoint).hostname;
      // FAIL CLOSED. This is the injection firewall, not a preference: if the
      // allowlist cannot be read we do not know whether this tenant restricts
      // hosts, and `allowed === false` on a null answer is false — which used
      // to let the call through to an unvetted host.
      // ⚠ _internal, since mig 749. mcp_host_allowed now refuses a caller with
      // no auth.uid(), and this runs on the service-role admin client — with
      // the old name the fail-closed branch below would fire on EVERY call and
      // every MCP request would 503. Deploy this WITH migration 749.
      const { data: allowed, error: allowErr } = await admin.rpc('mcp_host_allowed_internal', { p_tenant_id: tenantId, p_host: host });
      if (allowErr) {
        console.error(`[mcp-client] host allowlist unreadable for ${host} — refusing (fail closed): ${allowErr.message}`);
        return json({
          error: 'mcp_allowlist_unavailable',
          detail: 'The MCP server allowlist could not be checked, so the request was refused rather than sent to an unverified host. Try again shortly.',
        }, 503);
      }
      if (allowed === false) {
        return json({
          error: 'mcp_host_not_allowlisted',
          detail: `This workspace restricts MCP servers to an allowlist, and "${host}" is not on it. An admin can add it under the MCP server allowlist.`,
        }, 403);
      }
    } catch { /* URL parse failed → isSafeExternalUrl would have rejected */ }

    const headers: Record<string, string> = {};
    if (secretText) {
      const headerName = String(cfg.auth_header ?? '') || 'Authorization';
      headers[headerName] = headerName.toLowerCase() === 'authorization' && !/^bearer /i.test(secretText)
        ? `Bearer ${secretText}` : secretText;
    }

    const audit = (actionText: string, detail: Record<string, unknown>) =>
      rpcLoud(admin, 'append_audit_event', {
        p_tenant_id: tenantId, p_actor: 'MCP client', p_actor_type: 'system',
        p_action: actionText, p_category: 'connector_sync',
        p_detail: {
          kind: 'mcp', endpoint,
          connector_id: connectorId,   // always set by this line — see the note above
          ...detail,
        },
      });

    // ════════ handshake ════════
    if (action === 'handshake') {
      const started = Date.now();
      const s = await mcpSession(endpoint, headers);
      const ms = Date.now() - started;
      // Persist the handshake record onto whichever row this call is for.
      const persistMcp = (meta: Record<string, unknown>) =>
        admin.from('connectors').update({ config: { ...cfg, mcp: meta } }).eq('id', connectorId);

      if (!s.ok) {
        // Honest structured failure — recorded on the row too.
        const lastHandshake = { ok: false, error: s.error, stage: s.stage, at: new Date().toISOString() };
        await persistMcp({ ...(cfg.mcp as Record<string, unknown> ?? {}), last_handshake: lastHandshake });
        await audit(`MCP handshake FAILED at ${s.stage} — ${s.error} (recorded honestly)`, { ok: false, stage: s.stage, error: s.error, latency_ms: ms });
        return json({ ok: false, error: s.error, stage: s.stage, latency_ms: ms });
      }
      const mcpMeta = {
        server_info: s.serverInfo,
        // STORE the summary only (no inputSchema payloads) — unchanged promise.
        // The full defs, incl. annotations, are RETURNED to the caller below so
        // the governed registration can classify risk without persisting schemas.
        tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
        tool_count: s.tools.length,
        last_handshake: { ok: true, at: new Date().toISOString(), latency_ms: ms },
      };
      await persistMcp(mcpMeta);
      await audit(
        `MCP handshake succeeded — ${s.serverInfo.name ?? 'server'} (${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} listed) via Streamable HTTP`,
        { ok: true, server_info: s.serverInfo, tool_count: s.tools.length, tools: s.tools.map((t) => t.name), latency_ms: ms });
      return json({ ok: true, server_info: s.serverInfo, tools: s.tools, latency_ms: ms });
    }

    // ════════ call_tool — fetch-only: returned + audited, never persisted ════════
    if (action === 'call_tool') {
      // SECURITY (§3): this path invokes a third-party MCP tool with caller-supplied
      // arguments and sends the vault-decrypted bearer — a real side effect — but it
      // NEVER passed decide_action_execution (no destructive floor, guardrails, trust
      // dial, spend cap, approval, or exactly-once). It is authenticated by tenant
      // membership alone, so any member could drive an ungoverned external write.
      // It has ZERO callers in the app, so closing it costs nothing today. MCP writes
      // are re-enabled by REGISTERING each tool as an action_definition (provider
      // 'mcp'), which inherits the whole gate rather than bypassing it — the §3 MCP
      // increment. Opt-in escape hatch for that governed executor only.
      const governed = secretMatches(req.headers.get('x-mcp-governed-call'), Deno.env.get('PLAYBOOK_DISPATCH_SECRET'));
      if (!governed) {
        return json({ ok: false, error: 'mcp_writes_not_governed',
          detail: 'Calling an MCP tool directly is disabled: it would bypass the action gate (approval, guardrails, trust dial, spend caps). Register the tool as a governed action instead.' }, 403);
      }
      const tool = String(body.tool ?? '').trim();
      if (!tool) return json({ error: 'tool_required' }, 400);
      const args = (body.args ?? {}) as Record<string, unknown>;
      const started = Date.now();
      const s = await mcpSession(endpoint, headers);
      if (!s.ok) {
        await audit(`MCP tools/call FAILED — could not establish session (${s.error})`, { ok: false, tool, error: s.error });
        return json({ ok: false, error: s.error, stage: s.stage });
      }
      const call = await rpc(endpoint, headers, 'tools/call', { name: tool, arguments: args }, 3, s.sessionId, s.protocolVersion);
      let ms = Date.now() - started;
      if (!call.ok) {
        await audit(`MCP tools/call FAILED — ${tool}: ${call.error}`, { ok: false, tool, error: call.error, latency_ms: ms });
        return json({ ok: false, error: call.error, latency_ms: ms });
      }
      // Tasks (Jul-2026 spec, #16): a 2026 server may hand back a long-
      // running task instead of an immediate result. Poll tasks/get on a
      // bounded budget; pre-2026 servers never return one (path dormant).
      let callResult = call.result;
      const taskInfo = (callResult ?? {}) as { task?: { taskId?: string; status?: string } };
      if (taskInfo.task?.taskId && !['completed', 'failed', 'cancelled'].includes(String(taskInfo.task.status ?? ''))) {
        const taskId = taskInfo.task.taskId;
        let terminal = false;
        for (let p = 0; p < TASK_POLLS && !terminal; p++) {
          await sleep(TASK_POLL_MS);
          const poll = await rpc(endpoint, headers, 'tasks/get', { taskId }, 10 + p, s.sessionId, s.protocolVersion);
          if (!poll.ok) break;
          const t = (poll.result ?? {}) as { task?: { status?: string }; result?: unknown };
          const status = String(t.task?.status ?? '');
          if (status === 'completed') { callResult = t.result ?? t; terminal = true; }
          else if (status === 'failed' || status === 'cancelled') {
            ms = Date.now() - started;
            await audit(`MCP task ${status} — ${tool}`, { ok: false, tool, task_id: taskId, latency_ms: ms });
            return json({ ok: false, error: `mcp_task_${status}`, task_id: taskId, latency_ms: ms });
          }
        }
        if (!terminal) {
          ms = Date.now() - started;
          await audit(`MCP task still running after poll budget — ${tool}`, { ok: false, tool, task_id: taskId, latency_ms: ms });
          return json({ ok: false, error: 'mcp_task_timeout', task_id: taskId, detail: `Task still running after ${TASK_POLLS} polls — retry later.`, latency_ms: ms });
        }
        ms = Date.now() - started;
      }
      const result = (callResult ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const textOut = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      await audit(
        `MCP tool called — ${tool} on ${s.serverInfo.name ?? endpoint}: ${result.isError ? 'tool reported an error' : 'ok'} (${ms}ms; fetch-only, result not persisted)`,
        { ok: !result.isError, tool, latency_ms: ms, result_chars: textOut.length, persisted: false });
      return json({ ok: !result.isError, tool, content: result.content ?? [], text: textOut, latency_ms: ms, persisted: false });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('mcp-client error:', err);
    await reportEdgeError('mcp-client', err, {});
    return json({ error: String(err) }, 500);
  }
});
