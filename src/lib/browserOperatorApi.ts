// Browser Operator — the human surface over the mig-182 computer-use governance
// specialised for browser tasks (mig 241). Every task still flows
// propose → human approval → claim (active runtime only) → run → step audit;
// nothing here can bypass the database gate. Reads are RLS-scoped; the
// propose/approve writes go through the audited RPCs + human_tasks.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export type BrowserEngine = 'browser_dom' | 'browser_vision' | 'desktop';
export type CredentialPolicy = 'none' | 'vault_injected' | 'human_login';
export type BrowserTaskStatus =
  | 'pending_approval' | 'approved' | 'rejected' | 'claimed' | 'running' | 'done' | 'failed' | 'expired';

export interface BrowserTaskRow {
  id: string;
  de_id: string | null;
  de_name: string | null;
  title: string | null;
  goal: string;
  allowed_domains: string[];
  max_steps: number;
  engine: BrowserEngine;
  credential_policy: CredentialPolicy;
  status: BrowserTaskStatus;
  human_task_id: string | null;
  approval_status: string | null;
  runtime_id: string | null;
  runtime_name: string | null;
  steps: number;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrowserRuntime {
  id: string;
  name: string;
  kind: 'browser' | 'desktop';
  engine: string;
  active: boolean;        // active AND heart-beat within 5 min
  last_seen: string | null;
}

export interface BrowserAuditStep {
  step?: number;
  action?: string;
  url?: string;
  screenshot_ref?: string;
  note?: string;
  at?: string;
  [k: string]: unknown;
}

export interface BrowserTaskDetail extends BrowserTaskRow {
  audit: BrowserAuditStep[];
}

export interface BrowserOperatorState {
  enabled: boolean;
  tasks: BrowserTaskRow[];
  runtimes: BrowserRuntime[];
}

export interface DeLite { id: string; name: string }

/** Tasks + runtimes + feature flag for the monitor UI (mig 241 read RPC). */
export async function getBrowserOperator(limit = 50): Promise<BrowserOperatorState> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('list_browser_operator', { p_tenant_id: tid, p_limit: limit });
  if (error) throw new Error(error.message);
  const res = data as { ok?: boolean; error?: string; enabled?: boolean; tasks?: BrowserTaskRow[]; runtimes?: BrowserRuntime[] } | null;
  if (!res?.ok) throw new Error(res?.error || 'Could not load Browser Operator.');
  return { enabled: res.enabled ?? false, tasks: res.tasks ?? [], runtimes: res.runtimes ?? [] };
}

/** The full step-by-step audit for one task — the "replay". */
export async function getBrowserTask(taskId: string): Promise<BrowserTaskDetail | null> {
  const { data, error } = await supabase.rpc('get_browser_task', { p_task_id: taskId });
  if (error) throw new Error(error.message);
  const res = data as { ok?: boolean; task?: BrowserTaskDetail } | null;
  if (!res?.ok || !res.task) return null;
  const t = res.task as BrowserTaskDetail;
  return { ...t, audit: Array.isArray(t.audit) ? t.audit : [] };
}

export interface ProposeBrowserTaskInput {
  deId: string;
  goal: string;
  allowedDomains: string[];
  maxSteps?: number;
  engine?: BrowserEngine;
  credentialPolicy?: CredentialPolicy;
  title?: string;
}

