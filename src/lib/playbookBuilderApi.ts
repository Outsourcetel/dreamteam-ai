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
  | 'connector_action' | 'update_record' | 'log_activity' | 'consult_specialist'
  | 'instruction' | 'decision' | 'checklist' | 'wait' | 'sub_playbook' | 'complete';

export interface StepMedia {
  asset_id?: string;
  url?: string;
  kind: 'image' | 'video';
  caption?: string;
}

export interface DefinitionStep {
  key: PrimitiveKey;
  label?: string;
  params: Record<string, unknown>;
  /** decision only — branch steps rendered indented under the decision. */
  then_steps?: DefinitionStep[];
  else_steps?: DefinitionStep[];
}

export const DECISION_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'exists', label: 'exists (has any value)' },
] as const;

// Primitives allowed inside a decision's then/else branch — no gates,
// no invoice generation, no complete (one level of nesting, v1).
export const BRANCH_PRIMITIVES: PrimitiveKey[] = [
  'instruction', 'checklist', 'wait', 'log_activity', 'update_record',
  'connector_action', 'guardrail_check', 'consult_specialist',
];

export interface PrimitiveMeta {
  key: PrimitiveKey;
  label: string;
  description: string;
  gate: boolean;             // can pause the run for a human
  group: 'work' | 'guide' | 'flow';
  defaultParams: Record<string, unknown>;
}

