/**
 * playbook-execute — R4 server-side playbook executor,
 * generalized in R6 for tenant-built playbook definitions.
 *
 * Orchestration is server-authoritative: the browser only starts/observes.
 * Runs survive closed tabs; every step appends a hash-chained audit event
 * via the append_audit_event RPC (service-role path).
 *
 * Actions:
 *   { action: 'start',    playbook_key: 'renewal_v1', account_id }   — legacy, unchanged
 *   { action: 'start',    definition_id, account_id }                — R6 definition run
 *   { action: 'publish',  definition_id }   — validate + snapshot version + status published
 *   { action: 'validate', definition_id | steps }                    — dry validation
 *   { action: 'advance',  run_id | task_id }                         — resume waiting/parked run
 *   { action: 'cancel',   run_id }
 *
 * ── R6 STEP-PRIMITIVE REGISTRY ──────────────────────────────────────
 * A playbook definition is an ordered array of typed step objects:
 *   { key, label?, params }
 *
 *   check_account     {}                              — loads the account into run context.
 *                                                       Must be step 0 (context.account_id from start).
 *   generate_invoice  { amount_source: 'account_arr'|'fixed',
 *                       fixed_amount_cents? }         — creates a renewal_invoices row. Runs the
 *                                                       R5 guardrail + trust-dial COMPOSITION
 *                                                       (autonomy narrows within guardrails):
 *                                                       gated → invoice awaiting_approval, else sent.
 *   human_approval    { title_template?, task_type? } — explicit gate. If a prior generate_invoice
 *                                                       was NOT gated, this step is skipped
 *                                                       (auto-approved under guardrail/trust dial —
 *                                                       mirrors renewal_v1 semantics). Otherwise a
 *                                                       human_tasks row is created and the run pauses.
 *   guardrail_check   { check: 'invoice_threshold' }  — explicit re-check point; records an audit
 *                                                       event with the threshold comparison. Never pauses.
 *   connector_action  { provider: 'zendesk',
 *                       op: 'add_internal_note'|'update_status',
 *                       payload_template,
 *                       external_ref_template? }      — write-back into the SoR. HONEST DEGRADATION:
 *                                                       no connected connector / disabled action /
 *                                                       no target ref → step recorded 'skipped',
 *                                                       run continues.
 *   update_record     { table: 'renewal_invoices'|'support_tickets',
 *                       set: { status } }             — WHITELISTED status flips only
 *                                                       (see UPDATE_WHITELIST). Target id comes from
 *                                                       run context (invoice_id / ticket_id).
 *   log_activity      { text_template }               — activity_events row.
 *   complete          {}                              — required final step.
 *
 * Templates: {{account.name}}, {{invoice.amount}}, {{run.id}} rendered
 * from run context.
 *
 * ── VALIDATION (server-side, on publish and on start) ──────────────
 *   - 1..20 steps; every key must be a known primitive
 *   - step 0 must be check_account; last step must be complete;
 *     complete appears exactly once (at the end)
 *   - at most one generate_invoice, at most one human_approval
 *   - human_approval requires a PRECEDING generate_invoice
 *   - steps AFTER human_approval limited to guardrail_check /
 *     connector_action / update_record / log_activity / complete
 *     (this is what makes the SQL-native resume path possible)
 *   - update_record.set must be a whitelisted status value
 *   - connector_action op/provider must be known
 *   Errors are structured: [{ index, code, message }]
 *
 * ── RESUME SPLIT (documented honestly) ─────────────────────────────
 * On gate approval, resume_playbook_on_task (SQL, migration 019)
 * advances every post-gate step it can do natively (guardrail_check,
 * update_record, log_activity, complete) — zero HTTP. When it meets a
 * connector_action it parks the run in 'resume_pending'; decideHumanTask
 * then fires {action:'advance'} here, which executes the connector call
 * and the remaining steps. Two paths, one authority: the server.
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

// ── Legacy renewal_v1 (unchanged) ───────────────────────────────────
const STEP_DEFS = [
  { key: 'check_account', label: 'Check account' },
  { key: 'generate_invoice', label: 'Generate invoice' },
  { key: 'guardrail_gate', label: 'Guardrail check' },
  { key: 'human_approval', label: 'Human approval' },
  { key: 'mark_sent', label: 'Send invoice' },
  { key: 'complete', label: 'Complete' },
];

interface RunStep {
  key: string;
  label: string;
  status: string;
  at: string | null;
  detail: string;
  params?: Record<string, unknown>;
}

interface RunContext {
  account_id?: string;
  account_name?: string;
  arr_cents?: number;
  renewal_date?: string | null;
  invoice_id?: string;
  invoice_amount_cents?: number;
  invoice_status?: string;
  gated?: boolean;
  ticket_id?: string;
  [k: string]: unknown;
}

const now = () => new Date().toISOString();
const fmtMoney = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

// ── R6 registry + validation ───────────────────────────────────────

const PRIMITIVES = [
  'check_account', 'generate_invoice', 'human_approval', 'guardrail_check',
  'connector_action', 'update_record', 'log_activity', 'complete',
] as const;

const PRIMITIVE_LABELS: Record<string, string> = {
  check_account: 'Check account',
  generate_invoice: 'Generate invoice',
  human_approval: 'Human approval',
  guardrail_check: 'Guardrail check',
  connector_action: 'Connector action',
  update_record: 'Update record',
  log_activity: 'Log activity',
  complete: 'Complete',
};

// Steps that the SQL resume path (resume_playbook_on_task) can advance.
const SQL_RESUMABLE = new Set(['guardrail_check', 'update_record', 'log_activity', 'complete']);
const POST_GATE_ALLOWED = new Set([...SQL_RESUMABLE, 'connector_action']);

const UPDATE_WHITELIST: Record<string, string[]> = {
  renewal_invoices: ['sent', 'paid'],
  support_tickets: ['open', 'pending', 'resolved', 'escalated'],
};

interface DefStep { key: string; label?: string; params?: Record<string, unknown> }
interface ValidationError { index: number; code: string; message: string }

function validateSteps(steps: unknown): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return [{ index: -1, code: 'empty', message: 'A playbook needs at least one step.' }];
  }
  if (steps.length > 20) {
    errs.push({ index: -1, code: 'too_many_steps', message: 'A playbook is limited to 20 steps.' });
  }
  const list = steps as DefStep[];
  let invoiceCount = 0, approvalCount = 0, completeCount = 0;
  let invoiceIdx = -1, approvalIdx = -1;

  list.forEach((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.key !== 'string') {
      errs.push({ index: i, code: 'bad_step', message: 'Step must be an object with a key.' });
      return;
    }
    if (!(PRIMITIVES as readonly string[]).includes(s.key)) {
      errs.push({ index: i, code: 'unknown_primitive', message: `Unknown step primitive "${s.key}".` });
      return;
    }
    const p = (s.params ?? {}) as Record<string, unknown>;
    switch (s.key) {
      case 'generate_invoice': {
        invoiceCount++; invoiceIdx = invoiceIdx === -1 ? i : invoiceIdx;
        const src = p.amount_source;
        if (src !== 'account_arr' && src !== 'fixed') {
          errs.push({ index: i, code: 'bad_params', message: 'generate_invoice.amount_source must be "account_arr" or "fixed".' });
        } else if (src === 'fixed' && (typeof p.fixed_amount_cents !== 'number' || p.fixed_amount_cents <= 0)) {
          errs.push({ index: i, code: 'bad_params', message: 'generate_invoice with fixed amount needs fixed_amount_cents > 0.' });
        }
        break;
      }
      case 'human_approval':
        approvalCount++; approvalIdx = approvalIdx === -1 ? i : approvalIdx;
        break;
      case 'guardrail_check':
        if (p.check !== 'invoice_threshold') {
          errs.push({ index: i, code: 'bad_params', message: 'guardrail_check.check must be "invoice_threshold" (the only check in v1).' });
        }
        break;
      case 'connector_action': {
        if (p.provider !== 'zendesk') {
          errs.push({ index: i, code: 'bad_params', message: 'connector_action.provider must be "zendesk" (v1).' });
        }
        if (p.op !== 'add_internal_note' && p.op !== 'update_status') {
          errs.push({ index: i, code: 'bad_params', message: 'connector_action.op must be "add_internal_note" or "update_status".' });
        }
        break;
      }
      case 'update_record': {
        const table = p.table as string;
        const allowed = UPDATE_WHITELIST[table];
        const set = (p.set ?? {}) as Record<string, unknown>;
        if (!allowed) {
          errs.push({ index: i, code: 'bad_params', message: 'update_record.table must be "renewal_invoices" or "support_tickets".' });
        } else if (typeof set.status !== 'string' || !allowed.includes(set.status)) {
          errs.push({ index: i, code: 'bad_params', message: `update_record on ${table} may only set status to: ${allowed?.join(', ')}.` });
        } else if (Object.keys(set).length !== 1) {
          errs.push({ index: i, code: 'bad_params', message: 'update_record.set may only contain "status" (whitelisted mutation).' });
        }
        break;
      }
      case 'log_activity':
        if (typeof p.text_template !== 'string' || !p.text_template.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'log_activity needs a non-empty text_template.' });
        }
        break;
      case 'complete':
        completeCount++;
        break;
    }
  });

  if (list[0]?.key !== 'check_account') {
    errs.push({ index: 0, code: 'first_step', message: 'Step 1 must be check_account (loads the account into run context).' });
  }
  if (list[list.length - 1]?.key !== 'complete') {
    errs.push({ index: list.length - 1, code: 'last_step', message: 'The last step must be complete.' });
  }
  if (completeCount > 1) errs.push({ index: -1, code: 'multiple_complete', message: 'Only one complete step is allowed (at the end).' });
  if (invoiceCount > 1) errs.push({ index: -1, code: 'multiple_invoice', message: 'At most one generate_invoice step is allowed.' });
  if (approvalCount > 1) errs.push({ index: -1, code: 'multiple_approval', message: 'At most one human_approval step is allowed.' });
  if (approvalIdx !== -1 && (invoiceIdx === -1 || invoiceIdx > approvalIdx)) {
    errs.push({ index: approvalIdx, code: 'approval_without_invoice', message: 'human_approval must come after a generate_invoice step (it gates the invoice).' });
  }
  if (approvalIdx !== -1) {
    list.slice(approvalIdx + 1).forEach((s, off) => {
      if (s?.key && !POST_GATE_ALLOWED.has(s.key)) {
        errs.push({
          index: approvalIdx + 1 + off, code: 'post_gate_primitive',
          message: `"${s.key}" cannot follow human_approval — post-gate steps are limited to guardrail_check, connector_action, update_record, log_activity, complete (this keeps the resume path server-authoritative).`,
        });
      }
    });
  }
  return errs;
}

function renderTemplate(t: string, ctx: RunContext, runId: string): string {
  return t
    .replaceAll('{{account.name}}', ctx.account_name ?? 'account')
    .replaceAll('{{invoice.amount}}', fmtMoney(ctx.invoice_amount_cents ?? 0))
    .replaceAll('{{run.id}}', runId);
}

// ── Audit helpers ───────────────────────────────────────────────────

async function audit(
  admin: SupabaseClient, tenantId: string, action: string, category: string,
  detail: Record<string, unknown>, actor = 'Renewal DE',
) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: 'de',
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('audit:', error.message);
}

function stepAuditText(accountName: string, step: RunStep) {
  return `Renewal playbook [${accountName}] — step "${step.label}" ${step.status}${step.detail ? `: ${step.detail}` : ''}`;
}

// ── R6 definition-run interpreter ───────────────────────────────────
// Executes steps[startIndex..] sequentially. Returns when the run
// pauses (human gate), completes, or fails. State is persisted to
// playbook_runs after every step so runs survive crashes.

interface DefRunRow {
  id: string; tenant_id: string; account_id: string | null;
  status: string; current_step: number; steps: RunStep[];
  waiting_task_id: string | null; context: RunContext;
  definition_id: string; definition_version: number; playbook_key: string;
}

async function saveRun(admin: SupabaseClient, run: DefRunRow) {
  await admin.from('playbook_runs').update({
    status: run.status, current_step: run.current_step, steps: run.steps,
    waiting_task_id: run.waiting_task_id, context: run.context,
  }).eq('id', run.id);
}

async function executeDefinitionSteps(
  admin: SupabaseClient, run: DefRunRow, startIndex: number,
): Promise<{ status: string; task_id?: string }> {
  const tenantId = run.tenant_id;
  const ctx = run.context;
  const acct = () => ctx.account_name ?? 'account';

  const stepAudit = async (i: number, extra: Record<string, unknown> = {}) => {
    const s = run.steps[i];
    await audit(admin, tenantId,
      `Playbook [${acct()}] — step "${s.label}" ${s.status}${s.detail ? `: ${s.detail}` : ''}`,
      'playbook_step',
      { run_id: run.id, definition_id: run.definition_id, definition_version: run.definition_version, step_index: i, step_key: s.key, step_status: s.status, step_detail: s.detail, ...extra },
      'Playbook DE');
  };

  for (let i = startIndex; i < run.steps.length; i++) {
    const step = run.steps[i];
    const params = (step.params ?? {}) as Record<string, unknown>;
    run.current_step = i;

    try {
      switch (step.key) {
        // ────────────────────────────────────────────────
        case 'check_account': {
          const { data: account } = await admin
            .from('customer_accounts')
            .select('id, name, arr_cents, renewal_date')
            .eq('id', ctx.account_id).eq('tenant_id', tenantId).single();
          if (!account) {
            step.status = 'failed'; step.at = now(); step.detail = 'Account not found or not eligible';
            run.status = 'failed';
            await saveRun(admin, run); await stepAudit(i);
            return { status: 'failed' };
          }
          ctx.account_name = account.name;
          ctx.arr_cents = account.arr_cents;
          ctx.renewal_date = account.renewal_date;
          step.status = 'done'; step.at = now();
          step.detail = account.renewal_date
            ? `${account.name} · ARR ${fmtMoney(account.arr_cents)} · renews ${account.renewal_date}`
            : `${account.name} · ARR ${fmtMoney(account.arr_cents)} · no renewal date set`;
          break;
        }

        // ────────────────────────────────────────────────
        case 'generate_invoice': {
          const amount = params.amount_source === 'fixed'
            ? (params.fixed_amount_cents as number)
            : (ctx.arr_cents ?? 0);

          // Guardrail threshold + trust dial (R5 composition — identical to renewal_v1).
          let thresholdCents = 10_000 * 100;
          const { data: rules } = await admin
            .from('guardrail_rules').select('threshold')
            .eq('tenant_id', tenantId).eq('rule_type', 'require_approval_over_cents').eq('active', true)
            .order('updated_at', { ascending: false }).limit(1);
          if (rules?.length && typeof rules[0].threshold === 'number') thresholdCents = rules[0].threshold;

          let autonomy: { id: string; enabled: boolean; max_amount_cents: number | null } | null = null;
          try {
            const { data: auto } = await admin
              .from('de_autonomy').select('id, enabled, max_amount_cents')
              .eq('tenant_id', tenantId).eq('action_type', 'invoice_auto_send').maybeSingle();
            autonomy = auto ?? null;
          } catch { autonomy = null; }

          const guardrailAllows = amount <= thresholdCents;
          const autonomyAllows = !autonomy ||
            (autonomy.enabled && autonomy.max_amount_cents !== null && amount <= autonomy.max_amount_cents);
          const gated = !(guardrailAllows && autonomyAllows);

          const { data: invoice, error: invErr } = await admin
            .from('renewal_invoices')
            .insert({
              tenant_id: tenantId, account_id: ctx.account_id, amount_cents: amount,
              status: gated ? 'awaiting_approval' : 'sent', due_date: ctx.renewal_date ?? null,
            })
            .select().single();
          if (invErr || !invoice) throw new Error(invErr?.message ?? 'invoice insert failed');

          ctx.invoice_id = invoice.id;
          ctx.invoice_amount_cents = amount;
          ctx.invoice_status = invoice.status;
          ctx.gated = gated;
          step.status = 'done'; step.at = now();
          step.detail = `Invoice ${fmtMoney(amount)} created (${invoice.status})`;
          await stepAudit(i, { invoice_id: invoice.id, amount_cents: amount, gated, threshold_cents: thresholdCents, composition: 'autonomy_narrows_within_guardrails' });
          await audit(admin, tenantId,
            gated
              ? `Guardrail GATED — invoice ${fmtMoney(amount)} for ${acct()}: exceeds guardrail/trust-dial limits — routed to human approval`
              : `Guardrail passed — invoice ${fmtMoney(amount)} for ${acct()}: within guardrail and trust dial — auto-approved`,
            'guardrail_check',
            { run_id: run.id, invoice_id: invoice.id, amount_cents: amount, threshold_cents: thresholdCents, autonomy_rule_id: autonomy?.id ?? null, result: gated ? 'gated' : 'passed', composition: 'autonomy_narrows_within_guardrails' },
            'Playbook DE');
          await saveRun(admin, run);
          continue; // audit already appended above
        }

        // ────────────────────────────────────────────────
        case 'human_approval': {
          if (ctx.invoice_id && ctx.gated === false) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'Not required — invoice auto-approved within guardrail and trust dial';
            break;
          }
          const title = renderTemplate(
            (params.title_template as string) || 'Playbook approval — {{account.name}}', ctx, run.id);
          const { data: task, error: taskErr } = await admin
            .from('human_tasks')
            .insert({
              tenant_id: tenantId, type: (params.task_type as string) || 'approval_gate',
              title, detail: ctx.invoice_amount_cents ? fmtMoney(ctx.invoice_amount_cents) : '',
              source: 'system',
              related_table: ctx.invoice_id ? 'renewal_invoices' : null,
              related_id: ctx.invoice_id ?? null,
            })
            .select().single();
          if (taskErr || !task) throw new Error(taskErr?.message ?? 'task insert failed');
          step.status = 'waiting';
          step.detail = 'Waiting on the approval task in Human Tasks';
          run.status = 'waiting_approval';
          run.waiting_task_id = task.id;
          await saveRun(admin, run);
          await stepAudit(i, { task_id: task.id });
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'escalated',
            text: `Playbook "${run.playbook_key}" paused for approval — ${title}`,
          });
          return { status: 'waiting_approval', task_id: task.id };
        }

        // ────────────────────────────────────────────────
        case 'guardrail_check': {
          let thresholdCents = 10_000 * 100;
          const { data: rules } = await admin
            .from('guardrail_rules').select('threshold')
            .eq('tenant_id', tenantId).eq('rule_type', 'require_approval_over_cents').eq('active', true)
            .order('updated_at', { ascending: false }).limit(1);
          if (rules?.length && typeof rules[0].threshold === 'number') thresholdCents = rules[0].threshold;
          const amount = ctx.invoice_amount_cents ?? 0;
          const within = amount <= thresholdCents;
          step.status = 'done'; step.at = now();
          step.detail = ctx.invoice_id
            ? `Invoice ${fmtMoney(amount)} ${within ? 'within' : 'EXCEEDS'} ${fmtMoney(thresholdCents)} threshold${within ? '' : ' (human approval on record)'}`
            : 'No invoice in run context — nothing to check';
          await audit(admin, tenantId,
            `Playbook [${acct()}] — guardrail re-check: ${step.detail}`,
            'guardrail_check',
            { run_id: run.id, definition_id: run.definition_id, step_index: i, amount_cents: amount, threshold_cents: thresholdCents, result: within ? 'passed' : 'gated_with_approval' },
            'Playbook DE');
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        case 'connector_action': {
          // HONEST DEGRADATION: every missing prerequisite records a skip and continues.
          const { data: connector } = await admin
            .from('connectors').select('id, base_url, status')
            .eq('tenant_id', tenantId).eq('provider', 'zendesk').eq('status', 'connected')
            .limit(1).maybeSingle();
          const externalRef = params.external_ref_template
            ? renderTemplate(params.external_ref_template as string, ctx, run.id).trim()
            : '';
          let skip: string | null = null;
          if (!connector) skip = 'skipped: no connected Zendesk connector for this workspace';
          else if (!externalRef) skip = 'skipped: no target ticket reference in run context';

          if (!skip && connector) {
            const { data: actionRow } = await admin
              .from('connector_actions').select('enabled')
              .eq('connector_id', connector.id).eq('action_key', params.op as string).maybeSingle();
            if (!actionRow?.enabled) skip = `skipped: write-back action "${params.op}" is disabled in the registry`;
          }

          if (!skip && connector) {
            const { data: secretRow } = await admin
              .from('connector_secrets').select('secret').eq('connector_id', connector.id).maybeSingle();
            if (!secretRow?.secret) skip = 'skipped: no credentials stored for the connector';
            else {
              try {
                const creds = JSON.parse(secretRow.secret) as { email: string; api_token: string };
                const auth = 'Basic ' + btoa(`${creds.email}/token:${creds.api_token}`);
                const payloadText = renderTemplate((params.payload_template as string) ?? '', ctx, run.id);
                const body = params.op === 'add_internal_note'
                  ? { ticket: { comment: { body: payloadText, public: false } } }
                  : { ticket: { status: payloadText || 'open' } };
                const res = await fetch(
                  `${connector.base_url.replace(/\/+$/, '')}/api/v2/tickets/${encodeURIComponent(externalRef)}.json`,
                  { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!res.ok) skip = `skipped: Zendesk returned HTTP ${res.status}`;
                else {
                  step.status = 'done'; step.at = now();
                  step.detail = `Zendesk ${params.op} → ticket #${externalRef}`;
                  await audit(admin, tenantId,
                    `Playbook [${acct()}] — SoR write-back: ${params.op} on Zendesk ticket #${externalRef}`,
                    'connector_action',
                    { run_id: run.id, definition_id: run.definition_id, connector_id: connector.id, op: params.op, external_ref: externalRef },
                    'Playbook DE');
                }
              } catch (e) {
                skip = `skipped: connector call failed (${String(e).slice(0, 120)})`;
              }
            }
          }

          if (skip) {
            step.status = 'skipped'; step.at = now(); step.detail = skip;
          }
          break;
        }

        // ────────────────────────────────────────────────
        case 'update_record': {
          const table = params.table as string;
          const status = ((params.set ?? {}) as Record<string, unknown>).status as string;
          const allowed = UPDATE_WHITELIST[table] ?? [];
          const targetId = table === 'renewal_invoices' ? ctx.invoice_id : ctx.ticket_id;
          if (!allowed.includes(status)) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: "${status}" is not a whitelisted status for ${table}`;
          } else if (!targetId) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: no target record in run context';
          } else {
            const { error: updErr } = await admin.from(table)
              .update({ status }).eq('id', targetId).eq('tenant_id', tenantId);
            if (updErr) throw new Error(updErr.message);
            if (table === 'renewal_invoices') ctx.invoice_status = status;
            step.status = 'done'; step.at = now();
            step.detail = `${table}.status → ${status}`;
          }
          break;
        }

        // ────────────────────────────────────────────────
        case 'log_activity': {
          const text = renderTemplate((params.text_template as string) ?? 'Playbook step executed', ctx, run.id);
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'resolved', text,
          });
          step.status = 'done'; step.at = now(); step.detail = text;
          break;
        }

        // ────────────────────────────────────────────────
        case 'complete': {
          step.status = 'done'; step.at = now(); step.detail = 'Run completed';
          run.status = 'completed';
          run.waiting_task_id = null;
          await saveRun(admin, run);
          await stepAudit(i);
          await audit(admin, tenantId,
            `Playbook [${acct()}] — run completed end-to-end`,
            'playbook_step',
            { run_id: run.id, definition_id: run.definition_id, definition_version: run.definition_version, invoice_id: ctx.invoice_id ?? null },
            'Playbook DE');
          return { status: 'completed' };
        }

        default: {
          step.status = 'skipped'; step.at = now();
          step.detail = `skipped: unknown primitive "${step.key}"`;
        }
      }
    } catch (err) {
      step.status = 'failed'; step.at = now();
      step.detail = `failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      run.status = 'failed';
      await saveRun(admin, run);
      await stepAudit(i);
      return { status: 'failed' };
    }

    await saveRun(admin, run);
    await stepAudit(i);
  }

  // Defensive: validation guarantees a trailing complete step.
  run.status = 'completed';
  run.waiting_task_id = null;
  await saveRun(admin, run);
  return { status: 'completed' };
}

// ═══════════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const action = body?.action;
    if (!['start', 'advance', 'cancel', 'publish', 'validate'].includes(action)) {
      return json({ error: 'invalid action' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service-role key + body.tenant_id ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    let userId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      userId = userData.user.id;
      const { data: profile } = await admin
        .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ────────────────────────────────────────────────────────────
    // validate — dry validation of a steps array or a saved draft
    // ────────────────────────────────────────────────────────────
    if (action === 'validate') {
      let steps = body?.steps;
      if (!steps && body?.definition_id) {
        const { data: def } = await admin.from('playbook_definitions')
          .select('steps').eq('id', body.definition_id).eq('tenant_id', tenantId).maybeSingle();
        if (!def) return json({ error: 'definition_not_found' }, 404);
        steps = def.steps;
      }
      const errors = validateSteps(steps);
      return json({ valid: errors.length === 0, errors });
    }

    // ────────────────────────────────────────────────────────────
    // publish — validate, bump version, snapshot, mark published
    // ────────────────────────────────────────────────────────────
    if (action === 'publish') {
      const defId = body?.definition_id;
      if (!defId) return json({ error: 'definition_id required' }, 400);
      const { data: def } = await admin.from('playbook_definitions')
        .select('*').eq('id', defId).eq('tenant_id', tenantId).maybeSingle();
      if (!def) return json({ error: 'definition_not_found' }, 404);
      if (def.status === 'archived') return json({ error: 'definition_archived' }, 400);

      const errors = validateSteps(def.steps);
      if (errors.length > 0) return json({ published: false, valid: false, errors }, 422);

      // Version number: next after the latest snapshot (first publish → 1).
      const { data: latest } = await admin.from('playbook_versions')
        .select('version').eq('definition_id', defId)
        .order('version', { ascending: false }).limit(1).maybeSingle();
      const nextVersion = (latest?.version ?? 0) + 1;

      const { error: snapErr } = await admin.from('playbook_versions').insert({
        definition_id: defId, version: nextVersion, steps: def.steps, published_by: userId,
      });
      if (snapErr) return json({ error: snapErr.message }, 500);

      const { error: updErr } = await admin.from('playbook_definitions')
        .update({ version: nextVersion, status: 'published' }).eq('id', defId);
      if (updErr) return json({ error: updErr.message }, 500);

      await audit(admin, tenantId,
        `Playbook definition published — "${def.name}" (${def.key}) v${nextVersion}`,
        'config_change',
        { kind: 'playbook_definition', definition_id: defId, key: def.key, version: nextVersion, step_count: (def.steps as unknown[]).length },
        'Playbook DE');
      return json({ published: true, version: nextVersion });
    }

    // ────────────────────────────────────────────────────────────
    // start
    // ────────────────────────────────────────────────────────────
    if (action === 'start') {
      // ── R6: definition-based start ──
      if (body?.definition_id) {
        const accountId = body?.account_id;
        if (!accountId) return json({ error: 'account_id required' }, 400);
        const { data: def } = await admin.from('playbook_definitions')
          .select('*').eq('id', body.definition_id).eq('tenant_id', tenantId).maybeSingle();
        if (!def) return json({ error: 'definition_not_found' }, 404);
        if (def.status !== 'published') return json({ error: 'definition_not_published' }, 400);

        // Runs execute the IMMUTABLE published snapshot, never the live draft.
        const { data: snapshot } = await admin.from('playbook_versions')
          .select('version, steps').eq('definition_id', def.id)
          .order('version', { ascending: false }).limit(1).maybeSingle();
        if (!snapshot) return json({ error: 'no_published_version' }, 400);

        const errors = validateSteps(snapshot.steps);
        if (errors.length > 0) return json({ error: 'invalid_definition', errors }, 422);

        const steps: RunStep[] = (snapshot.steps as DefStep[]).map((s) => ({
          key: s.key,
          label: s.label || PRIMITIVE_LABELS[s.key] || s.key,
          status: 'pending', at: null, detail: '',
          params: s.params ?? {},
        }));
        const context: RunContext = { account_id: accountId };
        const { data: runRow, error: runErr } = await admin
          .from('playbook_runs')
          .insert({
            tenant_id: tenantId, playbook_key: def.key, account_id: accountId,
            status: 'running', current_step: 0, steps, context,
            definition_id: def.id, definition_version: snapshot.version,
          })
          .select().single();
        if (runErr || !runRow) return json({ error: runErr?.message ?? 'run insert failed' }, 500);

        const run: DefRunRow = {
          id: runRow.id, tenant_id: tenantId, account_id: accountId,
          status: 'running', current_step: 0, steps, waiting_task_id: null,
          context, definition_id: def.id, definition_version: snapshot.version,
          playbook_key: def.key,
        };
        const result = await executeDefinitionSteps(admin, run, 0);
        return json({ run_id: run.id, status: result.status, task_id: result.task_id, steps: run.steps });
      }

      // ── LEGACY: renewal_v1 (unchanged behavior — regression-protected) ──
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
      let { data: run } = await query.maybeSingle();
      // Definition runs parked by the SQL resume have waiting_task_id
      // cleared — find them via the task's related run in resume_pending.
      if (!run && body?.task_id) {
        const { data: parked } = await admin.from('playbook_runs')
          .select('*').eq('tenant_id', tenantId).eq('status', 'resume_pending')
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        run = parked ?? null;
      }
      if (!run) return json({ advanced: false, reason: 'run_not_found' }, 404);

      // ── R6: definition run parked for the HTTP-capable advance ──
      if (run.definition_id && run.status === 'resume_pending') {
        const defRun: DefRunRow = {
          id: run.id, tenant_id: run.tenant_id, account_id: run.account_id,
          status: 'running', current_step: run.current_step,
          steps: run.steps as RunStep[], waiting_task_id: null,
          context: (run.context ?? {}) as RunContext,
          definition_id: run.definition_id, definition_version: run.definition_version ?? 1,
          playbook_key: run.playbook_key,
        };
        const result = await executeDefinitionSteps(admin, defRun, run.current_step);
        return json({ advanced: true, status: result.status, run_id: run.id });
      }

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
      // If the SQL resume parked the run at a connector step, finish it here.
      if ((res as { needs_http?: boolean })?.needs_http) {
        const { data: parked } = await admin.from('playbook_runs')
          .select('*').eq('id', (res as { run_id: string }).run_id).maybeSingle();
        if (parked?.status === 'resume_pending' && parked.definition_id) {
          const defRun: DefRunRow = {
            id: parked.id, tenant_id: parked.tenant_id, account_id: parked.account_id,
            status: 'running', current_step: parked.current_step,
            steps: parked.steps as RunStep[], waiting_task_id: null,
            context: (parked.context ?? {}) as RunContext,
            definition_id: parked.definition_id, definition_version: parked.definition_version ?? 1,
            playbook_key: parked.playbook_key,
          };
          const result = await executeDefinitionSteps(admin, defRun, parked.current_step);
          return json({ advanced: true, result: res, status: result.status });
        }
      }
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
    await audit(admin, tenantId, `Playbook run cancelled by operator`, 'playbook_step',
      { run_id: runId, previous_status: run.status, definition_id: run.definition_id ?? null });
    return json({ cancelled: true, run_id: runId });
  } catch (err) {
    console.error('playbook-execute error:', err);
    return json({ error: String(err) }, 500);
  }
});
