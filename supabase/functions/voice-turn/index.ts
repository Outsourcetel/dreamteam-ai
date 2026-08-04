/**
 * voice-turn — the voice channel's brain (docs/42 P0 spike).
 *
 * An OpenAI-compatible /chat/completions endpoint that a managed voice
 * platform (Vapi first; Retell/ConversationRelay are drop-ins by dialect)
 * calls once per conversational turn. The platform owns the mouth and ears
 * (telephony, STT, TTS, barge-in); this function owns the brain, the seam,
 * and nothing else:
 *
 *   THE SEAM: every utterance exists here as TEXT and is checked against the
 *   tenant's blocking guardrails BEFORE it is returned to be synthesized. A
 *   blocked utterance is never spoken — the caller hears the standard safe
 *   redirect instead. A voice reply is 1-3 short sentences, so whole-turn
 *   buffering IS sentence buffering, with zero chunk-boundary leak risk.
 *
 * Auth: x-voice-secret header vs VOICE_GATEWAY_SECRET (project secret). The
 * platform is a third party — it gets its own low-privilege secret, never the
 * dispatch secret. Tenant/DE arrive as query params configured per assistant.
 * Suspension: a dormant workspace's number answers with a fallback line and
 * takes no action, consistent with the platform-wide dormancy regime.
 *
 * Tool use: the request may carry OpenAI-format tools (configured per
 * assistant). Claude decides; tool_use is translated back as OpenAI
 * tool_calls, the platform executes them against voice-webhook, and the
 * result returns next turn as role:'tool'. The gate lives in voice-webhook —
 * this function never executes anything.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { llmMessages } from '../_shared/llm.ts';
import { resolveDePersona } from '../_shared/dePersona.ts';
import { findBlockingMatch } from '../_shared/guardrailMatch.ts';
import { secureEqual } from '../_shared/secureCompare.ts';
import { loadTenantGate } from '../_shared/tenantStatus.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-voice-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

const SAFE_REDIRECT = "I'm not able to help with that over the phone. Let me take a message and a colleague will follow up with you directly.";
const UNAVAILABLE = 'This line is currently unavailable. Please call back later.';

const VOICE_RULES = `
You are answering a live PHONE CALL. Hard rules for speech:
- At most three short sentences per turn. No lists, no markdown, no URLs spelled out.
- Plain spoken language. Confirm names, numbers and times back to the caller.
- If the caller asks for something involving money, refunds, or account changes, never promise it — offer to take the details and say a colleague will confirm.
- If you cannot help or the caller asks for a person, offer to take a message.
- Use the tools you are given when the caller wants to book or leave a message; after a tool result, tell the caller plainly what happened next.`;

type OaiMsg = { role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string };

/** OpenAI-dialect messages → Anthropic Messages body blocks. */
function toAnthropic(messages: OaiMsg[]): { system: string; msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> } {
  let system = '';
  const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? (m.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join(' ') : '';
    if (m.role === 'system') { system += (system ? '\n' : '') + text; continue; }
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave {} */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: text || 'ok' }] });
      continue;
    }
    if (text.trim()) msgs.push({ role: 'user', content: text });
  }
  // Anthropic requires the first message to be from the user.
  if (msgs.length === 0 || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '[call connected]' });
  return { system, msgs };
}

/** One OpenAI chat.completion response (the non-streaming shape; the SSE path
 *  wraps the same content). */
function oaiResponse(model: string, text: string | null, toolCalls: Array<{ id: string; name: string; input: unknown }>) {
  const message: Record<string, unknown> = { role: 'assistant', content: text };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((t) => ({
      id: t.id, type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
    }));
  }
  return {
    id: `vt-${crypto.randomUUID()}`, object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
  };
}

/** The same payload as chunked SSE — sentence-sized deltas so the platform
 *  begins synthesis on the first sentence. All text was guardrail-checked
 *  BEFORE this is called; chunking is presentation, not risk. */