export const PRIMITIVE_REGISTRY: PrimitiveMeta[] = [
  { key: 'check_account', label: 'Check account', gate: false, group: 'work', defaultParams: {},
    description: 'Loads the target account into the run context. Must be the first step.' },
  { key: 'generate_invoice', label: 'Generate invoice', gate: true, group: 'work',
    defaultParams: { amount_source: 'account_arr' },
    description: 'Creates a renewal invoice. Runs the guardrail + trust-dial composition — over-limit amounts route to human approval.' },
  { key: 'human_approval', label: 'Human approval', gate: true, group: 'work',
    defaultParams: { title_template: 'Playbook approval — {{account.name}}', task_type: 'approval_gate' },
    description: 'Explicit gate: creates a Human Task and pauses the run. Skipped automatically when a prior invoice was auto-approved within limits.' },
  { key: 'guardrail_check', label: 'Guardrail check', gate: false, group: 'work',
    defaultParams: { check: 'invoice_threshold' },
    description: 'Explicit re-check point — records the threshold comparison in the audit chain. Never pauses.' },
  { key: 'connector_action', label: 'Connector action', gate: false, group: 'work',
    defaultParams: { provider: 'zendesk', op: 'add_internal_note', payload_template: 'Playbook update for {{account.name}}: invoice {{invoice.amount}}', external_ref_template: '' },
    description: 'Write-back into the system of record (Zendesk). Degrades honestly: no connector → step recorded as skipped, run continues.' },
  { key: 'update_record', label: 'Update record', gate: false, group: 'work',
    defaultParams: { table: 'renewal_invoices', set: { status: 'sent' } },
    description: 'Whitelisted status flip only (invoices: sent/paid · tickets: open/pending/resolved/escalated).' },
  { key: 'log_activity', label: 'Log activity', gate: false, group: 'work',
    defaultParams: { text_template: 'Playbook completed for {{account.name}} — invoice {{invoice.amount}}' },
    description: 'Writes a line to the activity feed. Supports templates.' },
  { key: 'consult_specialist', label: 'Consult specialist', gate: false, group: 'work',
    defaultParams: { profile_key: 'technical', question_template: 'Review this run for {{account.name}} — any technical risks?', min_confidence: 60, on_low: 'escalate' },
    description: 'Consults a Specialist (Technical v1) server-side. Recorded in the consultation log. Below the confidence floor → escalate to a human or continue (your choice). Dormant LLM → step skipped honestly.' },
  { key: 'instruction', label: 'Instruction', gate: false, group: 'guide',
    defaultParams: { title: 'Before you continue', body_md: '', media: [] },
    description: 'Explains something to whoever is reading the playbook — text, images, or video, embedded right in the step. Feeds later "Consult specialist" steps as context once the specialist brain is activated.' },
  { key: 'checklist', label: 'Checklist', gate: true, group: 'guide',
    defaultParams: { items: [''] },
    description: 'A list of items a human must tick off. Creates a Human Task and pauses the run until every item is confirmed.' },
  { key: 'decision', label: 'Decision', gate: false, group: 'flow',
    defaultParams: { on: '', operator: 'exists', value: '', then_steps: [], else_steps: [] },
    description: 'Branches the playbook based on an earlier step’s result — "then" and "else" steps render indented underneath. One level of nesting.' },
  { key: 'wait', label: 'Wait', gate: false, group: 'flow',
    defaultParams: { duration_minutes: 60 },
    description: 'Pauses the run for a set number of minutes, then continues automatically (checked every 5 minutes).' },
  { key: 'sub_playbook', label: 'Run another playbook', gate: false, group: 'flow',
    defaultParams: { playbook_id: '' },
    description: 'Runs a published playbook as a child of this one. The child inherits this playbook’s access — it can never do more than its parent is allowed to.' },
  { key: 'complete', label: 'Complete', gate: false, group: 'work', defaultParams: {},
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

function validateBranchClient(
  branch: DefinitionStep[] | undefined, parentIndex: number, side: 'then' | 'else', depth: number, errs: ValidationError[],
): void {
  if (!Array.isArray(branch)) return;
  for (const bs of branch) {
    if (bs.key === 'decision') {
      if (depth >= 1) {
        errs.push({ index: parentIndex, code: 'decision_nesting_too_deep', message: `This decision is nested inside another decision's ${side} branch — decisions can only be nested one level deep. Move the inner decision to its own top-level step.` });
        continue;
      }
      validateDecisionClient(bs, parentIndex, depth + 1, errs);
      continue;
    }
    if (!BRANCH_PRIMITIVES.includes(bs.key)) {
      errs.push({ index: parentIndex, code: 'branch_primitive_not_allowed', message: `"${bs.key}" cannot run inside a decision's ${side} branch — only guide/explain and simple work steps are allowed there.` });
    }
  }
}

function validateDecisionClient(s: DefinitionStep, i: number, depth: number, errs: ValidationError[]): void {
  const p = s.params ?? {};
  if (!(typeof p.on === 'string' && p.on.trim())) {
    errs.push({ index: i, code: 'bad_params', message: 'This decision needs to know what to look at — pick a prior step and field.' });
  }
  if (!(DECISION_OPERATORS as readonly { value: string }[]).some(o => o.value === p.operator)) {
    errs.push({ index: i, code: 'bad_params', message: 'Pick a comparison for this decision.' });
  }
  if (p.operator !== 'exists' && (p.value === undefined || p.value === null || p.value === '')) {
    errs.push({ index: i, code: 'bad_params', message: 'This decision needs a value to compare against.' });
  }
  validateBranchClient(s.then_steps, i, 'then', depth, errs);
  validateBranchClient(s.else_steps, i, 'else', depth, errs);
}

export function validateStepsClient(steps: DefinitionStep[]): ValidationError[] {
  const errs: ValidationError[] = [];
  if (steps.length === 0) return [{ index: -1, code: 'empty', message: 'A playbook needs at least one step.' }];
  if (steps.length > 20) errs.push({ index: -1, code: 'too_many_steps', message: 'A playbook is limited to 20 steps.' });
  const known = new Set(PRIMITIVE_REGISTRY.map(p => p.key));
  const postGateAllowed = new Set([
    'guardrail_check', 'connector_action', 'update_record', 'log_activity',
    'instruction', 'decision', 'checklist', 'wait', 'sub_playbook', 'consult_specialist', 'complete',
  ]);
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
    if (s.key === 'consult_specialist') {
      if (!(typeof p.profile_key === 'string' && p.profile_key.trim())) {
        errs.push({ index: i, code: 'bad_params', message: 'Consult specialist needs a profile key (e.g. technical).' });
      }
      if (!(typeof p.question_template === 'string' && p.question_template.trim())) {
        errs.push({ index: i, code: 'bad_params', message: 'Consult specialist needs a question template.' });
      }
    }
    if (s.key === 'instruction') {
      if (!(typeof p.title === 'string' && p.title.trim())) errs.push({ index: i, code: 'bad_params', message: 'This instruction needs a title.' });
      if (!(typeof p.body_md === 'string' && p.body_md.trim())) errs.push({ index: i, code: 'bad_params', message: 'This instruction needs some body text.' });
    }
    if (s.key === 'checklist') {
      const items = Array.isArray(p.items) ? p.items as unknown[] : [];
      if (items.length === 0 || items.some(it => typeof it !== 'string' || !it.trim())) {
        errs.push({ index: i, code: 'bad_params', message: 'A checklist needs at least one non-empty item.' });
      }
    }
    if (s.key === 'wait' && !(typeof p.duration_minutes === 'number' && p.duration_minutes > 0)) {
      errs.push({ index: i, code: 'bad_params', message: 'This wait needs a duration greater than 0 minutes.' });
    }
    if (s.key === 'sub_playbook' && !(typeof p.playbook_id === 'string' && p.playbook_id.trim())) {
      errs.push({ index: i, code: 'bad_params', message: 'Pick which playbook this step should run.' });
    }
    if (s.key === 'decision') validateDecisionClient(s, i, 0, errs);
    if (s.key === 'complete') completeCount++;
  });
  // decision.on must reference an earlier step (client sends "step:<index>[.field]").
  steps.forEach((s, i) => {
    if (s.key !== 'decision') return;
    const on = s.params?.on;
    if (typeof on !== 'string') return;
    const m = /^step:(\d+)/.exec(on);
    if (m && parseInt(m[1], 10) >= i) {
      errs.push({ index: i, code: 'decision_forward_reference', message: `This decision points at step ${parseInt(m[1], 10) + 1}, which runs at or after it — decisions can only look at earlier steps.` });
    }
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
        errs.push({ index: approvalIdx + 1 + off, code: 'post_gate_primitive', message: `"${s.key}" cannot follow Human approval — only guardrail check, connector action, update record, log activity, instruction, decision, checklist, wait, sub-playbook, consult specialist, and complete may run after the gate.` });
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

import { raise, requireTenantId, listTenantRows } from './liveShared';


const notify = () => { try { window.dispatchEvent(new Event('dt-state-changed')); } catch { /* noop */ } };

export async function listDefinitions(): Promise<PlaybookDefinition[]> {
  return listTenantRows<PlaybookDefinition>('playbook_definitions', 'created_at', false, 'listDefinitions');
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

// ============================================================
// R7 — Scheduled & event triggers.
//
// DISPATCH MODE on this deployment (verified): pg_cron + pg_net + Vault
// are all live on the project — a pg_cron job ('playbook-dispatch-5min')
// invokes the dispatcher every 5 minutes, always-on. The app ALSO fires
// an opportunistic dispatch when the Playbooks page loads (backup path,
// scoped server-side to the caller's tenant).
// ============================================================

export const DISPATCH_MODE: 'cron' | 'opportunistic' = 'cron';

export type ScheduleCadence = 'daily' | 'weekly' | 'monthly';
export type EventKey = 'invoice_overdue' | 'ticket_synced_high_priority' | 'account_at_risk';

export interface PlaybookSchedule {
  id: string;
  tenant_id: string;
  definition_id: string;
  cadence: ScheduleCadence;
  run_at_hour: number;
  weekly_day: number | null;
  monthly_day: number | null;
  account_selector: { mode: 'all_eligible' | 'single'; account_id?: string; renewal_within_days?: number };
  active: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
}

export interface PlaybookEventRule {
  id: string;
  tenant_id: string;
  definition_id: string;
  event_key: EventKey;
  params: { overdue_days?: number; priority?: string; min_arr_cents?: number };
  cooldown_hours: number;
  active: boolean;
  last_fired_at: string | null;
  created_at: string;
}

export interface PlaybookTriggerFire {
  id: string;
  tenant_id: string;
  source: 'schedule' | 'event';
  schedule_id: string | null;
  event_rule_id: string | null;
  definition_id: string | null;
  target_account_id: string | null;
  target_ref: string | null;
  run_id: string | null;
  status: 'pending_start' | 'started' | 'skipped_dedup' | 'error';
  detail: string;
  fired_at: string;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const EVENT_META: Record<EventKey, { label: string; description: string }> = {
  invoice_overdue: {
    label: 'Invoice overdue',
    description: 'Fires for each sent invoice past its due date by N days (default 7). Per-invoice cooldown dedup.',
  },
  ticket_synced_high_priority: {
    label: 'High-priority ticket synced',
    description: 'Fires when a high-priority ticket lands from the Zendesk sync. Per-ticket cooldown dedup.',
  },
  account_at_risk: {
    label: 'Account flips to at-risk',
    description: 'Fires when computed health drops an account below the at-risk threshold. Optional minimum ARR filter. Per-account cooldown dedup.',
  },
};

export function describeSchedule(s: PlaybookSchedule): string {
  const hh = `${String(s.run_at_hour).padStart(2, '0')}:00 UTC`;
  if (s.cadence === 'daily') return `daily ${hh}`;
  if (s.cadence === 'weekly') return `${WEEKDAYS[s.weekly_day ?? 1]}s ${hh}`;
  return `monthly day ${s.monthly_day ?? 1} · ${hh}`;
}

export function describeEventRule(r: PlaybookEventRule): string {
  if (r.event_key === 'invoice_overdue') return `on invoice overdue ${r.params.overdue_days ?? 7}+ days`;
  if (r.event_key === 'account_at_risk') {
    const min = r.params.min_arr_cents ?? 0;
    return min > 0 ? `on account at-risk (ARR ≥ $${Math.round(min / 100).toLocaleString()})` : 'on account at-risk';
  }
  return `on ${r.params.priority ?? 'p1'} ticket synced`;
}

// ── Schedules CRUD ────────────────────────────────────────────────

export async function listSchedules(): Promise<PlaybookSchedule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_schedules').select('*').eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listSchedules', error);
  return (data ?? []) as PlaybookSchedule[];
}

export async function createSchedule(input: {
  definition_id: string; cadence: ScheduleCadence; run_at_hour: number;
  weekly_day?: number | null; monthly_day?: number | null;
  account_selector: PlaybookSchedule['account_selector'];
}): Promise<PlaybookSchedule> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('playbook_schedules')
    .insert({
      tenant_id: tid, definition_id: input.definition_id, cadence: input.cadence,
      run_at_hour: input.run_at_hour, weekly_day: input.weekly_day ?? null,
      monthly_day: input.monthly_day ?? null, account_selector: input.account_selector,
      created_by: user?.id ?? null,
    })
    .select().single();
  if (error) raise('createSchedule', error);
  const sched = data as PlaybookSchedule;
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Playbook schedule created — ${describeSchedule(sched)}`,
    detail: { kind: 'playbook_trigger', trigger: 'schedule', schedule_id: sched.id, definition_id: input.definition_id },
  });
  notify();
  return sched;
}

export async function setScheduleActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('playbook_schedules').update({ active }).eq('id', id);
  if (error) raise('setScheduleActive', error);
  notify();
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('playbook_schedules').delete().eq('id', id);
  if (error) raise('deleteSchedule', error);
  notify();
}

// ── Event rules CRUD ──────────────────────────────────────────────

export async function listEventRules(): Promise<PlaybookEventRule[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('playbook_event_rules').select('*').eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listEventRules', error);
  return (data ?? []) as PlaybookEventRule[];
}

export async function createEventRule(input: {
  definition_id: string; event_key: EventKey;
  params: PlaybookEventRule['params']; cooldown_hours: number;
}): Promise<PlaybookEventRule> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('playbook_event_rules')
    .insert({
      tenant_id: tid, definition_id: input.definition_id, event_key: input.event_key,
      params: input.params, cooldown_hours: input.cooldown_hours, created_by: user?.id ?? null,
    })
    .select().single();
  if (error) raise('createEventRule', error);
  const rule = data as PlaybookEventRule;
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Playbook event rule created — ${describeEventRule(rule)} (cooldown ${rule.cooldown_hours}h)`,
    detail: { kind: 'playbook_trigger', trigger: 'event', event_rule_id: rule.id, definition_id: input.definition_id },
  });
  notify();
  return rule;
}

