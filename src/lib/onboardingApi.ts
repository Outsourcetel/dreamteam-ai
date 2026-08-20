// ============================================================
// Customer Onboarding — LIVE data layer (migration 022).
// Templated implementation checklists run against customer accounts:
// versioned template publish (immutable snapshots), per-item status /
// assignee / note, sign-off gates via human_tasks (review_gate), and
// server-side auto-completion. All mutations go through SECURITY
// DEFINER RPCs so audit + activity events are appended server-side.
// ============================================================
import { supabase } from '../supabase';
import { invokeEdge } from './invokeEdge';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type OnboardingPhase = 'kickoff' | 'data' | 'config' | 'validation' | 'golive' | 'handoff';
export type OnboardingOwnerType = 'human' | 'de' | 'either';
export type OnboardingItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'signed_off';
export type OnboardingProjectStatus = 'active' | 'on_hold' | 'completed' | 'cancelled';

/**
 * The phase vocabulary, in order. This array IS the ordering: the phase rail,
 * the "past phase" styling, the editor's dropdown and currentPhase below all
 * read it, so a phase is added here and nowhere else on the client.
 * `handoff` (mig 685) comes after go-live on purpose — onboarding is not over
 * when the system is live, it is over when support and success own the
 * customer. The server's matching allow-list lives in
 * public.validate_onboarding_items.
 */
export const PHASES: Array<{ key: OnboardingPhase; label: string }> = [
  { key: 'kickoff', label: 'Kickoff' },
  { key: 'data', label: 'Data' },
  { key: 'config', label: 'Configuration' },
  { key: 'validation', label: 'Validation' },
  { key: 'golive', label: 'Go-live' },
  { key: 'handoff', label: 'Handoff' },
];

export type VerifyMatch = 'exists' | 'contains';

/**
 * Connector-verified provisioning (gap-analysis item 10): when present,
 * this item completes only when a real read-through check against a
 * connected system passes — not when a human picks "Done." Reuses
 * category_op's canonical search/get shape: query_template for a
 * 'search'-kind op, ref_template for a 'get'-kind op (see
 * src/lib/categoryContracts.ts for which ops are which kind).
 * {{account.name}} is the only template token supported today.
 */
export interface VerifyConfig {
  category: string;
  op: string;
  query_template?: string;
  ref_template?: string;
  match: VerifyMatch;
  contains_text?: string;
}

export interface TemplateItem {
  key: string;
  label: string;
  phase: OnboardingPhase;
  owner_type: OnboardingOwnerType;
  requires_signoff: boolean;
  description?: string;
  verify?: VerifyConfig;
  /** mig 674 — the verb this item performs, resolved per tenant at run time.
   *  Only valid when owner_type === 'de'; validate_onboarding_items enforces
   *  that server-side at publish time. */
  action_key?: string;
  /** param name → '@account' | '@ask' | literal. Every REQUIRED param of the
   *  bound verb must appear as a key (named, not necessarily answered yet —
   *  '@ask' satisfies this); optional params may be omitted entirely. */
  params?: Record<string, string>;
}

export interface OnboardingTemplate {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  items: TemplateItem[];
  version: number;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
}

export interface TemplateVersion {
  id: string;
  template_id: string;
  tenant_id: string;
  version: number;
  name: string;
  description: string;
  items: TemplateItem[];
  published_at: string;
}

export interface ProjectItemState {
  key: string;
  status: OnboardingItemStatus;
  assignee: string | null;
  note?: string;
  done_at?: string;
  signed_off_by?: string;
  signed_off_at?: string;
  signoff_task_id?: string | null;
  /** Set only when this item's completion came from apply_onboarding_verification,
   *  never from a human status change — the honest signal gap #10 exists for. */
  verified_by?: 'system';
  verified_at?: string;
  last_check_at?: string;
  last_check_result?: 'verified' | 'not_yet';
  verify_detail?: string;
}

export interface OnboardingProject {
  id: string;
  tenant_id: string;
  account_id: string;
  template_version_id: string;
  name: string;
  status: OnboardingProjectStatus;
  target_golive: string | null;
  items_state: ProjectItemState[];
  progress_pct: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** joined account (select alias) */
  customer_accounts?: { name: string } | null;
  /** mig 674 — answers to bound items' '@ask' params, keyed
   *  '<action_key>.<param>'. See resolveParams in onboardingTypes.ts. */
  requirements: Record<string, string>;
}

