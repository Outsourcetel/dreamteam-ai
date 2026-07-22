import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import type { Page } from '../../types';
import { listDigitalEmployees, type DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { listDeHealth, DE_HEALTH_LABELS, type DEHealth } from '../../lib/deHealthApi';
import { getDeWorkItems, getDeObjectives, countDeOutputs, type WorkItemRow, type ObjectiveRow } from '../../lib/deWorkbenchApi';
import { getWorkforceBoard, type WorkforceBoardRow } from '../../lib/missionApi';
import { fmtWhen } from '../../components/WorkforceBoard';
import { listDEActivity, type DEActivityRow, type InquiryDecisionKind } from '../../lib/specialistApi';
import {
  getDePerformanceMetrics, getDeInquiryMetrics, getDeCostMetricsRanged, getDeCsatMetrics, getDeActionMetrics,
  getOutcomeMetering,
  type DePerformanceMetrics, type DeInquiryMetrics, type DeCostMetrics, type DeCsatMetrics, type DeActionMetrics,
} from '../../lib/api';
import { useEmployeeFileDeId } from '../../lib/employeeFileRoute';
import {
  getDeExecutionLog, getDeExperience, getDeAgenticRuns, getAgenticRunMessages,
  getDeRoleContext, getDeWorkProduct,
  type DeRun, type DeExperience, type AgenticRun, type AgenticMessage,
  type RoleContext, type WorkProduct,
} from '../../lib/employeeRecordApi';
import { CATEGORY_LABELS, CATEGORY_SHORT, type SystemCategory } from '../../lib/categoryContracts';
import DeWorkbenchPanel from './DeWorkbench';
import CaseTimelinePanel from '../../components/CaseTimelinePanel';
import MissionPanel from '../../components/MissionPanel';
import OperatingModelPanel from '../../components/OperatingModelPanel';
import { DeProfileSections, type DeProfileSectionKey } from './LiveWorkforceDEs';
import {
  Button, Chip, PanelCard, StatTile, EmptyState, TabBar, Banner, type Tone,
} from '../../design/primitives';

// ═══════════════════════════════════════════════════════════════
// Employee File — ONE page per Digital Employee, with a URL other
// surfaces can link to (/workforce/employee?de=<id>). The front door
// to "watch this employee work": Today (live work), Performance
// (the same outcome RPCs as the Performance tab, scoped to one DE),
// and the full Workbench (memory / reasoning / replay), which was
// previously buried four clicks deep in the roster detail panel.
// ═══════════════════════════════════════════════════════════════

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const STATUS_TONE: Record<string, Tone> = { active: 'ok', paused: 'warn', retired: 'neutral', draft: 'neutral' };
const TRUST_TONE: Record<string, Tone> = { supervised: 'warn', established: 'info', trusted: 'accent', autonomous: 'ok' };
const WORK_TONE: Record<string, { tone: Tone; pulse?: boolean }> = {
  running: { tone: 'info', pulse: true }, queued: { tone: 'neutral' }, waiting_human: { tone: 'warn' },
  done: { tone: 'ok' }, failed: { tone: 'danger' }, cancelled: { tone: 'neutral' },
};
const DECISION_CHIP: Record<InquiryDecisionKind, { label: string; tone: Tone }> = {
  would_auto_send: { label: 'Would auto-send', tone: 'ok' },
  needs_review: { label: 'Needs review', tone: 'warn' },
  blocked_guardrail: { label: 'Blocked by guardrail', tone: 'danger' },
  skipped_no_access: { label: 'No access', tone: 'danger' },
  would_act: { label: 'Would act — awaiting approval', tone: 'warn' },
  acted: { label: 'Acted', tone: 'ok' },
};

// One employee, ONE page (founder structural fix 2026-07-22): the old
// in-roster profile panel merged into this file — its sections render via
// DeProfileSections so nothing exists in two places anymore.
type FileTab = 'today' | 'work' | 'operating' | 'record' | 'performance' | 'workbench'
  | 'profile' | 'capabilities' | 'trust' | 'development' | 'governance' | 'specialist';
const FILE_TABS: { key: FileTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'work', label: 'Work' },
  { key: 'operating', label: 'How I operate' },
  { key: 'record', label: 'Record' },
  { key: 'performance', label: 'Performance' },
  { key: 'workbench', label: 'Workbench' },
  { key: 'profile', label: 'Profile' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'trust', label: 'Trust & Autonomy' },
  { key: 'development', label: 'Development' },
  { key: 'governance', label: 'Governance' },
];

// ── Today — what this employee is doing right now ─────────────────

