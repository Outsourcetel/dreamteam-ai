import { useCanCurateKnowledge } from '../../../lib/useRoleGate';
import React, { useEffect, useState } from 'react';
import { Chip, Drawer, Toast } from '../../../design/primitives';
import type { Tone } from '../../../design/primitives';
import AISessionPanel from '../../../components/AISessionPanel';
import {  } from '../../../context/AuthContext';
import type {  } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import type { KEntity, KAudience, KType } from './KnowledgeLibraryPage';
import type { Page } from '../../../types';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  listKnowledgeGapClusters, listKnowledgeGapPolicies, getKnowledgeGapClusterDetail,
  listKnowledgeRevisionRequests, resolveKnowledgeRevision, updateGapPolicy,
} from '../../../lib/knowledgeApi';
import type { KnowledgeGapCluster, KnowledgeGapPolicy, KnowledgeGapClusterMember, KnowledgeRevisionRequest } from '../../../lib/knowledgeApi';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi';
import { supabase } from '../../../supabase';

// ============================================================
// Gap Detection — THE FLAGSHIP PAGE. The self-healing loop:
// DE query misses / escalations → gap signal → Resolution Agent
// searches historical resolutions → Knowledge Drafting Agent
// proposes an article → human approves → DEs auto-retrain.
// Open-gap counts MUST match companies.ts (TCP 5 / PWC 3).
// "Webhook retry logic" (23 queries) reuses the exact wording
// from the dashboard activity feed.
// ============================================================

type GapStatus = 'detected' | 'investigating' | 'draft_ready' | 'approved' | 'retrained';
type SignalSource = 'DE query miss' | 'Human escalation' | 'Low-confidence answer';

interface GapSignal { time: string; text: string }
interface GapFinding { ref: string; title: string; note: string }
interface GapDraft {
  title: string;
  paragraphs: string[];
  entity: KEntity;
  audience: KAudience;
  type: KType;
  confidence: number;
  sources: string[];
}


const STATUS_META: Record<GapStatus, { label: string; cls: string }> = {
  detected: { label: 'Detected', cls: 'bg-dt-neutral-soft text-dt-neutral' },
  investigating: { label: 'Investigating', cls: 'bg-sky-500/20 text-sky-400' },
  draft_ready: { label: 'Draft ready', cls: 'bg-amber-500/20 text-amber-400' },
  approved: { label: 'Approved', cls: 'bg-emerald-500/20 text-emerald-400' },
  retrained: { label: 'Retrained', cls: 'bg-indigo-500/20 text-indigo-400' },
};

const SEVERITY_CLS = { high: 'text-red-400', medium: 'text-amber-400', low: 'text-dt-support' } as const;


// ============================================================
// LIVE mode — real automatic detection (migration 070): a cluster of
// similar low-confidence inquiries, promoted into a real
// knowledge_revision_requests draft once it crosses the tenant's
// configured min_cluster_size. Approve/reject uses the SAME RPCs
// (apply_knowledge_revision / reject_knowledge_revision) the Human
// Tasks queue's "KNOWLEDGE" items already call — this page is just a
// richer, gap-specific view onto the same real data.
//
// Real states are simpler than the demo's invented 5-stage lifecycle:
// open (accumulating members) → revision_requested (a draft is
// pending human review) → resolved (applied) or back to open
// (rejected). There is no tracked "investigating" phase and no
// tracked "retrained" event — those stayed as demo-only concepts
// rather than being faked with real data that doesn't exist.
// ============================================================

type RepInfo = { inquiry: string; de_id: string | null; created_at: string };

// Severity is a STATE of the gap, so it wears the shared status vocabulary
// rather than three bare colours of text. recurred_after_fix is a real
// column that carried no visual weight at all — it is the loudest of the four,
// because a question coming back after you answered it means the answer you
// published did not cover what people were actually asking.
function severityTier(c: KnowledgeGapCluster, policy: KnowledgeGapPolicy | null): { label: string; tone: Tone; means: string } {
  if (c.recurred_after_fix) return { label: 'Came back', tone: 'danger', means: 'You fixed this once and people are asking again — the published answer may not cover what they mean.' };
  const bar = policy?.min_cluster_size ?? 3;
  if (c.severity_score >= bar * 1.5) return { label: 'High', tone: 'danger', means: 'Asked far more often than your threshold for acting on a gap.' };
  if (c.severity_score >= bar) return { label: 'Medium', tone: 'warn', means: 'Asked often enough to cross your threshold for acting on a gap.' };
  return { label: 'Low', tone: 'neutral', means: 'Below the cluster size you set as worth acting on.' };
}

