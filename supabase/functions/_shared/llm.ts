/**
 * llm — the ONE shared model client for every brain function.
 *
 * Before this module, 18 edge functions each hand-rolled a fetch to
 * api.anthropic.com — the deep audit's #1 structural gap, and the reason
 * an Anthropic org outage takes every Digital Employee offline at once.
 *
 * This client speaks the Anthropic Messages API shape on BOTH sides
 * (callers keep building anthropic-style bodies and reading
 * content/stop_reason/usage) and walks a provider chain under the hood:
 *
 *   1. anthropic  — Anthropic direct (primary)
 *   2. bedrock    — the SAME Claude models via Amazon Bedrock (zero
 *                   behavior drift; separate billing/credentials)
 *   3. openai     — optional cross-vendor fallback (translated)
 *   4. google     — optional cross-vendor fallback (Gemini, translated)
 *
 * A provider is in the chain only when its key is configured (Settings →
 * AI Engine, or env). Failover advances on auth/org problems (401/403),
 * throttling (408/429), outages (5xx/529) and network errors — NEVER on
 * 400s, which are our own request bugs and must stay visible. The first
 * provider's error is what callers see when the whole chain fails, so
 * today's error surfaces are unchanged.
 *
 * Cross-vendor caveat (told to the founder, kept honest here): OpenAI /
 * Gemini answers come from a different brain — certifications and
 * calibration were earned on Claude. They are OPT-IN tiers for
 * keep-the-lights-on continuity, not equivalents. Token usage is still
 * recorded against the caller's requested model id, so cost attribution
 * under cross-vendor failover is approximate.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { getAIKey, getAIKeys } from './aiKeys.ts';

type Provider = 'anthropic' | 'bedrock' | 'openai' | 'google';

interface ChainConfig {
  providers: Provider[];
  anthropicKey?: string;
  bedrockKey?: string;
  bedrockRegion: string;
  bedrockModelPrefix: string;
  bedrockModelMap: Record<string, string>;
  openaiKey?: string;
  openaiModel: string;
  googleKey?: string;
  googleModel: string;
}

// Chain resolution hits platform_config (Vault) — cache it briefly so
// multi-turn loops (de-work runs up to 6 turns per item) pay once.
// KEYED BY TENANT (mig 541). This was a single module-level cache, which was
// correct only while every tenant shared one key: the moment workspaces bring
// their own, a global cache serves tenant A's credential to tenant B for up to
// a minute. The key is the tenant id (or '' for platform-level callers).
const chainCache = new Map<string, { chain: ChainConfig; at: number }>();
const CHAIN_TTL_MS = 60_000;

async function resolveChain(admin: SupabaseClient, tenantId?: string | null): Promise<ChainConfig> {
  const cacheKey = tenantId ?? '';
  const hit = chainCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.chain;
  // ONE round trip for the whole chain (mig 576). This was ten concurrent
  // per-key resolutions, and each key that resolved to "absent" then made two
  // more calls with a 400ms sleep between them — measured at 0.6-1.2s per LLM
  // call, which is inaudible in chat and is dead air on a phone call.
  const k = await getAIKeys(admin, [
    'ANTHROPIC_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_REGION', 'BEDROCK_MODEL_PREFIX',
    'BEDROCK_MODEL_MAP', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'GOOGLE_AI_KEY',
    'GOOGLE_AI_MODEL', 'LLM_PROVIDER_ORDER',
  ], tenantId);
  const anthropicKey = k.ANTHROPIC_API_KEY, bedrockKey = k.BEDROCK_API_KEY;
  const bedrockRegion = k.BEDROCK_REGION, bedrockModelPrefix = k.BEDROCK_MODEL_PREFIX;
  const bedrockModelMapRaw = k.BEDROCK_MODEL_MAP;
  const openaiKey = k.OPENAI_API_KEY, openaiModel = k.OPENAI_MODEL;
  const googleKey = k.GOOGLE_AI_KEY, googleModel = k.GOOGLE_AI_MODEL;
  const order = k.LLM_PROVIDER_ORDER;
  const available: Provider[] = [];
  if (anthropicKey) available.push('anthropic');
  if (bedrockKey) available.push('bedrock');
  if (openaiKey) available.push('openai');
  if (googleKey) available.push('google');
  // Optional reorder/subset via config, e.g. "bedrock,anthropic" while an
  // org issue is being resolved. Unknown names are ignored; providers
  // without keys can't be forced in.
  let providers = available;
  if (order) {
    const wanted = order.split(',').map((s) => s.trim().toLowerCase()).filter((s): s is Provider => available.includes(s as Provider));
    if (wanted.length > 0) providers = wanted;
  }
  // Exact-ID overrides beat the prefix rule — Bedrock's catalog mixes
  // suffixless new-generation IDs with dated "-v1:0" legacy ones, so a
  // single prefix cannot cover a mixed model estate.
  let bedrockModelMap: Record<string, string> = {};
  if (bedrockModelMapRaw) {
    try { bedrockModelMap = JSON.parse(bedrockModelMapRaw); } catch { bedrockModelMap = {}; }
  }
  const chain: ChainConfig = {
    providers,
    anthropicKey, bedrockKey, openaiKey, googleKey,
    bedrockModelMap,
    bedrockRegion: bedrockRegion || 'us-east-1',
    // Bedrock model ids carry a provider prefix; some accounts must route
    // via inference profiles instead ("us.anthropic." / "global.anthropic.").
    bedrockModelPrefix: bedrockModelPrefix || 'anthropic.',
    openaiModel: openaiModel || 'gpt-5.1',
    googleModel: googleModel || 'gemini-2.5-pro',
  };
  chainCache.set(cacheKey, { chain, at: Date.now() });
  return chain;
}

/** True when at least one provider key is configured — the "is the brain wired" gate. */
export async function hasLLMProvider(admin: SupabaseClient, tenantId?: string | null): Promise<boolean> {
  return (await resolveChain(admin, tenantId)).providers.length > 0;
}

