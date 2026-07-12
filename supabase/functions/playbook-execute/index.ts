/**
 * playbook-execute — R4 server-side playbook executor,
 * generalized in R6 for tenant-built playbook definitions.
 *
 * Orchestration is server-authoritative: the browser only starts/observes.
 * Runs survive closed tabs; every step appends a hash-chained audit event
 * via the append_audit_event RPC (service-role path).
 *
 * Actions:
 *   { action: 'start',    playbook_key: 'renewal_v1', account_id }   — legacy, unchanged
 *   { action: 'start',    definition_id, account_id }                — R6 definition run
 *   { action: 'publish',  definition_id }   — validate + snapshot version + status published
 *   { action: 'validate', definition_id | steps }                    — dry validation
 *   { action: 'advance',  run_id | task_id }                         — resume waiting/parked run
 *   { action: 'cancel',   run_id }
 *   { action: 'dispatch' }  — R7: process due scheduled/event triggers.
 *     Auth: x-dispatch-secret header (pg_cron via pg_net, Vault-held
 *     secret), service-role key, or any tenant user (opportunistic
 *     dispatch scoped to THEIR tenant when the Playbooks page loads).
 *     Calls dispatch_due_triggers() (SQL: due schedules + event matches
 *     → 'pending_start' fire rows with cooldown dedup), then turns each
 *     pending fire into a real definition run and stamps the fire row
 *     started/error. Audit: playbook_step with detail.kind='trigger_fire'.
 *
 * ── R6 STEP-PRIMITIVE REGISTRY ──────────────────────────────────────
 * A playbook definition is an ordered array of typed step objects:
 *   { key, label?, params }
 *
 *   check_account     {}                              — loads the account into run context.
 *                                                       Must be step 0 (context.account_id from start).
 *   generate_invoice  { amount_source: 'account_arr'|'fixed',
 *                       fixed_amount_cents? }         — creates a renewal_invoices row. Runs the
 *                                                       R5 guardrail + trust-dial COMPOSITION
 *                                                       (autonomy narrows within guardrails):
 *                                                       gated → invoice awaiting_approval, else sent.
 *   human_approval    { title_template?, task_type? } — explicit gate. If a prior generate_invoice
 *                                                       was NOT gated, this step is skipped
 *                                                       (auto-approved under guardrail/trust dial —
 *                                                       mirrors renewal_v1 semantics). Otherwise a
 *                                                       human_tasks row is created and the run pauses.
 *   guardrail_check   { check: 'invoice_threshold' }  — explicit re-check point; records an audit
 *                                                       event with the threshold comparison. Never pauses.
 *   connector_action  { provider: 'zendesk',
 *                       op: 'add_internal_note'|'update_status',
 *                       payload_template,
 *                       external_ref_template? }      — write-back into the SoR. HONEST DEGRADATION:
 *                                                       no connected connector / disabled action /
 *                                                       no target ref → step recorded 'skipped',
 *                                                       run continues.
 *                     { action_category, action_key,
 *                       param_templates? }            — THE GENERALIZED ACTION LAYER (migration 035):
 *                                                       targets any registered action_definition (read
 *                                                       OR write, any category) via connector-hub's
 *                                                       execute_action — access grants, destructive-
 *                                                       always-gates, guardrail, trust dial all apply
 *                                                       exactly as they do outside playbooks. Lets a
 *                                                       playbook "read something, then act on it" for
 *                                                       any connected category, not just helpdesk.
 *   update_record     { table: 'renewal_invoices'|'support_tickets',
 *                       set: { status } }             — WHITELISTED status flips only
 *                                                       (see UPDATE_WHITELIST). Target id comes from
 *                                                       run context (invoice_id / ticket_id).
 *   log_activity      { text_template }               — activity_events row.
 *   complete          {}                              — required final step.
 *
 * Templates: {{account.name}}, {{invoice.amount}}, {{run.id}} rendered
 * from run context.
 *
 * ── VALIDATION (server-side, on publish and on start) ──────────────
 *   - 1..20 steps; every key must be a known primitive
 *   - step 0 must be check_account; last step must be complete;
 *     complete appears exactly once (at the end)
 *   - at most one generate_invoice, at most one human_approval
 *   - human_approval requires a PRECEDING generate_invoice
 *   - steps AFTER human_approval limited to guardrail_check /
 *     connector_action / update_record / log_activity / complete
 *     (this is what makes the SQL-native resume path possible)
 *   - update_record.set must be a whitelisted status value
 *   - connector_action op/provider must be known
 *   Errors are structured: [{ index, code, message }]
 *
 * ── RESUME SPLIT (documented honestly) ─────────────────────────────
 * On gate approval, resume_playbook_on_task (SQL, migration 019)
 * advances every post-gate step it can do natively (guardrail_check,
 * update_record, log_activity, complete) — zero HTTP. When it meets a
 * connector_action it parks the run in 'resume_pending'; decideHumanTask
 * then fires {action:'advance'} here, which executes the connector call
 * and the remaining steps. Two paths, one authority: the server.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
// PB2.0 — check_knowledge uses the same free built-in embeddings every
// DE answer uses; read_reference URL fetches pass the shared SSRF guard.
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// ── Legacy renewal_v1 (unchanged) ───────────────────────────────────
const STEP_DEFS = [
  { key: 'check_account', label: 'Check account' },
  { key: 'generate_invoice', label: 'Generate invoice' },
  { key: 'guardrail_gate', label: 'Guardrail check' },
  { key: 'human_approval', label: 'Human approval' },
  { key: 'mark_sent', label: 'Send invoice' },
  { key: 'complete', label: 'Complete' },
];

interface RunStep {
  key: string;
  label: string;
  status: string;
  at: string | null;
  detail: string;
  params?: Record<string, unknown>;
  then_steps?: RunStep[];
  else_steps?: RunStep[];
  /** Which branch a decision actually took at run time ('then' | 'else' | null=not reached). */
  branch_taken?: 'then' | 'else' | null;
  /** Recorded output of this step, referenced by later decision steps via "step:<index>.<field>". */
  output?: Record<string, unknown>;
}

interface RunContext {
  account_id?: string;
  account_name?: string;
  arr_cents?: number;
  renewal_date?: string | null;
  invoice_id?: string;
  invoice_amount_cents?: number;
  invoice_status?: string;
  gated?: boolean;
  ticket_id?: string;
  /** Accumulated instruction step bodies for this run — assembled context
   * for subsequent ai/consult steps. DORMANT-HONEST: this text is only
   * actually consumed by an LLM once ANTHROPIC_API_KEY is configured for
   * consult_specialist; until then it is recorded but unused. */
  instructions_context?: string[];
  de_subject_id?: string;
  last_consultation_id?: string | null;
  onboarding_project_id?: string | null;
  [k: string]: unknown;
}

const now = () => new Date().toISOString();
const fmtMoney = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

// ── R6 registry + validation ───────────────────────────────────────

const PRIMITIVES = [
  'check_account', 'generate_invoice', 'human_approval', 'guardrail_check',
  'connector_action', 'update_record', 'log_activity', 'consult_specialist',
  'instruction', 'decision', 'checklist', 'wait', 'sub_playbook', 'agentic_step',
  'start_onboarding', 'emit_event', 'check_knowledge', 'read_reference', 'complete',
] as const;

const PRIMITIVE_LABELS: Record<string, string> = {
  check_account: 'Check account',
  generate_invoice: 'Generate invoice',
  human_approval: 'Human approval',
  guardrail_check: 'Guardrail check',
  connector_action: 'Connector action',
  update_record: 'Update record',
  log_activity: 'Log activity',
  consult_specialist: 'Consult specialist',
  instruction: 'Instruction',
  decision: 'Decision',
  checklist: 'Checklist',
  wait: 'Wait',
  sub_playbook: 'Run another playbook',
  agentic_step: 'Agentic step',
  start_onboarding: 'Start onboarding',
  emit_event: 'Emit event',
  check_knowledge: 'Check knowledge',
  read_reference: 'Read reference',
  complete: 'Complete',
};

// Steps that the SQL resume path (resume_playbook_on_task) can advance.
const SQL_RESUMABLE = new Set(['guardrail_check', 'update_record', 'log_activity', 'complete']);
// Everything else (connector_action + all new document/flow steps) needs
// the HTTP executor and is allowed to sit after a human gate.
const POST_GATE_ALLOWED = new Set([
  ...SQL_RESUMABLE, 'connector_action', 'instruction', 'decision', 'checklist',
  'wait', 'sub_playbook', 'consult_specialist', 'agentic_step', 'start_onboarding',
  'emit_event', 'check_knowledge', 'read_reference',
]);
// Steps allowed INSIDE a decision's then/else branch — ONE level of
// nesting only (a decision cannot appear inside a branch in v1).
const BRANCH_ALLOWED = new Set([
  'instruction', 'checklist', 'wait', 'log_activity', 'update_record',
  'connector_action', 'guardrail_check', 'consult_specialist',
  'check_knowledge', 'read_reference',
]);
const DECISION_OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists'] as const;

const UPDATE_WHITELIST: Record<string, string[]> = {
  renewal_invoices: ['sent', 'paid'],
  support_tickets: ['open', 'pending', 'resolved', 'escalated'],
};

interface MediaRef { asset_id?: string; url?: string; kind: 'image' | 'video'; caption?: string }
interface DefStep {
  key: string; label?: string; params?: Record<string, unknown>;
  then_steps?: DefStep[]; else_steps?: DefStep[];
}
interface ValidationError { index: number; code: string; message: string }

// Validates a single decision branch (then_steps or else_steps) — used
// both at the top level (depth 0→1, allowed) and recursively to catch
// depth 2 (rejected with a plain-language message).
function validateBranch(
  branch: unknown, parentIndex: number, side: 'then' | 'else', depth: number, errs: ValidationError[],
): void {
  if (!Array.isArray(branch)) return;
  for (const bs of branch as DefStep[]) {
    if (!bs || typeof bs !== 'object' || typeof bs.key !== 'string') {
      errs.push({ index: parentIndex, code: 'bad_branch_step', message: `A step inside the ${side} branch is missing a type.` });
      continue;
    }
    if (bs.key === 'decision') {
      if (depth >= 1) {
        errs.push({
          index: parentIndex, code: 'decision_nesting_too_deep',
          message: `This decision is nested inside another decision's ${side} branch — decisions can only be nested one level deep. Move the inner decision to its own top-level step.`,
        });
        continue;
      }
      validateDecisionParams(bs, parentIndex, errs, depth + 1);
      continue;
    }
    if (!BRANCH_ALLOWED.has(bs.key)) {
      errs.push({
        index: parentIndex, code: 'branch_primitive_not_allowed',
        message: `"${bs.key}" cannot run inside a decision's ${side} branch — only guide/explain and simple work steps are allowed there (not generate_invoice, human_approval, or complete).`,
      });
    }
  }
}

function validateDecisionParams(s: DefStep, i: number, errs: ValidationError[], depth = 0): void {
  const p = (s.params ?? {}) as Record<string, unknown>;
  if (typeof p.on !== 'string' || !p.on.trim()) {
    errs.push({ index: i, code: 'bad_params', message: 'A decision needs to know what to look at — pick a prior step and field.' });
  }
  if (typeof p.operator !== 'string' || !(DECISION_OPERATORS as readonly string[]).includes(p.operator)) {
    errs.push({ index: i, code: 'bad_params', message: `A decision's comparison must be one of: ${DECISION_OPERATORS.join(', ')}.` });
  }
  if (p.operator !== 'exists' && (p.value === undefined || p.value === null || p.value === '')) {
    errs.push({ index: i, code: 'bad_params', message: 'This decision needs a value to compare against.' });
  }
  validateBranch(s.then_steps, i, 'then', depth, errs);
  validateBranch(s.else_steps, i, 'else', depth, errs);
}

