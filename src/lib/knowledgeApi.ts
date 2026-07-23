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
  /** Per-DE knowledge scopes: 'tenant' = every DE and specialist answers from
   *  this doc; 'scoped' (mig 030) = only the subjects in knowledge_doc_scopes
   *  retrieve it; 'role' (mig 271) = only DEs whose archetype matches
   *  share_archetype_key (role-shared learning). All enforced server-side in
   *  the retrieval RPCs, not here. */
  visibility: 'tenant' | 'scoped' | 'role';
  /** For visibility='role' (mig 271): the archetype whose DEs can retrieve
   *  this doc. Null for tenant/scoped docs. */
  share_archetype_key: string | null;
  /** Simple version chain (migration 032): a revision APPLY inserts a new
   *  row pointing back at the doc it superseded — history is preserved,
   *  never destructively overwritten. */
  previous_version_id: string | null;
  is_current: boolean;
  /** Real "confirmed still accurate" stamp (migration 101) — null until
   *  a human explicitly re-verifies; distinct from updated_at, which
   *  only reflects the last content edit. */
  last_verified_at: string | null;
  /** Lifecycle governance (mig 285): steward, review cadence, and hard expiry. */
  owner_user_id: string | null;
  review_interval_days: number | null;
  expires_at: string | null;
  /** Retrieval weight / trust (mig 236). */
  authority: number | null;
  created_at: string;
  updated_at: string;
}

export async function getMyUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}
export async function markDocVerified(docId: string): Promise<void> {
  const { data, error } = await supabase.rpc('mark_doc_verified', { p_doc_id: docId });
  if (error) raise('markDocVerified', error);
  if (!(data as { ok?: boolean })?.ok) throw new Error('Could not mark verified.');
}
export interface DocLifecycle { ownerUserId?: string | null; reviewIntervalDays?: number | null; authority?: number | null; expiresAt?: string | null }
export async function setDocLifecycle(docId: string, l: DocLifecycle): Promise<void> {
  const { data, error } = await supabase.rpc('set_doc_lifecycle', {
    p_doc_id: docId,
    p_owner_user_id: l.ownerUserId ?? null,
    p_review_interval_days: l.reviewIntervalDays ?? null,
    p_authority: l.authority ?? null,
    p_expires_at: l.expiresAt ?? null,
  });
  if (error) raise('setDocLifecycle', error);
  if (!(data as { ok?: boolean })?.ok) throw new Error('Could not save lifecycle settings.');
}

import { raise, requireTenantId } from './liveShared';


// ── CRUD ──────────────────────────────────────────────────────────

// Ledger-3 (docs/16): the stored version chain finally gets a viewer — walk
// previous_version_id from the head, capped at 12 hops.
export async function listDocVersions(headId: string): Promise<KnowledgeDoc[]> {
  const chain: KnowledgeDoc[] = [];
  let cursor: string | null = headId;
  for (let hop = 0; cursor && hop < 12; hop++) {
    const { data, error } = await supabase.from('knowledge_docs').select('*').eq('id', cursor).maybeSingle();
    if (error || !data) break;
    chain.push(data as KnowledgeDoc);
    cursor = (data as KnowledgeDoc & { previous_version_id?: string | null }).previous_version_id ?? null;
  }
  return chain;
}

// Ledger-3: gap-detection policy — tunable from the product instead of raw
// SQL. RLS already scopes/permits tenant writes (mig 070).
export interface GapPolicy {
  id: string; category: string | null; min_confidence_floor: number;
  min_cluster_size: number; window_days: number; similarity_threshold: number; enabled: boolean;
}
export async function listGapPolicies(): Promise<GapPolicy[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase.from('knowledge_gap_policies').select('*').eq('tenant_id', tid).order('created_at');
  if (error) throw error;
  return (data ?? []) as GapPolicy[];
}
export async function updateGapPolicy(id: string, patch: Partial<Omit<GapPolicy, 'id' | 'category'>>): Promise<void> {
  const { error } = await supabase.from('knowledge_gap_policies').update(patch).eq('id', id);
  if (error) throw error;
}

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