function TodayTab({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  const [work, setWork] = useState<WorkItemRow[] | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveRow[]>([]);
  const [activity, setActivity] = useState<DEActivityRow[]>([]);
  const [board, setBoard] = useState<WorkforceBoardRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDeWorkItems(de.id), getDeObjectives(de.id), listDEActivity(10, de.id)])
      .then(([w, o, a]) => {
        if (cancelled) return;
        setWork(w);
        setObjectives(o.filter(x => ['open', 'in_progress', 'blocked'].includes(x.status)));
        setActivity(a);
      })
      .catch(e => { if (!cancelled) { setError((e as Error).message); setWork([]); } });
    // The same board read the whole-workforce view uses, scoped to this DE —
    // one truth for "what happens next", no second codepath (docs/17 C2).
    getWorkforceBoard(de.id)
      .then(r => { if (!cancelled) setBoard(r.board[0] ?? null); })
      .catch(() => { /* the panel simply doesn't render */ });
    return () => { cancelled = true; };
  }, [de.id]);

  if (work === null) return <p className="text-sm text-dt-muted py-8 text-center">Loading today's work…</p>;

  const inMotion = work.filter(w => ['running', 'queued', 'waiting_human'].includes(w.status));
  const recent = work.filter(w => !['running', 'queued', 'waiting_human'].includes(w.status)).slice(0, 5);
  const name = de.persona_name ?? de.name;

  return (
    <div className="space-y-5">
      {error && <Banner tone="danger">{error}</Banner>}

      <MissionPanel de={de} />

      {board && (board.next_up.length > 0 || board.listens_live || board.waiting_on_you > 0) && (
        <PanelCard title="Next up — in order"
          badge={board.waiting_on_you > 0 ? <Chip tone="warn">{board.waiting_on_you} wait{board.waiting_on_you === 1 ? 's' : ''} on you</Chip> : undefined}>
          {board.next_up.length === 0 ? (
            <p className="text-sm text-dt-muted">Nothing on the schedule.</p>
          ) : (
            <div className="divide-y divide-dt-border">
              {board.next_up.map((n, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <span className="text-sm">{({ work_item: '📋', case_wait: '⏸', watcher: '👁', objective_wake: '🔁' } as Record<string, string>)[n.kind] ?? '•'}</span>
                  <p className="text-sm text-dt-body flex-1 truncate">{n.title}</p>
                  <span className="text-xs text-dt-muted whitespace-nowrap">{fmtWhen(n.when)}</span>
                </div>
              ))}
            </div>
          )}
          {board.listens_live && (
            <p className="text-xs text-dt-support mt-2">Plus continuous: listening to the live support inbox in real time.</p>
          )}
        </PanelCard>
      )}

      <PanelCard title="Working right now" badge={inMotion.length > 0 ? <Chip tone="info" dot pulse>{inMotion.length} in motion</Chip> : undefined}>
        {inMotion.length === 0 ? (
          <EmptyState icon="🌙" headline="Nothing in motion at this moment">
            {name} picks up work from watchers, playbook triggers, and the support inbox — new items appear here the moment one starts.
          </EmptyState>
        ) : (
          <div className="divide-y divide-dt-border">
            {inMotion.map(w => {
              const t = WORK_TONE[w.status] ?? { tone: 'neutral' as Tone };
              return (
                <div key={w.id} className="flex items-center gap-3 py-2.5">
                  <Chip tone={t.tone} dot pulse={t.pulse}>{w.status.replace(/_/g, ' ')}</Chip>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-dt-body truncate">{w.title}</p>
                    <p className="text-xs text-dt-muted">{w.kind.replace(/_/g, ' ')} · scheduled {fmt(w.scheduled_for)}{w.attempts > 1 ? ` · attempt ${w.attempts}` : ''}</p>
                  </div>
                  {w.last_error && <span className="text-xs text-dt-danger truncate max-w-[16rem]">{w.last_error}</span>}
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <CaseTimelinePanel deId={de.id} />

      {objectives.length > 0 && (
        <PanelCard title="Open objectives">
          <div className="space-y-2">
            {objectives.map(o => (
              <div key={o.id} className="flex items-center gap-3">
                <Chip tone={o.status === 'blocked' ? 'warn' : 'info'}>{o.status.replace(/_/g, ' ')}</Chip>
                <span className="text-sm text-dt-body">{o.title}</span>
              </div>
            ))}
          </div>
        </PanelCard>
      )}

      <PanelCard
        title="Recent decisions & answers"
        actions={<Button kind="ghost" size="sm" onClick={() => setPage('ops_de_activity')}>Open the At Work cockpit →</Button>}
      >
        {activity.length === 0 ? (
          <EmptyState icon="🗒️" headline="No recorded decisions yet">
            Every answer and action {name} takes lands here with its evidence trail — knowledge used, systems consulted, and the decision that came out.
          </EmptyState>
        ) : (
          <div className="divide-y divide-dt-border">
            {activity.map(r => {
              const d = r.decision ? DECISION_CHIP[r.decision.decision] : null;
              return (
                <div key={r.evidence_run.id} className="flex items-center gap-3 py-2.5">
                  <span className="text-xs text-dt-muted w-28 shrink-0">{fmt(r.evidence_run.created_at)}</span>
                  <p className="text-sm text-dt-body truncate flex-1">{r.evidence_run.inquiry}</p>
                  {d ? <Chip tone={d.tone}>{d.label}</Chip> : <Chip tone="neutral">no decision</Chip>}
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      {recent.length > 0 && (
        <PanelCard title="Recently finished">
          <div className="divide-y divide-dt-border">
            {recent.map(w => (
              <div key={w.id} className="flex items-center gap-3 py-2">
                <Chip tone={(WORK_TONE[w.status] ?? { tone: 'neutral' as Tone }).tone}>{w.status.replace(/_/g, ' ')}</Chip>
                <p className="text-sm text-dt-support truncate flex-1">{w.title}</p>
                <span className="text-xs text-dt-muted">{fmt(w.created_at)}</span>
              </div>
            ))}
          </div>
        </PanelCard>
      )}
    </div>
  );
}

// ── Performance — the Performance tab's numbers, for ONE employee ─

const RANGES: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 }, { label: '30 days', days: 30 }, { label: '90 days', days: 90 }, { label: 'All time', days: null },
];

function PerformanceTab({ de, tenantId }: { de: DigitalEmployee; tenantId: string }) {
  const [range, setRange] = useState<number | null>(30);
  const [loading, setLoading] = useState(true);
  const [perf, setPerf] = useState<DePerformanceMetrics | null>(null);
  const [inquiry, setInquiry] = useState<DeInquiryMetrics | null>(null);
  const [cost, setCost] = useState<DeCostMetrics | null>(null);
  const [csat, setCsat] = useState<DeCsatMetrics | null>(null);
  const [actions, setActions] = useState<DeActionMetrics | null>(null);
  const [resolutions, setResolutions] = useState<{ resolutions: number; escalations: number } | null>(null);
  const [outputs, setOutputs] = useState<{ items_done: number; deliverables: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getDePerformanceMetrics(tenantId),
      getDeInquiryMetrics(tenantId, range),
      getDeCostMetricsRanged(tenantId, range),
      getDeCsatMetrics(tenantId),
      getDeActionMetrics(tenantId, range),
      getOutcomeMetering(tenantId, range),
      countDeOutputs(de.id, range).catch(() => ({ items_done: 0, deliverables: 0 })),
    ]).then(([m, iq, c, s, a, om, outs]) => {
      if (cancelled) return;
      setPerf(m.find(x => x.de_id === de.id) ?? null);
      setInquiry(iq.find(x => x.de_id === de.id) ?? null);
      setCost(c.find(x => x.de_id === de.id) ?? null);
      setCsat(s.find(x => x.de_id === de.id) ?? null);
      setActions(a.find(x => x.de_id === de.id) ?? null);
      const mine = om?.by_de.find(x => x.de_id === de.id);
      setResolutions(mine ? { resolutions: mine.resolutions, escalations: mine.escalations } : null);
      setOutputs(outs);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, de.id, range]);

  if (loading) return <p className="text-sm text-dt-muted py-8 text-center">Loading performance…</p>;

  const nothing = !perf && !inquiry && !cost && !csat && !actions && !resolutions
    && !(outputs && (outputs.items_done > 0 || outputs.deliverables > 0));
  if (nothing) {
    return (
      <EmptyState icon="📊" headline="No performance history in this window yet">
        Numbers appear after {de.persona_name ?? de.name} handles real inquiries and actions — try "All time", or come back once work has flowed through.
      </EmptyState>
    );
  }

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase tracking-wide text-dt-muted mr-2">Time window</span>
        {RANGES.map(r => (
          <button key={r.label} onClick={() => setRange(r.days)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${range === r.days ? 'border-dt-accent bg-dt-accent-soft text-dt-accent-text' : 'border-dt-border text-dt-support hover:border-dt-border-strong'}`}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Resolutions delivered" value={String(resolutions?.resolutions ?? 0)}
          sub={resolutions ? `${resolutions.escalations} handed to your team` : undefined} tone="ok" />
        <StatTile label="Inquiries handled" value={String(inquiry?.total_decisions ?? 0)} tone="accent" />
        <StatTile label="Resolution" value={pct(inquiry?.resolution_rate)} tone="ok" />
        <StatTile label="Confidence" value={pct(inquiry?.avg_confidence)} tone="info" />
        <StatTile label="Escalation" value={pct(inquiry?.escalation_rate)} tone={inquiry && inquiry.escalation_rate > 20 ? 'warn' : 'neutral'} />
        <StatTile label="Work items completed" value={String(outputs?.items_done ?? 0)} sub={outputs?.deliverables ? `${outputs.deliverables} document(s) produced` : undefined} tone="accent" />
        <StatTile label="Actions executed" value={String(actions?.executed ?? 0)} sub={actions ? `${actions.sent_to_human} sent to a human` : undefined} tone="ok" />
        <StatTile label="AI cost" value={cost ? `$${cost.total_cost_usd.toFixed(2)}` : '$0.00'} sub={cost ? `${cost.total_calls} calls` : undefined} tone="neutral" />
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <PanelCard title="Autonomy">
          <p className="text-2xl font-semibold text-dt-title">{pct(actions?.autonomy_rate)}</p>
          <p className="text-xs text-dt-support mt-1">of executed actions ran without a human — the rest waited at the approval gate ({actions?.approved_after_gate ?? 0} approved, {actions?.rejected ?? 0} rejected, {actions?.blocked ?? 0} blocked).</p>
        </PanelCard>
        <PanelCard title="Customer satisfaction">
          <p className="text-2xl font-semibold text-dt-title">{csat && csat.total_ratings > 0 ? `${Math.round(csat.csat_pct)}%` : '—'}</p>
          <p className="text-xs text-dt-support mt-1">{csat && csat.total_ratings > 0 ? `${csat.positive_ratings} positive of ${csat.total_ratings} ratings (all time).` : 'No ratings collected yet.'}</p>
        </PanelCard>
        <PanelCard title="Quality flags">
          <p className="text-2xl font-semibold text-dt-title">{perf?.blocked_guardrail_count ?? 0}</p>
          <p className="text-xs text-dt-support mt-1">guardrail blocks all-time · error rate {pct(perf?.error_rate)} · {perf?.high_frustration_count ?? 0} high-frustration conversations.</p>
        </PanelCard>
      </div>
    </div>
  );
}

// ── Work — dedicated work-product BY ROLE (founder: never a mix-up) ─
// Resolves the employee's domain from the system categories it operates
// (generic — not a hardcoded department) and shows what it has actually
// produced, framed in that domain's language. A finance DE shows payment
// reminders and reconciliations; a support DE shows cases. Same component,
// zero per-vertical code — driven by the category-contract layer.
const domainLabel = (c: string): string => CATEGORY_LABELS[c as SystemCategory] ?? c.replace(/_/g, ' ');
const domainShort = (c: string): string => CATEGORY_SHORT[c as SystemCategory] ?? c.replace(/_/g, ' ');

function WorkTab({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  const [role, setRole] = useState<RoleContext | null>(null);
  const [wp, setWp] = useState<WorkProduct | null>(null);
  const name = de.persona_name ?? de.name;

  useEffect(() => {
    let cancelled = false;
    getDeRoleContext(de.id).then(r => !cancelled && setRole(r)).catch(() => !cancelled && setRole(null));
    getDeWorkProduct(de.id).then(w => !cancelled && setWp(w)).catch(() => !cancelled && setWp(null));
    return () => { cancelled = true; };
  }, [de.id]);

  // The employee's operating domains: certified archetype categories first,
  // else the categories it's granted. Falls back to department text.
  const domains: string[] = (role?.archetype_categories?.length ? role.archetype_categories
    : role?.domains ?? []).filter(Boolean);
  const roleName = role?.archetype_name ?? role?.archetype_domain ?? role?.department ?? de.department ?? 'Generalist';
  // Data-driven, not a hardcoded category list: this employee handles
  // conversations iff it actually has any.
  const isConversational = (wp?.conversations.total ?? 0) > 0;

  // Group the action work-product by domain category.
  const byCategory = new Map<string, WorkProduct['actions']>();
  (wp?.actions ?? []).forEach(a => {
    const k = a.category ?? 'other';
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k)!.push(a);
  });
  const catKeys = [...byCategory.keys()].filter(k => k !== 'platform_admin').sort();
  const adminActions = byCategory.get('platform_admin') ?? [];

  return (
    <div className="space-y-5">
      {/* Role header — who this employee is and what it operates */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
        <p className="text-[11px] uppercase tracking-wide text-dt-muted">Role</p>
        <p className="text-lg font-semibold text-dt-title mt-0.5">{roleName}</p>
        {domains.length > 0 ? (
          <p className="text-xs text-dt-support mt-1">
            Operates: {domains.map(d => domainShort(d)).join(' · ')}
          </p>
        ) : (
          <p className="text-xs text-dt-muted mt-1">No connected systems granted yet — this employee's domain is set by what you give it access to.</p>
        )}
      </div>

      {role === null && wp === null
        ? <p className="text-sm text-dt-muted py-8 text-center">Loading this employee's work…</p>
        : (
        <>
          {/* Conversational work-product (support / CRM / product) */}
          {isConversational && wp && (
            <PanelCard title="Cases & conversations">
              <p className="text-xs text-dt-muted mb-3 -mt-1">The customer conversations {name} has handled.</p>
              {wp.conversations.total === 0
                ? <p className="text-sm text-dt-muted py-4 text-center">No conversations handled yet.</p>
                : (
                  <div className="flex flex-wrap gap-4">
                    <StatTile label="Handled" value={String(wp.conversations.total)} />
                    <StatTile label="Resolved" value={String(wp.conversations.resolved)} />
                    <StatTile label="Open" value={String(wp.conversations.open)} />
                    <button onClick={() => setPage('support_inbox')} className="self-center text-xs text-dt-accent-text hover:underline ml-auto">Open in the inbox →</button>
                  </div>
                )}
            </PanelCard>
          )}

          {/* Domain action work-product — grouped by category, labeled generically */}
          {catKeys.length === 0 && adminActions.length === 0 && !isConversational ? (
            <div className="rounded-xl border border-dashed border-dt-border px-4 py-6 text-center">
              <p className="text-sm text-dt-support">{name} hasn't produced domain work-product yet.</p>
              <p className="text-xs text-dt-muted mt-1">As it acts on its connected systems, everything it does appears here — grouped and labeled by the kind of work.</p>
            </div>
          ) : (
            <>
              {catKeys.map(cat => (
                <PanelCard key={cat} title={domainLabel(cat)}>
                  <div className="space-y-1.5">
                    {byCategory.get(cat)!.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm">
                        <span className="flex-1 text-dt-body">{a.label}</span>
                        <span className="text-xs text-dt-muted whitespace-nowrap">
                          {a.auto_n > 0 && <span className="text-dt-support">{a.auto_n} auto</span>}
                          {a.auto_n > 0 && a.gated_n > 0 && ' · '}
                          {a.gated_n > 0 && <span>{a.gated_n} approved</span>}
                        </span>
                        <span className="w-10 text-right text-sm font-semibold text-dt-title tabular-nums">{a.n}</span>
                      </div>
                    ))}
                  </div>
                </PanelCard>
              ))}
              {/* Platform actions (running DreamTeam itself) shown last + labeled honestly */}
              {adminActions.length > 0 && (
                <PanelCard title="Workforce administration">
                  <p className="text-xs text-dt-muted mb-3 -mt-1">Actions {name} took to set up or run the workforce itself — all human-approved.</p>
                  <div className="space-y-1.5">
                    {adminActions.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm">
                        <span className="flex-1 text-dt-body">{a.label}</span>
                        <span className="w-10 text-right text-sm font-semibold text-dt-title tabular-nums">{a.n}</span>
                      </div>
                    ))}
                  </div>
                </PanelCard>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Record — the living employment record (Tier-1 surfacing) ──────
// Three datasets the file was sitting on but never showed: evidence-earned
// skills, the run-by-run execution log (which model served each answer —
// the failover, per reply), and the lived-experience ledger.
const relTime = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const isFallbackModel = (m: string | null) => !!m && /bedrock|anthropic\.|openai|gpt|gemini|google/i.test(m);

// Humanize an agentic transcript turn (raw Anthropic content blocks) into
// readable lines — mirrors the Workbench Reasoning humanizer. Never dumps raw
// JSON, thinking signatures, or tool_use ids at the reader.
type TurnLine = { kind: 'thought' | 'action' | 'result' | 'say' | 'error'; text: string };
function humanizeTurn(role: string, content: unknown): TurnLine[] {
  let blocks: unknown = content;
  if (typeof content === 'string') {
    const s = content.trim();
    if (s.startsWith('[') || s.startsWith('{')) { try { blocks = JSON.parse(s); } catch { return [{ kind: 'say', text: s }]; } }
    else return [{ kind: role === 'user' ? 'say' : 'say', text: s }];
  }
  if (!Array.isArray(blocks)) return [];
  const out: TurnLine[] = [];
  for (const b of blocks as Array<Record<string, unknown>>) {
    const t = b?.type;
    if (t === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'say', text: b.text.trim() });
    else if (t === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) out.push({ kind: 'thought', text: b.thinking.trim() });
    else if (t === 'tool_use' && typeof b.name === 'string') out.push({ kind: 'action', text: `Called ${String(b.name).replace(/^platform_admin__/, '').replace(/_/g, ' ')}` });
    else if (t === 'tool_result') {
      const isErr = b.is_error === true;
      const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x?.text ?? '').join(' ') : '';
      out.push({ kind: isErr ? 'error' : 'result', text: (isErr ? '' : 'Result: ') + String(c).slice(0, 300) });
    }
  }
  return out;
}
const TURN_STYLE: Record<TurnLine['kind'], string> = {
  thought: 'text-dt-muted italic', action: 'text-dt-accent-text', result: 'text-dt-support',
  say: 'text-dt-body', error: 'text-rose-400',
};
const TURN_TAG: Record<TurnLine['kind'], string> = {
  thought: 'thought', action: 'did', result: 'saw', say: 'said', error: '⚠',
};

// One autonomous run, expandable to its turn-by-turn reasoning transcript.
function AgenticRunRow({ run }: { run: AgenticRun }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<AgenticMessage[] | null>(null);
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next && msgs === null) getAgenticRunMessages(run.id).then(setMsgs).catch(() => setMsgs([]));
  };
  const statusTone: Tone = run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger'
    : run.status.startsWith('blocked') ? 'warn' : 'info';
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card">
      <button onClick={toggle} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2">
        <span className={`mt-0.5 text-dt-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-dt-body">{run.goal ?? 'Autonomous task'}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Chip tone={statusTone}>{run.status.replace(/_/g, ' ')}</Chip>
            {run.iteration_count > 0 && <span className="text-[10px] text-dt-muted">{run.iteration_count} step{run.iteration_count === 1 ? '' : 's'}</span>}
            {run.cost_used_cents > 0 && <span className="text-[10px] text-dt-muted">${(run.cost_used_cents / 100).toFixed(2)}</span>}
            <span className="text-[10px] text-dt-faint ml-auto">{relTime(run.created_at)}</span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-dt-border px-3.5 py-2.5">
          {msgs === null ? <p className="text-xs text-dt-muted py-2">Loading transcript…</p>
            : msgs.length === 0 ? <p className="text-xs text-dt-muted py-2">No transcript recorded for this run.</p>
            : (
              <div className="space-y-1.5">
                {msgs.flatMap(m => humanizeTurn(m.role, m.content).map((line, li) => (
                  <div key={`${m.id}-${li}`} className="flex gap-2 text-xs">
                    <span className="w-12 shrink-0 text-[10px] text-dt-faint uppercase tracking-wide pt-0.5">{TURN_TAG[line.kind]}</span>
                    <span className={`flex-1 whitespace-pre-wrap break-words ${TURN_STYLE[line.kind]}`}>{line.text}</span>
                  </div>
                )))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function RecordTab({ de }: { de: DigitalEmployee }) {
  const [runs, setRuns] = useState<DeRun[] | null>(null);
  const [exp, setExp] = useState<DeExperience[] | null>(null);
  const [agentic, setAgentic] = useState<AgenticRun[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDeExecutionLog(de.id, 25).then(r => !cancelled && setRuns(r)).catch(() => !cancelled && setRuns([]));
    getDeExperience(de.id, 40).then(e => !cancelled && setExp(e)).catch(() => !cancelled && setExp([]));
    getDeAgenticRuns(de.id, 15).then(a => !cancelled && setAgentic(a)).catch(() => !cancelled && setAgentic([]));
    return () => { cancelled = true; };
  }, [de.id]);

  const name = de.persona_name ?? de.name;

  return (
    <div className="space-y-5">
      {/* Skills, KPIs and development live on the Development tab (the canonical
          list_de_skills surface) — the Record tab is the evidence of work done. */}

      {/* Autonomous runs — watch it reason through a multi-step task */}
      {agentic !== null && agentic.length > 0 && (
        <PanelCard title="Autonomous runs — how it reasoned through a task">
          <p className="text-xs text-dt-muted mb-3 -mt-1">When {name} works a multi-step goal on its own, every turn of its reasoning and tool use is recorded. Expand any run to read the transcript.</p>
          <div className="space-y-2">
            {agentic.map(r => <AgenticRunRow key={r.id} run={r} />)}
          </div>
        </PanelCard>
      )}

      {/* Execution log — how each run was actually served */}
      <PanelCard title="Execution log — every answer, and how it was served">
        <p className="text-xs text-dt-muted mb-3 -mt-1">The model that served each run, latency, tokens, confidence, and whether it went to a human. This is the failover made visible, one reply at a time.</p>
        {runs === null ? <p className="text-sm text-dt-muted py-6 text-center">Loading runs…</p>
          : runs.length === 0 ? <p className="text-sm text-dt-muted py-6 text-center">No traced runs yet — they appear here as {name} answers and works.</p>
          : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr className="text-dt-muted text-left border-b border-dt-border">
                    <th className="py-1.5 pl-1 font-medium">When</th>
                    <th className="py-1.5 font-medium">Work</th>
                    <th className="py-1.5 font-medium">Served by</th>
                    <th className="py-1.5 font-medium text-right">Latency</th>
                    <th className="py-1.5 font-medium text-right">Tokens</th>
                    <th className="py-1.5 font-medium text-right">Conf.</th>
                    <th className="py-1.5 pr-1 font-medium text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r, i) => (
                    <tr key={i} className="border-b border-dt-border/50">
                      <td className="py-1.5 pl-1 text-dt-support whitespace-nowrap">{relTime(r.started_at)}</td>
                      <td className="py-1.5 text-dt-body">{r.name === 'chat de-answer' ? 'Answered a question' : r.name === 'invoke_agent de-work' ? `Worked a task${r.turns ? ` (${r.turns} steps)` : ''}` : r.name}</td>
                      <td className="py-1.5">
                        {r.model
                          ? <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono ${isFallbackModel(r.model) ? 'bg-dt-accent-soft text-dt-accent-text' : 'bg-dt-inset text-dt-support'}`}>{r.model.replace(/^(us\.)?anthropic\./, '').replace(/-v1:0$/, '')}</span>
                          : <span className="text-dt-faint">—</span>}
                      </td>
                      <td className="py-1.5 text-right text-dt-support whitespace-nowrap">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="py-1.5 text-right text-dt-support">{(r.input_tokens ?? 0) + (r.output_tokens ?? 0) || '—'}</td>
                      <td className="py-1.5 text-right text-dt-support">{r.confidence != null ? `${r.confidence}%` : '—'}</td>
                      <td className="py-1.5 pr-1 text-right">
                        {r.escalated ? <Chip tone="warn">escalated</Chip>
                          : r.work_status === 'done' ? <Chip tone="ok">done</Chip>
                          : r.confidence != null ? <Chip tone="ok">answered</Chip>
                          : <span className="text-dt-faint text-[10px]">{r.work_status ?? '—'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </PanelCard>

      {/* Experience ledger — what the employee has done and learned */}
      <PanelCard title="Experience — what this employee has done">
        <p className="text-xs text-dt-muted mb-3 -mt-1">Each entry is a real action or decision, kept with a link back to the evidence that produced it. This is the record that makes an employee worth keeping — and impossible to export.</p>
        {exp === null ? <p className="text-sm text-dt-muted py-6 text-center">Loading…</p>
          : exp.length === 0 ? (
            <div className="rounded-xl border border-dashed border-dt-border px-4 py-6 text-center">
              <p className="text-sm text-dt-support">{name} hasn't logged real-world experience yet.</p>
              <p className="text-xs text-dt-muted mt-1">Experience accrues as {name} executes actions on connected systems — each success or human-gated decision is recorded here with its evidence. It fills as the work happens.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {exp.map(e => {
                const f = e.fact_summary ?? {};
                return (
                  <div key={e.id} className="relative pl-4 border-l-2 border-dt-border">
                    <span className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-dt-accent" />
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.category && <Chip tone="neutral">{e.category.replace(/_/g, ' ')}</Chip>}
                      {e.from_action && <span className="text-[10px] text-dt-muted">from an action it took</span>}
                      {e.from_evidence && <span className="text-[10px] text-dt-muted">from an evidence run</span>}
                      <span className="text-[10px] text-dt-faint ml-auto">{relTime(e.created_at)}</span>
                    </div>
                    {f.what_happened && <p className="text-xs text-dt-body mt-1">{f.what_happened}</p>}
                    <div className="flex items-center gap-3 mt-0.5 text-[11px]">
                      {f.decision_made && <span className="text-dt-support">{f.decision_made}</span>}
                      {f.outcome && <span className="text-dt-muted">· {f.outcome}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </PanelCard>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────

export default function EmployeeFilePage({ setPage }: { setPage: (p: Page) => void }) {
  const deId = useEmployeeFileDeId();
  const { currentTenant } = useAuth();
  const [des, setDes] = useState<DigitalEmployee[] | null>(null);
  const [health, setHealth] = useState<DEHealth | null>(null);
  // mig 258 records gate — why this employee's autonomy is clamped, if it is.
  const [gate, setGate] = useState<{ gated: boolean; reasons: string[] } | null>(null);
  const [tab, setTab] = useState<FileTab>('today');
  const onDeUpdated = (updated: DigitalEmployee) =>
    setDes(prev => (prev ?? []).map(d => (d.id === updated.id ? updated : d)));

  useEffect(() => {
    let cancelled = false;
    listDigitalEmployees().then(d => { if (!cancelled) setDes(d); }).catch(() => { if (!cancelled) setDes([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deId) return;
    let cancelled = false;
    listDeHealth().then(h => { if (!cancelled) setHealth(h.find(x => x.de_id === deId) ?? null); }).catch(() => undefined);
    import('../../supabase').then(({ supabase }) =>
      supabase.rpc('get_de_gate_status', { p_de_id: deId }).then(({ data }) => {
        if (!cancelled && data?.ok) setGate({ gated: !!data.gated, reasons: (data.reasons ?? []) as string[] });
      })
    ).catch(() => undefined);
    return () => { cancelled = true; };
  }, [deId]);

  if (des === null) return <div className="p-6"><p className="text-sm text-dt-muted py-8 text-center">Loading employee…</p></div>;

  const de = deId ? des.find(d => d.id === deId) : undefined;
  if (!de) {
    return (
      <div className="p-6">
        <EmptyState icon="🪪" headline="No employee selected"
          action={<Button kind="primary" onClick={() => setPage('workforce_des')}>Open the roster</Button>}>
          This page shows one digital employee's file — reach it from the Roster, Performance, or Command Centre by clicking an employee.
        </EmptyState>
      </div>
    );
  }

  const name = de.persona_name ?? de.name;
  const healthMeta = health ? DE_HEALTH_LABELS[health.state] : null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <Button kind="ghost" size="sm" onClick={() => setPage('workforce_des')}>← Workforce roster</Button>
      </div>

      <div className="flex items-start gap-4 flex-wrap">
        <div className="w-14 h-14 rounded-2xl bg-dt-accent-soft border border-dt-border flex items-center justify-center text-2xl shrink-0">
          {de.icon ?? name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-dt-title truncate">{name}</h1>
          <p className="text-sm text-dt-support mt-0.5">{de.name !== name ? `${de.name} · ` : ''}{de.department} · {de.category}</p>
          <p className="text-xs text-dt-muted mt-1 max-w-2xl">{de.description}</p>
          {/* docs/17 C6 — the dossier line (Reznikov design language, dt tokens). */}
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dt-faint mt-2">
            FILE {de.id.slice(0, 8)} · STATUS: {de.status === 'active' ? 'OPERATIONAL' : de.status.toUpperCase()} · TRUST: {(de.trust_level ?? '—').toUpperCase()} · DEPT: {(de.department ?? '—').toUpperCase()}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone={STATUS_TONE[de.status] ?? 'neutral'} dot pulse={de.status === 'active'}>{de.status}</Chip>
          <Chip tone={TRUST_TONE[de.trust_level] ?? 'neutral'}>{de.trust_level}</Chip>
          {healthMeta && <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${healthMeta.color}`}>{healthMeta.label}</span>}
          {gate?.gated && <Chip tone="warn">records gate</Chip>}
        </div>
      </div>

      {/* mig 258 — the records gate, explained where the record lives. */}
      {gate?.gated && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-xs font-medium text-amber-300">
            Autonomy is gated by {name}'s employment record — every answer and action is routed to a human until it's resolved.
          </p>
          <ul className="mt-1 text-xs text-amber-200/90 space-y-0.5">
            {gate.reasons.map(r => (
              <li key={r}>
                · {r === 'stale_certification' ? 'Certification is stale — the configuration changed after the last exam. Re-run the certification exam to refresh it.'
                  : r === 'failed_certification' ? 'The last certification exam was failed. A passing exam restores autonomy.'
                  : r === 'expired_certification' ? 'A governance certification has expired. Re-issue or re-certify to restore autonomy.'
                  : r}
              </li>
            ))}
          </ul>
        </div>
      )}

      <TabBar
        tabs={de.is_specialist ? [...FILE_TABS, { key: 'specialist' as FileTab, label: 'Specialist Tools' }] : FILE_TABS}
        active={tab} onSelect={(k: FileTab) => setTab(k)} />

      {tab === 'today' && <TodayTab de={de} setPage={setPage} />}
      {tab === 'work' && <WorkTab de={de} setPage={setPage} />}
      {tab === 'operating' && <OperatingModelPanel de={de} />}
      {tab === 'record' && <RecordTab de={de} />}
      {tab === 'performance' && (currentTenant?.id
        ? <PerformanceTab de={de} tenantId={currentTenant.id} />
        : <p className="text-sm text-dt-muted py-8 text-center">Performance needs a live workspace.</p>)}
      {tab === 'workbench' && <DeWorkbenchPanel deId={de.id} />}
      {['profile', 'capabilities', 'trust', 'development', 'governance', 'specialist'].includes(tab) && (
        <DeProfileSections de={de} section={tab as DeProfileSectionKey} setPage={setPage} onUpdated={onDeUpdated} />
      )}
    </div>
  );
}
