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
  await resolveActionExecution(taskId, 'approved');
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('human_tasks')
    .update({ status: 'approved', decided_by: user?.id ?? null, decided_at: new Date().toISOString() })
    .eq('id', taskId);
}
