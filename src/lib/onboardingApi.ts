// ============================================================
// Customer Onboarding — LIVE data layer (migration 022).
// Templated implementation checklists run against customer accounts:
// versioned template publish (immutable snapshots), per-item status /
// assignee / note, sign-off gates via human_tasks (review_gate), and
// server-side auto-completion. All mutations go through SECURITY
// DEFINER RPCs so audit + activity events are appended server-side.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type OnboardingPhase = 'kickoff' | 'data' | 'config' | 'validation' | 'golive';
export type OnboardingOwnerType = 'human' | 'de' | 'either';
export type OnboardingItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'signed_off';
export type OnboardingProjectStatus = 'active' | 'on_hold' | 'completed' | 'cancelled';

export const PHASES: Array<{ key: OnboardingPhase; label: string }> = [
  { key: 'kickoff', label: 'Kickoff' },
  { key: 'data', label: 'Data' },
  { key: 'config', label: 'Configuration' },
  { key: 'validation', label: 'Validation' },
  { key: 'golive', label: 'Go-live' },
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

export async function installStarterTemplate(): Promise<{ template_id: string; already_installed: boolean }> {
  const { data, error } = await supabase.rpc('install_starter_onboarding_template');
  if (error) raise('installStarterTemplate', error);
  notify();
  return data as { template_id: string; already_installed: boolean };
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
    .select('*, customer_accounts(name)')
    .eq('tenant_id', tid).eq('id', projectId).maybeSingle();
  if (error) raise('getProject', error);
  return (data as OnboardingProject) ?? null;
}

export async function getProjectForAccount(accountId: string): Promise<OnboardingProject | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('onboarding_projects')
    .select('id, name, status, progress_pct, tenant_id, account_id, template_version_id, target_golive, items_state, completed_at, created_at, updated_at')
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
  const { data, error } = await supabase.functions.invoke('onboarding-verify', {
    body: { action: 'check_item', project_id: projectId, key },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { const body = await ctx.json(); notify(); return body as CheckItemResult; } catch { /* fallthrough */ }
    }
    raise('checkItemNow', { message: error.message ?? String(error) });
  }
  notify();
  return data as CheckItemResult;
}

// ── Display helpers ───────────────────────────────────────────────

export function phaseOfItem(items: TemplateItem[], key: string): OnboardingPhase {
  return items.find(i => i.key === key)?.phase ?? 'kickoff';
}

/** Current phase = first phase with an unfinished item (or 'golive' when done). */
export function currentPhase(items: TemplateItem[], state: ProjectItemState[]): OnboardingPhase {
  for (const p of PHASES) {
    const keys = items.filter(i => i.phase === p.key).map(i => i.key);
    if (keys.some(k => {
      const s = state.find(x => x.key === k);
      return !s || (s.status !== 'done' && s.status !== 'signed_off');
    })) return p.key;
  }
  return 'golive';
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}
