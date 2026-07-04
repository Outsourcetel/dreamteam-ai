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
    try {
      const body = await req.json();
      if (['manual', 'knowledge_publish', 'scheduled'].includes(body?.trigger)) trigger = body.trigger;
    } catch { /* empty body → manual */ }

    // ── Auth: resolve the caller from their JWT ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const { data: profile } = await admin
      .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
    const tenantId: string | null = profile?.tenant_id ?? null;
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // ── Load the suite (active questions, capped) ──
    const { data: qas, error: qaErr } = await admin
      .from('golden_qa')
      .select('id, question, expected_fragments, min_confidence, category')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(MAX_QUESTIONS);
    if (qaErr) return json({ error: qaErr.message }, 500);
    if (!qas || qas.length === 0) return json({ error: 'no_active_questions' }, 400);

    // ── Create the run row ──
    const { data: run, error: runErr } = await admin
      .from('eval_runs')
      .insert({ tenant_id: tenantId, trigger, status: 'running', total: qas.length })
      .select('id').single();
    if (runErr || !run) return json({ error: runErr?.message ?? 'run_insert_failed' }, 500);
    const runId: string = run.id;

    const results: QuestionResult[] = [];
    let passed = 0;
    let failed = 0;
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

    for (let i = 0; i < (qas as GoldenQA[]).length; i++) {
      const qa = (qas as GoldenQA[])[i];
      try {
        const res = await fetch(deAnswerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward the caller's JWT — de-answer resolves the SAME tenant.
            'Authorization': authHeader,
            'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? '',
          },
          body: JSON.stringify({ question: qa.question }),
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
      if (i < qas.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    finalStatus = failed === 0 ? 'passed' : 'failed';
    await saveProgress(true);
    await auditCompletion(admin, tenantId, runId, trigger, finalStatus, qas.length, passed, failed);

    return json({ run_id: runId, status: finalStatus, total: qas.length, passed, failed });
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
