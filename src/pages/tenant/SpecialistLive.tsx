import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, th, td } from '../../components/ui';
import { CustomerApiError } from '../../lib/customerApi';
import { listConnectors, Connector } from '../../lib/connectorApi';
import {
  SpecialistProfile, SpecialistSource, MediaAsset, SpecConsultation, ScribeRequest,
  ConsultResult, SourceType, AccessMode, QualityFlag,
  ACCESS_MODE_MATRIX, ACCESS_MODE_LABELS,
  getProfile, installTechnicalSpecialist, updateProfile,
  listSources, addSource, updateSource, removeSource, mcpHandshake,
  listMedia, uploadMedia, raiseQualityFlag, deleteMedia, updateMedia,
  consult, listConsultations, listScribeRequests, createScribeRequest,
  resolveInquiry, listEvidenceRuns, EvidenceRun, EvidenceStep, ResolveInquiryResult,
  startEvidenceConversation,
} from '../../lib/specialistApi';
import {
  listActionDefinitions, previewAction, ActionDefinition, ActionPreviewResult,
} from '../../lib/connectorApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../components/LiveDataStates';
import {
  submitEvidenceFeedback, listEvidenceFeedback, EvidenceFeedback, EvidenceVerdict,
} from '../../lib/knowledgeApi';
import type { Page } from '../../types';
import { ConfirmDeleteModal } from '../../components';
import { AmendmentWizard } from '../../components/AmendmentWizard';

// ============================================================
// Technical Specialist — LIVE (migration 024).
// Charter + sources (per-customer access modes) + media library +
// consultation console + Scribe queue. Honest about what's dormant:
// the LLM answer path (ANTHROPIC_API_KEY) and
// pdf/video content extraction.
// ============================================================

const fmtDate = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const inputCls = 'w-full text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500';
const selectCls = 'text-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500';
const btnPrimary = 'text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors';
const btnGhost = 'text-sm px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-500 disabled:opacity-40 transition-colors';

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  knowledge: 'Knowledge (tag-scoped docs)',
  connector: 'Connected system',
  mcp_server: 'MCP server',
  link: 'Reference link',
  media: 'Media library',
};

const STATUS_CHIP: Record<string, string> = {
  answered: 'bg-emerald-500/20 text-emerald-400',
  blocked_llm: 'bg-amber-500/20 text-amber-400',
  escalated: 'bg-orange-500/20 text-orange-400',
  error: 'bg-red-500/20 text-red-400',
  pending_approval: 'bg-amber-500/20 text-amber-400',
  approved: 'bg-indigo-500/20 text-indigo-400',
  executed: 'bg-emerald-500/20 text-emerald-400',
  rejected: 'bg-slate-600 text-slate-400',
  failed: 'bg-red-500/20 text-red-400',
};