const LIVE_STATUS_META: Record<KnowledgeGapCluster['status'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-dt-neutral-soft text-dt-neutral' },
  revision_requested: { label: 'Draft pending review', cls: 'bg-amber-500/20 text-amber-400' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-500/20 text-emerald-400' },
};

// Ledger-3: tune the detection policy from the product (RLS already permits
// tenant writes, mig 070). Plain-language labels; saves per-row.
function GapPolicyPanel({ policies, onSaved }: { policies: KnowledgeGapPolicy[]; onSaved: () => void }) {
  // The thresholds that turn a knowledge gap into work. Owner, admin or the
  // knowledge specialist since migration 634.
  //
  // ⚠ updateGapPolicy does not read the row back, so before 634 a refusal
  // arrived as a save that reported success and changed nothing. If this
  // gate is ever narrowed again, that is the failure it produces — not an
  // error message.
  const canEditGapPolicy = useCanCurateKnowledge();
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { floor: string; size: string; window: string; sim: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const draftFor = (p: KnowledgeGapPolicy) => drafts[p.id] ?? {
    floor: String(p.min_confidence_floor), size: String(p.min_cluster_size),
    window: String(p.window_days), sim: String(p.similarity_threshold),
  };
  const save = async (p: KnowledgeGapPolicy) => {
    const d = draftFor(p);
    setBusyId(p.id); setErr(null);
    try {
      await updateGapPolicy(p.id, {
        min_confidence_floor: Math.max(0, Math.min(100, Number(d.floor) || 60)),
        min_cluster_size: Math.max(2, Number(d.size) || 3),
        window_days: Math.max(1, Number(d.window) || 14),
        similarity_threshold: Math.max(0.1, Math.min(1, Number(d.sim) || 0.85)),
      });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    setBusyId(null);
  };
  return (
    <div className="mb-5 rounded-xl border border-dt-border bg-dt-card p-4">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-dt-title w-full text-left">
        <span>{open ? '▾' : '▸'}</span> Detection policy
        <span className="text-[11px] font-normal text-dt-muted">— when similar misses become a gap</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {err && <p className="text-xs text-dt-danger">{err}</p>}
          {policies.map(p => {
            const d = draftFor(p);
            const set = (k: keyof typeof d, v: string) => setDrafts(prev => ({ ...prev, [p.id]: { ...draftFor(p), [k]: v } }));
            const inp = 'w-16 bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1 text-xs text-dt-body';
            return (
              <div key={p.id} className="flex items-center gap-2 text-xs text-dt-support flex-wrap">
                <span className="w-24 text-dt-body">{p.category ?? 'all categories'}</span>
                <span>below</span><input value={d.floor} onChange={e => set('floor', e.target.value)} className={inp} /><span>% confidence,</span>
                <input value={d.size} onChange={e => set('size', e.target.value)} className={inp} /><span>+ similar misses within</span>
                <input value={d.window} onChange={e => set('window', e.target.value)} className={inp} /><span>days (similarity ≥</span>
                <input value={d.sim} onChange={e => set('sim', e.target.value)} className={inp} /><span>)</span>
                <button disabled={busyId === p.id || !canEditGapPolicy} onClick={() => void save(p)}
                  className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-muted disabled:opacity-50">
                  {busyId === p.id ? '…' : 'Save'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LiveKnowledgeGaps({ setPage }: { setPage: (p: Page) => void }) {
  const [clusters, setClusters] = useState<KnowledgeGapCluster[]>([]);
  const [policies, setPolicies] = useState<KnowledgeGapPolicy[]>([]);
  const [showAi, setShowAi] = useState(false);
  const [revisions, setRevisions] = useState<KnowledgeRevisionRequest[]>([]);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [repInfo, setRepInfo] = useState<Record<string, RepInfo>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ members: KnowledgeGapClusterMember[]; inquiries: Record<string, RepInfo> } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, p, r, d] = await Promise.all([
        listKnowledgeGapClusters(), listKnowledgeGapPolicies(), listKnowledgeRevisionRequests(), listDigitalEmployees(),
      ]);
      setClusters(c);
      setPolicies(p);
      setRevisions(r);
      setDes(d);
      setMissingTables(false);

      const repIds = Array.from(new Set(c.map(cl => cl.representative_run_id)));
      if (repIds.length > 0) {
        const { data: runs, error: runsErr } = await supabase
          .from('evidence_runs').select('id, inquiry, de_id, created_at').in('id', repIds);
        if (runsErr) throw runsErr;
        setRepInfo(Object.fromEntries((runs ?? []).map((row: any) => [row.id, { inquiry: row.inquiry, de_id: row.de_id, created_at: row.created_at }])));
      } else {
        setRepInfo({});
      }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load knowledge gaps.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const cluster = clusters.find(c => c.id === selectedId);
    if (!cluster) return;
    setDetailLoading(true);
    getKnowledgeGapClusterDetail(cluster)
      .then(setDetail)
      .catch(err => setError((err as Error)?.message || 'Failed to load this gap\'s evidence.'))
      .finally(() => setDetailLoading(false));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const deById = new Map(des.map(d => [d.id, d]));
  const revisionById = new Map(revisions.map(r => [r.id, r]));
  const policyFor = (category: string | null): KnowledgeGapPolicy | null =>
    policies.find(p => p.category === category) ?? policies.find(p => p.category === null) ?? null;

  // ⚠⚠ APPROVED IS NOT APPLIED, AND THIS CLAIMED IT WAS.
  //
  // The old body was `await resolveKnowledgeRevision(...)` followed
  // unconditionally by "Article published — the knowledge base was updated
  // immediately." It never looked at the result. apply_knowledge_revision
  // returns its refusals IN THE PAYLOAD — request_not_found, not_pending
  // (someone else decided it first), not_tenant_member — as ok:false with a
  // 200, so the promise resolves and nothing throws. A refusal therefore
  // showed a success message about a knowledge fix that had not happened,
  // and the list refreshed underneath it.
  //
  // That is the same shape as the .rpc() sweep: a resolved promise is not a
  // completed action. The status enum makes the distinction explicit —
  // draft | pending_approval | approved | rejected | applied — and only
  // `applied` means a document changed. The proof is new_doc_id: the RPC
  // creates the new version and returns its id, so the message is now tied
  // to that rather than to the absence of an exception.
  const DECISION_REFUSALS: Record<string, string> = {
    request_not_found: 'That draft no longer exists — it may have been decided already.',
    not_pending: 'Somebody else already decided this one.',
    not_tenant_member: "You don't have permission to decide this.",
  };
  const decide = async (requestId: string, decision: 'approved' | 'rejected') => {
    setDeciding(true);
    setError(null);
    try {
      const res = await resolveKnowledgeRevision(requestId, decision);
      if (!res?.ok) {
        setError(DECISION_REFUSALS[res?.error ?? ''] ?? res?.error ?? 'That decision could not be recorded.');
        await refresh();          // show what the record actually says now
        return;
      }
      if (decision === 'rejected') {
        setToast('Draft rejected — this gap reopened and will keep accumulating for the next detection pass.');
      } else if (res.new_doc_id) {
        setToast('Published — a new version of the document is live and searchable.');
      } else {
        // Approved, but no document came back. Do not call that published.
        setToast('Approved, but no document was written — check the knowledge base before relying on this.');
      }
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to record decision.');
    } finally {
      setDeciding(false);
    }
  };

  const openCount = clusters.filter(c => c.status === 'open').length;
  const pendingCount = clusters.filter(c => c.status === 'revision_requested').length;
  const resolvedCount = clusters.filter(c => c.status === 'resolved').length;
  const recurredCount = clusters.filter(c => c.recurred_after_fix).length;

  const loopNodes = [
    { label: 'Gap detected', count: openCount, icon: '◉' },
    { label: 'Draft pending review', count: pendingCount, icon: '✎' },
    { label: 'Resolved', count: resolvedCount, icon: '↗' },
  ];

  const selected = clusters.find(c => c.id === selectedId) ?? null;
  const selectedRevision = selected?.revision_request_id ? revisionById.get(selected.revision_request_id) ?? null : null;
  const selectedRep = selected ? repInfo[selected.representative_run_id] : undefined;
  const selectedDe = selectedRep?.de_id ? deById.get(selectedRep.de_id) : undefined;
  const selectedPolicy = selected ? policyFor(selected.category) : null;

  return (
    <div className="p-6 relative">
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Gap Detection" subtitle="Automatic detection of recurring low-confidence answers — clusters of similar questions become a draft knowledge update for a human to review, no manual flagging required." />
        <button onClick={() => setShowAi((v) => !v)} className="shrink-0 border border-dt-border-strong hover:border-indigo-500 text-dt-body text-sm px-4 py-2 rounded-lg transition-colors">
          {showAi ? 'Close assistant' : '✨ Work gaps with AI'}
        </button>
      </div>

      {showAi && (
        <div className="mb-6">
          <AISessionPanel subjectKind="workspace" subjectLabel="Knowledge gaps"
            examples={['Summarize my open knowledge gaps', 'Draft a document for the most severe gap', 'Why is nothing being detected — are the thresholds too strict?']} />
        </div>
      )}

      {error && <div className="mb-4 rounded-xl border border-dt-danger-border bg-dt-danger-soft px-4 py-3 text-xs text-dt-danger">{error}</div>}

      {/* Ledger-3 (docs/16): the detection thresholds were only tunable via
          raw SQL — now a product control. */}
      {!loading && !missingTables && policies.length > 0 && (
        <GapPolicyPanel policies={policies} onSaved={() => void refresh()} />
      )}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : clusters.length === 0 ? (
        <LiveEmptyState
          icon="◎"
          title="No knowledge gaps detected yet"
          body="This runs automatically every 5 minutes: when several similar questions score below your confidence floor with no matching knowledge, they're grouped into a gap here for review. Nothing has crossed that pattern yet for this workspace."
          primaryLabel="Go to Knowledge Library"
          onPrimary={() => setPage('knowledge_library')}
        />
      ) : (
        <>
          {/* Loop diagram strip — real states only */}
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {loopNodes.map((n, i) => (
                <React.Fragment key={n.label}>
                  <div className="flex-1 min-w-[100px] rounded-xl border border-dt-border bg-dt-page p-3 text-center">
                    <p className="text-indigo-400 text-sm">{n.icon}</p>
                    <p className="text-xs font-semibold text-dt-support mt-1">{n.label}</p>
                    <p className="text-lg font-bold text-dt-title mt-0.5">{n.count}</p>
                  </div>
                  {i < loopNodes.length - 1 && <span className="self-center text-dt-faint flex-shrink-0">→</span>}
                </React.Fragment>
              ))}
            </div>
            <p className="text-[11px] text-dt-muted mt-2">
              Detection and clustering run every 5 minutes against real, low-confidence inquiries — approving a draft updates the knowledge base immediately.
              {recurredCount > 0 && <span className="text-red-400"> {recurredCount} gap{recurredCount === 1 ? '' : 's'} recurred after a fix was applied — the earlier fix may not have worked.</span>}
            </p>
          </div>

          {/* Gap table */}
          <div className="rounded-2xl border border-dt-border bg-dt-card overflow-x-auto">
            <table className="w-full text-sm text-dt-support">
              <thead className="bg-dt-card border-b border-dt-border">
                <tr>
                  <th className={th}>Gap</th>
                  <th className={th}>Category</th>
                  <th className={th}>Members</th>
                  <th className={th}>Affected DE</th>
                  <th className={th}>Severity</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map(c => {
                  const rep = repInfo[c.representative_run_id];
                  const de = rep?.de_id ? deById.get(rep.de_id) : undefined;
                  const rev = c.revision_request_id ? revisionById.get(c.revision_request_id) : undefined;
                  const title = rev?.proposed_title ?? rep?.inquiry ?? '(loading…)';
                  const tier = severityTier(c, policyFor(c.category));
                  return (
                    <tr key={c.id} onClick={() => setSelectedId(c.id)} className="border-b border-dt-border hover:bg-dt-panel cursor-pointer transition-colors">
                      <td className={td}>
                        <p className="text-dt-body font-medium max-w-md truncate">{title}</p>
                        <p className="text-xs text-dt-muted mt-0.5">first seen {new Date(c.first_seen_at).toLocaleDateString()}</p>
                      </td>
                      <td className={`${td} text-xs text-dt-support`}>{c.category ?? 'any'}</td>
                      <td className={`${td} text-xs text-dt-support`}>{c.member_count}</td>
                      <td className={td}>
                        {de ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold">{de.name[0]}</span>
                            <span className="text-xs">{de.name}</span>
                          </span>
                        ) : <span className="text-xs text-dt-faint">—</span>}
                      </td>
                      <td className={td}><Chip tone={tier.tone} title={tier.means}>{tier.label}</Chip></td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[c.status]?.cls}`}>{LIVE_STATUS_META[c.status]?.label ?? c.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Detail panel */}
          {selected && (
            <Drawer title={selectedRevision?.proposed_title ?? selectedRep?.inquiry ?? 'Gap detail'} onClose={() => setSelectedId(null)}>
                <div className="flex items-center gap-2 mb-5 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[selected.status].cls}`}>{LIVE_STATUS_META[selected.status].label}</span>
                  <span className="text-xs text-dt-muted">{selected.member_count} similar question{selected.member_count === 1 ? '' : 's'}{selectedPolicy ? ` in a ${selectedPolicy.window_days}-day window` : ''}{selectedDe ? ` · affects ${selectedDe.name}` : ''}</span>
                </div>

                {typeof selected.pre_fix_avg_confidence === 'number' && (
                  <div className="mb-5 bg-dt-page rounded-lg px-3 py-2">
                    <p className="text-xs text-dt-support">Average confidence when this pattern was detected: <span className="text-dt-body font-medium">{selected.pre_fix_avg_confidence}%</span></p>
                  </div>
                )}

                {/* 1. Signal — real cluster members, real inquiry text */}
                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">1 · Signal — the questions behind this pattern</p>
                {detailLoading ? (
                  <div className="mb-6"><LiveLoadingSkeleton rows={2} /></div>
                ) : (
                  <div className="space-y-2 mb-6">
                    {(detail?.members ?? []).map(m => {
                      const info = detail?.inquiries[m.evidence_run_id];
                      return (
                        <div key={m.id} className="bg-dt-page rounded-lg px-3 py-2">
                          <p className="text-xs text-dt-support">{info?.inquiry ?? '(inquiry text unavailable)'}</p>
                          <p className="text-[10px] text-dt-faint mt-0.5">
                            {info ? new Date(info.created_at).toLocaleString() : ''}
                            {m.similarity_to_representative !== null ? ` · ${Math.round(m.similarity_to_representative * 100)}% similar to the representative question` : ''}
                          </p>
                        </div>
                      );
                    })}
                    {(detail?.members ?? []).length === 0 && !detailLoading && (
                      <p className="text-xs text-dt-muted">No member questions loaded.</p>
                    )}
                  </div>
                )}

                {/* 2. Drafted revision — real proposed_body_md, server-composed from the evidence above */}
                {selectedRevision && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">2 · Proposed knowledge update</p>
                    <div className="rounded-xl border border-dt-border bg-dt-page p-4 mb-6">
                      <p className="text-sm font-semibold text-dt-title mb-2">{selectedRevision.proposed_title}</p>
                      <pre className="text-xs text-dt-support leading-relaxed whitespace-pre-wrap font-sans">{selectedRevision.proposed_body_md}</pre>
                    </div>
                  </>
                )}

                {/* 3. Human gate — real approve/reject via the same RPCs Human Tasks uses */}
                {selected.status === 'revision_requested' && selectedRevision && selectedRevision.status === 'pending_approval' && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">3 · Human review</p>
                    <div className="flex gap-2 mb-6">
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selectedRevision.id, 'approved')}
                        className="flex-1 text-sm px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium">
                        {deciding ? '…' : 'Approve & publish'}
                      </button>
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selectedRevision.id, 'rejected')}
                        className="text-sm px-3 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-red-500/50 hover:text-red-400 disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </>
                )}
                {selected.status === 'resolved' && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 mb-6">
                    <p className="text-xs text-dt-ok">Resolved — a knowledge update was published{selected.fix_applied_at ? ` on ${new Date(selected.fix_applied_at).toLocaleDateString()}` : ''}.</p>
                    {selected.recurred_after_fix && (
                      <p className="text-xs text-dt-danger mt-1">This gap has since recurred {selected.recurrence_count} time{selected.recurrence_count === 1 ? '' : 's'} after that fix — the underlying question may not have been fully resolved.</p>
                    )}
                  </div>
                )}
                {selected.status === 'open' && (
                  <p className="text-xs text-dt-muted mb-6">
                    Still accumulating — needs {Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count)} more similar question{Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count) === 1 ? '' : 's'} before it's promoted to a reviewable draft.
                  </p>
                )}
            </Drawer>
          )}
        </>
      )}

      {toast && (
        <Toast>{toast}</Toast>
      )}
    </div>
  );
}

export default function KnowledgeGapsPage({ setPage }: { setPage?: (p: Page) => void }) {
  return <LiveKnowledgeGaps setPage={setPage ?? (() => {})} />;
}
