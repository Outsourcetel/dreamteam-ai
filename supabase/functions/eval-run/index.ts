/**
 * eval-run — Proving Ground v1 eval runner (R3).
 *
 * JWT-authed. Loads the caller's tenant's active golden_qa (hard cap 50),
 * asks the LIVE DE each question by calling the deployed de-answer edge
 * function over HTTP — forwarding the CALLER'S Authorization header so
 * tenant scoping stays honest (de-answer resolves the tenant from the
 * same JWT) — and grades each answer:
 *
 *   pass = ALL expected_fragments present in the answer (case-insensitive)
 *          AND confidence >= min_confidence
 *
 * If de-answer returns llm_not_configured on the FIRST question, the run
 * is marked 'blocked_llm' immediately (honest dormant state — no spinning
 * through 50 questions that can't run). Progress is written to eval_runs
 * after every question so the client can live-poll. Cost-bounded by
 * design: sequential, 250ms delay, max 50 questions per run.
 *
 * Audit: completion is appended to the immutable audit chain using the
 * existing 'config_change' category with detail.kind='eval_run' (the
 * category constraint is deliberately not extended — parallel migrations
 * own it).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const MAX_QUESTIONS = 50;
const DELAY_MS = 250;

interface GoldenQA {
  id: string;
  question: string;
  expected_fragments: string[];
  min_confidence: number;
  category: string;
}

interface QuestionResult {
  qa_id: string;
  question: string;
  answer?: string;
  confidence?: number;
  passed: boolean;
  reason: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    let trigger = 'manual';
    let body: any = {};
    try {
      body = await req.json();
      if (['manual', 'knowledge_publish', 'scheduled'].includes(body?.trigger)) trigger = body.trigger;
    } catch { /* empty body → manual */ }

    // Wave-2: optional certification target — when set, THIS employee answers
    // its own exam (de_id forwarded to de-answer) and a passing suite writes
    // a role_certifications row. Callers must re-send de_id on batch resumes.
    const targetDeId = (typeof body?.de_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.de_id)) ? body.de_id : null;
    const targetArchetype = (typeof body?.archetype_key === 'string' && body.archetype_key) ? body.archetype_key : null;

    // ── Auth: service/dispatch caller with an explicit tenant (enables
    // headless + scheduled runs — same dual pattern as ingest-chunks),
    // or a user JWT ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isServiceCaller = isServiceRole || (dispatchSecret !== '' && headerSecret === dispatchSecret);

    let tenantId: string | null = null;
    if (isServiceCaller) {
      const asserted = (typeof body?.tenant_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.tenant_id)) ? body.tenant_id : null;
      if (!asserted) return json({ error: 'tenant_id required for service calls' }, 400);
      tenantId = asserted;
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body?.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ── Resolve the DE's archetype so a cert exam is scoped to its role.
    // A targeted run (targetDeId set) sits the UNIVERSAL questions
    // (archetype_key IS NULL) PLUS its own archetype's questions — never
    // another role's. A generic run with no target keeps the full tenant
    // suite unchanged (backward compat with the Proving Ground button). ──
    let deArchetype: string | null = targetArchetype;
    if (targetDeId) {
      const { data: arch } = await admin.rpc('resolve_de_archetype', { p_de_id: targetDeId });
      if (typeof arch === 'string' && arch) deArchetype = arch;
    }

    // ── Load the suite (active questions, capped) ──
    let qaQuery = admin
      .from('golden_qa')
      .select('id, question, expected_fragments, min_confidence, category')
      .eq('tenant_id', tenantId)
      .eq('active', true);
    if (targetDeId) {
      qaQuery = deArchetype
        ? qaQuery.or(`archetype_key.is.null,archetype_key.eq.${deArchetype}`)
        : qaQuery.is('archetype_key', null);
    }
    const { data: qas, error: qaErr } = await qaQuery
      .order('created_at', { ascending: true })
      .limit(MAX_QUESTIONS);
    if (qaErr) return json({ error: qaErr.message }, 500);
    if (!qas || qas.length === 0) return json({ error: 'no_active_questions' }, 400);

    // ── Create OR resume the run row ──
    //
    // Resumable batching: one invocation answers at most BATCH questions
    // (each de-answer call spends thousands of LLM input tokens; running
    // a whole suite in one invocation blows both the org's per-minute
    // token rate limit and the edge wall clock). Callers re-invoke with
    // the returned run_id until `remaining` hits 0 — the same loop
    // contract ingest-chunks established.
    const BATCH = 2;
    let runId: string;
    let results: QuestionResult[] = [];
    if (typeof body?.run_id === 'string' && body.run_id) {
      const { data: existing } = await admin
        .from('eval_runs').select('id, results, status')
        .eq('id', body.run_id).eq('tenant_id', tenantId).single();
      if (!existing) return json({ error: 'run_not_found' }, 404);
      if (existing.status !== 'running') return json({ error: 'run_already_finished', status: existing.status }, 400);
      runId = existing.id;
      results = Array.isArray(existing.results) ? existing.results as QuestionResult[] : [];
    } else {
      const { data: run, error: runErr } = await admin
        .from('eval_runs')
        // Persist the certification target so the server-side driver
        // (migration 264) can resume this run to completion even if the
        // client that started it goes away — de_id is forwarded to
        // de-answer on resume and required by certify_de_from_eval.
        .insert({ tenant_id: tenantId, trigger, status: 'running', total: qas.length, de_id: targetDeId, archetype_key: targetArchetype })
        .select('id').single();
      if (runErr || !run) return json({ error: runErr?.message ?? 'run_insert_failed' }, 500);
      runId = run.id;
    }

    const answeredIds = new Set(results.map((r) => r.qa_id));
    let passed = results.filter((r) => r.passed).length;
    let failed = results.length - passed;
    let finalStatus: 'passed' | 'failed' | 'blocked_llm' = 'passed';

    const deAnswerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`;
    const saveProgress = async (done = false) => {
      const patch: Record<string, unknown> = { results, passed, failed };
      if (done) {
        patch.status = finalStatus;
        patch.finished_at = new Date().toISOString();
      }
      const { error } = await admin.from('eval_runs').update(patch).eq('id', runId);
      if (error) console.error('eval_runs update:', error.message);
    };

    const pendingQas = (qas as GoldenQA[]).filter((q) => !answeredIds.has(q.id)).slice(0, BATCH);

    for (let i = 0; i < pendingQas.length; i++) {
      const qa = pendingQas[i];
      try {
        const res = await fetch(deAnswerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward the caller's own auth: user JWT as-is, or (for
            // service/scheduled callers) the same dispatch secret this
            // function was invoked with — de-answer accepts the same
            // dual pattern. Passing the raw service-role key as a
            // Bearer gets rejected at the gateway before de-answer
            // ever runs (verified live on the first suite run).
            'Authorization': authHeader,
            'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            ...(isServiceCaller && headerSecret ? { 'x-dispatch-secret': headerSecret } : {}),
          },
          body: JSON.stringify(isServiceCaller
            ? { question: qa.question, tenant_id: tenantId, ...(targetDeId ? { de_id: targetDeId } : {}) }
            : { question: qa.question, ...(targetDeId ? { de_id: targetDeId } : {}) }),
        });
        const data = await res.json().catch(() => ({} as Record<string, unknown>));

        if (data?.error === 'llm_not_configured') {
          // Honest dormant state — stop early, no spinning.
          finalStatus = 'blocked_llm';
          results.push({
            qa_id: qa.id, question: qa.question, passed: false,
            reason: 'DE brain not activated (ANTHROPIC_API_KEY not set) — suite is ready and will run on activation.',
          });
          await saveProgress(true);
          await auditCompletion(admin, tenantId, runId, trigger, finalStatus, qas.length, passed, failed);
          return json({ run_id: runId, status: finalStatus, total: qas.length, passed, failed });
        }
        if (!res.ok || data?.error) {
          failed += 1;
          results.push({
            qa_id: qa.id, question: qa.question, passed: false,
            reason: `de-answer error: ${data?.error ?? `HTTP ${res.status}`}`,
          });
        } else {
          const answer = String(data.answer ?? '');
          const confidence = Math.max(0, Math.min(100, Number(data.confidence) || 0));
          const answerLc = answer.toLowerCase();
          const missing = (qa.expected_fragments ?? [])
            .filter((f) => f && !answerLc.includes(f.toLowerCase()));
          const fragsOk = missing.length === 0;
          const confOk = confidence >= qa.min_confidence;
          const pass = fragsOk && confOk;
          if (pass) passed += 1; else failed += 1;
          const reasons: string[] = [];
          if (!fragsOk) reasons.push(`missing fragment(s): ${missing.map((m) => `"${m}"`).join(', ')}`);
          if (!confOk) reasons.push(`confidence ${confidence} below floor ${qa.min_confidence}`);
          results.push({
            qa_id: qa.id, question: qa.question,
            answer: answer.slice(0, 500), confidence,
            passed: pass,
            reason: pass ? 'all fragments present, confidence at or above floor' : reasons.join('; '),
          });
        }
      } catch (err) {
        failed += 1;
        results.push({ qa_id: qa.id, question: qa.question, passed: false, reason: `runner error: ${String(err)}` });
      }
      await saveProgress(false);
      if (i < pendingQas.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    const remaining = (qas as GoldenQA[]).length - results.length;
    if (remaining > 0) {
      // Batch done, suite not finished — caller re-invokes with run_id.
      return json({ run_id: runId, status: 'running', total: qas.length, passed, failed, remaining });
    }

    finalStatus = failed === 0 ? 'passed' : 'failed';
    await saveProgress(true);
    await auditCompletion(admin, tenantId, runId, trigger, finalStatus, qas.length, passed, failed);

    // Wave-2 (truth audit 2026-07-22, docs/15): a targeted run finally
    // CERTIFIES — certify_de_from_eval had zero callers, so Proving Ground
    // passes never produced a certification and the go-live gate was
    // unsatisfiable through the app. Best-effort: a cert failure never
    // breaks the eval result itself.
    let certification: Record<string, unknown> | null = null;
    if (targetDeId) {
      try {
        const { data: cert, error: certErr } = await admin.rpc('certify_de_from_eval', {
          p_de_id: targetDeId, p_archetype_key: deArchetype, p_eval_run_id: runId, p_threshold_pct: 80,
        });
        if (certErr) console.error('certify_de_from_eval:', certErr.message);
        else certification = cert as Record<string, unknown>;
      } catch (e) { console.error('certify_de_from_eval:', e); }
    }

    return json({ run_id: runId, status: finalStatus, total: qas.length, passed, failed, remaining: 0, certification });
  } catch (err) {
    console.error('eval-run error:', err);
    return json({ error: String(err) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function auditCompletion(admin: any, tenantId: string, runId: string, trigger: string, status: string, total: number, passed: number, failed: number) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId,
    p_actor: 'Proving Ground',
    p_actor_type: 'system',
    p_action: status === 'blocked_llm'
      ? `Eval run finished — blocked: DE brain not activated (${total} questions staged, trigger ${trigger})`
      : `Eval run finished — ${status.toUpperCase()} ${passed}/${total} (trigger ${trigger})`,
    p_category: 'config_change', // category-safe: constraint owned by parallel migrations
    p_detail: { kind: 'eval_run', run_id: runId, trigger, status, total, passed, failed },
  });
  if (error) console.error('append_audit_event:', error.message);
}
