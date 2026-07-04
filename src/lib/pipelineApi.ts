// ============================================================
// BD + Sales pipeline — LIVE data layer (migration 023).
//
// SoR DOCTRINE: the CRM (Salesforce/HubSpot) is the system of record
// for pipeline. This is a WORKING CACHE / action workspace — `source`
// + `external_ref` carry the origin like support_tickets; native mode
// bootstraps tenants without a CRM; the CRM connector is the sync
// upgrade (connector_objects already supports 'opportunity').
//
// THE LIFECYCLE SPINE: BD → Sales → won (close_opportunity_won) →
// customer account exists → onboarding project starts (022) → success
// monitors health (021) → renewal plays run (020). Winning a deal is
// the moment a prospect becomes a customer.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError, parseMoneyToCents } from './customerApi';
import type { ImportResult, ImportRowError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type OppStage = 'prospect' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';

export const OPEN_STAGES: OppStage[] = ['prospect', 'qualified', 'proposal', 'negotiation'];
export const BD_STAGES: OppStage[] = ['prospect'];
export const SALES_STAGES: OppStage[] = ['qualified', 'proposal', 'negotiation'];
export const ALL_STAGES: OppStage[] = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

export const STAGE_LABELS: Record<OppStage, string> = {
  prospect: 'Prospect', qualified: 'Qualified', proposal: 'Proposal',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};

export interface StageHistoryEntry { stage: OppStage; at: string; by: string }

export interface Opportunity {
  id: string;
  tenant_id: string;
  account_id: string | null;
  name: string;
  company_name: string;
  stage: OppStage;
  amount_cents: number | null;
  close_date: string | null;
  owner: string;
  source: string;            // 'native' | 'import' | future CRM providers
  external_ref: string | null;
  stage_history: StageHistoryEntry[];
  lost_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineSummaryRow {
  tenant_id: string;
  stage: OppStage;
  opp_count: number;
  amount_cents: number;
  win_rate_90d: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────

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

// ── CRUD ──────────────────────────────────────────────────────────

export async function listOpportunities(): Promise<Opportunity[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('opportunities').select('*').eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listOpportunities', error);
  return (data ?? []) as Opportunity[];
}

export async function createOpportunity(o: {
  name: string; company_name?: string; stage?: 'prospect' | 'qualified';
  amount_cents?: number | null; close_date?: string | null; owner?: string;
}): Promise<Opportunity> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('opportunities')
    .insert({ tenant_id: tid, source: 'native', ...o })
    .select().single();
  if (error) raise('createOpportunity', error);
  notify();
  return data as Opportunity;
}

export async function updateOpportunity(
  id: string,
  updates: Partial<Pick<Opportunity, 'name' | 'company_name' | 'amount_cents' | 'close_date' | 'owner'>>,
): Promise<Opportunity> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('opportunities').update(updates).eq('id', id).eq('tenant_id', tid)
    .select().single();
  if (error) raise('updateOpportunity', error);
  return data as Opportunity;
}

/**
 * Guarded stage move for OPEN stages only (prospect ↔ qualified ↔
 * proposal ↔ negotiation). Won/lost are server-enforced to go through
 * the close RPCs below — the DB trigger rejects direct writes.
 */
export async function moveStage(id: string, stage: Exclude<OppStage, 'won' | 'lost'>): Promise<Opportunity> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('opportunities').update({ stage }).eq('id', id).eq('tenant_id', tid)
    .select().single();
  if (error) raise('moveStage', error);
  notify();
  return data as Opportunity;
}

// ── Close flows (the lifecycle handoff) ───────────────────────────

export interface CloseWonResult { account_id: string; project_id: string | null; onboarding_error?: string }

/**
 * Won → lifecycle handoff: closes the opportunity, creates the
 * customer account (or links an existing one), and optionally starts
 * the onboarding project (022 machinery). This is where a prospect
 * becomes a customer and the Customer Lifecycle loop closes.
 */