// Phase-1 scale keystone (mig 279): server-side faceted, paginated search that
// returns a preview + the denormalized chunk counts + a window total — never the
// full corpus, never a per-load chunk aggregate. Replaces listKnowledgeDocs +
// listChunkStatus in the Library so a 100k-doc corpus doesn't load into the tab.
export interface SearchDocRow {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  source: 'upload' | 'paste' | 'connector';
  visibility: 'tenant' | 'scoped' | 'role';
  share_archetype_key: string | null;
  authority: number | null;
  last_verified_at: string | null;
  is_current: boolean;
  chunk_count: number;
  embedded_count: number;
  updated_at: string;
  citation_count: number;
  last_cited_at: string | null;
  total_count: number;
}
export interface SearchDocsParams {
  query?: string; tags?: string[]; source?: string | null; visibility?: string | null;
  collectionId?: string | null; currentOnly?: boolean; limit?: number; offset?: number;
}
export async function searchKnowledgeDocs(p: SearchDocsParams = {}): Promise<{ rows: SearchDocRow[]; total: number }> {
  const { data, error } = await supabase.rpc('search_knowledge_docs', {
    p_query: p.query?.trim() || null,
    p_tags: p.tags && p.tags.length ? p.tags : null,
    p_source: p.source ?? null,
    p_visibility: p.visibility ?? null,
    p_collection_id: p.collectionId ?? null,
    p_current_only: p.currentOnly ?? true,
    p_limit: p.limit ?? 50,
    p_offset: p.offset ?? 0,
  });
  if (error) raise('searchKnowledgeDocs', error);
  const rows = (data ?? []) as SearchDocRow[];
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

// ── Phase-3 WS5: collections (taxonomy) ───────────────────────────────────
export interface KnowledgeCollection { id: string; parent_id: string | null; name: string; description: string | null; doc_count: number }
export async function listKnowledgeCollections(): Promise<KnowledgeCollection[]> {
  const { data, error } = await supabase.rpc('list_knowledge_collections');
  if (error) return [];
  return (data ?? []) as KnowledgeCollection[];
}
export async function createKnowledgeCollection(name: string, description?: string): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase.from('knowledge_collections').insert({ tenant_id: tid, name: name.trim(), description: description?.trim() || null });
  if (error) raise('createKnowledgeCollection', error);
}
export async function deleteKnowledgeCollection(id: string): Promise<void> {
  const { error } = await supabase.from('knowledge_collections').delete().eq('id', id);
  if (error) raise('deleteKnowledgeCollection', error);
}
export async function listDocCollectionIds(docId: string): Promise<string[]> {
  const { data, error } = await supabase.from('knowledge_doc_collections').select('collection_id').eq('doc_id', docId);
  if (error) return [];
  return (data ?? []).map((r: { collection_id: string }) => r.collection_id);
}
export async function assignDocCollection(docId: string, collectionId: string): Promise<void> {
  const { data, error } = await supabase.rpc('assign_doc_collection', { p_doc_id: docId, p_collection_id: collectionId });
  if (error) raise('assignDocCollection', error);
  const r = data as { ok?: boolean; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? 'Could not add to collection.');
}
export async function unassignDocCollection(docId: string, collectionId: string): Promise<void> {
  const { error } = await supabase.rpc('unassign_doc_collection', { p_doc_id: docId, p_collection_id: collectionId });
  if (error) raise('unassignDocCollection', error);
}

// ── Phase-4 WS7: bulk maintenance (Class-A, no re-embed) ─────────────────────
async function bulkRpc(fn: string, args: Record<string, unknown>, verb: string): Promise<number> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string; [k: string]: unknown };
  if (!r?.ok) {
    if (r?.error === 'too_many') throw new Error(`Too many documents selected (max ${r.cap ?? 1000}).`);
    if (r?.error === 'reembed_disabled') throw new Error('Re-embed is turned off for this workspace.');
    throw new Error(r?.error ?? `Bulk ${verb} failed.`);
  }
  return Number(r.updated ?? r.added ?? r.verified ?? r.deleted ?? r.chunks_queued ?? 0);
}
export const bulkAddTag = (docIds: string[], tag: string) => bulkRpc('bulk_add_doc_tag', { p_doc_ids: docIds, p_tag: tag }, 'tag');
export const bulkAssignCollection = (docIds: string[], collectionId: string) => bulkRpc('bulk_assign_collection', { p_doc_ids: docIds, p_collection_id: collectionId }, 'assign');
export const bulkMarkVerified = (docIds: string[]) => bulkRpc('bulk_mark_verified', { p_doc_ids: docIds }, 'verify');
export const bulkDeleteDocs = (docIds: string[]) => bulkRpc('bulk_delete_docs', { p_doc_ids: docIds }, 'delete');
// Class-B: queue an in-place re-embed of the selected docs' chunks (gated on the
// default-OFF knowledge_reembed flag; the reembed-drain worker refreshes each
// chunk's vector without ever blanking it). Returns the number of chunks queued.
export const bulkReembedDocs = (docIds: string[]) => bulkRpc('bulk_reembed_docs', { p_doc_ids: docIds }, 're-embed');