// ── Anthropic-shape helpers ──────────────────────────────────────────────

type Block = Record<string, unknown>;
type Msg = { role: string; content: unknown };

function systemToText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => String((b as Block).text ?? '')).join('\n\n');
  return '';
}

function blockContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => String((b as Block).text ?? JSON.stringify(b))).join('\n');
  if (content == null) return '';
  return JSON.stringify(content);
}

function stripCacheControl<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripCacheControl) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'cache_control') continue;
      out[k] = stripCacheControl(val);
    }
    return out as T;
  }
  return v;
}

// ── OpenAI translation ───────────────────────────────────────────────────

function toOpenAIBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Msg[] = [];
  const sys = systemToText(body.system);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of (body.messages as Msg[] ?? [])) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = (m.content as Block[]) ?? [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: String(b.id), type: 'function',
        function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg as Msg);
    } else {
      // Anthropic packs tool_results into the next user message; OpenAI
      // wants one role:"tool" message per result, before any user text.
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', content: blockContentToText(b.content), tool_call_id: String(b.tool_use_id) } as unknown as Msg);
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  const req: Record<string, unknown> = { model, messages: out, max_completion_tokens: Number(body.max_tokens ?? 1024) };
  const tools = body.tools as Block[] | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    req.tools = stripCacheControl(tools).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } },
    }));
  }
  return req;
}

function fromOpenAI(d: Record<string, unknown>, requestedModel: string): Record<string, unknown> {
  const choice = (d.choices as Array<Record<string, unknown>>)?.[0] ?? {};
  const msg = (choice.message as Record<string, unknown>) ?? {};
  const content: Block[] = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls as Array<Record<string, unknown>> ?? [])) {
    const fn = tc.function as Record<string, unknown> ?? {};
    let input: unknown = {};
    try { input = JSON.parse(String(fn.arguments ?? '{}')); } catch { input = {}; }
    content.push({ type: 'tool_use', id: String(tc.id), name: String(fn.name), input });
  }
  const finish = String(choice.finish_reason ?? '');
  const usage = (d.usage as Record<string, unknown>) ?? {};
  return {
    id: d.id ?? `msg_openai_${crypto.randomUUID()}`,
    model: requestedModel, provider_model: d.model,
    content,
    stop_reason: finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) },
  };
}