export interface ItemUpdateResult {
  project: OnboardingProject;
  signoff_task_id: string | null;
  completed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────

import { raise, requireTenantId } from './liveShared';


const notify = () => { try { window.dispatchEvent(new Event('dt-state-changed')); } catch { /* noop */ } };

/** Server RPCs return {error: '...'} for expected failures — surface them. */
function expectOk<T extends { error?: string }>(context: string, data: T): T {
  if (data?.error) raise(context, { message: data.error.replace(/_/g, ' ') });
  return data;
}

// ── Templates ─────────────────────────────────────────────────────

export async function listTemplates(): Promise<OnboardingTemplate[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_templates').select('*').eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listTemplates', error);
  return (data ?? []) as OnboardingTemplate[];
}

export async function createTemplate(name: string, description: string): Promise<OnboardingTemplate> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_templates')
    .insert({ tenant_id: tid, name, description, items: [] })
    .select().single();
  if (error) raise('createTemplate', error);
  return data as OnboardingTemplate;
}

/** Saves the DRAFT (items/name/description). Published snapshots are immutable. */
export async function saveTemplateDraft(
  id: string,
  updates: { name?: string; description?: string; items?: TemplateItem[] },
): Promise<OnboardingTemplate> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_templates')
    .update({ ...updates, status: 'draft' })
    .eq('id', id).eq('tenant_id', tid)
    .select().single();
  if (error) raise('saveTemplateDraft', error);
  return data as OnboardingTemplate;
}

export async function deleteTemplate(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('onboarding_templates').delete().eq('id', id).eq('tenant_id', tid);
  if (error) raise('deleteTemplate', error);
}

export interface PublishResult { version_id?: string; version?: number; errors?: string[] }

/** Server-side validation: 1-50 items, ≥1 go-live item, sign-off items human/either, unique keys. */
export async function publishTemplate(id: string): Promise<PublishResult> {
  const { data, error } = await supabase.rpc('publish_onboarding_template', { p_template_id: id });
  if (error) raise('publishTemplate', error);
  const res = data as PublishResult & { error?: string };
  if (res?.error) raise('publishTemplate', { message: res.error.replace(/_/g, ' ') });
  notify();
  return res;
}

/**
 * How this workspace's starter template compares to the canonical one (mig 817).
 *
 *   installed — this call created it.
 *   current   — it is there and its items ARE the canonical list.
 *   outdated  — it is there, provably unedited, and `behind_by` canonical items
 *               are missing. THIS IS THE STATE THAT USED TO REPORT AS PLAIN
 *               SUCCESS: install_starter_onboarding_template answered
 *               `already_installed: true` and handed back the old template id,
 *               so four workspaces sat six items behind for a month with
 *               nothing anywhere saying so.
 *   divergent — it is there and it carries local edits. Not a failure; somebody
 *               made this template theirs, and the upgrade refuses to touch it.
 *   absent    — there is no starter template here.
 *
 * The vocabulary is mig 712's, not a new one: `installed ≠ current` is the same
 * distinction as that build's `answered ≠ resolved` — a state that looks
 * finished and is not.
 */
export type StarterTemplateStatus =
  | 'installed' | 'current' | 'outdated' | 'divergent' | 'absent';

export interface StarterTemplateState {
  ok: boolean;
  status: StarterTemplateStatus;
  template_id: string | null;
  template_status: 'draft' | 'published' | null;
  canon_items: number;
  tenant_items: number;
  /** How many canonical items this workspace does not have. */
  behind_by: number;
  missing_keys: string[];
  modified_keys: string[];
  extra_keys: string[];
  edited: boolean;
  edit_signals: string[];
  upgrade_available: boolean;
  /** install() only. */
  already_installed?: boolean;
  installed?: boolean;
}

export interface StarterUpgradeResult extends StarterTemplateState {
  changed: boolean;
  refused: boolean;
  reason?: string;
  message?: string;
  errors?: string[];
  was_status?: StarterTemplateStatus;
  items_before?: number;
  items_after?: number;
  added_keys?: string[];
  republished?: boolean;
  description_updated?: boolean;
}

export async function installStarterTemplate(): Promise<StarterTemplateState> {
  const { data, error } = await supabase.rpc('install_starter_onboarding_template');
  if (error) raise('installStarterTemplate', error);
  notify();
  return data as StarterTemplateState;
}

