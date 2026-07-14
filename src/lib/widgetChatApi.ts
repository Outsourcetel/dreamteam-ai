// Client for the public support-chat endpoint (widget-ask). Used by both the
// hosted chat page and the embeddable widget. No Supabase auth — the
// publishable widget key IS the auth (endpoint is verify_jwt=false).
import { SUPABASE_URL } from './env';

const ENDPOINT = `${SUPABASE_URL}/functions/v1/widget-ask`;

export interface WidgetAskResult {
  conversation_id: string | null;
  message_id?: string | null;
  answer: string;
  confidence: number;
  sources: string[];
  needs_escalation: boolean;
  status?: 'ai_handling' | 'needs_human' | 'human_owned' | 'resolved';
  delivery?: 'sent' | 'draft_pending' | 'blocked';
  language?: string | null;
  cached?: boolean;
  blocked?: boolean;
  no_docs?: boolean;
  error?: string;
}

export interface WidgetAskInput {
  widgetKey: string;
  question: string;
  conversationId?: string | null;
  channel?: 'widget' | 'hosted';
  accountRef?: string | null;
  endUserRef?: string | null;
  displayName?: string | null;
}

export async function askWidget(input: WidgetAskInput): Promise<WidgetAskResult> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      widget_key: input.widgetKey,
      question: input.question,
      conversation_id: input.conversationId ?? undefined,
      channel: input.channel ?? 'hosted',
      account_ref: input.accountRef ?? undefined,
      end_user_ref: input.endUserRef ?? undefined,
      display_name: input.displayName ?? undefined,
    }),
  });
  return (await res.json()) as WidgetAskResult;
}

export interface WidgetPollMessage { id: string; content: string; created_at: string }
export interface WidgetPollResult { status?: string; messages: WidgetPollMessage[] }

// Fetch delivered assistant messages (approved drafts + human replies) so
// they reach the customer live. Client dedupes by id.
export async function pollWidget(widgetKey: string, conversationId: string): Promise<WidgetPollResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widget_key: widgetKey, action: 'poll', conversation_id: conversationId }),
    });
    const d = await res.json().catch(() => ({ messages: [] }));
    return { status: d.status, messages: Array.isArray(d.messages) ? d.messages : [] };
  } catch { return { messages: [] }; }
}

export async function submitWidgetCsat(widgetKey: string, conversationId: string, score: 1 | -1): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widget_key: widgetKey, action: 'csat', conversation_id: conversationId, score }),
    });
    const d = await res.json().catch(() => ({}));
    return !!d.ok;
  } catch { return false; }
}