// ── Gemini translation ───────────────────────────────────────────────────

function cleanSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'additionalProperties' || k === '$schema' || k === 'cache_control') continue;
      out[k] = cleanSchema(val);
    }
    return out;
  }
  return v;
}

function toGeminiBody(body: Record<string, unknown>): Record<string, unknown> {
  // tool_result blocks reference tool_use ids; Gemini functionResponse
  // needs the function NAME — build the id→name map across the transcript.
  const nameById: Record<string, string> = {};
  for (const m of (body.messages as Msg[] ?? [])) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Block[]) {
        if (b.type === 'tool_use' && b.id) nameById[String(b.id)] = String(b.name);
      }
    }
  }
  const contents: Array<Record<string, unknown>> = [];
  for (const m of (body.messages as Msg[] ?? [])) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const b of (m.content as Block[]) ?? []) {
        if (b.type === 'text' && b.text) parts.push({ text: String(b.text) });
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: String(b.name), args: b.input ?? {} } });
        else if (b.type === 'tool_result') parts.push({ functionResponse: { name: nameById[String(b.tool_use_id)] ?? 'tool', response: { result: blockContentToText(b.content) } } });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  const req: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: Number(body.max_tokens ?? 1024) },
  };
  const sys = systemToText(body.system);
  if (sys) req.systemInstruction = { parts: [{ text: sys }] };
  const tools = body.tools as Block[] | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    req.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? '', parameters: cleanSchema(t.input_schema ?? { type: 'object' }) })) }];
  }
  return req;
}

function fromGemini(d: Record<string, unknown>, requestedModel: string): Record<string, unknown> | null {
  const cand = (d.candidates as Array<Record<string, unknown>>)?.[0];
  if (!cand) return null; // safety block / empty — treat as provider failure
  const parts = ((cand.content as Record<string, unknown>)?.parts as Array<Record<string, unknown>>) ?? [];
  const content: Block[] = [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => String(p.text)).join('');
  if (text) content.push({ type: 'text', text });
  let hasTool = false;
  for (const p of parts) {
    const fc = p.functionCall as Record<string, unknown> | undefined;
    if (fc) { hasTool = true; content.push({ type: 'tool_use', id: `toolu_gm_${crypto.randomUUID().slice(0, 12)}`, name: String(fc.name), input: fc.args ?? {} }); }
  }
  const um = (d.usageMetadata as Record<string, unknown>) ?? {};
  return {
    id: `msg_gemini_${crypto.randomUUID()}`,
    model: requestedModel, provider_model: d.modelVersion,
    content,
    stop_reason: hasTool ? 'tool_use' : String(cand.finishReason ?? '') === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: Number(um.promptTokenCount ?? 0), output_tokens: Number(um.candidatesTokenCount ?? 0) },
  };
}

// ── The chain walker ─────────────────────────────────────────────────────

const ADVANCE_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504, 529]);

function jsonResponse(payload: unknown, status: number, provider: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'x-llm-provider': provider },
  });
}

/**
 * Drop-in replacement for `fetch('https://api.anthropic.com/v1/messages', …)`.
 * Takes the anthropic-shaped body object (NOT pre-stringified), returns a
 * Response whose JSON is always anthropic-shaped regardless of the provider
 * that served it. `label` names the caller in failover logs.
 */
