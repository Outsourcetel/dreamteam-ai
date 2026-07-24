/**
 * de-fitness-measure — GI-6b: the honest amendment-fitness measurement driver.
 *
 * For ONE applied 'de' persona amendment per invocation, it runs a back-to-back
 * golden replay — the CURRENT persona vs the PROPOSED persona over the SAME
 * fixed, ordered golden set at temperature 0 (de-simulate measure mode) — and
 * compares PASS COUNTS, exactly like de-improve does for candidate knowledge.
 * Both personas come from the amendment's stored current_config / proposed_config,
 * so the delta is the projected effect of the change, with no time-separation,
 * no moving baseline, and no live-answer side effects (measure mode is dry-run).
 *
 * Honesty rails:
 *   - Claim FIRST (claim_amendment_for_fitness) — the NULL/NULL claim row also
 *     IS the fail-closed record, so two ticks never double-run and a failure
 *     never fabricates a delta.
 *   - Non-null scores ONLY when BOTH sims genuinely completed (de-improve's
 *     completed() rule); any partial/blocked/error/no-golden -> NULL/NULL.
 *   - Only measured when a resolveDePersona-visible field actually changed
 *     (persona_name/description/purpose_statement); else NULL/NULL (no wasted run).
 *   - Gated OFF by platform_config 'amendment_fitness.enabled' (default absent).
 *
 * NOTE on rigor: |Q| is capped at de-simulate's MAX_COUNT (5). A broader golden
 * sample (e.g. 40) would need raising that cap AND an async chunked harness to
 * avoid edge timeouts on ~80 sequential LLM calls — a documented follow-up.
 *
 * POST { tenant_id?, de_id? }  (cron passes neither -> scans all tenants)
 * Auth: dispatch secret or tenant-member JWT. Budget-gated.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const GOLDEN_COUNT = 5;   // de-simulate MAX_COUNT ceiling (clamped there anyway)
const VISIBLE = ['persona_name', 'description', 'purpose_statement'] as const;

// Only the resolveDePersona-visible + 'de'-amendment-editable fields, as strings.
function personaFrom(cfg: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const c = cfg as Record<string, unknown>;
    for (const k of VISIBLE) {
      const v = c[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
  }
  return out;
}
function sameVisible(a: Record<string, string>, b: Record<string, string>): boolean {
  return VISIBLE.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const bodyTenant = typeof body.tenant_id === 'string' ? body.tenant_id : null;
    const bodyDe = typeof body.de_id === 'string' ? body.de_id : null;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const isDispatch = dispatch && req.headers.get('x-dispatch-secret') === dispatch;
    if (!isDispatch) {
      // A JWT caller must name a tenant they belong to (no fleet scan for users).
      if (!bodyTenant) return json({ error: 'tenant_id required' }, 400);
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'unauthorized' }, 401);
      const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
      const resolvedTenant = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, bodyTenant);
      if (resolvedTenant !== bodyTenant) return json({ error: 'forbidden' }, 403);
    }

    // Feature gate — default OFF (absent key = off). platform_config.value is TEXT.
    const { data: gate } = await admin.from('platform_config').select('value').eq('key', 'amendment_fitness.enabled').maybeSingle();
    if (String(gate?.value ?? '') !== 'true') return json({ ok: true, skipped: 'feature_disabled' });

    // ── Select ONE eligible amendment: applied 'de', not yet in amendment_metrics ──
    let q = admin.from('workforce_entity_amendments')
      .select('id, tenant_id, entity_id, entity_kind, current_config, proposed_config')
      .eq('status', 'applied').eq('entity_kind', 'de')
      .order('updated_at', { ascending: true }).limit(25);
    if (bodyTenant) q = q.eq('tenant_id', bodyTenant);
    if (bodyDe) q = q.eq('entity_id', bodyDe);
    const { data: cands } = await q;
    if (!cands || cands.length === 0) return json({ ok: true, skipped: 'no_applied_de_amendments' });

    const ids = cands.map((a: { id: string }) => a.id);
    const { data: measured } = await admin.from('amendment_metrics').select('amendment_id').in('amendment_id', ids);
    const done = new Set((measured ?? []).map((m: { amendment_id: string }) => m.amendment_id));
    const amendment = cands.find((a: { id: string }) => !done.has(a.id));
    if (!amendment) return json({ ok: true, skipped: 'all_measured' });

    const tenant_id = amendment.tenant_id as string;
    const de_id = amendment.entity_id as string;
    const beforePersona = personaFrom(amendment.current_config);
    const afterPersona = personaFrom(amendment.proposed_config);

    // Budget guard for THIS tenant. A missing LLM provider surfaces downstream as
    // a de-simulate 'llm_not_configured' -> not-completed -> honest NULL/NULL.
    const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
    if (budget && budget.allowed === false) return json({ ok: true, skipped: 'ai_budget_exceeded', tenant_id });

    // Claim FIRST — the NULL/NULL row is the claim AND the fail-closed record.
    const { data: claim } = await admin.rpc('claim_amendment_for_fitness', {
      p_tenant_id: tenant_id, p_amendment_id: amendment.id, p_entity_kind: 'de', p_entity_id: de_id,
    });
    if (!claim || (claim as { claimed?: boolean }).claimed !== true) return json({ ok: true, skipped: 'already_claimed', amendment_id: amendment.id });

    // No resolveDePersona-visible change -> nothing to measure. Leave NULL/NULL.
    if (sameVisible(beforePersona, afterPersona)) {
      return json({ ok: true, amendment_id: amendment.id, result: 'no_visible_change', recorded: 'null' });
    }

    const base = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const simCall = async (persona: Record<string, string>) => {
      try {
        const r = await fetch(`${base}/functions/v1/de-simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anon, 'x-dispatch-secret': dispatch, Authorization: `Bearer ${anon}` },
          body: JSON.stringify({ tenant_id, de_id, mode: 'golden', count: GOLDEN_COUNT, candidate: true, measure: true, candidate_persona: persona }),
        });
        return await r.json().catch(() => ({}));
      } catch { return { error: 'sim_fetch_failed' }; }
    };

    const before = await simCall(beforePersona);
    const after = await simCall(afterPersona);

    // Fail-closed: non-null ONLY when BOTH sims genuinely completed (de-improve rule).
    const completed = (r: { error?: string; status?: string }) => !r.error && (r.status === 'passed' || r.status === 'failed');
    let scoreBefore: number | null = null, scoreAfter: number | null = null, outcome = 'failed_closed';
    if (completed(before) && completed(after)) {
      scoreBefore = Number(before.passed ?? 0);
      scoreAfter = Number(after.passed ?? 0);
      outcome = 'measured';
    }

    await admin.rpc('record_amendment_fitness', {
      p_tenant_id: tenant_id, p_amendment_id: amendment.id, p_entity_kind: 'de', p_entity_id: de_id,
      p_before_metrics: { passed: before.passed ?? null, total: before.total ?? null, status: before.status ?? before.error ?? null, persona: beforePersona, golden_count: GOLDEN_COUNT },
      p_after_metrics: { passed: after.passed ?? null, total: after.total ?? null, status: after.status ?? after.error ?? null, persona: afterPersona },
      p_score_before: scoreBefore, p_score_after: scoreAfter,
    });

    return json({ ok: true, amendment_id: amendment.id, tenant_id, outcome, score_before: scoreBefore, score_after: scoreAfter });
  } catch (err) {
    console.error('de-fitness-measure error:', err);
    return json({ error: String(err) }, 500);
  }
});
