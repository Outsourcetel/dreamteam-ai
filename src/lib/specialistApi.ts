// ============================================================
// Specialist system v1 — LIVE data layer (migration 024).
//
// Specialists are consulted when completing tasks. Per-source access
// mode is the CUSTOMER'S storage choice (constraint matrix in SQL):
//   knowledge → ingest · connector → ingest|fetch_only ·
//   mcp_server → fetch_only|reference · link → reference · media → ingest
//
// The Scribe sub-specialist ONLY writes back to connected systems,
// with STRUCTURAL guarantees (FK-required consultation grounding,
// server-side whitelisted payload templates, always-gated human task,
// audited citation chain) — see supabase/functions/specialist-consult.
// ============================================================
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';

// ── Types ─────────────────────────────────────────────────────────

export type SpecialistKey = 'technical' | 'legal' | 'finance' | 'people';
export type SourceType = 'knowledge' | 'connector' | 'mcp_server' | 'link' | 'media';
export type AccessMode = 'ingest' | 'fetch_only' | 'reference';
export type MediaKind = 'document' | 'image' | 'video';

/** The access-mode matrix — mirror of the SQL CHECK constraint. */
export const ACCESS_MODE_MATRIX: Record<SourceType, AccessMode[]> = {
  knowledge: ['ingest'],
  connector: ['fetch_only', 'ingest'],
  mcp_server: ['fetch_only', 'reference'],
  link: ['reference'],
  media: ['ingest'],
};

export const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  ingest: 'Ingest — stored & indexed in DreamTeam',
  fetch_only: 'Fetch-only — read at consult time, never stored',
  reference: 'Reference — registered & cited, content not read (v1)',
};

export interface SpecialistProfile {
  id: string;
  tenant_id: string;
  key: SpecialistKey;
  name: string;
  charter: string;
  status: 'active' | 'paused';
  created_at: string;
  updated_at: string;
}

export interface McpTestResult { ok: boolean; status: number; note: string; at: string }

