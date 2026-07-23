/**
 * identityMemory — the per-turn gate for cross-conversation (identity) memory.
 *
 * T2.3 wiring on the shipped crypto foundation (migs 275-277). A verified caller
 * (widget HMAC, or a DMARC-aligned email later) can have durable memory that
 * follows them across conversations — but ONLY when THIS request proved their
 * identity. The gate consumes the per-turn verify_and_bind result, NEVER the
 * stored de_conversations row (a persisted flag would let a reused convId or a
 * forged message inherit a stranger's identity — the adversary's core critical).
 *
 * subject_ref is the method-namespaced memory_ref the RPC returns (e.g.
 * 'widget_hmac:alice@acme.com') so identities from different trust methods never
 * stitch into one bucket. If the turn isn't verified (no secret configured, bad
 * hash, blank ref, identity_conflict, …) recall returns [] and remember no-ops —
 * anonymous sessions keep exactly today's conversation-scoped behavior.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// The shape verify_and_bind_widget_identity (mig 277) returns.
export interface IdentityVerdict {
  verified: boolean;
  reason?: string;
  method?: string;
  verified_key?: string;
  memory_ref?: string;   // method-namespaced subject_ref, e.g. 'widget_hmac:<key>'
  account_id?: string | null;
}

/** True only when this turn is verified AND carries a usable memory_ref. */
export function identityActive(v: IdentityVerdict | null | undefined): v is IdentityVerdict {
  return !!v && v.verified === true && typeof v.memory_ref === 'string' && v.memory_ref.trim().length > 0;
}

export interface MemoryItem { content: string }

/**
 * Recall durable memory for the verified caller across their conversations.
 * No-op (returns []) unless the turn is verified. Never throws — memory is
 * best-effort context, never allowed to break an answer.
 */
export async function recallIdentityMemory(
  admin: SupabaseClient,
  opts: { tenantId: string; deId: string; queryEmbedding: number[] | null; verdict: IdentityVerdict | null; matchCount?: number },
): Promise<MemoryItem[]> {
  if (!identityActive(opts.verdict) || !opts.deId || !opts.queryEmbedding) return [];
  try {
    const { data } = await admin.rpc('de_memory_search', {
      p_tenant_id: opts.tenantId, p_de_id: opts.deId, p_query_embedding: opts.queryEmbedding,
      p_subject_kind: 'identity', p_subject_ref: opts.verdict.memory_ref, p_kinds: null,
      p_match_count: opts.matchCount ?? 5,
    });
    return Array.isArray(data) ? (data as MemoryItem[]) : [];
  } catch (e) {
    console.error('recallIdentityMemory:', String(e));
    return [];
  }
}

/**
 * Persist a durable memory for the verified caller. No-op unless the turn is
 * verified. Never throws.
 */
export async function rememberIdentity(
  admin: SupabaseClient,
  opts: {
    tenantId: string; deId: string; content: string; embedding: number[] | null;
    verdict: IdentityVerdict | null; kind?: string; salience?: number; source?: string; expiresAt?: string | null;
  },
): Promise<void> {
  if (!identityActive(opts.verdict) || !opts.deId || !opts.content || !opts.embedding) return;
  try {
    await admin.rpc('de_memory_write', {
      p_tenant_id: opts.tenantId, p_de_id: opts.deId, p_content: opts.content, p_embedding: opts.embedding,
      p_subject_kind: 'identity', p_subject_ref: opts.verdict.memory_ref,
      p_kind: opts.kind ?? 'fact', p_salience: opts.salience ?? 0.5, p_source: opts.source ?? 'de',
      p_expires_at: opts.expiresAt ?? null,
    });
  } catch (e) {
    console.error('rememberIdentity:', String(e));
  }
}
