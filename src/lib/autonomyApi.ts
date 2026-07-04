// ============================================================
// Trust dial v1 (R5) — de_autonomy: per-tenant, per-action autonomy
// thresholds (migration 016).
//
// COMPOSITION RULE (implemented in generateInvoice and the
// playbook-execute edge function): autonomy NARROWS within guardrails,
// never overrides them. An invoice auto-sends ONLY when BOTH:
//   (a) the guardrail rule allows auto (amount <= approval threshold), AND
//   (b) no de_autonomy 'invoice_auto_send' row exists, OR the row is
//       enabled AND amount <= its max_amount_cents.
// Every other case routes to human approval. Raising the trust dial can
// never authorize something a guardrail forbids.
//
// answer_dock / answer_widget confidence floors are stored here but
// consumed only on activation (R1) — de-answer/widget-ask wiring is a
// TODO(R1-activation) noted in docs/ROADMAP.md.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import { appendAuditEvent } from './guardrailApi';

export type AutonomyActionType = 'invoice_auto_send' | 'answer_dock' | 'answer_widget';

export interface DEAutonomy {
  id: string;
  tenant_id: string;
  action_type: AutonomyActionType;
  max_amount_cents: number | null;
  min_confidence: number | null;
  enabled: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export const AUTONOMY_ACTION_META: Record<AutonomyActionType, { label: string; description: string; unit: 'amount' | 'confidence'; dormant: boolean }> = {
  invoice_auto_send: {
    label: 'Auto-send renewal invoices',
    description: 'Invoices at or under this amount send without a human gate — but only within the guardrail approval threshold. Autonomy narrows within guardrails; it never overrides them.',
    unit: 'amount', dormant: false,
  },
  answer_dock: {
    label: 'Answer in the dock unaided',
    description: 'Minimum confidence for Alex to answer in the workspace dock without escalating. Stored now; enforced in de-answer on activation.',
    unit: 'confidence', dormant: true,
  },
  answer_widget: {
    label: 'Answer end-users via widget',
    description: 'Minimum confidence for widget answers to end-users. Stored now; enforced in widget-ask on activation.',
    unit: 'confidence', dormant: true,
  },
};

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

export async function listAutonomy(): Promise<DEAutonomy[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('de_autonomy')
    .select('*')
    .eq('tenant_id', tid)
    .order('action_type', { ascending: true });
  if (error) raise('listAutonomy', error);
  return (data ?? []) as DEAutonomy[];
}

/** Upsert one dial setting; the change appends a config_change audit event. */
export async function upsertAutonomy(
  action_type: AutonomyActionType,
  updates: { enabled: boolean; max_amount_cents?: number | null; min_confidence?: number | null },
): Promise<DEAutonomy> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('de_autonomy')
    .upsert(
      {
        tenant_id: tid, action_type,
        enabled: updates.enabled,
        max_amount_cents: updates.max_amount_cents ?? null,
        min_confidence: updates.min_confidence ?? null,
        updated_by: user?.id ?? null,
      },
      { onConflict: 'tenant_id,action_type' },
    )
    .select()
    .single();
  if (error) raise('upsertAutonomy', error);
  const row = data as DEAutonomy;
  const meta = AUTONOMY_ACTION_META[action_type];
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Trust dial ${row.enabled ? 'set' : 'disabled'} — ${meta.label}${
      row.enabled && meta.unit === 'amount' && row.max_amount_cents !== null ? ` (≤ $${Math.round(row.max_amount_cents / 100).toLocaleString()})` : ''
    }${row.enabled && meta.unit === 'confidence' && row.min_confidence !== null ? ` (confidence ≥ ${row.min_confidence}%)` : ''}`,
    detail: {
      autonomy_id: row.id, action_type, enabled: row.enabled,
      max_amount_cents: row.max_amount_cents, min_confidence: row.min_confidence,
      composition: 'autonomy_narrows_within_guardrails',
    },
  });
  return row;
}

/** The invoice_auto_send dial (null when unset or table missing). */
export async function getInvoiceAutonomy(): Promise<Pick<DEAutonomy, 'id' | 'enabled' | 'max_amount_cents'> | null> {
  try {
    const tid = await requireTenantId();
    const { data, error } = await supabase
      .from('de_autonomy')
      .select('id, enabled, max_amount_cents')
      .eq('tenant_id', tid)
      .eq('action_type', 'invoice_auto_send')
      .maybeSingle();
    if (error || !data) return null;
    return data as Pick<DEAutonomy, 'id' | 'enabled' | 'max_amount_cents'>;
  } catch {
    return null;
  }
}

// ── Evidence line: computed from the immutable audit trail ────────

export interface ApprovalEvidence {
  total: number;
  approved: number;
  approvedPct: number;
}

/** "N invoice approvals, M approved (P%)" — from approval-category
 *  audit events whose detail records an approval_gate decision. */
export async function getApprovalEvidence(): Promise<ApprovalEvidence> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('audit_events')
    .select('detail')
    .eq('tenant_id', tid)
    .eq('category', 'approval')
    .limit(500);
  if (error) raise('getApprovalEvidence', error);
  const rows = (data ?? []) as Array<{ detail: Record<string, unknown> }>;
  const gates = rows.filter(r => r.detail?.task_type === 'approval_gate' && typeof r.detail?.decision === 'string');
  const approved = gates.filter(r => r.detail.decision === 'approved').length;
  const total = gates.length;
  return { total, approved, approvedPct: total > 0 ? Math.round((approved / total) * 100) : 0 };
}
