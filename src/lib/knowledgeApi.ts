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
  /** Per-DE knowledge scopes (migration 030): 'tenant' = every DE and
   *  specialist answers from this doc; 'scoped' = only the subjects in
   *  knowledge_doc_scopes retrieve it (enforced server-side in the
   *  retrieval RPCs, not here). */
  visibility: 'tenant' | 'scoped';
  created_at: string;
  updated_at: string;
}

import { raise, requireTenantId } from './liveShared';


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

// ── Knowledge scopes (migration 030) ──────────────────────────────

/** A machine subject a doc can be scoped to — same subject model as
 *  data_access_grants (migration 029). */
export interface ScopeSubject {
  kind: 'de' | 'specialist';
  id: string;
  name: string;
}

/** All scopeable subjects in the tenant: Digital Employees + Specialists. */
export async function listScopeSubjects(): Promise<ScopeSubject[]> {
  const tid = await requireTenantId();
  const [des, specs] = await Promise.all([
    supabase.from('digital_employees').select('id, name').eq('tenant_id', tid).order('created_at'),
    supabase.from('specialist_profiles').select('id, name').eq('tenant_id', tid).order('created_at'),
  ]);
  if (des.error) raise('listScopeSubjects', des.error);
  const out: ScopeSubject[] = (des.data ?? []).map(d => ({ kind: 'de' as const, id: d.id, name: d.name }));
  // specialist_profiles may not exist on older workspaces — non-fatal
  if (!specs.error) out.push(...(specs.data ?? []).map(s => ({ kind: 'specialist' as const, id: s.id, name: s.name })));
  return out;
}

/** Current scopes per doc, keyed by doc_id. Docs with no entry are tenant-wide. */
export async function listDocScopes(): Promise<Record<string, { kind: 'de' | 'specialist'; id: string }[]>> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_doc_scopes')
    .select('doc_id, subject_kind, subject_id')
    .eq('tenant_id', tid);
  if (error) {
    // Missing table (migration 030 not applied) is non-fatal — no scoping UI data.
    console.error('listDocScopes:', error.message);
    return {};
  }
  const map: Record<string, { kind: 'de' | 'specialist'; id: string }[]> = {};
  for (const row of data ?? []) {
    (map[row.doc_id] ??= []).push({ kind: row.subject_kind, id: row.subject_id });
  }
  return map;
}

/** Replace a doc's scope list via the audited SECURITY DEFINER RPC.
 *  Empty list = back to tenant-wide. Returns the resulting visibility. */
export async function setDocScope(
  docId: string,
  subjects: { kind: 'de' | 'specialist'; id: string }[]
): Promise<'tenant' | 'scoped'> {
  const { data, error } = await supabase.rpc('set_doc_scope', {
    p_doc_id: docId,
    p_subjects: subjects,
  });
  if (error) raise('setDocScope', error);
  const res = data as { ok: boolean; error?: string; detail?: string; visibility?: string };
  if (!res?.ok) throw new CustomerApiError(res?.detail ?? res?.error ?? 'scope change rejected', false);
  return (res.visibility as 'tenant' | 'scoped') ?? 'tenant';
}

// ── Chunking / embedding (ingest-chunks edge function) ────────────

export interface DocChunkStatus {
  chunks: number;
  embedded: number;
}

/** Per-doc chunk/embedding counts, keyed by doc_id. Docs with no entry
 *  have not been indexed yet (keyword-only retrieval). */
export async function listChunkStatus(): Promise<Record<string, DocChunkStatus>> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_doc_chunks')
    .select('doc_id, chunk_index, embedding')
    .eq('tenant_id', tid);
  if (error) {
    // Missing table (migration 013 not applied) is non-fatal — no badges.
    console.error('listChunkStatus:', error.message);
    return {};
  }
  const map: Record<string, DocChunkStatus> = {};
  for (const row of data ?? []) {
    const s = (map[row.doc_id] ??= { chunks: 0, embedded: 0 });
    s.chunks += 1;
    if (row.embedding != null) s.embedded += 1;
  }
  return map;
}

/** Fire the ingest-chunks edge function for a doc (chunk + embed).
 *  Fire-and-forget friendly: resolves with the result, throws on failure. */
export async function ingestDocChunks(docId: string): Promise<DocChunkStatus> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest-chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ doc_id: docId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new CustomerApiError(String(data.error ?? `HTTP ${res.status}`), false);
  return { chunks: Number(data.chunks) || 0, embedded: Number(data.embedded) || 0 };
}

// ── de-answer edge function (the real DE brain) ───────────────────

export interface DEAnswerResult {
  conversation_id: string | null;
  answer: string;
  confidence: number; // 0..100
  sources: string[];
  needs_escalation: boolean;
  no_docs?: boolean;
  /** answer served from the semantic answer cache (no LLM call) */
  cached?: boolean;
  /** the answer was withheld by a tenant guardrail rule (P3) */
  blocked?: boolean;
  /** the guardrail rule text that blocked the answer */
  blocked_rule?: string;
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
    cached: !!data.cached,
    blocked: !!data.blocked,
    blocked_rule: typeof data.rule === 'string' ? data.rule : undefined,
  };
}
