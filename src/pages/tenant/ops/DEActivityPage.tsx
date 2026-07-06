import React, { useCallback, useEffect, useRef, useState } from 'react';
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
// Closes gap-analysis Tier 0 item 4: near-real-time visibility into a
// DE noticing and evaluating work on its own, with the REASONING for
// each decision surfaced (not a spinner/status dot). Semantic
// telemetry over structural — "is the system making sound decisions",
// per the 2026 agent-observability research this build is grounded in
// (see the migration 034 SQL header for the full citation).
//
// Migration 036 adds: which of the 9 category-contract categories each
// run came from (not just implicitly "support"), and a real receipt
// when the DE actually ACTED (via the generalized action layer,
// migration 035) — distinct from merely deciding it WOULD act, or
// deciding to just answer.
//
// LIVE STRATEGY: short poll (8s) rather than a Supabase Realtime
// channel subscription. This codebase has NO existing Realtime
// channel usage anywhere (every other "live" page — Proving Ground,
// Playbooks eval runs — polls with setInterval), so a poll keeps this
// build consistent with the established pattern instead of
// introducing a new live-data mechanism for the first time here. A
// dedicated Realtime channel is a reasonable v2 if this page's poll
// cadence becomes a bottleneck.
// ============================================================

const fmtTime = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  skipped_not_connected: ['Not connected — skipped', 'bg-slate-700 text-slate-300'],
  failed: ['Failed', 'bg-red-500/20 text-red-400'],
  denied_no_access: ['No access — blocked', 'bg-rose-500/20 text-rose-300'],
};
// 'would_act'/'acted' added in migration 036 — the act-side siblings
// of would_auto_send/needs_review. 'acted' is styled distinctly (solid
// emerald, not just a tint) since it means something REALLY HAPPENED
// in the outside world, not just an intent recorded.
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
  proactive_trigger: 'Automatic — noticed on its own',
  manual_simulation: 'Simulation (demo/test)',
};

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
}