export async function closeWon(opts: {
  opportunityId: string;
  linkAccountId?: string | null;
  createOnboarding?: boolean;
  templateVersionId?: string | null;
}): Promise<CloseWonResult> {
  const { data, error } = await supabase.rpc('close_opportunity_won', {
    p_opp: opts.opportunityId,
    p_account_id: opts.linkAccountId ?? null,
    p_create_onboarding: opts.createOnboarding ?? false,
    p_template_version: opts.templateVersionId ?? null,
  });
  if (error) raise('closeWon', error);
  const res = data as { account_id?: string; project_id?: string | null; error?: string; onboarding_error?: string };
  if (res?.error) raise('closeWon', { message: res.error.replace(/_/g, ' ') });
  notify();
  return { account_id: res.account_id!, project_id: res.project_id ?? null, onboarding_error: res.onboarding_error };
}

/** Lost requires a reason — enforced server-side too. */
export async function closeLost(opportunityId: string, reason: string): Promise<void> {
  const { data, error } = await supabase.rpc('close_opportunity_lost', {
    p_opp: opportunityId,
    p_reason: reason,
  });
  if (error) raise('closeLost', error);
  const res = data as { error?: string } | null;
  if (res?.error) raise('closeLost', { message: res.error.replace(/_/g, ' ') });
  notify();
}

/** Won opportunities linked to an account — shown on the Success drawer
 *  (the account's origin story: which deal created it). */
export async function listWonOpportunitiesForAccount(accountId: string): Promise<Opportunity[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('opportunities').select('*')
    .eq('tenant_id', tid).eq('account_id', accountId).eq('stage', 'won')
    .order('closed_at', { ascending: false }).limit(5);
  if (error) raise('listWonOpportunitiesForAccount', error);
  return (data ?? []) as Opportunity[];
}

// ── Summary ───────────────────────────────────────────────────────

export async function getPipelineSummary(): Promise<PipelineSummaryRow[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('pipeline_summary').select('*').eq('tenant_id', tid);
  if (error) raise('getPipelineSummary', error);
  return (data ?? []) as PipelineSummaryRow[];
}

// ── CSV import (bootstrap — labeled as such in the UI) ────────────

export interface OpportunityImportRow {
  company?: string;
  name?: string;
  stage?: string;
  amount?: string;
  close_date?: string;
  owner?: string;
}

export async function importOpportunitiesCsv(rows: OpportunityImportRow[]): Promise<ImportResult> {
  const tid = await requireTenantId();
  const errors: ImportRowError[] = [];
  const inserts: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const company = (r.company || '').trim();
    const name = (r.name || '').trim() || (company ? `${company} — opportunity` : '');
    if (!name) { errors.push({ row: i + 1, message: 'Missing company/opportunity name' }); return; }
    const stageRaw = (r.stage || '').trim().toLowerCase();
    // won/lost can't be imported (guarded transitions) — clamp to open stages.
    const stage = (['prospect', 'qualified', 'proposal', 'negotiation'] as string[]).includes(stageRaw)
      ? stageRaw : 'prospect';
    const closeDate = (r.close_date || '').trim();
    inserts.push({
      tenant_id: tid,
      name,
      company_name: company,
      stage,
      amount_cents: r.amount && r.amount.trim() !== '' ? parseMoneyToCents(r.amount) : null,
      close_date: /^\d{4}-\d{2}-\d{2}$/.test(closeDate) ? closeDate : null,
      owner: (r.owner || '').trim(),
      source: 'import',
    });
  });
  let imported = 0;
  if (inserts.length > 0) {
    const { error, data } = await supabase.from('opportunities').insert(inserts).select('id');
    if (error) raise('importOpportunitiesCsv', error);
    imported = data?.length ?? inserts.length;
  }
  if (imported > 0) notify();
  return { imported, errors };
}