/** Read-only: what state is this workspace's starter template in? No writes. */
export async function starterTemplateStatus(): Promise<StarterTemplateState> {
  const { data, error } = await supabase.rpc('starter_onboarding_template_status');
  if (error) raise('starterTemplateStatus', error);
  return data as StarterTemplateState;
}

/**
 * Add the canonical items this workspace is missing. Owner/admin only.
 *
 * ⛔ Refuses outright when the template carries local edits, unless
 * `preserveEdits` is passed — and even then it is a KEY-WISE MERGE that only
 * ADDS: an item that already exists is never rewritten. A refusal comes back as
 * `ok: false`, and this wrapper throws on it, because a caller that ignores the
 * result is exactly how the original defect stayed invisible.
 */
export async function upgradeStarterTemplate(
  preserveEdits = false,
): Promise<StarterUpgradeResult> {
  const { data, error } = await supabase.rpc('upgrade_starter_onboarding_template', {
    p_preserve_edits: preserveEdits,
  });
  if (error) raise('upgradeStarterTemplate', error);
  const res = data as StarterUpgradeResult;
  if (res?.ok === false) {
    raise('upgradeStarterTemplate', {
      message: res.message || res.reason?.replace(/_/g, ' ') || 'the upgrade was refused',
    });
  }
  notify();
  return res;
}

/**
 * Record a decision to STAY on the current list. Owner/admin only. The
 * acknowledgement stores both item hashes and lapses if either side moves, so
 * it cannot outlive the comparison it was about.
 */
export async function acknowledgeStarterBaseline(note?: string): Promise<StarterTemplateState> {
  const { data, error } = await supabase.rpc('acknowledge_starter_template_baseline', {
    p_note: note ?? null,
  });
  if (error) raise('acknowledgeStarterBaseline', error);
  const res = data as StarterTemplateState & { message?: string };
  if (res?.ok === false) raise('acknowledgeStarterBaseline', { message: res.message || 'refused' });
  notify();
  return res;
}

export async function listPublishedVersions(): Promise<TemplateVersion[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_template_versions').select('*').eq('tenant_id', tid)
    .order('published_at', { ascending: false });
  if (error) raise('listPublishedVersions', error);
  return (data ?? []) as TemplateVersion[];
}

export async function getTemplateVersion(id: string): Promise<TemplateVersion | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_template_versions').select('*').eq('tenant_id', tid).eq('id', id).maybeSingle();
  if (error) raise('getTemplateVersion', error);
  return (data as TemplateVersion) ?? null;
}

// ── Projects ──────────────────────────────────────────────────────

export async function listProjects(): Promise<OnboardingProject[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_projects')
    // '*' already carries the new `requirements` column — nothing to add here.
    .select('*, customer_accounts(name)')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listProjects', error);
  return (data ?? []) as OnboardingProject[];
}

export async function getProject(projectId: string): Promise<OnboardingProject | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_projects')
    // '*' already carries the new `requirements` column — nothing to add here.
    .select('*, customer_accounts(name)')
    .eq('tenant_id', tid).eq('id', projectId).maybeSingle();
  if (error) raise('getProject', error);
  return (data as OnboardingProject) ?? null;
}

export async function getProjectForAccount(accountId: string): Promise<OnboardingProject | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_projects')
    .select('id, name, status, progress_pct, tenant_id, account_id, template_version_id, target_golive, items_state, requirements, completed_at, created_at, updated_at')
    .eq('tenant_id', tid).eq('account_id', accountId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) raise('getProjectForAccount', error);
  return (data as OnboardingProject) ?? null;
}

export async function createProject(
  accountId: string,
  versionId: string,
  name?: string,
  targetGolive?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_onboarding_project', {
    p_account_id: accountId,
    p_version_id: versionId,
    p_name: name || null,
    p_target: targetGolive || null,
  });
  if (error) raise('createProject', error);
  const res = expectOk('createProject', data as { project_id: string; error?: string });
  notify();
  return res.project_id;
}

/**
 * Update one checklist item. Server appends ONE activity event per status
 * transition (assignee/note-only edits are silent), creates the sign-off
 * human task when a requires_signoff item is marked done, and auto-completes
 * the project when everything is done/signed off.
 */