function StepList({ steps }: { steps: EvidenceStep[] }) {
  return (
    <div className="space-y-2 mt-2">
      {steps.map((s, i) => {
        const [ol, oc] = OUTCOME_CHIP[s.outcome] ?? [s.outcome, 'bg-slate-800 text-slate-400'];
        return (
          <div key={i} className="flex gap-2">
            <span className="text-sm leading-5">{STEP_ICON[s.kind] ?? '•'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-medium text-white">{STEP_LABEL[s.kind] ?? s.kind}</span>
                <span className="text-[10px] text-slate-500">{s.system}</span>
                <Chip label={ol} cls={oc} />
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">{s.summary}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityCard({ row }: { row: DEActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const [execution, setExecution] = useState<ActionExecutionRow | null>(null);
  const { evidence_run: run, decision } = row;
  const meta = decision ? DECISION_META[decision.decision] : null;
  const sourceLabel = decision ? SOURCE_LABEL[decision.source] ?? decision.source : null;
  const isSimulation = decision?.source === 'manual_simulation';
  const categoryLabel = decision?.source_category
    ? (CATEGORY_LABELS[decision.source_category as SystemCategory] ?? decision.source_category).split(' — ')[0]
    : null;
  const didAct = decision?.decision === 'acted' || decision?.decision === 'would_act';

  useEffect(() => {
    if (decision?.action_execution_id) {
      void getActionExecution(decision.action_execution_id).then(setExecution).catch(() => setExecution(null));
    }
  }, [decision?.action_execution_id]);

  return (
    <div className={`rounded-xl border p-4 ${isSimulation ? 'border-purple-500/30 bg-purple-500/5' : didAct ? 'border-emerald-600/40 bg-emerald-500/5' : 'border-slate-800 bg-slate-900/60'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {isSimulation && <Chip label="SIMULATION — not a real ticket" cls="bg-purple-500/20 text-purple-300 border border-purple-500/40" />}
            {categoryLabel && <Chip label={categoryLabel} cls="bg-indigo-500/15 text-indigo-300 border border-indigo-500/30" />}
            {sourceLabel && !isSimulation && <Chip label={sourceLabel} cls="bg-slate-800 text-slate-400" />}
            <span className="text-xs font-medium text-white truncate">{run.inquiry.slice(0, 140)}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
            <span className="font-mono">{fmtTime(run.created_at)}</span>
            {decision?.connector_id && <span>· via connector</span>}
            {run.account_ref && <span>· account {run.account_ref}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {meta && <Chip label={meta.label} cls={`border ${meta.cls}`} />}
          {decision?.confidence != null && <Chip label={`${decision.confidence}% confidence`} cls="bg-slate-800 text-slate-300" />}
        </div>
      </div>

      {decision?.reasoning && (
        <div className="mt-3 pt-3 border-t border-slate-800">
          <p className="text-[11px] font-medium text-slate-400 mb-1">Why</p>
          <p className="text-xs text-slate-200 leading-relaxed">{decision.reasoning}</p>
          {decision.human_task_id && (
            <p className="text-[11px] text-amber-300 mt-1">A human review task was created for this.</p>
          )}
        </div>
      )}

      {execution && (
        <div className="mt-3 pt-3 border-t border-slate-800">
          <p className="text-[11px] font-medium text-emerald-400 mb-1">
            {execution.receipt ? 'Receipt — what actually happened' : 'What this action will do (awaiting approval)'}
          </p>
          <p className="text-xs text-emerald-200/90 leading-relaxed font-mono">
            {execution.receipt ?? execution.request_summary}
          </p>
        </div>
      )}

      {!decision && (
        <p className="mt-2 text-[11px] text-slate-500">Human-invoked consultation — no automatic decision recorded (a human reading the answer is the decision here).</p>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        {expanded ? 'Hide evidence steps ▲' : `Show ${run.steps?.length ?? 0} evidence step(s) ▼`}
      </button>
      {expanded && <StepList steps={run.steps ?? []} />}
    </div>
  );
}

export default function DEActivityPage({ setPage: _setPage }: { setPage: (p: Page) => void }) {
  const [rows, setRows] = useState<DEActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState(false);
  const [simInquiry, setSimInquiry] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setRows(await listDEActivity(50));
      setLastPolledAt(new Date());
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Short poll (8s) — see header note on why polling over Realtime for v1.
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

  if (missingTables) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageHeader title="DE at Work" subtitle="Live proactive-triage queue." />
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 max-w-xl">
          <p className="text-sm text-amber-300 font-medium mb-1">Workspace still provisioning</p>
          <p className="text-xs text-slate-400">Apply <code className="mx-1 text-slate-300">supabase/migrations/034_proactive_inquiry_triage.sql</code> in the Supabase SQL Editor, then reload.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="DE at Work"
        subtitle="Live evidence + reasoning as Digital Employees notice, evaluate, and act on work across any connected system — not just a status dot."
      />

      <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <p className="text-xs text-slate-400 mb-2">
          <span className="text-slate-300 font-medium">Honest limits:</span> "Would auto-send" and "would act" record intent
          only — a decision only becomes "Acted" when a registered action exists for that item's category and the trust/
          guardrail rules clear it for real execution. This queue now watches every connected category (not just support
          tickets), each with its own plain-language framing. Automatic polling runs every 5 minutes via the existing
          dispatch cron; use the simulator below to watch the mechanism run immediately without waiting for real data.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={simInquiry}
            onChange={(e) => setSimInquiry(e.target.value)}
            placeholder='Simulate an incoming inquiry, e.g. "My API key stopped working after the update"'
            className="flex-1 min-w-[280px] text-sm bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-purple-500"
          />
          <button
            onClick={runSimulation}
            disabled={!simInquiry.trim() || simulating}
            className="text-sm px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
          >
            {simulating ? 'Running…' : 'Simulate an incoming inquiry'}
          </button>
        </div>
        <p className="text-[10px] text-purple-300 mt-1.5">Demo/test aid — clearly tagged as a simulation below and in the audit trail, never conflated with real automatic triage.</p>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-500">{rows.length} recent run(s)</span>
        {lastPolledAt && <span className="text-[10px] text-slate-600">Updated {lastPolledAt.toLocaleTimeString()} · refreshes every 8s</span>}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500 py-8 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
          <p className="text-slate-500 text-sm">No evidence runs yet — resolve an inquiry from the Technical Specialist, or simulate one above.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => <ActivityCard key={row.evidence_run.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