const Chip = ({ label, cls }: { label: string; cls?: string }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls ?? 'bg-slate-700 text-slate-400'}`}>{label}</span>
);

// ── Add-source form ───────────────────────────────────────────────

interface AddSourceState {
  source_type: SourceType;
  access_mode: AccessMode;
  label: string;
  tags: string;
  connector_id: string;
  endpoint: string;
  auth_header: string;
  secret: string;
  url: string;
  note: string;
}
const emptyAdd: AddSourceState = {
  source_type: 'knowledge', access_mode: 'ingest', label: '', tags: '',
  connector_id: '', endpoint: '', auth_header: '', secret: '', url: '', note: '',
};

function AddSourceForm({ profileId, connectors, onDone, onError }: {
  profileId: string; connectors: Connector[]; onDone: () => void; onError: (m: string) => void;
}) {
  const [s, setS] = useState<AddSourceState>({ ...emptyAdd });
  const [saving, setSaving] = useState(false);
  const modes = ACCESS_MODE_MATRIX[s.source_type];

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const config: SpecialistSource['config'] = {};
      if (s.source_type === 'knowledge') config.tags = s.tags.split(',').map(t => t.trim()).filter(Boolean);
      if (s.source_type === 'connector') config.connector_id = s.connector_id;
      if (s.source_type === 'mcp_server') { config.endpoint = s.endpoint.trim(); config.transport = 'http'; if (s.auth_header.trim()) config.auth_header = s.auth_header.trim(); }
      if (s.source_type === 'link') { config.url = s.url.trim(); config.note = s.note; }
      await addSource({
        profile_id: profileId, source_type: s.source_type, access_mode: s.access_mode,
        label: s.label.trim() || SOURCE_TYPE_LABELS[s.source_type], config,
        secret: s.source_type === 'mcp_server' && s.secret.trim() ? s.secret.trim() : undefined,
      });
      setS({ ...emptyAdd });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const canSave = (s.source_type === 'knowledge')
    || (s.source_type === 'connector' && !!s.connector_id)
    || (s.source_type === 'mcp_server' && !!s.endpoint.trim())
    || (s.source_type === 'link' && !!s.url.trim())
    || s.source_type === 'media';

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3">
      <div className="flex gap-2 flex-wrap">
        <select className={selectCls} value={s.source_type}
          onChange={e => {
            const t = e.target.value as SourceType;
            setS({ ...s, source_type: t, access_mode: ACCESS_MODE_MATRIX[t][0] });
          }}>
          {(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map(t => (
            <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select className={selectCls} value={s.access_mode} onChange={e => setS({ ...s, access_mode: e.target.value as AccessMode })}>
          {modes.map(m => <option key={m} value={m}>{ACCESS_MODE_LABELS[m]}</option>)}
        </select>
        <input className={inputCls + ' !w-56'} placeholder="Label" value={s.label} onChange={e => setS({ ...s, label: e.target.value })} />
      </div>
      <p className="text-[11px] text-slate-500">
        The access mode is the customer's storage choice — ingest stores content in DreamTeam, fetch-only reads live and never persists, reference only registers and cites.
      </p>
      {s.source_type === 'knowledge' && (
        <input className={inputCls} placeholder="Scope tags, comma-separated (empty = all knowledge docs)" value={s.tags} onChange={e => setS({ ...s, tags: e.target.value })} />
      )}
      {s.source_type === 'connector' && (
        connectors.length === 0
          ? <p className="text-xs text-amber-400">No connectors configured yet — connect one in Systems → Connectors first.</p>
          : <select className={selectCls + ' w-full'} value={s.connector_id} onChange={e => setS({ ...s, connector_id: e.target.value })}>
              <option value="">Select a connector…</option>
              {connectors.map(c => <option key={c.id} value={c.id}>{c.display_name || c.provider} — {c.base_url} ({c.status})</option>)}
            </select>
      )}
      {s.source_type === 'mcp_server' && (
        <div className="space-y-2">
          <input className={inputCls} placeholder="Endpoint URL (https://…)" value={s.endpoint} onChange={e => setS({ ...s, endpoint: e.target.value })} />
          <div className="flex gap-2">
            <input className={inputCls} placeholder="Auth header name (optional, e.g. Authorization)" value={s.auth_header} onChange={e => setS({ ...s, auth_header: e.target.value })} />
            <input className={inputCls} type="password" placeholder="Auth header value (stored server-side only)" value={s.secret} onChange={e => setS({ ...s, secret: e.target.value })} />
          </div>
          <p className="text-[11px] text-slate-500">Real MCP client: after adding, run Handshake to connect and list the server's tools. Failures are shown honestly.</p>
        </div>
      )}
      {s.source_type === 'link' && (
        <div className="flex gap-2">
          <input className={inputCls} placeholder="https://…" value={s.url} onChange={e => setS({ ...s, url: e.target.value })} />
          <input className={inputCls} placeholder="Note (optional)" value={s.note} onChange={e => setS({ ...s, note: e.target.value })} />
        </div>
      )}
      {s.source_type === 'media' && (
        <p className="text-[11px] text-slate-500">Points the specialist at this profile's media library (upload assets below).</p>
      )}
      <button className={btnPrimary} disabled={saving || !canSave} onClick={() => void submit()}>
        {saving ? 'Adding…' : '+ Add source'}
      </button>
    </div>
  );
}

// ── Evidence trail renderer ───────────────────────────────────────

const STEP_ICON: Record<string, string> = {
  account_context: '🏢', knowledge_search: '📚', history_check: '🕓', prior_experience: '🧠', mcp_tool: '🔧', compose: '🧾',
};
const STEP_LABEL: Record<string, string> = {
  account_context: 'Account configuration',
  knowledge_search: 'Knowledge',
  history_check: 'Past cases (external system)',
  prior_experience: 'Prior experience (this DE\'s own memory)',
  mcp_tool: 'MCP tool',
  compose: 'Evidence bundle',
};
const OUTCOME_CHIP: Record<string, [string, string]> = {
  ok: ['OK', 'bg-emerald-500/20 text-emerald-400'],
  skipped_not_connected: ['Not connected — skipped', 'bg-slate-600 text-slate-300'],
  failed: ['Failed', 'bg-red-500/20 text-red-400'],
  denied_no_access: ['No access — blocked by your data access rules', 'bg-rose-500/20 text-rose-300'],
};

const VERDICT_OPTIONS: { key: EvidenceVerdict; label: string; cls: string }[] = [
  { key: 'accurate', label: 'Accurate', cls: 'bg-emerald-600 hover:bg-emerald-500 text-white' },
  { key: 'needs_improvement', label: 'Needs improvement', cls: 'bg-amber-600 hover:bg-amber-500 text-white' },
  { key: 'inaccurate', label: 'Inaccurate', cls: 'bg-red-600 hover:bg-red-500 text-white' },
];

/** "Was this evidence accurate?" verdict control — the human-in-the-loop
 *  entry point for the Knowledge Feedback Loop (migration 032). Verdicts
 *  of 'needs_improvement' / 'inaccurate' auto-create a pending knowledge
 *  revision request + a human task, server-side (submit_evidence_feedback).
 *  'accurate' records feedback only — no revision, no task. */
function EvidenceVerdictControl({ evidenceRunId, onSubmitted }: { evidenceRunId: string; onSubmitted?: () => void }) {
  const [picked, setPicked] = useState<EvidenceVerdict | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; revision_request_id?: string | null; error?: string } | null>(null);
  const [past, setPast] = useState<EvidenceFeedback[]>([]);

  useEffect(() => {
    let live = true;
    listEvidenceFeedback(evidenceRunId).then((f) => { if (live) setPast(f); }).catch(() => {});
    return () => { live = false; };
  }, [evidenceRunId]);

  const submit = async () => {
    if (!picked || submitting) return;
    setSubmitting(true);
    try {
      const res = await submitEvidenceFeedback(evidenceRunId, picked, notes.trim());
      setResult(res);
      setPast(await listEvidenceFeedback(evidenceRunId).catch(() => past));
      onSubmitted?.();
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  if (past.length > 0 && !picked) {
    const latest = past[0];
    return (
      <div className="mt-3 pt-3 border-t border-slate-700">
        <p className="text-[11px] font-medium text-slate-400 mb-1">Reviewer verdict</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip label={latest.verdict.replace('_', ' ')}
            cls={latest.verdict === 'accurate' ? 'bg-emerald-500/20 text-emerald-400' : latest.verdict === 'needs_improvement' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'} />
          {latest.notes && <span className="text-[11px] text-slate-500">"{latest.notes}"</span>}
        </div>
        {latest.verdict !== 'accurate' && (
          <p className="text-[10px] text-teal-400 mt-1">A knowledge revision request was drafted for human review — see Knowledge → Library → Revisions.</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-700">
      <p className="text-[11px] font-medium text-slate-400 mb-1.5">Was this evidence accurate?</p>
      <div className="flex gap-1.5 flex-wrap mb-2">
        {VERDICT_OPTIONS.map((v) => (
          <button key={v.key}
            className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${picked === v.key ? v.cls : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            onClick={() => setPicked(v.key)}>
            {v.label}
          </button>
        ))}
      </div>
      {picked && (
        <div className="flex gap-2">
          <input className={inputCls + ' flex-1'} placeholder="Optional note (e.g. what should be added or fixed)"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className={btnPrimary} disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      )}
      {result && (
        result.ok ? (
          <p className="text-[11px] text-emerald-400 mt-1.5">
            Feedback recorded.{result.revision_request_id ? ' A knowledge revision request was drafted and sent for human approval.' : ''}
          </p>
        ) : (
          <p className="text-[11px] text-red-400 mt-1.5">Could not submit: {result.error}</p>
        )
      )}
    </div>
  );
}

function EvidenceTrail({ steps, confidence, answerStatus, answer, note, evidenceRunId }: {
  steps: EvidenceStep[];
  confidence?: EvidenceRun['confidence_inputs'];
  answerStatus?: string;
  answer?: string | null;
  note?: string;
  evidenceRunId?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="space-y-2.5">
        {steps.map((s, i) => {
          const [ol, oc] = OUTCOME_CHIP[s.outcome] ?? [s.outcome, 'bg-slate-700 text-slate-400'];
          return (
            <div key={i} className="flex gap-2.5">
              <span className="text-base leading-5">{STEP_ICON[s.kind] ?? '•'}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-white">{STEP_LABEL[s.kind] ?? s.kind}</span>
                  <span className="text-[11px] text-slate-500">{s.system}</span>
                  <Chip label={ol} cls={oc} />
                  {s.latency_ms > 0 && <span className="text-[10px] text-slate-600">{s.latency_ms}ms</span>}
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">{s.summary}</p>
                {(s.citations ?? []).length > 0 && (
                  <div className="mt-1 space-y-1">
                    {s.citations.map((c, j) => (
                      <div key={j} className="text-[11px] text-slate-500 pl-2 border-l border-slate-700">
                        <span className="text-slate-300">{c.title}</span>
                        <span className="text-slate-600"> · {c.system} · ref {c.ref}</span>
                        {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 ml-1">↗</a>}
                        {c.snippet && <span className="block text-slate-500 truncate">{c.snippet}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {confidence && (
        <div className="mt-3 pt-3 border-t border-slate-700 flex gap-2 flex-wrap">
          <Chip label={`${confidence.knowledge_hits ?? 0} knowledge hits`} cls="bg-indigo-500/15 text-indigo-300" />
          <Chip label={`${confidence.history_corroborations ?? 0} past-case corroborations`} cls="bg-teal-500/15 text-teal-300" />
          {(confidence.prior_experience_hits ?? 0) > 0 && (
            <Chip label={`${confidence.prior_experience_hits} prior experience citation(s) — handled before`} cls="bg-purple-500/15 text-purple-300" />
          )}
          <Chip label={confidence.account_context_found ? 'account context found' : 'no account context'}
            cls={confidence.account_context_found ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-600 text-slate-300'} />
          {(confidence.systems_skipped_not_connected ?? 0) > 0 && (
            <Chip label={`${confidence.systems_skipped_not_connected} system(s) not connected`} cls="bg-amber-500/15 text-amber-300" />
          )}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-slate-700">
        <p className="text-[11px] font-medium text-slate-400 mb-1">What Alex would answer from</p>
        {answerStatus === 'answered' && answer ? (
          <p className="text-xs text-slate-200 whitespace-pre-wrap">{answer}</p>
        ) : (
          <p className="text-[11px] text-amber-300">
            Awaiting LLM activation — the evidence above is gathered and cited today; the written answer unlocks when the brain (ANTHROPIC_API_KEY) is switched on.
            {note ? '' : ''}
          </p>
        )}
      </div>

      {evidenceRunId && <EvidenceVerdictControl evidenceRunId={evidenceRunId} />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

// Wave 4: keyed by specialistKey so it renders inside ANY absorbed
// specialist DE's profile, not only the standalone technical desk.
export default function SpecialistLive({ setPage, specialistKey = 'technical' }: { setPage: (p: Page) => void; specialistKey?: string }) {
  const [profile, setProfile] = useState<SpecialistProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [removeSourceTarget, setRemoveSourceTarget] = useState<SpecialistSource | null>(null);
  const [deleteMediaTarget, setDeleteMediaTarget] = useState<MediaAsset | null>(null);

  const [charter, setCharter] = useState('');
  const [savingCharter, setSavingCharter] = useState(false);
  const [savedCharter, setSavedCharter] = useState(false);

  const [sources, setSources] = useState<SpecialistSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);

  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [flagFor, setFlagFor] = useState<MediaAsset | null>(null);
  const [flagKind, setFlagKind] = useState<QualityFlag['flag']>('stale');
  const [flagNote, setFlagNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [inquiry, setInquiry] = useState('');
  const [inquiryAccount, setInquiryAccount] = useState('');
  const [resolving, setResolving] = useState(false);
  const [lastRun, setLastRun] = useState<ResolveInquiryResult | null>(null);
  const [pastRuns, setPastRuns] = useState<EvidenceRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  // Conversation threading (migration 044, closes gap-analysis item 5):
  // once a conversation_id exists (created implicitly by the first turn
  // — resolve_inquiry doesn't create one itself, so this panel mints one
  // via de_conversations directly), every subsequent "Run" in this
  // session reuses it, letting the pipeline check for facts established
  // on a prior turn instead of starting blank.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTurns, setThreadTurns] = useState<ResolveInquiryResult[]>([]);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [lastResult, setLastResult] = useState<ConsultResult | null>(null);
  const [consultations, setConsultations] = useState<SpecConsultation[]>([]);

  const [scribe, setScribe] = useState<ScribeRequest[]>([]);
  const [scribeFor, setScribeFor] = useState<SpecConsultation | null>(null);
  const [scribeRef, setScribeRef] = useState('');
  const [scribeAction, setScribeAction] = useState<'add_internal_note' | 'update_status' | 'reply_to_ticket'>('add_internal_note');

  const [amendmentOpen, setAmendmentOpen] = useState(false);
  const [scribeStatus, setScribeStatus] = useState<'open' | 'pending' | 'hold' | 'solved'>('pending');
  const [scribeConnector, setScribeConnector] = useState('');
  const [creatingScribe, setCreatingScribe] = useState(false);

  // ── THE GENERALIZED ACTION LAYER (migration 035): the action picker
  // shows every registered action_definition for the helpdesk category
  // (platform + this tenant's own), not just the two narrow legacy keys.
  // Preview renders the exact request + a plain-language receipt preview
  // WITHOUT calling out — reuses the same preview/receipt concept as the
  // playbook dry-run mode.
  const [actionDefs, setActionDefs] = useState<ActionDefinition[]>([]);
  const [scribePreview, setScribePreview] = useState<ActionPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const prof = await getProfile(specialistKey);
      setProfile(prof);
      if (prof) {
        setCharter(prof.charter);
        const [src, med, cons, scr, conn, actDefs] = await Promise.all([
          listSources(prof.id), listMedia(prof.id), listConsultations(prof.id),
          listScribeRequests(prof.id), listConnectors().catch(() => [] as Connector[]),
          listActionDefinitions('helpdesk').catch(() => [] as ActionDefinition[]),
        ]);
        setSources(src); setMedia(med); setConsultations(cons); setScribe(scr); setConnectors(conn);
        setActionDefs(actDefs);
        setPastRuns(await listEvidenceRuns().catch(() => [] as EvidenceRun[]));
      }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [specialistKey]);

  useEffect(() => { void load(); }, [load]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try { await installTechnicalSpecialist(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setInstalling(false); }
  };

  const saveCharter = async () => {
    if (!profile || savingCharter) return;
    setSavingCharter(true);
    try {
      setProfile(await updateProfile(profile.id, { charter }));
      setSavedCharter(true);
      setTimeout(() => setSavedCharter(false), 2500);
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSavingCharter(false); }
  };

  const toggleStatus = async () => {
    if (!profile) return;
    try { setProfile(await updateProfile(profile.id, { status: profile.status === 'active' ? 'paused' : 'active' })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !profile) return;
    setUploading(true);
    setError(null);
    try {
      await uploadMedia(file, profile.id, 'technical', []);
      setMedia(await listMedia(profile.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setUploading(false); }
  };

  const runInquiry = async () => {
    if (!inquiry.trim() || resolving) return;
    setResolving(true);
    setError(null);
    setLastRun(null);
    try {
      // CONVERSATION CONTINUITY (migration 044): mint a thread on the
      // FIRST turn of this panel session, then reuse it for every
      // subsequent "Run" — so a follow-up question ("what about the
      // billing side?") lets the pipeline recognize the account/category
      // already resolved on the prior turn instead of starting blank.
      let convId = threadId;
      if (!convId) {
        convId = await startEvidenceConversation().catch(() => null);
        if (convId) setThreadId(convId);
      }
      const res = await resolveInquiry(inquiry.trim(), inquiryAccount.trim() || undefined, convId);
      setLastRun(res);
      setThreadTurns(prev => [...prev, res]);
      setPastRuns(await listEvidenceRuns().catch(() => [] as EvidenceRun[]));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setResolving(false); }
  };

  const startNewThread = () => {
    setThreadId(null);
    setThreadTurns([]);
    setLastRun(null);
  };

  const ask = async () => {
    if (!question.trim() || asking) return;
    setAsking(true);
    setError(null);
    try {
      const res = await consult('technical', question.trim());
      setLastResult(res);
      if (profile) setConsultations(await listConsultations(profile.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setAsking(false); }
  };

  const submitScribe = async () => {
    if (!scribeFor || !scribeConnector || !scribeRef.trim() || creatingScribe) return;
    setCreatingScribe(true);
    setError(null);
    try {
      const res = await createScribeRequest({
        consultation_id: scribeFor.id, connector_id: scribeConnector,
        action_key: scribeAction, external_ref: scribeRef.trim(),
        status_value: scribeAction === 'update_status' ? scribeStatus : undefined,
      });
      if (res.error) setError(res.error);
      else {
        setScribeFor(null); setScribeRef(''); setScribePreview(null);
        if (profile) setScribe(await listScribeRequests(profile.id));
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setCreatingScribe(false); }
  };

  /** THE GENERALIZED ACTION LAYER — preview the exact request + a
   *  plain-language receipt preview WITHOUT calling the external
   *  system. Uses the registered action_definition for whichever key
   *  is selected (covers the two legacy keys AND the new
   *  reply_to_ticket action identically — one generic call). */
  const runScribePreview = async () => {
    if (!scribeConnector || !scribeRef.trim() || previewing) return;
    setPreviewing(true);
    setScribePreview(null);
    try {
      const params: Record<string, unknown> = { external_ref: scribeRef.trim() };
      if (scribeAction === 'update_status') params.status = scribeStatus;
      if (scribeAction === 'reply_to_ticket') params.body = `[Preview only — Scribe posts the grounded consultation text on send]`;
      if (scribeAction === 'add_internal_note') params.note = `[Preview only — Scribe composes the note text from consultation ${scribeFor?.id.slice(0, 8)}… on send]`;
      const res = await previewAction(scribeConnector, scribeAction, params);
      setScribePreview(res);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPreviewing(false); }
  };

  const actionDefFor = (key: string) => actionDefs.find(d => d.action_key === key);

  if (missingTables) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
        <PageHeader title="Technical Specialist" subtitle="Consulted when tasks exceed a DE's technical depth." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-slate-400">Apply <code className="mx-1 text-slate-300">supabase/migrations/024_specialists.sql</code> in the Supabase SQL Editor, then reload.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
        <PageHeader title="Technical Specialist" subtitle="Consulted when tasks exceed a DE's technical depth." />
        <LiveLoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
        <PageHeader title="Technical Specialist" subtitle="Consulted when tasks exceed a DE's technical depth." />
        {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>}
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-10 text-center max-w-2xl">
          <p className="text-sm text-slate-300 font-medium mb-1">Install the Technical Specialist</p>
          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            Seeds a tenant-editable charter (answers only from configured sources, cites everything, escalates below the confidence floor).
            You then connect its sources — knowledge, connected systems, MCP servers, links, and media — each with the access mode your
            company allows: ingest, fetch-only, or reference.
          </p>
          <button className={btnPrimary} disabled={installing} onClick={() => void install()}>
            {installing ? 'Installing…' : 'Install Technical Specialist'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
      <PageHeader
        title="Technical Specialist — Live"
        subtitle="Configurable sources with per-customer access modes · grounded consultations · Scribe write-backs always human-gated"
      />
      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>}

      {/* Profile / charter */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 text-lg">⚙</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-white">{profile.name}</p>
            <p className="text-[11px] text-slate-500">The charter is the specialist's role definition — tenant-editable, every save audited.</p>
          </div>
          <Chip label={profile.status} cls={profile.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'} />
          <button
            className={btnGhost + ' !py-1.5'}
            onClick={() => setAmendmentOpen(true)}
          >
            ✨ Improve
          </button>
          <button className={btnGhost + ' !py-1.5'} onClick={() => void toggleStatus()}>
            {profile.status === 'active' ? 'Pause' : 'Activate'}
          </button>
        </div>
        <textarea className={inputCls + ' resize-y'} rows={4} value={charter} onChange={e => setCharter(e.target.value)} />
        <div className="flex justify-end mt-2">
          <button className={btnPrimary + ' !py-1.5'} disabled={savingCharter || charter === profile.charter} onClick={() => void saveCharter()}>
            {savingCharter ? 'Saving…' : savedCharter ? 'Saved ✓' : 'Save charter'}
          </button>
        </div>
      </div>

      {/* Sources */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Sources</h3>
            <p className="text-[11px] text-slate-500">Each source carries the customer's access-mode choice — ingest, fetch-only, or reference.</p>
          </div>
          <button className={btnGhost + ' !py-1.5'} onClick={() => setShowAdd(v => !v)}>{showAdd ? 'Close' : '+ Add source'}</button>
        </div>
        {showAdd && (
          <div className="mb-3">
            <AddSourceForm profileId={profile.id} connectors={connectors}
              onDone={() => { setShowAdd(false); void listSources(profile.id).then(setSources); }}
              onError={setError} />
          </div>
        )}
        {sources.length === 0 ? (
          <LiveEmptyState icon="◎" title="No sources yet" body="The specialist can only answer from what you connect here." />
        ) : (
          <div className="space-y-2">
            {sources.map(src => (
              <div key={src.id} className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-white">{src.label}</span>
                    <Chip label={src.source_type} />
                    <Chip label={src.access_mode.replace('_', '-')} cls={
                      src.access_mode === 'ingest' ? 'bg-indigo-500/20 text-indigo-300'
                        : src.access_mode === 'fetch_only' ? 'bg-teal-500/20 text-teal-300'
                        : 'bg-slate-600 text-slate-300'} />
                    {src.source_type === 'mcp_server' && (
                      src.config.mcp?.last_handshake
                        ? <Chip label={src.config.mcp.last_handshake.ok
                              ? `handshake ok — ${src.config.mcp.server_info?.name ?? 'server'} · ${src.config.mcp.tool_count ?? 0} tools`
                              : `handshake failed (${src.config.mcp.last_handshake.stage ?? 'connect'})`}
                            cls={src.config.mcp.last_handshake.ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'} />
                        : src.config.last_test
                        ? <Chip label={src.config.last_test.ok ? `pinged (${src.config.last_test.note})` : `unreachable (${src.config.last_test.note})`}
                            cls={src.config.last_test.ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'} />
                        : <Chip label="untested" cls="bg-amber-500/20 text-amber-400" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 truncate">
                    {src.source_type === 'knowledge' && (src.config.tags?.length ? `tags: ${src.config.tags.join(', ')}` : 'all knowledge docs')}
                    {src.source_type === 'connector' && `connector ${connectors.find(c => c.id === src.config.connector_id)?.display_name ?? src.config.connector_id ?? '—'}`}
                    {src.source_type === 'mcp_server' && `${src.config.endpoint ?? ''}${src.config.mcp?.last_handshake?.ok ? ` · tools: ${(src.config.mcp.tools ?? []).slice(0, 5).map(t => t.name).join(', ')}${(src.config.mcp.tool_count ?? 0) > 5 ? '…' : ''}` : ' · run Handshake to list this server\'s tools'}`}
                    {src.source_type === 'link' && (src.config.url ?? '')}
                    {src.source_type === 'media' && 'this profile\'s media library'}
                  </p>
                </div>
                {src.source_type === 'mcp_server' && (
                  <button className="text-xs text-teal-400 hover:text-teal-300" disabled={testingId === src.id}
                    onClick={() => {
                      setTestingId(src.id);
                      void mcpHandshake(src.id)
                        .then(r => {
                          if (!r.ok) setError(`MCP handshake failed at ${r.stage ?? 'connect'}: ${r.error ?? 'unknown'} — recorded honestly.`);
                          return listSources(profile.id).then(setSources);
                        })
                        .catch(err => setError(err instanceof Error ? err.message : String(err)))
                        .finally(() => setTestingId(null));
                    }}>
                    {testingId === src.id ? 'Handshaking…' : 'Handshake'}
                  </button>
                )}
                <button className="text-xs text-slate-400 hover:text-white"
                  onClick={() => void updateSource(src, { enabled: !src.enabled }).then(() => listSources(profile.id).then(setSources)).catch(err => setError(String(err)))}>
                  {src.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="text-xs text-red-400/80 hover:text-red-300"
                  onClick={() => setRemoveSourceTarget(src)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Media library */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Media library</h3>
            <p className="text-[11px] text-slate-500">.txt/.md are extracted to knowledge instantly; pdf/docx/video/image are stored + indexed by title/tags — content extraction on activation.</p>
          </div>
          <button className={btnGhost + ' !py-1.5'} disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Upload file'}
          </button>
          <input ref={fileRef} type="file" className="hidden" onChange={e => void onUpload(e)} />
        </div>
        {media.length === 0 ? (
          <LiveEmptyState icon="◎" title="No media assets yet" body="Upload a file to add it to this specialist's library." />
        ) : (
          <div className="space-y-2">
            {media.map(m => (
              <div key={m.id} className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-white truncate">{m.title}</span>
                    <Chip label={m.kind} />
                    <Chip label={m.extracted ? 'extracted → consultable' : 'indexed by title/tags'}
                      cls={m.extracted ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'} />
                    {(m.quality_flags ?? []).map((f, i) => (
                      <Chip key={i} label={`⚑ ${f.flag}`} cls="bg-red-500/15 text-red-300" />
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500">{Math.round(m.size_bytes / 1024)} KB · {m.tags.length ? m.tags.join(', ') : 'no tags'}</p>
                </div>
                <button className="text-xs text-slate-400 hover:text-white" onClick={() => {
                  const t = window.prompt('Tags (comma-separated):', m.tags.join(', '));
                  if (t !== null) void updateMedia(m.id, { tags: t.split(',').map(x => x.trim()).filter(Boolean) }).then(() => listMedia(profile.id).then(setMedia));
                }}>Tags</button>
                <button className="text-xs text-amber-400 hover:text-amber-300" onClick={() => { setFlagFor(m); setFlagKind('stale'); setFlagNote(''); }}>Flag</button>
                <button className="text-xs text-red-400/80 hover:text-red-300"
                  onClick={() => setDeleteMediaTarget(m)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Resolve an inquiry — the evidence pipeline */}
      <div className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-1">Resolve an inquiry — evidence first</h3>
        <p className="text-[11px] text-slate-500 mb-3">
          Before answering a customer, the specialist gathers evidence in order: account configuration from your product system,
          your knowledge, past cases in your support desk / CRM, then its own prior experience with this account. Systems that
          aren't connected are skipped honestly — never faked.
        </p>
        {threadId && (
          <div className="flex items-center gap-2 mb-3 text-[11px] text-teal-300">
            <span>🧵 Conversation thread active — {threadTurns.length} turn{threadTurns.length === 1 ? '' : 's'} so far. A follow-up "Run" reuses facts already established this thread.</span>
            <button className="text-slate-400 hover:text-white underline underline-offset-2" onClick={startNewThread}>Start a new conversation</button>
          </div>
        )}
        <div className="flex gap-2 mb-3 flex-wrap">
          <input className={inputCls + ' flex-1 min-w-[240px]'} placeholder="Customer inquiry, e.g. 'SSO login fails after the latest update'"
            value={inquiry} onChange={e => setInquiry(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runInquiry(); }} />
          <input className={inputCls + ' !w-52'} placeholder="Account name (optional)" value={inquiryAccount} onChange={e => setInquiryAccount(e.target.value)} />
          <button className={btnPrimary} disabled={resolving || !inquiry.trim()} onClick={() => void runInquiry()}>
            {resolving ? 'Gathering evidence…' : 'Run'}
          </button>
        </div>

        {lastRun?.conversation_facts_reused && (
          <div className="mb-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[11px] text-indigo-200">
            🔗 Continuing from earlier in this conversation — {lastRun.conversation_facts_reused.note}
          </div>
        )}

        {lastRun && <EvidenceTrail steps={lastRun.steps ?? []} confidence={lastRun.confidence_inputs} answerStatus={lastRun.answer_status} answer={lastRun.answer ?? null} note={lastRun.note} evidenceRunId={lastRun.evidence_run_id} />}

        {pastRuns.length > 0 && (
          <>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mt-4 mb-2">Past evidence runs</p>
            <div className="space-y-1.5">
              {pastRuns.map(r => (
                <div key={r.id} className="rounded-xl border border-slate-700 bg-slate-900/50">
                  <button className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}>
                    <span className="text-xs text-slate-300 flex-1 truncate">{r.inquiry}</span>
                    {r.account_ref && <Chip label={r.account_ref} />}
                    <Chip label={`${(r.steps ?? []).filter(s => s.outcome === 'ok').length}/${(r.steps ?? []).length} steps ok`} cls="bg-teal-500/15 text-teal-300" />
                    <span className="text-[10px] text-slate-500 whitespace-nowrap">{fmtDate(r.created_at)}</span>
                  </button>
                  {expandedRun === r.id && (
                    <div className="px-3 pb-3">
                      <EvidenceTrail steps={r.steps ?? []} confidence={r.confidence_inputs} answerStatus={r.answer_status} answer={r.answer} evidenceRunId={r.id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Consultation console */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-1">Consultation console</h3>
        <p className="text-[11px] text-slate-500 mb-3">Retrieval across configured sources runs now; the answer path unlocks when the specialist brain (ANTHROPIC_API_KEY) is activated.</p>
        <div className="flex gap-2 mb-3">
          <input className={inputCls} placeholder="Ask the Technical Specialist…" value={question}
            onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void ask(); }} />
          <button className={btnPrimary} disabled={asking || !question.trim()} onClick={() => void ask()}>
            {asking ? 'Consulting…' : 'Consult'}
          </button>
        </div>
        {lastResult && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 mb-4">
            {lastResult.error === 'llm_not_configured' ? (
              <p className="text-xs text-amber-300 mb-2">Specialist brain not activated — retrieval ran and is recorded below. Configure ANTHROPIC_API_KEY to unlock answers.</p>
            ) : lastResult.blocked ? (
              <p className="text-xs text-red-300 mb-2">Answer blocked by guardrail "{lastResult.rule}" — escalated to a human.</p>
            ) : lastResult.answer ? (
              <>
                <p className="text-sm text-slate-200 whitespace-pre-wrap mb-2">{lastResult.answer}</p>
                <p className="text-[11px] text-slate-500 mb-2">Confidence {lastResult.confidence}% · cited: {(lastResult.citations ?? []).join(', ') || '—'}</p>
              </>
            ) : null}
            <p className="text-[11px] font-medium text-slate-400 mb-1">Retrieved sources</p>
            <div className="space-y-1">
              {(lastResult.retrieved_sources ?? []).map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <Chip label={r.kind} cls={r.kind === 'content' ? 'bg-emerald-500/20 text-emerald-400' : r.kind === 'reference' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-700 text-slate-500'} />
                  <span className="text-slate-300">{r.label}</span>
                  <span className="text-slate-500">{r.detail}</span>
                </div>
              ))}
              {(lastResult.retrieved_sources ?? []).length === 0 && <p className="text-[11px] text-slate-600">No enabled sources.</p>}
            </div>
          </div>
        )}

        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">History</p>
        {consultations.length === 0 ? (
          <LiveEmptyState icon="◎" title="No consultations yet" body="Questions asked of the Technical Specialist appear here." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr><th className={th}>When</th><th className={th}>By</th><th className={th}>Question</th><th className={th}>Status</th><th className={th}>Conf.</th><th className={th}></th></tr>
            </thead>
            <tbody>
              {consultations.map(c => (
                <tr key={c.id} className="border-t border-slate-700/60">
                  <td className={`${td} text-xs text-slate-500 whitespace-nowrap`}>{fmtDate(c.created_at)}</td>
                  <td className={`${td} text-xs text-slate-400`}>{c.requested_by}</td>
                  <td className={`${td} text-xs text-slate-300 max-w-xs`}><span className="line-clamp-2">{c.question}</span></td>
                  <td className={td}><Chip label={c.status} cls={STATUS_CHIP[c.status]} /></td>
                  <td className={`${td} text-xs text-slate-400`}>{c.confidence ?? '—'}</td>
                  <td className={td}>
                    <button className="text-xs text-purple-400 hover:text-purple-300 whitespace-nowrap"
                      onClick={() => { setScribeFor(c); setScribeConnector(connectors[0]?.id ?? ''); }}>
                      Scribe →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Scribe queue */}
      <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-1">Scribe — write-back queue</h3>
        <p className="text-[11px] text-slate-500 mb-3">
          Structurally grounded: every write must originate from a consultation (FK-enforced), payloads come only from whitelisted templates
          interpolated from that consultation, and every request is human-gated in v1. Approve or reject in{' '}
          <button className="text-indigo-400 hover:text-indigo-300" onClick={() => setPage('ops_human_tasks')}>Human Tasks</button>.
        </p>
        {scribe.length === 0 ? (
          <LiveEmptyState icon="◎" title="No Scribe requests yet" body="Start one from a consultation above." />
        ) : (
          <div className="space-y-2">
            {scribe.map(r => (
              <div key={r.id} className="rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs font-medium text-white">
                    {r.action_key === 'add_internal_note' ? 'Internal note' : r.action_key === 'reply_to_ticket' ? 'Public reply' : 'Status update'} → ticket #{r.external_ref}
                  </span>
                  <Chip label={r.status.replace('_', ' ')} cls={STATUS_CHIP[r.status]} />
                  <span className="text-[10px] text-slate-500">consultation {r.consultation_id.slice(0, 8)}…</span>
                </div>
                <p className="text-[11px] text-slate-400 font-mono truncate">{JSON.stringify(r.payload)}</p>
                {r.status === 'failed' && r.result && (
                  <p className="text-[11px] text-red-300 mt-1">write failed: {String((r.result as { error?: string }).error ?? 'unknown')} (recorded honestly)</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quality flag modal */}
      {flagFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => setFlagFor(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md bg-slate-800 border border-slate-600 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-3">Flag "{flagFor.title}"</h2>
            <select className={selectCls + ' w-full mb-3'} value={flagKind} onChange={e => setFlagKind(e.target.value as QualityFlag['flag'])}>
              <option value="stale">Stale</option>
              <option value="incomplete">Incomplete</option>
              <option value="conflicting">Conflicting</option>
              <option value="unreadable">Unreadable</option>
            </select>
            <input className={inputCls + ' mb-4'} placeholder="Note" value={flagNote} onChange={e => setFlagNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button className={btnGhost} onClick={() => setFlagFor(null)}>Cancel</button>
              <button className={btnPrimary} onClick={() => {
                void raiseQualityFlag(flagFor, flagKind, flagNote)
                  .then(() => listMedia(profile.id).then(setMedia))
                  .catch(err => setError(String(err)))
                  .finally(() => setFlagFor(null));
              }}>Raise flag</button>
            </div>
          </div>
        </div>
      )}

      {removeSourceTarget && (
        <ConfirmDeleteModal
          title="Remove source"
          message={`Remove "${removeSourceTarget.label}" as a source for this specialist? It will stop being consulted immediately.`}
          confirmLabel="Remove"
          onClose={() => setRemoveSourceTarget(null)}
          onConfirm={async () => {
            await removeSource(removeSourceTarget);
            setRemoveSourceTarget(null);
            setSources(await listSources(profile!.id));
          }}
        />
      )}

      {deleteMediaTarget && (
        <ConfirmDeleteModal
          title="Delete media"
          message={`Delete "${deleteMediaTarget.title}"? This can't be undone.`}
          confirmLabel="Delete"
          onClose={() => setDeleteMediaTarget(null)}
          onConfirm={async () => {
            await deleteMedia(deleteMediaTarget);
            setDeleteMediaTarget(null);
            setMedia(await listMedia(profile!.id));
          }}
        />
      )}

      {/* Scribe create modal — THE GENERALIZED ACTION LAYER's action
          picker: any registered action_definition for this connector's
          category, not a hardcoded two-item list. Risk badges use the
          MCP tool-annotation vocabulary (destructive/idempotent). */}
      {scribeFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6" onClick={() => setScribeFor(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-lg bg-slate-800 border border-purple-500/40 rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-white mb-1">Scribe write-back</h2>
            <p className="text-xs text-slate-500 mb-4">
              Grounded in consultation <span className="font-mono">{scribeFor.id.slice(0, 8)}…</span>. The payload is built server-side from
              the consultation only — you choose the target and action, never the text.
            </p>
            {connectors.length === 0 ? (
              <p className="text-xs text-amber-400 mb-4">No connectors configured — connect a system first.</p>
            ) : (
              <>
                <select className={selectCls + ' w-full mb-3'} value={scribeConnector} onChange={e => { setScribeConnector(e.target.value); setScribePreview(null); }}>
                  {connectors.map(c => <option key={c.id} value={c.id}>{c.display_name || c.provider} — {c.base_url}</option>)}
                </select>
                <div className="flex gap-2 mb-2">
                  <select className={selectCls} value={scribeAction} onChange={e => { setScribeAction(e.target.value as 'add_internal_note' | 'update_status' | 'reply_to_ticket'); setScribePreview(null); }}>
                    {actionDefs.length > 0 ? actionDefs.map(d => (
                      <option key={d.action_key} value={d.action_key}>{d.label}</option>
                    )) : (
                      <>
                        <option value="add_internal_note">Add internal note (from consultation)</option>
                        <option value="update_status">Update status (whitelisted enum)</option>
                      </>
                    )}
                  </select>
                  {scribeAction === 'update_status' && (
                    <select className={selectCls} value={scribeStatus} onChange={e => { setScribeStatus(e.target.value as 'open' | 'pending' | 'hold' | 'solved'); setScribePreview(null); }}>
                      {['open', 'pending', 'hold', 'solved'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                {/* Risk badges — MCP tool-annotation vocabulary (destructive/idempotent) */}
                {actionDefFor(scribeAction) && (
                  <div className="flex items-center gap-2 mb-3">
                    {actionDefFor(scribeAction)!.risk.destructive ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30">Always requires approval</span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Currently auto-executes once trusted</span>
                    )}
                    {actionDefFor(scribeAction)!.risk.idempotent && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-600 text-slate-400">Safe to retry</span>
                    )}
                    <span className="text-[10px] text-slate-600">{actionDefFor(scribeAction)!.description}</span>
                  </div>
                )}
                <input className={inputCls + ' mb-3'} placeholder="Target ticket ref (e.g. 12345)" value={scribeRef} onChange={e => { setScribeRef(e.target.value); setScribePreview(null); }} />

                <button className={btnGhost + ' w-full mb-3'} disabled={previewing || !scribeConnector || !scribeRef.trim()} onClick={() => void runScribePreview()}>
                  {previewing ? 'Rendering preview…' : 'Preview — see the exact request (nothing sent)'}
                </button>
                {scribePreview && (
                  <div className={`rounded-lg border px-3 py-2 mb-4 text-xs ${scribePreview.ok ? 'border-indigo-500/30 bg-indigo-500/5 text-indigo-200' : 'border-red-500/30 bg-red-500/5 text-red-300'}`}>
                    {scribePreview.ok ? (
                      <>
                        <p className="font-medium mb-1">{scribePreview.receipt_preview}</p>
                        <p className="font-mono text-[10px] text-slate-500 truncate">{scribePreview.preview?.method} {scribePreview.preview?.url}</p>
                      </>
                    ) : (
                      <p>{scribePreview.detail ?? scribePreview.error}</p>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <button className={btnGhost} onClick={() => { setScribeFor(null); setScribePreview(null); }}>Cancel</button>
              <button className={btnPrimary} disabled={creatingScribe || !scribeConnector || !scribeRef.trim()} onClick={() => void submitScribe()}>
                {creatingScribe ? 'Creating…' : 'Create gated request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {amendmentOpen && profile && (
        <AmendmentWizard
          entity_kind="specialist"
          entity_id={profile.id}
          entity_name={profile.name}
          onClose={() => setAmendmentOpen(false)}
          onSuccess={() => setAmendmentOpen(false)}
        />
      )}
    </div>
  );
}
