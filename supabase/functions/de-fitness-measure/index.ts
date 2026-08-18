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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked } from '../_shared/rpcSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
// 695: the measurement is CHUNKED and RESUMABLE. Each chunk replays the same
// frozen questions under BOTH personas back-to-back (no time separation per
// question); progress persists in fitness_run_progress; the next cron tick
// resumes an in-flight run before claiming new work.
const CHUNK = 4;                 // questions per chunk (×2 personas ×2 calls ≈ 16 LLM calls)
const TIME_BUDGET_MS = 65_000;   // stop chunking before the edge wall-clock does
const SAMPLE_DEFAULT = 20;       // platform_config 'amendment_fitness.sample_size', clamped 1..40
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

    // ── RESUME-FIRST (695): an in-flight chunked run continues before any new
    // claim. A driver death mid-run self-heals here on the next tick —
    // record_amendment_fitness has been an idempotent UPSERT since mig 310.
    type Progress = { amendment_id: string; tenant_id: string; de_id: string; frozen_ids: string[]; sample_target: number; next_offset: number; before_passed: number; after_passed: number };
    let prog: Progress | null = null;
    {
      let pq = admin.from('fitness_run_progress').select('*').order('updated_at', { ascending: true }).limit(1);
      if (bodyTenant) pq = pq.eq('tenant_id', bodyTenant);
      const { data: prows } = await pq;
      if (prows && prows.length) {
        const p = prows[0] as Record<string, unknown>;
        prog = { amendment_id: p.amendment_id as string, tenant_id: p.tenant_id as string, de_id: p.de_id as string,
                 frozen_ids: (p.frozen_ids ?? []) as string[], sample_target: Number(p.sample_target),
                 next_offset: Number(p.next_offset), before_passed: Number(p.before_passed), after_passed: Number(p.after_passed) };
      }
    }

    let amendment: { id: string; tenant_id: string; entity_id: string; current_config: unknown; proposed_config: unknown };
    if (prog) {
      const { data: am } = await admin.from('workforce_entity_amendments')
        .select('id, tenant_id, entity_id, current_config, proposed_config')
        .eq('id', prog.amendment_id).maybeSingle();
      if (!am) {
        // FK cascade should make this impossible; belt over braces.
        await admin.from('fitness_run_progress').delete().eq('amendment_id', prog.amendment_id);
        return json({ ok: true, skipped: 'stale_progress_dropped', amendment_id: prog.amendment_id });
      }
      amendment = am;
    } else {
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
      const picked = cands.find((a: { id: string }) => !done.has(a.id));
      if (!picked) return json({ ok: true, skipped: 'all_measured' });
      amendment = picked;
    }

    const tenant_id = amendment.tenant_id as string;
    const de_id = amendment.entity_id as string;
    const beforePersona = personaFrom(amendment.current_config);
    const afterPersona = personaFrom(amendment.proposed_config);

    // Budget guard for THIS tenant — on fresh claims AND resumes alike. A
    // missing LLM provider surfaces downstream as a de-simulate
    // 'llm_not_configured' -> not-completed -> honest NULL/NULL.
    const { data: budget, error: budgetErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenant_id });
    if (budgetBlocked(budgetErr, budget)) return json({ ok: true, skipped: 'ai_budget_exceeded', tenant_id });

    if (!prog) {
      // Claim FIRST — the NULL/NULL row is the claim AND the fail-closed record.
      // 690: READ the error. .rpc() resolves on a Postgres error, and for 3 weeks
      // a 42703 in the claim was reported here as benign "already_claimed" — the
      // driver misdiagnosed its own crash as contention. A claim error is a loud
      // failure, never a skip.
      const { data: claim, error: claimErr } = await admin.rpc('claim_amendment_for_fitness', {
        p_tenant_id: tenant_id, p_amendment_id: amendment.id, p_entity_kind: 'de', p_entity_id: de_id,
      });
      if (claimErr) {
        console.error('claim_amendment_for_fitness FAILED:', claimErr);
        await reportEdgeError('de-fitness-measure', new Error(`claim failed: ${JSON.stringify(claimErr)}`), { amendment_id: amendment.id });
        return json({ error: 'claim_failed', amendment_id: amendment.id, detail: (claimErr as { message?: string }).message ?? String(claimErr) }, 500);
      }
      if (!claim || (claim as { claimed?: boolean }).claimed !== true) return json({ ok: true, skipped: 'already_claimed', amendment_id: amendment.id });

      // No resolveDePersona-visible change -> nothing to measure. Leave NULL/NULL.
      if (sameVisible(beforePersona, afterPersona)) {
        return json({ ok: true, amendment_id: amendment.id, result: 'no_visible_change', recorded: 'null' });
      }

      // ── FREEZE (695): fix the question list NOW, so a golden set edited
      // mid-run can never poison the before/after comparison.
      const { data: cfg } = await admin.from('platform_config').select('value').eq('key', 'amendment_fitness.sample_size').maybeSingle();
      const sampleTarget = Math.min(40, Math.max(1, Number(cfg?.value) || SAMPLE_DEFAULT));
      const { data: gRows } = await admin.from('golden_qa').select('id')
        .eq('tenant_id', tenant_id).eq('active', true).order('id', { ascending: true }).limit(sampleTarget);
      const frozen = (gRows ?? []).map((g: { id: string }) => g.id);
      if (frozen.length === 0) {
        await admin.rpc('record_amendment_fitness', {
          p_tenant_id: tenant_id, p_amendment_id: amendment.id, p_entity_kind: 'de', p_entity_id: de_id,
          p_before_metrics: { status: 'no_golden_qa', persona: beforePersona, golden_count: 0 },
          p_after_metrics: { status: 'no_golden_qa', persona: afterPersona },
          p_score_before: null, p_score_after: null,
        });
        return json({ ok: true, amendment_id: amendment.id, outcome: 'failed_closed', detail: 'no_golden_qa' });
      }
      const { error: progErr } = await admin.from('fitness_run_progress').insert({
        amendment_id: amendment.id, tenant_id, de_id, frozen_ids: frozen, sample_target: frozen.length,
      });
      if (progErr) {
        console.error('fitness_run_progress insert FAILED:', progErr);
        return json({ error: 'progress_insert_failed', amendment_id: amendment.id }, 500);
      }
      prog = { amendment_id: amendment.id, tenant_id, de_id, frozen_ids: frozen,
               sample_target: frozen.length, next_offset: 0, before_passed: 0, after_passed: 0 };
    }

    const base = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const simCall = async (persona: Record<string, string>, chunkIds: string[]) => {
      try {
        const r = await fetch(`${base}/functions/v1/de-simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anon, 'x-dispatch-secret': dispatch, Authorization: `Bearer ${anon}` },
          body: JSON.stringify({ tenant_id, de_id, mode: 'golden', candidate: true, measure: true, candidate_persona: persona, golden_ids: chunkIds }),
        });
        return await r.json().catch(() => ({}));
      } catch { return { error: 'sim_fetch_failed' }; }
    };
    const completed = (r: { error?: string; status?: string }) => !r.error && (r.status === 'passed' || r.status === 'failed');
    const target = prog.sample_target;

    // ── The interleaved chunk loop (695): same questions, both personas,
    // back-to-back — then persist progress, so any tick can pick up here.
    const deadline = Date.now() + TIME_BUDGET_MS;
    let failedSide: { side: 'before' | 'after'; got: { error?: string; status?: string } } | null = null;
    while (prog.next_offset < target && Date.now() < deadline) {
      const chunkIds = prog.frozen_ids.slice(prog.next_offset, prog.next_offset + CHUNK);
      const b = await simCall(beforePersona, chunkIds);
      const a = await simCall(afterPersona, chunkIds);
      if (!completed(b) || !completed(a)) {
        failedSide = !completed(b) ? { side: 'before', got: b } : { side: 'after', got: a };
        break;
      }
      prog.before_passed += Number(b.passed ?? 0);
      prog.after_passed += Number(a.passed ?? 0);
      prog.next_offset += chunkIds.length;
      await admin.from('fitness_run_progress').update({
        next_offset: prog.next_offset, before_passed: prog.before_passed,
        after_passed: prog.after_passed, updated_at: new Date().toISOString(),
      }).eq('amendment_id', prog.amendment_id);
    }

    // Fail-closed: ANY chunk whose either side did not genuinely complete
    // voids the whole run — partial scores are never promoted to verdicts.
    if (failedSide) {
      await admin.rpc('record_amendment_fitness', {
        p_tenant_id: tenant_id, p_amendment_id: prog.amendment_id, p_entity_kind: 'de', p_entity_id: de_id,
        p_before_metrics: { status: failedSide.side === 'before' ? (failedSide.got.status ?? failedSide.got.error ?? 'incomplete') : 'chunk_partner_failed',
                            measured_through: prog.next_offset, persona: beforePersona, golden_count: target },
        p_after_metrics: { status: failedSide.side === 'after' ? (failedSide.got.status ?? failedSide.got.error ?? 'incomplete') : 'chunk_partner_failed',
                           persona: afterPersona },
        p_score_before: null, p_score_after: null,
      });
      await admin.from('fitness_run_progress').delete().eq('amendment_id', prog.amendment_id);
      return json({ ok: true, amendment_id: prog.amendment_id, outcome: 'failed_closed', failed_side: failedSide.side });
    }

    // Time budget spent with questions remaining: the next tick resumes.
    if (prog.next_offset < target) {
      return json({ ok: true, amendment_id: prog.amendment_id, tenant_id, outcome: 'in_progress',
                    measured: prog.next_offset, remaining: target - prog.next_offset });
    }

    // ── FINALIZE: all frozen questions measured under both personas.
    const scoreBefore = prog.before_passed;
    const scoreAfter = prog.after_passed;
    const outcome = 'measured';
    await admin.rpc('record_amendment_fitness', {
      p_tenant_id: tenant_id, p_amendment_id: prog.amendment_id, p_entity_kind: 'de', p_entity_id: de_id,
      p_before_metrics: { passed: scoreBefore, total: target, status: 'passed', persona: beforePersona, golden_count: target },
      p_after_metrics: { passed: scoreAfter, total: target, status: 'passed', persona: afterPersona },
      p_score_before: scoreBefore, p_score_after: scoreAfter,
    });
    await admin.from('fitness_run_progress').delete().eq('amendment_id', prog.amendment_id);

    // 690 (G-E): a measured REGRESSION is loud. de_id stays NULL on the notice —
    // a decided governance task must never become trust evidence about the
    // employee (the 687 rule) — and the detail names the undo that now exists.
    if (scoreAfter < scoreBefore) {
      const { data: deRow } = await admin.from('digital_employees').select('persona_name, name').eq('id', de_id).maybeSingle();
      const who = deRow?.persona_name || deRow?.name || 'employee';
      const { data: pending } = await admin.from('human_tasks').select('id')
        .eq('related_table', 'workforce_entity_amendments').eq('related_id', prog.amendment_id)
        .eq('status', 'pending').limit(1);
      if (!pending || pending.length === 0) {
        await admin.from('human_tasks').insert({
          tenant_id, type: 'escalation', source: 'de', origin: 'production',
          title: `Amendment regressed — ${who} scored ${scoreAfter}/${target} vs ${scoreBefore}/${target} before`,
          detail: `The applied persona amendment for ${who} was measured with a back-to-back golden replay `
            + `(same ${target} questions, temperature 0, chunked): the prior persona passed ${scoreBefore}, the amended one ${scoreAfter}. `
            + `The change made the employee worse on its own golden set. Reverting restores the prior configuration in one step `
            + `(revert_entity_amendment) — the amendment record is kept either way.`,
          related_table: 'workforce_entity_amendments', related_id: prog.amendment_id,
        });
      }
    }

    return json({ ok: true, amendment_id: prog.amendment_id, tenant_id, outcome, score_before: scoreBefore, score_after: scoreAfter, golden_count: target });
  } catch (err) {
    console.error('de-fitness-measure error:', err);
    await reportEdgeError('de-fitness-measure', err, {});
    return json({ error: String(err) }, 500);
  }
});
