/**
 * ai-engine-status — the Platform Console's honest view of the AI spine.
 *
 * Exists because key PRESENCE cannot be judged from the database alone: the
 * Bedrock credential lives as an edge-function secret (env), invisible to
 * any platform_config check — a console page reading only the config table
 * would have called the serving primary "not configured". Only the edge
 * runtime can see both sources, so the edge runtime reports.
 *
 * Returns, per provider tier: armed (a key resolves) and where it came from
 * (config / env / both / none) — NEVER the value. Plus the configured
 * provider order, the EFFECTIVE chain (order filtered to armed tiers, the
 * same rule _shared/llm.ts applies), and the LLM_LAST_FAILOVER marker that
 * migration 700 finally made writable.
 *
 * Auth: user JWT + is_platform_admin — this is founder/operator tooling,
 * never a tenant surface. No tenant_id parameter exists on purpose.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKeys } from '../_shared/aiKeys.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const PROVIDERS: { provider: string; keyName: string }[] = [
  { provider: 'anthropic', keyName: 'ANTHROPIC_API_KEY' },
  { provider: 'bedrock', keyName: 'BEDROCK_API_KEY' },
  { provider: 'openai', keyName: 'OPENAI_API_KEY' },
  { provider: 'google', keyName: 'GOOGLE_AI_KEY' },
];
const DEFAULT_ORDER = 'anthropic,bedrock,openai,google';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ ok: false, error: 'unauthorized', detail: 'user JWT required' }, 401);
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return json({ ok: false, error: 'unauthorized', detail: 'user JWT required' }, 401);

    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: isAdmin } = await asUser.rpc('is_platform_admin');
    if (isAdmin !== true) return json({ ok: false, error: 'not_permitted', detail: 'platform operators only' }, 403);

    // Resolution exactly as the spine sees it (config first, env fallback).
    const keyNames = PROVIDERS.map((p) => p.keyName);
    const resolved = await getAIKeys(admin, [...keyNames, 'LLM_PROVIDER_ORDER']);

    // Source attribution: config rows via the table (service role), env via
    // the runtime. Values never leave this function.
    const { data: rows } = await admin.from('platform_config').select('key').in('key', keyNames);
    const inConfig = new Set((rows ?? []).map((r: { key: string }) => r.key));

    const tiers = PROVIDERS.map(({ provider, keyName }) => {
      const cfg = inConfig.has(keyName);
      const env = !!Deno.env.get(keyName);
      return {
        provider,
        armed: !!resolved[keyName],
        source: cfg && env ? 'both' : cfg ? 'config' : env ? 'env' : 'none',
      };
    });

    // Effective chain: configured order filtered to armed tiers — the same
    // rule resolveChain applies (unknown names ignored, unarmed can't be
    // forced in, empty result falls back to armed-in-default-order).
    const configuredOrder = resolved['LLM_PROVIDER_ORDER'] || null;
    const armed = tiers.filter((t) => t.armed).map((t) => t.provider);
    let effective = armed;
    if (configuredOrder) {
      const wanted = configuredOrder.split(',').map((s) => s.trim().toLowerCase()).filter((p) => armed.includes(p));
      if (wanted.length > 0) effective = wanted;
    }

    let lastFailover: string | null = null;
    try {
      const { data } = await admin.rpc('platform_config_get', { p_key: 'LLM_LAST_FAILOVER' });
      lastFailover = (data as string | null) ?? null;
    } catch { /* absent = never recorded */ }

    return json({
      ok: true,
      tiers,
      configured_order: configuredOrder ?? `${DEFAULT_ORDER} (default)`,
      effective_chain: effective,
      last_failover: lastFailover,
      marker_note: 'Failovers are recordable since 2026-08-11 (mig 700) — an empty marker before that date proves nothing.',
    });
  } catch (err) {
    return json({ ok: false, error: 'internal_error', detail: String((err as Error)?.message ?? err) }, 500);
  }
});
