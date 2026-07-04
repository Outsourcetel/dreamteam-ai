// ============================================================
// Customer Success — computed health API (migration 021).
// Health is COMPUTED from real signals (tickets, invoices, activity),
// with a transparent per-component breakdown stored on the account row
// and tenant-configurable weights/thresholds in health_score_config.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import type { SupportTicket, RenewalInvoice, ActivityEvent } from './customerApi';
import type { PlaybookTriggerFire } from './playbookBuilderApi';

// ── Types ─────────────────────────────────────────────────────────

export interface HealthWeights {
  open_tickets: number;
  escalations: number;
  overdue_invoices: number;
  activity_recency: number;
}

export interface HealthThresholds {
  at_risk_below: number;
  healthy_above: number;
}

export const DEFAULT_WEIGHTS: HealthWeights = {
  open_tickets: 25, escalations: 25, overdue_invoices: 30, activity_recency: 20,
};
export const DEFAULT_THRESHOLDS: HealthThresholds = { at_risk_below: 50, healthy_above: 75 };

export interface HealthConfig {
  tenant_id: string;
  weights: HealthWeights;
  thresholds: HealthThresholds;
  last_computed_at: string | null;
  updated_at: string;
}

export interface HealthComponent { count?: number; days_since?: number | null; penalty: number; weight: number }
export interface HealthComponents {
  score: number;
  computed_at: string;
  open_tickets: HealthComponent;
  escalations: HealthComponent;
  overdue_invoices: HealthComponent;
  activity_recency: HealthComponent;
}

export interface RecomputeResult { computed: number; status_flips?: number; skipped: boolean; last_computed_at?: string }

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

// ── Config ────────────────────────────────────────────────────────

export async function getHealthConfig(): Promise<HealthConfig | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('health_score_config').select('*').eq('tenant_id', tid).maybeSingle();
  if (error) raise('getHealthConfig', error);
  return (data as HealthConfig | null) ?? null;
}

export async function saveHealthConfig(weights: HealthWeights, thresholds: HealthThresholds): Promise<void> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('health_score_config')
    .upsert({ tenant_id: tid, weights, thresholds, updated_by: user?.id ?? null }, { onConflict: 'tenant_id' });
  if (error) raise('saveHealthConfig', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Health scoring config updated — weights tickets ${weights.open_tickets} / escalations ${weights.escalations} / overdue ${weights.overdue_invoices} / activity ${weights.activity_recency}; at-risk < ${thresholds.at_risk_below}, healthy > ${thresholds.healthy_above}`,
    detail: { kind: 'health_config', weights: { ...weights }, thresholds: { ...thresholds } },
  });
}

// ── Recompute ─────────────────────────────────────────────────────

/** force=true → "Recompute now"; force=false → opportunistic page-load
 *  recompute (server no-ops if the last compute was under an hour ago). */
export async function recomputeHealth(force: boolean): Promise<RecomputeResult> {
  const { data, error } = await supabase.rpc('compute_tenant_health', { p_force: force });
  if (error) raise('recomputeHealth', error);
  return data as RecomputeResult;
}

// ── Account signal detail (drawer) ────────────────────────────────

export interface AccountSignals {
  openTickets: SupportTicket[];
  overdueInvoices: RenewalInvoice[];
  recentActivity: ActivityEvent[];
  atRiskFires: PlaybookTriggerFire[];
}

export async function getAccountSignals(accountId: string): Promise<AccountSignals> {
  const tid = await requireTenantId();
  const today = new Date().toISOString().slice(0, 10);
  const [tickets, invoices, activity, fires] = await Promise.all([
    supabase.from('support_tickets').select('*').eq('tenant_id', tid).eq('account_id', accountId)
      .in('status', ['open', 'pending', 'escalated']).order('created_at', { ascending: false }).limit(20),
    supabase.from('renewal_invoices').select('*').eq('tenant_id', tid).eq('account_id', accountId)
      .eq('status', 'sent').lt('due_date', today).order('due_date', { ascending: true }).limit(10),
    supabase.from('activity_events').select('*').eq('tenant_id', tid).eq('account_id', accountId)
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('playbook_trigger_fires').select('*').eq('tenant_id', tid).eq('target_account_id', accountId)
      .eq('source', 'event').order('fired_at', { ascending: false }).limit(10),
  ]);
  if (tickets.error) raise('getAccountSignals.tickets', tickets.error);
  if (invoices.error) raise('getAccountSignals.invoices', invoices.error);
  if (activity.error) raise('getAccountSignals.activity', activity.error);
  if (fires.error) raise('getAccountSignals.fires', fires.error);
  return {
    openTickets: (tickets.data ?? []) as SupportTicket[],
    overdueInvoices: (invoices.data ?? []) as RenewalInvoice[],
    recentActivity: (activity.data ?? []) as ActivityEvent[],
    atRiskFires: (fires.data ?? []) as PlaybookTriggerFire[],
  };
}

// ── Breakdown rendering helper ───────────────────────────────────

export function describeComponents(c: HealthComponents | null | undefined): string {
  if (!c) return 'Not computed yet';
  const parts: string[] = [];
  if (c.open_tickets?.penalty) parts.push(`Tickets −${c.open_tickets.penalty}`);
  if (c.escalations?.penalty) parts.push(`Escalations −${c.escalations.penalty}`);
  if (c.overdue_invoices?.penalty) parts.push(`Overdue invoice −${c.overdue_invoices.penalty}`);
  if (c.activity_recency?.penalty) parts.push(`Activity −${c.activity_recency.penalty}`);
  return parts.length ? parts.join(' · ') : 'No penalties — all signals healthy';
}