// Whether this workspace has re-embed enabled + how many chunks are still
// re-indexing. Non-fatal: the UI simply hides the action if the RPC is absent
// or the flag is off. (enabled=false with the default-OFF flag = the common case.)
export async function getReembedStatus(): Promise<{ enabled: boolean; pending: number }> {
  const { data, error } = await supabase.rpc('get_reembed_status');
  if (error) return { enabled: false, pending: 0 };
  const r = data as { enabled?: boolean; pending?: number };
  return { enabled: !!r?.enabled, pending: Number(r?.pending ?? 0) };
}

// Phase-2 WS4: corpus-level "state of your knowledge" for the Hub overview,
// in one call over the Phase-1 denormalized signals + gaps + review queue.
export interface KnowledgeOverview {
  ok: boolean;
  total_docs: number; indexed_docs: number; keyword_only: number; stale_docs: number;
  role_shared: number; scoped: number; total_citations: number; cited_docs: number; never_cited: number;
  last_updated_at: string | null; open_gaps: number; pending_reviews: number;
  top_cited: { id: string; title: string; citation_count: number }[];
  recent: { id: string; title: string; updated_at: string; indexed: boolean }[];
}
export async function getKnowledgeOverview(): Promise<KnowledgeOverview | null> {
  // Non-fatal: the Hub simply omits the overview if the RPC isn't there yet.
  const { data, error } = await supabase.rpc('get_knowledge_overview');
  if (error) return null;
  const o = data as KnowledgeOverview;
  return o?.ok ? o : null;
}

// Phase-5 WS10: coverage-vs-demand. Joins DEMAND (open gap clusters) against
// COVERAGE (denormalized citation_count + usage rollup). The per-gap coverage
// verdict is opt-in (probe_enabled=false → gaps show coverage_state 'unknown').
export interface CoverageDemand {
  ok: boolean;
  probe_enabled: boolean;
  top_gaps: { id: string; category: string | null; severity_score: number | null; member_count: number | null;
              reviewer_summary: string | null; status: string; nearest_cited_dist: number | null;
              coverage_state: 'covered' | 'weak' | 'none' | 'unknown' }[];
  never_cited: { id: string; title: string; updated_at: string; last_verified_at: string | null }[];
  most_cited: { id: string; title: string; citation_count: number; last_cited_at: string | null }[];
  trend: { usage_date: string; citations: number; docs_cited: number }[];
}
export async function getKnowledgeCoverageDemand(days = 30, gapLimit = 20, listLimit = 10): Promise<CoverageDemand | null> {
  // Non-fatal: the panel simply omits itself if the RPC isn't deployed yet.
  const { data, error } = await supabase.rpc('get_knowledge_coverage_demand', { p_days: days, p_gap_limit: gapLimit, p_list_limit: listLimit });
  if (error) return null;
  const c = data as CoverageDemand;
  return c?.ok ? c : null;
}

