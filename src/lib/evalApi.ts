// ============================================================
// Proving Ground v1 (R3) — LIVE data layer.
// golden_qa CRUD, eval_runs history, the eval-run edge function
// trigger, and getEvalGate() (latest finished run — drives the
// knowledge-publish soft gate in LiveKnowledgeLibrary).
// Mirrors the tenant/error patterns in customerApi.ts.
// ============================================================
import { supabase } from '../supabase';
import { CustomerApiError, isMissingTableError, getSessionTenantId } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type GoldenCategory = 'knowledge' | 'procedure' | 'guardrail' | 'escalation' | 'calibration';

export interface GoldenQA {
  id: string;
  tenant_id: string;
  question: string;
  expected_fragments: string[];
  min_confidence: number;
  category: GoldenCategory;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type EvalTrigger = 'manual' | 'knowledge_publish' | 'scheduled';
export type EvalStatus = 'running' | 'passed' | 'failed' | 'blocked_llm';

export interface EvalQuestionResult {
  qa_id: string;
  question: string;
  answer?: string;
  confidence?: number;
  passed: boolean;
  reason: string;
}

export interface EvalRun {
  id: string;
  tenant_id: string;
  trigger: EvalTrigger;
  status: EvalStatus;
  total: number;
  passed: number;
  failed: number;
  results: EvalQuestionResult[];
  started_at: string;
  finished_at: string | null;
}

export interface EvalGate {
  run_id: string;
  status: EvalStatus;
  total: number;
  passed: number;
  failed: number;
  finished_at: string;
}

import { raise, requireTenantId } from './liveShared';


// ── golden_qa CRUD ────────────────────────────────────────────────

export async function listGoldenQA(): Promise<GoldenQA[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('golden_qa')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) raise('listGoldenQA', error);
  return (data ?? []) as GoldenQA[];
}

export async function createGoldenQA(
  q: { question: string; expected_fragments: string[]; min_confidence?: number; category?: GoldenCategory; active?: boolean }
): Promise<GoldenQA> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('golden_qa')
    .insert({ ...q, tenant_id: tid })
    .select()
    .single();
  if (error) raise('createGoldenQA', error);
  return data as GoldenQA;
}

export async function updateGoldenQA(
  id: string,
  updates: Partial<Pick<GoldenQA, 'question' | 'expected_fragments' | 'min_confidence' | 'category' | 'active'>>
): Promise<GoldenQA> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('golden_qa')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('updateGoldenQA', error);
  return data as GoldenQA;
}

export async function deleteGoldenQA(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('golden_qa')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tid);
  if (error) raise('deleteGoldenQA', error);
}

// ── Starter suite (honest v1: templates from knowledge doc titles) ──

const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'how', 'what', 'why', 'guide', 'policy', 'faq', 'docs', 'notes', 'v1', 'v2',
]);

/** A significant word from a doc title to use as the expected fragment. */
export function significantTitleWord(title: string): string {
  const words = (title || '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TITLE_STOPWORDS.has(w.toLowerCase()));
  // Longest word is usually the most distinctive.
  words.sort((a, b) => b.length - a.length);
  return words[0] ?? title.trim().split(/\s+/)[0] ?? '';
}

/** Generate up to 5 starter questions from knowledge doc titles.
 *  Honest v1: client-side templates, fully editable by the tenant. */
export async function generateStarterSuite(docTitles: string[]): Promise<GoldenQA[]> {
  const created: GoldenQA[] = [];
  for (const title of docTitles.slice(0, 5)) {
    const frag = significantTitleWord(title);
    if (!frag) continue;
    created.push(await createGoldenQA({
      question: `What does ${title} cover?`,
      expected_fragments: [frag],
      min_confidence: 60,
      category: 'knowledge',
    }));
  }
  return created;
}

// ── eval_runs ─────────────────────────────────────────────────────

export async function listEvalRuns(limit = 25): Promise<EvalRun[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('eval_runs')
    .select('*')
    .eq('tenant_id', tid)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) raise('listEvalRuns', error);
  return (data ?? []) as EvalRun[];
}

export async function getEvalRun(id: string): Promise<EvalRun | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('eval_runs')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tid)
    .maybeSingle();
  if (error) raise('getEvalRun', error);
  return (data as EvalRun) ?? null;
}

// ── Gate ──────────────────────────────────────────────────────────

/** Latest FINISHED eval run for the tenant, or null when none exist
 *  (or the tables aren't provisioned — the gate fails OPEN by design;
 *  server-side hard gating is the hardening step). */
export async function getEvalGate(): Promise<EvalGate | null> {
  try {
    const tid = await getSessionTenantId();
    if (!tid) return null;
    const { data, error } = await supabase
      .from('eval_gate')
      .select('run_id, status, total, passed, failed, finished_at')
      .eq('tenant_id', tid)
      .maybeSingle();
    if (error) {
      console.error('getEvalGate:', error.message);
      return null;
    }
    return (data as EvalGate) ?? null;
  } catch (err) {
    console.error('getEvalGate:', err);
    return null;
  }
}

/** Audit a tenant's decision to publish knowledge despite a failing gate. */
export async function auditEvalGateOverride(gate: EvalGate, docTitle: string): Promise<void> {
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Eval gate OVERRIDDEN — published knowledge "${docTitle}" while the last eval run was failing (${gate.passed}/${gate.total})`,
    detail: { kind: 'eval_gate_override', run_id: gate.run_id, passed: gate.passed, total: gate.total, doc_title: docTitle },
  });
}

// ── eval-run edge function ────────────────────────────────────────

export class EvalRunError extends Error {
  code: 'no_questions' | 'network' | 'server';
  constructor(code: EvalRunError['code'], message: string) {
    super(message);
    this.name = 'EvalRunError';
    this.code = code;
  }
}

/** Start an eval run. Resolves when the run has FINISHED (the edge
 *  function runs the suite synchronously); the UI live-polls the run
 *  row in parallel for progressive results. */
export async function startEvalRun(trigger: EvalTrigger = 'manual'): Promise<{ run_id: string; status: EvalStatus }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new EvalRunError('server', 'Not signed in.');

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/eval-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ trigger }),
    });
  } catch (err) {
    throw new EvalRunError('network', String(err));
  }
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (data.error === 'no_active_questions') {
    throw new EvalRunError('no_questions', 'No active golden questions — add some first.');
  }
  if (!res.ok || data.error) {
    throw new EvalRunError('server', String(data.error ?? `HTTP ${res.status}`));
  }
  return { run_id: String(data.run_id), status: data.status as EvalStatus };
}
