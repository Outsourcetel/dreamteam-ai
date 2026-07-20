// Case timeline — what a Digital Employee is parked on (EXEC 0.2).
//
// A renewal or dunning motion runs over weeks: the DE sends something, then
// PAUSES the case — waiting for a date or for a reply — and resumes when the
// continuation is due (migration 214). This surfaces those pending
// continuations so a human can see, at a glance, what the employee is waiting
// on and when it will pick each case back up.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export interface CaseContinuation {
  id: string;
  objective_id: string;
  objective_title: string;
  kind: 'wait' | 'follow_up';
  fire_at: string;
  awaiting_ref: string | null;
  instruction: string;
  status: 'pending' | 'fired' | 'resolved' | 'cancelled';
}

/** Pending continuations for a DE, soonest first — the employee's "waiting on" list. */
export async function listPendingContinuations(deId: string): Promise<CaseContinuation[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_case_events')
    .select('id, objective_id, kind, fire_at, awaiting_ref, instruction, status, de_objectives(title)')
    .eq('tenant_id', tid).eq('de_id', deId).eq('status', 'pending')
    .order('fire_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    objective_id: r.objective_id as string,
    objective_title: ((r.de_objectives as { title?: string } | null)?.title) ?? 'Case',
    kind: r.kind as 'wait' | 'follow_up',
    fire_at: r.fire_at as string,
    awaiting_ref: (r.awaiting_ref as string | null) ?? null,
    instruction: (r.instruction as string) ?? '',
    status: r.status as CaseContinuation['status'],
  }));
}

export async function cancelContinuation(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('cancel_case_continuation', { p_event_id: id });
  const res = data as { ok?: boolean; error?: string } | null;
  if (error || res?.ok === false) throw new Error(error?.message || res?.error || 'Could not cancel.');
}

/** Plain-language "resumes in 3 days" / "overdue" from a fire_at. */
export function whenLabel(fireAt: string): string {
  const ms = new Date(fireAt).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `resumes in ${days} day${days === 1 ? '' : 's'}`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `resumes in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return 'resumes shortly';
}