// Phase-5 WS9: conflict / duplicate findings for human review. Detection is opt-in
// (default-OFF flag knowledge_conflict_detection); the status call lets the UI show
// an honest "not enabled" vs "none found" state.
export interface KnowledgeConflict {
  id: string; relation: 'near_duplicate' | 'potential_conflict'; status: string;
  cosine_distance: number; confidence: number | null;
  signal: { source?: string; rationale?: string; lexical?: string[]; note?: string } | null;
  doc_a_id: string; doc_a_title: string; doc_b_id: string; doc_b_title: string;
  authoritative_doc_id: string | null; detected_at: string;
}
export async function getKnowledgeConflicts(status = 'open', relation: string | null = null): Promise<KnowledgeConflict[]> {
  const { data, error } = await supabase.rpc('get_knowledge_conflicts', { p_status: status, p_relation: relation, p_limit: 50, p_offset: 0 });
  if (error) return [];
  return (data ?? []) as KnowledgeConflict[];
}
export async function getKnowledgeConflictStatus(): Promise<{ enabled: boolean; open_count: number }> {
  const { data, error } = await supabase.rpc('get_knowledge_conflict_status');
  if (error) return { enabled: false, open_count: 0 };
  const r = data as { enabled?: boolean; open_count?: number };
  return { enabled: !!r?.enabled, open_count: Number(r?.open_count ?? 0) };
}
export async function resolveKnowledgeConflict(
  id: string, resolution: 'resolved_pick_a' | 'resolved_pick_b' | 'merged' | 'dismissed', authoritativeDocId?: string | null): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_knowledge_conflict', {
    p_conflict_id: id, p_resolution: resolution, p_authoritative_doc_id: authoritativeDocId ?? null,
  });
  if (error) throw new Error(error.message);
  const r = data as { ok?: boolean; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? 'Resolve failed.');
}

// Fetch ONE doc with full content — the search rows carry only a preview, so the
// editor loads the real content on open (no truncation-on-save data loss).
export async function getKnowledgeDoc(id: string): Promise<KnowledgeDoc | null> {
  const { data, error } = await supabase.from('knowledge_docs').select('*').eq('id', id).maybeSingle();
  if (error) raise('getKnowledgeDoc', error);
  return (data as KnowledgeDoc) ?? null;
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

// Extract plain text from a PDF file or a web page via the
// extract-document edge function, so it can then be saved as a normal
// knowledge doc (chunk/embed path unchanged). Removes the text-only wall.
export async function extractPdf(file: File): Promise<{ title: string; text: string; chars: number }> {
  const file_base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read the file'));
    r.readAsDataURL(file);
  });
  const { data, error } = await supabase.functions.invoke('extract-document', {
    body: { kind: 'pdf', file_base64, filename: file.name },
  });
  if (error) throw new Error((data as { error?: string })?.error || error.message);
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as { title: string; text: string; chars: number };
}

export async function extractUrl(url: string): Promise<{ title: string; text: string; chars: number }> {
  const { data, error } = await supabase.functions.invoke('extract-document', {
    body: { kind: 'url', url },
  });
  if (error) throw new Error((data as { error?: string })?.error || error.message);
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as { title: string; text: string; chars: number };
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
    supabase.from('digital_employees').select('id, name').eq('tenant_id', tid).eq('is_specialist', true).order('created_at'),
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
  /** T1.3: a supervisor router picked a different teammate to answer */
  routed?: boolean;
  route_reason?: string;
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
  conversationId?: string | null,
  tenantId?: string | null,
): Promise<DEAnswerResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new DEAnswerError('server', 'Not signed in.');

  // T1.3: when we know the tenant, route through de-orchestrate — it resolves
  // the tenant's designated supervisor DE and either answers directly or routes
  // to the best-matched teammate. With no supervisor configured it is a pure
  // pass-through to de-answer, so this is a no-op until a supervisor is set.
  const endpoint = tenantId ? 'de-orchestrate' : 'de-answer';
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ question, conversation_id: conversationId ?? undefined, ...(tenantId ? { tenant_id: tenantId } : {}) }),
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
  // de-orchestrate reports who answered as handled_by:{de_id,name}; de-answer
  // reports de_id/de_name at top level. Fan them into one shape.
  const handledBy = (data.handled_by ?? null) as { de_id?: string | null; name?: string } | null;
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
    de_id: handledBy?.de_id ?? (typeof data.de_id === 'string' ? data.de_id : null),
    de_name: handledBy?.name ?? (typeof data.de_name === 'string' ? data.de_name : undefined),
    routed: !!data.routed,
    route_reason: typeof data.route_reason === 'string' ? data.route_reason : undefined,
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
