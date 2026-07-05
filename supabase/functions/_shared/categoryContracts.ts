/**
 * categoryContracts — the CATEGORY CONTRACT layer (single source for
 * edge functions; mirrored for the browser at src/lib/categoryContracts.ts
 * — keep the two files in sync, the shapes are identical).
 *
 * Doctrine: the app talks in system CATEGORIES (canonical objects and
 * operations); provider adapters translate. A consumer says
 * "helpdesk.search_tickets", never "call Zendesk". That keeps the
 * evidence pipeline and playbooks provider-agnostic and makes swapping
 * a customer's stack a configuration change, not a code change.
 *
 * Honesty contract:
 *   - op not in the connector's category   → op_not_legal_for_category
 *   - op legal but the provider can't do it → op_not_supported
 */

export type SystemCategory =
  | 'crm' | 'helpdesk' | 'knowledge_base' | 'erp_financials' | 'billing'
  | 'payroll_hcm' | 'pos' | 'product_system' | 'other';

export const CATEGORIES: SystemCategory[] = [
  'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
  'payroll_hcm', 'pos', 'product_system', 'other',
];

export const CATEGORY_LABELS: Record<SystemCategory, string> = {
  crm: 'CRM — customers, deals, conversations',
  helpdesk: 'Helpdesk — tickets & help articles',
  knowledge_base: 'Knowledge base — docs & pages',
  erp_financials: 'ERP / Financials — invoices, payments, POs',
  billing: 'Billing — subscriptions, invoices, usage',
  payroll_hcm: 'Payroll / HCM — employees, payruns, time off',
  pos: 'Point of sale — orders & products',
  product_system: 'Product system — your own product’s records',
  other: 'Other',
};

/** Canonical operation: what the app may ask a system of this category. */
export interface CategoryOp {
  op: string;
  object: string;          // canonical object the op returns
  kind: 'search' | 'get';  // search takes {query}, get takes {external_ref}
  label: string;           // plain language
}

export const CATEGORY_OPS: Record<SystemCategory, CategoryOp[]> = {
  crm: [
    { op: 'search_accounts', object: 'account', kind: 'search', label: 'Find customer accounts' },
    { op: 'get_account', object: 'account', kind: 'get', label: 'Fetch one account' },
    { op: 'search_conversations', object: 'conversation', kind: 'search', label: 'Find past conversations/cases' },
    { op: 'search_opportunities', object: 'opportunity', kind: 'search', label: 'Find deals/opportunities' },
  ],
  helpdesk: [
    { op: 'search_tickets', object: 'ticket', kind: 'search', label: 'Find support tickets' },
    { op: 'get_ticket', object: 'ticket', kind: 'get', label: 'Fetch one ticket' },
    { op: 'search_articles', object: 'article', kind: 'search', label: 'Find help articles' },
  ],
  knowledge_base: [
    { op: 'search_articles', object: 'article', kind: 'search', label: 'Find articles/pages' },
    { op: 'get_article', object: 'article', kind: 'get', label: 'Fetch one article/page' },
  ],
  erp_financials: [
    { op: 'search_invoices', object: 'invoice', kind: 'search', label: 'Find invoices' },
    { op: 'get_invoice', object: 'invoice', kind: 'get', label: 'Fetch one invoice' },
  ],
  billing: [
    { op: 'get_subscription', object: 'subscription', kind: 'get', label: 'Fetch a subscription' },
    { op: 'search_invoices', object: 'invoice', kind: 'search', label: 'Find invoices' },
  ],
  payroll_hcm: [
    { op: 'get_employee', object: 'employee', kind: 'get', label: 'Fetch an employee record' },
    { op: 'search_time_off', object: 'time_off', kind: 'search', label: 'Find time-off records' },
  ],
  pos: [
    { op: 'search_orders', object: 'order', kind: 'search', label: 'Find orders' },
    { op: 'get_order', object: 'order', kind: 'get', label: 'Fetch one order' },
  ],
  product_system: [
    { op: 'get_record', object: 'record', kind: 'get', label: 'Fetch one record' },
    { op: 'search_records', object: 'record', kind: 'search', label: 'Find records' },
  ],
  other: [
    { op: 'get_record', object: 'record', kind: 'get', label: 'Fetch one record' },
    { op: 'search_records', object: 'record', kind: 'search', label: 'Find records' },
  ],
};

export function getCategoryOp(category: SystemCategory, op: string): CategoryOp | null {
  return (CATEGORY_OPS[category] ?? []).find((o) => o.op === op) ?? null;
}

export function legalOps(category: SystemCategory): string[] {
  return (CATEGORY_OPS[category] ?? []).map((o) => o.op);
}

/**
 * Canonical object shape every category op returns. raw_fields is the
 * source payload passed through UNMAPPED (returned live, never
 * persisted — same read-through contract as the hub).
 */
export interface CanonicalItem {
  id: string;                 // canonical id (= external_ref today)
  external_ref: string;       // the SoR's own id
  url: string | null;
  title: string;              // title / name
  snippet: string;            // ≤400 chars
  object: string;             // canonical object name (account, ticket, …)
  source_system: string;      // connector display name
  source_provider: string;    // provider key (zendesk, generic_rest, …)
  raw_fields?: unknown;       // full source payload — never persisted
}

/** Canonical fields a customer's field_map may override (canonical → source field name). */
export const MAPPABLE_FIELDS = ['title', 'snippet', 'url', 'external_ref'] as const;

// ── Connector health (call-driven; computed, no stored status) ──
export type ConnectorHealth = 'healthy' | 'degraded' | 'down' | 'never_connected';

export function computeHealth(c: {
  last_ok_at?: string | null;
  last_error_at?: string | null;
  consecutive_failures?: number | null;
}): ConnectorHealth {
  const failures = c.consecutive_failures ?? 0;
  if (!c.last_ok_at && !c.last_error_at) return 'never_connected';
  if (failures >= 3) return 'down';
  if (failures >= 1) return 'degraded';
  return 'healthy';
}

export const HEALTH_LABELS: Record<ConnectorHealth, string> = {
  healthy: 'Healthy — last call succeeded',
  degraded: 'Degraded — recent calls failing',
  down: 'Down — 3+ consecutive failures',
  never_connected: 'Never connected — no calls made yet',
};
