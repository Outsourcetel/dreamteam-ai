import { supabase } from '../supabase';

// Mission Delegation client rail (docs/14). Missing-table TOLERANT: until
// migration 248 is applied, reads surface `notReady` instead of throwing so
// the Employee File can show an honest "rail not applied yet" state.

export type MissionStatus =
  | 'draft' | 'compiling' | 'awaiting_approval' | 'approved'
  | 'running' | 'paused' | 'done' | 'cancelled' | 'failed';

export interface StandingWatcher { kind: string; label: string; description: string; config: Record<string, unknown>; in_scope_count: number }
export interface MissionTargetSpec { kind: 'archetype' | 'explicit' | 'supervisor'; archetype_key?: string; de_ids?: string[]; supervisor_de_id?: string; routing?: string }

export interface MissionPlan {
  interpretation?: string;
  shape?: 'batch' | 'project' | 'standing';
  team?: boolean;
  target_spec?: MissionTargetSpec | null;
  routing_preview?: { candidate_count: number; kind: string } | null;
  scope_preview?: { count: number; entity_kind: string; sample: { ref: string; label: string }[] } | null;
  subject?: string | null;
  cadence?: string | null;
  standing?: { cadence_words: string; watchers: StandingWatcher[]; total_open_now: number } | null;
  case_title_template?: string;
  procedure_summary?: string;
  playbook_key?: string | null;
  gates?: string[];
  notes?: string[];
  dedup?: { count: number; sample: { ref: string; label: string }[]; policy: string };
  est_cases?: number;
}

export interface MissionReport { per_de?: Record<string, number>; unrouted?: { ref: string; label: string }[]; created?: number; skipped_busy?: number; skipped_excluded?: number }

export interface MissionRow {
  id: string; de_id: string | null; directive_text: string; status: MissionStatus;
  shape: 'batch' | 'project' | 'standing' | null;
  target_spec: MissionTargetSpec | null;
  compiled_plan: MissionPlan | null; est_cost_usd: number | null;
  error: string | null; report: MissionReport | null;
  created_at: string; approved_at: string | null; finished_at: string | null;
}

export interface MissionProgress { total: number; achieved: number; active: number; blocked: number; abandoned: number }

const MISSING = (msg: string | undefined) =>
  !!msg && (msg.includes('does not exist') || msg.includes('PGRST205') || msg.includes('schema cache') || msg.includes('Could not find'));

const MISSION_COLS = 'id,de_id,directive_text,status,shape,target_spec,compiled_plan,est_cost_usd,error,report,created_at,approved_at,finished_at';

export async function listMissions(deId: string): Promise<{ notReady: boolean; missions: MissionRow[] }> {
  const { data, error } = await supabase.from('de_missions')
    .select(MISSION_COLS)
    .eq('de_id', deId).order('created_at', { ascending: false }).limit(20);
  if (error) {
    if (MISSING(error.message)) return { notReady: true, missions: [] };
    throw new Error(error.message);
  }
  return { notReady: false, missions: (data ?? []) as MissionRow[] };
}

// Team missions aren't bound to one de_id — list them for the workforce board.
export async function listTeamMissions(): Promise<{ notReady: boolean; missions: MissionRow[] }> {
  const { data, error } = await supabase.from('de_missions')
    .select(MISSION_COLS)
    .is('de_id', null).order('created_at', { ascending: false }).limit(20);
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

const TEAM_ERR: Record<string, string> = {
  not_permitted: 'Only owners, admins and managers can give team missions.',
  no_active_de_for_archetype: 'No active employee holds that role yet — hire one first.',
  unknown_or_foreign_de: 'One of the chosen employees isn’t in this workspace.',
  unknown_or_foreign_supervisor: 'That supervisor isn’t an active employee here.',
  directive_too_short: 'Say a little more — a mission needs at least a full sentence.',
};
export async function createTeamMission(target: MissionTargetSpec, directive: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_de_team_mission', { p_target_spec: target, p_directive: directive });
  if (error) throw new Error(MISSING(error.message) ? 'Cross-DE missions aren’t applied to this workspace yet (migration 274 pending).' : error.message);
  const res = data as { ok?: boolean; error?: string; mission_id?: string };
  if (!res?.ok) throw new Error(TEAM_ERR[res?.error ?? ''] ?? (res?.error ?? 'Could not create the team mission.'));
  return String(res.mission_id);
}

// Distinct role archetypes present in the active workforce — the targets a
// founder can give a team mission to. Counts drive the "the whole X team" copy.
export async function listArchetypeTargets(): Promise<{ archetype_key: string; count: number }[]> {
  const { data, error } = await supabase.from('digital_employees')
    .select('archetype_key').eq('status', 'active').not('archetype_key', 'is', null);
  if (error) return [];
  const counts = new Map<string, number>();
  for (const r of data ?? []) { const k = String((r as { archetype_key: string }).archetype_key); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return [...counts.entries()].map(([archetype_key, count]) => ({ archetype_key, count })).sort((a, b) => b.count - a.count);
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

export async function approveMission(missionId: string, excludedRefs: string[]): Promise<{ created: number; skipped: number; unrouted: number; standing?: boolean; installed?: number }> {
  const res = await invoke({ action: 'approve', mission_id: missionId, excluded_refs: excludedRefs });
  if (res.error) throw new Error(String(res.detail ?? res.error));
  if (res.standing) return { created: 0, skipped: 0, unrouted: 0, standing: true, installed: Number(res.installed ?? 0) };
  return { created: Number(res.created ?? 0), skipped: Number(res.skipped_busy ?? 0) + Number(res.skipped_excluded ?? 0), unrouted: Number(res.unrouted ?? 0) };
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
  // v2 (mig 255): the complete first-class object — focus, order, output.
  current_focus: { title: string; status: string; next_wake_at: string | null; wake_count: number; mission_id: string | null; due_at: string | null } | null;
  next_up: { kind: string; title: string; when: string | null }[];
  listens_live: boolean;
  rhythm: { done_7d: number; deliverables_7d: number; last_deliverable: { title: string; at: string } | null };
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
