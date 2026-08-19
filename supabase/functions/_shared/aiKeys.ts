/**
 * aiKeys — resolves a provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GOOGLE_AI_KEY) for the real AI-calling edge functions.
 *
 * Found during the pre-launch readiness review (2026-07-08): Settings >
 * AI Engine saves a key via platform_config_set, but every edge function
 * that actually calls an LLM read Deno.env.get(...) instead — a
 * completely separate, Supabase-dashboard-configured secret. The two
 * systems were never connected; typing a key into Settings did nothing
 * for the real answer pipeline.
 *
 * getAIKey checks platform_config first (via the service-role-only
 * platform_config_get RPC, migration 087's Vault-encrypted storage) and
 * falls back to the Deno.env secret if platform_config has nothing set —
 * so an already-configured Deno.env secret keeps working exactly as
 * before, and the Settings UI becomes the effective source of truth the
 * moment a founder sets a key there.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

/**
 * Per-tenant keys (mig 541). When a tenantId is given, that workspace's own
 * credential is tried FIRST, and a workspace set to 'byo' with no key of its own
 * gets nothing rather than quietly borrowing the platform's — silent fallback is
 * exactly how one key came to carry sixteen tenants unnoticed.
 *
 * Without a tenantId this behaves as before, so callers that genuinely have no
 * tenant in scope (platform-level jobs) keep working.
 */
export async function getAIKey(
  admin: SupabaseClient, keyName: string, tenantId?: string | null,
): Promise<string | undefined> {
  if (tenantId) {
    try {
      const { data, error } = await admin.rpc('resolve_llm_key', {
        p_tenant_id: tenantId, p_provider_key: keyName,
      });
      if (!error && data) {
        const r = data as { ok?: boolean; key?: string; source?: string; reason?: string };
        if (r.ok && r.key) return r.key;
        // A BYO refusal is an ANSWER, not a miss. Falling through to the
        // platform key here would reinstate the silent borrowing mig 541
        // replaced. ('none' used to be treated the same — but 'none' also
        // covered "platform_config simply has no row", which silently deleted
        // env-only providers like BEDROCK_API_KEY from tenant-scoped failover
        // chains; mig 575 split the two, and plain absence now falls through
        // to the platform path below, same as every no-tenant caller.)
        if (r.source === 'byo_refused') {
          console.warn(`getAIKey: ${keyName} unavailable for tenant ${tenantId} — ${r.reason ?? 'not configured'}`);
          return undefined;
        }
      }
    } catch {
      // Fall through to the platform path only on a transport failure, never on
      // a considered refusal.
    }
  }
  return await getPlatformAIKey(admin, keyName);
}

async function getPlatformAIKey(admin: SupabaseClient, keyName: string): Promise<string | undefined> {
  // Two attempts: a transient platform_config_get/Vault hiccup used to
  // silently degrade to "key not configured" (observed live on a cron
  // tick 2026-07-11: one tick reported llm_not_configured while the
  // ticks around it resolved the same key fine). One retry after a
  // short pause covers the transient case; a genuinely missing key
  // still falls through to the env secret and then undefined.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await admin.rpc('platform_config_get', { p_key: keyName });
      if (!error && typeof data === 'string' && data.length > 0) return data;
      // A CLEAN response carrying no value means the key is not configured.
      // That is an answer, not a hiccup — and retrying it was costing a 400ms
      // sleep on the most common path, because five of the ten keys the
      // provider chain resolves are legitimately absent (Bedrock's credential
      // is env-only; OpenAI and Gemini are unconfigured tiers). Only a genuine
      // error or throw earns the retry this loop was written for.
      if (!error) break;
    } catch {
      // transient — worth exactly one retry
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return Deno.env.get(keyName) ?? undefined;
}

/**
 * Batch twin of getAIKey (mig 576). Resolves many keys in ONE round trip with
 * identical semantics: tenant credential wins, a 'byo' workspace with no key
 * of its own is refused rather than silently borrowing the platform's, and
 * plain absence falls through to the env secret — which is the only reason
 * env-only Bedrock survives in a tenant-scoped chain.
 *
 * Falls back to the per-key path if the batch RPC is unavailable, so a
 * half-deployed environment degrades to the old behaviour rather than losing
 * its brain.
 */
export async function getAIKeys(
  admin: SupabaseClient, keyNames: string[], tenantId?: string | null,
): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  try {
    const { data, error } = await admin.rpc('resolve_llm_keys', {
      p_tenant_id: tenantId ?? null, p_keys: keyNames,
    });
    if (!error && data && typeof data === 'object') {
      const m = data as Record<string, { ok?: boolean; key?: string; source?: string; reason?: string }>;
      for (const name of keyNames) {
        const r = m[name];
        if (r?.ok && r.key) { out[name] = r.key; continue; }
        if (r?.source === 'byo_refused') {
          console.warn(`getAIKeys: ${name} unavailable for tenant ${tenantId} — ${r.reason ?? 'not configured'}`);
          out[name] = undefined;
          continue;
        }
        out[name] = Deno.env.get(name) ?? undefined;
      }
      return out;
    }
    console.warn(`getAIKeys: batch resolve unavailable (${error?.message ?? 'no data'}) — falling back to per-key`);
  } catch (e) {
    console.warn(`getAIKeys: batch resolve threw (${e instanceof Error ? e.message : String(e)}) — falling back to per-key`);
  }
  const vals = await Promise.all(keyNames.map((n) => getAIKey(admin, n, tenantId)));
  keyNames.forEach((n, i) => { out[n] = vals[i]; });
  return out;
}