export async function llmMessages(admin: SupabaseClient, body: Record<string, unknown>, label = 'llm', tenantId?: string | null): Promise<Response> {
  const cfg = await resolveChain(admin, tenantId);
  if (cfg.providers.length === 0) {
    return jsonResponse({ type: 'error', error: { type: 'authentication_error',
      message: tenantId
        ? 'No AI engine key is configured for this workspace (Settings → AI Engine). If this workspace brings its own key, add it there.'
        : 'No AI engine key configured (Settings → AI Engine).' } }, 401, 'none');
  }
  let firstFailure: { status: number; text: string; provider: Provider } | null = null;

  for (let i = 0; i < cfg.providers.length; i++) {
    const provider = cfg.providers[i];
    let res: Response;
    try {
      if (provider === 'anthropic') {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': cfg.anthropicKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          if (i > 0) await noteFailover(admin, firstFailure, provider, label);
          return jsonResponse(await res.json(), 200, provider);
        }
      } else if (provider === 'bedrock') {
        // Bedrock serves the SAME Messages API body/response for Claude —
        // model moves to the URL, anthropic_version moves into the body.
        const { model: _m, ...rest } = body;
        const requested = String(body.model ?? '');
        const bedrockModel = cfg.bedrockModelMap[requested] ?? `${cfg.bedrockModelPrefix}${requested}`;
        console.log(`[llm] ${label}: bedrock invoking ${bedrockModel} in ${cfg.bedrockRegion}`);
        res = await fetch(`https://bedrock-runtime.${cfg.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(bedrockModel)}/invoke`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.bedrockKey!}`, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...rest }),
        });
        if (res.ok) {
          const d = await res.json();
          if (i > 0) await noteFailover(admin, firstFailure, provider, label);
          return jsonResponse({ model: body.model, ...d }, 200, provider);
        }
      } else if (provider === 'openai') {
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.openaiKey!}`, 'content-type': 'application/json' },
          body: JSON.stringify(toOpenAIBody(body, cfg.openaiModel)),
        });
        if (res.ok) {
          if (i > 0) await noteFailover(admin, firstFailure, provider, label);
          return jsonResponse(fromOpenAI(await res.json(), String(body.model ?? cfg.openaiModel)), 200, provider);
        }
      } else {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.googleModel}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': cfg.googleKey!, 'content-type': 'application/json' },
          body: JSON.stringify(toGeminiBody(body)),
        });
        if (res.ok) {
          const normalized = fromGemini(await res.json(), String(body.model ?? cfg.googleModel));
          if (normalized) {
            if (i > 0) await noteFailover(admin, firstFailure, provider, label);
            return jsonResponse(normalized, 200, provider);
          }
          // safety-blocked/empty candidate — treat like a provider failure
          if (!firstFailure) firstFailure = { status: 502, text: '{"error":{"message":"gemini returned no candidates"}}', provider };
          continue;
        }
      }
    } catch (e) {
      // network-level failure — advance the chain
      console.error(`[llm] ${label}: ${provider} network error: ${e instanceof Error ? e.message : String(e)}`);
      if (!firstFailure) firstFailure = { status: 503, text: JSON.stringify({ type: 'error', error: { type: 'api_error', message: `network error reaching ${provider}` } }), provider };
      continue;
    }

    const text = await res.text();
    console.error(`[llm] ${label}: ${provider} ${res.status}: ${text.slice(0, 300)}`);
    if (!firstFailure) firstFailure = { status: res.status, text, provider };
    // 400/404/413/422 = OUR request is malformed for this provider. From the
    // primary, surface it (masking it behind a fallback hides real bugs);
    // from a fallback provider (translation/model-id mismatch), keep walking.
    if (!ADVANCE_STATUSES.has(res.status) && i === 0) {
      return jsonResponse(safeParse(text), res.status, provider);
    }
  }

  const f = firstFailure!;
  return jsonResponse(safeParse(f.text), f.status, f.provider);
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return { type: 'error', error: { type: 'api_error', message: text.slice(0, 500) } }; }
}

// ── Streaming ────────────────────────────────────────────────────────────
//
// Built for the voice channel, where the whole product is time-to-first-word:
// a caller hears silence until the FIRST sentence is ready, so generating the
// whole turn before returning anything costs seconds of dead air. Callers that
// only need the finished answer should keep using llmMessages.
//
// Anthropic and Bedrock stream; OpenAI and Gemini stay unary here and are
// reached through the llmMessages fallback at the bottom, so the failover
// chain is unchanged — only its fastest two tiers gained a faster shape.

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** UTF-8-safe base64 decode. atob() yields a binary string; decoding it as
 *  Latin-1 would mangle every non-ASCII character — and tenants configure
 *  their own reply language, so this is a correctness issue, not a nicety. */