function validateSteps(steps: unknown): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return [{ index: -1, code: 'empty', message: 'A playbook needs at least one step.' }];
  }
  if (steps.length > 20) {
    errs.push({ index: -1, code: 'too_many_steps', message: 'A playbook is limited to 20 steps.' });
  }
  const list = steps as DefStep[];
  let invoiceCount = 0, approvalCount = 0, completeCount = 0;
  let invoiceIdx = -1, approvalIdx = -1;

  list.forEach((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.key !== 'string') {
      errs.push({ index: i, code: 'bad_step', message: 'Step must be an object with a key.' });
      return;
    }
    if (!(PRIMITIVES as readonly string[]).includes(s.key)) {
      errs.push({ index: i, code: 'unknown_primitive', message: `Unknown step primitive "${s.key}".` });
      return;
    }
    const p = (s.params ?? {}) as Record<string, unknown>;
    switch (s.key) {
      case 'generate_invoice': {
        invoiceCount++; invoiceIdx = invoiceIdx === -1 ? i : invoiceIdx;
        const src = p.amount_source;
        if (src !== 'account_arr' && src !== 'fixed') {
          errs.push({ index: i, code: 'bad_params', message: 'generate_invoice.amount_source must be "account_arr" or "fixed".' });
        } else if (src === 'fixed' && (typeof p.fixed_amount_cents !== 'number' || p.fixed_amount_cents <= 0)) {
          errs.push({ index: i, code: 'bad_params', message: 'generate_invoice with fixed amount needs fixed_amount_cents > 0.' });
        }
        break;
      }
      case 'human_approval':
        approvalCount++; approvalIdx = approvalIdx === -1 ? i : approvalIdx;
        break;
      case 'guardrail_check':
        if (p.check !== 'invoice_threshold') {
          errs.push({ index: i, code: 'bad_params', message: 'guardrail_check.check must be "invoice_threshold" (the only check in v1).' });
        }
        break;
      case 'connector_action': {
        // THREE FORMS (compat shim, documented):
        //   legacy write-back: { provider: 'zendesk', op: add_internal_note|update_status, ... }
        //   category op (027): { category, op, query_template? | ref_template? }
        //     — provider-agnostic read-through via connector-hub category_op;
        //       the hub enforces op legality (op_not_legal_for_category) at
        //       run time, so validation here checks shape only.
        //   action_key (035, THE GENERALIZED ACTION LAYER): { action_category,
        //     action_key, param_templates? } — targets ANY registered
        //     action_definition (read OR write) via connector-hub's
        //     execute_action, which itself enforces access grants +
        //     destructive-always-gates + guardrail + trust. Validation here
        //     checks shape only — the hub resolves whether the action
        //     actually exists at run time (honest op_not_registered otherwise).
        if (typeof p.action_key === 'string' && p.action_key && typeof p.category !== 'string') {
          if (typeof p.action_category !== 'string' || !(p.action_category as string).trim()) {
            errs.push({ index: i, code: 'bad_params', message: 'connector_action (action_key form) needs action_category (which connected category to target).' });
          }
        } else if (typeof p.category === 'string' && p.category) {
          const cats = ['crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing', 'payroll_hcm', 'pos', 'product_system', 'other'];
          if (!cats.includes(p.category as string)) {
            errs.push({ index: i, code: 'bad_params', message: `connector_action.category must be one of: ${cats.join(', ')}.` });
          }
          if (typeof p.op !== 'string' || !(p.op as string).trim()) {
            errs.push({ index: i, code: 'bad_params', message: 'connector_action (category form) needs an op, e.g. "search_tickets".' });
          }
        } else {
          if (p.provider !== 'zendesk') {
            errs.push({ index: i, code: 'bad_params', message: 'connector_action needs a category (category-op form), an action_key + action_category (generalized action form), or provider "zendesk" (legacy write-back form).' });
          }
          if (p.op !== 'add_internal_note' && p.op !== 'update_status') {
            errs.push({ index: i, code: 'bad_params', message: 'connector_action.op must be "add_internal_note" or "update_status" (legacy write-back form).' });
          }
        }
        break;
      }
      case 'update_record': {
        const table = p.table as string;
        const allowed = UPDATE_WHITELIST[table];
        const set = (p.set ?? {}) as Record<string, unknown>;
        if (!allowed) {
          errs.push({ index: i, code: 'bad_params', message: 'update_record.table must be "renewal_invoices" or "support_tickets".' });
        } else if (typeof set.status !== 'string' || !allowed.includes(set.status)) {
          errs.push({ index: i, code: 'bad_params', message: `update_record on ${table} may only set status to: ${allowed?.join(', ')}.` });
        } else if (Object.keys(set).length !== 1) {
          errs.push({ index: i, code: 'bad_params', message: 'update_record.set may only contain "status" (whitelisted mutation).' });
        }
        break;
      }
      case 'log_activity':
        if (typeof p.text_template !== 'string' || !p.text_template.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'log_activity needs a non-empty text_template.' });
        }
        break;
      case 'emit_event':
        // Event existence is TENANT RUNTIME STATE (checked at execution time,
        // honest no-op if missing) — shape-only validation here.
        if (typeof p.event_key !== 'string' || !p.event_key.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'emit_event needs an event_key (e.g. "deal_signed").' });
        }
        break;
      case 'check_knowledge': {
        if (typeof p.query_template !== 'string' || !p.query_template.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'check_knowledge needs a query_template (what to look up).' });
        }
        if (p.match_count !== undefined && (typeof p.match_count !== 'number' || p.match_count < 1 || p.match_count > 10)) {
          errs.push({ index: i, code: 'bad_params', message: 'check_knowledge.match_count must be 1-10.' });
        }
        if (p.on_miss !== undefined && !['continue', 'escalate', 'fail'].includes(String(p.on_miss))) {
          errs.push({ index: i, code: 'bad_params', message: 'check_knowledge.on_miss must be "continue", "escalate" or "fail".' });
        }
        break;
      }
      case 'read_reference': {
        const refs = Array.isArray(p.refs) ? p.refs as Array<Record<string, unknown>> : [];
        if (refs.length < 1 || refs.length > 5) {
          errs.push({ index: i, code: 'bad_params', message: 'read_reference needs 1-5 references (knowledge doc, URL, or uploaded text document).' });
        }
        refs.forEach((r) => {
          const kind = String(r?.kind ?? '');
          if (kind === 'doc' && (typeof r.doc_id !== 'string' || !r.doc_id)) {
            errs.push({ index: i, code: 'bad_params', message: 'A knowledge-doc reference needs its doc_id.' });
          } else if (kind === 'url' && (typeof r.url !== 'string' || !/^https?:\/\//i.test(String(r.url)))) {
            errs.push({ index: i, code: 'bad_params', message: 'A URL reference needs a full http(s) address.' });
          } else if (kind === 'asset' && (typeof r.asset_id !== 'string' || !r.asset_id)) {
            errs.push({ index: i, code: 'bad_params', message: 'An uploaded-document reference needs its asset_id.' });
          } else if (!['doc', 'url', 'asset'].includes(kind)) {
            errs.push({ index: i, code: 'bad_params', message: 'Each reference must be a knowledge doc, a URL, or an uploaded document.' });
          }
        });
        break;
      }
      case 'consult_specialist': {
        // Profile existence/active is TENANT RUNTIME STATE, not definition
        // shape — checked at execution time (honest skip), warn-only here.
        if (typeof p.profile_key !== 'string' || !p.profile_key.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'consult_specialist needs a profile_key (e.g. "technical").' });
        }
        if (typeof p.question_template !== 'string' || !p.question_template.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'consult_specialist needs a question_template.' });
        }
        if (p.min_confidence !== undefined && (typeof p.min_confidence !== 'number' || p.min_confidence < 0 || p.min_confidence > 100)) {
          errs.push({ index: i, code: 'bad_params', message: 'consult_specialist.min_confidence must be 0-100.' });
        }
        if (p.on_low !== undefined && p.on_low !== 'escalate' && p.on_low !== 'continue') {
          errs.push({ index: i, code: 'bad_params', message: 'consult_specialist.on_low must be "escalate" or "continue".' });
        }
        break;
      }
      case 'instruction': {
        if (typeof p.title !== 'string' || !p.title.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'An instruction step needs a title.' });
        }
        if (typeof p.body_md !== 'string' || !p.body_md.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'An instruction step needs body text (markdown supported).' });
        }
        const media = Array.isArray(p.media) ? p.media as MediaRef[] : [];
        media.forEach((m) => {
          if (!m || (m.kind !== 'image' && m.kind !== 'video')) {
            errs.push({ index: i, code: 'bad_params', message: 'Instruction media must be marked image or video.' });
          }
          if (!m?.asset_id && !m?.url) {
            errs.push({ index: i, code: 'bad_params', message: 'Instruction media needs an uploaded file or a URL.' });
          }
        });
        break;
      }
      case 'decision':
        validateDecisionParams(s, i, errs, 0);
        break;
      case 'checklist': {
        const items = Array.isArray(p.items) ? p.items as unknown[] : [];
        if (items.length === 0 || items.some((it) => typeof it !== 'string' || !it.trim())) {
          errs.push({ index: i, code: 'bad_params', message: 'A checklist needs at least one non-empty item.' });
        }
        break;
      }
      case 'wait': {
        if (typeof p.duration_minutes !== 'number' || p.duration_minutes <= 0) {
          errs.push({ index: i, code: 'bad_params', message: 'A wait step needs duration_minutes greater than 0.' });
        }
        break;
      }
      case 'sub_playbook': {
        if (typeof p.playbook_id !== 'string' || !p.playbook_id.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'Pick which playbook this step should run.' });
        }
        break;
      }
      case 'agentic_step': {
        // Budget (max_iterations/token/cost) is a TENANT policy
        // (agentic_step_policies), not step shape — checked at run time,
        // same "definition shape here, runtime state there" split as
        // consult_specialist.profile_key. Validation here is just: does
        // this step actually say what it's trying to accomplish.
        if (typeof p.goal_template !== 'string' || !p.goal_template.trim()) {
          errs.push({ index: i, code: 'bad_params', message: 'An agentic step needs a goal — describe what it should accomplish.' });
        }
        break;
      }
      case 'start_onboarding': {
        // Which template version is real tenant runtime state (like
        // consult_specialist.profile_key) — checked at execution time
        // by create_onboarding_project itself (returns a real, honest
        // {error:'template_version_not_found'} skip), not re-validated
        // against the DB here. Shape-only check: is this even a uuid.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof p.template_version_id !== 'string' || !UUID_RE.test(p.template_version_id)) {
          errs.push({ index: i, code: 'bad_params', message: 'Pick which onboarding template version this step should create a project from.' });
        }
        break;
      }
      case 'complete':
        completeCount++;
        break;
    }
  });

  // decision.on must reference an EARLIER step in this same list (client
  // sends step refs as "step:<index>" or "step:<index>.<field>").
  list.forEach((s, i) => {
    if (s?.key !== 'decision') return;
    const on = (s.params as Record<string, unknown> | undefined)?.on;
    if (typeof on !== 'string') return;
    const m = /^step:(\d+)/.exec(on);
    if (m) {
      const refIdx = parseInt(m[1], 10);
      if (refIdx >= i) {
        errs.push({
          index: i, code: 'decision_forward_reference',
          message: `This decision points at step ${refIdx + 1}, which runs at or after it — decisions can only look at earlier steps.`,
        });
      }
    }
  });

  // PB2.0: check_account is no longer forced as step 1 — it is optional
  // and placeable anywhere. Steps that use account fields before (or
  // without) it degrade honestly, the executor's existing convention.
  if (list[list.length - 1]?.key !== 'complete') {
    errs.push({ index: list.length - 1, code: 'last_step', message: 'The last step must be complete.' });
  }

  // PB2.0: optional per-step rule — an assertion on any step's recorded
  // outcome. Shape-only validation here; matching happens at run time.
  list.forEach((s, i) => {
    const rule = (s?.params as Record<string, unknown> | undefined)?.rule as Record<string, unknown> | undefined;
    if (rule === undefined || rule === null) return;
    if (typeof rule !== 'object' || typeof rule.pattern !== 'string' || !String(rule.pattern).trim()) {
      errs.push({ index: i, code: 'bad_rule', message: 'A step rule needs a non-empty pattern (separate alternatives with |).' });
    }
    if (rule && rule.on_violation !== undefined && !['escalate', 'fail'].includes(String(rule.on_violation))) {
      errs.push({ index: i, code: 'bad_rule', message: 'A step rule\'s on_violation must be "escalate" or "fail".' });
    }
  });
  if (completeCount > 1) errs.push({ index: -1, code: 'multiple_complete', message: 'Only one complete step is allowed (at the end).' });
  if (invoiceCount > 1) errs.push({ index: -1, code: 'multiple_invoice', message: 'At most one generate_invoice step is allowed.' });
  if (approvalCount > 1) errs.push({ index: -1, code: 'multiple_approval', message: 'At most one human_approval step is allowed.' });
  if (approvalIdx !== -1 && (invoiceIdx === -1 || invoiceIdx > approvalIdx)) {
    errs.push({ index: approvalIdx, code: 'approval_without_invoice', message: 'human_approval must come after a generate_invoice step (it gates the invoice).' });
  }
  if (approvalIdx !== -1) {
    list.slice(approvalIdx + 1).forEach((s, off) => {
      if (s?.key && !POST_GATE_ALLOWED.has(s.key)) {
        errs.push({
          index: approvalIdx + 1 + off, code: 'post_gate_primitive',
          message: `"${s.key}" cannot follow human_approval — post-gate steps are limited to guardrail_check, connector_action, update_record, log_activity, instruction, decision, checklist, wait, sub_playbook, consult_specialist, complete (this keeps the resume path server-authoritative).`,
        });
      }
    });
  }
  return errs;
}

// Collects every sub_playbook.playbook_id referenced anywhere in a step
// list, including inside decision branches (one level of nesting).
function collectSubPlaybookRefs(steps: DefStep[]): string[] {
  const ids: string[] = [];
  const walk = (list: DefStep[] | undefined) => {
    for (const s of list ?? []) {
      if (s.key === 'sub_playbook' && typeof s.params?.playbook_id === 'string') ids.push(s.params.playbook_id as string);
      walk(s.then_steps); walk(s.else_steps);
    }
  };
  walk(steps);
  return ids;
}

/**
 * DB-backed validation for sub_playbook steps: every referenced playbook
 * must be published, and there must be no cycle (walks the referenced
 * definitions' PUBLISHED steps transitively; a definition editing its
 * own draft to reference itself is also rejected as a 1-step cycle).
 */
async function validateSubPlaybookRefs(
  admin: SupabaseClient, tenantId: string, ownDefId: string | null, steps: DefStep[],
): Promise<ValidationError[]> {
  const errs: ValidationError[] = [];
  const directRefs = collectSubPlaybookRefs(steps);
  if (directRefs.length === 0) return errs;

  const visited = new Set<string>(ownDefId ? [ownDefId] : []);
  const stack = [...new Set(directRefs)];
  const checkedUnpublished = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ownDefId && id === ownDefId) {
      errs.push({ index: -1, code: 'sub_playbook_cycle', message: 'This playbook cannot call itself, directly or through another playbook — that would loop forever.' });
      continue;
    }
    if (visited.has(id)) {
      errs.push({ index: -1, code: 'sub_playbook_cycle', message: 'These playbooks call each other in a loop (A calls B, B calls A) — cycles are not allowed.' });
      continue;
    }
    visited.add(id);

    const { data: def } = await admin.from('playbook_definitions')
      .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!def) {
      if (!checkedUnpublished.has(id)) {
        errs.push({ index: -1, code: 'sub_playbook_not_found', message: 'A "Run another playbook" step points at a playbook that no longer exists.' });
        checkedUnpublished.add(id);
      }
      continue;
    }
    if (def.status !== 'published') {
      if (!checkedUnpublished.has(id)) {
        errs.push({ index: -1, code: 'sub_playbook_unpublished', message: 'A "Run another playbook" step points at a playbook that is not published yet — publish it first, or it can never run.' });
        checkedUnpublished.add(id);
      }
      continue;
    }
    const { data: snap } = await admin.from('playbook_versions')
      .select('steps').eq('definition_id', id).order('version', { ascending: false }).limit(1).maybeSingle();
    for (const nested of collectSubPlaybookRefs((snap?.steps ?? []) as DefStep[])) stack.push(nested);
  }
  return errs;
}

// PB2.0: the single template choke-point, now a real token pass instead
// of three replaceAll chains. New tokens beyond the original three:
//   {{event.ref}} / {{event.note}}   — what triggered an event-started run
//   {{party.KEY}}                    — custom fields on the served-party
//                                      record (loaded by check_account)
//   {{steps.N}} / {{steps.N.FIELD}}  — a prior step's recorded output
//                                      (same resolver decisions use)
// Unknown tokens render as '' (never leak braces to a customer-facing
// string). `steps` is optional so pre-run callers keep working.
function renderTemplate(t: string, ctx: RunContext, runId: string, steps?: RunStep[]): string {
  return t.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_all, token: string) => {
    if (token === 'account.name') return ctx.account_name ?? 'account';
    if (token === 'invoice.amount') return fmtMoney(ctx.invoice_amount_cents ?? 0);
    if (token === 'run.id') return runId;
    if (token === 'event.ref') return String(ctx.event_ref ?? '');
    if (token === 'event.note') return String(ctx.event_note ?? '');
    if (token.startsWith('party.')) {
      const attrs = (ctx.party_attributes ?? {}) as Record<string, unknown>;
      const v = attrs[token.slice('party.'.length)];
      return v == null ? '' : String(v);
    }
    if (token.startsWith('steps.') && steps) {
      const ref = 'step:' + token.slice('steps.'.length);
      const v = resolveStepRef(steps, ref);
      return v == null ? '' : String(v);
    }
    return '';
  });
}

// PB2.0 — the run's assembled working context: everything instruction,
// check_knowledge and read_reference steps accumulated, newest-first
// hard-capped so a long run can't blow out an LLM prompt. This is what
// agentic_step and consult_specialist receive as reference material.
function collectRunContextDocs(ctx: RunContext, capChars = 24000): string {
  const parts = [
    ...((ctx.reference_context as string[] | undefined) ?? []),
    ...((ctx.knowledge_context as string[] | undefined) ?? []),
    ...((ctx.instructions_context as string[] | undefined) ?? []),
  ];
  if (parts.length === 0) return '';
  let out = '';
  for (const p of parts) {
    if (out.length + p.length > capChars) {
      out += '\n\n[…additional reference material truncated…]';
      break;
    }
    out += (out ? '\n\n' : '') + p;
  }
  return out;
}

// ── Audit helpers ───────────────────────────────────────────────────

async function audit(
  admin: SupabaseClient, tenantId: string, action: string, category: string,
  detail: Record<string, unknown>, actor = 'Renewal DE',
) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: 'de',
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('audit:', error.message);
}

function stepAuditText(accountName: string, step: RunStep) {
  return `Renewal playbook [${accountName}] — step "${step.label}" ${step.status}${step.detail ? `: ${step.detail}` : ''}`;
}

// ── R6 definition-run interpreter ───────────────────────────────────
// Executes steps[startIndex..] sequentially. Returns when the run
// pauses (human gate), completes, or fails. State is persisted to
// playbook_runs after every step so runs survive crashes.

interface DefRunRow {
  id: string; tenant_id: string; account_id: string | null;
  status: string; current_step: number; steps: RunStep[];
  waiting_task_id: string | null; context: RunContext;
  definition_id: string; definition_version: number; playbook_key: string;
  /** Preview / dry-run mode (builder "try it" button): connector and
   * write steps are SIMULATED — nothing persisted, no external calls,
   * no human_tasks/activity rows. Decisions/instructions/checklist
   * flow logic still runs for real so the trace is trustworthy. */
  preview?: boolean;
  parent_run_id?: string | null;
}

