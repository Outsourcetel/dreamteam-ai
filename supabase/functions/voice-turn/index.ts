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
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hasLLMProvider, llmMessages, llmStream, type LlmStreamMeta } from '../_shared/llm.ts';
import { resolveDePersona, type DePersona } from '../_shared/dePersona.ts';
import { findBlockingMatch, type PatternHit, type PatternRule } from '../_shared/guardrailMatch.ts';
import { secureEqual } from '../_shared/secureCompare.ts';
import { loadTenantGate } from '../_shared/tenantStatus.ts';
import { rpcLoud } from '../_shared/rpcSafety.ts';

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

/** A fixed line as SSE — for the canned replies (dormant workspace, chain
 *  exhausted) that never involve the model. */
function staticStream(model: string, text: string | null, toolCalls: Array<{ id: string; name: string; input: unknown }>, extra: Record<string, string> = {}): Response {
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
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...extra },
  });
}

// A period is not always a full stop. Splitting after an initial or an
// abbreviation hands the synthesizer "9 A." then "M. to 5 P." — an audible
// stutter in the middle of exactly the kind of detail callers ring up to get.
const NOT_SENTENCE_END = /(?:^|[\s("'])(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|approx|Inc|Ltd|Co|No|a\.m|p\.m|A\.M|P\.M|e\.g|i\.e)\.$/;
const MIN_SENTENCE = 16;

/** Pull every COMPLETE sentence out of a growing buffer, leaving the partial
 *  tail behind. Only complete sentences are checked and spoken, so a rule can
 *  never be evaded by a phrase that straddles a network chunk boundary. */
function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i];
    if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < buf.length && /\s/.test(buf[i + 1])) {
      const cand = buf.slice(start, i + 1).trim();
      if (cand.length >= MIN_SENTENCE && !NOT_SENTENCE_END.test(cand)) {
        out.push(cand);
        let j = i + 1;
        while (j < buf.length && /\s/.test(buf[j])) j++;
        start = j; i = j;
        continue;
      }
    }
    i++;
  }
  return { sentences: out, rest: buf.slice(start) };
}

const personaCache = new Map<string, { persona: DePersona; at: number }>();
const PERSONA_TTL_MS = 60_000;

interface LiveStreamOpts {
  admin: SupabaseClient;
  model: string;
  llmBody: Record<string, unknown>;
  tenantId: string;
  deId: string;
  personaName: string;
  rulesP: Promise<{ data: PatternRule[] | null }>;
  extra: Record<string, string>;
  t0: number;
  /** When true, the final chunk carries an x_dreamteam diagnostic object.
   *  Gated by the gateway secret; the platform ignores unknown fields. */
  debug: boolean;
  /** True when the assistant's configured URL carries exercise=1 — a TEST
   *  assistant. Guardrail blocks it provokes are stamped origin='exercise'
   *  so they never count as trust evidence (mig 682; the 2026-08-04 voice
   *  spike's four unmarked blocks held a real DE's ladder for a month). */
  isExercise: boolean;
}

/**
 * The live turn: generate and speak SENTENCE BY SENTENCE.
 *
 * THE SEAM, streamed. Every sentence is matched against the tenant's blocking
 * guardrails BEFORE it is released for synthesis — nothing the caller hears
 * has gone unchecked, which is the whole reason this endpoint exists rather
 * than pointing the platform straight at a model.
 *
 * The check runs over everything cleared so far PLUS the new sentence, so a
 * phrase spanning two sentences is still caught. Earlier sentences were
 * already cleared, so any hit necessarily involves the newest one.
 *
 * ACCEPTED TRADE-OFF, stated plainly: audio cannot be recalled. When sentence
 * three trips a rule, the caller has already heard sentences one and two and
 * then hears the safe redirect. Whole-turn buffering (the non-streaming path
 * below) suppresses the entire reply instead. What holds identically in both:
 * the blocked text is never spoken, and a blocked turn never carries a tool
 * call. What streaming gives up is the surrounding context, in exchange for
 * removing several seconds of dead air from every single turn.
 */