function b64ToText(b64: string, dec: TextDecoder): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

/** AWS event-stream framing (application/vnd.amazon.eventstream), which is
 *  what Bedrock's invoke-with-response-stream returns:
 *
 *    [u32 total][u32 headersLen][u32 preludeCrc][headers][payload][u32 crc]
 *
 *  The payload is {"bytes": base64(<one Anthropic SSE event>)} — so once
 *  unwrapped, both providers speak the identical event vocabulary. CRCs are a
 *  transport integrity check that TLS already gives us; a frame that does not
 *  parse ends the stream rather than being silently skipped forever. */
async function* awsEventFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (value?.length) {
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf); next.set(value, buf.length);
      buf = next;
    }
    for (;;) {
      if (buf.length < 16) break;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const total = dv.getUint32(0);
      // A frame length outside any sane bound means we have lost sync with the
      // framing; continuing would emit garbage as speech.
      if (total < 16 || total > 1 << 24) return;
      if (buf.length < total) break;
      const headersLen = dv.getUint32(4);
      const payload = buf.slice(12 + headersLen, total - 4);
      buf = buf.slice(total);
      try {
        const wrapper = JSON.parse(dec.decode(payload)) as { bytes?: string };
        if (typeof wrapper.bytes === 'string') yield b64ToText(wrapper.bytes, dec);
      } catch { /* ping / exception frame — not a content chunk */ }
    }
    if (done) break;
  }
}

/** `data:` payloads from a text/event-stream body (Anthropic direct). */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
    if (done) break;
  }
}

/** Anthropic Messages streaming events → normalized deltas. Tool calls arrive
 *  as fragmented JSON across many events, so they are assembled and emitted
 *  whole at content_block_stop — a half-parsed tool call must never escape. */
async function* anthropicEvents(src: AsyncGenerator<string>): AsyncGenerator<LlmStreamEvent> {
  const building = new Map<number, { id: string; name: string; json: string }>();
  for await (const raw of src) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch { continue; }
    const idx = Number(ev.index ?? -1);
    if (ev.type === 'content_block_start') {
      const cb = (ev.content_block ?? {}) as Record<string, unknown>;
      if (cb.type === 'tool_use') building.set(idx, { id: String(cb.id ?? ''), name: String(cb.name ?? ''), json: '' });
    } else if (ev.type === 'content_block_delta') {
      const d = (ev.delta ?? {}) as Record<string, unknown>;
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        if (d.text) yield { type: 'text', text: d.text };
      } else if (d.type === 'input_json_delta') {
        const b = building.get(idx);
        if (b) b.json += String(d.partial_json ?? '');
      }
    } else if (ev.type === 'content_block_stop') {
      const b = building.get(idx);
      if (b) {
        let input: unknown = {};
        try { input = JSON.parse(b.json || '{}'); } catch { input = {}; }
        yield { type: 'tool_use', id: b.id || `toolu_${crypto.randomUUID().slice(0, 12)}`, name: b.name, input };
        building.delete(idx);
      }
    }
  }
}

/**
 * Streaming twin of llmMessages: same anthropic-shaped body in, normalized
 * deltas out, same provider chain and same failover rules.
 *
 * Throws only when the entire chain is exhausted — callers must handle that,
 * because unlike llmMessages there is no Response object to inspect. Once the
 * first event has been yielded the provider is committed: a mid-stream failure
 * ends the turn with whatever was already produced rather than restarting on
 * another provider, which would duplicate speech the caller already heard.
 */
export interface LlmStreamMeta {
  /** Which provider served the turn. */
  provider?: string;
  /** 'stream' = incremental; 'unary' = whole-answer fallback (no latency win). */
  mode?: 'stream' | 'unary';
  /** Why streaming was not used, when it was not. */
  why?: string;
  /** ms until the provider returned response HEADERS. */
  headersMs?: number;
  /** ms until the FIRST content event. A large gap between this and headersMs
   *  means the body was buffered somewhere rather than delivered as it was
   *  produced — the difference between a real stream and a fake one. */
  firstEventMs?: number;
}

