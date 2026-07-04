/**
 * playbook-execute — R4 server-side playbook executor (renewal_v1).
 *
 * Orchestration is server-authoritative: the browser only starts/observes.
 * Runs survive closed tabs; every step appends a hash-chained audit event
 * via the append_audit_event RPC (service-role path).
 *
 * Actions:
 *   { action: 'start',   playbook_key: 'renewal_v1', account_id }
 *   { action: 'advance', run_id }            — resume a waiting run whose
 *                                              gate task has been decided
 *   { action: 'advance', task_id }           — same, addressed by task
 *   { action: 'cancel',  run_id }
 *
 * Auth: caller JWT (tenant from profile), same pattern as ingest-chunks.
 *       The service-role key is also accepted as bearer (with tenant_id
 *       in the body) for ops/verification.
 *
 * Idempotency: advancing a run in 'waiting_approval' whose task is still
 * pending is a no-op; completed/cancelled runs are never re-executed.
 *
 * R5 TRUST DIAL COMPOSITION RULE (autonomy narrows within guardrails,
 * never overrides them): an invoice auto-sends ONLY when BOTH
 *   (a) the guardrail rule allows auto (amount <= approval threshold), AND
 *   (b) no de_autonomy 'invoice_auto_send' row exists, OR the row is
 *       enabled AND amount <= its max_amount_cents.
 * Every other case routes to human approval.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const STEP_DEFS = [
  { key: 'check_account', label: 'Check account' },
  { key: 'generate_invoice', label: 'Generate invoice' },
  { key: 'guardrail_gate', label: 'Guardrail check' },
  { key: 'human_approval', label: 'Human approval' },
  { key: 'mark_sent', label: 'Send invoice' },
  { key: 'complete', label: 'Complete' },
];

interface RunStep { key: string; label: string; status: string; at: string | null; detail: string }

const now = () => new Date().toISOString();
const fmtMoney = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

async function audit(
  admin: SupabaseClient, tenantId: string, action: string, category: string,
  detail: Record<string, unknown>,
) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: 'Renewal DE', p_actor_type: 'de',
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('audit:', error.message);
}

function stepAuditText(accountName: string, step: RunStep) {
  return `Renewal playbook [${accountName}] — step "${step.label}" ${step.status}${step.detail ? `: ${step.detail}` : ''}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const action = body?.action;
    if (!['start', 'advance', 'cancel'].includes(action)) return json({ error: 'invalid action' }, 400);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service-role key + body.tenant_id ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ────────────────────────────────────────────────────────────
    if (action === 'start') {
      if ((body?.playbook_key ?? 'renewal_v1') !== 'renewal_v1') return json({ error: 'unknown playbook_key' }, 400);
      const accountId = body?.account_id;
      if (!accountId) return json({ error: 'account_id required' }, 400);

      const { data: account, error: acctErr } = await admin
        .from('customer_accounts')
        .select('id, name, arr_cents, renewal_date')
        .eq('id', accountId).eq('tenant_id', tenantId).single();
      if (acctErr || !account) return json({ error: 'account_not_found' }, 404);

      const steps: RunStep[] = STEP_DEFS.map((d) => ({ ...d, status: 'pending', at: null, detail: '' }));
      const { data: runRow, error: runErr } = await admin
        .from('playbook_runs')
        .insert({ tenant_id: tenantId, playbook_key: 'renewal_v1', account_id: account.id, status: 'running', current_step: 0, steps })
        .select().single();
      if (runErr || !runRow) return json({ error: runErr?.message ?? 'run insert failed' }, 500);
      const runId = runRow.id as string;
      const amount = account.arr_cents as number;

      // ── Step 1: check_account ──
      steps[0].status = 'done'; steps[0].at = now();
      steps[0].detail = account.renewal_date
        ? `${account.name} · ARR ${fmtMoney(amount)} · renews ${account.renewal_date}`
        : `${account.name} · ARR ${fmtMoney(amount)} · no renewal date set`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[0]), 'playbook_step',
        { run_id: runId, step_key: steps[0].key, step_status: 'done', step_detail: steps[0].detail });

      // ── Guardrail threshold (require_approval_over_cents, fallback $10K) ──
      let thresholdCents = 10_000 * 100;
      let fromRule = false;
      const { data: rules } = await admin
        .from('guardrail_rules').select('threshold')
        .eq('tenant_id', tenantId).eq('rule_type', 'require_approval_over_cents').eq('active', true)
        .order('updated_at', { ascending: false }).limit(1);
      if (rules && rules.length > 0 && typeof rules[0].threshold === 'number') {
        thresholdCents = rules[0].threshold; fromRule = true;
      }

      // ── Trust dial (de_autonomy: invoice_auto_send) ──
      let autonomy: { id: string; enabled: boolean; max_amount_cents: number | null } | null = null;
      try {
        const { data: auto } = await admin
          .from('de_autonomy').select('id, enabled, max_amount_cents')
          .eq('tenant_id', tenantId).eq('action_type', 'invoice_auto_send').maybeSingle();
        autonomy = auto ?? null;
      } catch { autonomy = null; }

      // COMPOSITION: autonomy narrows within guardrails, never overrides.
      const guardrailAllows = amount <= thresholdCents;
      const autonomyAllows = !autonomy ||
        (autonomy.enabled && autonomy.max_amount_cents !== null && amount <= autonomy.max_amount_cents);
      const gated = !(guardrailAllows && autonomyAllows);
      const underTrustDial = guardrailAllows && autonomy !== null && autonomy.enabled &&
        autonomy.max_amount_cents !== null && amount <= autonomy.max_amount_cents;

      // ── Step 2: generate_invoice ──
      const { data: invoice, error: invErr } = await admin
        .from('renewal_invoices')
        .insert({
          tenant_id: tenantId, account_id: account.id, amount_cents: amount,
          status: gated ? 'awaiting_approval' : 'sent', due_date: account.renewal_date,
        })
        .select().single();
      if (invErr || !invoice) return json({ error: invErr?.message ?? 'invoice insert failed' }, 500);

      steps[1].status = 'done'; steps[1].at = now();
      steps[1].detail = `Invoice ${fmtMoney(amount)} created (${invoice.status})`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[1]), 'playbook_step',
        { run_id: runId, step_key: steps[1].key, step_status: 'done', step_detail: steps[1].detail });
      await audit(admin, tenantId,
        `Renewal invoice generated — ${account.name} (${fmtMoney(amount)}), status ${invoice.status}`,
        'invoice', { invoice_id: invoice.id, account: account.name, amount_cents: amount, status: invoice.status });

      // ── Step 3: guardrail_gate (guardrail + trust-dial composition) ──
      steps[2].status = 'done'; steps[2].at = now();
      steps[2].detail = gated
        ? (guardrailAllows
          ? `Under ${fmtMoney(thresholdCents)} threshold but trust dial requires approval — routed to human approval`
          : `Amount exceeds ${fmtMoney(thresholdCents)} approval threshold — routed to human approval`)
        : (underTrustDial
          ? `auto-approved under trust dial (≤ ${fmtMoney(autonomy!.max_amount_cents!)}) — within ${fmtMoney(thresholdCents)} guardrail`
          : `Under ${fmtMoney(thresholdCents)} approval threshold — auto-approved`);
      await audit(admin, tenantId,
        gated
          ? `Guardrail GATED — invoice ${fmtMoney(amount)} for ${account.name}: ${steps[2].detail}`
          : `Guardrail passed — invoice ${fmtMoney(amount)} for ${account.name}: ${steps[2].detail}`,
        'guardrail_check', {
          run_id: runId, invoice_id: invoice.id, account: account.name, amount_cents: amount,
          threshold_cents: thresholdCents, threshold_from_rule: fromRule,
          autonomy_rule_id: autonomy?.id ?? null, autonomy_enabled: autonomy?.enabled ?? null,
          autonomy_max_cents: autonomy?.max_amount_cents ?? null,
          composition: 'autonomy_narrows_within_guardrails',
          result: gated ? 'gated' : 'passed',
        });
      await audit(admin, tenantId, stepAuditText(account.name, steps[2]), 'playbook_step',
        { run_id: runId, step_key: steps[2].key, step_status: 'done', step_detail: steps[2].detail, autonomy_rule_id: autonomy?.id ?? null });

      if (gated) {
        // ── Step 4 pauses: human_approval ──
        const { data: task, error: taskErr } = await admin
          .from('human_tasks')
          .insert({
            tenant_id: tenantId, type: 'approval_gate',
            title: `Invoice approval — ${account.name}`, detail: fmtMoney(amount),
            source: 'system', related_table: 'renewal_invoices', related_id: invoice.id,
          })
          .select().single();
        if (taskErr || !task) return json({ error: taskErr?.message ?? 'task insert failed' }, 500);

        steps[3].status = 'waiting';
        steps[3].detail = 'Waiting on the approval task in Human Tasks';
        await admin.from('playbook_runs')
          .update({ status: 'waiting_approval', current_step: 3, steps, waiting_task_id: task.id })
          .eq('id', runId);
        await audit(admin, tenantId, stepAuditText(account.name, steps[3]), 'playbook_step',
          { run_id: runId, step_key: steps[3].key, step_status: 'waiting', task_id: task.id });
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: 'Renewal DE', actor_type: 'de', event_type: 'escalated',
          text: `Renewal invoice for ${account.name} (${fmtMoney(amount)}) requires approval — routed to Human Tasks`,
        });
        return json({ run_id: runId, status: 'waiting_approval', task_id: task.id, steps });
      }

      // Not gated: skip the gate and finish.
      steps[3].status = 'skipped'; steps[3].at = now();
      steps[3].detail = underTrustDial
        ? `auto-approved under trust dial (≤ ${fmtMoney(autonomy!.max_amount_cents!)})`
        : 'Not required — under the approval threshold';
      await audit(admin, tenantId, stepAuditText(account.name, steps[3]), 'playbook_step',
        { run_id: runId, step_key: steps[3].key, step_status: 'skipped', autonomy_rule_id: autonomy?.id ?? null });

      await admin.from('renewal_invoices').update({ status: 'sent', cadence_stage: 1 }).eq('id', invoice.id);
      steps[4].status = 'done'; steps[4].at = now();
      steps[4].detail = `Invoice ${fmtMoney(amount)} sent · cadence Day-0 started`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[4]), 'playbook_step',
        { run_id: runId, step_key: steps[4].key, step_status: 'done', invoice_id: invoice.id });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Renewal DE', actor_type: 'de', event_type: 'resolved',
        text: `Renewal playbook sent invoice — ${account.name} (${fmtMoney(amount)}), dunning cadence started`,
      });

      steps[5].status = 'done'; steps[5].at = now(); steps[5].detail = 'Run completed';
      await admin.from('playbook_runs')
        .update({ status: 'completed', current_step: 5, steps, waiting_task_id: null })
        .eq('id', runId);
      await audit(admin, tenantId, stepAuditText(account.name, steps[5]), 'playbook_step',
        { run_id: runId, step_key: steps[5].key, step_status: 'done' });
      await audit(admin, tenantId,
        `Renewal playbook [${account.name}] — run completed end-to-end`,
        'playbook_step', { run_id: runId, invoice_id: invoice.id, amount_cents: amount });
      return json({ run_id: runId, status: 'completed', steps });
    }

    // ────────────────────────────────────────────────────────────
    if (action === 'advance') {
      let query = admin.from('playbook_runs').select('*').eq('tenant_id', tenantId);
      if (body?.run_id) query = query.eq('id', body.run_id);
      else if (body?.task_id) query = query.eq('waiting_task_id', body.task_id);
      else return json({ error: 'run_id or task_id required' }, 400);
      const { data: run } = await query.maybeSingle();
      if (!run) return json({ advanced: false, reason: 'run_not_found' }, 404);
      if (run.status !== 'waiting_approval') return json({ advanced: false, reason: `run is ${run.status}`, status: run.status });
      if (!run.waiting_task_id) return json({ advanced: false, reason: 'no waiting task' });

      const { data: task } = await admin
        .from('human_tasks').select('id, status')
        .eq('id', run.waiting_task_id).eq('tenant_id', tenantId).maybeSingle();
      if (!task) return json({ advanced: false, reason: 'task_not_found' }, 404);
      // Idempotent no-op: gate task not decided yet.
      if (task.status !== 'approved' && task.status !== 'rejected') {
        return json({ advanced: false, reason: 'task_pending', status: 'waiting_approval' });
      }
      const { data: res, error: resErr } = await admin.rpc('resume_playbook_on_task', {
        p_task_id: task.id, p_decision: task.status,
      });
      if (resErr) return json({ error: resErr.message }, 500);
      return json({ advanced: true, result: res });
    }

    // ────────────────────────────────────────────────────────────
    // cancel
    const runId = body?.run_id;
    if (!runId) return json({ error: 'run_id required' }, 400);
    const { data: run } = await admin
      .from('playbook_runs').select('*').eq('id', runId).eq('tenant_id', tenantId).maybeSingle();
    if (!run) return json({ cancelled: false, reason: 'run_not_found' }, 404);
    if (run.status === 'completed' || run.status === 'cancelled') {
      return json({ cancelled: false, reason: `run is ${run.status}`, status: run.status });
    }
    const steps = (run.steps as RunStep[]).map((s) =>
      s.status === 'pending' || s.status === 'waiting' ? { ...s, status: 'cancelled' } : s);
    await admin.from('playbook_runs')
      .update({ status: 'cancelled', steps, waiting_task_id: null })
      .eq('id', runId);
    await audit(admin, tenantId, `Renewal playbook run cancelled by operator`, 'playbook_step',
      { run_id: runId, previous_status: run.status });
    return json({ cancelled: true, run_id: runId });
  } catch (err) {
    console.error('playbook-execute error:', err);
    return json({ error: String(err) }, 500);
  }
});