export interface SpecialistSource {
  id: string;
  profile_id: string;
  source_type: SourceType;
  access_mode: AccessMode;
  label: string;
  config: {
    tags?: string[];
    connector_id?: string;
    object_types?: string[];
    endpoint?: string;
    transport?: 'http';
    auth_header?: string;
    url?: string;
    title?: string;
    note?: string;
    last_test?: McpTestResult;
    mcp?: {
      server_info?: { name?: string; version?: string; protocolVersion?: string };
      tools?: Array<{ name: string; description: string }>;
      tool_count?: number;
      last_handshake?: { ok: boolean; at: string; latency_ms?: number; error?: string; stage?: string };
    };
  };
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface QualityFlag {
  flag: 'stale' | 'incomplete' | 'conflicting' | 'unreadable';
  note: string;
  raised_by: string;
  at: string;
}

export interface MediaAsset {
  id: string;
  tenant_id: string;
  profile_id: string | null;
  kind: MediaKind;
  title: string;
  storage_path: string;
  mime: string;
  size_bytes: number;
  tags: string[];
  sort_order: number;
  quality_flags: QualityFlag[];
  extracted: boolean;
  knowledge_doc_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetrievedSource {
  source_id: string;
  source_type: SourceType;
  access_mode: AccessMode;
  label: string;
  kind: 'content' | 'reference' | 'skipped';
  detail: string;
  doc_titles?: string[];
}

export interface SpecConsultation {
  id: string;
  tenant_id: string;
  profile_id: string;
  requested_by: 'human' | 'de' | 'playbook';
  run_id: string | null;
  question: string;
  answer: string | null;
  confidence: number | null;
  sources_used: RetrievedSource[];
  status: 'answered' | 'blocked_llm' | 'escalated' | 'error';
  created_at: string;
}

export interface ConsultResult {
  consultation_id: string | null;
  answer?: string;
  confidence?: number;
  citations?: string[];
  retrieved_sources: RetrievedSource[];
  needs_escalation?: boolean;
  blocked?: boolean;
  rule?: string;
  error?: string;
  note?: string;
}

export interface ScribeRequest {
  id: string;
  tenant_id: string;
  profile_id: string;
  consultation_id: string;
  connector_id: string;
  action_key: 'add_internal_note' | 'update_status' | 'reply_to_ticket';
  external_ref: string;
  payload: Record<string, unknown>;
  payload_source: 'consultation_citation';
  status: 'pending_approval' | 'approved' | 'executed' | 'rejected' | 'failed';
  task_id: string | null;
  executed_at: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ── Plumbing ──────────────────────────────────────────────────────

import { raise, requireTenantId } from './liveShared';


const notify = () => { try { window.dispatchEvent(new Event('dt-state-changed')); } catch { /* noop */ } };

async function auditConfig(action: string, detail: Record<string, unknown>): Promise<void> {
  const { appendAuditEvent } = await import('./guardrailApi');
  await appendAuditEvent({
    actor: 'You', actor_type: 'human', category: 'config_change', action, detail,
  });
}

async function invokeSpecialist<T>(body: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/specialist-consult`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) throw new CustomerApiError(`HTTP ${res.status}`, false);
  return data as T;
}

// ── Profile ───────────────────────────────────────────────────────

export async function getProfile(key: SpecialistKey): Promise<SpecialistProfile | null> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('specialist_profiles').select('*')
    .eq('tenant_id', tid).eq('key', key).maybeSingle();
  if (error) raise('getProfile', error);
  return (data as SpecialistProfile) ?? null;
}

export async function installTechnicalSpecialist(): Promise<{ profile_id: string; already_installed: boolean }> {
  const { data, error } = await supabase.rpc('install_technical_specialist');
  if (error) raise('installTechnicalSpecialist', error);
  const res = data as { profile_id?: string; already_installed?: boolean; error?: string };
  if (res?.error) raise('installTechnicalSpecialist', { message: res.error.replace(/_/g, ' ') });
  notify();
  return { profile_id: res.profile_id!, already_installed: !!res.already_installed };
}

export async function updateProfile(
  id: string,
  updates: Partial<Pick<SpecialistProfile, 'name' | 'charter' | 'status'>>,
): Promise<SpecialistProfile> {
  const { data, error } = await supabase
    .from('specialist_profiles').update(updates).eq('id', id).select().single();
  if (error) raise('updateProfile', error);
  const prof = data as SpecialistProfile;
  await auditConfig(
    updates.status
      ? `Specialist ${updates.status === 'active' ? 'activated' : 'paused'} — ${prof.name}`
      : `Specialist charter edited — ${prof.name}`,
    { kind: 'specialist_profile', profile_id: id, key: prof.key, status: prof.status },
  );
  notify();
  return prof;
}

// ── Sources ───────────────────────────────────────────────────────

export async function listSources(profileId: string): Promise<SpecialistSource[]> {
  const { data, error } = await supabase
    .from('specialist_sources').select('*')
    .eq('profile_id', profileId).order('created_at', { ascending: true });
  if (error) raise('listSources', error);
  return (data ?? []) as SpecialistSource[];
}

export async function addSource(input: {
  profile_id: string;
  source_type: SourceType;
  access_mode: AccessMode;
  label: string;
  config: SpecialistSource['config'];
  secret?: string; // mcp auth value — stored via RPC, never in config
}): Promise<SpecialistSource> {
  if (!ACCESS_MODE_MATRIX[input.source_type].includes(input.access_mode)) {
    throw new CustomerApiError(
      `${input.source_type} sources only support: ${ACCESS_MODE_MATRIX[input.source_type].join(', ')}`, false);
  }
  const { data, error } = await supabase
    .from('specialist_sources')
    .insert({
      profile_id: input.profile_id, source_type: input.source_type,
      access_mode: input.access_mode, label: input.label, config: input.config,
    })
    .select().single();
  if (error) raise('addSource', error);
  const src = data as SpecialistSource;
  if (input.secret) {
    const { error: secErr } = await supabase.rpc('set_specialist_source_secret', {
      p_source_id: src.id, p_secret: input.secret,
    });
    if (secErr) raise('set_specialist_source_secret', secErr);
  }
  await auditConfig(
    `Specialist source added — ${src.label} (${src.source_type}, ${src.access_mode})`,
    { kind: 'specialist_source', source_id: src.id, source_type: src.source_type, access_mode: src.access_mode },
  );
  notify();
  return src;
}

export async function updateSource(
  source: SpecialistSource,
  updates: Partial<Pick<SpecialistSource, 'label' | 'config' | 'enabled'>>,
): Promise<SpecialistSource> {
  const { data, error } = await supabase
    .from('specialist_sources').update(updates).eq('id', source.id).select().single();
  if (error) raise('updateSource', error);
  await auditConfig(
    updates.enabled !== undefined
      ? `Specialist source ${updates.enabled ? 'enabled' : 'disabled'} — ${source.label} (${source.source_type})`
      : `Specialist source edited — ${source.label} (${source.source_type})`,
    { kind: 'specialist_source', source_id: source.id, source_type: source.source_type },
  );
  notify();
  return data as SpecialistSource;
}

export async function removeSource(source: SpecialistSource): Promise<void> {
  const { error } = await supabase.from('specialist_sources').delete().eq('id', source.id);
  if (error) raise('removeSource', error);
  await auditConfig(
    `Specialist source removed — ${source.label} (${source.source_type}, ${source.access_mode})`,
    { kind: 'specialist_source', source_id: source.id, source_type: source.source_type },
  );
  notify();
}

export interface McpHandshakeResult {
  ok: boolean;
  server_info?: { name?: string; version?: string; protocolVersion?: string };
  tools?: Array<{ name: string; description: string }>;
  latency_ms?: number;
  error?: string;
  stage?: string;
}

/** Real MCP handshake (Streamable HTTP): initialize → tools/list.
 *  The tool inventory is stored on the source row (config.mcp). */
export async function mcpHandshake(sourceId: string): Promise<McpHandshakeResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CustomerApiError('Not signed in.', false);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp-client`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'handshake', source_id: sourceId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) throw new CustomerApiError(`HTTP ${res.status}`, false);
  notify();
  return data as McpHandshakeResult;
}

// ── Evidence pipeline ─────────────────────────────────────────────

export type EvidenceOutcome = 'ok' | 'skipped_not_connected' | 'failed';
export interface EvidenceCitation { system: string; ref: string; title: string; url: string | null; snippet: string }
export interface EvidenceStep {
  kind: 'account_context' | 'knowledge_search' | 'history_check' | 'mcp_tool' | 'compose';
  system: string;
  query: string;
  outcome: EvidenceOutcome;
  summary: string;
  item_count: number;
  latency_ms: number;
  citations: EvidenceCitation[];
  /** Category-contract fields (migration 027/036) — which canonical
   *  category+op this step called, and which provider answered it.
   *  Not every step carries these (e.g. the internal knowledge_search
   *  step over knowledge_docs has no connector behind it). */
  category?: string;
  op?: string;
  provider?: string;
}
export interface EvidenceRun {
  id: string;
  tenant_id: string;
  de_id: string | null;
  specialist_id: string | null;
  inquiry: string;
  account_ref: string | null;
  status: 'running' | 'complete' | 'failed';
  steps: EvidenceStep[];
  confidence_inputs: {
    knowledge_hits?: number;
    history_corroborations?: number;
    account_context_found?: boolean;
    systems_consulted?: number;
    systems_skipped_not_connected?: number;
    systems_failed?: number;
  };
  answer_status: 'llm_not_configured' | 'answered' | 'blocked' | 'error';
  answer: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ResolveInquiryResult {
  evidence_run_id?: string;
  status?: string;
  steps?: EvidenceStep[];
  confidence_inputs?: EvidenceRun['confidence_inputs'];
  answer_status?: string;
  answer?: string | null;
  note?: string;
  error?: string;
}

/** Run the evidence pipeline for a customer inquiry:
 *  account context → knowledge → past-case verification → evidence bundle. */
export async function resolveInquiry(inquiry: string, accountRef?: string): Promise<ResolveInquiryResult> {
  const res = await invokeSpecialist<ResolveInquiryResult>({
    action: 'resolve_inquiry', inquiry, account_ref: accountRef ?? '',
    profile_key: 'technical',
  });
  notify();
  return res;
}

export async function listEvidenceRuns(limit = 20): Promise<EvidenceRun[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('evidence_runs').select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) raise('listEvidenceRuns', error);
  return (data ?? []) as EvidenceRun[];
}

// ── Proactive triage (migration 034) — "DE at work" live queue ────
//
// Reuses the SAME evidence pipeline (resolveInquiry above) and the
// SAME guardrail+trust composition generateInvoice uses for invoices —
// no parallel confidence system. Every row here is a DECISION on top
// of an evidence_runs row: would the DE have auto-sent, does it need
// a human, was it blocked by a guardrail, or was it skipped because
// the DE/specialist has no access grant to that system.

export type InquiryDecisionSource = 'manual' | 'proactive_trigger' | 'manual_simulation';
// 'would_act'/'acted' added in migration 036 (the Generalized Trigger
// Layer) — the act-side siblings of would_auto_send/needs_review. A
// decision becomes 'would_act' when a registered action_definition
// exists for the item's category but composition (destructive-always-
// gates / guardrail / trust) requires human approval first, and
// 'acted' when connector-hub's execute_action actually ran (auto or
// after approval) — distinct from 'would_auto_send', which still only
// ever records intent to ANSWER, never to act.
export type InquiryDecisionKind =
  | 'would_auto_send' | 'needs_review' | 'blocked_guardrail' | 'skipped_no_access'
  | 'would_act' | 'acted';

export interface EvidenceRunDecision {
  id: string;
  tenant_id: string;
  evidence_run_id: string;
  connector_id: string | null;
  external_ref: string | null;
  source: InquiryDecisionSource;
  decision: InquiryDecisionKind;
  confidence: number | null;
  guardrail_rule_id: string | null;
  trust_level: number | null;
  reasoning: string;
  human_task_id: string | null;
  created_at: string;
  /** migration 036: which of the 9 category-contract categories this
   *  item came from (null for pre-036 rows/the manual/simulation path
   *  when a category wasn't recorded), and the linked action_executions
   *  row when the decision resulted in (or awaits) a real ACT attempt. */
  source_category?: string | null;
  action_execution_id?: string | null;
}

/** Live "DE at work" feed: evidence_runs joined with their decision
 *  (when one exists — human-invoked resolve_inquiry runs have none,
 *  honestly, since a human reading the answer IS the decision there). */
export interface DEActivityRow {
  evidence_run: EvidenceRun;
  decision: EvidenceRunDecision | null;
}

export async function listDEActivity(limit = 30): Promise<DEActivityRow[]> {
  const tid = await requireTenantId();
  const [{ data: runs, error: runErr }, { data: decisions, error: decErr }] = await Promise.all([
    supabase.from('evidence_runs').select('*').eq('tenant_id', tid)
      .order('created_at', { ascending: false }).limit(limit),
    supabase.from('evidence_run_decisions').select('*').eq('tenant_id', tid)
      .order('created_at', { ascending: false }).limit(limit),
  ]);
  if (runErr) raise('listDEActivity (evidence_runs)', runErr);
  if (decErr) raise('listDEActivity (evidence_run_decisions)', decErr);
  const byRun = new Map<string, EvidenceRunDecision>();
  for (const d of (decisions ?? []) as EvidenceRunDecision[]) byRun.set(d.evidence_run_id, d);
  return ((runs ?? []) as EvidenceRun[]).map((r) => ({ evidence_run: r, decision: byRun.get(r.id) ?? null }));
}

export interface SimulateInquiryResult extends ResolveInquiryResult {
  decision?: InquiryDecisionKind;
  confidence?: number;
  reasoning?: string;
  human_task_id?: string | null;
  simulated?: boolean;
}

/** DEMO-SAFE MANUAL TRIGGER — "Simulate an incoming inquiry". Runs the
 *  exact same pipeline + triage composition RIGHT NOW so the mechanism
 *  can be watched without waiting for a real connector to have new
 *  data. ALWAYS tagged source='manual_simulation' — never conflated
 *  with the genuine automatic path (source='proactive_trigger'). */
export async function simulateInquiry(inquiry: string, accountRef?: string): Promise<SimulateInquiryResult> {
  const res = await invokeSpecialist<SimulateInquiryResult>({
    action: 'simulate_inquiry', inquiry, account_ref: accountRef ?? '',
  });
  notify();
  return res;
}

// ── Media library ─────────────────────────────────────────────────

const EXTRACTABLE = /\.(txt|md|markdown)$/i;

export function detectKind(file: File): MediaKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'document';
}

export async function listMedia(profileId: string): Promise<MediaAsset[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('media_assets').select('*')
    .eq('tenant_id', tid).eq('profile_id', profileId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) raise('listMedia', error);
  return (data ?? []) as MediaAsset[];
}

/**
 * Upload a media file. Text-extractable types (.txt/.md) are extracted
 * client-side into a linked knowledge_doc (tagged specialist:{key}) so the
 * specialist can consult them NOW. Everything else is stored + indexed by
 * title/tags with extracted=false — the honest state until content
 * extraction (pdf/vision) is activated.
 */
export async function uploadMedia(
  file: File,
  profileId: string,
  profileKey: SpecialistKey,
  tags: string[],
): Promise<MediaAsset> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const path = `${tid}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const { error: upErr } = await supabase.storage
    .from('specialist-media')
    .upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (upErr) raise('uploadMedia (storage)', upErr);

  const kind = detectKind(file);
  const extractable = kind === 'document' && EXTRACTABLE.test(file.name);
  let knowledgeDocId: string | null = null;
  if (extractable) {
    try {
      const text = await file.text();
      const { data: doc, error: docErr } = await supabase
        .from('knowledge_docs')
        .insert({
          tenant_id: tid,
          title: file.name.replace(EXTRACTABLE, ''),
          content: text,
          source: 'upload',
          tags: [...new Set([`specialist:${profileKey}`, ...tags])],
        })
        .select('id').single();
      if (!docErr && doc) {
        knowledgeDocId = doc.id;
        // Fire-and-forget semantic indexing (free edge embeddings).
        void import('./knowledgeApi').then(({ ingestDocChunks }) => ingestDocChunks(doc.id)).catch(() => undefined);
      }
    } catch { /* extraction is best-effort; asset stays extracted=false */ }
  }

  const { data, error } = await supabase
    .from('media_assets')
    .insert({
      tenant_id: tid, profile_id: profileId, kind,
      title: file.name, storage_path: path,
      mime: file.type || '', size_bytes: file.size, tags,
      extracted: !!knowledgeDocId, knowledge_doc_id: knowledgeDocId,
      created_by: user?.id ?? null,
    })
    .select().single();
  if (error) raise('uploadMedia', error);
  const asset = data as MediaAsset;
  await auditConfig(
    `Specialist media uploaded — ${file.name} (${kind}${knowledgeDocId ? ', text extracted to knowledge' : ', indexed by title/tags — content extraction on activation'})`,
    { kind: 'specialist_media', asset_id: asset.id, media_kind: kind, extracted: !!knowledgeDocId, size_bytes: file.size },
  );
  notify();
  return asset;
}

export async function updateMedia(
  id: string,
  updates: Partial<Pick<MediaAsset, 'title' | 'tags' | 'sort_order'>>,
): Promise<MediaAsset> {
  const { data, error } = await supabase
    .from('media_assets').update(updates).eq('id', id).select().single();
  if (error) raise('updateMedia', error);
  notify();
  return data as MediaAsset;
}

export async function raiseQualityFlag(
  asset: MediaAsset,
  flag: QualityFlag['flag'],
  note: string,
): Promise<MediaAsset> {
  const { data: { user } } = await supabase.auth.getUser();
  const entry: QualityFlag = {
    flag, note, raised_by: user?.email ?? user?.id ?? 'unknown', at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('media_assets')
    .update({ quality_flags: [...(asset.quality_flags ?? []), entry] })
    .eq('id', asset.id).select().single();
  if (error) raise('raiseQualityFlag', error);
  await auditConfig(
    `Media quality flag raised — "${asset.title}" flagged ${flag}${note ? `: ${note}` : ''}`,
    { kind: 'specialist_media', asset_id: asset.id, flag, note },
  );
  notify();
  return data as MediaAsset;
}

export async function deleteMedia(asset: MediaAsset): Promise<void> {
  await supabase.storage.from('specialist-media').remove([asset.storage_path]);
  const { error } = await supabase.from('media_assets').delete().eq('id', asset.id);
  if (error) raise('deleteMedia', error);
  await auditConfig(
    `Specialist media removed — ${asset.title}`,
    { kind: 'specialist_media', asset_id: asset.id },
  );
  notify();
}

// ── Consultations ─────────────────────────────────────────────────

export async function consult(
  profileKey: SpecialistKey,
  question: string,
  context?: Record<string, unknown>,
): Promise<ConsultResult> {
  const res = await invokeSpecialist<ConsultResult>({
    action: 'consult', profile_key: profileKey, question, context: context ?? {},
    requested_by: 'human',
  });
  notify();
  return res;
}

export async function listConsultations(profileId: string, limit = 30): Promise<SpecConsultation[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('spec_consultations').select('*')
    .eq('tenant_id', tid).eq('profile_id', profileId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) raise('listConsultations', error);
  return (data ?? []) as SpecConsultation[];
}

// ── Scribe ────────────────────────────────────────────────────────

export async function createScribeRequest(input: {
  consultation_id: string;
  connector_id: string;
  action_key: 'add_internal_note' | 'update_status' | 'reply_to_ticket';
  external_ref: string;
  status_value?: 'open' | 'pending' | 'hold' | 'solved';
}): Promise<{ ok?: boolean; request_id?: string; task_id?: string; payload?: Record<string, unknown>; error?: string }> {
  const res = await invokeSpecialist<{ ok?: boolean; request_id?: string; task_id?: string; payload?: Record<string, unknown>; error?: string }>({
    action: 'scribe_create', ...input,
  });
  notify();
  return res;
}

export async function listScribeRequests(profileId: string, limit = 30): Promise<ScribeRequest[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('scribe_requests').select('*')
    .eq('tenant_id', tid).eq('profile_id', profileId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) raise('listScribeRequests', error);
  return (data ?? []) as ScribeRequest[];
}

/**
 * Scribe resolution hook — called from decideHumanTask (hook #3,
 * alongside the playbook + onboarding hooks, never replacing them) when
 * the decided task belongs to a scribe_request. Best-effort: the task
 * decision itself has already persisted.
 */
export async function resolveScribeRequest(
  taskId: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  try {
    const res = await invokeSpecialist<{ decided?: boolean; status?: string; reason?: string; error?: string }>({
      action: 'scribe_decide', task_id: taskId, decision,
    });
    if (res?.error || res?.decided === false) {
      console.warn('resolveScribeRequest:', res?.error ?? res?.reason);
    }
    notify();
  } catch (err) {
    console.error('resolveScribeRequest:', err);
  }
}
