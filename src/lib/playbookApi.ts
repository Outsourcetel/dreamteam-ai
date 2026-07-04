// ============================================================
// Workforce Engine (P3) — the one real playbook: renewal_v1.
//
// HONEST V1: orchestration is client-side (the browser drives the
// steps and persists state in playbook_runs). Server-side execution
// (edge function / queue) is the production hardening step — the
// data model and audit trail are already shaped for it.
//
// Steps: check_account → generate_invoice → guardrail_gate →
//        human_approval → mark_sent → complete
// The human_approval step pauses the run (status waiting_approval,
// waiting_task_id set); decideHumanTask() calls resumeRunForTask().
// ============================================================
import { supabase } from '../supabase';
import {
  getSessionTenantId, CustomerApiError, isMissingTableError,
  updateInvoice, logActivity, fmtMoney,
  generateInvoice,
} from './customerApi';
import type { CustomerAccount } from './customerApi';
import { appendAuditEvent } from './guardrailApi';

export type RunStatus = 'running' | 'waiting_approval' | 'completed' | 'cancelled';
export type StepStatus = 'pending' | 'done' | 'waiting' | 'skipped' | 'failed' | 'cancelled';

export interface RunStep {
  key: string;
  label: string;
  status: StepStatus;
  at: string | null;
  detail: string;
}

export interface PlaybookRun {
  id: string;
  tenant_id: string;
  playbook_key: string;
  account_id: string | null;
  status: RunStatus;
  current_step: number;
  steps: RunStep[];
  waiting_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export const RENEWAL_STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: 'check_account', label: 'Check account' },
  { key: 'generate_invoice', label: 'Generate invoice' },
  { key: 'guardrail_gate', label: 'Guardrail check' },
  { key: 'human_approval', label: 'Human approval' },
  { key: 'mark_sent', label: 'Send invoice' },
  { key: 'complete', label: 'Complete' },
];

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

const notify = () => { try { window.dispatchEvent(new Event('dt-state-changed')); } catch { /* noop */ } };

export async function listPlaybookRuns(): Promise<PlaybookRun[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_runs')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listPlaybookRuns', error);
  return (data ?? []) as PlaybookRun[];
}

async function saveRun(
  id: string,
  updates: Partial<Pick<PlaybookRun, 'status' | 'current_step' | 'steps' | 'waiting_task_id'>>
): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('playbook_runs')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid);
  if (error) raise('saveRun', error);
}

function stepAudit(runId: string, accountName: string, step: RunStep) {
  return appendAuditEvent({
    actor: 'Renewal DE', actor_type: 'de', category: 'playbook_step',
    action: `Renewal playbook [${accountName}] — step "${step.label}" ${step.status}${step.detail ? `: ${step.detail}` : ''}`,
    detail: { run_id: runId, step_key: step.key, step_status: step.status, step_detail: step.detail },
  });
}

const now = () => new Date().toISOString();

/**
 * Execute the renewal playbook for an account. Runs synchronously through
 * the steps; pauses at human_approval when the invoice is gated by the
 * tenant's approval-threshold guardrail.
 */
export async function startRenewalRun(
  account: CustomerAccount
): Promise<PlaybookRun> {
  const tid = await requireTenantId();
  const steps: RunStep[] = RENEWAL_STEP_DEFS.map(d => ({ ...d, status: 'pending', at: null, detail: '' }));

  const { data, error } = await supabase
    .from('playbook_runs')
    .insert({ tenant_id: tid, playbook_key: 'renewal_v1', account_id: account.id, status: 'running', current_step: 0, steps })
    .select()
    .single();
  if (error) raise('startRenewalRun', error);
  const run = data as PlaybookRun;

  // ── Step 1: check_account ──
  steps[0].status = 'done';
  steps[0].at = now();
  steps[0].detail = account.renewal_date
    ? `${account.name} · ARR ${fmtMoney(account.arr_cents)} · renews ${account.renewal_date}`
    : `${account.name} · ARR ${fmtMoney(account.arr_cents)} · no renewal date set`;
  await stepAudit(run.id, account.name, steps[0]);

  // ── Step 2: generate_invoice (guardrail-aware) ──
  const { invoice, gated, task, thresholdCents } = await generateInvoice(account);
  steps[1].status = 'done';
  steps[1].at = now();
  steps[1].detail = `Invoice ${fmtMoney(invoice.amount_cents)} created (${invoice.status})`;
  await stepAudit(run.id, account.name, steps[1]);

  // ── Step 3: guardrail_gate ──
  steps[2].status = 'done';
  steps[2].at = now();
  steps[2].detail = gated
    ? `Amount exceeds ${fmtMoney(thresholdCents)} approval threshold — routed to human approval`
    : `Under ${fmtMoney(thresholdCents)} approval threshold — auto-approved`;
  await stepAudit(run.id, account.name, steps[2]);

  if (gated && task) {
    // ── Step 4 pauses: human_approval ──
    steps[3].status = 'waiting';
    steps[3].detail = 'Waiting on the approval task in Human Tasks';
    await saveRun(run.id, { status: 'waiting_approval', current_step: 3, steps, waiting_task_id: task.id });
    await stepAudit(run.id, account.name, steps[3]);
    notify();
    return { ...run, status: 'waiting_approval', current_step: 3, steps, waiting_task_id: task.id };
  }

  // Not gated: skip the human gate and finish.
  steps[3].status = 'skipped';
  steps[3].at = now();
  steps[3].detail = 'Not required — under the approval threshold';
  await finishRun(run.id, account.name, invoice.id, steps, invoice.amount_cents);
  return { ...run, status: 'completed', current_step: 5, steps };
}

