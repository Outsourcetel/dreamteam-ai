// ============================================================
// "Digital employee at work" — the evidence-run feed.
//
// Split out of the old specialistApi when the specialist role was retired
// (migrations 208/211 absorbed specialists into digital_employees; every
// remaining is_specialist row is disabled). None of this is specialist-specific
// — it reads evidence_runs and their decisions for ANY digital employee — but
// it lived in that module, so deleting the module wholesale would have taken
// the Workforce activity tab and the employee file's activity list with it.
//
// Every row is a DECISION on top of an evidence_runs row: would the employee
// have auto-sent, does it need a human, was it blocked by a guardrail, or was
// it skipped for lack of an access grant.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

// ── Evidence runs ─────────────────────────────────────────────────

export type EvidenceOutcome = 'ok' | 'skipped_not_connected' | 'failed';

export interface EvidenceCitation { system: string; ref: string; title: string; url: string | null; snippet: string }

export interface EvidenceStep {
  kind: 'account_context' | 'knowledge_search' | 'history_check' | 'prior_experience' | 'mcp_tool' | 'compose' | 'de_consultation';
  system: string;
  query: string;
  outcome: EvidenceOutcome | 'denied_no_access';
  summary: string;
  item_count: number;
  latency_ms: number;
  citations: EvidenceCitation[];
  /** Category-contract fields (migration 027/036) — which canonical
   *  category+op this step called, and which provider answered it.
   *  Not every step carries these (e.g. the internal knowledge_search
   *  step over knowledge_docs has no connector behind it). */
  category?: string;
  op?: string;
  provider?: string;
}

export interface EvidenceRun {
  id: string;
  tenant_id: string;
  de_id: string | null;
  inquiry: string;
  account_ref: string | null;
  status: 'running' | 'complete' | 'failed';
  steps: EvidenceStep[];
  confidence_inputs: {
    knowledge_hits?: number;
    history_corroborations?: number;
    prior_experience_hits?: number;
    account_context_found?: boolean;
    systems_consulted?: number;
    systems_skipped_not_connected?: number;
    systems_failed?: number;
  };
  answer_status: 'llm_not_configured' | 'answered' | 'blocked' | 'error';
  answer: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function listEvidenceRuns(limit = 20): Promise<EvidenceRun[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('evidence_runs').select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) raise('listEvidenceRuns', error);
  return (data ?? []) as EvidenceRun[];
}

// ── Decisions (migration 034/036) ─────────────────────────────────

export type InquiryDecisionSource = 'manual' | 'proactive_trigger' | 'manual_simulation';

// 'would_act'/'acted' added in migration 036 (the Generalized Trigger
// Layer) — the act-side siblings of would_auto_send/needs_review. A
// decision becomes 'would_act' when a registered action_definition
// exists for the item's category but composition (destructive-always-
// gates / guardrail / trust) requires human approval first, and
// 'acted' when connector-hub's execute_action actually ran (auto or
// after approval) — distinct from 'would_auto_send', which still only
// ever records intent to ANSWER, never to act.
export type InquiryDecisionKind =
  | 'would_auto_send' | 'needs_review' | 'blocked_guardrail' | 'skipped_no_access'
  | 'would_act' | 'acted';

export interface EvidenceRunDecision {
  id: string;
  tenant_id: string;
  evidence_run_id: string;
  connector_id: string | null;
  external_ref: string | null;
  source: InquiryDecisionSource;
  decision: InquiryDecisionKind;
  confidence: number | null;
  guardrail_rule_id: string | null;
  trust_level: number | null;
  reasoning: string;
  human_task_id: string | null;
  created_at: string;
  /** migration 036: which of the 9 category-contract categories this
   *  item came from (null for pre-036 rows/the manual path when a
   *  category wasn't recorded), and the linked action_executions row
   *  when the decision resulted in (or awaits) a real ACT attempt. */
  source_category?: string | null;
  action_execution_id?: string | null;
}

/** Live feed: evidence_runs joined with their decision (when one exists —
 *  human-invoked runs have none, honestly, since a human reading the answer
 *  IS the decision there). */
export interface DEActivityRow {
  evidence_run: EvidenceRun;
  decision: EvidenceRunDecision | null;
  /** Who did this work, resolved to a display name so the queue can be
   *  filtered per employee. null when de_id is unset (legacy rows). */
  subject_name?: string | null;
}

// Wave-2 fix (truth audit 2026-07-22): optional deId pushes the per-employee
// filter INTO the query. Before, callers filtered client-side after a
// tenant-wide limit — on a busy tenant a DE outside the newest N rows showed
// a false "no decisions yet". Decisions are fetched for exactly the returned
// runs, not by their own tenant-wide limit.
export async function listDEActivity(limit = 30, deId?: string | null): Promise<DEActivityRow[]> {
  const tid = await requireTenantId();
  let runsQ = supabase.from('evidence_runs').select('*').eq('tenant_id', tid);
  if (deId) runsQ = runsQ.eq('de_id', deId);
  const [{ data: runs, error: runErr }, { data: des }] = await Promise.all([
    runsQ.order('created_at', { ascending: false }).limit(limit),
    // One lookup over every employee. The retired specialists are ordinary
    // digital_employees rows, so the 190 historical runs that name one still
    // resolve — which is exactly why those rows were retired, not deleted
    // (the FK cascades).
    supabase.from('digital_employees').select('id, name, persona_name').eq('tenant_id', tid),
  ]);
  if (runErr) raise('listDEActivity (evidence_runs)', runErr);

  const runIds = ((runs ?? []) as EvidenceRun[]).map((r) => r.id);
  const { data: decisions, error: decErr } = runIds.length > 0
    ? await supabase.from('evidence_run_decisions').select('*').eq('tenant_id', tid).in('evidence_run_id', runIds)
    : { data: [], error: null };
  if (decErr) raise('listDEActivity (evidence_run_decisions)', decErr);

  const byRun = new Map<string, EvidenceRunDecision>();
  for (const d of (decisions ?? []) as EvidenceRunDecision[]) byRun.set(d.evidence_run_id, d);

  const deName = new Map<string, string>();
  for (const d of (des ?? []) as Array<{ id: string; name: string; persona_name: string | null }>) {
    deName.set(d.id, d.persona_name || d.name);
  }

  return ((runs ?? []) as EvidenceRun[]).map((r) => ({
    evidence_run: r,
    decision: byRun.get(r.id) ?? null,
    subject_name: r.de_id ? (deName.get(r.de_id) ?? null) : null,
  }));
}
