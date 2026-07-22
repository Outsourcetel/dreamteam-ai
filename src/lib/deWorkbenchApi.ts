// DE Workbench — read layer that finally surfaces the Wave 1-3 "muscles"
// (memory, work queue, decision trace, exceptions, compliance, certification,
// training) in the UI. Every table has an RLS SELECT policy scoping to the
// caller's tenant (migs 155-163), so a de_id filter is sufficient and safe.
import { supabase } from '../supabase';

export interface MemoryRow { id: string; content: string; kind: string; subject_kind: string; subject_ref: string | null; salience: number; created_at: string }
export interface ObjectiveRow { id: string; title: string; status: string; priority: number; due_at: string | null; created_at: string }
export interface WorkItemRow { id: string; title: string; kind: string; status: string; scheduled_for: string; attempts: number; last_error: string | null; result: Record<string, unknown> | null; created_at: string }
export interface TraceRow { id: string; run_ref: string | null; run_kind: string; seq: number; thought: string | null; tool: string | null; inputs: Record<string, unknown> | null; outputs: Record<string, unknown> | null; created_at: string }
export interface ExceptionRow { id: string; situation: string; proposed_action: string; justification: string; status: string; outcome: string | null; learned: boolean; created_at: string }
export interface CertRow { id: string; archetype_key: string | null; score_pct: number; threshold_pct: number; status: string; evaluated_at: string | null; created_at: string }
export interface CertStatus { state: 'certified' | 'stale' | 'failed' | 'uncertified' | 'unknown'; fresh: boolean; latest_passed: { score_pct: number; evaluated_at: string | null; archetype_key: string | null } | null; latest_status: string | null }
export interface TrainingRow { module_key: string; status: string; completed_at: string | null }
export interface CompliancePackRow { pack_key: string; attached_at: string; name?: string; domain?: string }
// Replay Lab (Frontier-20 #6): a past exchange the operator can re-run.
export interface ReplaySource { kind: 'failed_judgment' | 'question'; question: string; original_answer: string | null; original_score: number | null; rationale: string | null; created_at: string }
export interface ReplayResult { answer: string; confidence: number; sources: string[]; needs_escalation: boolean }

