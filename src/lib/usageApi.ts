// ============================================================
// Usage metrics — LIVE observability groundwork (migration 013).
// usage_metrics rows are written by the de-answer edge function
// via SECURITY DEFINER RPCs; this module only reads them.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId } from './customerApi';

export interface MonthlyUsage {
  inquiries: number;
  cache_hits: number;
  escalations: number;
  llm_calls: number;
}

const EMPTY: MonthlyUsage = { inquiries: 0, cache_hits: 0, escalations: 0, llm_calls: 0 };

/** Sum of this calendar month's usage_metrics per metric for the
 *  current tenant. Returns zeros when nothing is recorded (or the
 *  table doesn't exist yet — non-fatal). */
export async function fetchMonthlyUsage(): Promise<MonthlyUsage> {
  const tid = await getSessionTenantId();
  if (!tid) return { ...EMPTY };
  const monthStart = new Date();
  monthStart.setDate(1);
  const from = monthStart.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('usage_metrics')
    .select('metric, value')
    .eq('tenant_id', tid)
    .gte('day', from);
  if (error) {
    console.error('fetchMonthlyUsage:', error.message);
    return { ...EMPTY };
  }
  const usage: MonthlyUsage = { ...EMPTY };
  for (const row of data ?? []) {
    if (row.metric in usage) usage[row.metric as keyof MonthlyUsage] += Number(row.value) || 0;
  }
  return usage;
}