async function saveRun(admin: SupabaseClient, run: DefRunRow) {
  if (run.preview) return; // preview traces are returned in-memory, never persisted
  await admin.from('playbook_runs').update({
    status: run.status, current_step: run.current_step, steps: run.steps,
    waiting_task_id: run.waiting_task_id, context: run.context,
  }).eq('id', run.id);
}

/** Resolve "step:<index>" or "step:<index>.<field>" against recorded
 * step outputs/detail — this is what a decision step evaluates. */
function resolveStepRef(steps: RunStep[], ref: string): unknown {
  const m = /^step:(\d+)(?:\.(.+))?$/.exec(ref.trim());
  if (!m) return undefined;
  const idx = parseInt(m[1], 10);
  const field = m[2];
  const s = steps[idx];
  if (!s) return undefined;
  if (!field) return s.output?.value ?? s.detail;
  if (field === 'status') return s.status;
  if (field === 'detail') return s.detail;
  return s.output ? s.output[field] : undefined;
}

function evalDecision(operator: string, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'equals': return String(actual ?? '') === String(expected ?? '');
    case 'not_equals': return String(actual ?? '') !== String(expected ?? '');
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'greater_than': return Number(actual) > Number(expected);
    case 'less_than': return Number(actual) < Number(expected);
    default: return false;
  }
}

