// ============================================================
// Commercial Continuity — LIVE data layer (production track EXEC-2c).
// Typed reads over supabase/migrations/225_commercial_continuity_domain.sql
// + 226_continuity_engine_and_kit.sql.
//
// Reuses customerApi's tenant resolution (incl. the Remote Access god-mode
// override) and CustomerApiError so behaviour is identical across libs — no
// second tenant-resolution path. Money is stored in cents. Read-only for now;
// gated write-backs arrive with the continuity write-back registry (mig 227).
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, fmtMoneyK } from './customerApi';
import { motionLabel, daysUntil } from './continuityFormat';
import type { ContinuityMotion } from './continuityFormat';

export { fmtMoneyK, CustomerApiError, motionLabel, daysUntil };
export type { ContinuityMotion };

// ── Vocabulary (kept in sync with the DB CHECK constraints) ──────────
export type PartySide = 'sell' | 'buy';

export type AgreementType =
  | 'subscription' | 'maintenance' | 'managed_service' | 'retainer' | 'staff_aug'
  | 'sow' | 'purchase' | 'lease' | 'rental' | 'license' | 'warranty'
  | 'supplier_contract' | 'other';

export type AgreementStatus = 'draft' | 'active' | 'pending' | 'expired' | 'terminated' | 'superseded';
export type BillingInterval = 'one_time' | 'monthly' | 'quarterly' | 'annual' | 'usage' | 'custom';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ForecastCategory = 'pipeline' | 'best_case' | 'commit' | 'closed' | 'at_risk' | 'excluded';
export type StageCategory = 'open' | 'won' | 'lost' | 'terminated' | 'expired';

// ── Types ────────────────────────────────────────────────────────────
export interface CommercialAgreement {
  id: string;
  tenant_id: string;
  account_id: string | null;
  party_side: PartySide;
  counterparty_name: string;
  agreement_type: AgreementType;
  title: string;
  status: AgreementStatus;
  currency: string;
  auto_renew: boolean;
  notice_period_days: number | null;
  baseline_value_cents: number | null;
  // independent dates (any may be null)
  start_date: string | null;
  end_date: string | null;
  renewal_date: string | null;
  notice_deadline: string | null;
  cancellation_deadline: string | null;
  pricing_notice_deadline: string | null;
  warranty_expiry: string | null;
  next_reorder_date: string | null;
  replacement_date: string | null;
  expected_decision_date: string | null;
  expected_signature_date: string | null;
  service_activation_date: string | null;
  billing_start_date: string | null;
  source_document: Record<string, unknown>;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AgreementLine {
  id: string;
  tenant_id: string;
  agreement_id: string;
  catalog_item_id: string | null;
  description: string;
  quantity: number;
  unit_price_cents: number | null;
  billing_interval: BillingInterval;
  line_start_date: string | null;
  line_end_date: string | null;
  renewal_eligible: boolean;
  motion_hint: string | null;
  attributes: Record<string, unknown>;
}

export interface ContinuityStage {
  stage_key: string;
  label: string;
  sort_order: number;
  category: StageCategory;
  is_terminal: boolean;
  active: boolean;
}

/** The typed facet joined to its de_objectives case + agreement, shaped for the UI. */
export interface ContinuityCase {
  objective_id: string;
  tenant_id: string;
  de_id: string | null;
  agreement_id: string | null;
  account_id: string | null;
  motion: ContinuityMotion;
  stage_key: string | null;
  party_side: PartySide;
  baseline_cents: number | null;
  forecast_cents: number | null;
  probability_pct: number | null;
  expected_uplift_cents: number | null;
  expected_contraction_cents: number | null;
  forecast_category: ForecastCategory | null;
  risk_level: RiskLevel | null;
  readiness_score: number | null;
  outcome: string | null;
  loss_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // joined from de_objectives (the case spine)
  title: string | null;
  case_status: string | null;
  due_at: string | null;
  // joined from commercial_agreements
  counterparty_name: string | null;
  agreement_title: string | null;
  agreement_type: AgreementType | null;
}

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  // customerApi's isMissingTableError is private; re-derive the same signal here.
  const msg = (error.message || '').toLowerCase();
  const missing = msg.includes('does not exist') || msg.includes('could not find the table') || msg.includes('schema cache');
  throw new CustomerApiError(error.message, missing);
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

// ── Agreements ───────────────────────────────────────────────────────
export async function listAgreements(): Promise<CommercialAgreement[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('commercial_agreements')
    .select('*')
    .eq('tenant_id', tid)
    .order('renewal_date', { ascending: true, nullsFirst: false });
  if (error) raise('listAgreements', error);
  return (data ?? []) as CommercialAgreement[];
}

export async function getAgreement(id: string): Promise<{ agreement: CommercialAgreement; lines: AgreementLine[] }> {
  const tid = await requireTenantId();
  const [{ data: agr, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
    supabase.from('commercial_agreements').select('*').eq('tenant_id', tid).eq('id', id).single(),
    supabase.from('agreement_lines').select('*').eq('tenant_id', tid).eq('agreement_id', id).order('created_at', { ascending: true }),
  ]);
  if (e1) raise('getAgreement', e1);
  if (e2) raise('getAgreement.lines', e2);
  return { agreement: agr as CommercialAgreement, lines: (lines ?? []) as AgreementLine[] };
}

// ── Configurable stages ──────────────────────────────────────────────
export async function listStages(): Promise<ContinuityStage[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('continuity_stage_config')
    .select('stage_key,label,sort_order,category,is_terminal,active')
    .eq('tenant_id', tid)
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) raise('listStages', error);
  return (data ?? []) as ContinuityStage[];
}

