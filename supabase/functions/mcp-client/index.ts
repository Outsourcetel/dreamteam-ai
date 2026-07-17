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
 *   { action: 'handshake', source_id }
 *     Full initialize → tools/list. Stores a tool-list SUMMARY
 *     (names + descriptions, no payloads) on the specialist source row
 *     (config.mcp), audits the handshake. Honest structured failure on
 *     unreachable/broken servers.
 *   { action: 'call_tool', source_id, tool, args? }
 *     initialize → tools/call. FETCH-ONLY semantics: the result is
 *     returned to the caller and audited; NOTHING is persisted.
 *
 * Auth to the MCP server: optional bearer secret from
 * specialist_source_secrets_decrypted, a service-role-only view over
 * Vault-encrypted storage (migration 088), sent under the configured
 * header name (default Authorization: Bearer …).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const PROTOCOL_VERSION = '2025-03-26';
const TIMEOUT_MS = 12000;

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
): Promise<RpcResult> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id; // null id = notification
  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    ...headers,
  };
  if (sessionId) hdrs['Mcp-Session-Id'] = sessionId;
  // SSRF guard at the actual fetch chokepoint. `endpoint` comes from
  // specialist_sources.config, which ANY member of the tenant can write
  // (RLS policy specialist_sources_tenant_isolation, migration 024) --
  // unlike connectors.base_url there is no DB-level CHECK behind it, so
  // this is the only thing standing between a tenant user and a fetch
  // against loopback / RFC1918 / cloud-metadata addresses. Callers also
  // pre-check on the way in; this re-checks per request (endpoint is a
  // parameter and every MCP call funnels through here).
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

interface McpToolSummary { name: string; description: string }
interface McpServerInfo { name?: string; version?: string; protocolVersion?: string }

async function mcpSession(endpoint: string, headers: Record<string, string>): Promise<
  { ok: true; sessionId?: string; serverInfo: McpServerInfo; tools: McpToolSummary[] } |
  { ok: false; error: string; stage: string }
