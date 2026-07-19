/**
 * Support Agent Metrics API
 *
 * Provides typed queries for Support Agent performance metrics:
 * - FCR (First Contact Resolution)
 * - CSAT (Customer Satisfaction)
 * - TTR (Time to Resolution)
 * - Escalation Rate
 * - Quality Score
 * - Policy Compliance
 */

import { supabase } from '../supabase';

export interface SupportMetrics {
  fcr: number; // % of tickets resolved without escalation
  csat: number; // 0-5 scale, average
  ttr_median: string; // ISO interval (e.g., "02:30:00")
  ttr_p95: string; // 95th percentile
  escalation_rate: number; // % of tickets escalated
  quality_score: number; // % of responses rated accurate
  policy_compliance: number; // % without violations
  volume: number; // total tickets in period
  period: {
    from: string; // ISO date
    to: string; // ISO date
  };
}

export interface MetricsTrend {
  timestamp: string;
  metric: string;
  value: number;
  trend?: 'up' | 'down' | 'stable';
}

export interface DeMetricsDetail {
  de_id: string;
  de_name: string;
  metrics: SupportMetrics;
  trend_7d?: MetricsTrend[];
  alerts?: Array<{
    type: 'warning' | 'critical';
    metric: string;
    current: number;
    threshold: number;
  }>;
}

/**
 * Get aggregated support metrics for a DE or tenant
 */
export async function getSupportMetrics(
  tenant_id: string,
  de_id?: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<SupportMetrics | null> {
  try {
    const { data, error } = await supabase.rpc('get_support_agent_metrics', {
      p_tenant_id: tenant_id,
      p_de_id: de_id || null,
      p_date_from: dateFrom?.toISOString() || null,
      p_date_to: dateTo?.toISOString() || null,
    });

    if (error) throw error;
    return data as SupportMetrics;
  } catch (e) {
    console.error('Failed to fetch support metrics:', e);
    return null;
  }
}

/**
 * Get per-DE metrics details with trends and alerts
 */
export async function getDeMetricsDetail(
  de_id: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<DeMetricsDetail | null> {
  try {
    const { data, error } = await supabase.rpc('get_de_metrics_detail', {
      p_de_id: de_id,
      p_date_from: dateFrom?.toISOString() || null,
      p_date_to: dateTo?.toISOString() || null,
    });

    if (error) throw error;
    return data as DeMetricsDetail;
  } catch (e) {
    console.error('Failed to fetch DE metrics detail:', e);
    return null;
  }
}

/**
 * Get metrics trend over time (daily or hourly)
 */
export async function getMetricsTrend(
  de_id: string,
  metric: 'fcr' | 'csat' | 'ttr' | 'escalation_rate' | 'quality_score',
  dateFrom: Date,
  dateTo: Date,
  interval: 'hourly' | 'daily' | 'weekly' = 'daily'
): Promise<MetricsTrend[]> {
  try {
    const { data, error } = await supabase.rpc('get_metrics_trend', {
      p_de_id: de_id,
      p_metric: metric,
      p_date_from: dateFrom.toISOString(),
      p_date_to: dateTo.toISOString(),
      p_interval: interval,
    });

    if (error) throw error;
    return data as MetricsTrend[];
  } catch (e) {
    console.error('Failed to fetch metrics trend:', e);
    return [];
  }
}

/**
 * Get metric comparison vs baseline/previous period
 */
export async function getMetricsComparison(
  de_id: string,
  currentStart: Date,
  currentEnd: Date,
  previousStart: Date,
  previousEnd: Date
): Promise<Record<string, { current: number; previous: number; change: number; changePercent: number }>> {
  try {
    const [current, previous] = await Promise.all([
      getSupportMetrics(de_id, de_id, currentStart, currentEnd),
      getSupportMetrics(de_id, de_id, previousStart, previousEnd),
    ]);

    if (!current || !previous) return {};

    const metrics = ['fcr', 'csat', 'ttr_median', 'escalation_rate', 'quality_score', 'policy_compliance'] as const;
    const result: Record<string, any> = {};

    for (const metric of metrics) {
      const curr = Number((current as any)[metric]) || 0;
      const prev = Number((previous as any)[metric]) || 0;
      const change = curr - prev;
      const changePercent = prev ? (change / prev) * 100 : 0;

      result[metric] = {
        current: curr,
        previous: prev,
        change,
        changePercent,
      };
    }

    return result;
  } catch (e) {
    console.error('Failed to fetch metrics comparison:', e);
    return {};
  }
}

/**
 * Get anomalies detected in metrics
 */
export interface MetricAnomaly {
  de_id: string;
  metric: string;
  timestamp: string;
  value: number;
  expected_range: [number, number];
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export async function getMetricsAnomalies(
  de_id: string,
  lookbackDays: number = 7
): Promise<MetricAnomaly[]> {
  try {
    const { data, error } = await supabase.rpc('get_metrics_anomalies', {
      p_de_id: de_id,
      p_lookback_days: lookbackDays,
    });

    if (error) throw error;
    return data as MetricAnomaly[];
  } catch (e) {
    console.error('Failed to fetch metrics anomalies:', e);
    return [];
  }
}

/**
 * Get metrics for all DEs in a tenant (for comparison)
 */
export async function getTenantMetricsComparison(
  tenant_id: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<Array<{
  de_id: string;
  de_name: string;
  metrics: SupportMetrics;
  rank: number;
}>> {
  try {
    const { data, error } = await supabase.rpc('get_tenant_metrics_comparison', {
      p_tenant_id: tenant_id,
      p_date_from: dateFrom?.toISOString() || null,
      p_date_to: dateTo?.toISOString() || null,
    });

    if (error) throw error;
    return data;
  } catch (e) {
    console.error('Failed to fetch tenant metrics comparison:', e);
    return [];
  }
}

/**
 * Compute SLA achievement
 */
export async function getSLAAchievement(
  de_id: string,
  dateFrom: Date,
  dateTo: Date
): Promise<{
  total_escalations: number;
  within_sla: number;
  achievement_percent: number;
  missed_by_hours: Array<{ escalation_id: string; hours_missed: number }>;
}> {
  try {
    const { data, error } = await supabase.rpc('get_sla_achievement', {
      p_de_id: de_id,
      p_date_from: dateFrom.toISOString(),
      p_date_to: dateTo.toISOString(),
    });

    if (error) throw error;
    return data;
  } catch (e) {
    console.error('Failed to fetch SLA achievement:', e);
    return {
      total_escalations: 0,
      within_sla: 0,
      achievement_percent: 0,
      missed_by_hours: [],
    };
  }
}

/**
 * Get quality score breakdown by category
 */
export async function getQualityScoreBreakdown(
  de_id: string,
  dateFrom: Date,
  dateTo: Date
): Promise<{
  overall: number;
  by_category: Record<string, { accurate: number; total: number; percent: number }>;
  by_response_type: Record<string, { accurate: number; total: number; percent: number }>;
}> {
  try {
    const { data, error } = await supabase.rpc('get_quality_score_breakdown', {
      p_de_id: de_id,
      p_date_from: dateFrom.toISOString(),
      p_date_to: dateTo.toISOString(),
    });

    if (error) throw error;
    return data;
  } catch (e) {
    console.error('Failed to fetch quality score breakdown:', e);
    return {
      overall: 0,
      by_category: {},
      by_response_type: {},
    };
  }
}
