import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import type { Page } from '../../types';
import { listDigitalEmployees, type DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { listDeHealth, DE_HEALTH_LABELS, type DEHealth } from '../../lib/deHealthApi';
import { getDeWorkItems, getDeObjectives, type WorkItemRow, type ObjectiveRow } from '../../lib/deWorkbenchApi';
import { listDEActivity, type DEActivityRow, type InquiryDecisionKind } from '../../lib/specialistApi';
import {
  getDePerformanceMetrics, getDeInquiryMetrics, getDeCostMetricsRanged, getDeCsatMetrics, getDeActionMetrics,
  getOutcomeMetering,
  type DePerformanceMetrics, type DeInquiryMetrics, type DeCostMetrics, type DeCsatMetrics, type DeActionMetrics,
} from '../../lib/api';
import { useEmployeeFileDeId } from '../../lib/employeeFileRoute';
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
type FileTab = 'today' | 'operating' | 'performance' | 'workbench'
  | 'profile' | 'capabilities' | 'trust' | 'development' | 'governance' | 'specialist';
const FILE_TABS: { key: FileTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'operating', label: 'How I operate' },
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
    ]).then(([m, iq, c, s, a, om]) => {
      if (cancelled) return;
      setPerf(m.find(x => x.de_id === de.id) ?? null);
      setInquiry(iq.find(x => x.de_id === de.id) ?? null);
      setCost(c.find(x => x.de_id === de.id) ?? null);
      setCsat(s.find(x => x.de_id === de.id) ?? null);
      setActions(a.find(x => x.de_id === de.id) ?? null);
      const mine = om?.by_de.find(x => x.de_id === de.id);
      setResolutions(mine ? { resolutions: mine.resolutions, escalations: mine.escalations } : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, de.id, range]);

  if (loading) return <p className="text-sm text-dt-muted py-8 text-center">Loading performance…</p>;

  const nothing = !perf && !inquiry && !cost && !csat && !actions && !resolutions;
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

// ── The page ──────────────────────────────────────────────────────

export default function EmployeeFilePage({ setPage }: { setPage: (p: Page) => void }) {
  const deId = useEmployeeFileDeId();
  const { currentTenant } = useAuth();
  const [des, setDes] = useState<DigitalEmployee[] | null>(null);
  const [health, setHealth] = useState<DEHealth | null>(null);
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
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone={STATUS_TONE[de.status] ?? 'neutral'} dot pulse={de.status === 'active'}>{de.status}</Chip>
          <Chip tone={TRUST_TONE[de.trust_level] ?? 'neutral'}>{de.trust_level}</Chip>
          {healthMeta && <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${healthMeta.color}`}>{healthMeta.label}</span>}
        </div>
      </div>

      <TabBar
        tabs={de.is_specialist ? [...FILE_TABS, { key: 'specialist' as FileTab, label: 'Specialist Tools' }] : FILE_TABS}
        active={tab} onSelect={(k: FileTab) => setTab(k)} />

      {tab === 'today' && <TodayTab de={de} setPage={setPage} />}
      {tab === 'operating' && <OperatingModelPanel de={de} />}
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