export async function setEventRuleActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('playbook_event_rules').update({ active }).eq('id', id);
  if (error) raise('setEventRuleActive', error);
  notify();
}

export async function deleteEventRule(id: string): Promise<void> {
  const { error } = await supabase.from('playbook_event_rules').delete().eq('id', id);
  if (error) raise('deleteEventRule', error);
  notify();
}

// ── Fires log + opportunistic dispatch ────────────────────────────

export async function listTriggerFires(definitionId?: string): Promise<PlaybookTriggerFire[]> {
  const tid = await requireTenantId();
  let q = supabase.from('playbook_trigger_fires').select('*').eq('tenant_id', tid)
    .order('fired_at', { ascending: false }).limit(50);
  if (definitionId) q = q.eq('definition_id', definitionId);
  const { data, error } = await q;
  if (error) raise('listTriggerFires', error);
  return (data ?? []) as PlaybookTriggerFire[];
}

/**
 * Opportunistic dispatch — the backup path behind the pg_cron primary.
 * Server scopes the evaluation to the caller's tenant. Fire-and-forget:
 * failures are swallowed (cron will catch up within 5 minutes anyway).
 */
export async function dispatchTriggersOpportunistic(): Promise<{ processed: number } | null> {
  try {
    const { data, error } = await supabase.functions.invoke('playbook-execute', {
      body: { action: 'dispatch' },
    });
    if (error) return null;
    const res = data as { processed_fires?: number };
    if ((res?.processed_fires ?? 0) > 0) notify();
    return { processed: res?.processed_fires ?? 0 };
  } catch {
    return null;
  }
}

