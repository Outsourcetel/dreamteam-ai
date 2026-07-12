// ============================================================
// Wave 4 — Tenant vocabulary: the per-tenant relabeling layer that
// removes the hardcoded B2B-SaaS nouns from live surfaces. A tenant
// (or their industry template) chooses what they call the party they
// serve and their value metric; every live surface reads THIS instead
// of hardcoding "Customer"/"ARR". Unset fields fall back to the
// original SaaS defaults, so existing tenants change nothing.
// Stored on tenants.vocabulary (jsonb), written via
// update_tenant_general_settings (migration 135).
// ============================================================
import { useAuth } from '../context/AuthContext';

export interface Vocabulary {
  /** What one served party is called, e.g. Customer / Patient / Client / Order */
  party_singular: string;
  /** Plural, e.g. Customers / Patients / Clients / Orders */
  party_plural: string;
  /** The value metric label, e.g. ARR / Contract value / Care value */
  value_metric: string;
  /** Short qualifier for the metric period, e.g. "$/year" */
  value_metric_hint: string;
  /** The recurring-commitment noun, e.g. Renewal / Re-enrollment / Reorder */
  renewal_label: string;
  /** The nav section title, e.g. "Customers" */
  section_label: string;
}

export const DEFAULT_VOCABULARY: Vocabulary = {
  party_singular: 'Customer',
  party_plural: 'Customers',
  value_metric: 'ARR',
  value_metric_hint: '$/year',
  renewal_label: 'Renewal',
  section_label: 'Customers',
};

/** Merge a tenant's stored vocabulary (possibly partial/empty) over the defaults. */
export function resolveVocabulary(raw: unknown): Vocabulary {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Vocabulary, unknown>>;
  const pick = (k: keyof Vocabulary) =>
    typeof v[k] === 'string' && (v[k] as string).trim() ? (v[k] as string).trim() : DEFAULT_VOCABULARY[k];
  return {
    party_singular: pick('party_singular'),
    party_plural: pick('party_plural'),
    value_metric: pick('value_metric'),
    value_metric_hint: pick('value_metric_hint'),
    renewal_label: pick('renewal_label'),
    section_label: pick('section_label'),
  };
}

/** The tenant's vocabulary, defaults-merged. Safe in demo mode (defaults). */
export function useVocabulary(): Vocabulary {
  const { currentTenant } = useAuth();
  return resolveVocabulary((currentTenant as { vocabulary?: unknown } | null)?.vocabulary);
}
