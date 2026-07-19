/**
 * Extensible Metrics Framework
 *
 * Customers define metrics per tenant. Each metric has:
 * - name: human-readable identifier
 * - key: identifier for queries
 * - type: percentage | count | duration | score
 * - description: what it measures
 * - calculation: SQL template or rule
 * - tags: domain tags (support, billing, hr, operations)
 * - query_template: parameterized query
 */

import { supabase } from '../supabase'

export type MetricType = 'percentage' | 'count' | 'duration' | 'score'

export interface CustomMetric {
  metric_id: string
  tenant_id: string
  name: string
  key: string
  type: MetricType
  description: string
  unit?: string
  calculation_rule: string
  query_template: string
  tags: string[]
  thresholds?: {
    warning?: number
    critical?: number
  }
  created_at: string
  created_by: string
}

export interface MetricValue {
  metric_key: string
  value: number
  timestamp: string
  period?: { from: string; to: string }
  context?: Record<string, unknown>
}

export interface MetricQueryResult {
  metric_key: string
  metric_name: string
  value: number
  unit?: string
  trend?: 'up' | 'down' | 'stable'
  comparison?: {
    previous: number
    change: number
    changePercent: number
  }
}

export async function getTenantMetrics(
  tenant_id: string,
  tags?: string[]
): Promise<CustomMetric[]> {
  try {
    const query = supabase
      .from('customer_metrics')
      .select('*')
      .eq('tenant_id', tenant_id)

    if (tags && tags.length > 0) {
      query.contains('tags', tags)
    }

    const { data, error } = await query.order('created_at')
    if (error) throw error
    return data as CustomMetric[]
  } catch (e) {
    console.error('Failed to fetch tenant metrics:', e)
    return []
  }
}

export async function getMetricValue(
  tenant_id: string,
  de_id: string,
  metric_key: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<MetricValue | null> {
  try {
    const { data, error } = await supabase.rpc('get_metric_value', {
      p_tenant_id: tenant_id,
      p_de_id: de_id,
      p_metric_key: metric_key,
      p_date_from: dateFrom?.toISOString() || null,
      p_date_to: dateTo?.toISOString() || null,
    })

    if (error) throw error
    return data as MetricValue
  } catch (e) {
    console.error(`Failed to fetch metric ${metric_key}:`, e)
    return null
  }
}

export async function getMetricsForDE(
  tenant_id: string,
  de_id: string,
  metric_keys?: string[],
  dateFrom?: Date,
  dateTo?: Date
): Promise<MetricQueryResult[]> {
  try {
    const { data, error } = await supabase.rpc('get_de_metrics_batch', {
      p_tenant_id: tenant_id,
      p_de_id: de_id,
      p_metric_keys: metric_keys || null,
      p_date_from: dateFrom?.toISOString() || null,
      p_date_to: dateTo?.toISOString() || null,
    })

    if (error) throw error
    return data as MetricQueryResult[]
  } catch (e) {
    console.error('Failed to fetch DE metrics:', e)
    return []
  }
}

export async function getMetricTrend(
  tenant_id: string,
  de_id: string,
  metric_key: string,
  dateFrom: Date,
  dateTo: Date,
  interval: 'hourly' | 'daily' | 'weekly' = 'daily'
): Promise<MetricValue[]> {
  try {
    const { data, error } = await supabase.rpc('get_metric_trend', {
      p_tenant_id: tenant_id,
      p_de_id: de_id,
      p_metric_key: metric_key,
      p_date_from: dateFrom.toISOString(),
      p_date_to: dateTo.toISOString(),
      p_interval: interval,
    })

    if (error) throw error
    return data as MetricValue[]
  } catch (e) {
    console.error(`Failed to fetch metric trend for ${metric_key}:`, e)
    return []
  }
}

export async function createCustomMetric(
  tenant_id: string,
  metric: Omit<CustomMetric, 'metric_id' | 'tenant_id' | 'created_at' | 'created_by'>
): Promise<CustomMetric | null> {
  try {
    const { data, error } = await supabase.rpc('create_custom_metric', {
      p_tenant_id: tenant_id,
      p_name: metric.name,
      p_key: metric.key,
      p_type: metric.type,
      p_description: metric.description,
      p_unit: metric.unit || null,
      p_calculation_rule: metric.calculation_rule,
      p_query_template: metric.query_template,
      p_tags: metric.tags,
      p_thresholds: metric.thresholds || null,
    })

    if (error) throw error
    return data as CustomMetric
  } catch (e) {
    console.error('Failed to create custom metric:', e)
    return null
  }
}

export async function updateCustomMetric(
  metric_id: string,
  updates: Partial<Omit<CustomMetric, 'metric_id' | 'tenant_id' | 'created_at' | 'created_by'>>
): Promise<CustomMetric | null> {
  try {
    const { data, error } = await supabase.rpc('update_custom_metric', {
      p_metric_id: metric_id,
      p_updates: updates,
    })

    if (error) throw error
    return data as CustomMetric
  } catch (e) {
    console.error('Failed to update custom metric:', e)
    return null
  }
}

export async function deleteCustomMetric(metric_id: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('delete_custom_metric', {
      p_metric_id: metric_id,
    })

    if (error) throw error
    return true
  } catch (e) {
    console.error('Failed to delete custom metric:', e)
    return false
  }
}

