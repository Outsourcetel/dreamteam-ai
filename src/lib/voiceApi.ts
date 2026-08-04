// ============================================================
// voiceApi — LIVE data for the Calls tab (docs/42).
//
// The voice channel captured everything from the first real call — summary,
// duration, recording pointer, full transcript, and any message the caller
// left — and NONE of it had a reader. Calls showed up in the generic DE
// activity feed as a row saying "Phone call", indistinguishable from a typed
// question, while the transcript sat unread in the audit chain and messages
// sat in a table nothing queried.
//
// The pieces live in three places because each earns its own home: the call as
// a unit of work is an evidence_runs row (so it feeds the same performance and
// trust organs as chat); the transcript and recording are audit-chain detail
// (tamper-evident, because a recording pointer is evidence); the messages are
// their own rows with their own human task (mig 577). This module joins them
// back into the thing an operator actually thinks about — a call.
// ============================================================
import { supabase } from '../supabase';
import { raise, requireTenantId } from './liveShared';

export interface VoiceCallMessage {
  id: string;
  caller_name: string | null;
  caller_phone: string | null;
  message: string;
  created_at: string;
  /** Status of the callback task this message raised (mig 577). null means no
   *  task exists — which is the pre-577 defect, and worth showing as such. */
  task_status: string | null;
  task_title: string | null;
}

export interface VoiceCall {
  /** evidence_runs.id — the call as a unit of work. */
  id: string;
  call_id: string | null;
  inquiry: string;
  summary: string;
  created_at: string;
  duration_seconds: number | null;
  recording_url: string | null;
  /** Up to 1500 chars, as captured into the audit chain. null when the
   *  end-of-call report never arrived (the assistant-level server URL was
   *  unset for the first live call — see docs/42). */
  transcript: string | null;
  de_name: string | null;
  messages: VoiceCallMessage[];
}

/** Recent phone calls, newest first, with everything that happened on them. */
export async function listVoiceCalls(limit = 40): Promise<VoiceCall[]> {
  const tid = await requireTenantId();

  const { data: runs, error: runErr } = await supabase
    .from('evidence_runs')
    .select('id, de_id, inquiry, answer, steps, created_at')
    .eq('tenant_id', tid).eq('kind', 'call')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (runErr) raise('listVoiceCalls (evidence_runs)', runErr);
  const rows = (runs ?? []) as Array<{
    id: string; de_id: string | null; inquiry: string | null; answer: string | null;
    steps: unknown; created_at: string;
  }>;
  if (rows.length === 0) return [];

  const runIds = rows.map((r) => r.id);
  // call_id lives in the steps blob written by voice-webhook.
  const callIdOf = (steps: unknown): string | null => {
    const s = Array.isArray(steps) ? (steps as Array<Record<string, unknown>>) : [];
    const call = s.find((x) => x?.step === 'call');
    const v = call?.call_id;
    return typeof v === 'string' && v ? v : null;
  };
  const stepOf = (steps: unknown, key: string): unknown => {
    const s = Array.isArray(steps) ? (steps as Array<Record<string, unknown>>) : [];
    return s.find((x) => x?.step === 'call')?.[key];
  };

  const callIds = rows.map((r) => callIdOf(r.steps)).filter((c): c is string => !!c);

  const [{ data: audits }, { data: msgs }, { data: des }] = await Promise.all([
    supabase.from('audit_events')
      .select('detail, created_at')
      .eq('tenant_id', tid)
      .eq('detail->>kind', 'voice_call_completed')
      .in('detail->>evidence_run_id', runIds)
      .limit(limit),
    callIds.length > 0
      ? supabase.from('voice_messages')
          .select('id, call_id, caller_name, caller_phone, message, created_at')
          .eq('tenant_id', tid).in('call_id', callIds)
      : Promise.resolve({ data: [] as never[] }),
    supabase.from('digital_employees').select('id, name, persona_name').eq('tenant_id', tid),
  ]);

  // The callback task each message raised — so an operator can see at a glance
  // whether anyone has actually rung this person back.
  const msgRows = (msgs ?? []) as Array<{
    id: string; call_id: string | null; caller_name: string | null;
    caller_phone: string | null; message: string; created_at: string;
  }>;
  let taskByMsg = new Map<string, { status: string; title: string }>();
  if (msgRows.length > 0) {
    const { data: tasks } = await supabase
      .from('human_tasks')
      .select('related_id, status, title')
      .eq('tenant_id', tid).eq('related_table', 'voice_messages')
      .in('related_id', msgRows.map((m) => m.id));
    taskByMsg = new Map(
      ((tasks ?? []) as Array<{ related_id: string; status: string; title: string }>)
        .map((t) => [t.related_id, { status: t.status, title: t.title }]),
    );
  }

  const transcriptByRun = new Map<string, string>();
  for (const a of (audits ?? []) as Array<{ detail: Record<string, unknown> }>) {
    const runId = String(a.detail?.evidence_run_id ?? '');
    const t = a.detail?.transcript_preview;
    if (runId && typeof t === 'string' && t) transcriptByRun.set(runId, t);
  }

  const deName = new Map<string, string>();
  for (const d of (des ?? []) as Array<{ id: string; name: string; persona_name: string | null }>) {
    deName.set(d.id, d.persona_name || d.name);
  }

  return rows.map((r) => {
    const cid = callIdOf(r.steps);
    const dur = stepOf(r.steps, 'duration_seconds');
    const rec = stepOf(r.steps, 'recording_url');
    return {
      id: r.id,
      call_id: cid,
      inquiry: r.inquiry ?? 'Phone call',
      summary: r.answer ?? '',
      created_at: r.created_at,
      duration_seconds: typeof dur === 'number' ? dur : null,
      recording_url: typeof rec === 'string' && rec ? rec : null,
      transcript: transcriptByRun.get(r.id) ?? null,
      de_name: r.de_id ? deName.get(r.de_id) ?? null : null,
      messages: msgRows
        .filter((m) => cid && m.call_id === cid)
        .map((m) => ({
          id: m.id,
          caller_name: m.caller_name,
          caller_phone: m.caller_phone,
          message: m.message,
          created_at: m.created_at,
          task_status: taskByMsg.get(m.id)?.status ?? null,
          task_title: taskByMsg.get(m.id)?.title ?? null,
        })),
    };
  });
}

