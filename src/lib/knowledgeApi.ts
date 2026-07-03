// ============================================================
// Knowledge docs — LIVE data layer (production track P2).
// CRUD over knowledge_docs (migration 012) + the de-answer
// edge-function call that gives the Customer Support DE a
// real, grounded brain.
// ============================================================
import { supabase } from '../supabase';
import { CustomerApiError, isMissingTableError, getSessionTenantId } from './customerApi';

export interface KnowledgeDoc {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  source: 'upload' | 'paste';
  tags: string[];
  created_at: string;
  updated_at: string;
}

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

// ── CRUD ──────────────────────────────────────────────────────────

export async function listKnowledgeDocs(): Promise<KnowledgeDoc[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_docs')
    .select('*')
    .eq('tenant_id', tid)
    .order('updated_at', { ascending: false });
  if (error) raise('listKnowledgeDocs', error);
  return data ?? [];
}

export async function createKnowledgeDoc(
  d: { title: string; content: string; source: 'upload' | 'paste'; tags: string[] }
): Promise<KnowledgeDoc> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_docs')
    .insert({ ...d, tenant_id: tid })
    .select()
    .single();
  if (error) raise('createKnowledgeDoc', error);
  return data as KnowledgeDoc;
}

export async function updateKnowledgeDoc(
  id: string,
  updates: Partial<Pick<KnowledgeDoc, 'title' | 'content' | 'tags'>>
): Promise<KnowledgeDoc> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_docs')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('updateKnowledgeDoc', error);
  return data as KnowledgeDoc;
}

export async function deleteKnowledgeDoc(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('knowledge_docs')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tid);
  if (error) raise('deleteKnowledgeDoc', error);
}

// ── de-answer edge function (the real DE brain) ───────────────────

export interface DEAnswerResult {
  conversation_id: string | null;
  answer: string;
  confidence: number; // 0..100
  sources: string[];
  needs_escalation: boolean;
  no_docs?: boolean;
}

export class DEAnswerError extends Error {
  code: 'llm_not_configured' | 'network' | 'server';
  constructor(code: DEAnswerError['code'], message: string) {
    super(message);
    this.name = 'DEAnswerError';
    this.code = code;
  }
}

/** Ask the live DE a question via the de-answer edge function.
 *  Forwards the caller's session JWT so the function can resolve the tenant. */
export async function askDE(
  question: string,
  conversationId?: string | null
): Promise<DEAnswerResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new DEAnswerError('server', 'Not signed in.');

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/de-answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ question, conversation_id: conversationId ?? undefined }),
    });
  } catch (err) {
    throw new DEAnswerError('network', String(err));
  }

  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* noop */ }

  if (data.error === 'llm_not_configured') {
    throw new DEAnswerError('llm_not_configured', 'DE brain not yet activated.');
  }
  if (!res.ok || data.error) {
    throw new DEAnswerError('server', String(data.error ?? `HTTP ${res.status}`));
  }
  return {
    conversation_id: (data.conversation_id as string) ?? null,
    answer: String(data.answer ?? ''),
    confidence: Math.max(0, Math.min(100, Number(data.confidence) || 0)),
    sources: Array.isArray(data.sources) ? (data.sources as string[]) : [],
    needs_escalation: !!data.needs_escalation,
    no_docs: !!data.no_docs,
  };
}
