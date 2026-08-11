// approvalBriefsApi.ts — the ADVISORY brief beside each pending approval
// (migration 705, Gap 1: "AI asks for decisions but never helps make them").
//
// Every line is rail-computed SQL evidence — precedent counts, landed history,
// amount vs the workspace's approval dials, standing — plus a deterministic
// risk rank. No model is involved anywhere, so a brief costs nothing and can
// never hallucinate.
//
// ⛔ ADVISORY ONLY. The server side is privilege-bounded (the brief writer
// role holds no EXECUTE on decide_human_task and no write on human_tasks —
// Ring-0 probe `advisory-layer-cannot-decide`), and this client must keep the
// same posture: nothing in this module, and nothing rendered from it, may
// pre-select, pre-fill or trigger a decision. Auto-approve is Gap 2 and a
// founder decision.
//
// Freshness: list_approval_briefs RECOMPUTES every pending brief for the
// caller's workspace before returning, so what renders is never a stored
// marker read as current truth.
import { supabase } from '../supabase';

export type BriefRisk = 'routine' | 'caution' | 'attention';

export interface ApprovalBrief {
  task_id: string;
  risk: BriefRisk;
  /** One rail-composed advisory sentence, e.g. "Looks routine — 12 identical
   *  prior approvals, none rejected, and the last run landed." */
  headline: string;
  /** Deterministic evidence lines, in display order. */
  evidence: string[];
  computed_at: string;
}

const RISKS: BriefRisk[] = ['routine', 'caution', 'attention'];

/** Briefs for every PENDING action_approval in the caller's workspace,
 *  keyed by task id. Advisory overlay: callers must treat a failure here as
 *  "no briefs", never as a reason to block the queue. */
export async function listApprovalBriefs(): Promise<Map<string, ApprovalBrief>> {
  const { data, error } = await supabase.rpc('list_approval_briefs');
  if (error) throw new Error(error.message);
  const map = new Map<string, ApprovalBrief>();
  for (const row of (data ?? []) as Array<{
    task_id: string; risk: string; headline: string; evidence: unknown; computed_at: string;
  }>) {
    // A malformed row is dropped, not rendered — wrong advice is worse than
    // no advice.
    if (!row.task_id || !RISKS.includes(row.risk as BriefRisk)) continue;
    map.set(row.task_id, {
      task_id: row.task_id,
      risk: row.risk as BriefRisk,
      headline: String(row.headline ?? ''),
      evidence: Array.isArray(row.evidence) ? row.evidence.map((l) => String(l)) : [],
      computed_at: row.computed_at,
    });
  }
  return map;
}

/** Queue ordering: the safest decisions first (one-glance clears), the risky
 *  ones last but loudly chipped. Tasks without a brief (every non-approval
 *  type) sit between, keeping their existing order. */
export function briefSortKey(brief: ApprovalBrief | undefined): number {
  if (!brief) return 2;
  return { routine: 0, caution: 1, attention: 3 }[brief.risk];
}

export const BRIEF_CHIP: Record<BriefRisk, { tone: 'ok' | 'warn' | 'danger'; label: string }> = {
  routine: { tone: 'ok', label: 'Looks routine' },
  caution: { tone: 'warn', label: 'Worth a look' },
  attention: { tone: 'danger', label: 'Needs attention' },
};