// ============================================================
// Dry-run preview — executes a draft (or arbitrary steps array) with
// writes/connectors/gates SIMULATED server-side. Nothing persisted:
// no run row, no audit events, no human tasks, no external calls.
// ============================================================

export interface PreviewRunStep {
  key: string; label: string; status: string; at: string | null; detail: string;
  branch_taken?: 'then' | 'else' | null;
  then_steps?: PreviewRunStep[]; else_steps?: PreviewRunStep[];
}
export interface PreviewResult {
  preview: true; status: string; steps: PreviewRunStep[];
  context: Record<string, unknown>; error?: string; errors?: ValidationError[];
}

export async function previewRun(input: { definitionId?: string; steps?: DefinitionStep[]; accountId: string }): Promise<PreviewResult> {
  const { data, error } = await supabase.functions.invoke('playbook-execute', {
    body: {
      action: 'start', preview: true, account_id: input.accountId,
      ...(input.definitionId ? { definition_id: input.definitionId } : { steps: input.steps }),
    },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { return await ctx.json() as PreviewResult; } catch { /* fallthrough */ }
    }
    raise('previewRun', { message: error.message ?? String(error) });
  }
  return data as PreviewResult;
}

// ============================================================
// Playbook step media — uploads to the private 'playbook-media' bucket
// (tenant-folder RLS, same pattern as specialist-media). Used by
// instruction steps to embed images/video right in the step.
// ============================================================

