// Governed data access — the worker only ever calls the mig-182/241/242 RPCs, so
// the database stays the authority on approval, active-runtime and audit. No raw
// table writes.
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface BrowserTask {
  id: string;
  tenant_id: string;
  de_id: string | null;
  goal: string;
  allowed_domains: string[];
  max_steps: number;
  engine: 'browser_dom' | 'browser_vision';
  credential_policy: 'none' | 'vault_injected' | 'human_login';
}

export interface AuditStep {
  step: number;
  action: string;
  url?: string;
  note?: string;
  screenshot_ref?: string;
  at: string;
}

export class Db {
  private sb: SupabaseClient;
  constructor(url: string, serviceKey: string) {
    this.sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  /** Register (or re-register) this worker as an active runtime. */
  async registerRuntime(name: string, endpoint: string): Promise<string> {
    const { data, error } = await this.sb.rpc('register_computer_use_runtime', {
      p_name: name, p_endpoint: endpoint, p_kind: 'browser', p_engine: 'browser_dom',
    });
    if (error) throw new Error(`registerRuntime: ${error.message}`);
    return data as string;
  }

  async heartbeat(runtimeId: string): Promise<void> {
    const { error } = await this.sb.rpc('heartbeat_computer_use_runtime', { p_runtime_id: runtimeId });
    if (error) throw new Error(`heartbeat: ${error.message}`);
  }

  /** Next approved browser task to attempt (null if none). */
  async nextApprovedTask(): Promise<BrowserTask | null> {
    const { data, error } = await this.sb.rpc('next_approved_browser_task');
    if (error) throw new Error(`nextApprovedTask: ${error.message}`);
    const res = data as { ok?: boolean; task?: BrowserTask | null } | null;
    return res?.task ?? null;
  }

  /** Atomically claim an approved task for this runtime (mig-182 gate). Returns
   * the task detail on success, or null if another worker won the race. */
  async claim(taskId: string, runtimeId: string): Promise<boolean> {
    const { data, error } = await this.sb.rpc('claim_computer_use_task', { p_task_id: taskId, p_runtime_id: runtimeId });
    if (error) return false; // not claimable (raced / not approved / no active runtime)
    return !!(data as { task_id?: string })?.task_id;
  }

  async appendStep(taskId: string, step: AuditStep): Promise<void> {
    const { error } = await this.sb.rpc('append_browser_task_step', { p_task_id: taskId, p_step: step });
    if (error) throw new Error(`appendStep: ${error.message}`);
  }

  async finish(taskId: string, status: 'done' | 'failed', result: string): Promise<void> {
    const { error } = await this.sb.rpc('finish_browser_task', { p_task_id: taskId, p_status: status, p_result: result });
    if (error) throw new Error(`finish: ${error.message}`);
  }

  /** Platform-vault config value (mig 087; service-role only). Lets the worker
   * reuse the SAME provider key the edge functions use (aiKeys.ts pattern) —
   * no local copy of the Anthropic key required. */
  async platformConfig(key: string): Promise<string | null> {
    const { data, error } = await this.sb.rpc('platform_config_get', { p_key: key });
    if (error) return null;
    const v = data as string | null;
    return v && String(v).trim() ? String(v).trim() : null;
  }

  /** UI-login secret for a domain (Vault-decrypted; mig 243). The model never
   * sees it — the worker types it. Secret is {"username","password"} JSON or a
   * bare password. Returns null if no login is configured for the domain. */
  async browserLogin(tenantId: string, domain: string): Promise<{ username?: string; password: string } | null> {
    const { data, error } = await this.sb.rpc('get_browser_login', { p_tenant_id: tenantId, p_domain: domain });
    if (error) return null;
    const res = data as { ok?: boolean; secret?: string } | null;
    if (!res?.ok || !res.secret) return null;
    try { const j = JSON.parse(res.secret); if (j && typeof j.password === 'string') return { username: j.username, password: j.password }; } catch { /* bare */ }
    return { password: res.secret };
  }
}
