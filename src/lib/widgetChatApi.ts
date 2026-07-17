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

// ── Streaming (SSE) client ──
// widget-ask (body.stream=true) emits: `event: delta` {text},
// `event: blocked` {answer, rule, …full result}, `event: final` {…full
// result}, `event: error` {error}. If the server answers with plain JSON
// instead (draft-mode DE, cache hit, no_docs, turn cap, llm errors…) the
// parsed result is delivered via onFinal directly — callers need no
// special-casing. Throws on network/HTTP/stream failure so the caller can
// fall back to the non-streaming askWidget() path.
export interface WidgetStreamHandlers {
  onDelta: (text: string) => void;
  onBlocked: (msg: string) => void;
  onFinal: (result: WidgetAskResult) => void;
}

export async function askWidgetStream(
  widgetKey: string,
  question: string,
  conversationId: string | null | undefined,
  handlers: WidgetStreamHandlers,
  opts?: Pick<WidgetAskInput, 'channel' | 'accountRef' | 'endUserRef' | 'displayName'>,
): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      widget_key: widgetKey,
      question,
      conversation_id: conversationId ?? undefined,
      stream: true,
      channel: opts?.channel ?? 'hosted',
      account_ref: opts?.accountRef ?? undefined,
      end_user_ref: opts?.endUserRef ?? undefined,
      display_name: opts?.displayName ?? undefined,
    }),
  });
  if (!res.ok) throw new Error(`widget_stream_http_${res.status}`);
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream')) {
    // Server chose the JSON path (draft mode, cache hit, …) — final result.
    handlers.onFinal((await res.json()) as WidgetAskResult);
    return;
  }
  if (!res.body) throw new Error('widget_stream_no_body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  const state = { terminal: false, error: null as string | null };

  const dispatch = (ev: string, raw: string) => {
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (ev === 'delta') {
      handlers.onDelta(String(data.text ?? ''));
    } else if (ev === 'blocked') {
      state.terminal = true;
      handlers.onBlocked(String(data.answer ?? ''));
      // The blocked payload carries the full result shape (needs_escalation,
      // status, delivery…) so metadata handling stays uniform.
      handlers.onFinal(data as unknown as WidgetAskResult);
    } else if (ev === 'final') {
      state.terminal = true;
      handlers.onFinal(data as unknown as WidgetAskResult);
    } else if (ev === 'error') {
      state.error = String(data.error ?? 'stream_error');
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dispatch(event, line.slice(5).trim());
      else if (line === '') event = '';
    }
  }
  if (state.error) throw new Error(state.error);
  if (!state.terminal) throw new Error('widget_stream_incomplete');
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