export async function updateItem(
  projectId: string,
  key: string,
  changes: { status?: OnboardingItemStatus; assignee?: string; note?: string },
): Promise<ItemUpdateResult> {
  const { data, error } = await supabase.rpc('update_onboarding_item', {
    p_project_id: projectId,
    p_key: key,
    p_status: changes.status ?? null,
    p_assignee: changes.assignee ?? null,
    p_note: changes.note ?? null,
  });
  if (error) raise('updateItem', error);
  const res = expectOk('updateItem', data as ItemUpdateResult & { error?: string });
  notify();
  return res;
}

/**
 * Records a human's answers to bound items' '@ask' params (mig 674), keyed
 * '<action_key>.<param>' — see resolveParams in onboardingTypes.ts, the same
 * convention perform_onboarding_item reads server-side. A plain table write
 * rather than an RPC: there is no state machine here, just an answer sheet,
 * and RLS plus the tenant_id filter below are the only gates it needs.
 */
export async function saveRequirements(
  projectId: string,
  requirements: Record<string, string>,
): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('onboarding_projects')
    .update({ requirements })
    .eq('id', projectId).eq('tenant_id', tid);
  if (error) raise('saveRequirements', error);
  notify();
}

export async function setProjectStatus(
  projectId: string,
  status: 'active' | 'on_hold' | 'cancelled',
): Promise<void> {
  const { data, error } = await supabase.rpc('set_onboarding_project_status', {
    p_project_id: projectId,
    p_status: status,
  });
  if (error) raise('setProjectStatus', error);
  expectOk('setProjectStatus', data as { error?: string });
  notify();
}

/**
 * Sign-off resolution hook — called from decideHumanTask (alongside the
 * playbook resume hook, never replacing it) when the decided task belongs
 * to an onboarding project. Approve → item signed_off (+ possible project
 * completion); reject → item back to in_progress with a rework note.
 */
export async function resolveOnboardingSignoff(
  taskId: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_onboarding_signoff', {
    p_task_id: taskId,
    p_decision: decision,
  });
  if (error) {
    console.error('resolveOnboardingSignoff:', error.message);
    return; // best-effort hook — the task decision itself already persisted
  }
  const res = data as { error?: string } | null;
  if (res?.error) console.warn('resolveOnboardingSignoff:', res.error);
  notify();
}

/**
 * Runs the connector-verified check for one item right now (the
 * project page's "Check now" button) — same check the 5-minute
 * dispatch cron runs automatically for verify-configured items on
 * active projects. Never flips status on a human's word; only a real
 * matching read-through result does.
 */
export interface CheckItemResult {
  ok: boolean;
  verified?: boolean;
  skipped?: string;
  detail: string;
  error?: string;
}
export async function checkItemNow(projectId: string, key: string): Promise<CheckItemResult> {
  const tid = await getSessionTenantId();
  const { data, error } = await invokeEdge('onboarding-verify', {
    body: tid ? { action: 'check_item', project_id: projectId, key, tenant_id: tid } : { action: 'check_item', project_id: projectId, key },
  });
  if (error) {
    // check_item answers some refusals as structured non-2xx JSON that IS a
    // renderable CheckItemResult.
    if (error.body) { notify(); return error.body as unknown as CheckItemResult; }
    raise('checkItemNow', { message: error.message });
  }
  notify();
  return data as CheckItemResult;
}

// ── Display helpers ───────────────────────────────────────────────

export function phaseOfItem(items: TemplateItem[], key: string): OnboardingPhase {
  return items.find(i => i.key === key)?.phase ?? 'kickoff';
}

/**
 * Current phase = first phase with an unfinished item, or the LAST phase when
 * everything is done. That fallback used to be the literal 'golive'; with the
 * handoff phase (mig 685) a finished project would have reported itself one
 * phase short of the end, so it now reads the ordering from PHASES rather than
 * naming a phase that only happened to be last.
 */
export function currentPhase(items: TemplateItem[], state: ProjectItemState[]): OnboardingPhase {
  for (const p of PHASES) {
    const keys = items.filter(i => i.phase === p.key).map(i => i.key);
    if (keys.some(k => {
      const s = state.find(x => x.key === k);
      return !s || (s.status !== 'done' && s.status !== 'signed_off');
    })) return p.key;
  }
  return PHASES[PHASES.length - 1].key;
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}
