/**
 * a2a — A2A protocol endpoint (Frontier-20 #8).
 *
 * Exposes each customer-facing DE as an A2A agent so external
 * orchestrators (Vertex, Bedrock, CrewAI, another DreamTeam) can
 * discover it and delegate work to it over the open protocol.
 *
 *   GET  ?de_id=<uuid>            → the DE's public Agent Card (discovery).
 *        Only DEs in a customer-facing lifecycle stage (certified/
 *        published/assigned/active — i.e. past the certification gate,
 *        mig 162) are discoverable; everything else 404s.
 *   POST ?de_id=<uuid>            → JSON-RPC 2.0. Methods:
 *        message/send             → the DE answers through the FULL
 *        governed path (de-answer: retrieval, guardrails, confidence,
 *        escalation, budgets). Result is an A2A Message from the agent;
 *        metadata carries confidence/sources/escalated.
 *
 * Auth: the card is public (that is the A2A discovery model — it contains
 * no secrets, only what the tenant already publishes about the DE).
 * message/send requires a tenant API key (X-API-Key, the mig-090 system —
 * verify_tenant_api_key was built exactly for this endpoint) whose tenant
 * must own the DE. Honest scope v1: synchronous Message results only —
 * capabilities advertises no streaming/push/task-history, so compliant
 * clients won't ask for what isn't there.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key, x-delegation-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);

const LIVE_STAGES = ['certified', 'published', 'assigned', 'active'];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = new URL(req.url);
    const deId = url.searchParams.get('de_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(deId)) return json({ error: 'de_id query parameter required' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: de } = await admin.from('digital_employees')
      .select('id, tenant_id, name, persona_name, description, department, responsibilities, lifecycle_status, config_version')
      .eq('id', deId).maybeSingle();
    if (!de || !LIVE_STAGES.includes(String(de.lifecycle_status))) {
      // Not found and not-yet-customer-facing are indistinguishable on
      // purpose: an uncertified DE simply does not exist to the outside.
      return json({ error: 'agent_not_found' }, 404);
    }

    const selfUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/a2a?de_id=${de.id}`;

    // ── GET: the public Agent Card ──
    if (req.method === 'GET') {
      const skills = (Array.isArray(de.responsibilities) ? de.responsibilities : []).slice(0, 8).map((r: string, i: number) => ({
        id: `skill-${i + 1}`,
        name: String(r).slice(0, 80),
        description: String(r).slice(0, 300),
        tags: [String(de.department ?? 'general').toLowerCase()],
      }));
      return json({
        protocolVersion: '1.0',
        name: de.persona_name || de.name,
        description: de.description || `${de.name} — a governed digital employee on DreamTeam AI.`,
        url: selfUrl,
        preferredTransport: 'JSONRPC',
        version: String(de.config_version ?? 1),
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'DreamTeam tenant API key (dt_live_…)' },
          delegationToken: { type: 'apiKey', in: 'header', name: 'X-Delegation-Token', description: 'Short-lived, agent-bound delegation token (dt_dg_…) — preferred: downscoped to this agent only' },
        },
        security: [{ apiKey: [] }, { delegationToken: [] }],
        skills: skills.length ? skills : [{ id: 'skill-1', name: 'Answer questions', description: 'Answers questions grounded in the tenant knowledge base, with escalation to humans.', tags: ['support'] }],
        provider: { organization: 'DreamTeam AI' },
      });
    }

    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    // ── POST: JSON-RPC 2.0 ──
    let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: { message?: { parts?: Array<{ kind?: string; type?: string; text?: string }> } } };
    try { rpc = await req.json(); } catch { return rpcError(null, -32700, 'Parse error'); }
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return rpcError(rpc.id, -32600, 'Invalid Request');

    // Auth, two credentials accepted (#14, mig 178):
    //   1. X-Delegation-Token — a short-lived, downscoped token bound to
    //      ONE DE (scope 'a2a.message'); the token's DE must BE this agent.
    //      Preferred: leaking it exposes minutes of one employee, not the
    //      tenant. Checked first as the more specific credential.
    //   2. X-API-Key — the tenant API key (mig 090); tenant must own the DE.
    const delegation = req.headers.get('x-delegation-token') ?? '';
    if (delegation) {
      // The expected DE participates in the atomic verify (mig 180), so a
      // token presented against the wrong agent consumes NO use.
      const { data: dtCheck } = await admin.rpc('verify_de_delegation_token', { p_raw: delegation, p_required_scope: 'a2a.message', p_expected_de: de.id });
      if (!dtCheck?.valid) return rpcError(rpc.id, -32001, 'Invalid, expired, revoked, out-of-scope, or wrong-agent delegation token', 401);
    } else {
      const rawKey = req.headers.get('x-api-key') ?? '';
      if (!rawKey) return rpcError(rpc.id, -32001, 'Authentication required: send a tenant API key in X-API-Key, or a DE delegation token in X-Delegation-Token', 401);
      const { data: keyCheck } = await admin.rpc('verify_tenant_api_key', { p_raw_key: rawKey });
      if (!keyCheck?.valid) return rpcError(rpc.id, -32001, 'Invalid or revoked API key', 401);
      if (keyCheck.tenant_id !== de.tenant_id) return rpcError(rpc.id, -32001, 'API key does not grant access to this agent', 403);
      // Scope symmetry with the delegation path: a key with NO scopes is
      // unrestricted (back-compat with every existing key); a key that
      // declares scopes must include a2a access to use this surface.
      const keyScopes: string[] = Array.isArray(keyCheck.scopes) ? keyCheck.scopes.map(String) : [];
      if (keyScopes.length > 0 && !keyScopes.some((s) => s === 'a2a.message' || s === 'a2a.*' || s === '*')) {
        return rpcError(rpc.id, -32001, 'This API key\'s scopes do not permit A2A message/send', 403);
      }
    }

    if (rpc.method !== 'message/send') return rpcError(rpc.id, -32601, `Method not found: ${rpc.method} (v1 supports message/send)`);

    const parts = rpc.params?.message?.parts;
    const text = (Array.isArray(parts) ? parts : [])
      .filter((p) => (p.kind ?? p.type) === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n').trim();
    if (!text) return rpcError(rpc.id, -32602, 'message.parts must contain at least one text part');

    // The governed answer path — same fabric as every other channel.
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ar = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: svc, Authorization: `Bearer ${svc}` },
      body: JSON.stringify({ question: text.slice(0, 4000), tenant_id: de.tenant_id, de_id: de.id }),
    });
    const aj = await ar.json().catch(() => ({}));
    if (aj.error) return rpcError(rpc.id, -32000, `Agent unavailable: ${String(aj.error)}`, 502);

    return json({
      jsonrpc: '2.0',
      id: rpc.id ?? null,
      result: {
        kind: 'message',
        role: 'agent',
        messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: String(aj.answer ?? '') }],
        metadata: {
          confidence: Number(aj.confidence) || 0,
          sources: Array.isArray(aj.sources) ? aj.sources : [],
          escalated_to_human: Boolean(aj.needs_escalation),
          conversation_id: aj.conversation_id ?? null,
        },
      },
    });
  } catch (err) {
    console.error('a2a error:', err);
    return json({ error: String(err) }, 500);
  }
});
