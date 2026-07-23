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
  source: 'computed' | 'manual' | 'action';   // action = auto-tracked from what the DE did (mig 263)
  source_config?: Record<string, unknown>;
  domains?: string[] | null;                   // system categories it suits; null = any
  applicable?: boolean;                        // only from getKpiMetricsForDe — suits this DE's role
  sort_order: number;
  is_custom: boolean;
}

/** Catalog metrics ordered for one employee — the ones that suit its role
 *  (by the system categories it operates) first. mig 263. */
export async function getKpiMetricsForDe(deId: string): Promise<KpiMetric[]> {
  const { data, error } = await supabase.rpc('get_kpi_metrics_for_de', { p_de_id: deId });
  if (error) throw new Error(error.message);
  return (data ?? []) as KpiMetric[];
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

// A condition tests one signal from the catalog (mig 262).
export interface EscCondition { signal: string; op: string; value: string | number | boolean }
export interface EscalationRule {
  name: string;
  action: 'escalate' | 'require_approval';
  enabled: boolean;
  match?: 'all' | 'any';          // AND (default) / OR across conditions
  conditions?: EscCondition[];    // the generic model
  when?: string;                  // legacy keyword rows still supported
}

export interface EscalationSignal {
  key: string;
  label: string;
  value_type: 'number' | 'text' | 'boolean';
  applies_to: string[];
  help: string | null;
}

/** The extensible signal catalog an escalation condition can test. */
export async function getEscalationSignals(): Promise<EscalationSignal[]> {
  const { data, error } = await supabase.rpc('get_escalation_signals');
  if (error) throw new Error(error.message);
  return (data ?? []) as EscalationSignal[];
}

// Operators offered per value type — the UI reads this, so a new signal of a
// known type gets the right operators for free.
export const OPERATORS_BY_TYPE: Record<string, Array<{ op: string; label: string }>> = {
  number: [
    { op: 'gt', label: 'is greater than' }, { op: 'gte', label: 'is at least' },
    { op: 'lt', label: 'is less than' }, { op: 'lte', label: 'is at most' }, { op: 'eq', label: 'equals' },
  ],
  text: [
    { op: 'contains', label: 'contains' }, { op: 'not_contains', label: 'does not contain' },
    { op: 'eq', label: 'is exactly' },
  ],
  boolean: [{ op: 'is_true', label: 'is yes' }, { op: 'is_false', label: 'is no' }],
};

function friendly(raw: string): string {
  if (raw.includes('insufficient_role')) return 'Only workspace owners and admins can change this.';
  if (raw.includes('metric_key_reserved')) return 'That name is already used by a built-in metric — pick another.';
  if (raw.includes('skill_key_reserved')) return 'That name is already used by a built-in skill — pick another.';
  if (raw.includes('must be lowercase letters')) return 'Use lowercase letters, numbers and underscores only (e.g. first_call_resolution).';
  if (raw.includes('unknown_skill_category')) return 'That skill category does not exist.';
  if (raw.includes('unknown_metric_key')) return 'Define that metric in your KPI catalog before using it.';
  return raw;
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