/** Messages left on calls that have no completed-call record yet — a caller
 *  can hang up before the platform posts its end-of-call report, and a person
 *  waiting for a callback must not fall through that gap. */
export async function listOrphanVoiceMessages(limit = 20): Promise<VoiceCallMessage[]> {
  const tid = await requireTenantId();
  const { data: msgs, error } = await supabase
    .from('voice_messages')
    .select('id, call_id, caller_name, caller_phone, message, created_at')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) raise('listOrphanVoiceMessages', error);
  const rows = (msgs ?? []) as Array<{
    id: string; call_id: string | null; caller_name: string | null;
    caller_phone: string | null; message: string; created_at: string;
  }>;
  if (rows.length === 0) return [];

  const { data: runs } = await supabase
    .from('evidence_runs').select('steps')
    .eq('tenant_id', tid).eq('kind', 'call')
    .order('created_at', { ascending: false }).limit(200);
  const known = new Set<string>();
  for (const r of (runs ?? []) as Array<{ steps: unknown }>) {
    const s = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
    const c = s.find((x) => x?.step === 'call')?.call_id;
    if (typeof c === 'string' && c) known.add(c);
  }

  const orphans = rows.filter((m) => !m.call_id || !known.has(m.call_id));
  if (orphans.length === 0) return [];

  const { data: tasks } = await supabase
    .from('human_tasks').select('related_id, status, title')
    .eq('tenant_id', tid).eq('related_table', 'voice_messages')
    .in('related_id', orphans.map((m) => m.id));
  const byMsg = new Map(
    ((tasks ?? []) as Array<{ related_id: string; status: string; title: string }>)
      .map((t) => [t.related_id, { status: t.status, title: t.title }]),
  );

  return orphans.map((m) => ({
    id: m.id,
    caller_name: m.caller_name,
    caller_phone: m.caller_phone,
    message: m.message,
    created_at: m.created_at,
    task_status: byMsg.get(m.id)?.status ?? null,
    task_title: byMsg.get(m.id)?.title ?? null,
  }));
}
