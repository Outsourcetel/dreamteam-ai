import { supabase } from '../supabase';

// Mission Delegation client rail (docs/14). Missing-table TOLERANT: until
// migration 248 is applied, reads surface `notReady` instead of throwing so
// the Employee File can show an honest "rail not applied yet" state.

export type MissionStatus =
  | 'draft' | 'compiling' | 'awaiting_approval' | 'approved'
  | 'running' | 'paused' | 'done' | 'cancelled' | 'failed';

export interface MissionPlan {
  interpretation?: string;
  shape?: 'batch' | 'project' | 'standing';
  scope_preview?: { count: number; entity_kind: string; sample: { ref: string; label: string }[] } | null;
  subject?: string | null;
  cadence?: string | null;
  case_title_template?: string;
  procedure_summary?: string;
  playbook_key?: string | null;
  gates?: string[];
  notes?: string[];
  dedup?: { count: number; sample: { ref: string; label: string }[]; policy: string };
  est_cases?: number;
}

export interface MissionRow {
  id: string; de_id: string; directive_text: string; status: MissionStatus;
  shape: 'batch' | 'project' | 'standing' | null;
  compiled_plan: MissionPlan | null; est_cost_usd: number | null;
  error: string | null; report: Record<string, unknown> | null;
  created_at: string; approved_at: string | null; finished_at: string | null;
}

export interface MissionProgress { total: number; achieved: number; active: number; blocked: number; abandoned: number }

const MISSING = (msg: string | undefined) =>
  !!msg && (msg.includes('does not exist') || msg.includes('PGRST205') || msg.includes('schema cache') || msg.includes('Could not find'));

export async function listMissions(deId: string): Promise<{ notReady: boolean; missions: MissionRow[] }> {
  const { data, error } = await supabase.from('de_missions')
    .select('id,de_id,directive_text,status,shape,compiled_plan,est_cost_usd,error,report,created_at,approved_at,finished_at')
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(20);
  if (error) {
    if (MISSING(error.message)) return { notReady: true, missions: [] };
    throw new Error(error.message);
  }
  return { notReady: false, missions: (data ?? []) as MissionRow[] };
}

export async function createMission(deId: string, directive: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_de_mission', { p_de_id: deId, p_directive: directive });
  if (error) throw new Error(MISSING(error.message) ? 'Mission rail not applied yet — migration 248 is pending.' : error.message);
  const res = data as { ok?: boolean; error?: string; mission_id?: string };
  if (!res?.ok) throw new Error(res?.error === 'not_permitted' ? 'Only owners, admins and managers can give missions.' : (res?.error ?? 'Could not create the mission.'));
  return String(res.mission_id);
}

export async function setMissionState(missionId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const { data, error } = await supabase.rpc('set_de_mission_state', { p_mission_id: missionId, p_action: action });
  if (error) throw new Error(error.message);
  const res = data as { ok?: boolean; error?: string };
  if (!res?.ok) throw new Error(res?.error ?? `Could not ${action} the mission.`);
}

async function invoke(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('de-mission', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { return await ctx.json() as Record<string, unknown>; } catch { /* fallthrough */ }
    }
    throw new Error(error.message ?? String(error));
  }
  return data as Record<string, unknown>;
}

export async function compileMission(missionId: string): Promise<{ ok: boolean; error?: string; impossible?: string }> {
  const res = await invoke({ action: 'compile', mission_id: missionId });
  if (res.error === 'llm_not_configured') return { ok: false, error: 'The workforce brain is offline (no AI key configured). The mission is saved — compile it once the key is restored.' };
  if (res.error) return { ok: false, error: String(res.detail ?? res.error) };
  if (res.impossible) return { ok: false, impossible: String(res.impossible) };
  return { ok: true };
}

export async function approveMission(missionId: string, excludedRefs: string[]): Promise<{ created: number; skipped: number }> {
  const res = await invoke({ action: 'approve', mission_id: missionId, excluded_refs: excludedRefs });
  if (res.error) throw new Error(String(res.error));
  return { created: Number(res.created ?? 0), skipped: Number(res.skipped_busy ?? 0) + Number(res.skipped_excluded ?? 0) };
}

export async function missionProgress(missionId: string): Promise<MissionProgress> {
  const { data, error } = await supabase.from('de_objectives').select('status').eq('mission_id', missionId);
  if (error) return { total: 0, achieved: 0, active: 0, blocked: 0, abandoned: 0 };
  const rows = data ?? [];
  return {
    total: rows.length,
    achieved: rows.filter(r => r.status === 'achieved').length,
    active: rows.filter(r => ['open', 'in_progress'].includes(r.status)).length,
    blocked: rows.filter(r => r.status === 'blocked').length,
    abandoned: rows.filter(r => r.status === 'abandoned').length,
  };
}

// ── Operating model (composed read; audit gap #1) ─────────────────

export interface OperatingModel {
  identity: { name: string; persona_name: string | null; department: string; category: string; trust_level: string; status: string };
  work_sources: { label: string; description: string | null; kind: string; active: boolean; next_fire_at: string | null; last_run_at: string | null; last_match_count: number | null }[];
  playbooks: { key: string; name: string; status: string; version: number; steps: number; trigger_type: string | null }[];
  open_objectives: number;
  waiting_on_human: number;
}

export async function getOperatingModel(deId: string): Promise<{ notReady: boolean; model: OperatingModel | null }> {
  const { data, error } = await supabase.rpc('get_de_operating_model', { p_de_id: deId });
  if (error) {
    if (MISSING(error.message)) return { notReady: true, model: null };
    throw new Error(error.message);
  }
  const res = data as ({ ok: boolean } & OperatingModel) | { ok: false; error: string };
  if (!res || (res as { ok: boolean }).ok === false) return { notReady: false, model: null };
  return { notReady: false, model: res as unknown as OperatingModel };
}

// ── Workforce board (docs/17 C2: whole-workforce now / next / blocked) ──

export interface BoardNextItem { kind: 'work_item' | 'case_wait' | 'watcher' | 'objective_wake' | string; title: string; when: string | null }
export interface WorkforceBoardRow {
  de_id: string;
  name: string;
  persona_name: string | null;
  department: string | null;
  trust_level: string | null;
  lifecycle_status: string;
  now: { title: string; since: string | null } | null;
  next_up: BoardNextItem[];
  listens_live: boolean;
  waiting_on_you: number;
  blocked_objectives: number;
  open_objectives: number;
  done_today: number;
}

export async function getWorkforceBoard(deId?: string): Promise<{ notReady: boolean; board: WorkforceBoardRow[] }> {
  const { data, error } = await supabase.rpc('get_workforce_board', deId ? { p_de_id: deId } : {});
  if (error) {
    if (MISSING(error.message)) return { notReady: true, board: [] };
    throw new Error(error.message);
  }
  const res = data as { ok: boolean; board?: WorkforceBoardRow[] };
  if (!res?.ok) return { notReady: false, board: [] };
  return { notReady: false, board: res.board ?? [] };
}
