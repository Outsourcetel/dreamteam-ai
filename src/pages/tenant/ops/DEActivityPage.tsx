import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../../components/ui';
import { CustomerApiError } from '../../../lib/customerApi';
import {
  listDEActivity, simulateInquiry, DEActivityRow, EvidenceStep, InquiryDecisionKind,
} from '../../../lib/specialistApi';
import { getActionExecution, ActionExecutionRow } from '../../../lib/connectorApi';
import { CATEGORY_LABELS, SystemCategory } from '../../../lib/categoryContracts';
import type { Page } from '../../../types';

// ============================================================
// "DE at work" — the live proactive-triage queue (migration 034),
// generalized to any source category with real ACT outcomes
// (migration 036 — the Generalized Trigger Layer).
//
// Redesigned 2026-07-14 from an infinite stack of tall cards into a
// triage cockpit: an attention strip (clickable bucket counts), a
// filter bar (per DE / per event / per source / per category / search),
// and dense one-line rows that expand on click — so a feed that could
// run thousands of lines stays scannable. Load-more paging keeps the
// DOM small; the 8s live refresh is unchanged.
// ============================================================

const fmtTime = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const STEP_ICON: Record<string, string> = {
  account_context: '🏢', knowledge_search: '📚', history_check: '🕓', prior_experience: '🧠', mcp_tool: '🔧', compose: '🧾',
};
const STEP_LABEL: Record<string, string> = {
  account_context: 'Account configuration', knowledge_search: 'Knowledge',
  history_check: 'Past cases (external system)', prior_experience: 'Prior experience (this DE\'s own memory)',
  mcp_tool: 'MCP tool', compose: 'Evidence bundle',
};
const OUTCOME_CHIP: Record<string, [string, string]> = {
  ok: ['OK', 'bg-emerald-500/20 text-emerald-400'],
  skipped_not_connected: ['Not connected — skipped', 'bg-slate-500 text-slate-200'],
  failed: ['Failed', 'bg-red-500/20 text-red-400'],
  denied_no_access: ['No access — blocked', 'bg-rose-500/20 text-rose-300'],
};
// 'would_act'/'acted' added in migration 036 — the act-side siblings of
// would_auto_send/needs_review. 'acted' is styled distinctly (solid
// emerald) since it means something REALLY HAPPENED, not just intent.
const DECISION_META: Record<InquiryDecisionKind, { label: string; cls: string }> = {
  would_auto_send: { label: 'Would auto-send', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  needs_review: { label: 'Needs review', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  blocked_guardrail: { label: 'Blocked by guardrail', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
  skipped_no_access: { label: 'No access', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  would_act: { label: 'Would act — awaiting approval', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  acted: { label: 'Acted', cls: 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50' },
};
const SOURCE_LABEL: Record<string, string> = {
  manual: 'Human-invoked',
  proactive_trigger: 'Automatic',
  manual_simulation: 'Simulation',
};

// The attention buckets — the whole point of the redesign: what needs a
// human right now floats to the top, at-a-glance, and filters on click.
type BucketKey = 'attention' | 'acted' | 'auto' | 'blocked' | 'all';
const BUCKETS: Array<{ key: BucketKey; label: string; match: (d: InquiryDecisionKind | null) => boolean; cls: string; active: string }> = [
  { key: 'attention', label: 'Needs a human', match: d => d === 'needs_review' || d === 'would_act', cls: 'text-amber-300', active: 'border-amber-500/60 bg-amber-500/10' },
  { key: 'blocked', label: 'Blocked / no access', match: d => d === 'blocked_guardrail' || d === 'skipped_no_access', cls: 'text-rose-300', active: 'border-rose-500/60 bg-rose-500/10' },
  { key: 'acted', label: 'Acted', match: d => d === 'acted', cls: 'text-emerald-300', active: 'border-emerald-500/60 bg-emerald-500/10' },
  { key: 'auto', label: 'Auto-sent', match: d => d === 'would_auto_send', cls: 'text-emerald-400', active: 'border-emerald-500/60 bg-emerald-500/10' },
  { key: 'all', label: 'All activity', match: () => true, cls: 'text-slate-300', active: 'border-indigo-500/60 bg-indigo-500/10' },
];

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${cls}`}>{label}</span>;
}

function StepList({ steps }: { steps: EvidenceStep[] }) {
  return (
    <div className="space-y-2 mt-2">
      {steps.map((s, i) => {
        const [ol, oc] = OUTCOME_CHIP[s.outcome] ?? [s.outcome, 'bg-slate-600 text-slate-300'];
        return (
          <div key={i} className="flex gap-2">
            <span className="text-sm leading-5">{STEP_ICON[s.kind] ?? '•'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-medium text-white">{STEP_LABEL[s.kind] ?? s.kind}</span>
                <span className="text-[10px] text-slate-400">{s.system}</span>
                <Chip label={ol} cls={oc} />
              </div>
              <p className="text-[11px] text-slate-300 mt-0.5">{s.summary}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function categoryShort(cat?: string | null): string | null {
  if (!cat) return null;
  return (CATEGORY_LABELS[cat as SystemCategory] ?? cat).split(' — ')[0];
}

// One dense row; expands in place to reveal the reasoning, receipt and
// evidence steps that used to make every card tall.
function ActivityRow({ row }: { row: DEActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const [execution, setExecution] = useState<ActionExecutionRow | null>(null);
  const { evidence_run: run, decision } = row;
  const meta = decision ? DECISION_META[decision.decision] : null;
  const isSimulation = decision?.source === 'manual_simulation';
  const catLabel = categoryShort(decision?.source_category);

  useEffect(() => {
    if (expanded && decision?.action_execution_id && !execution) {
      void getActionExecution(decision.action_execution_id).then(setExecution).catch(() => setExecution(null));
    }
  }, [expanded, decision?.action_execution_id, execution]);

  return (
    <div className={`rounded-lg border ${isSimulation ? 'border-purple-500/30' : 'border-slate-700'} bg-slate-800/40 overflow-hidden`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-slate-800/80 transition-colors"
      >
        <span className="text-slate-500 text-[10px] w-4 flex-shrink-0">{expanded ? '▼' : '▶'}</span>
        <span className="font-mono text-[10px] text-slate-500 w-24 flex-shrink-0 hidden sm:block">{fmtTime(run.created_at)}</span>
        <span className="text-[11px] text-slate-300 w-28 flex-shrink-0 truncate hidden md:block">{row.subject_name ?? '—'}</span>
        <span className="text-xs text-slate-100 flex-1 min-w-0 truncate">{run.inquiry}</span>
        {catLabel && <span className="hidden lg:inline"><Chip label={catLabel} cls="bg-indigo-500/15 text-indigo-300" /></span>}
        {decision?.confidence != null && <span className="text-[10px] text-slate-400 w-9 text-right flex-shrink-0 tabular-nums">{decision.confidence}%</span>}
        {meta ? <Chip label={meta.label} cls={`border ${meta.cls}`} />
          : <Chip label="Answered" cls="bg-slate-700 text-slate-300" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-700/60 space-y-3">
          <div className="flex items-center gap-2 flex-wrap text-[10px] sm:hidden">
            <span className="font-mono text-slate-500">{fmtTime(run.created_at)}</span>
            {row.subject_name && <span className="text-slate-400">· {row.subject_name}</span>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isSimulation && <Chip label="SIMULATION — not a real item" cls="bg-purple-500/20 text-purple-300 border border-purple-500/40" />}
            {decision && <Chip label={SOURCE_LABEL[decision.source] ?? decision.source} cls="bg-slate-700 text-slate-300" />}
            {run.account_ref && <Chip label={`account ${run.account_ref}`} cls="bg-slate-700 text-slate-300" />}
          </div>

          {decision?.reasoning && (
            <div>
              <p className="text-[11px] font-medium text-slate-400 mb-1">Why</p>
              <p className="text-xs text-slate-100 leading-relaxed">{decision.reasoning}</p>
              {decision.human_task_id && <p className="text-[11px] text-amber-300 mt-1">A human review task was created for this.</p>}
            </div>
          )}
          {!decision && (
            <p className="text-[11px] text-slate-400">Human-invoked consultation — no automatic decision recorded (a human reading the answer is the decision here).</p>
          )}

          {execution && (
            <div className="rounded-lg border border-emerald-600/30 bg-emerald-500/5 p-2.5">
              <p className="text-[11px] font-medium text-emerald-400 mb-1">
                {execution.receipt ? 'Receipt — what actually happened' : 'What this action will do (awaiting approval)'}
              </p>
              <p className="text-xs text-emerald-200/90 leading-relaxed font-mono">{execution.receipt ?? execution.request_summary}</p>
            </div>
          )}

          <div>
            <p className="text-[11px] font-medium text-slate-400">Evidence — {run.steps?.length ?? 0} step(s)</p>
            <StepList steps={run.steps ?? []} />
          </div>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 40;

export default function DEActivityPage({ setPage: _setPage }: { setPage: (p: Page) => void }) {
  const [rows, setRows] = useState<DEActivityRow[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState(false);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filters
  const [bucket, setBucket] = useState<BucketKey>('all');
  const [subject, setSubject] = useState<string>('all');
  const [source, setSource] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Simulator (collapsed by default so it no longer dominates)
  const [showSim, setShowSim] = useState(false);
  const [simInquiry, setSimInquiry] = useState('');
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(async (silent = false, lim = limit) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setRows(await listDEActivity(lim));
      setLastPolledAt(new Date());
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [limit]);

  useEffect(() => { void load(false, limit); }, [load, limit]);
  useEffect(() => {
    pollTimer.current = setInterval(() => { void load(true); }, 8000);
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
  }, [load]);

  const runSimulation = async () => {
    if (!simInquiry.trim() || simulating) return;
    setSimulating(true);
    setError(null);
    try {
      await simulateInquiry(simInquiry.trim());
      setSimInquiry('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulating(false);
    }
  };

  // Distinct filter options, derived from what's actually loaded.
  const subjects = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { if (r.subject_name) s.add(r.subject_name); });
    return [...s].sort();
  }, [rows]);
  const categories = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { const c = categoryShort(r.decision?.source_category); if (c) s.add(c); });
    return [...s].sort();
  }, [rows]);

  const bucketCounts = useMemo(() => {
    const counts: Record<BucketKey, number> = { attention: 0, acted: 0, auto: 0, blocked: 0, all: rows.length };
    for (const r of rows) {
      const d = r.decision?.decision ?? null;
      for (const b of BUCKETS) if (b.key !== 'all' && b.match(d)) counts[b.key]++;
    }
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const activeBucket = BUCKETS.find(b => b.key === bucket)!;
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      const d = r.decision?.decision ?? null;
      if (!activeBucket.match(d)) return false;
      if (subject !== 'all' && r.subject_name !== subject) return false;
      if (source !== 'all' && (r.decision?.source ?? 'manual') !== source) return false;
      if (category !== 'all' && categoryShort(r.decision?.source_category) !== category) return false;
      if (q && !(r.evidence_run.inquiry.toLowerCase().includes(q) || (r.evidence_run.account_ref ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, bucket, subject, source, category, search]);

  const filtersActive = bucket !== 'all' || subject !== 'all' || source !== 'all' || category !== 'all' || search.trim() !== '';
  const clearFilters = () => { setBucket('all'); setSubject('all'); setSource('all'); setCategory('all'); setSearch(''); };
  const selectCls = 'text-xs bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-indigo-500';

  if (missingTables) {
    return (
      <div className="flex-1 overflow-auto bg-slate-900 p-6">
        <PageHeader title="DE at Work" subtitle="Live proactive-triage queue." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-slate-400">Apply <code className="mx-1 text-slate-300">supabase/migrations/034_proactive_inquiry_triage.sql</code> in the Supabase SQL Editor, then reload.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <PageHeader
          title="DE at Work"
          subtitle="Live evidence and reasoning as your Digital Employees notice, evaluate, and act on work — filter, don't scroll."
        />
        <button
          onClick={() => setShowSim(s => !s)}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-purple-500 hover:text-purple-300 transition-colors whitespace-nowrap"
        >
          {showSim ? 'Hide simulator' : 'Simulate an inquiry'}
        </button>
      </div>

      {showSim && (
        <div className="mb-5 rounded-xl border border-purple-500/30 bg-purple-500/5 p-4">
          <p className="text-xs text-slate-400 mb-2">
            Runs the exact same evidence + triage pipeline right now, so you can watch the mechanism without waiting for a real item.
            Always tagged as a simulation — never mixed with real triage. Real automatic triage runs every 5 minutes via the dispatch cron.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={simInquiry}
              onChange={(e) => setSimInquiry(e.target.value)}
              placeholder='e.g. "My API key stopped working after the update"'
              className="flex-1 min-w-[280px] text-sm bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
            <button
              onClick={runSimulation}
              disabled={!simInquiry.trim() || simulating}
              className="text-sm px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
            >
              {simulating ? 'Running…' : 'Run simulation'}
            </button>
          </div>
        </div>
      )}

      {/* Attention strip — clickable bucket counts */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        {BUCKETS.map(b => (
          <button
            key={b.key}
            onClick={() => setBucket(b.key)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${bucket === b.key ? b.active : 'border-slate-700 bg-slate-800/40 hover:border-slate-600'}`}
          >
            <div className={`text-xl font-semibold tabular-nums ${b.cls}`}>{bucketCounts[b.key]}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{b.label}</div>
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search item or account…"
          className="flex-1 min-w-[200px] text-xs bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <select value={subject} onChange={e => setSubject(e.target.value)} className={selectCls}>
          <option value="all">All employees</option>
          {subjects.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={source} onChange={e => setSource(e.target.value)} className={selectCls}>
          <option value="all">Any source</option>
          <option value="proactive_trigger">Automatic</option>
          <option value="manual">Human-invoked</option>
          <option value="manual_simulation">Simulation</option>
        </select>
        {categories.length > 0 && (
          <select value={category} onChange={e => setCategory(e.target.value)} className={selectCls}>
            <option value="all">Any system</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {filtersActive && (
          <button onClick={clearFilters} className="text-xs px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors">Clear</button>
        )}
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-500">
          {filtersActive ? `${filtered.length} of ${rows.length} shown` : `${rows.length} recent run(s)`}
        </span>
        {lastPolledAt && <span className="text-[10px] text-slate-600">Updated {lastPolledAt.toLocaleTimeString()} · refreshes every 8s</span>}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500 py-8 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-slate-700 rounded-xl">
          <p className="text-slate-500 text-sm">No activity yet — real automatic triage needs connected systems with new items, or use the simulator above.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-slate-700 rounded-xl">
          <p className="text-slate-500 text-sm">No activity matches these filters.</p>
          <button onClick={clearFilters} className="text-xs text-indigo-400 hover:text-indigo-300 mt-1">Clear filters</button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {filtered.map(row => <ActivityRow key={row.evidence_run.id} row={row} />)}
          </div>
          {/* Load more — only meaningful when the fetched window is full
              and we're not filtering to a subset. Pulls an older page. */}
          {rows.length >= limit && !filtersActive && (
            <div className="text-center mt-4">
              <button
                onClick={() => setLimit(l => l + PAGE_SIZE)}
                className="text-xs px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:border-indigo-500 transition-colors"
              >
                Load older activity
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
