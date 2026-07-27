// ============================================================
// Onboarding Architect (Quick Start) — client API.
// Drives the tenant's "DreamTeam Onboarding Architect" DE via the
// onboarding-assist edge function, then approves its proposals through
// the existing human-task/action-approval path (decideHumanTask →
// resolveActionExecution). Every proposal is human-gated (migration 142):
// nothing is built until the admin approves it here.
// ============================================================
import { supabase } from '../supabase';

export interface ArchitectProposal {
  execution_id: string;
  task_id: string | null;
  action_label: string;
  summary: string | null;
  params: Record<string, unknown>;
}

export interface OnboardingAssistResult {
  ok?: boolean;
  run_id?: string;
  /** completed | rate_limited | failed | max_iterations_exceeded | blocked_llm | ... */
  status?: string;
  architect_name?: string;
  summary?: string | null;
  proposals: ArchitectProposal[];
  error?: string;
  detail?: string;
}

/** Ask the Onboarding Architect to design a setup from a plain-language brief. */
export async function runOnboardingAssist(description: string): Promise<OnboardingAssistResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-assist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ description }),
  });
  const data = await res.json().catch(() => ({}));
  return { proposals: [], ...data } as OnboardingAssistResult;
}

import { resolveActionExecution } from './connectorApi';

/** Approve one proposal: execute the gated build (creates the DE/playbook/etc.)
 *  and mark its approval task resolved. Mirrors decideHumanTask's action-approval
 *  path without needing the full task object. */
export async function approveProposal(taskId: string): Promise<void> {
  // ⚠ ORDER REVERSED, DELIBERATELY. This used to execute the gated build FIRST
  // and mark the task approved afterwards, with no pending-only clause on
  // either step — so a double-click or a retry ran the build twice and created
  // the DE/playbook twice. That is the exact shape docs/24 records as a live
  // double-charge on the gated-action path.
  //
  // Now the task is CLAIMED first, atomically, through decide_human_task
  // (migration 455). Its UPDATE carries `AND status = 'pending'`, so exactly
  // one caller can win. A null return means somebody else already decided it —
  // and the build must NOT run again, which is the same contract
  // decideHumanTask has always relied on for its own hooks.
  const { data, error } = await supabase.rpc('decide_human_task', {
    p_task_id: taskId, p_decision: 'approved',
    p_reason_code: null, p_note: null, p_edit: null,
  });
  if (error) throw new Error(error.message);
  if (!data) return;                    // already decided — do not re-execute
  await resolveActionExecution(taskId, 'approved');
}
