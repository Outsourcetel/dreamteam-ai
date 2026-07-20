// Tenant-extensible role configuration (Wave 2).
//
// KPIs, skills, skill categories and certification types used to be closed
// lists compiled into the UI. They are now catalogs: built-in entries every
// workspace gets, plus whatever this workspace defines for itself.
//
// The computed/manual split matters and is surfaced deliberately — a
// platform-computed metric fills itself in, a workspace-defined one only
// shows a value once somebody records a reading. Hiding that difference
// would produce KPIs that look broken.
import { supabase } from '../supabase';

export interface KpiMetric {
  metric_key: string;
  label: string;
  description: string | null;
  direction: 'higher' | 'lower';
  unit: string | null;
  source: 'computed' | 'manual';
  sort_order: number;
  is_custom: boolean;
}

export interface SkillCategory {
  key: string;
  label: string;
  sort_order: number;
  is_custom: boolean;
}

export interface CertificationType {
  key: string;
  label: string;
  description: string | null;
  sort_order: number;
  is_custom: boolean;
}

export interface EscalationRule {
  name: string;
  when: string;
  action: 'escalate' | 'require_approval';
  enabled: boolean;
}

function friendly(raw: string): string {
  if (raw.includes('insufficient_role')) return 'Only workspace owners and admins can change this.';
  if (raw.includes('metric_key_reserved')) return 'That name is already used by a built-in metric — pick another.';
  if (raw.includes('skill_key_reserved')) return 'That name is already used by a built-in skill — pick another.';
  if (raw.includes('must be lowercase letters')) return 'Use lowercase letters, numbers and underscores only (e.g. first_call_resolution).';
  if (raw.includes('unknown_skill_category')) return 'That skill category does not exist.';
  if (raw.includes('unknown_metric_key')) return 'Define that metric in your KPI catalog before using it.';
  return raw;
}

export async function listKpiMetrics(): Promise<KpiMetric[]> {
  const { data, error } = await supabase.rpc('list_kpi_metrics');
  if (error) throw new Error(friendly(error.message));
  return (data ?? []) as KpiMetric[];
}

export async function listSkillCategories(): Promise<SkillCategory[]> {
  const { data, error } = await supabase.rpc('list_skill_categories');
  if (error) throw new Error(friendly(error.message));
  return (data ?? []) as SkillCategory[];
}

export async function listCertificationTypes(): Promise<CertificationType[]> {
  const { data, error } = await supabase.rpc('list_certification_types');
  if (error) throw new Error(friendly(error.message));
  return (data ?? []) as CertificationType[];
}

/** Define a metric this workspace tracks itself. Always source='manual'. */
export async function createKpiMetric(args: {
  metricKey: string; label: string; direction: 'higher' | 'lower';
  unit?: string; description?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('upsert_kpi_metric', {
    p_metric_key: args.metricKey, p_label: args.label, p_direction: args.direction,
    p_unit: args.unit ?? null, p_description: args.description ?? null,
  });
  if (error) throw new Error(friendly(error.message));
}

/** Record a value for a manual metric — this is what makes it show a number. */
export async function recordKpiReading(args: {
  deId: string; metricKey: string; value: number; asOf?: string; note?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('record_kpi_reading', {
    p_de_id: args.deId, p_metric_key: args.metricKey, p_value: args.value,
    p_as_of: args.asOf ?? null, p_note: args.note ?? null,
  });
  if (error) throw new Error(friendly(error.message));
}

export async function createTenantSkill(args: {
  skillKey: string; name: string; category: string; description?: string; signalLabel?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_tenant_skill', {
    p_skill_key: args.skillKey, p_name: args.name, p_category: args.category,
    p_description: args.description ?? null, p_signal_label: args.signalLabel ?? null,
  });
  if (error) throw new Error(friendly(error.message));
  return data as string;
}

export async function getCustomEscalationRules(deId: string): Promise<EscalationRule[]> {
  const { data, error } = await supabase.from('de_escalation_rules')
    .select('custom_rules').eq('de_id', deId).maybeSingle();
  if (error) throw new Error(friendly(error.message));
  const rules = (data?.custom_rules ?? []) as EscalationRule[];
  return Array.isArray(rules) ? rules : [];
}

export async function saveCustomEscalationRules(deId: string, rules: EscalationRule[]): Promise<void> {
  const { error } = await supabase.rpc('set_de_custom_escalation_rules', {
    p_de_id: deId, p_rules: rules,
  });
  if (error) throw new Error(friendly(error.message));
}

/** Turn a label into a valid key: "First-call resolution" -> "first_call_resolution". */
export function slugifyKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}