// ── Continuity cases (the facet joined to its case + agreement) ──────
export async function listContinuityCases(): Promise<ContinuityCase[]> {
  const tid = await requireTenantId();
  // PostgREST embedding via the FKs declared in mig 225 (objective_id →
  // de_objectives, agreement_id → commercial_agreements).
  const { data, error } = await supabase
    .from('continuity_cases')
    .select('*, de_objectives(title,status,due_at), commercial_agreements(counterparty_name,title,agreement_type)')
    .eq('tenant_id', tid)
    .order('updated_at', { ascending: false });
  if (error) raise('listContinuityCases', error);
  type Row = Record<string, unknown> & {
    de_objectives?: { title?: string; status?: string; due_at?: string } | null;
    commercial_agreements?: { counterparty_name?: string; title?: string; agreement_type?: AgreementType } | null;
  };
  return ((data ?? []) as Row[]).map((r): ContinuityCase => ({
    ...(r as unknown as ContinuityCase),
    title: r.de_objectives?.title ?? null,
    case_status: r.de_objectives?.status ?? null,
    due_at: r.de_objectives?.due_at ?? null,
    counterparty_name: r.commercial_agreements?.counterparty_name ?? null,
    agreement_title: r.commercial_agreements?.title ?? null,
    agreement_type: r.commercial_agreements?.agreement_type ?? null,
  }));
}

// ── Case timeline (stage history + activities) ───────────────────────
export interface ContinuityCaseEvent {
  id: string;
  objective_id: string;
  from_stage: string | null;
  to_stage: string | null;
  motion: string | null;
  actor_kind: 'de' | 'human' | 'system';
  summary: string;
  created_at: string;
}

export async function listCaseEvents(objectiveId: string, limit = 100): Promise<ContinuityCaseEvent[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('continuity_case_events')
    .select('id,objective_id,from_stage,to_stage,motion,actor_kind,summary,created_at')
    .eq('tenant_id', tid)
    .eq('objective_id', objectiveId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) raise('listCaseEvents', error);
  return (data ?? []) as ContinuityCaseEvent[];
}

// ── Gated write-back (propose → gate → auto-apply or human approval) ──
export type ContinuityWritebackOp = 'log_activity' | 'set_next_step' | 'advance_stage';
export interface ContinuityWritebackResult {
  ok: boolean;
  gated?: boolean;
  applied?: boolean;
  task_id?: string;
  request_id?: string;
  reasoning?: string;
  error?: string;
}

/**
 * Propose a case write-back. Non-destructive ops (log_activity, set_next_step)
 * may auto-apply per the gate; advance_stage is destructive and routes to a
 * human approval task unless trust/guardrails allow it. Never writes directly.
 */
export async function proposeContinuityWriteback(
  deId: string,
  objectiveId: string,
  op: ContinuityWritebackOp,
  params: Record<string, string> = {},
): Promise<ContinuityWritebackResult> {
  const { data, error } = await supabase.rpc('propose_continuity_writeback', {
    p_de_id: deId, p_objective_id: objectiveId, p_op: op, p_params: params,
  });
  if (error) raise('proposeContinuityWriteback', error);
  const res = (data ?? {}) as ContinuityWritebackResult;
  if (res.ok === false) throw new CustomerApiError(res.error || 'Could not propose the write-back.', false);
  return res;
}

// Presentation helpers (motionLabel, daysUntil) live in ./continuityFormat and
// are re-exported at the top of this module.
