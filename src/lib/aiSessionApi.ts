// Working sessions — the conversational "Edit with AI" spine (Wave 1).
//
// One API for every surface: a playbook, a digital employee, or the whole
// workspace. The assistant applies low-risk changes itself and everything
// it applies is undoable for 120 hours; anything riskier comes back as a
// proposal for a human to approve.
import { supabase } from '../supabase';
import { requireTenantId } from './liveShared';

export type SubjectKind = 'de' | 'playbook' | 'workspace';

export interface AppliedChange {
  change_id: string;
  kind: string;
  summary: string;
  undoable_until: string;
}

export interface ProposedChange {
  what: string;
  why: string;
}

export interface SessionTurn {
  session_id: string;
  reply: string;
  applied: AppliedChange[];
  proposed: ProposedChange[];
  /** False during a remote-access support session — the assistant advises but cannot write. */
  can_auto_apply: boolean;
}

export interface UndoableChange {
  id: string;
  change_kind: string;
  summary: string;
  target_table: string;
  target_id: string | null;
  applied_at: string;
  expires_at: string;
}

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta: { applied?: AppliedChange[]; proposed?: ProposedChange[] };
  created_at: string;
}

/** Plain-language messages for the failures a user can actually act on. */
function friendlyError(raw: string): string {
  if (raw.includes('llm_not_configured')) return 'The AI engine has not been connected yet. Add an API key in Settings → AI Engine.';
  if (raw.includes('ai_budget_exceeded')) return 'This workspace has used its AI budget for the month. Raise the limit in Settings to carry on.';
  if (raw.includes('change_kind_requires_human_review')) return 'That change needs a person to approve it — the assistant is not allowed to make it directly.';
  if (raw.includes('session_not_found')) return 'That conversation could not be found. Starting a new one will fix it.';
  if (raw.includes('undo_window_expired')) return 'This change is more than 120 hours old, so it can no longer be undone automatically.';
  if (raw.includes('already_undone')) return 'That change has already been undone.';
  return raw;
}

/** Send a message. Omit sessionId to start a new conversation. */
export async function sendSessionMessage(args: {
  subjectKind: SubjectKind;
  subjectId?: string | null;
  message: string;
  sessionId?: string | null;
}): Promise<SessionTurn> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.functions.invoke('ai-session', {
    body: {
      subject_kind: args.subjectKind,
      subject_id: args.subjectId ?? null,
      message: args.message,
      session_id: args.sessionId ?? null,
      tenant_id: tid,
    },
  });
  const payloadError = (data as { error?: string } | null)?.error;
  if (error || payloadError) {
    throw new Error(friendlyError(payloadError || error?.message || 'The assistant could not be reached.'));
  }
  const d = data as SessionTurn;
  return {
    session_id: d.session_id,
    reply: d.reply ?? '',
    applied: Array.isArray(d.applied) ? d.applied : [],
    proposed: Array.isArray(d.proposed) ? d.proposed : [],
    can_auto_apply: d.can_auto_apply !== false,
  };
}

/** Most recent session for this subject, so reopening a panel resumes the thread. */
export async function findLatestSession(subjectKind: SubjectKind, subjectId?: string | null): Promise<string | null> {
  const tid = await requireTenantId();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  let q = supabase.from('ai_sessions').select('id')
    .eq('tenant_id', tid).eq('user_id', auth.user.id)
    .eq('subject_kind', subjectKind).eq('status', 'active')
    .order('updated_at', { ascending: false }).limit(1);
  q = subjectId ? q.eq('subject_id', subjectId) : q.is('subject_id', null);
  const { data } = await q;
  return data?.[0]?.id ?? null;
}

export async function loadSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  const { data, error } = await supabase.from('ai_session_messages')
    .select('role, content, meta, created_at')
    .eq('session_id', sessionId).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m) => m.role !== 'system') as StoredMessage[];
}

export async function listUndoable(limit = 20): Promise<UndoableChange[]> {
  const { data, error } = await supabase.rpc('ai_list_undoable', { p_limit: limit });
  if (error) throw new Error(friendlyError(error.message));
  return (data ?? []) as UndoableChange[];
}

export async function undoChange(changeId: string): Promise<void> {
  const { error } = await supabase.rpc('ai_undo_change', { p_change_id: changeId });
  if (error) throw new Error(friendlyError(error.message));
}

/** Hours left in the 120-hour window, for the countdown on an undo chip. */
export function hoursRemaining(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 3_600_000));
}