> {
  // 1. initialize
  const init = await rpc(endpoint, headers, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'dreamteam-mcp-client', version: '1.0.0' },
  }, 1);
  if (!init.ok) return { ok: false, error: init.error ?? 'initialize_failed', stage: 'initialize' };
  const initRes = (init.result ?? {}) as { serverInfo?: McpServerInfo; protocolVersion?: string };
  const sessionId = init.sessionId;

  // 2. notifications/initialized (best-effort)
  await rpc(endpoint, headers, 'notifications/initialized', undefined, null, sessionId);

  // 3. tools/list
  const list = await rpc(endpoint, headers, 'tools/list', {}, 2, sessionId);
  if (!list.ok) return { ok: false, error: list.error ?? 'tools_list_failed', stage: 'tools/list' };
  const toolsRaw = ((list.result ?? {}) as { tools?: Array<Record<string, unknown>> }).tools ?? [];
  return {
    ok: true, sessionId,
    serverInfo: { ...(initRes.serverInfo ?? {}), protocolVersion: initRes.protocolVersion },
    tools: toolsRaw.slice(0, 40).map((t) => ({ name: String(t.name ?? ''), description: String(t.description ?? '').slice(0, 200) })),
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? '';
    const sourceId: string = String(body.source_id ?? '');
    if (!action) return json({ error: 'action_required' }, 400);
    if (!sourceId) return json({ error: 'source_id_required' }, 400);

    const admin: SupabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service role + tenant_id ──
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Source row (tenant-checked) + optional bearer secret ──
    const { data: src } = await admin.from('specialist_sources')
      .select('id, source_type, config, profile_id, specialist_profiles!inner(tenant_id)')
      .eq('id', sourceId).maybeSingle();
    const srcTenant = (src as { specialist_profiles?: { tenant_id?: string } } | null)?.specialist_profiles?.tenant_id;
    if (!src || srcTenant !== tenantId) return json({ error: 'source_not_found' }, 404);
    if (src.source_type !== 'mcp_server') return json({ error: 'not_an_mcp_source' }, 400);

    const cfg = (src.config ?? {}) as Record<string, unknown>;
    const endpoint = String(cfg.endpoint ?? '');
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

    const headers: Record<string, string> = {};
    const { data: secretRow } = await admin.from('specialist_source_secrets_decrypted')
      .select('secret').eq('source_id', sourceId).maybeSingle();
    if (secretRow?.secret) {
      const headerName = String(cfg.auth_header ?? '') || 'Authorization';
      headers[headerName] = headerName.toLowerCase() === 'authorization' && !/^bearer /i.test(secretRow.secret)
        ? `Bearer ${secretRow.secret}` : secretRow.secret;
    }

    const audit = (actionText: string, detail: Record<string, unknown>) =>
      admin.rpc('append_audit_event', {
        p_tenant_id: tenantId, p_actor: 'MCP client', p_actor_type: 'system',
        p_action: actionText, p_category: 'connector_sync',
        p_detail: { kind: 'mcp', source_id: sourceId, endpoint, ...detail },
      });

    // ════════ handshake ════════
    if (action === 'handshake') {
      const started = Date.now();
      const s = await mcpSession(endpoint, headers);
      const ms = Date.now() - started;
      if (!s.ok) {
        // Honest structured failure — recorded on the source row too.
        const lastHandshake = { ok: false, error: s.error, stage: s.stage, at: new Date().toISOString() };
        await admin.from('specialist_sources')
          .update({ config: { ...cfg, mcp: { ...(cfg.mcp as Record<string, unknown> ?? {}), last_handshake: lastHandshake } } })
          .eq('id', sourceId);
        await audit(`MCP handshake FAILED at ${s.stage} — ${s.error} (recorded honestly)`, { ok: false, stage: s.stage, error: s.error, latency_ms: ms });
        return json({ ok: false, error: s.error, stage: s.stage, latency_ms: ms });
      }
      const mcpMeta = {
        server_info: s.serverInfo,
        tools: s.tools,
        tool_count: s.tools.length,
        last_handshake: { ok: true, at: new Date().toISOString(), latency_ms: ms },
      };
      await admin.from('specialist_sources')
        .update({ config: { ...cfg, mcp: mcpMeta } }).eq('id', sourceId);
      await audit(
        `MCP handshake succeeded — ${s.serverInfo.name ?? 'server'} (${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} listed) via Streamable HTTP`,
        { ok: true, server_info: s.serverInfo, tool_count: s.tools.length, tools: s.tools.map((t) => t.name), latency_ms: ms });
      return json({ ok: true, server_info: s.serverInfo, tools: s.tools, latency_ms: ms });
    }

    // ════════ call_tool — fetch-only: returned + audited, never persisted ════════
    if (action === 'call_tool') {
      const tool = String(body.tool ?? '').trim();
      if (!tool) return json({ error: 'tool_required' }, 400);
      const args = (body.args ?? {}) as Record<string, unknown>;
      const started = Date.now();
      const s = await mcpSession(endpoint, headers);
      if (!s.ok) {
        await audit(`MCP tools/call FAILED — could not establish session (${s.error})`, { ok: false, tool, error: s.error });
        return json({ ok: false, error: s.error, stage: s.stage });
      }
      const call = await rpc(endpoint, headers, 'tools/call', { name: tool, arguments: args }, 3, s.sessionId);
      const ms = Date.now() - started;
      if (!call.ok) {
        await audit(`MCP tools/call FAILED — ${tool}: ${call.error}`, { ok: false, tool, error: call.error, latency_ms: ms });
        return json({ ok: false, error: call.error, latency_ms: ms });
      }
      const result = (call.result ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const textOut = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      await audit(
        `MCP tool called — ${tool} on ${s.serverInfo.name ?? endpoint}: ${result.isError ? 'tool reported an error' : 'ok'} (${ms}ms; fetch-only, result not persisted)`,
        { ok: !result.isError, tool, latency_ms: ms, result_chars: textOut.length, persisted: false });
      return json({ ok: !result.isError, tool, content: result.content ?? [], text: textOut, latency_ms: ms, persisted: false });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('mcp-client error:', err);
    return json({ error: String(err) }, 500);
  }
});
