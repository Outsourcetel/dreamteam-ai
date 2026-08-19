// ============================================================
// The one-shot model call — one implementation.
//
// Six functions each declared their own `callModel`: ai-session,
// compile-trust-plan, entity-amend, entity-draft, playbook-amend and
// playbook-draft. All six already went through the shared failover client
// (_shared/llm.ts), so the FAILOVER was never at risk — what drifted was
// everything around it:
//
//   • entity-amend and ai-session returned `llm_http_${status}` with NO
//     response body, so a provider failure there told you the status code and
//     nothing else, while the other four quoted what the provider actually
//     said. That is the difference between a diagnosable incident and a shrug.
//   • max_tokens defaults ranged 2048–4096 with no pattern
//   • two took a user string, one took a messages array, one took tools
//
// These are FACTORIES rather than plain functions on purpose: each caller binds
// its own label and defaults once, and keeps the exact positional signature it
// already had. Seventeen call sites across six live functions therefore did not
// change at all — the smallest possible blast radius for a consolidation.
// ============================================================
// ⚠ Must track the SAME pin as ./llm.ts, which this file hands `admin` to.
// This was the lone `@2.45.4` in a tree where the other 69 imports are `@2`;
// supabase-js widened SupabaseClient's generics between those versions (3 type
// params → 5), so the stale pin made the two files disagree about a type they
// pass between them. That produced 2 permanently-unattributed errors here, and
// a third the moment any function on `@2` (brand-extract) passed a client in.
// Type-only import: no runtime change.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { llmMessages } from './llm.ts';

const DEFAULT_MODEL = 'claude-sonnet-5';

export interface ModelUsage { inTok: number; outTok: number }
export type ModelTextResult = { text: string; inTok: number; outTok: number } | { error: string };
export type ModelBlocksResult =
  | { blocks: unknown[]; stop: string; inTok: number; outTok: number }
  | { error: string };

type MessageLike = { role: string; content: unknown };

/** Always quote what the provider said. A bare status code is not a diagnosis. */
async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return body ? `llm_http_${res.status}: ${body.slice(0, 200)}` : `llm_http_${res.status}`;
}

function usageOf(d: Record<string, unknown>): ModelUsage {
  const u = (d?.usage ?? {}) as Record<string, unknown>;
  return { inTok: Number(u.input_tokens ?? 0), outTok: Number(u.output_tokens ?? 0) };
}

function joinText(d: Record<string, unknown>): string {
  const content = (d?.content ?? []) as Array<{ type?: string; text?: string }>;
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

/** A caller that wants the model's prose. `input` accepts either a user string
 *  (wrapped as a single user turn) or a ready-made messages array. */
export function makeCallModelText(
  label: string,
  defaultMaxTokens: number,
  opts: { model?: string; temperature?: number } = {},
) {
  return async function callModel(
    admin: SupabaseClient,
    system: string,
    input: string | MessageLike[],
    maxTokens: number = defaultMaxTokens,
    // ⚠ WHOSE KEY PAYS. Omit it and llmMessages resolves the PLATFORM chain —
    // which is silently wrong for any caller that gated on a tenant having its
    // own provider. Optional so existing callers keep their current behaviour.
    tenantId?: string | null,
  ): Promise<ModelTextResult> {
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    const body: Record<string, unknown> = {
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const res = await llmMessages(admin, body, label, tenantId);
    if (!res.ok) return { error: await describeFailure(res) };
    const d = await res.json();
    return { text: joinText(d), ...usageOf(d) };
  };
}

/** A caller running a TOOL-USE loop, which needs the raw content blocks and the
 *  stop reason rather than joined prose. Deliberately a separate shape: folding
 *  it into the text variant would have thrown away exactly what it exists for. */
export function makeCallModelBlocks(
  label: string,
  defaultMaxTokens: number,
  defaultTools: unknown[] = [],
  opts: { model?: string } = {},
) {
  return async function callModel(
    admin: SupabaseClient,
    system: string,
    messages: MessageLike[],
    tools: unknown[] = defaultTools,
  ): Promise<ModelBlocksResult> {
    const res = await llmMessages(admin, {
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: defaultMaxTokens,
      system,
      tools,
      messages,
    }, label);
    if (!res.ok) return { error: await describeFailure(res) };
    const d = await res.json();
    return {
      blocks: (d.content ?? []) as unknown[],
      stop: String(d.stop_reason ?? ''),
      ...usageOf(d),
    };
  };
}
