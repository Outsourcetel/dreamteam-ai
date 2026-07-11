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
  source: 'upload' | 'paste' | 'connector';
  external_ref: string | null;
  tags: string[];
  /** Per-DE knowledge scopes (migration 030): 'tenant' = every DE and
   *  specialist answers from this doc; 'scoped' = only the subjects in
   *  knowledge_doc_scopes retrieve it (enforced server-side in the
   *  retrieval RPCs, not here). */
  visibility: 'tenant' | 'scoped';
  /** Simple version chain (migration 032): a revision APPLY inserts a new
   *  row pointing back at the doc it superseded — history is preserved,
   *  never destructively overwritten. */
  previous_version_id: string | null;
  is_current: boolean;
  /** Real "confirmed still accurate" stamp (migration 101) — null until
   *  a human explicitly re-verifies; distinct from updated_at, which
   *  only reflects the last content edit. */
  last_verified_at: string | null;
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
    // Superseded versions (migration 032) stay in the table for history
    // but never show as if they were a separate, current document.
    .eq('is_current', true)
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

/** Real "I checked this is still accurate" stamp (migration 101) — a
 *  plain column update, not an RPC, since knowledge_docs already
 *  allows any tenant member to write via RLS (same permission level
 *  as updateKnowledgeDoc). Distinct from editing: a doc can be
 *  verified-as-still-correct without changing its content. */
export async function markKnowledgeDocVerified(id: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('knowledge_docs')
    .update({ last_verified_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tid);
  if (error) raise('markKnowledgeDocVerified', error);
}

/** Per-doc citation count + confidence/feedback correlation
 *  (migration 101) — real evidence of whether a document is actually
 *  helping DEs answer well, not a guess. */
export interface KnowledgeDocCitationStats {
  doc_id: string;
  citation_count: number;
  avg_confidence: number | null;
  accurate_count: number;
  needs_improvement_count: number;
}

export async function getKnowledgeDocCitationStats(): Promise<Record<string, KnowledgeDocCitationStats>> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.rpc('get_knowledge_doc_citation_stats', { p_tenant_id: tid });
  if (error) raise('getKnowledgeDocCitationStats', error);
  const map: Record<string, KnowledgeDocCitationStats> = {};
  for (const row of (data ?? []) as KnowledgeDocCitationStats[]) map[row.doc_id] = row;
  return map;
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
    supabase.from('digital_employees').select('id, name').eq('tenant_id', tid).eq('status', 'active').order('created_at'),
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
 *  Fire-and-forget friendly: resolves with the result, throws on failure.
 *
 *  Embedding is resumable server-side (a single invocation embeds at
 *  most a small batch of chunks — a whole large doc in one call blew
 *  the edge worker's compute limit), so this loops until the function
 *  reports 0 remaining. Small docs still complete in one call. */
export async function ingestDocChunks(docId: string): Promise<DocChunkStatus> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  // tenant_id here is only ever a fallback the edge function verifies
  // server-side against a real Remote Access session — for an
  // ordinary tenant user it's redundant with their own profile and
  // never gets used (see resolveTenantWithRemoteAccess).
  const tid = await requireTenantId();
  let chunks = 0;
  let embedded = 0;
  // Bounded loop: EMBED_BATCH is 4 server-side, so 50 rounds covers a
  // ~200-chunk (~300KB) doc — far beyond any realistic upload.
  for (let round = 0; round < 50; round++) {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest-chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ doc_id: docId, tenant_id: tid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new CustomerApiError(String(data.error ?? `HTTP ${res.status}`), false);
    chunks = Number(data.chunks) || 0;
    embedded += Number(data.embedded) || 0;
    if (!Number(data.remaining)) break;
  }
  return { chunks, embedded };
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
  /** the DE that actually answered — real per-DE persona (Wave 1.3),
   *  not a hardcoded display name */
  de_id?: string | null;
  de_name?: string;
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
    de_id: typeof data.de_id === 'string' ? data.de_id : null,
    de_name: typeof data.de_name === 'string' ? data.de_name : undefined,
  };
}