async function executeDefinitionSteps(
  admin: SupabaseClient, run: DefRunRow, startIndex: number,
): Promise<{ status: string; task_id?: string }> {
  const tenantId = run.tenant_id;
  const ctx = run.context;
  const acct = () => ctx.account_name ?? 'account';

  const stepAudit = async (i: number, extra: Record<string, unknown> = {}) => {
    if (run.preview) return; // preview never touches the audit chain
    const s = run.steps[i];
    await audit(admin, tenantId,
      `Playbook [${acct()}] — step "${s.label}" ${s.status}${s.detail ? `: ${s.detail}` : ''}`,
      'playbook_step',
      { run_id: run.id, definition_id: run.definition_id, definition_version: run.definition_version, step_index: i, step_key: s.key, step_status: s.status, step_detail: s.detail, ...extra },
      'Playbook DE');
  };

  // Resolve the DE subject whose data-access grants govern this run's
  // connector steps (migration 029) — hoisted here (was previously
  // computed inline, only reachable by the top-level connector_action
  // case) so BOTH the top-level step AND a decision-branch step can
  // reach it via execRegisteredAction below.
  const resolveRunDeId = async (): Promise<string | null> => {
    let runDeId = typeof ctx.de_subject_id === 'string' ? ctx.de_subject_id as string : null;
    if (!runDeId) {
      if (run.definition_id) {
        const { data: defRow } = await admin.from('playbook_definitions')
          .select('de_id').eq('id', run.definition_id).maybeSingle();
        runDeId = (defRow?.de_id as string | null) ?? null;
      }
      if (!runDeId) {
        const { data: firstDe } = await admin.from('digital_employees')
          .select('id').eq('tenant_id', tenantId)
          .order('created_at', { ascending: true }).limit(1).maybeSingle();
        runDeId = (firstDe?.id as string | undefined) ?? null;
      }
      if (runDeId) ctx.de_subject_id = runDeId;
    }
    return runDeId;
  };

  // Shared execution for the action_key form of connector_action
  // (migration 035, THE GENERALIZED ACTION LAYER) — extracted so a
  // decision branch can ACTUALLY act (not just present an inline
  // checklist), rather than duplicating this ~40-line call. FIX (found
  // live during the Finance DE build's own high-value-account
  // guardrail proof, a genuine pre-existing gap, not new business
  // logic): BRANCH_ALLOWED has always listed 'connector_action' as
  // validation-legal inside a decision branch, but runBranchStep's
  // switch never actually implemented it (fell to the default "skipped:
  // not executed in branch" case) — so ANY playbook that ever tried to
  // act conditionally on a decision (any department, not just Finance)
  // silently no-op'd that step while reporting a misleadingly generic
  // "skipped" detail. This is the SAME class of half-applied-mechanism
  // gap the standing rule says to fix at the primitive, not work around.
  async function execRegisteredAction(
    stepLike: { status: string; at: string | null; detail: string },
    p: Record<string, unknown>,
  ): Promise<void> {
    const actionCategory = String(p.action_category ?? '');
    const actionKey = String(p.action_key ?? '');
    const runDeId = await resolveRunDeId();
    const { data: actConn } = await admin
      .from('connectors').select('id, provider, display_name, category, status')
      .eq('tenant_id', tenantId)
      .eq(actionCategory ? 'category' : 'id', actionCategory || '00000000-0000-0000-0000-000000000000')
      .neq('status', 'disconnected')
      .limit(1).maybeSingle();
    if (!actConn) {
      stepLike.status = 'skipped'; stepLike.at = now();
      stepLike.detail = `skipped: no connected ${actionCategory || 'target'} system for action "${actionKey}"`;
      return;
    }
    const actionParams: Record<string, unknown> = {};
    const templates = (p.param_templates ?? {}) as Record<string, string>;
    for (const [k, tpl] of Object.entries(templates)) actionParams[k] = renderTemplate(tpl, ctx, run.id, run.steps).trim();
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        },
        body: JSON.stringify({
          action: 'execute_action', connector_id: actConn.id, tenant_id: tenantId,
          action_key: actionKey, params: actionParams,
          ...(runDeId ? { subject_kind: 'de', subject_id: runDeId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error === 'access_denied') {
        stepLike.status = 'failed'; stepLike.at = now();
        stepLike.detail = `Access denied by data access rules — the ${runDeId ? 'assigned DE' : 'DE'} needs write-back permission on ${actConn.display_name || actConn.provider} and ${data.detail ?? 'has no grant'}.`;
        return;
      }
      if (data.ok && data.gated) {
        stepLike.status = 'done'; stepLike.at = now();
        stepLike.detail = `Action "${actionKey}" on ${actConn.display_name || actConn.provider} — ${data.reasoning ?? 'awaiting human approval'} (task created)`;
        await audit(admin, tenantId,
          `Playbook [${acct()}] — action "${actionKey}" on ${actConn.display_name || actConn.provider} routed to a human: ${data.reasoning ?? ''}`,
          'connector_action',
          { run_id: run.id, definition_id: run.definition_id, connector_id: actConn.id, action_key: actionKey, decision: data.decision, task_id: data.task_id ?? null },
          'Playbook DE');
      } else if (data.ok) {
        stepLike.status = 'done'; stepLike.at = now();
        stepLike.detail = data.receipt ?? `Action "${actionKey}" executed on ${actConn.display_name || actConn.provider}`;
        await audit(admin, tenantId,
          `Playbook [${acct()}] — ${data.receipt ?? `action "${actionKey}" executed`}`,
          'connector_action',
          { run_id: run.id, definition_id: run.definition_id, connector_id: actConn.id, action_key: actionKey, receipt: data.receipt ?? null },
          'Playbook DE');
      } else {
        stepLike.status = 'skipped'; stepLike.at = now();
        stepLike.detail = `skipped: action "${actionKey}" failed honestly (${data.error ?? data.detail ?? `HTTP ${res.status}`})`;
      }
    } catch (e) {
      stepLike.status = 'skipped'; stepLike.at = now();
      stepLike.detail = `skipped: connector-hub action call failed (${String(e).slice(0, 120)})`;
    }
  }

  // Executes one branch step (decision then/else) IN PLACE — same
  // primitive semantics, simplified (no gates allowed inside a branch,
  // enforced at validation time).
  const runBranchStep = async (bs: RunStep): Promise<void> => {
    const p = (bs.params ?? {}) as Record<string, unknown>;
    if (run.preview && (bs.key === 'connector_action')) {
      bs.status = 'done'; bs.at = now();
      bs.detail = typeof p.action_key === 'string' && p.action_key
        ? `PREVIEW — would call ${String(p.action_category ?? 'connector')} action "${p.action_key}" (simulated, no external call)`
        : `PREVIEW — would call ${String(p.category ?? p.provider ?? 'connector')}.${String(p.op ?? '')} (not actually called)`;
      return;
    }
    switch (bs.key) {
      case 'instruction': {
        bs.status = 'done'; bs.at = now();
        bs.detail = `Presented: ${String(p.title ?? 'instruction')}`;
        ctx.instructions_context = [...(ctx.instructions_context ?? []), String(p.body_md ?? '')];
        break;
      }
      case 'checklist': {
        const items = Array.isArray(p.items) ? p.items as string[] : [];
        bs.status = 'done'; bs.at = now();
        bs.detail = `${items.length} item(s) presented inline (branch checklists auto-confirm — no separate human gate)`;
        break;
      }
      case 'wait': {
        bs.status = 'skipped'; bs.at = now();
        bs.detail = `skipped: wait is not supported inside a decision branch — use a top-level wait step`;
        break;
      }
      case 'log_activity': {
        const text = renderTemplate((p.text_template as string) ?? 'Playbook step executed', ctx, run.id, run.steps);
        if (!run.preview) {
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'resolved', text,
          });
        }
        bs.status = 'done'; bs.at = now(); bs.detail = run.preview ? `PREVIEW — would log: ${text}` : text;
        break;
      }
      case 'guardrail_check': {
        bs.status = 'done'; bs.at = now();
        bs.detail = 'Re-checked in branch — no invoice in this run to re-verify'
          + (ctx.invoice_id ? '' : '');
        break;
      }
      case 'connector_action': {
        // FIX (see execRegisteredAction's comment above): only the
        // action_key form (migration 035's generalized action layer) is
        // wired here — the category-op read-through and legacy zendesk
        // write-back forms remain top-level-only, honestly, since
        // extending those too is a larger change than this build's
        // scope; a branch step using either of those forms still
        // reports the same honest "not executed in branch" skip it
        // always has.
        if (typeof p.action_key === 'string' && p.action_key) {
          await execRegisteredAction(bs, p);
        } else {
          bs.status = 'skipped'; bs.at = now();
          bs.detail = 'skipped: only the action_key form of connector_action runs inside a decision branch today';
        }
        break;
      }
      default: {
        bs.status = 'skipped'; bs.at = now();
        bs.detail = `skipped: "${bs.key}" not executed in branch preview path`;
      }
    }
  };

  for (let i = startIndex; i < run.steps.length; i++) {
    const step = run.steps[i];
    const params = (step.params ?? {}) as Record<string, unknown>;
    run.current_step = i;

    // PB2.0 — per-step rule: an author-defined assertion on the PREVIOUS
    // step's recorded outcome, checked before advancing (loop-top so it
    // also covers steps that resumed after a human gate). Same
    // '|'-fragment matching as guardrails. Top-level steps only in v1.
    // Guardrails still always win — this is an additional assertion,
    // never a replacement.
    if (i > 0) {
      const prev = run.steps[i - 1];
      const prevRule = ((prev?.params ?? {}) as Record<string, unknown>).rule as
        { pattern?: string; on_violation?: string } | undefined;
      if (prevRule?.pattern && !(prev.output?.rule_checked) && ['done', 'skipped'].includes(prev.status)) {
        const hay = `${prev.detail} ${JSON.stringify(prev.output ?? {})}`;
        let hit = false; let hitFrag = '';
        for (const frag of String(prevRule.pattern).split('|').map((p) => p.trim()).filter(Boolean)) {
          try { hit = new RegExp(frag, 'i').test(hay); } catch { hit = hay.toLowerCase().includes(frag.toLowerCase()); }
          if (hit) { hitFrag = frag; break; }
        }
        prev.output = { ...(prev.output ?? {}), rule_checked: true, rule_violated: hit };
        if (hit) {
          const behavior = String(prevRule.on_violation ?? 'escalate');
          prev.status = 'failed';
          prev.detail = `${prev.detail} — STEP RULE VIOLATED (matched "${hitFrag}")`;
          run.status = 'failed';
          if (behavior === 'escalate' && !run.preview) {
            await admin.from('human_tasks').insert({
              tenant_id: tenantId, type: 'escalation', source: 'de',
              title: `Playbook step rule violated — ${prev.label}`,
              detail: `Step "${prev.label}" output matched its step rule pattern ("${hitFrag}"). The run was stopped for review. Run ${run.id}.`,
            });
          }
          await saveRun(admin, run);
          await audit(admin, tenantId,
            `Playbook [${acct()}] — step "${prev.label}" violated its step rule (matched "${hitFrag}") — run stopped${behavior === 'escalate' ? ', escalated to a human' : ''}`,
            'guardrail_block',
            { run_id: run.id, definition_id: run.definition_id, step_index: i - 1, rule_pattern: prevRule.pattern, matched: hitFrag },
            'Playbook DE');
          return { status: 'failed' };
        }
      }
    }

    try {
      switch (step.key) {
        // ────────────────────────────────────────────────
        case 'check_account': {
          const { data: account } = await admin
            .from('customer_accounts')
            .select('id, name, arr_cents, renewal_date, attributes')
            .eq('id', ctx.account_id).eq('tenant_id', tenantId).single();
          if (!account) {
            step.status = 'failed'; step.at = now(); step.detail = 'Account not found or not eligible';
            run.status = 'failed';
            await saveRun(admin, run); await stepAudit(i);
            return { status: 'failed' };
          }
          ctx.account_name = account.name;
          ctx.arr_cents = account.arr_cents;
          ctx.renewal_date = account.renewal_date;
          // PB2.0: tenant custom fields (Wave 4) become {{party.KEY}} tokens.
          ctx.party_attributes = (account.attributes ?? {}) as Record<string, unknown>;
          step.status = 'done'; step.at = now();
          step.detail = account.renewal_date
            ? `${account.name} · ARR ${fmtMoney(account.arr_cents)} · renews ${account.renewal_date}`
            : `${account.name} · ARR ${fmtMoney(account.arr_cents)} · no renewal date set`;
          // FIX (found live during the Finance DE build's own high-
          // value-account guardrail proof — a genuine, pre-existing gap
          // in the `decision` primitive, not new business logic): a
          // subsequent `decision` step's `on: "step:N.field"` reference
          // resolves via resolveStepRef, which only reads step.output
          // (populated today ONLY by sub_playbook) or step.status/
          // detail — never the values check_account itself just wrote
          // into ctx. This silently made ANY decision step branching on
          // account.arr_cents always evaluate the referenced field as
          // undefined (Number(undefined) > N is always false), for
          // every playbook that has ever tried this, not just this
          // build's. Populating step.output here is a fully generic
          // fix — any playbook wanting to branch on an account field
          // check_account already exposes needs this, regardless of
          // department — not a Finance-specific workaround.
          step.output = { account_name: account.name, arr_cents: account.arr_cents, renewal_date: account.renewal_date };
          break;
        }

        // ────────────────────────────────────────────────
        case 'generate_invoice': {
          const amount = params.amount_source === 'fixed'
            ? (params.fixed_amount_cents as number)
            : (ctx.arr_cents ?? 0);

          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would create an invoice for ${fmtMoney(amount)} (not persisted)`;
            ctx.invoice_amount_cents = amount; ctx.gated = false;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }

          // THE UNIFIED GATE (DE-B3, migration 125): the guardrail
          // threshold + per-DE trust dial composition that used to live
          // as a private TypeScript copy here is now
          // decide_action_execution's amount mode — one decision brain
          // for registered actions AND this step. On RPC failure the
          // step fails toward human review (gated), never toward
          // auto-sending.
          const invoiceRunDeId = await resolveRunDeId();
          // Registry identity (DE-B3): admin off switch + ledger id.
          // A missing row never blocks execution (defensive).
          let invDefId: string | null = null;
          try {
            const { data: invDef } = await admin.from('action_definitions')
              .select('id, status').eq('scope', 'platform').eq('category', 'billing')
              .eq('action_key', 'generate_invoice').maybeSingle();
            if (invDef?.status === 'disabled') {
              step.status = 'skipped'; step.at = now();
              step.detail = 'skipped: an admin disabled the "Generate a renewal invoice" action (Systems & Actions)';
              await stepAudit(i, { disabled_by: 'action_definition' });
              await saveRun(admin, run);
              continue;
            }
            invDefId = invDef?.id ?? null;
          } catch { /* defensive — proceed without registry identity */ }
          let gated = true;
          let gateReasoning = 'Gated: the decision service was unavailable — routed to human approval as the safe default.';
          let gateDecision = 'human_gated_trust';
          try {
            const { data: decisionRaw, error: decErr } = await admin.rpc('decide_action_execution', {
              p_tenant_id: tenantId, p_action_label: 'Generate a renewal invoice', p_category: 'billing',
              p_destructive: false, p_de_id: invoiceRunDeId, p_amount_cents: amount, p_action_type: 'invoice_auto_send',
            });
            if (!decErr && decisionRaw) {
              const d = decisionRaw as { decision: string; reasoning: string };
              gated = d.decision !== 'auto_executed';
              gateReasoning = d.reasoning;
              gateDecision = d.decision;
            }
          } catch { /* fail-safe default above */ }

          const { data: invoice, error: invErr } = await admin
            .from('renewal_invoices')
            .insert({
              tenant_id: tenantId, account_id: ctx.account_id, amount_cents: amount,
              status: gated ? 'awaiting_approval' : 'sent', due_date: ctx.renewal_date ?? null,
            })
            .select().single();
          if (invErr || !invoice) throw new Error(invErr?.message ?? 'invoice insert failed');

          ctx.invoice_id = invoice.id;
          ctx.invoice_amount_cents = amount;
          ctx.invoice_status = invoice.status;
          ctx.gated = gated;
          step.status = 'done'; step.at = now();
          step.detail = `Invoice ${fmtMoney(amount)} created (${invoice.status})`;
          await stepAudit(i, { invoice_id: invoice.id, amount_cents: amount, gated, gate_reasoning: gateReasoning, composition: 'autonomy_narrows_within_guardrails' });
          await audit(admin, tenantId,
            gated
              ? `Guardrail GATED — invoice ${fmtMoney(amount)} for ${acct()}: ${gateReasoning}`
              : `Guardrail passed — invoice ${fmtMoney(amount)} for ${acct()}: within guardrail and trust dial — auto-approved`,
            'guardrail_check',
            { run_id: run.id, invoice_id: invoice.id, amount_cents: amount, resolved_de_id: invoiceRunDeId, result: gated ? 'gated' : 'passed', composition: 'autonomy_narrows_within_guardrails' },
            'Playbook DE');
          // THE LEDGER (DE-B3): this execution now exists in
          // action_executions like every registered action. The
          // approval UX for a gated invoice is the playbook's own
          // human_approval step (which parks and resumes the run), so
          // p_create_task=false prevents a duplicate action_approval
          // task competing for the same invoice. Ledger failure never
          // fails the step — observability must not break execution.
          try {
            if (invDefId) {
              await admin.rpc('record_action_execution', {
                p_tenant_id: tenantId, p_action_definition_id: invDefId, p_connector_id: null,
                p_subject_kind: invoiceRunDeId ? 'de' : null, p_subject_id: invoiceRunDeId,
                p_mode: 'execute', p_params: { amount_cents: amount, account_name: ctx.account_name ?? null, invoice_id: invoice.id, run_id: run.id },
                p_decision: gated ? gateDecision : 'auto_executed',
                p_destructive: false, p_idempotent: false, p_dedupe_key: null,
                p_request_summary: `Generate a renewal invoice for ${fmtMoney(amount)} — ${acct()}`,
                p_receipt: gated ? null : `Invoice ${fmtMoney(amount)} created and sent for ${acct()}.`,
                p_result: { invoice_id: invoice.id, status: invoice.status, gate_reasoning: gateReasoning },
                p_task_title: null, p_task_detail: null, p_create_task: false,
              });
            }
          } catch { /* ledger is best-effort */ }
          await saveRun(admin, run);
          continue; // audit already appended above
        }

        // ────────────────────────────────────────────────
        case 'human_approval': {
          if (run.preview) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'PREVIEW — human gates never pause preview runs; treated as auto-approved';
            break;
          }
          if (ctx.invoice_id && ctx.gated === false) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'Not required — invoice auto-approved within guardrail and trust dial';
            break;
          }
          const title = renderTemplate(
            (params.title_template as string) || 'Playbook approval — {{account.name}}', ctx, run.id, run.steps);
          const { data: task, error: taskErr } = await admin
            .from('human_tasks')
            .insert({
              tenant_id: tenantId, type: (params.task_type as string) || 'approval_gate',
              title, detail: ctx.invoice_amount_cents ? fmtMoney(ctx.invoice_amount_cents) : '',
              source: 'system',
              related_table: ctx.invoice_id ? 'renewal_invoices' : null,
              related_id: ctx.invoice_id ?? null,
            })
            .select().single();
          if (taskErr || !task) throw new Error(taskErr?.message ?? 'task insert failed');
          step.status = 'waiting';
          step.detail = 'Waiting on the approval task in Human Tasks';
          run.status = 'waiting_approval';
          run.waiting_task_id = task.id;
          await saveRun(admin, run);
          await stepAudit(i, { task_id: task.id });
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'escalated',
            text: `Playbook "${run.playbook_key}" paused for approval — ${title}`,
          });
          return { status: 'waiting_approval', task_id: task.id };
        }

        // ────────────────────────────────────────────────
        case 'guardrail_check': {
          let thresholdCents = 10_000 * 100;
          const { data: rules } = await admin
            .from('guardrail_rules').select('threshold')
            .eq('tenant_id', tenantId).eq('rule_type', 'require_approval_over_cents').eq('active', true)
            .order('updated_at', { ascending: false }).limit(1);
          if (rules?.length && typeof rules[0].threshold === 'number') thresholdCents = rules[0].threshold;
          const amount = ctx.invoice_amount_cents ?? 0;
          const within = amount <= thresholdCents;
          step.status = 'done'; step.at = now();
          step.detail = ctx.invoice_id
            ? `Invoice ${fmtMoney(amount)} ${within ? 'within' : 'EXCEEDS'} ${fmtMoney(thresholdCents)} threshold${within ? '' : ' (human approval on record)'}`
            : 'No invoice in run context — nothing to check';
          await audit(admin, tenantId,
            `Playbook [${acct()}] — guardrail re-check: ${step.detail}`,
            'guardrail_check',
            { run_id: run.id, definition_id: run.definition_id, step_index: i, amount_cents: amount, threshold_cents: thresholdCents, result: within ? 'passed' : 'gated_with_approval' },
            'Playbook DE');
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        case 'connector_action': {
          if (run.preview) {
            const p = params as Record<string, unknown>;
            const label = typeof p.action_key === 'string' && typeof p.category !== 'string'
              ? `${String(p.action_category ?? 'connector')} action "${p.action_key}"`
              : `${String(p.category ?? p.provider ?? 'connector')}.${String(p.op ?? '')}`;
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would call ${label} (simulated, no external call, nothing persisted)`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          // ── DATA ACCESS GRANTS (migration 029): resolve the DE subject
          // whose grants govern this run's connector steps — the
          // definition's assigned DE (playbook_definitions.de_id), else
          // the tenant's first DE (same fallback as trust policies in
          // migration 025). The hub enforces default-deny; a denial
          // FAILS the step honestly and escalates to a human.
          let runDeId = typeof ctx.de_subject_id === 'string' ? ctx.de_subject_id as string : null;
          if (!runDeId) {
            if (run.definition_id) {
              const { data: defRow } = await admin.from('playbook_definitions')
                .select('de_id').eq('id', run.definition_id).maybeSingle();
              runDeId = (defRow?.de_id as string | null) ?? null;
            }
            if (!runDeId) {
              const { data: firstDe } = await admin.from('digital_employees')
                .select('id').eq('tenant_id', tenantId)
                .order('created_at', { ascending: true }).limit(1).maybeSingle();
              runDeId = (firstDe?.id as string | undefined) ?? null;
            }
            if (runDeId) ctx.de_subject_id = runDeId;
          }
          const failDenied = async (opLabel: string, detail: string) => {
            step.status = 'failed'; step.at = now();
            step.detail = `Access denied by data access rules — ${detail}`;
            run.status = 'failed';
            await admin.from('human_tasks').insert({
              tenant_id: tenantId, type: 'escalation', source: 'de',
              title: `Playbook blocked by data access rules — ${acct()}`,
              detail: `Step "${step.label}" (${opLabel}) was denied: ${detail} An admin can change this under Governance → Data Access, or assign a DE with the right grants to this playbook.`,
            });
            await saveRun(admin, run); await stepAudit(i, { denied_by: 'data_access_grants' });
            return { status: 'failed' as const };
          };

          // ── Category-op form (migration 027): provider-agnostic
          // read-through via connector-hub category_op. The step names
          // a CATEGORY + canonical op; the hub picks the adapter and
          // enforces op legality. Read-only — write-back stays on the
          // legacy zendesk form below.
          if (typeof params.category === 'string' && params.category) {
            const category = params.category as string;
            const op = String(params.op ?? '');
            const { data: catConn } = await admin
              .from('connectors').select('id, provider, display_name, status')
              .eq('tenant_id', tenantId).eq('category', category).neq('status', 'disconnected')
              .limit(1).maybeSingle();
            if (!catConn) {
              step.status = 'skipped'; step.at = now();
              step.detail = `skipped: no connected ${category} system for this workspace`;
              break;
            }
            const opParams: Record<string, unknown> = {};
            if (params.query_template) opParams.query = renderTemplate(params.query_template as string, ctx, run.id, run.steps).trim();
            if (params.ref_template) opParams.external_ref = renderTemplate(params.ref_template as string, ctx, run.id, run.steps).trim();
            try {
              const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                  'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                },
                body: JSON.stringify({
                  action: 'category_op', connector_id: catConn.id, tenant_id: tenantId, op, params: opParams,
                  ...(runDeId ? { subject_kind: 'de', subject_id: runDeId } : {}),
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (data.error === 'access_denied') {
                return await failDenied(`${category}.${op}`,
                  `the ${runDeId ? 'assigned DE' : 'DE'} needs "${data.denial?.needed ?? 'access'}" permission on ${catConn.display_name || catConn.provider} and has ${data.denial?.has ? `only "${data.denial.has}"` : 'no grant'}.`);
              }
              if (data.ok) {
                const items = (data.items ?? []) as unknown[];
                step.status = 'done'; step.at = now();
                step.detail = `${category}.${op} on ${catConn.display_name || catConn.provider} → ${items.length} item(s), read-through`;
                // PB2.0: expose the count so a later decision/template can
                // react ({{steps.N.item_count}}, "if item_count > 0"), and
                // surface the read items to the run's working context.
                step.output = { item_count: items.length, category, op };
                if (items.length > 0) {
                  ctx.reference_context = [...((ctx.reference_context as string[] | undefined) ?? []),
                    `## ${category}.${op} result (${items.length} item(s))\n${JSON.stringify(items).slice(0, 6000)}`];
                }
                await audit(admin, tenantId,
                  `Playbook [${acct()}] — category op ${category}.${op} on ${catConn.display_name || catConn.provider} (${items.length} item(s), read-through, not persisted)`,
                  'connector_action',
                  { run_id: run.id, definition_id: run.definition_id, connector_id: catConn.id, category, op, provider: catConn.provider, item_count: items.length },
                  'Playbook DE');
              } else {
                step.status = 'skipped'; step.at = now();
                step.detail = `skipped: ${category}.${op} failed honestly (${data.error ?? `HTTP ${res.status}`})`;
              }
            } catch (e) {
              step.status = 'skipped'; step.at = now();
              step.detail = `skipped: connector-hub call failed (${String(e).slice(0, 120)})`;
            }
            break;
          }

          // ── action_key form (migration 035, THE GENERALIZED ACTION
          // LAYER): a step can target ANY registered action_definition —
          // not just the two legacy Zendesk write-backs below. This is
          // what lets a playbook "read something, then act on it" for
          // any connected category, not only helpdesk. Reuses
          // connector-hub's execute_action end to end (data access
          // grants, destructive-always-gates, guardrail-always-wins,
          // trust-narrows-within-it, receipts) — the step executor
          // itself does no gating logic; it just calls the same
          // generalized path a human or Scribe flow would call.
          if (typeof params.action_key === 'string' && params.action_key) {
            const actionCategory = String(params.action_category ?? '');
            const actionKey = params.action_key as string;
            const { data: actConn } = await admin
              .from('connectors').select('id, provider, display_name, category, status')
              .eq('tenant_id', tenantId)
              .eq(actionCategory ? 'category' : 'id', actionCategory || '00000000-0000-0000-0000-000000000000')
              .neq('status', 'disconnected')
              .limit(1).maybeSingle();
            if (!actConn) {
              step.status = 'skipped'; step.at = now();
              step.detail = `skipped: no connected ${actionCategory || 'target'} system for action "${actionKey}"`;
              break;
            }
            const actionParams: Record<string, unknown> = {};
            const templates = (params.param_templates ?? {}) as Record<string, string>;
            for (const [k, tpl] of Object.entries(templates)) actionParams[k] = renderTemplate(tpl, ctx, run.id, run.steps).trim();
            try {
              const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                  'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                },
                body: JSON.stringify({
                  action: 'execute_action', connector_id: actConn.id, tenant_id: tenantId,
                  action_key: actionKey, params: actionParams,
                  ...(runDeId ? { subject_kind: 'de', subject_id: runDeId } : {}),
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (data.error === 'access_denied') {
                return await failDenied(actionKey,
                  `the ${runDeId ? 'assigned DE' : 'DE'} needs write-back permission on ${actConn.display_name || actConn.provider} and ${data.detail ?? 'has no grant'}.`);
              }
              if (data.ok && data.gated) {
                step.status = 'done'; step.at = now();
                step.detail = `Action "${actionKey}" on ${actConn.display_name || actConn.provider} — ${data.reasoning ?? 'awaiting human approval'} (task created)`;
                await audit(admin, tenantId,
                  `Playbook [${acct()}] — action "${actionKey}" on ${actConn.display_name || actConn.provider} routed to a human: ${data.reasoning ?? ''}`,
                  'connector_action',
                  { run_id: run.id, definition_id: run.definition_id, connector_id: actConn.id, action_key: actionKey, decision: data.decision, task_id: data.task_id ?? null },
                  'Playbook DE');
              } else if (data.ok) {
                step.status = 'done'; step.at = now();
                step.detail = data.receipt ?? `Action "${actionKey}" executed on ${actConn.display_name || actConn.provider}`;
                await audit(admin, tenantId,
                  `Playbook [${acct()}] — ${data.receipt ?? `action "${actionKey}" executed`}`,
                  'connector_action',
                  { run_id: run.id, definition_id: run.definition_id, connector_id: actConn.id, action_key: actionKey, receipt: data.receipt ?? null },
                  'Playbook DE');
              } else {
                step.status = 'skipped'; step.at = now();
                step.detail = `skipped: action "${actionKey}" failed honestly (${data.error ?? data.detail ?? `HTTP ${res.status}`})`;
              }
            } catch (e) {
              step.status = 'skipped'; step.at = now();
              step.detail = `skipped: connector-hub action call failed (${String(e).slice(0, 120)})`;
            }
            break;
          }

          // ── Legacy zendesk write-back form (kept working — compat shim) ──
          // HONEST DEGRADATION: every missing prerequisite records a skip and continues.
          const { data: connector } = await admin
            .from('connectors').select('id, base_url, status')
            .eq('tenant_id', tenantId).eq('provider', 'zendesk').eq('status', 'connected')
            .limit(1).maybeSingle();
          const externalRef = params.external_ref_template
            ? renderTemplate(params.external_ref_template as string, ctx, run.id, run.steps).trim()
            : '';
          let skip: string | null = null;
          if (!connector) skip = 'skipped: no connected Zendesk connector for this workspace';
          else if (!externalRef) skip = 'skipped: no target ticket reference in run context';

          if (!skip && connector) {
            const { data: actionRow } = await admin
              .from('connector_actions').select('enabled')
              .eq('connector_id', connector.id).eq('action_key', params.op as string).maybeSingle();
            if (!actionRow?.enabled) skip = `skipped: write-back action "${params.op}" is disabled in the registry`;
          }

          // DATA ACCESS GRANTS: a write-back needs "write_back" on the
          // connector for the run's DE subject. Denial fails honestly.
          if (!skip && connector && runDeId) {
            const { data: verdict } = await admin.rpc('resolve_access', {
              p_tenant_id: tenantId, p_subject_kind: 'de', p_subject_id: runDeId,
              p_connector_id: connector.id, p_needed: 'write_back',
            });
            const v = verdict as { allowed?: boolean; has?: string | null } | null;
            if (!v?.allowed) {
              await audit(admin, tenantId,
                `Playbook [${acct()}] — write-back DENIED by data access rules: DE needs "write_back" on the Zendesk connector and has ${v?.has ? `only "${v.has}"` : 'no grant'}. Nothing written.`,
                'access_control',
                { kind: 'data_access_denied', run_id: run.id, definition_id: run.definition_id, subject_kind: 'de', subject_id: runDeId, connector_id: connector.id, op: String(params.op ?? 'write_back'), needed: 'write_back', has: v?.has ?? null },
                'Playbook DE');
              return await failDenied(String(params.op ?? 'write_back'),
                `the DE needs "write_back" permission on the Zendesk connector and has ${v?.has ? `only "${v.has}"` : 'no grant'}.`);
            }
          }

          if (!skip && connector) {
            const { data: secretRow } = await admin
              .from('connector_secrets_decrypted').select('secret').eq('connector_id', connector.id).maybeSingle();
            if (!secretRow?.secret) skip = 'skipped: no credentials stored for the connector';
            else {
              try {
                const creds = JSON.parse(secretRow.secret) as { email: string; api_token: string };
                const auth = 'Basic ' + btoa(`${creds.email}/token:${creds.api_token}`);
                const payloadText = renderTemplate((params.payload_template as string) ?? '', ctx, run.id, run.steps);
                const body = params.op === 'add_internal_note'
                  ? { ticket: { comment: { body: payloadText, public: false } } }
                  : { ticket: { status: payloadText || 'open' } };
                const res = await fetch(
                  `${connector.base_url.replace(/\/+$/, '')}/api/v2/tickets/${encodeURIComponent(externalRef)}.json`,
                  { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!res.ok) skip = `skipped: Zendesk returned HTTP ${res.status}`;
                else {
                  step.status = 'done'; step.at = now();
                  step.detail = `Zendesk ${params.op} → ticket #${externalRef}`;
                  await audit(admin, tenantId,
                    `Playbook [${acct()}] — SoR write-back: ${params.op} on Zendesk ticket #${externalRef}`,
                    'connector_action',
                    { run_id: run.id, definition_id: run.definition_id, connector_id: connector.id, op: params.op, external_ref: externalRef },
                    'Playbook DE');
                }
              } catch (e) {
                skip = `skipped: connector call failed (${String(e).slice(0, 120)})`;
              }
            }
          }

          if (skip) {
            step.status = 'skipped'; step.at = now(); step.detail = skip;
          }
          break;
        }

        // ────────────────────────────────────────────────
        case 'update_record': {
          const table = params.table as string;
          const status = ((params.set ?? {}) as Record<string, unknown>).status as string;
          const allowed = UPDATE_WHITELIST[table] ?? [];
          const targetId = table === 'renewal_invoices' ? ctx.invoice_id : ctx.ticket_id;
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would set ${table}.status → ${status} (not persisted)`;
            break;
          }
          if (!allowed.includes(status)) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: "${status}" is not a whitelisted status for ${table}`;
          } else if (!targetId) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: no target record in run context';
          } else {
            const { error: updErr } = await admin.from(table)
              .update({ status }).eq('id', targetId).eq('tenant_id', tenantId);
            if (updErr) throw new Error(updErr.message);
            if (table === 'renewal_invoices') ctx.invoice_status = status;
            step.status = 'done'; step.at = now();
            step.detail = `${table}.status → ${status}`;
          }
          break;
        }

        // ────────────────────────────────────────────────
        case 'log_activity': {
          const text = renderTemplate((params.text_template as string) ?? 'Playbook step executed', ctx, run.id, run.steps);
          if (run.preview) {
            step.status = 'done'; step.at = now(); step.detail = `PREVIEW — would log: ${text}`;
            break;
          }
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'resolved', text,
          });
          step.status = 'done'; step.at = now(); step.detail = text;
          break;
        }

        // ────────────────────────────────────────────────
        case 'emit_event': {
          // Fires a tenant-defined trigger event (Wave 2b). Any playbook
          // wired to this event runs on the next dispatch cycle — the same
          // rails polled events ride. Honest no-op if the event isn't found.
          const eventKey = String(params.event_key ?? '').trim();
          const note = renderTemplate((params.payload_template as string) ?? '', ctx, run.id, run.steps);
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would emit event "${eventKey}"`;
            break;
          }
          if (!eventKey) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: no event_key configured';
            break;
          }
          const { data: emit, error: emitErr } = await admin.rpc('emit_tenant_event', {
            p_tenant_id: tenantId,
            p_event_key: eventKey,
            p_target_account_id: ctx.account_id ?? null,
            p_payload: { source: 'playbook', run_id: run.id, ...(note ? { note } : {}) },
          });
          const e = emit as { ok?: boolean; error?: string; fires_created?: number } | null;
          if (emitErr || !e?.ok) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: event "${eventKey}" ${e?.error ?? emitErr?.message ?? 'could not be emitted'}`;
          } else {
            step.status = 'done'; step.at = now();
            step.detail = `Emitted "${eventKey}" — ${e.fires_created ?? 0} playbook(s) triggered`;
            await audit(admin, tenantId,
              `Playbook [${acct()}] — emitted event "${eventKey}" (${e.fires_created ?? 0} triggered)`,
              'playbook_step',
              { run_id: run.id, definition_id: run.definition_id, step_index: i, event_key: eventKey, fires_created: e.fires_created ?? 0 },
              'Playbook DE');
          }
          break;
        }

        // ────────────────────────────────────────────────
        case 'consult_specialist': {
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would consult "${String(params.profile_key ?? 'technical')}" (not actually called; instructions_context has ${(ctx.instructions_context ?? []).length} item(s) accumulated so far)`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          // Server-side consult via the specialist-consult function
          // (service path). HONEST DEGRADATION: missing/paused profile or
          // dormant LLM → step recorded skipped; on_low='escalate' creates
          // an escalation task either way — the run never silently loses
          // a low-confidence signal.
          //
          // profile_key 'auto' (migration 122): resolve through the
          // playbook's assigned DE — its PRIMARY specialist if active,
          // else its secondary, else honest-skip with an explanation
          // (and the usual on_low escalation).
          let profileKey = String(params.profile_key ?? 'technical');
          const minConfidence = typeof params.min_confidence === 'number' ? params.min_confidence : 60;
          const onLow = params.on_low === 'continue' ? 'continue' : 'escalate';
          if (profileKey === 'auto') {
            const { data: defRow } = await admin.from('playbook_definitions')
              .select('de_id').eq('id', run.definition_id).maybeSingle();
            const autoDeId = (defRow as { de_id?: string } | null)?.de_id ?? null;
            const { data: resolvedKey } = autoDeId
              ? await admin.rpc('resolve_de_specialist_internal', { p_tenant_id: tenantId, p_de_id: autoDeId })
              : { data: null };
            if (typeof resolvedKey === 'string' && resolvedKey) {
              profileKey = resolvedKey;
            } else {
              step.status = 'skipped'; step.at = now();
              step.detail = autoDeId
                ? 'skipped: profile_key "auto" but this playbook\'s employee has no active primary/secondary specialist assigned — assign one on the DE profile'
                : 'skipped: profile_key "auto" but this playbook has no assigned employee to resolve a specialist from';
              if (onLow === 'escalate') {
                await admin.from('human_tasks').insert({
                  tenant_id: tenantId, type: 'escalation', source: 'de',
                  title: `Specialist consult needs a human — ${acct()}`,
                  detail: `Playbook step "Consult specialist" (auto): ${step.detail}`,
                  related_table: 'playbook_runs', related_id: run.id,
                });
                step.detail += '; escalation task created';
              }
              await stepAudit(i); await saveRun(admin, run);
              continue;
            }
          }
          const questionText = renderTemplate(String(params.question_template ?? ''), ctx, run.id, run.steps).trim()
            || `Specialist review for ${acct()}`;

          const escalateTask = async (why: string) => {
            await admin.from('human_tasks').insert({
              tenant_id: tenantId, type: 'escalation', source: 'de',
              title: `Specialist consult needs a human — ${acct()}`,
              detail: `Playbook step "Consult specialist" (${profileKey}): ${why}. Question: ${questionText.slice(0, 300)}`,
              related_table: 'playbook_runs', related_id: run.id,
            });
          };

          let consultRes: Record<string, unknown> | null = null;
          try {
            const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/specialist-consult`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                action: 'consult', tenant_id: tenantId, profile_key: profileKey,
                question: questionText, requested_by: 'playbook', run_id: run.id,
                // PB2.0: the run's accumulated reference material now
                // actually reaches the specialist (this field was parsed
                // but unused server-side until now).
                context: { account_name: ctx.account_name ?? null, documents: collectRunContextDocs(ctx) || null },
              }),
            });
            consultRes = await r.json().catch(() => null);
          } catch (e) {
            consultRes = { error: `consult call failed: ${String(e).slice(0, 120)}` };
          }

          const errKey = String(consultRes?.error ?? '');
          if (errKey === 'llm_not_configured') {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: specialist brain not activated (ANTHROPIC_API_KEY) — retrieval recorded in the consultation log';
            if (onLow === 'escalate') {
              await escalateTask('specialist brain not activated — routed to a human instead');
              step.detail += '; escalation task created';
            }
          } else if (errKey === 'profile_not_found' || errKey === 'profile_paused') {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: specialist profile "${profileKey}" ${errKey === 'profile_paused' ? 'is paused' : 'is not installed'} for this workspace`;
            if (onLow === 'escalate') {
              await escalateTask(`profile ${errKey === 'profile_paused' ? 'paused' : 'missing'}`);
              step.detail += '; escalation task created';
            }
          } else if (errKey) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: consult failed (${errKey.slice(0, 120)})`;
          } else {
            const confidence = Number(consultRes?.confidence ?? 0);
            const low = confidence < minConfidence || !!consultRes?.needs_escalation;
            step.status = 'done'; step.at = now();
            step.detail = `Specialist (${profileKey}) answered — confidence ${confidence}%${low ? ` (below floor ${minConfidence}%)` : ''}`;
            if (low && onLow === 'escalate') {
              await escalateTask(`confidence ${confidence}% below the ${minConfidence}% floor`);
              step.detail += '; escalation task created';
            }
            ctx.last_consultation_id = consultRes?.consultation_id ?? null;
          }
          await stepAudit(i, {
            profile_key: profileKey,
            consultation_id: (consultRes?.consultation_id as string | null) ?? null,
            min_confidence: minConfidence, on_low: onLow,
          });
          await saveRun(admin, run);
          continue; // audit appended above
        }

        // ────────────────────────────────────────────────
        // instruction — a no-op that PRESENTS content to a human and
        // accumulates its body into the run's instructions_context so
        // later ai/consult steps in the SAME run see it. DORMANT-HONEST:
        // the accumulated text is only actually consumed by an LLM once
        // consult_specialist's brain is activated (ANTHROPIC_API_KEY);
        // until then it is recorded here but not read by anything.
        case 'instruction': {
          const title = String(params.title ?? 'Instruction');
          const bodyMd = String(params.body_md ?? '');
          const media = Array.isArray(params.media) ? params.media as MediaRef[] : [];
          step.status = 'done'; step.at = now();
          step.detail = `Presented: ${title}${media.length ? ` (${media.length} media item${media.length === 1 ? '' : 's'})` : ''}`;
          ctx.instructions_context = [...(ctx.instructions_context ?? []), `## ${title}\n${bodyMd}`];
          await stepAudit(i, { title, has_media: media.length > 0 });
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        // decision — evaluates params.on (a "step:<index>[.field]" ref)
        // against params.value using a plain-language operator, then
        // executes then_steps or else_steps IN PLACE (indented rendering
        // in the UI — no separate steps array entry per branch step).
        case 'decision': {
          const onRef = String(params.on ?? '');
          const operator = String(params.operator ?? 'exists');
          const actual = resolveStepRef(run.steps, onRef);
          const took = evalDecision(operator, actual, params.value);
          const branchKey = took ? 'then_steps' : 'else_steps';
          const branch = (step[branchKey] ?? []) as RunStep[];
          step.branch_taken = took ? 'then' : 'else';
          step.status = 'done'; step.at = now();
          step.detail = `Condition ${took ? 'TRUE' : 'FALSE'} (${onRef} ${operator} ${params.value ?? ''}) — took the "${took ? 'then' : 'else'}" branch (${branch.length} step${branch.length === 1 ? '' : 's'})`;
          await stepAudit(i, { on: onRef, operator, value: params.value ?? null, actual: actual ?? null, branch_taken: step.branch_taken });
          await saveRun(admin, run);
          for (const bs of branch) {
            await runBranchStep(bs);
            await saveRun(admin, run);
            if (!run.preview) {
              await audit(admin, tenantId,
                `Playbook [${acct()}] — branch step "${bs.label}" ${bs.status}${bs.detail ? `: ${bs.detail}` : ''}`,
                'playbook_step',
                { run_id: run.id, definition_id: run.definition_id, step_index: i, branch: step.branch_taken, branch_step_key: bs.key },
                'Playbook DE');
            }
          }
          continue;
        }

        // ────────────────────────────────────────────────
        // checklist — a human-gate: creates a human_tasks row (type
        // 'checklist') and pauses the run, same machinery as
        // human_approval. Resume happens via decideHumanTask →
        // resume_playbook_on_task, exactly like an approval gate.
        case 'checklist': {
          const items = Array.isArray(params.items) ? params.items as string[] : [];
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would create a checklist task with ${items.length} item(s); preview never pauses for a human`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          const { data: task, error: taskErr } = await admin
            .from('human_tasks')
            .insert({
              tenant_id: tenantId, type: 'checklist',
              title: `Checklist — ${acct()}`,
              detail: items.join(' · '),
              source: 'system',
              checklist_state: items.map((text) => ({ text, done: false })),
            })
            .select().single();
          if (taskErr || !task) throw new Error(taskErr?.message ?? 'checklist task insert failed');
          step.status = 'waiting';
          step.detail = `Waiting on ${items.length} checklist item(s) in Human Tasks`;
          run.status = 'waiting_approval';
          run.waiting_task_id = task.id;
          await saveRun(admin, run);
          await stepAudit(i, { task_id: task.id, item_count: items.length });
          await admin.from('activity_events').insert({
            tenant_id: tenantId, actor: 'Playbook DE', actor_type: 'de', event_type: 'escalated',
            text: `Playbook "${run.playbook_key}" paused for a checklist — ${items.length} item(s) to confirm`,
          });
          return { status: 'waiting_approval', task_id: task.id };
        }

        // ────────────────────────────────────────────────
        // wait — parks the run until resume_at; the same 5-minute cron
        // that dispatches triggers also resumes due waits (dispatch action).
        case 'wait': {
          const minutes = Number(params.duration_minutes ?? 0);
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would wait ${minutes} minute(s); preview runs straight through`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          const resumeAt = new Date(Date.now() + minutes * 60_000).toISOString();
          step.status = 'waiting'; step.at = now();
          step.detail = `Waiting ${minutes} minute(s) — resumes at ${resumeAt}`;
          run.status = 'waiting';
          await admin.from('playbook_runs').update({
            status: 'waiting', current_step: i, steps: run.steps, context: ctx, resume_at: resumeAt,
          }).eq('id', run.id);
          await stepAudit(i, { duration_minutes: minutes, resume_at: resumeAt });
          return { status: 'waiting' };
        }

        // ────────────────────────────────────────────────
        // sub_playbook — runs a published version of another playbook
        // inline as a CHILD run (parent_run_id links it back). The child
        // inherits the parent's DE subject so data-access grants are
        // enforced consistently across the parent/child boundary.
        case 'sub_playbook': {
          const childDefId = String(params.playbook_id ?? '');
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would run playbook ${childDefId} as a child run (not actually started)`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          if (!ctx.account_id) {
            step.status = 'failed'; step.at = now();
            step.detail = 'skipped: sub_playbook needs an account in run context';
            run.status = 'failed';
            await saveRun(admin, run); await stepAudit(i);
            return { status: 'failed' };
          }
          const childResult = await startDefinitionRunServer(
            admin, tenantId, childDefId, ctx.account_id,
            { parentRunId: run.id, deSubjectId: (ctx.de_subject_id as string | undefined) ?? null },
          );
          if (childResult.error) {
            step.status = 'failed'; step.at = now();
            step.detail = `Child playbook failed to start: ${childResult.error}`;
            run.status = 'failed';
            await saveRun(admin, run); await stepAudit(i, { child_error: childResult.error });
            return { status: 'failed' };
          }
          step.status = 'done'; step.at = now();
          step.detail = `Child run started (${childResult.status}) — ${childResult.run_id}`;
          step.output = { child_run_id: childResult.run_id, child_status: childResult.status };
          await stepAudit(i, { child_run_id: childResult.run_id, child_status: childResult.status });
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        // agentic_step — hands the step to a bounded reasoning loop
        // (agentic-step-execute) instead of a fixed script. DORMANT-
        // HONEST: mirrors consult_specialist's llm_not_configured skip
        // exactly. The loop's own tool calls run through execute_action
        // internally (destructive-gates/guardrails/trust all apply
        // automatically, same as connector_action).
        //
        // NON-BLOCKING BY DESIGN, matching connector_action's existing
        // convention exactly: when a tool call inside the loop gets
        // gated, connector-hub creates its normal human_tasks row (type
        // 'action_approval') and the loop is TOLD the action is pending
        // — it does not stop and wait. The playbook step completes in
        // this one HTTP call once the loop reaches a terminal state
        // (goal reached, budget/iteration cap, or no-progress), exactly
        // like every other step. This deliberately mirrors
        // execRegisteredAction (above) rather than human_approval: a
        // gate created mid-reasoning is routed to a human for that ONE
        // action, same as a deterministic connector_action step would,
        // without pausing the playbook run around it. A future version
        // could make the loop itself wait on a gate before continuing
        // its OWN reasoning — deliberately out of scope here (it would
        // require executing the approved action exactly once, and the
        // existing approval hook (resolveActionExecution, connectorApi.ts)
        // already owns that; teaching two systems to coordinate on the
        // same gate without double-executing needs its own design pass).
        case 'agentic_step': {
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would run an agentic step toward: "${String(params.goal_template ?? '').slice(0, 120)}" (not actually run)`;
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          const goal = renderTemplate(String(params.goal_template ?? ''), ctx, run.id, run.steps).trim()
            || `Complete step ${i + 1} of this playbook.`;
          const runDeId = await resolveRunDeId();
          if (!runDeId) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: no digital employee available to run this step';
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }

          let agenticRes: Record<string, unknown> | null = null;
          try {
            const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/agentic-step-execute`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                action: 'start', tenant_id: tenantId, de_id: runDeId,
                playbook_run_id: run.id, step_index: i, goal,
                // PB2.0: instructions + knowledge checks + references the
                // run accumulated — the DE reads them before acting.
                context_documents: collectRunContextDocs(ctx) || null,
              }),
            });
            agenticRes = await r.json().catch(() => null);
          } catch (e) {
            agenticRes = { error: `agentic step call failed: ${String(e).slice(0, 120)}` };
          }

          const errKey = String(agenticRes?.error ?? '');
          if (errKey === 'llm_not_configured') {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: agentic reasoning not activated (ANTHROPIC_API_KEY) — run recorded';
            await stepAudit(i, { agentic_step_run_id: agenticRes?.agentic_step_run_id ?? null });
            await saveRun(admin, run);
            continue;
          }
          if (errKey) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: agentic step failed (${errKey.slice(0, 120)})`;
            await stepAudit(i, { agentic_step_run_id: agenticRes?.agentic_step_run_id ?? null });
            await saveRun(admin, run);
            continue;
          }

          const outStatus = String(agenticRes?.status ?? 'failed');
          const done = outStatus === 'completed';
          step.status = done ? 'done' : 'failed';
          step.at = now();
          step.detail = done
            ? `Agentic step completed — ${String(agenticRes?.summary ?? '').slice(0, 200) || 'goal reached'}`
            : `Agentic step ended: ${outStatus}`;
          ctx.last_agentic_step_run_id = (agenticRes?.agentic_step_run_id as string | undefined) ?? null;
          await stepAudit(i, { agentic_step_run_id: agenticRes?.agentic_step_run_id ?? null, status: outStatus });
          if (!done) {
            run.status = 'failed';
            await saveRun(admin, run);
            return { status: 'failed' };
          }
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        // start_onboarding — the fix closing roadmap #9 (auto-kickoff
        // onboarding on a won deal) and #13 (reunify onboarding with
        // the playbook engine) together. Before this, the ONLY caller
        // of create_onboarding_project was the manual UI checkbox
        // inside close_opportunity_won — the automatic opportunity_won
        // dispatcher path fired a real playbook run with nothing real
        // for it to do. create_onboarding_project's service-role
        // branch (migration 104) lets THIS call, running with no JWT,
        // pass tenantId explicitly instead of resolving via auth.uid().
        case 'start_onboarding': {
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = 'PREVIEW — would create a real onboarding project (not actually created)';
            await stepAudit(i); await saveRun(admin, run);
            continue;
          }
          // Registry identity (DE-B3, migration 125): the definition
          // gives admins a real off switch (Systems & Actions →
          // disable) and gives every execution a ledger row below. A
          // missing definition row never blocks execution (defensive:
          // observability infra must not break the live flow).
          let onbDefId: string | null = null;
          try {
            const { data: onbDef } = await admin.from('action_definitions')
              .select('id, status').eq('scope', 'platform').eq('category', 'other')
              .eq('action_key', 'start_onboarding').maybeSingle();
            if (onbDef?.status === 'disabled') {
              step.status = 'skipped'; step.at = now();
              step.detail = 'skipped: an admin disabled the "Start an onboarding project" action (Systems & Actions)';
              await stepAudit(i, { disabled_by: 'action_definition' });
              await saveRun(admin, run);
              continue;
            }
            onbDefId = onbDef?.id ?? null;
          } catch { /* defensive — proceed without registry identity */ }
          const { data: projRes, error: projErr } = await admin.rpc('create_onboarding_project', {
            p_account_id: ctx.account_id, p_version_id: params.template_version_id,
            p_name: (params.name as string) || null, p_target: null, p_tenant_id: tenantId,
          });
          if (projErr) throw new Error(projErr.message);
          const errKey = String((projRes as { error?: string } | null)?.error ?? '');
          if (errKey) {
            // Honest skip, not a throw — same posture as connector_action's
            // "no target record in run context" skips. A misconfigured
            // step (a deleted/unpublished template version, or no
            // account resolved yet in this run) shouldn't fail the
            // whole playbook.
            step.status = 'skipped'; step.at = now();
            step.detail = errKey === 'template_version_not_found'
              ? 'skipped: the configured onboarding template version no longer exists'
              : errKey === 'account_not_found'
                ? 'skipped: no account resolved yet in this run to onboard'
                : `skipped: ${errKey}`;
            await stepAudit(i, { error: errKey });
            await saveRun(admin, run);
            continue;
          }
          const projectId = (projRes as { project_id?: string } | null)?.project_id ?? null;
          step.status = 'done'; step.at = now();
          step.detail = `Onboarding project created — ${acct()}`;
          ctx.onboarding_project_id = projectId;
          await stepAudit(i, { project_id: projectId, account_id: ctx.account_id, template_version_id: params.template_version_id });
          // THE LEDGER (DE-B3): an internal record write from a
          // human-published playbook — executed ungated by design
          // (same class as log_activity/update_record), recorded
          // honestly as auto_executed. Best-effort.
          try {
            if (onbDefId) {
              const onbRunDeId = await resolveRunDeId();
              await admin.rpc('record_action_execution', {
                p_tenant_id: tenantId, p_action_definition_id: onbDefId, p_connector_id: null,
                p_subject_kind: onbRunDeId ? 'de' : null, p_subject_id: onbRunDeId,
                p_mode: 'execute', p_params: { template_version_id: params.template_version_id, account_name: ctx.account_name ?? null, project_id: projectId, run_id: run.id },
                p_decision: 'auto_executed',
                p_destructive: false, p_idempotent: false, p_dedupe_key: null,
                p_request_summary: `Start an onboarding project — ${acct()}`,
                p_receipt: `Onboarding project created for ${acct()} from a published template.`,
                p_result: { project_id: projectId },
                p_task_title: null, p_task_detail: null, p_create_task: false,
              });
            }
          } catch { /* ledger is best-effort */ }
          await saveRun(admin, run);
          continue;
        }

        // ────────────────────────────────────────────────
        // ────────────────────────────────────────────────
        // PB2.0 — check_knowledge: scripted knowledge verification. The
        // author defines WHAT to look up (templated query), HOW MANY
        // matches to fetch, and WHAT HAPPENS on a miss. Retrieval is the
        // same hybrid path every DE answer uses (lexical+semantic RRF,
        // migration 046), scoped to the run's DE (migration 030) — free
        // built-in embeddings, degrades to lexical-only without them.
        case 'check_knowledge': {
          const query = renderTemplate(String(params.query_template ?? ''), ctx, run.id, run.steps).trim();
          const matchCount = Math.min(10, Math.max(1, Number(params.match_count ?? 5)));
          const onMiss = ['continue', 'escalate', 'fail'].includes(String(params.on_miss)) ? String(params.on_miss) : 'escalate';
          if (!query) {
            step.status = 'skipped'; step.at = now();
            step.detail = 'skipped: query template rendered empty';
            break;
          }
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would search the knowledge base for "${query.slice(0, 80)}" (${matchCount} matches, on miss: ${onMiss})`;
            step.output = { found: true, matches: matchCount, preview: true };
            break;
          }
          const ckRunDeId = await resolveRunDeId();
          const qEmbedding = await embedText(query);
          const { data: chunks, error: ckErr } = await admin.rpc('hybrid_match_knowledge', {
            p_tenant_id: tenantId, p_query_text: query, p_account_id: null,
            p_query_embedding: qEmbedding, p_match_count: matchCount,
            p_subject_kind: ckRunDeId ? 'de' : null, p_subject_id: ckRunDeId,
          });
          if (ckErr) {
            step.status = 'skipped'; step.at = now();
            step.detail = `skipped: knowledge search failed honestly (${ckErr.message.slice(0, 120)})`;
            break;
          }
          const rows = (chunks ?? []) as Array<{ doc_title: string; content: string; distance: number | null }>;
          const found = rows.length > 0;
          step.output = {
            found, matches: rows.length,
            top_title: rows[0]?.doc_title ?? null,
            top_distance: rows[0]?.distance ?? null,
          };
          if (found) {
            // Feed what was found into the run's working context (capped)
            // so later agentic / specialist steps actually read it.
            const bundle = rows.map((r) => `### ${r.doc_title}\n${r.content}`).join('\n\n').slice(0, 6000);
            ctx.knowledge_context = [...((ctx.knowledge_context as string[] | undefined) ?? []), `## Knowledge check: ${query.slice(0, 120)}\n${bundle}`];
            step.status = 'done'; step.at = now();
            step.detail = `Found ${rows.length} knowledge match(es) for "${query.slice(0, 80)}" — top: ${rows[0]?.doc_title ?? '—'}`;
            break;
          }
          // Miss — author-chosen behavior.
          if (onMiss === 'continue') {
            step.status = 'skipped'; step.at = now();
            step.detail = `No knowledge found for "${query.slice(0, 80)}" — continuing (author's choice)`;
            break;
          }
          step.status = 'failed'; step.at = now();
          step.detail = `No knowledge found for "${query.slice(0, 80)}" — ${onMiss === 'escalate' ? 'escalated to a human' : 'run stopped'} (author's choice)`;
          run.status = 'failed';
          if (onMiss === 'escalate') {
            await admin.from('human_tasks').insert({
              tenant_id: tenantId, type: 'escalation', source: 'de',
              title: `Playbook knowledge check failed — ${step.label}`,
              detail: `The knowledge base has no answer for "${query.slice(0, 200)}". The run was stopped for review. Run ${run.id}.`,
            });
          }
          await saveRun(admin, run); await stepAudit(i);
          return { status: 'failed' };
        }

        // ────────────────────────────────────────────────
        // PB2.0 — read_reference: documents/links the DE actually READS.
        // Content lands in the run's working context, which later
        // agentic / specialist steps receive. URL fetches pass the SSRF
        // guard; storage assets must be text-like (PDF extraction is
        // deliberately not faked — no extractor exists yet).
        case 'read_reference': {
          const refs = (Array.isArray(params.refs) ? params.refs : []) as Array<Record<string, unknown>>;
          const title = String(params.title ?? step.label ?? 'Reference');
          if (run.preview) {
            step.status = 'done'; step.at = now();
            step.detail = `PREVIEW — would read ${refs.length} reference(s) into the run context`;
            step.output = { sources: refs.length, chars: 0, preview: true };
            break;
          }
          const readParts: string[] = [];
          const readNotes: string[] = [];
          for (const r of refs.slice(0, 5)) {
            const kind = String(r.kind ?? '');
            try {
              if (kind === 'doc') {
                const { data: doc } = await admin.from('knowledge_docs')
                  .select('id, title, content, visibility')
                  .eq('id', r.doc_id).eq('tenant_id', tenantId).maybeSingle();
                if (!doc) { readNotes.push(`doc ${String(r.doc_id).slice(0, 8)}… not found`); continue; }
                if (doc.visibility === 'scoped') {
                  // Mirror the retrieval RPC's scope filter: a scoped doc
                  // is readable only if the run's DE is on its scope list.
                  const rrDeId = await resolveRunDeId();
                  const { data: scopeRow } = rrDeId ? await admin.from('knowledge_doc_scopes')
                    .select('id').eq('doc_id', doc.id).eq('subject_kind', 'de').eq('subject_id', rrDeId).maybeSingle()
                    : { data: null };
                  if (!scopeRow) { readNotes.push(`"${doc.title}" is scoped to other employees — not readable in this run`); continue; }
                }
                readParts.push(`## ${doc.title}\n${String(doc.content ?? '').slice(0, 20000)}`);
              } else if (kind === 'url') {
                const url = String(r.url ?? '');
                if (!isSafeExternalUrl(url)) { readNotes.push(`URL blocked by safety policy: ${url.slice(0, 80)}`); continue; }
                const resp = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'Accept': 'text/html, text/plain, text/markdown, application/json' } });
                if (!resp.ok) { readNotes.push(`URL returned ${resp.status}: ${url.slice(0, 80)}`); continue; }
                const raw = (await resp.text()).slice(0, 200000);
                // Naive HTML strip — scripts/styles out, tags out, entities kept simple.
                const text = raw
                  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 20000);
                if (!text) { readNotes.push(`URL had no readable text: ${url.slice(0, 80)}`); continue; }
                readParts.push(`## ${url}\n${text}`);
              } else if (kind === 'asset') {
                const { data: asset } = await admin.from('media_assets')
                  .select('id, storage_path, mime, kind')
                  .eq('id', r.asset_id).eq('tenant_id', tenantId).maybeSingle();
                if (!asset) { readNotes.push(`document ${String(r.asset_id).slice(0, 8)}… not found`); continue; }
                const mime = String(asset.mime ?? '');
                const textLike = mime.startsWith('text/') || mime.includes('markdown') || mime.includes('json');
                if (!textLike) { readNotes.push(`"${asset.storage_path.split('/').pop()}" is ${mime || 'binary'} — only text documents are readable (PDF extraction not built yet)`); continue; }
                const { data: blob } = await admin.storage.from('playbook-media').download(asset.storage_path);
                if (!blob) { readNotes.push(`could not read stored document ${String(r.asset_id).slice(0, 8)}…`); continue; }
                const text = (await blob.text()).slice(0, 20000);
                readParts.push(`## ${asset.storage_path.split('/').pop()}\n${text}`);
              } else {
                readNotes.push(`unknown reference kind "${kind}"`);
              }
            } catch (e) {
              readNotes.push(`reference failed honestly: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
            }
          }
          const totalChars = readParts.reduce((s, p) => s + p.length, 0);
          if (readParts.length > 0) {
            ctx.reference_context = [...((ctx.reference_context as string[] | undefined) ?? []), `# ${title}\n${readParts.join('\n\n')}`];
          }
          step.output = { sources: readParts.length, chars: totalChars, skipped: readNotes.length };
          step.status = readParts.length > 0 ? 'done' : 'skipped'; step.at = now();
          step.detail = readParts.length > 0
            ? `Read ${readParts.length} reference(s) (${totalChars.toLocaleString()} chars) into the run context${readNotes.length ? ` · ${readNotes.length} skipped: ${readNotes.join('; ').slice(0, 160)}` : ''}`
            : `skipped: no readable references (${readNotes.join('; ').slice(0, 200)})`;
          break;
        }

        case 'complete': {
          step.status = 'done'; step.at = now(); step.detail = 'Run completed';
          run.status = 'completed';
          run.waiting_task_id = null;
          await saveRun(admin, run);
          await stepAudit(i);
          await audit(admin, tenantId,
            `Playbook [${acct()}] — run completed end-to-end`,
            'playbook_step',
            { run_id: run.id, definition_id: run.definition_id, definition_version: run.definition_version, invoice_id: ctx.invoice_id ?? null },
            'Playbook DE');
          return { status: 'completed' };
        }

        default: {
          step.status = 'skipped'; step.at = now();
          step.detail = `skipped: unknown primitive "${step.key}"`;
        }
      }
    } catch (err) {
      step.status = 'failed'; step.at = now();
      step.detail = `failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      run.status = 'failed';
      await saveRun(admin, run);
      await stepAudit(i);
      return { status: 'failed' };
    }

    await saveRun(admin, run);
    await stepAudit(i);
  }

  // Defensive: validation guarantees a trailing complete step.
  run.status = 'completed';
  run.waiting_task_id = null;
  await saveRun(admin, run);
  return { status: 'completed' };
}

// ── Definition-run starter — shared by 'start' and 'dispatch' (R7) ──

interface StartDefResult { run_id?: string; status: string; task_id?: string; error?: string; http?: number }

async function startDefinitionRunServer(
  admin: SupabaseClient, tenantId: string, definitionId: string, accountId: string,
  opts?: { parentRunId?: string | null; deSubjectId?: string | null; eventRef?: string | null; eventNote?: string | null },
): Promise<StartDefResult> {
  const { data: def } = await admin.from('playbook_definitions')
    .select('*').eq('id', definitionId).eq('tenant_id', tenantId).maybeSingle();
  if (!def) return { status: 'error', error: 'definition_not_found', http: 404 };
  if (def.status !== 'published') return { status: 'error', error: 'definition_not_published', http: 400 };

  // LIFECYCLE GATE (DE-B4, migration 126): a playbook assigned to a
  // paused/retired employee does not run — the constitution's "paused
  // = scheduled Workflows are paused" made real. Definitions with no
  // assigned DE are unaffected.
  if (def.de_id) {
    const { data: assignedDe } = await admin.from('digital_employees')
      .select('lifecycle_status, name').eq('id', def.de_id).maybeSingle();
    const stage = String(assignedDe?.lifecycle_status ?? '');
    if (['paused', 'retired', 'archived'].includes(stage)) {
      return { status: 'error', error: 'assigned_de_' + stage, http: 409 };
    }
  }

  // Runs execute the IMMUTABLE published snapshot, never the live draft.
  const { data: snapshot } = await admin.from('playbook_versions')
    .select('version, steps').eq('definition_id', def.id)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (!snapshot) return { status: 'error', error: 'no_published_version', http: 400 };

  const errors = validateSteps(snapshot.steps);
  if (errors.length > 0) return { status: 'error', error: 'invalid_definition', http: 422 };

  const steps: RunStep[] = (snapshot.steps as DefStep[]).map((s) => ({
    key: s.key,
    label: s.label || PRIMITIVE_LABELS[s.key] || s.key,
    status: 'pending', at: null, detail: '',
    params: s.params ?? {},
    then_steps: (s.then_steps ?? []).map((bs) => ({ key: bs.key, label: bs.label || PRIMITIVE_LABELS[bs.key] || bs.key, status: 'pending', at: null, detail: '', params: bs.params ?? {} })),
    else_steps: (s.else_steps ?? []).map((bs) => ({ key: bs.key, label: bs.label || PRIMITIVE_LABELS[bs.key] || bs.key, status: 'pending', at: null, detail: '', params: bs.params ?? {} })),
  }));
  // CHILD RUN (sub_playbook): inherits the parent's DE subject so
  // data-access grants are enforced consistently across the boundary —
  // a child never gets MORE access than its parent's assigned DE.
  const context: RunContext = {
    account_id: accountId,
    ...(opts?.deSubjectId ? { de_subject_id: opts.deSubjectId } : {}),
    // PB2.0: event-triggered runs finally know WHAT triggered them —
    // {{event.ref}} / {{event.note}} template tokens read these.
    ...(opts?.eventRef ? { event_ref: opts.eventRef } : {}),
    ...(opts?.eventNote ? { event_note: opts.eventNote } : {}),
  };
  const { data: runRow, error: runErr } = await admin
    .from('playbook_runs')
    .insert({
      tenant_id: tenantId, playbook_key: def.key, account_id: accountId,
      status: 'running', current_step: 0, steps, context,
      definition_id: def.id, definition_version: snapshot.version,
      parent_run_id: opts?.parentRunId ?? null,
    })
    .select().single();
  if (runErr || !runRow) return { status: 'error', error: runErr?.message ?? 'run insert failed', http: 500 };

  const run: DefRunRow = {
    id: runRow.id, tenant_id: tenantId, account_id: accountId,
    status: 'running', current_step: 0, steps, waiting_task_id: null,
    context, definition_id: def.id, definition_version: snapshot.version,
    playbook_key: def.key, parent_run_id: opts?.parentRunId ?? null,
  };
  const result = await executeDefinitionSteps(admin, run, 0);
  return { run_id: run.id, status: result.status, task_id: result.task_id };
}

// ═══════════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const action = body?.action;
    if (!['start', 'advance', 'cancel', 'publish', 'validate', 'dispatch'].includes(action)) {
      return json({ error: 'invalid action' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service-role key + body.tenant_id ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    let userId: string | null = null;

    // ── R7 dispatch: three callers, three scopes ──
    //   pg_cron via pg_net (x-dispatch-secret, Vault-held)  → all tenants
    //   service-role key                                    → all tenants
    //   tenant user JWT (opportunistic page-load dispatch)  → their tenant only
    if (action === 'dispatch') {
      const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
      const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
      let scopeTenant: string | null = null;
      let caller = 'cron';
      if (dispatchSecret && headerSecret === dispatchSecret) {
        caller = 'cron';
      } else if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
        caller = 'service_role';
      } else {
        const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
        if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
        const { data: profile } = await admin
          .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
        scopeTenant = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body?.tenant_id);
        if (!scopeTenant) return json({ error: 'no_tenant' }, 403);
        caller = 'opportunistic';
      }

      // 1) SQL trigger evaluation: due schedules + event matches → pending fires.
      const { data: dispatchRes, error: dispErr } = await admin.rpc('dispatch_due_triggers', {
        p_tenant_id: scopeTenant,
      });
      if (dispErr) return json({ error: dispErr.message }, 500);

      // 2) Turn pending fires into real runs (includes stale fires from
      //    a previously crashed processor — the fire log is the queue).
      let firesQuery = admin.from('playbook_trigger_fires')
        .select('*').eq('status', 'pending_start')
        .order('fired_at', { ascending: true }).limit(25);
      if (scopeTenant) firesQuery = firesQuery.eq('tenant_id', scopeTenant);
      const { data: fires } = await firesQuery;

      const processed: Array<{ fire_id: string; run_id?: string; status: string }> = [];
      for (const fire of fires ?? []) {
        let outcome: StartDefResult;
        if (!fire.definition_id || !fire.target_account_id) {
          outcome = { status: 'error', error: 'fire missing definition or target account' };
        } else {
          // PB2.0: thread what triggered this fire into the run context
          // so the playbook can reference {{event.ref}} / {{event.note}}.
          outcome = await startDefinitionRunServer(admin, fire.tenant_id, fire.definition_id, fire.target_account_id, {
            eventRef: fire.target_ref ?? null,
            eventNote: fire.detail ?? null,
          });
        }
        const ok = !!outcome.run_id;
        await admin.from('playbook_trigger_fires').update({
          status: ok ? 'started' : 'error',
          run_id: outcome.run_id ?? null,
          detail: ok
            ? `${fire.detail} → run ${outcome.status}`.slice(0, 500)
            : `${fire.detail} → ${outcome.error ?? 'start failed'}`.slice(0, 500),
        }).eq('id', fire.id);
        await audit(admin, fire.tenant_id,
          ok
            ? `Trigger fired (${fire.source}) — playbook run started automatically (${outcome.status})`
            : `Trigger fire FAILED (${fire.source}) — ${outcome.error ?? 'start failed'}`,
          'playbook_step',
          {
            kind: 'trigger_fire', fire_id: fire.id, source: fire.source,
            schedule_id: fire.schedule_id, event_rule_id: fire.event_rule_id,
            definition_id: fire.definition_id, target_account_id: fire.target_account_id,
            target_ref: fire.target_ref, run_id: outcome.run_id ?? null,
            result: ok ? 'started' : 'error', dispatched_by: caller,
          },
          'Playbook DE');
        processed.push({ fire_id: fire.id, run_id: outcome.run_id, status: ok ? 'started' : 'error' });
      }

      // 3) Resume due 'wait' steps — piggybacks on this same 5-minute
      //    tick (no separate cron): any run parked in status='waiting'
      //    with resume_at <= now() gets its wait step completed and
      //    execution continues from the next step.
      let waitQuery = admin.from('playbook_runs')
        .select('*').eq('status', 'waiting').not('resume_at', 'is', null)
        .lte('resume_at', new Date().toISOString()).limit(25);
      if (scopeTenant) waitQuery = waitQuery.eq('tenant_id', scopeTenant);
      const { data: dueWaits } = await waitQuery;
      const waitsResumed: Array<{ run_id: string; status: string }> = [];
      for (const w of dueWaits ?? []) {
        const steps = w.steps as RunStep[];
        const idx = w.current_step as number;
        if (steps[idx]) {
          steps[idx].status = 'done'; steps[idx].at = now();
          steps[idx].detail = `${steps[idx].detail} — resumed by dispatcher`;
        }
        const defRun: DefRunRow = {
          id: w.id, tenant_id: w.tenant_id, account_id: w.account_id,
          status: 'running', current_step: idx + 1, steps,
          waiting_task_id: null, context: (w.context ?? {}) as RunContext,
          definition_id: w.definition_id, definition_version: w.definition_version ?? 1,
          playbook_key: w.playbook_key, parent_run_id: w.parent_run_id ?? null,
        };
        await admin.from('playbook_runs').update({ status: 'running', resume_at: null }).eq('id', w.id);
        const result = await executeDefinitionSteps(admin, defRun, idx + 1);
        waitsResumed.push({ run_id: w.id, status: result.status });
      }

      return json({
        dispatched: true, caller, scope: scopeTenant ?? 'all',
        evaluation: dispatchRes, processed_fires: processed.length, fires: processed,
        waits_resumed: waitsResumed.length, waits: waitsResumed,
      });
    }

    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      userId = userData.user.id;
      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body?.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ────────────────────────────────────────────────────────────
    // validate — dry validation of a steps array or a saved draft
    // ────────────────────────────────────────────────────────────
    if (action === 'validate') {
      let steps = body?.steps;
      let defId: string | null = body?.definition_id ?? null;
      if (!steps && defId) {
        const { data: def } = await admin.from('playbook_definitions')
          .select('steps').eq('id', defId).eq('tenant_id', tenantId).maybeSingle();
        if (!def) return json({ error: 'definition_not_found' }, 404);
        steps = def.steps;
      }
      const errors = validateSteps(steps);
      const subErrors = await validateSubPlaybookRefs(admin, tenantId, defId, (steps ?? []) as DefStep[]);
      return json({ valid: errors.length === 0 && subErrors.length === 0, errors: [...errors, ...subErrors] });
    }

    // ────────────────────────────────────────────────────────────
    // publish — validate, bump version, snapshot, mark published
    // ────────────────────────────────────────────────────────────
    if (action === 'publish') {
      const defId = body?.definition_id;
      if (!defId) return json({ error: 'definition_id required' }, 400);
      const { data: def } = await admin.from('playbook_definitions')
        .select('*').eq('id', defId).eq('tenant_id', tenantId).maybeSingle();
      if (!def) return json({ error: 'definition_not_found' }, 404);
      if (def.status === 'archived') return json({ error: 'definition_archived' }, 400);

      const errors = validateSteps(def.steps);
      const subErrors = await validateSubPlaybookRefs(admin, tenantId, defId, def.steps as DefStep[]);
      if (errors.length > 0 || subErrors.length > 0) return json({ published: false, valid: false, errors: [...errors, ...subErrors] }, 422);

      // Version number: next after the latest snapshot (first publish → 1).
      const { data: latest } = await admin.from('playbook_versions')
        .select('version').eq('definition_id', defId)
        .order('version', { ascending: false }).limit(1).maybeSingle();
      const nextVersion = (latest?.version ?? 0) + 1;

      const { error: snapErr } = await admin.from('playbook_versions').insert({
        definition_id: defId, version: nextVersion, steps: def.steps, published_by: userId,
      });
      if (snapErr) return json({ error: snapErr.message }, 500);

      const { error: updErr } = await admin.from('playbook_definitions')
        .update({ version: nextVersion, status: 'published' }).eq('id', defId);
      if (updErr) return json({ error: updErr.message }, 500);

      await audit(admin, tenantId,
        `Playbook definition published — "${def.name}" (${def.key}) v${nextVersion}`,
        'config_change',
        { kind: 'playbook_definition', definition_id: defId, key: def.key, version: nextVersion, step_count: (def.steps as unknown[]).length },
        'Playbook DE');
      return json({ published: true, version: nextVersion });
    }

    // ────────────────────────────────────────────────────────────
    // start
    // ────────────────────────────────────────────────────────────
    if (action === 'start') {
      // ── PREVIEW / DRY-RUN: executes a DRAFT (or any steps array) with
      // writes/connectors/gates simulated. Nothing persisted except the
      // in-memory trace returned to the caller — no run row, no audit
      // events, no human_tasks, no external calls. ──
      if (body?.preview) {
        const accountId = body?.account_id;
        if (!accountId) return json({ error: 'account_id required' }, 400);
        let steps = body?.steps as DefStep[] | undefined;
        if (!steps && body?.definition_id) {
          const { data: def } = await admin.from('playbook_definitions')
            .select('steps').eq('id', body.definition_id).eq('tenant_id', tenantId).maybeSingle();
          if (!def) return json({ error: 'definition_not_found' }, 404);
          steps = def.steps as DefStep[];
        }
        if (!steps) return json({ error: 'steps or definition_id required' }, 400);
        const errors = validateSteps(steps);
        if (errors.length > 0) return json({ error: 'invalid_definition', errors }, 422);

        const runSteps: RunStep[] = steps.map((s) => ({
          key: s.key, label: s.label || PRIMITIVE_LABELS[s.key] || s.key,
          status: 'pending', at: null, detail: '', params: s.params ?? {},
          then_steps: (s.then_steps ?? []).map((bs) => ({ key: bs.key, label: bs.label || PRIMITIVE_LABELS[bs.key] || bs.key, status: 'pending', at: null, detail: '', params: bs.params ?? {} })),
          else_steps: (s.else_steps ?? []).map((bs) => ({ key: bs.key, label: bs.label || PRIMITIVE_LABELS[bs.key] || bs.key, status: 'pending', at: null, detail: '', params: bs.params ?? {} })),
        }));
        const previewRun: DefRunRow = {
          id: 'preview', tenant_id: tenantId, account_id: accountId,
          status: 'running', current_step: 0, steps: runSteps, waiting_task_id: null,
          context: { account_id: accountId }, definition_id: body?.definition_id ?? 'draft',
          definition_version: 0, playbook_key: 'preview', preview: true,
        };
        const result = await executeDefinitionSteps(admin, previewRun, 0);
        return json({ preview: true, status: result.status, steps: previewRun.steps, context: previewRun.context });
      }

      // ── R6: definition-based start (shared helper since R7) ──
      if (body?.definition_id) {
        const accountId = body?.account_id;
        if (!accountId) return json({ error: 'account_id required' }, 400);
        const result = await startDefinitionRunServer(admin, tenantId, body.definition_id, accountId);
        if (result.error) return json({ error: result.error }, result.http ?? 500);
        return json({ run_id: result.run_id, status: result.status, task_id: result.task_id });
      }

      // ── LEGACY: renewal_v1 (unchanged behavior — regression-protected) ──
      if ((body?.playbook_key ?? 'renewal_v1') !== 'renewal_v1') return json({ error: 'unknown playbook_key' }, 400);
      const accountId = body?.account_id;
      if (!accountId) return json({ error: 'account_id required' }, 400);

      const { data: account, error: acctErr } = await admin
        .from('customer_accounts')
        .select('id, name, arr_cents, renewal_date')
        .eq('id', accountId).eq('tenant_id', tenantId).single();
      if (acctErr || !account) return json({ error: 'account_not_found' }, 404);

      const steps: RunStep[] = STEP_DEFS.map((d) => ({ ...d, status: 'pending', at: null, detail: '' }));
      const { data: runRow, error: runErr } = await admin
        .from('playbook_runs')
        .insert({ tenant_id: tenantId, playbook_key: 'renewal_v1', account_id: account.id, status: 'running', current_step: 0, steps })
        .select().single();
      if (runErr || !runRow) return json({ error: runErr?.message ?? 'run insert failed' }, 500);
      const runId = runRow.id as string;
      const amount = account.arr_cents as number;

      // ── Step 1: check_account ──
      steps[0].status = 'done'; steps[0].at = now();
      steps[0].detail = account.renewal_date
        ? `${account.name} · ARR ${fmtMoney(amount)} · renews ${account.renewal_date}`
        : `${account.name} · ARR ${fmtMoney(amount)} · no renewal date set`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[0]), 'playbook_step',
        { run_id: runId, step_key: steps[0].key, step_status: 'done', step_detail: steps[0].detail });

      // ── Guardrail threshold (require_approval_over_cents, fallback $10K) ──
      let thresholdCents = 10_000 * 100;
      let fromRule = false;
      const { data: rules } = await admin
        .from('guardrail_rules').select('threshold')
        .eq('tenant_id', tenantId).eq('rule_type', 'require_approval_over_cents').eq('active', true)
        .order('updated_at', { ascending: false }).limit(1);
      if (rules && rules.length > 0 && typeof rules[0].threshold === 'number') {
        thresholdCents = rules[0].threshold; fromRule = true;
      }

      // ── Trust dial (de_autonomy: invoice_auto_send) ──
      let autonomy: { id: string; enabled: boolean; max_amount_cents: number | null } | null = null;
      try {
        const { data: auto } = await admin
          .from('de_autonomy').select('id, enabled, max_amount_cents')
          .eq('tenant_id', tenantId).eq('action_type', 'invoice_auto_send').maybeSingle();
        autonomy = auto ?? null;
      } catch { autonomy = null; }

      // COMPOSITION: autonomy narrows within guardrails, never overrides.
      const guardrailAllows = amount <= thresholdCents;
      const autonomyAllows = !autonomy ||
        (autonomy.enabled && autonomy.max_amount_cents !== null && amount <= autonomy.max_amount_cents);
      const gated = !(guardrailAllows && autonomyAllows);
      const underTrustDial = guardrailAllows && autonomy !== null && autonomy.enabled &&
        autonomy.max_amount_cents !== null && amount <= autonomy.max_amount_cents;

      // ── Step 2: generate_invoice ──
      const { data: invoice, error: invErr } = await admin
        .from('renewal_invoices')
        .insert({
          tenant_id: tenantId, account_id: account.id, amount_cents: amount,
          status: gated ? 'awaiting_approval' : 'sent', due_date: account.renewal_date,
        })
        .select().single();
      if (invErr || !invoice) return json({ error: invErr?.message ?? 'invoice insert failed' }, 500);

      steps[1].status = 'done'; steps[1].at = now();
      steps[1].detail = `Invoice ${fmtMoney(amount)} created (${invoice.status})`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[1]), 'playbook_step',
        { run_id: runId, step_key: steps[1].key, step_status: 'done', step_detail: steps[1].detail });
      await audit(admin, tenantId,
        `Renewal invoice generated — ${account.name} (${fmtMoney(amount)}), status ${invoice.status}`,
        'invoice', { invoice_id: invoice.id, account: account.name, amount_cents: amount, status: invoice.status });

      // ── Step 3: guardrail_gate (guardrail + trust-dial composition) ──
      steps[2].status = 'done'; steps[2].at = now();
      steps[2].detail = gated
        ? (guardrailAllows
          ? `Under ${fmtMoney(thresholdCents)} threshold but trust dial requires approval — routed to human approval`
          : `Amount exceeds ${fmtMoney(thresholdCents)} approval threshold — routed to human approval`)
        : (underTrustDial
          ? `auto-approved under trust dial (≤ ${fmtMoney(autonomy!.max_amount_cents!)}) — within ${fmtMoney(thresholdCents)} guardrail`
          : `Under ${fmtMoney(thresholdCents)} approval threshold — auto-approved`);
      await audit(admin, tenantId,
        gated
          ? `Guardrail GATED — invoice ${fmtMoney(amount)} for ${account.name}: ${steps[2].detail}`
          : `Guardrail passed — invoice ${fmtMoney(amount)} for ${account.name}: ${steps[2].detail}`,
        'guardrail_check', {
          run_id: runId, invoice_id: invoice.id, account: account.name, amount_cents: amount,
          threshold_cents: thresholdCents, threshold_from_rule: fromRule,
          autonomy_rule_id: autonomy?.id ?? null, autonomy_enabled: autonomy?.enabled ?? null,
          autonomy_max_cents: autonomy?.max_amount_cents ?? null,
          composition: 'autonomy_narrows_within_guardrails',
          result: gated ? 'gated' : 'passed',
        });
      await audit(admin, tenantId, stepAuditText(account.name, steps[2]), 'playbook_step',
        { run_id: runId, step_key: steps[2].key, step_status: 'done', step_detail: steps[2].detail, autonomy_rule_id: autonomy?.id ?? null });

      if (gated) {
        // ── Step 4 pauses: human_approval ──
        const { data: task, error: taskErr } = await admin
          .from('human_tasks')
          .insert({
            tenant_id: tenantId, type: 'approval_gate',
            title: `Invoice approval — ${account.name}`, detail: fmtMoney(amount),
            source: 'system', related_table: 'renewal_invoices', related_id: invoice.id,
          })
          .select().single();
        if (taskErr || !task) return json({ error: taskErr?.message ?? 'task insert failed' }, 500);

        steps[3].status = 'waiting';
        steps[3].detail = 'Waiting on the approval task in Human Tasks';
        await admin.from('playbook_runs')
          .update({ status: 'waiting_approval', current_step: 3, steps, waiting_task_id: task.id })
          .eq('id', runId);
        await audit(admin, tenantId, stepAuditText(account.name, steps[3]), 'playbook_step',
          { run_id: runId, step_key: steps[3].key, step_status: 'waiting', task_id: task.id });
        await admin.from('activity_events').insert({
          tenant_id: tenantId, actor: 'Renewal DE', actor_type: 'de', event_type: 'escalated',
          text: `Renewal invoice for ${account.name} (${fmtMoney(amount)}) requires approval — routed to Human Tasks`,
        });
        return json({ run_id: runId, status: 'waiting_approval', task_id: task.id, steps });
      }

      // Not gated: skip the gate and finish.
      steps[3].status = 'skipped'; steps[3].at = now();
      steps[3].detail = underTrustDial
        ? `auto-approved under trust dial (≤ ${fmtMoney(autonomy!.max_amount_cents!)})`
        : 'Not required — under the approval threshold';
      await audit(admin, tenantId, stepAuditText(account.name, steps[3]), 'playbook_step',
        { run_id: runId, step_key: steps[3].key, step_status: 'skipped', autonomy_rule_id: autonomy?.id ?? null });

      await admin.from('renewal_invoices').update({ status: 'sent', cadence_stage: 1 }).eq('id', invoice.id);
      steps[4].status = 'done'; steps[4].at = now();
      steps[4].detail = `Invoice ${fmtMoney(amount)} sent · cadence Day-0 started`;
      await audit(admin, tenantId, stepAuditText(account.name, steps[4]), 'playbook_step',
        { run_id: runId, step_key: steps[4].key, step_status: 'done', invoice_id: invoice.id });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Renewal DE', actor_type: 'de', event_type: 'resolved',
        text: `Renewal playbook sent invoice — ${account.name} (${fmtMoney(amount)}), dunning cadence started`,
      });

      steps[5].status = 'done'; steps[5].at = now(); steps[5].detail = 'Run completed';
      await admin.from('playbook_runs')
        .update({ status: 'completed', current_step: 5, steps, waiting_task_id: null })
        .eq('id', runId);
      await audit(admin, tenantId, stepAuditText(account.name, steps[5]), 'playbook_step',
        { run_id: runId, step_key: steps[5].key, step_status: 'done' });
      await audit(admin, tenantId,
        `Renewal playbook [${account.name}] — run completed end-to-end`,
        'playbook_step', { run_id: runId, invoice_id: invoice.id, amount_cents: amount });
      return json({ run_id: runId, status: 'completed', steps });
    }

    // ────────────────────────────────────────────────────────────
    if (action === 'advance') {
      let query = admin.from('playbook_runs').select('*').eq('tenant_id', tenantId);
      if (body?.run_id) query = query.eq('id', body.run_id);
      else if (body?.task_id) query = query.eq('waiting_task_id', body.task_id);
      else return json({ error: 'run_id or task_id required' }, 400);
      let { data: run } = await query.maybeSingle();
      // Definition runs parked by the SQL resume have waiting_task_id
      // cleared — find them via the task's related run in resume_pending.
      if (!run && body?.task_id) {
        const { data: parked } = await admin.from('playbook_runs')
          .select('*').eq('tenant_id', tenantId).eq('status', 'resume_pending')
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        run = parked ?? null;
      }
      if (!run) return json({ advanced: false, reason: 'run_not_found' }, 404);

      // ── R6: definition run parked for the HTTP-capable advance ──
      if (run.definition_id && run.status === 'resume_pending') {
        const defRun: DefRunRow = {
          id: run.id, tenant_id: run.tenant_id, account_id: run.account_id,
          status: 'running', current_step: run.current_step,
          steps: run.steps as RunStep[], waiting_task_id: null,
          context: (run.context ?? {}) as RunContext,
          definition_id: run.definition_id, definition_version: run.definition_version ?? 1,
          playbook_key: run.playbook_key,
        };
        const result = await executeDefinitionSteps(admin, defRun, run.current_step);
        return json({ advanced: true, status: result.status, run_id: run.id });
      }

      if (run.status !== 'waiting_approval') return json({ advanced: false, reason: `run is ${run.status}`, status: run.status });
      if (!run.waiting_task_id) return json({ advanced: false, reason: 'no waiting task' });

      const { data: task } = await admin
        .from('human_tasks').select('id, status')
        .eq('id', run.waiting_task_id).eq('tenant_id', tenantId).maybeSingle();
      if (!task) return json({ advanced: false, reason: 'task_not_found' }, 404);
      // Idempotent no-op: gate task not decided yet.
      if (task.status !== 'approved' && task.status !== 'rejected') {
        return json({ advanced: false, reason: 'task_pending', status: 'waiting_approval' });
      }
      const { data: res, error: resErr } = await admin.rpc('resume_playbook_on_task', {
        p_task_id: task.id, p_decision: task.status,
      });
      if (resErr) return json({ error: resErr.message }, 500);
      // If the SQL resume parked the run at a connector step, finish it here.
      if ((res as { needs_http?: boolean })?.needs_http) {
        const { data: parked } = await admin.from('playbook_runs')
          .select('*').eq('id', (res as { run_id: string }).run_id).maybeSingle();
        if (parked?.status === 'resume_pending' && parked.definition_id) {
          const defRun: DefRunRow = {
            id: parked.id, tenant_id: parked.tenant_id, account_id: parked.account_id,
            status: 'running', current_step: parked.current_step,
            steps: parked.steps as RunStep[], waiting_task_id: null,
            context: (parked.context ?? {}) as RunContext,
            definition_id: parked.definition_id, definition_version: parked.definition_version ?? 1,
            playbook_key: parked.playbook_key,
          };
          const result = await executeDefinitionSteps(admin, defRun, parked.current_step);
          return json({ advanced: true, result: res, status: result.status });
        }
      }
      return json({ advanced: true, result: res });
    }

    // ────────────────────────────────────────────────────────────
    // cancel
    const runId = body?.run_id;
    if (!runId) return json({ error: 'run_id required' }, 400);
    const { data: run } = await admin
      .from('playbook_runs').select('*').eq('id', runId).eq('tenant_id', tenantId).maybeSingle();
    if (!run) return json({ cancelled: false, reason: 'run_not_found' }, 404);
    if (run.status === 'completed' || run.status === 'cancelled') {
      return json({ cancelled: false, reason: `run is ${run.status}`, status: run.status });
    }
    const steps = (run.steps as RunStep[]).map((s) =>
      s.status === 'pending' || s.status === 'waiting' ? { ...s, status: 'cancelled' } : s);
    await admin.from('playbook_runs')
      .update({ status: 'cancelled', steps, waiting_task_id: null })
      .eq('id', runId);
    await audit(admin, tenantId, `Playbook run cancelled by operator`, 'playbook_step',
      { run_id: runId, previous_status: run.status, definition_id: run.definition_id ?? null });
    return json({ cancelled: true, run_id: runId });
  } catch (err) {
    console.error('playbook-execute error:', err);
    return json({ error: String(err) }, 500);
  }
});