function liveStream(o: LiveStreamOpts): Response {
  const id = `vt-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();

  const body = new ReadableStream({
    async start(c) {
      const send = (delta: Record<string, unknown>, finish: string | null = null) =>
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: o.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));

      let rules: PatternRule[] | null = null;
      let spoken = '';
      let pending = '';
      let blocked: PatternHit<PatternRule> | null = null;
      let firstAt = 0;
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

      /** Returns the offending rule, or null when the sentence is safe to speak. */
      const screen = async (sentence: string) => {
        if (!rules) rules = ((await o.rulesP).data ?? []).filter((r) => r.pattern);
        return findBlockingMatch(rules, `${spoken} ${sentence}`.trim());
      };
      const speak = (s: string) => {
        if (!firstAt) { firstAt = Date.now(); console.log(`[voice-turn] first sentence out at ${firstAt - o.t0}ms`); }
        spoken = `${spoken} ${s}`.trim();
        send({ content: s + ' ' });
      };

      send({ role: 'assistant' });
      const meta: LlmStreamMeta = {};
      const evTrace: string[] = [];
      try {
        for await (const ev of llmStream(o.admin, o.llmBody, 'voice-turn', o.tenantId, meta)) {
          if (o.debug && evTrace.length < 14) evTrace.push(`${Date.now() - o.t0}:${ev.type === 'text' ? JSON.stringify(ev.text) : ev.type}`);
          if (ev.type === 'tool_use') { toolCalls.push({ id: ev.id, name: ev.name, input: ev.input }); continue; }
          pending += ev.text;
          const { sentences, rest } = takeSentences(pending);
          pending = rest;
          for (const s of sentences) {
            const hit = await screen(s);
            if (hit) { blocked = hit; break; }
            speak(s);
          }
          if (blocked) break;
        }
        // The tail rarely ends in punctuation — flush it through the same check.
        if (!blocked && pending.trim()) {
          const hit = await screen(pending.trim());
          if (hit) blocked = hit;
          else speak(pending.trim());
        }
      } catch (e) {
        console.error(`[voice-turn] stream failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!spoken) send({ content: "I'm having trouble hearing our systems right now. Please call back in a few minutes." });
      }

      if (blocked) {
        toolCalls.length = 0; // a blocked turn acts on nothing
        send({ content: (spoken ? ' ' : '') + SAFE_REDIRECT });
        // The block already happened; this records it. A failure here must be
        // LOUD but must not take the call down — note that .rpc() returns a
        // thenable with no .catch, and resolves rather than rejects on a
        // Postgres error, so both are handled explicitly.
        try {
          const { error } = await o.admin.rpc('append_audit_event', {
            p_tenant_id: o.tenantId, p_actor: o.personaName, p_actor_type: 'de',
            p_action: `Guardrail blocked a voice utterance before synthesis — rule "${blocked.rule.rule}"`,
            p_category: 'guardrail_block',
            p_detail: { kind: 'voice_utterance_blocked', de_id: o.deId, rule_id: blocked.rule.id, channel: 'voice', streamed: true, spoken_before_block: spoken.length,
              origin: o.isExercise ? 'exercise' : 'production' },   // 682: a test-provoked block is the control being tested
          });
          if (error) console.error(`[voice-turn] GUARDRAIL BLOCK NOT AUDITED: ${error.message}`);
        } catch (e) {
          console.error(`[voice-turn] GUARDRAIL BLOCK NOT AUDITED: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Terminate cleanly no matter what happened above. An unterminated SSE
      // body is dead air on a live phone call — the one failure a voice system
      // must never have, and the reason this is a finally and not a tail.
      try {
        if (toolCalls.length) {
          toolCalls.forEach((t, i) => send({ tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }] }));
          send({}, 'tool_calls');
        } else {
          if (!spoken && !blocked) send({ content: 'One moment.' });
          send({}, 'stop');
        }
        console.log(`[voice-turn] served by ${meta.provider ?? '?'} (${meta.mode ?? '?'})${meta.why ? ` why=${meta.why}` : ''} first=${firstAt ? firstAt - o.t0 : -1}ms total=${Date.now() - o.t0}ms`);
        if (o.debug) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: o.model, choices: [], x_dreamteam: { ...meta, first_sentence_ms: firstAt ? firstAt - o.t0 : null, total_ms: Date.now() - o.t0, events: evTrace } })}\n\n`));
        }
        c.enqueue(enc.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error(`[voice-turn] failed to terminate stream: ${e instanceof Error ? e.message : String(e)}`);
      }
      try { c.close(); } catch { /* already closed or errored */ }
    },
  });

  return new Response(body, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...o.extra },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'post_only' }, 405);
  const t0 = Date.now();
  // Where the caller's wait actually goes. Latency is this spike's pass/fail
  // criterion, so the breakdown ships in every response rather than living in
  // a one-off script — you cannot tune what you cannot see.
  const mark: string[] = [];
  let last = t0;
  const at = (k: string) => { const n = Date.now(); mark.push(`${k}=${n - last}`); last = n; };
  const timings = () => ({ 'x-turn-ms': String(Date.now() - t0), 'x-turn-marks': mark.join(' ') });

  const secret = Deno.env.get('VOICE_GATEWAY_SECRET') ?? '';
  // Vapi can only present the secret where its dashboard allows: the model's
  // key arrives as Authorization: Bearer, the server URL's as x-vapi-secret.
  // Accept any of the three; it is the same single low-privilege secret.
  const given = req.headers.get('x-voice-secret')
    ?? req.headers.get('x-vapi-secret')
    ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !(await secureEqual(secret, given))) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  // Vapi appends /chat/completions to the WHOLE configured URL — including
  // after the query string — so the last param arrives as
  // "<uuid>/chat/completions". Take the leading uuid; refuse anything that
  // does not start with one.
  const uuidOf = (v: string | null) => (v ?? '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? '';
  const tenantId = uuidOf(url.searchParams.get('tenant'));
  const deId = uuidOf(url.searchParams.get('de'));
  // Configured per assistant, like tenant/de: a TEST assistant's URL carries
  // exercise=1; production assistants never do. See LiveStreamOpts.isExercise.
  const isExercise = url.searchParams.get('exercise') === '1';
  if (!tenantId || !deId) {
    return json({ error: 'tenant_and_de_required' }, 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const wantStream = body?.stream === true;
  const model = String(body?.model ?? 'claude-haiku-4-5-20251001');

  // Resolving the provider chain costs ten key lookups through Vault — measured
  // at 0.4-1.4s, and until now it was paid INSIDE the model call, where it read
  // as model latency. Start it here so it runs behind the tenant and persona
  // queries and is a warm cache hit by the time generation begins.
  const warm = hasLLMProvider(admin, tenantId).catch(() => false);

  // A dormant workspace's number stays polite and inert.
  const gate = await loadTenantGate(admin, tenantId);
  at('gate');
  if (gate.suspended) {
    return wantStream ? staticStream(model, UNAVAILABLE, []) : json(oaiResponse(model, UNAVAILABLE, []));
  }

  // A DE's identity does not change mid-call, but resolving it costs two more
  // round trips — measured at 0.4-1.0s, paid on every single turn. Cache it for
  // the length of a call. The suspension gate above is deliberately NOT cached:
  // it is a control, and it stays fresh every turn.
  const personaKey = `${tenantId}:${deId}`;
  const cachedPersona = personaCache.get(personaKey);
  const persona = cachedPersona && Date.now() - cachedPersona.at < PERSONA_TTL_MS
    ? cachedPersona.persona
    : await resolveDePersona(admin, tenantId, deId, gate.name);
  if (persona !== cachedPersona?.persona) personaCache.set(personaKey, { persona, at: Date.now() });
  at('persona');
  const { system, msgs } = toAnthropic((body?.messages ?? []) as OaiMsg[]);

  // The seam's rules are fetched CONCURRENTLY with generation. The check still
  // runs before a single byte is returned — only its round-trip stops being
  // charged to the caller's silence.
  const rulesP = admin.from('guardrail_rules')
    .select('id, rule, pattern, rule_type, severity, applies_to')
    .eq('tenant_id', tenantId).eq('active', true).eq('severity', 'blocking')
    .then((r) => r, () => ({ data: null }));

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
  await warm;
  at('chain');

  // Tenant-scoped, so a BYO workspace's own key serves its calls. Safe again
  // since mig 575: plain key-absence falls through to the platform path
  // (platform_config, then env), and only a considered BYO refusal blocks —
  // so env-only providers (Bedrock) stay in the failover chain.

  // The live path: speak each sentence as it clears the seam. Nothing below
  // this line is reached on a real call — the platform always streams.
  if (wantStream) {
    return liveStream({
      admin, model, llmBody, tenantId, deId,
      personaName: persona.name, rulesP, t0,
      debug: req.headers.get('x-voice-debug') === secret,
      extra: timings(),
      isExercise,
    });
  }

  // Whole-turn path: kept for harnesses and any platform that cannot stream.
  // Its seam is strictly stronger (the entire reply is suppressed on a hit),
  // at the cost of the dead air this whole exercise exists to remove.
  const res = await llmMessages(admin, llmBody, 'voice-turn', tenantId);
  at('llm');
  if (!res.ok) {
    // Secret-gated diagnostics: same header value as auth, different header
    // name — never reachable without the gateway secret, never spoken.
    if (req.headers.get('x-voice-debug') === secret) {
      return json({ debug: true, upstream_status: res.status, upstream: await res.text() }, 200);
    }
    // The failover chain is exhausted — say so like a phone system, not an API.
    const line = "I'm having trouble hearing our systems right now. Please call back in a few minutes.";
    return json(oaiResponse(model, line, []));
  }
  const out = await res.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  let text = (out.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
  const toolCalls = (out.content ?? []).filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? `tc-${crypto.randomUUID()}`, name: b.name ?? '', input: b.input ?? {} }));

  // ── THE SEAM: blocking guardrails on the full utterance, before synthesis. ──
  if (text) {
    const { data: rules } = await rulesP;
    const hit = findBlockingMatch((rules ?? []).filter((r) => r.pattern), text);
    if (hit) {
      await rpcLoud(admin, 'append_audit_event', {
        p_tenant_id: tenantId, p_actor: persona.name, p_actor_type: 'de',
        p_action: `Guardrail blocked a voice utterance before synthesis — rule "${hit.rule.rule}"`,
        p_category: 'guardrail_block',
        p_detail: { kind: 'voice_utterance_blocked', de_id: deId, rule_id: hit.rule.id, channel: 'voice',
          origin: isExercise ? 'exercise' : 'production' },   // 682
      });
      text = SAFE_REDIRECT;
      // A blocked turn never carries tool calls either — nothing acts on it.
      toolCalls.length = 0;
    }
  }

  at('guard');
  const latency = timings();
  return json(oaiResponse(model, toolCalls.length ? null : (text || 'One moment.'), toolCalls), 200, latency);
});