export async function* llmStream(
  admin: SupabaseClient, body: Record<string, unknown>, label = 'llm', tenantId?: string | null,
  meta: LlmStreamMeta = {},
): AsyncGenerator<LlmStreamEvent> {
  const cfg = await resolveChain(admin, tenantId);
  const tStart = Date.now();
  for (let i = 0; i < cfg.providers.length; i++) {
    const provider = cfg.providers[i];
    if (provider !== 'anthropic' && provider !== 'bedrock') break; // unary tiers — handled by the fallback
    let res: Response;
    try {
      if (provider === 'anthropic') {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': cfg.anthropicKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, stream: true }),
        });
        if (res.ok && res.body) {
          if (i > 0) await noteFailover(admin, null, provider, `${label}:stream`);
          meta.provider = provider; meta.mode = 'stream'; meta.headersMs = Date.now() - tStart;
          for await (const ev of anthropicEvents(sseData(res.body))) {
            if (meta.firstEventMs === undefined) meta.firstEventMs = Date.now() - tStart;
            yield ev;
          }
          return;
        }
      } else {
        const { model: _m, ...rest } = body;
        const requested = String(body.model ?? '');
        const bedrockModel = cfg.bedrockModelMap[requested] ?? `${cfg.bedrockModelPrefix}${requested}`;
        res = await fetch(`https://bedrock-runtime.${cfg.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(bedrockModel)}/invoke-with-response-stream`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.bedrockKey!}`, 'content-type': 'application/json' },
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...rest }),
        });
        if (res.ok && res.body) {
          if (i > 0) await noteFailover(admin, null, provider, `${label}:stream`);
          meta.provider = provider; meta.mode = 'stream'; meta.headersMs = Date.now() - tStart;
          for await (const ev of anthropicEvents(awsEventFrames(res.body))) {
            if (meta.firstEventMs === undefined) meta.firstEventMs = Date.now() - tStart;
            yield ev;
          }
          return;
        }
      }
      const detail = (await res.text()).slice(0, 300);
      console.error(`[llm] ${label}: ${provider} stream ${res.status}: ${detail}`);
      if (!meta.why) meta.why = `${provider}:${res.status}:${detail.slice(0, 160)}`;
      // A 400 here is our own malformed request — walking the chain would just
      // hide it. Drop to the unary fallback, which surfaces it properly.
      if (!ADVANCE_STATUSES.has(res.status)) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[llm] ${label}: ${provider} stream network error: ${msg}`);
      if (!meta.why) meta.why = `${provider}:network:${msg.slice(0, 160)}`;
    }
  }

  // Nothing streamed — fall back to the full unary chain so a stream-capable
  // provider being down still lands on OpenAI/Gemini rather than dropping the call.
  meta.mode = 'unary';
  const res = await llmMessages(admin, body, `${label}:unary-fallback`, tenantId);
  meta.provider = res.headers.get('x-llm-provider') ?? 'unknown';
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`llm_chain_exhausted status=${res.status} ${detail.slice(0, 200)}`);
  }
  const out = await res.json() as { content?: Array<Record<string, unknown>> };
  for (const b of out.content ?? []) {
    if (b.type === 'text' && b.text) yield { type: 'text', text: String(b.text) };
    else if (b.type === 'tool_use') yield { type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input ?? {} };
  }
}

// Failover is rare and worth a durable trace: the Settings page reads
// LLM_LAST_FAILOVER to show which engine answered last and why. Best-effort —
// a config write must never break an answer that a fallback just rescued.
async function noteFailover(admin: SupabaseClient, first: { status: number; provider: Provider } | null, served: Provider, label: string): Promise<void> {
  console.warn(`[llm] ${label}: FAILOVER — ${first?.provider ?? 'primary'} failed (${first?.status ?? '?'}), served by ${served}`);
  try {
    await admin.rpc('platform_config_set', {
      p_entries: { LLM_LAST_FAILOVER: JSON.stringify({ at: new Date().toISOString(), from: first?.provider ?? 'primary', from_status: first?.status ?? 0, served_by: served, label }) },
    });
  } catch { /* observability only */ }
}
