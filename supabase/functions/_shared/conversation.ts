/**
 * conversation.ts — give a Digital Employee the thread it is actually in.
 *
 * Found live (founder, 2026-07-25): "pleasantries like 'I am frustrated' or
 * 'thanks this helped' are handled poorly with no sensible conversation."
 *
 * Root cause, verified in code: every answer path sent the model exactly one
 * line — `messages: [{ role: 'user', content: question }]`. de_messages was
 * WRITTEN on every turn and never READ back. So each turn was a cold open: the
 * employee could not track what it had just said, could not tell a first
 * complaint from the fourth, could not resolve "what about the other one?",
 * and could not hear a joke land. No amount of prompt tuning fixes that —
 * conversation is the input, not the instruction.
 *
 * This module is the READ side of a table we were already writing. It returns
 * a properly-shaped Anthropic `messages` array ending with the current turn.
 *
 * Bounded on purpose — history is the main cost lever on a chat product:
 *   • per-employee turn budget (digital_employees.context_turns, default 8)
 *   • per-message character clamp (a pasted logfile can't blow the window)
 *   • consecutive same-role turns merged, leading assistant turns dropped
 *     (the Messages API requires alternating turns starting with `user`)
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

export interface Turn { role: 'user' | 'assistant'; content: string }

/** Per-message clamp. Long enough for a real paragraph + a pasted error;
 *  short enough that 8 of them cannot dominate the context window. */
const MAX_CHARS_PER_TURN = 1500;

/** Channel tag written for the human inbox (`[widget · alex@x.com] …`).
 *  Useful to a person reading the transcript, noise to the model — the
 *  identity is already established elsewhere in the prompt. */
const CHANNEL_TAG = /^\[[^\]\n]{0,80}\]\s*/;

function clamp(s: string): string {
  const t = String(s ?? '').trim();
  return t.length > MAX_CHARS_PER_TURN ? t.slice(0, MAX_CHARS_PER_TURN) + ' …[trimmed]' : t;
}

/**
 * Build the `messages` array for this turn: up to `maxTurns` prior messages
 * from the thread, followed by the current question.
 *
 * ALWAYS ends with `{ role: 'user', content: question }` — so a caller that
 * passes maxTurns=0, has no conversation, or hits any error gets EXACTLY the
 * previous single-turn behaviour. Fails open by design: a history read that
 * errors must degrade the conversation, never the answer.
 *
 * Note the ordering contract with callers: both answer paths insert the
 * current user message into de_messages BEFORE generating. That row is
 * therefore expected in the fetch and is de-duplicated here rather than
 * relying on insert-order luck.
 */
export async function buildTurns(
  admin: SupabaseClient,
  tenantId: string,
  convId: string | null,
  question: string,
  maxTurns: number,
): Promise<Turn[]> {
  const current: Turn = { role: 'user', content: clamp(question) };
  if (!convId || !Number.isFinite(maxTurns) || maxTurns <= 0) return [current];
  try {
    // +2 headroom: the just-inserted current row, plus one that may be
    // dropped when merging/trimming below.
    const { data, error } = await admin
      .from('de_messages')
      .select('role, content, created_at, id')
      .eq('tenant_id', tenantId)
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(Math.min(40, Math.floor(maxTurns) + 2));
    if (error || !Array.isArray(data) || data.length === 0) return [current];

    const rows = (data as Array<{ role: string; content: string }>).slice().reverse();
    const prior: Turn[] = [];
    for (const r of rows) {
      const role = r.role === 'assistant' ? 'assistant' : 'user';
      const content = clamp(role === 'user' ? String(r.content ?? '').replace(CHANNEL_TAG, '') : String(r.content ?? ''));
      if (!content) continue;
      prior.push({ role, content });
    }
    // Drop the current turn wherever it landed at the tail (it is re-appended
    // canonically, without the channel tag, as the final message).
    while (prior.length && prior[prior.length - 1].role === 'user'
           && prior[prior.length - 1].content === current.content) prior.pop();

    const turns = [...prior.slice(-Math.floor(maxTurns)), current];
    // The API requires the first turn to be `user` and (for our purposes)
    // no two consecutive turns to share a role.
    while (turns.length && turns[0].role === 'assistant') turns.shift();
    const merged: Turn[] = [];
    for (const t of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === t.role) last.content = clamp(`${last.content}\n\n${t.content}`);
      else merged.push({ ...t });
    }
    return merged.length ? merged : [current];
  } catch (e) {
    console.error('buildTurns (history unavailable, answering single-turn):', String(e));
    return [current];
  }
}

/**
 * What the employee read in the person it is talking to.
 *
 * Deliberately NOT a separate sentiment-classifier call. A detector bolted
 * beside the generator is what makes bots sound like bots ("I detect that you
 * are frustrated. I am sorry you are frustrated."). The model that is already
 * reading the whole thread reports what it read, in the same pass, for free —
 * and the same read that shapes its tone is the one governance sees.
 */
export interface CustomerState { mood: string | null; intensity: number | null }

const MOODS = ['happy', 'neutral', 'confused', 'frustrated', 'angry'];

/** Parse `customer_state` out of a model envelope. Unknown/absent => nulls,
 *  and a null signal never matches an escalation condition (escalation.ts),
 *  so a model that omits the field changes nothing. */
export function parseCustomerState(raw: unknown): CustomerState {
  const o = (raw ?? {}) as { mood?: unknown; intensity?: unknown };
  const mood = typeof o.mood === 'string' && MOODS.includes(o.mood.trim().toLowerCase())
    ? o.mood.trim().toLowerCase() : null;
  const n = Number(o.intensity);
  const intensity = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  return { mood, intensity };
}

/** The two escalation signals a customer_state contributes, ready to spread
 *  into an EscContext. `sentiment` is the pre-existing numeric signal from the
 *  catalog (mig 262) that no caller ever supplied; `sentiment_label` is its
 *  categorical companion (mig 325). */
export function stateSignals(s: CustomerState): Record<string, string | number | null> {
  return { sentiment: s.intensity, sentiment_label: s.mood };
}

/** The JSON contract + the calibration behind the numbers. Shared verbatim by
 *  every answer path so a rule written against `sentiment` means the same
 *  thing everywhere. */
export const CUSTOMER_STATE_SPEC =
  '"customer_state": {"mood": one of "happy"|"neutral"|"confused"|"frustrated"|"angry", "intensity": 0-100} — '
  + 'your honest read of the PERSON from the whole conversation, not of your own answer. '
  + 'intensity means how much they need a human right now: 0-30 fine or mildly annoyed, '
  + '40-60 clearly unhappy but the conversation is still making progress, '
  + '70-100 stuck, going in circles, escalating, or threatening to leave. '
  + 'Report it accurately even when the news is good.';