export interface PlaybookMediaAsset {
  id: string; tenant_id: string; definition_id: string | null;
  kind: 'document' | 'image' | 'video'; title: string; storage_path: string;
  mime: string; size_bytes: number; created_at: string;
}

export async function uploadPlaybookMedia(file: File, definitionId: string): Promise<PlaybookMediaAsset> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const path = `${tid}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error: upErr } = await supabase.storage
    .from('playbook-media')
    .upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (upErr) raise('uploadPlaybookMedia (storage)', upErr);

  const kind: 'document' | 'image' | 'video' = file.type.startsWith('image/') ? 'image'
    : file.type.startsWith('video/') ? 'video' : 'document';
  const { data, error } = await supabase
    .from('media_assets')
    .insert({
      tenant_id: tid, definition_id: definitionId, kind,
      title: file.name, storage_path: path, mime: file.type || '', size_bytes: file.size,
      created_by: user?.id ?? null,
    })
    .select().single();
  if (error) raise('uploadPlaybookMedia', error);
  return data as PlaybookMediaAsset;
}

export async function getPlaybookMediaUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('playbook-media').createSignedUrl(storagePath, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Resolve a signed URL from a media_assets.id (what instruction steps
 * store as asset_id) — looks up the storage_path, then signs it. */
export async function getPlaybookMediaUrlByAssetId(assetId: string): Promise<string | null> {
  const { data: asset } = await supabase.from('media_assets').select('storage_path').eq('id', assetId).maybeSingle();
  if (!asset?.storage_path) return null;
  return getPlaybookMediaUrl(asset.storage_path);
}

// ============================================================
// de_playbook_assignments — the DE operating charter: which playbooks
// a DE runs, and in what priority order (lowest number first) when
// several active playbooks match the same trigger.
// ============================================================

export interface DEPlaybookAssignment {
  id: string;
  tenant_id: string;
  de_id: string;
  playbook_id: string;
  priority: number;
  active: boolean;
  created_at: string;
}

export async function listDEPlaybookAssignments(deId?: string): Promise<DEPlaybookAssignment[]> {
  const tid = await requireTenantId();
  let q = supabase.from('de_playbook_charter').select('*').eq('tenant_id', tid).order('priority', { ascending: true });
  if (deId) q = q.eq('de_id', deId);
  const { data, error } = await q;
  if (error) raise('listDEPlaybookAssignments', error);
  return (data ?? []) as DEPlaybookAssignment[];
}

export async function assignPlaybookToDE(deId: string, playbookId: string, priority = 100): Promise<DEPlaybookAssignment> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('de_playbook_charter')
    .insert({ tenant_id: tid, de_id: deId, playbook_id: playbookId, priority, created_by: user?.id ?? null })
    .select().single();
  if (error) raise('assignPlaybookToDE', error);
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change',
    action: `Playbook assigned to DE — priority ${priority}`,
    detail: { kind: 'de_playbook_assignment', de_id: deId, playbook_id: playbookId, priority },
  });
  notify();
  return data as DEPlaybookAssignment;
}

export async function reprioritizeAssignment(id: string, priority: number): Promise<void> {
  const { error } = await supabase.from('de_playbook_charter').update({ priority }).eq('id', id);
  if (error) raise('reprioritizeAssignment', error);
  notify();
}

export async function setAssignmentActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('de_playbook_charter').update({ active }).eq('id', id);
  if (error) raise('setAssignmentActive', error);
  notify();
}

export async function removeAssignment(id: string): Promise<void> {
  const { error } = await supabase.from('de_playbook_charter').delete().eq('id', id);
  if (error) raise('removeAssignment', error);
  notify();
}