// ============================================================
// Knowledge Feedback Loop (migration 032) — a human verdict on a
// resolved inquiry's evidence, human-gated knowledge revision
// requests, re-embedding on apply. Closes the loop: DE resolves an
// inquiry → human verifies accuracy → knowledge base gets corrected
// → with a human gate before any knowledge changes.
// ============================================================

export type EvidenceVerdict = 'accurate' | 'needs_improvement' | 'inaccurate';

export interface EvidenceFeedback {
  id: string;
  tenant_id: string;
  evidence_run_id: string;
  reviewer_user_id: string | null;
  verdict: EvidenceVerdict;
  notes: string;
  created_at: string;
}

export interface KnowledgeRevisionRequest {
  id: string;
  tenant_id: string;
  source_doc_id: string | null;
  evidence_run_id: string;
  feedback_id: string;
  proposed_title: string;
  proposed_body_md: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'applied';
  created_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_doc_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Submit a human verdict on one evidence run's gathered evidence/answer.
 *  'accurate' records feedback only. 'needs_improvement' / 'inaccurate'
 *  ALSO auto-creates a pending knowledge_revision_requests row + a
 *  human_tasks row (type 'knowledge_revision') — server-side, in one
 *  transaction (see submit_evidence_feedback, migration 032). */
export async function submitEvidenceFeedback(
  evidenceRunId: string,
  verdict: EvidenceVerdict,
  notes = ''
): Promise<{ ok: boolean; feedback_id?: string; revision_request_id?: string | null; task_id?: string | null; error?: string }> {
  const { data, error } = await supabase.rpc('submit_evidence_feedback', {
    p_evidence_run_id: evidenceRunId, p_verdict: verdict, p_notes: notes,
  });
  if (error) raise('submitEvidenceFeedback', error);
  return data as { ok: boolean; feedback_id?: string; revision_request_id?: string | null; task_id?: string | null; error?: string };
}

export async function listEvidenceFeedback(evidenceRunId: string): Promise<EvidenceFeedback[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('evidence_feedback').select('*')
    .eq('tenant_id', tid).eq('evidence_run_id', evidenceRunId)
    .order('created_at', { ascending: false });
  if (error) raise('listEvidenceFeedback', error);
  return (data ?? []) as EvidenceFeedback[];
}

export async function listKnowledgeRevisionRequests(
  status?: KnowledgeRevisionRequest['status']
): Promise<KnowledgeRevisionRequest[]> {
  const tid = await requireTenantId();
  let q = supabase.from('knowledge_revision_requests').select('*').eq('tenant_id', tid);
  if (status) q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) raise('listKnowledgeRevisionRequests', error);
  return (data ?? []) as KnowledgeRevisionRequest[];
}

/** Approve (apply_knowledge_revision) or reject (reject_knowledge_revision)
 *  a pending knowledge revision. Called by decideHumanTask's hook #5 when
 *  the gating human_tasks row is of type 'knowledge_revision'.
 *  On approve: a NEW knowledge_docs version is inserted (previous_version_id
 *  links back — never a destructive overwrite), then re-run through the
 *  SAME ingest-chunks embedding path every other doc uses so the improved
 *  content is retrievable immediately. */
export async function resolveKnowledgeRevision(
  requestId: string,
  decision: 'approved' | 'rejected',
  reason = ''
): Promise<{ ok: boolean; new_doc_id?: string | null; error?: string }> {
  if (decision === 'rejected') {
    const { data, error } = await supabase.rpc('reject_knowledge_revision', {
      p_request_id: requestId, p_reason: reason,
    });
    if (error) raise('resolveKnowledgeRevision (reject)', error);
    return data as { ok: boolean; error?: string };
  }
  const { data, error } = await supabase.rpc('apply_knowledge_revision', { p_request_id: requestId });
  if (error) raise('resolveKnowledgeRevision (apply)', error);
  const result = data as { ok: boolean; new_doc_id?: string; previous_doc_id?: string | null; error?: string };
  if (result?.ok && result.new_doc_id) {
    // Re-embed the new version through the existing chunk/embed path so the
    // improved content is retrievable right away — same path every other
    // knowledge doc goes through, not a special case.
    try { await ingestDocChunks(result.new_doc_id); }
    catch (err) { console.error('knowledge revision re-embed:', err); }
  }
  return result;
}