function oaiStream(model: string, text: string | null, toolCalls: Array<{ id: string; name: string; input: unknown }>): Response {
  const id = `vt-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts: string[] = [];
  parts.push(chunk({ role: 'assistant' }));
  if (toolCalls.length) {
    toolCalls.forEach((t, i) => parts.push(chunk({
      tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }],
    })));
    parts.push(chunk({}, 'tool_calls'));
  } else {
    const sentences = (text ?? '').split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    for (const s of sentences.length ? sentences : ['']) parts.push(chunk({ content: s + ' ' }));
    parts.push(chunk({}, 'stop'));
  }
  parts.push('data: [DONE]\n\n');
  return new Response(parts.join(''), {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'post_only' }, 405);
  const t0 = Date.now();

  const secret = Deno.env.get('VOICE_GATEWAY_SECRET') ?? '';
  const given = req.headers.get('x-voice-secret') ?? '';
  if (!secret || !(await secureEqual(secret, given))) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenant') ?? '';
  const deId = url.searchParams.get('de') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(deId)) {
    return json({ error: 'tenant_and_de_required' }, 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const wantStream = body?.stream === true;
  const model = String(body?.model ?? 'claude-haiku-4-5-20251001');

  // A dormant workspace's number stays polite and inert.
  const gate = await loadTenantGate(admin, tenantId);
  if (gate.suspended) {
    return wantStream ? oaiStream(model, UNAVAILABLE, []) : json(oaiResponse(model, UNAVAILABLE, []));
  }

  const persona = await resolveDePersona(admin, tenantId, deId, gate.name);
  const { system, msgs } = toAnthropic((body?.messages ?? []) as OaiMsg[]);

  // Anthropic-dialect tools from the OpenAI-dialect request (names/schemas pass through).
  const tools = Array.isArray(body?.tools)
    ? (body.tools as Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>)
        .filter((t) => t?.function?.name)
        .map((t) => ({ name: t.function!.name!, description: t.function!.description ?? '', input_schema: t.function!.parameters ?? { type: 'object', properties: {} } }))
    : [];

  const llmBody: Record<string, unknown> = {
    model, max_tokens: 200, temperature: 0.4,
    system: `${persona.preamble}\n${VOICE_RULES}\n${system}`.trim(),
    messages: msgs,
  };
  if (tools.length) llmBody.tools = tools;

  // Tenant-scoped, so a BYO workspace's own key serves its calls. Safe again
  // since mig 575: plain key-absence falls through to the platform path
  // (platform_config, then env), and only a considered BYO refusal blocks —
  // so env-only providers (Bedrock) stay in the failover chain.
  const res = await llmMessages(admin, llmBody, 'voice-turn', tenantId);
  if (!res.ok) {
    // Secret-gated diagnostics: same header value as auth, different header
    // name — never reachable without the gateway secret, never spoken.
    if (req.headers.get('x-voice-debug') === secret) {
      return json({ debug: true, upstream_status: res.status, upstream: await res.text() }, 200);
    }
    // The failover chain is exhausted — say so like a phone system, not an API.
    const line = "I'm having trouble hearing our systems right now. Please call back in a few minutes.";
    return wantStream ? oaiStream(model, line, []) : json(oaiResponse(model, line, []));
  }
  const out = await res.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  let text = (out.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
  const toolCalls = (out.content ?? []).filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? `tc-${crypto.randomUUID()}`, name: b.name ?? '', input: b.input ?? {} }));

  // ── THE SEAM: blocking guardrails on the full utterance, before synthesis. ──
  if (text) {
    const { data: rules } = await admin.from('guardrail_rules')
      .select('id, rule, pattern, rule_type, severity, applies_to')
      .eq('tenant_id', tenantId).eq('active', true).eq('severity', 'blocking');
    const hit = findBlockingMatch((rules ?? []).filter((r) => r.pattern), text);
    if (hit) {
      await admin.rpc('append_audit_event', {
        p_tenant_id: tenantId, p_actor: persona.name, p_actor_type: 'de',
        p_action: `Guardrail blocked a voice utterance before synthesis — rule "${hit.rule.rule}"`,
        p_category: 'guardrail_block',
        p_detail: { kind: 'voice_utterance_blocked', de_id: deId, rule_id: hit.rule.id, channel: 'voice' },
      });
      text = SAFE_REDIRECT;
      // A blocked turn never carries tool calls either — nothing acts on it.
      toolCalls.length = 0;
    }
  }

  const latency = { 'x-turn-ms': String(Date.now() - t0) };
  return wantStream
    ? oaiStream(model, toolCalls.length ? null : (text || 'One moment.'), toolCalls)
    : json(oaiResponse(model, toolCalls.length ? null : (text || 'One moment.'), toolCalls), 200, latency);
});
