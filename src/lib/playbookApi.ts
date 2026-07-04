// ============================================================
// Workforce Engine — renewal_v1 playbook, THIN CLIENT (R4).
//
// Orchestration is server-authoritative: the playbook-execute edge
// function runs every step (guardrail threshold + trust-dial
// composition, invoice, human gate, audit events) with the service
// role. Runs survive closed tabs. The browser only starts, observes,
// and cancels.
//
// Human-gate resume is also server-side: decideHumanTask() calls the
// resume_playbook_on_task RPC (migration 016, SECURITY DEFINER —
// status flips + invoice sent + audit events all in SQL). If the RPC
// is missing (migration not applied), the client falls back to the
// edge function's 'advance' action.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import type { CustomerAccount } from './customerApi';

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

// ── Read helpers ──────────────────────────────────────────────────

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

export async function getPlaybookRun(runId: string): Promise<PlaybookRun | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_runs')
    .select('*')
    .eq('tenant_id', tid)
    .eq('id', runId)
    .maybeSingle();
  if (error) raise('getPlaybookRun', error);
  return (data as PlaybookRun) ?? null;
}

// ── Server-side execution (playbook-execute edge function) ───────

interface StartResponse { run_id: string; status: RunStatus; task_id?: string; steps: RunStep[]; error?: string }

/** Start a renewal run — executed entirely server-side. */
export async function startRenewalRun(account: CustomerAccount): Promise<PlaybookRun> {
  await requireTenantId();
  const { data, error } = await supabase.functions.invoke('playbook-execute', {
    body: { action: 'start', playbook_key: 'renewal_v1', account_id: account.id },
  });
  if (error) raise('startRenewalRun', { message: error.message ?? String(error) });
  const res = data as StartResponse;
  if (res?.error) raise('startRenewalRun', { message: res.error });
  notify();
  const run = await getPlaybookRun(res.run_id);
  if (run) return run;
  // Fallback shape if the read races the write.
  return {
    id: res.run_id, tenant_id: '', playbook_key: 'renewal_v1', account_id: account.id,
    status: res.status, current_step: res.status === 'completed' ? 5 : 3,
    steps: res.steps, waiting_task_id: res.task_id ?? null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

/** Cancel a run (server-side). */
export async function cancelRun(runId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('playbook-execute', {
    body: { action: 'cancel', run_id: runId },
  });
  if (error) raise('cancelRun', { message: error.message ?? String(error) });
  if ((data as { error?: string })?.error) raise('cancelRun', { message: (data as { error: string }).error });
  notify();
}

/**
 * Resume the run waiting on a decided human task. Primary path: the
 * resume_playbook_on_task RPC (server-authoritative SQL). Fallback when
 * the RPC is missing: the edge function's idempotent 'advance' action.
 */
export async function resumeRunForTask(
  taskId: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const { error } = await supabase.rpc('resume_playbook_on_task', {
    p_task_id: taskId,
    p_decision: decision,
  });
  if (!error) { notify(); return; }
  // PGRST202 / 42883: function not found — migration 016 not applied yet.
  console.warn('resume_playbook_on_task RPC unavailable, falling back to edge advance:', error.message);
  try {
    await supabase.functions.invoke('playbook-execute', {
      body: { action: 'advance', task_id: taskId },
    });
    notify();
  } catch (err) {
    console.error('resumeRunForTask fallback:', err);
  }
}
