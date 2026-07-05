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
  action_key: 'add_internal_note' | 'update_status';
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

export async function testMcpSource(sourceId: string): Promise<{ ok: boolean; status: number; note: string; upgrade_note?: string; error?: string }> {
  return invokeSpecialist({ action: 'mcp_test', source_id: sourceId });
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
  action_key: 'add_internal_note' | 'update_status';
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
