// Tenant Management API Layer
import { supabase } from '../supabase';

export interface TenantDetails {
  tenant_id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  industry?: string;
  admin_name?: string;
  admin_email?: string;
  billing_email?: string;
  contact_name?: string;
  adoption_score: number;
  created_at: string;
  features: FeatureToggles;
  limits: UsageLimits;
  billing: BillingConfig;
  usage: UsageMetrics;
}

export interface FeatureToggles {
  sophie_config_enabled: boolean;
  amendment_journeys_enabled: boolean;
  metrics_tracking_enabled: boolean;
  reply_mode_enabled: boolean;
  hosted_chat_enabled: boolean;
  replay_testing: boolean;
  trust_adaptive: boolean;
  playbook_mining: boolean;
}

export interface UsageLimits {
  monthly_cost_limit?: number;
  soft_limit_alert_percent: number;
  hard_limit_behavior: 'alert' | 'soft_block' | 'hard_block';
  max_de_count?: number;
  max_monthly_responses?: number;
  max_monthly_amendments?: number;
}

export interface BillingConfig {
  sophie_config_cost: number;
  amendment_cost: number;
  metrics_cost: number;
  reply_mode_cost: number;
  hosted_chat_cost: number;
  cost_per_1k_responses: number;
  cost_per_amendment: number;
  cost_per_de: number;
}

export interface UsageMetrics {
  de_using_sophie_config: number;
  de_using_amendments: number;
  de_using_metrics: number;
  de_using_reply_mode: number;
  total_responses_this_month: number;
  total_amendments_created: number;
  total_amendments_adopted: number;
  avg_response_confidence: number;
  avg_escalation_rate: number;
  adoption_score: number;
}

export interface TenantSummary {
  tenant_id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  industry?: string;
  admin_email?: string;
  adoption_score: number;
  de_count: number;
  active_features: number;
  monthly_cost: number;
  cost_vs_budget?: number;
  created_at: string;
}

export interface MonthlyCostCalculation {
  tenant_id: string;
  month: string;
  features_cost: number;
  usage_cost: number;
  responses: number;
  amendments: number;
  de_count: number;
  total_cost: number;
}

// ════════════════════════════════════════════════════════════════
// Get Tenant Details
// ════════════════════════════════════════════════════════════════

export async function getTenantDetails(tenantId: string): Promise<TenantDetails | null> {
  const { data, error } = await supabase.rpc('get_tenant_details', {
    p_tenant_id: tenantId,
  });

  if (error) {
    console.error('Failed to get tenant details:', error);
    return null;
  }

  return data;
}

// ════════════════════════════════════════════════════════════════
// Update Tenant Features
// ════════════════════════════════════════════════════════════════

export async function updateTenantFeatures(
  tenantId: string,
  features: Partial<FeatureToggles>
): Promise<{ ok: boolean; updated_at: string } | null> {
  const { data, error } = await supabase.rpc('update_tenant_features', {
    p_tenant_id: tenantId,
    p_features: features,
  });

  if (error) {
    console.error('Failed to update tenant features:', error);
    return null;
  }

  return data;
}

// ════════════════════════════════════════════════════════════════
// Update Billing Config
// ════════════════════════════════════════════════════════════════

export async function updateTenantBilling(
  tenantId: string,
  billing: Partial<BillingConfig> & { billing_email?: string; payment_method?: string }
): Promise<{ ok: boolean; updated_at: string } | null> {
  const { data, error } = await supabase.rpc('update_tenant_billing', {
    p_tenant_id: tenantId,
    p_billing_config: billing,
  });

  if (error) {
    console.error('Failed to update tenant billing:', error);
    return null;
  }

  return data;
}

// ════════════════════════════════════════════════════════════════
// Calculate Monthly Cost
// ════════════════════════════════════════════════════════════════

export async function calculateMonthlyCost(tenantId: string): Promise<MonthlyCostCalculation | null> {
  const { data, error } = await supabase.rpc('calculate_tenant_monthly_cost', {
    p_tenant_id: tenantId,
  });

  if (error) {
    console.error('Failed to calculate monthly cost:', error);
    return null;
  }

  return data;
}

// ════════════════════════════════════════════════════════════════
// Get All Tenants Summary (for Platform Console)
// ════════════════════════════════════════════════════════════════

export async function getAllTenantsSummary(): Promise<TenantSummary[] | null> {
  const { data, error } = await supabase.rpc('get_all_tenants_with_summary');

  if (error) {
    console.error('Failed to get tenants summary:', error);
    return null;
  }

  return data || [];
}

// ════════════════════════════════════════════════════════════════
// Cost Calculator (Client-side)
// ════════════════════════════════════════════════════════════════

export function calculateEstimatedMonthlyCost(
  billing: BillingConfig,
  features: FeatureToggles,
  usage: {
    responses: number;
    amendments: number;
    deCount: number;
  }
): { base: number; usage: number; total: number } {
  // Base feature costs (if enabled)
  let baseFeatureCost = 0;
  if (features.sophie_config_enabled) baseFeatureCost += billing.sophie_config_cost;
  if (features.amendment_journeys_enabled) baseFeatureCost += billing.amendment_cost;
  if (features.metrics_tracking_enabled) baseFeatureCost += billing.metrics_cost;
  if (features.reply_mode_enabled) baseFeatureCost += billing.reply_mode_cost;
  if (features.hosted_chat_enabled) baseFeatureCost += billing.hosted_chat_cost;

  // Usage-based costs
  const usageCost =
    (usage.responses / 1000) * billing.cost_per_1k_responses +
    usage.amendments * billing.cost_per_amendment +
    usage.deCount * billing.cost_per_de;

  return {
    base: Math.round(baseFeatureCost * 100) / 100,
    usage: Math.round(usageCost * 100) / 100,
    total: Math.round((baseFeatureCost + usageCost) * 100) / 100,
  };
}

// ════════════════════════════════════════════════════════════════
// Budget Alert Helper
// ════════════════════════════════════════════════════════════════

export function checkBudgetStatus(
  currentCost: number,
  monthlyBudget: number | null,
  softLimitPercent: number = 80
): {
  isWithinBudget: boolean;
  percentOfBudget: number | null;
  alertLevel: 'ok' | 'warning' | 'critical';
} {
  if (!monthlyBudget) {
    return { isWithinBudget: true, percentOfBudget: null, alertLevel: 'ok' };
  }

  const percentOfBudget = (currentCost / monthlyBudget) * 100;
  const isWithinBudget = percentOfBudget <= 100;

  let alertLevel: 'ok' | 'warning' | 'critical' = 'ok';
  if (percentOfBudget >= 100) {
    alertLevel = 'critical';
  } else if (percentOfBudget >= softLimitPercent) {
    alertLevel = 'warning';
  }

  return {
    isWithinBudget,
    percentOfBudget: Math.round(percentOfBudget * 10) / 10,
    alertLevel,
  };
}