/** Launch a governed browser task (tenant admin). Lands as pending_approval. */
export async function proposeBrowserTask(input: ProposeBrowserTaskInput): Promise<string> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('propose_browser_task', {
    p_tenant_id: tid,
    p_de_id: input.deId,
    p_goal: input.goal,
    p_allowed_domains: input.allowedDomains,
    p_max_steps: input.maxSteps ?? 15,
    p_engine: input.engine ?? 'browser_dom',
    p_credential_policy: input.credentialPolicy ?? 'none',
    p_title: input.title ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Approve/reject the task's human_task gate; the DB trigger syncs the task. */
export async function decideBrowserTask(humanTaskId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('human_tasks')
    .update({ status: decision, decided_by: user?.id ?? null, decided_at: new Date().toISOString() })
    .eq('id', humanTaskId).eq('tenant_id', tid);
  if (error) throw new Error(error.message);
}

/** Active DEs for the launch form. */
export async function listDEsLite(): Promise<DeLite[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('digital_employees')
    .select('id, name').eq('tenant_id', tid).eq('status', 'active').order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as DeLite[];
}

// ── Operate config (mig 244): which connected apps a DE may drive via web UI ──
export interface OperateSystem {
  id: string;
  system_key: string;
  label: string;
  binding_kind: 'internal_table' | 'connector';
  can_operate: boolean;
  can_read: boolean;
  can_write: boolean;
  active: boolean;
  operate_domain: string | null;   // the raw override (what the admin typed)
  resolved_domain: string | null;  // effective domain (override, else connector host)
  connector_id: string | null;
  connector_name: string | null;
  has_login: boolean;              // a Vault UI-login is stored (value never exposed)
  operate_only: boolean;           // created by this feature (safe to delete)
}
export interface OperateConnector { id: string; name: string; base_url: string | null }
export interface DeOperateConfig {
  de: { id: string; name: string };
  featureEnabled: boolean;
  systems: OperateSystem[];
  connectors: OperateConnector[];
}

/** Read a DE's operate bindings + the tenant's connectors (admin). */
export async function getDeOperateConfig(deId: string): Promise<DeOperateConfig> {
  const { data, error } = await supabase.rpc('list_de_operate_config', { p_de_id: deId });
  if (error) throw new Error(error.message);
  const r = data as {
    ok?: boolean; error?: string; de?: { id: string; name: string }; feature_enabled?: boolean;
    systems?: OperateSystem[]; connectors?: OperateConnector[];
  } | null;
  if (!r?.ok) throw new Error(r?.error || 'Could not load operate config.');
  return {
    de: r.de ?? { id: deId, name: 'DE' },
    featureEnabled: r.feature_enabled ?? false,
    systems: r.systems ?? [],
    connectors: r.connectors ?? [],
  };
}

export interface UpsertOperateBindingInput {
  deId: string;
  systemId?: string | null;   // null → create a new operate-only binding
  systemKey?: string;         // required when creating
  label?: string;
  canOperate: boolean;
  operateDomain?: string | null;
  connectorId?: string | null;
}

/** Create or update an operate binding (admin). Returns the binding id. */
export async function upsertOperateBinding(input: UpsertOperateBindingInput): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_de_operate_binding', {
    p_de_id: input.deId,
    p_system_id: input.systemId ?? null,
    p_system_key: input.systemKey ?? null,
    p_label: input.label ?? null,
    p_can_operate: input.canOperate,
    p_operate_domain: input.operateDomain ?? null,
    p_connector_id: input.connectorId ?? null,
  });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string; system_id?: string } | null;
  if (!r?.ok) throw new Error(r?.error || 'Could not save the binding.');
  return r.system_id as string;
}

/** Store (or replace) the Vault UI-login for a binding. Value never leaves here. */
export async function setOperateLogin(systemId: string, secret: string): Promise<void> {
  const { data, error } = await supabase.rpc('set_de_operate_login', { p_system_id: systemId, p_secret: secret });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string } | null;
  if (!r?.ok) throw new Error(r?.error || 'Could not save the login.');
}

/** Remove a binding's stored login (falls back to human_login). */
export async function clearOperateLogin(systemId: string): Promise<void> {
  const { data, error } = await supabase.rpc('clear_de_operate_login', { p_system_id: systemId });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string } | null;
  if (!r?.ok) throw new Error(r?.error || 'Could not remove the login.');
}

/** Delete an operate-only binding (admin). */
export async function deleteOperateBinding(systemId: string): Promise<void> {
  const { data, error } = await supabase.rpc('delete_de_operate_binding', { p_system_id: systemId });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string } | null;
  if (!r?.ok) throw new Error(r?.error || 'Could not delete the binding.');
}
