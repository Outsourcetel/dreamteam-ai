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
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from './aiKeys.ts';

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
let cachedChain: ChainConfig | null = null;
let cachedAt = 0;
const CHAIN_TTL_MS = 60_000;

async function resolveChain(admin: SupabaseClient): Promise<ChainConfig> {
  if (cachedChain && Date.now() - cachedAt < CHAIN_TTL_MS) return cachedChain;
  const [anthropicKey, bedrockKey, bedrockRegion, bedrockModelPrefix, bedrockModelMapRaw, openaiKey, openaiModel, googleKey, googleModel, order] = await Promise.all([
    getAIKey(admin, 'ANTHROPIC_API_KEY'),
    getAIKey(admin, 'BEDROCK_API_KEY'),
    getAIKey(admin, 'BEDROCK_REGION'),
    getAIKey(admin, 'BEDROCK_MODEL_PREFIX'),
    getAIKey(admin, 'BEDROCK_MODEL_MAP'),
    getAIKey(admin, 'OPENAI_API_KEY'),
    getAIKey(admin, 'OPENAI_MODEL'),
    getAIKey(admin, 'GOOGLE_AI_KEY'),
    getAIKey(admin, 'GOOGLE_AI_MODEL'),
    getAIKey(admin, 'LLM_PROVIDER_ORDER'),
  ]);
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
  cachedChain = {
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
  cachedAt = Date.now();
  return cachedChain;
}

/** True when at least one provider key is configured — the new "is the brain wired" gate. */
export async function hasLLMProvider(admin: SupabaseClient): Promise<boolean> {
  return (await resolveChain(admin)).providers.length > 0;
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
export async function llmMessages(admin: SupabaseClient, body: Record<string, unknown>, label = 'llm'): Promise<Response> {
  const cfg = await resolveChain(admin);
  if (cfg.providers.length === 0) {
    return jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'No AI engine key configured (Settings → AI Engine).' } }, 401, 'none');
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