// ============================================================
// Knowledge-gap clusters (migration 070) — the automatic-detection
// half of the Knowledge Gaps page. A cluster is a group of similar
// low-confidence inquiries; once it crosses a tenant's configured
// min_cluster_size it gets promoted into a knowledge_revision_requests
// row (above), which is what a human actually approves/rejects.
// ============================================================

export interface KnowledgeGapCluster {
  id: string;
  tenant_id: string;
  category: string | null;
  representative_run_id: string;
  member_count: number;
  severity_score: number;
  root_cause_category: 'missing' | 'unretrievable' | 'contradicted' | 'stale' | null;
  reviewer_summary: string | null;
  status: 'open' | 'revision_requested' | 'resolved';
  revision_request_id: string | null;
  pre_fix_avg_confidence: number | null;
  fix_applied_at: string | null;
  recurred_after_fix: boolean;
  recurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeGapClusterMember {
  id: string;
  cluster_id: string;
  evidence_run_id: string;
  similarity_to_representative: number | null;
  frustration_score: number;
  added_at: string;
}

export interface KnowledgeGapPolicy {
  id: string;
  tenant_id: string;
  category: string | null;
  min_confidence_floor: number;
  min_cluster_size: number;
  window_days: number;
  similarity_threshold: number;
  enabled: boolean;
}

export async function listKnowledgeGapClusters(): Promise<KnowledgeGapCluster[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_gap_clusters').select('*')
    .eq('tenant_id', tid)
    .order('last_seen_at', { ascending: false });
  if (error) raise('listKnowledgeGapClusters', error);
  return (data ?? []) as KnowledgeGapCluster[];
}

export async function listKnowledgeGapPolicies(): Promise<KnowledgeGapPolicy[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('knowledge_gap_policies').select('*')
    .eq('tenant_id', tid);
  if (error) raise('listKnowledgeGapPolicies', error);
  return (data ?? []) as KnowledgeGapPolicy[];
}

/** The evidence behind a detected cluster: which inquiries make it up
 *  (real text, not invented "findings"), plus their DE attribution
 *  where evidence_runs.de_id is set. */
export async function getKnowledgeGapClusterDetail(cluster: KnowledgeGapCluster): Promise<{
  members: KnowledgeGapClusterMember[];
  inquiries: Record<string, { inquiry: string; de_id: string | null; created_at: string }>;
}> {
  const { data: members, error } = await supabase
    .from('knowledge_gap_cluster_members').select('*')
    .eq('cluster_id', cluster.id)
    .order('added_at', { ascending: true });
  if (error) raise('getKnowledgeGapClusterDetail (members)', error);

  const ids = Array.from(new Set([cluster.representative_run_id, ...(members ?? []).map(m => m.evidence_run_id)]));
  let inquiries: Record<string, { inquiry: string; de_id: string | null; created_at: string }> = {};
  if (ids.length > 0) {
    const { data: runs, error: runsErr } = await supabase
      .from('evidence_runs').select('id, inquiry, de_id, created_at')
      .in('id', ids);
    if (runsErr) raise('getKnowledgeGapClusterDetail (runs)', runsErr);
    inquiries = Object.fromEntries((runs ?? []).map(r => [r.id, { inquiry: r.inquiry, de_id: r.de_id, created_at: r.created_at }]));
  }
  return { members: (members ?? []) as KnowledgeGapClusterMember[], inquiries };
}
