// ============================================================
// R6 — Tenant playbook builder: definitions, versions, and the
// step-primitive registry (client mirror of the server registry in
// supabase/functions/playbook-execute/index.ts — the SERVER is the
// authority; publish always re-validates there).
//
// Lifecycle: draft (editable) → publish (server validation + immutable
// playbook_versions snapshot + version bump) → runs execute the
// snapshot, never the live draft. Editing a published definition just
// mutates the draft steps; the next publish snapshots version+1.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import type { PlaybookRun } from './playbookApi';

// ── Registry (UI metadata + param forms) ──────────────────────────

export type PrimitiveKey =
  | 'check_account' | 'generate_invoice' | 'human_approval' | 'guardrail_check'
  | 'connector_action' | 'update_record' | 'log_activity' | 'complete';

export interface DefinitionStep {
  key: PrimitiveKey;
  label?: string;
  params: Record<string, unknown>;
}

export interface PrimitiveMeta {
  key: PrimitiveKey;
  label: string;
  description: string;
  gate: boolean;             // can pause the run for a human
  defaultParams: Record<string, unknown>;
}

export const PRIMITIVE_REGISTRY: PrimitiveMeta[] = [
  { key: 'check_account', label: 'Check account', gate: false, defaultParams: {},
    description: 'Loads the target account into the run context. Must be the first step.' },
  { key: 'generate_invoice', label: 'Generate invoice', gate: true,
    defaultParams: { amount_source: 'account_arr' },
    description: 'Creates a renewal invoice. Runs the guardrail + trust-dial composition — over-limit amounts route to human approval.' },
  { key: 'human_approval', label: 'Human approval', gate: true,
    defaultParams: { title_template: 'Playbook approval — {{account.name}}', task_type: 'approval_gate' },
    description: 'Explicit gate: creates a Human Task and pauses the run. Skipped automatically when a prior invoice was auto-approved within limits.' },
  { key: 'guardrail_check', label: 'Guardrail check', gate: false,
    defaultParams: { check: 'invoice_threshold' },
    description: 'Explicit re-check point — records the threshold comparison in the audit chain. Never pauses.' },
  { key: 'connector_action', label: 'Connector action', gate: false,
    defaultParams: { provider: 'zendesk', op: 'add_internal_note', payload_template: 'Playbook update for {{account.name}}: invoice {{invoice.amount}}', external_ref_template: '' },
    description: 'Write-back into the system of record (Zendesk). Degrades honestly: no connector → step recorded as skipped, run continues.' },
  { key: 'update_record', label: 'Update record', gate: false,
    defaultParams: { table: 'renewal_invoices', set: { status: 'sent' } },
    description: 'Whitelisted status flip only (invoices: sent/paid · tickets: open/pending/resolved/escalated).' },
  { key: 'log_activity', label: 'Log activity', gate: false,
    defaultParams: { text_template: 'Playbook completed for {{account.name}} — invoice {{invoice.amount}}' },
    description: 'Writes a line to the activity feed. Supports templates.' },
  { key: 'complete', label: 'Complete', gate: false, defaultParams: {},
    description: 'Marks the run completed. Required final step.' },
];

export const TEMPLATE_VARS = [
  { token: '{{account.name}}', meaning: 'Account name from the run context' },
  { token: '{{invoice.amount}}', meaning: 'Invoice amount (formatted, e.g. $12,000)' },
  { token: '{{run.id}}', meaning: 'The playbook run id' },
];

export const UPDATE_WHITELIST: Record<string, string[]> = {
  renewal_invoices: ['sent', 'paid'],
  support_tickets: ['open', 'pending', 'resolved', 'escalated'],
};

// Client-side mirror of the server validator — instant feedback in the
// builder. The server re-validates on publish regardless.
export interface ValidationError { index: number; code: string; message: string }