export const METRIC_TEMPLATES = {
  support: [
    {
      name: 'First Contact Resolution',
      key: 'fcr',
      type: 'percentage' as MetricType,
      description: 'Percentage of tickets resolved without escalation',
      unit: '%',
      calculation_rule: 'COUNT(resolved without escalation) / COUNT(all)',
      query_template: 'SELECT COUNT(*) WHERE escalation_count = 0',
      tags: ['support', 'de-performance'],
    },
    {
      name: 'Customer Satisfaction',
      key: 'csat',
      type: 'score' as MetricType,
      description: 'Average customer satisfaction rating',
      unit: '/5',
      calculation_rule: 'AVG(satisfaction_rating)',
      query_template: 'SELECT AVG(rating) FROM feedback WHERE rating IS NOT NULL',
      tags: ['support', 'satisfaction'],
    },
    {
      name: 'Time to Resolution (Median)',
      key: 'ttr_median',
      type: 'duration' as MetricType,
      description: 'Median time from ticket open to resolution',
      unit: 'minutes',
      calculation_rule: 'PERCENTILE(resolution_time, 0.5)',
      query_template: 'SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resolution_minutes)',
      tags: ['support', 'efficiency'],
    },
    {
      name: 'Escalation Rate',
      key: 'escalation_rate',
      type: 'percentage' as MetricType,
      description: 'Percentage of tickets escalated',
      unit: '%',
      calculation_rule: 'COUNT(escalated) / COUNT(all)',
      query_template: 'SELECT COUNT(*) WHERE escalation_count > 0',
      tags: ['support', 'performance'],
    },
    {
      name: 'Quality Score',
      key: 'quality_score',
      type: 'percentage' as MetricType,
      description: 'Percentage of responses rated accurate',
      unit: '%',
      calculation_rule: 'COUNT(accurate) / COUNT(rated)',
      query_template: 'SELECT COUNT(*) WHERE quality_rating >= 4',
      tags: ['support', 'quality'],
    },
  ],
  billing: [
    {
      name: 'Invoice Accuracy',
      key: 'invoice_accuracy',
      type: 'percentage' as MetricType,
      description: 'Percentage of invoices issued without error',
      unit: '%',
      calculation_rule: 'COUNT(accurate) / COUNT(all)',
      query_template: 'SELECT COUNT(*) WHERE has_error = false',
      tags: ['billing', 'quality'],
    },
    {
      name: 'Payment Processing Time',
      key: 'payment_time',
      type: 'duration' as MetricType,
      description: 'Average time from request to payment',
      unit: 'hours',
      calculation_rule: 'AVG(processing_hours)',
      query_template: 'SELECT AVG(EXTRACT(EPOCH FROM (processed_at - created_at))/3600)',
      tags: ['billing', 'efficiency'],
    },
  ],
  hr: [
    {
      name: 'Approval Rate',
      key: 'approval_rate',
      type: 'percentage' as MetricType,
      description: 'Percentage of requests approved automatically',
      unit: '%',
      calculation_rule: 'COUNT(approved) / COUNT(all)',
      query_template: 'SELECT COUNT(*) WHERE approved_by_de = true',
      tags: ['hr', 'automation'],
    },
    {
      name: 'Turnaround Time',
      key: 'turnaround_time',
      type: 'duration' as MetricType,
      description: 'Average time from request to resolution',
      unit: 'hours',
      calculation_rule: 'AVG(resolution_hours)',
      query_template: 'SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)',
      tags: ['hr', 'efficiency'],
    },
  ],
}