export const getDeMemory = async (deId: string, limit = 40): Promise<MemoryRow[]> => {
  const { data, error } = await supabase.from('de_memory')
    .select('id, content, kind, subject_kind, subject_ref, salience, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as MemoryRow[];
};

export const getDeObjectives = async (deId: string): Promise<ObjectiveRow[]> => {
  const { data, error } = await supabase.from('de_objectives')
    .select('id, title, status, priority, due_at, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as ObjectiveRow[];
};

// Tenant-wide "who is mid-task right now" for the Command Centre strip —
// RLS scopes to the caller's tenant; de_id comes back so rows can group
// per employee and link to each Employee File.
export type ActiveWorkRow = WorkItemRow & { de_id: string };
export const getActiveWorkAcrossDes = async (): Promise<ActiveWorkRow[]> => {
  const { data, error } = await supabase.from('de_work_items')
    .select('id, de_id, title, kind, status, scheduled_for, attempts, last_error, result, created_at')
    .in('status', ['running', 'queued', 'waiting_human'])
    .order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as ActiveWorkRow[];
};

export const getDeWorkItems = async (deId: string): Promise<WorkItemRow[]> => {
  const { data, error } = await supabase.from('de_work_items')
    .select('id, title, kind, status, scheduled_for, attempts, last_error, result, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as WorkItemRow[];
};

export const getDeTrace = async (deId: string, limit = 60): Promise<TraceRow[]> => {
  const { data, error } = await supabase.from('de_decision_trace')
    .select('id, run_ref, run_kind, seq, thought, tool, inputs, outputs, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as TraceRow[];
};

export const getDeExceptions = async (deId: string): Promise<ExceptionRow[]> => {
  const { data, error } = await supabase.from('de_exceptions')
    .select('id, situation, proposed_action, justification, status, outcome, learned, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(30);
  if (error) throw error;
  return (data ?? []) as ExceptionRow[];
};

export const getDeCertifications = async (deId: string): Promise<CertRow[]> => {
  const { data, error } = await supabase.from('role_certifications')
    .select('id, archetype_key, score_pct, threshold_pct, status, evaluated_at, created_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  return (data ?? []) as CertRow[];
};

// Replay Lab sources: judge-failed answers first (richest — they carry the
// wrong answer + why it failed), then recent real customer questions.
export const getReplaySources = async (deId: string): Promise<ReplaySource[]> => {
  const [judgRes, msgRes] = await Promise.all([
    supabase.from('eval_judgments')
      .select('question, answer, score, rationale, created_at')
      .eq('de_id', deId).eq('verdict', 'fail')
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('de_messages')
      .select('content, created_at, de_conversations!inner(de_id)')
      .eq('role', 'user').eq('de_conversations.de_id', deId)
      .order('created_at', { ascending: false }).limit(15),
  ]);
  if (judgRes.error) throw judgRes.error;
  if (msgRes.error) throw msgRes.error;
  const out: ReplaySource[] = (judgRes.data ?? []).map((j) => ({
    kind: 'failed_judgment' as const, question: j.question, original_answer: j.answer,
    original_score: j.score, rationale: j.rationale, created_at: j.created_at,
  }));
  const seen = new Set(out.map(s => s.question.trim().toLowerCase()));
  for (const m of (msgRes.data ?? []) as Array<{ content: string; created_at: string }>) {
    const q = (m.content ?? '').trim();
    if (q.length > 8 && !seen.has(q.toLowerCase())) {
      seen.add(q.toLowerCase());
      out.push({ kind: 'question', question: q, original_answer: null, original_score: null, rationale: null, created_at: m.created_at });
    }
  }
  return out.slice(0, 20);
};

// Dry-run a question against the DE, optionally with counterfactual knowledge
// injected ("what if it knew this?"). replay:true → de-answer suppresses every
// side effect: no cache read/write, no metrics, no memory, no escalation.
export const runReplay = async (deId: string, question: string, candidateKnowledge?: string): Promise<ReplayResult> => {
  const { data, error } = await supabase.functions.invoke('de-answer', {
    body: {
      question, de_id: deId, replay: true,
      ...(candidateKnowledge?.trim() ? { candidate_knowledge: candidateKnowledge.trim() } : {}),
    },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return {
    answer: data?.answer ?? '', confidence: Number(data?.confidence) || 0,
    sources: Array.isArray(data?.sources) ? data.sources.map(String) : [],
    needs_escalation: Boolean(data?.needs_escalation),
  };
};

// ── Wave 3: the workbench could only READ. These are the missing verbs. ──

/** Memory grouped by what it is ABOUT, so the tab is not a flat wall of rows. */
export interface MemoryGroup {
  subject_kind: string | null;
  subject_ref: string | null;
  item_count: number;
  top_salience: number;
  newest_at: string;
  items: Array<{ id: string; kind: string; content: string; salience: number; source: string; created_at: string }> | null;
}

export const getDeMemoryGrouped = async (deId: string, limit = 50): Promise<MemoryGroup[]> => {
  const { data, error } = await supabase.rpc('list_de_memory_grouped', { p_de_id: deId, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []) as MemoryGroup[];
};

/** A wrong memory keeps steering answers until somebody removes it. */
export const forgetMemory = async (memoryId: string): Promise<void> => {
  const { error } = await supabase.rpc('forget_de_memory', { p_memory_id: memoryId });
  if (error) throw new Error(friendlyWorkbenchError(error.message));
};

export const saveObjective = async (args: {
  deId: string; title: string; id?: string; description?: string;
  priority?: number; dueAt?: string | null; status?: string;
}): Promise<string> => {
  const { data, error } = await supabase.rpc('upsert_de_objective', {
    p_de_id: args.deId, p_title: args.title, p_id: args.id ?? null,
    p_description: args.description ?? null, p_priority: args.priority ?? 3,
    p_due_at: args.dueAt ?? null, p_status: args.status ?? null,
  });
  if (error) throw new Error(friendlyWorkbenchError(error.message));
  return data as string;
};

/** Answering "this situation isn't covered — here's what I propose". */
export const decideException = async (args: {
  exceptionId: string; decision: 'approved' | 'rejected'; outcome?: string; learned?: boolean;
}): Promise<void> => {
  const { error } = await supabase.rpc('decide_de_exception', {
    p_exception_id: args.exceptionId, p_decision: args.decision,
    p_outcome: args.outcome ?? null, p_learned: args.learned ?? false,
  });
  if (error) throw new Error(friendlyWorkbenchError(error.message));
};

function friendlyWorkbenchError(raw: string): string {
  if (raw.includes('insufficient_role')) return 'Only workspace owners and admins can change this.';
  if (raw.includes('already_decided')) return 'Somebody has already answered this one.';
  if (raw.includes('objective_not_found')) return 'That objective no longer exists — refresh and try again.';
  if (raw.includes('priority must be')) return 'Priority has to be between 1 and 5.';
  if (raw.includes('needs a title')) return 'Give the objective a title.';
  return raw;
}

// Whether the DE's passing certification still vouches for its CURRENT config.
// state: certified (fresh) | stale (config changed since last pass) | failed | uncertified.
// Wave-2 (truth audit 2026-07-22): the certification loop finally closes —
// run the tenant's golden exam WITH this employee answering; a passing suite
// writes role_certifications via certify_de_from_eval inside eval-run.
export const runCertificationEval = async (deId: string): Promise<{ status: string; certification: { status?: string; score_pct?: number } | null }> => {
  const { data, error } = await supabase.functions.invoke('eval-run', { body: { trigger: 'manual', de_id: deId } });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json() as { error?: string };
        throw new Error(parsed?.error === 'llm_not_configured'
          ? 'The workforce brain is offline — certification exams run the real answer pipeline and need the AI key.'
          : (parsed?.error ?? error.message));
      } catch (e) { if (e instanceof Error) throw e; }
    }
    throw new Error(error.message ?? String(error));
  }
  let res = data as { run_id: string; status: string; remaining?: number; certification?: { status?: string; score_pct?: number } | null };
  // Batched suites: keep re-invoking with run_id + de_id until finished.
  let guard = 0;
  while (res?.status === 'running' && (res.remaining ?? 0) > 0 && guard++ < 20) {
    const { data: next, error: nextErr } = await supabase.functions.invoke('eval-run', { body: { run_id: res.run_id, de_id: deId } });
    if (nextErr) throw new Error(nextErr.message ?? String(nextErr));
    res = next as typeof res;
  }
  return { status: res?.status ?? 'unknown', certification: res?.certification ?? null };
};

export const getDeCertStatus = async (deId: string): Promise<CertStatus | null> => {
  const { data, error } = await supabase.rpc('de_certification_status', { p_de_id: deId });
  if (error) throw error;
  return (data ?? null) as CertStatus | null;
};

export const getDeTraining = async (deId: string): Promise<TrainingRow[]> => {
  const { data, error } = await supabase.from('de_training_progress')
    .select('module_key, status, completed_at')
    .eq('de_id', deId).order('module_key', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrainingRow[];
};

// Compliance packs are tenant-scoped (not per-DE), but relevant on the DE
// workbench because attached packs enforce guardrails on every DE.
export const getTenantCompliancePacks = async (): Promise<CompliancePackRow[]> => {
  const { data, error } = await supabase.from('tenant_compliance_packs')
    .select('pack_key, attached_at, compliance_packs(name, domain)')
    .order('attached_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ pack_key: string; attached_at: string; compliance_packs?: { name?: string; domain?: string } | { name?: string; domain?: string }[] }>).map((r) => {
    const pack = Array.isArray(r.compliance_packs) ? r.compliance_packs[0] : r.compliance_packs;
    return { pack_key: r.pack_key, attached_at: r.attached_at, name: pack?.name, domain: pack?.domain };
  });
};