export function validateStepsClient(steps: DefinitionStep[]): ValidationError[] {
  const errs: ValidationError[] = [];
  if (steps.length === 0) return [{ index: -1, code: 'empty', message: 'A playbook needs at least one step.' }];
  if (steps.length > 20) errs.push({ index: -1, code: 'too_many_steps', message: 'A playbook is limited to 20 steps.' });
  const known = new Set(PRIMITIVE_REGISTRY.map(p => p.key));
  const postGateAllowed = new Set(['guardrail_check', 'connector_action', 'update_record', 'log_activity', 'complete']);
  let invoiceIdx = -1, approvalIdx = -1, completeCount = 0;
  steps.forEach((s, i) => {
    if (!known.has(s.key)) { errs.push({ index: i, code: 'unknown_primitive', message: `Unknown step primitive "${s.key}".` }); return; }
    const p = s.params ?? {};
    if (s.key === 'generate_invoice') {
      if (invoiceIdx !== -1) errs.push({ index: i, code: 'multiple_invoice', message: 'At most one Generate invoice step is allowed.' });
      invoiceIdx = invoiceIdx === -1 ? i : invoiceIdx;
      if (p.amount_source !== 'account_arr' && p.amount_source !== 'fixed') {
        errs.push({ index: i, code: 'bad_params', message: 'Amount source must be account ARR or a fixed amount.' });
      } else if (p.amount_source === 'fixed' && (typeof p.fixed_amount_cents !== 'number' || p.fixed_amount_cents <= 0)) {
        errs.push({ index: i, code: 'bad_params', message: 'Fixed amount must be greater than zero.' });
      }
    }
    if (s.key === 'human_approval') {
      if (approvalIdx !== -1) errs.push({ index: i, code: 'multiple_approval', message: 'At most one Human approval step is allowed.' });
      approvalIdx = approvalIdx === -1 ? i : approvalIdx;
    }
    if (s.key === 'update_record') {
      const allowed = UPDATE_WHITELIST[p.table as string];
      const status = (p.set as Record<string, unknown> | undefined)?.status as string;
      if (!allowed) errs.push({ index: i, code: 'bad_params', message: 'Update record table must be renewal_invoices or support_tickets.' });
      else if (!allowed.includes(status)) errs.push({ index: i, code: 'bad_params', message: `Status must be one of: ${allowed.join(', ')}.` });
    }
    if (s.key === 'log_activity' && !(typeof p.text_template === 'string' && p.text_template.trim())) {
      errs.push({ index: i, code: 'bad_params', message: 'Log activity needs a message template.' });
    }
    if (s.key === 'complete') completeCount++;
  });
  if (steps[0]?.key !== 'check_account') errs.push({ index: 0, code: 'first_step', message: 'Step 1 must be Check account.' });
  if (steps[steps.length - 1]?.key !== 'complete') errs.push({ index: steps.length - 1, code: 'last_step', message: 'The last step must be Complete.' });
  if (completeCount > 1) errs.push({ index: -1, code: 'multiple_complete', message: 'Only one Complete step is allowed (at the end).' });
  if (approvalIdx !== -1 && (invoiceIdx === -1 || invoiceIdx > approvalIdx)) {
    errs.push({ index: approvalIdx, code: 'approval_without_invoice', message: 'Human approval must come after Generate invoice — it gates the invoice.' });
  }
  if (approvalIdx !== -1) {
    steps.slice(approvalIdx + 1).forEach((s, off) => {
      if (!postGateAllowed.has(s.key)) {
        errs.push({ index: approvalIdx + 1 + off, code: 'post_gate_primitive', message: `"${s.key}" cannot follow Human approval — only guardrail check, connector action, update record, log activity, and complete may run after the gate.` });
      }
    });
  }
  return errs;
}

// ── Types / CRUD ──────────────────────────────────────────────────

export type DefinitionStatus = 'draft' | 'published' | 'archived';

export interface PlaybookDefinition {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  version: number;
  status: DefinitionStatus;
  steps: DefinitionStep[];
  trigger_type: 'manual' | 'schedule' | 'event';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

const notify = () => { try { window.dispatchEvent(new Event('dt-state-changed')); } catch { /* noop */ } };

export async function listDefinitions(): Promise<PlaybookDefinition[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_definitions').select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listDefinitions', error);
  return (data ?? []) as PlaybookDefinition[];
}

export async function createDefinition(input: {
  key: string; name: string; description: string; steps: DefinitionStep[];
}): Promise<PlaybookDefinition> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('playbook_definitions')
    .insert({ tenant_id: tid, key: input.key, name: input.name, description: input.description, steps: input.steps, created_by: user?.id ?? null })
    .select().single();
  if (error) raise('createDefinition', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Playbook definition created — "${input.name}" (${input.key}), ${input.steps.length} steps, draft`,
    detail: { kind: 'playbook_definition', definition_id: (data as PlaybookDefinition).id, key: input.key },
  });
  notify();
  return data as PlaybookDefinition;
}

export async function updateDefinition(
  id: string,
  updates: Partial<Pick<PlaybookDefinition, 'name' | 'description' | 'steps' | 'status'>>,
): Promise<PlaybookDefinition> {
  const { data, error } = await supabase
    .from('playbook_definitions').update(updates).eq('id', id).select().single();
  if (error) raise('updateDefinition', error);
  const def = data as PlaybookDefinition;
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: updates.status === 'archived'
      ? `Playbook definition archived — "${def.name}" (${def.key})`
      : `Playbook definition edited — "${def.name}" (${def.key}), ${def.steps.length} steps`,
    detail: { kind: 'playbook_definition', definition_id: id, key: def.key, status: def.status },
  });
  notify();
  return def;
}

// ── Server actions (playbook-execute edge function) ───────────────

export interface PublishResult { published: boolean; version?: number; errors?: ValidationError[]; error?: string }

/** Publish: server-side validation → immutable version snapshot → status published. */
export async function publishDefinition(definitionId: string): Promise<PublishResult> {
  const { data, error } = await supabase.functions.invoke('playbook-execute', {
    body: { action: 'publish', definition_id: definitionId },
  });
  if (error) {
    // supabase-js surfaces non-2xx as FunctionsHttpError — read the body for structured errors.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { return await ctx.json() as PublishResult; } catch { /* fallthrough */ }
    }
    raise('publishDefinition', { message: error.message ?? String(error) });
  }
  notify();
  return data as PublishResult;
}

export interface StartDefinitionResult { run_id: string; status: string; task_id?: string; error?: string }

/** Start a run of the latest PUBLISHED snapshot (server-executed). */
export async function startDefinitionRun(definitionId: string, accountId: string): Promise<StartDefinitionResult> {
  const { data, error } = await supabase.functions.invoke('playbook-execute', {
    body: { action: 'start', definition_id: definitionId, account_id: accountId },
  });
  if (error) raise('startDefinitionRun', { message: error.message ?? String(error) });
  const res = data as StartDefinitionResult;
  if (res?.error) raise('startDefinitionRun', { message: res.error });
  notify();
  return res;
}

export function runsForDefinition(runs: PlaybookRun[], definitionId: string): PlaybookRun[] {
  return runs.filter(r => (r as PlaybookRun & { definition_id?: string | null }).definition_id === definitionId);
}