async function finishRun(
  runId: string,
  accountName: string,
  invoiceId: string,
  steps: RunStep[],
  amountCents: number
): Promise<void> {
  // ── Step 5: mark_sent (invoice → sent, cadence day-0) ──
  await updateInvoice(invoiceId, { status: 'sent', cadence_stage: 1 });
  steps[4].status = 'done';
  steps[4].at = now();
  steps[4].detail = `Invoice ${fmtMoney(amountCents)} sent · cadence Day-0 started`;
  await stepAudit(runId, accountName, steps[4]);
  await logActivity({
    actor: 'Renewal DE', actor_type: 'de', event_type: 'resolved',
    text: `Renewal playbook sent invoice — ${accountName} (${fmtMoney(amountCents)}), dunning cadence started`,
  });

  // ── Step 6: complete ──
  steps[5].status = 'done';
  steps[5].at = now();
  steps[5].detail = 'Run completed';
  await saveRun(runId, { status: 'completed', current_step: 5, steps, waiting_task_id: null });
  await stepAudit(runId, accountName, steps[5]);
  await appendAuditEvent({
    actor: 'Renewal DE', actor_type: 'de', category: 'playbook_step',
    action: `Renewal playbook [${accountName}] — run completed end-to-end`,
    detail: { run_id: runId, invoice_id: invoiceId, amount_cents: amountCents },
  });
  notify();
}

/**
 * Hook called by decideHumanTask(): if a run is paused on this task,
 * approve → resume (mark_sent + complete); reject → cancel the run.
 * decideHumanTask has already flipped the invoice to 'sent' on approve.
 */
export async function resumeRunForTask(
  taskId: string,
  decision: 'approved' | 'rejected'
): Promise<void> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_runs')
    .select('*')
    .eq('tenant_id', tid)
    .eq('waiting_task_id', taskId)
    .eq('status', 'waiting_approval')
    .maybeSingle();
  if (error) {
    // Missing table (migration 015 not applied) is fine — no runs to resume.
    if (isMissingTableError(error)) return;
    raise('resumeRunForTask', error);
  }
  if (!data) return;
  const run = data as PlaybookRun;
  const steps = run.steps.map(s => ({ ...s }));
  const accountName = (steps[0]?.detail || '').split(' · ')[0] || 'account';

  if (decision === 'rejected') {
    steps[3].status = 'cancelled';
    steps[3].at = now();
    steps[3].detail = 'Rejected by human reviewer';
    for (let i = 4; i < steps.length; i++) if (steps[i].status === 'pending') steps[i].status = 'cancelled';
    await saveRun(run.id, { status: 'cancelled', current_step: 3, steps, waiting_task_id: null });
    await stepAudit(run.id, accountName, steps[3]);
    await appendAuditEvent({
      actor: 'Renewal DE', actor_type: 'de', category: 'playbook_step',
      action: `Renewal playbook [${accountName}] — run cancelled (approval rejected)`,
      detail: { run_id: run.id, task_id: taskId },
    });
    notify();
    return;
  }

  steps[3].status = 'done';
  steps[3].at = now();
  steps[3].detail = 'Approved by human reviewer';
  await stepAudit(run.id, accountName, steps[3]);

  // Find the invoice + amount from the run's account.
  let invoiceId: string | null = null;
  let amountCents = 0;
  if (run.account_id) {
    const { data: inv } = await supabase
      .from('renewal_invoices')
      .select('id, amount_cents')
      .eq('tenant_id', tid)
      .eq('account_id', run.account_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inv) { invoiceId = inv.id; amountCents = inv.amount_cents; }
  }
  if (invoiceId) {
    await finishRun(run.id, accountName, invoiceId, steps, amountCents);
  } else {
    steps[5].status = 'done';
    steps[5].at = now();
    steps[5].detail = 'Run completed (invoice not found for cadence update)';
    await saveRun(run.id, { status: 'completed', current_step: 5, steps, waiting_task_id: null });
    notify();
  }
}
