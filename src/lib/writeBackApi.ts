// Account write-backs — the DE closing the loop in the system of record (EXEC 0.3).
//
// A DE proposes a write-back (log an activity, set a next step, change status)
// through propose_account_writeback (migration 215). It's server-composed +
// frozen, and gated: a destructive write always waits for a human. This resolver
// is the decideHumanTask hook — approving the task applies the frozen write;
// rejecting leaves the record untouched.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

/** Hook target for decideHumanTask on related_table='account_writeback_requests'. */
export async function resolveAccountWriteback(taskId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_account_writeback', { p_task_id: taskId, p_decision: decision });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(error?.message || res?.error || 'Could not resolve the write-back.');
}

/** Hook target for decideHumanTask on related_table='opportunity_writeback_requests' (pipeline desk, mig 220). */
export async function resolveOpportunityWriteback(taskId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_opportunity_writeback', { p_task_id: taskId, p_decision: decision });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(error?.message || res?.error || 'Could not resolve the pipeline write-back.');
}

/** Hook target for decideHumanTask on related_table='continuity_writeback_requests' (continuity case desk, mig 227). */
export async function resolveContinuityWriteback(taskId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_continuity_writeback', { p_task_id: taskId, p_decision: decision });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(error?.message || res?.error || 'Could not resolve the continuity write-back.');
}

export interface AccountActivity {
  id: string;
  account_id: string;
  kind: string;
  summary: string;
  created_at: string;
}

/** The activity timeline for an account — proof the loop was closed. */
export async function listAccountActivities(accountId: string, limit = 50): Promise<AccountActivity[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('account_activities')
    .select('id, account_id, kind, summary, created_at')
    .eq('tenant_id', tid).eq('account_id', accountId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AccountActivity[];
}
