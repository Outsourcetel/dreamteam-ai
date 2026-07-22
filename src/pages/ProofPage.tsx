import React, { useEffect, useState } from 'react';
import { SUPABASE_URL } from '../lib/env';

// The public proof page (docs/18 Move 1) — counter-positioning against agent
// washing. Rule of the page: NOTHING appears here that is not wired and
// live-verifiable. The counters are fetched from production when the visitor
// loads the page; the incident is told with its real log line; the numbers
// are small because they are real — and that is the point.

interface ProofStats {
  ok: boolean;
  scope: string;
  generated_at: string;
  stats: {
    active_digital_employees: number;
    conversations_handled: number;
    work_items_completed: number;
    escalations_to_humans: number;
    guardrail_blocks_enforced: number;
    certification_exams: { run: number; passed: number };
    amendments_adopted: number;
    knowledge_documents: number;
    audit_chain_events: number;
  };
}

const SOURCES = {
  gartner: 'https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027',
  mit: 'https://mlq.ai/media/quarterly_decks/v0.1_State_of_AI_in_Business_2025_Report.pdf',
};

function Counter({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-4">
      <p className="text-2xl font-semibold text-dt-title tabular-nums">{value}</p>
      <p className="text-xs text-dt-support mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-dt-muted mt-1">{sub}</p>}
    </div>
  );
}

export default function ProofPage() {
  const [stats, setStats] = useState<ProofStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`${SUPABASE_URL}/functions/v1/proof-stats`)
      .then(r => r.json())
      .then(d => { if (d?.ok) setStats(d as ProofStats); else setFailed(true); })
      .catch(() => setFailed(true));
  }, []);

  const s = stats?.stats;

  return (
    <div className="min-h-screen bg-dt-page text-dt-body overflow-y-auto">
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_50%_-20%,rgba(99,102,241,0.25),transparent_65%)]" />

        <header className="relative max-w-4xl mx-auto px-6 pt-8 flex items-center justify-between">
          <span className="text-sm font-semibold text-white tracking-tight">DreamTeam <span className="text-indigo-400">AI</span></span>
          <a href="/" className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:text-white hover:border-indigo-500 transition-colors">Sign in</a>
        </header>

        {/* ── Hero ── */}
        <section className="relative max-w-4xl mx-auto px-6 pt-16 pb-10">
          <p className="text-[11px] uppercase tracking-[0.22em] text-indigo-300 mb-3">The proof page</p>
          <h1 className="text-3xl sm:text-4xl font-semibold text-white leading-tight max-w-2xl">
            Toolkits build agents.<br />DreamTeam employs them.
          </h1>
          <p className="text-sm text-dt-support mt-4 max-w-2xl leading-relaxed">
            Every company will have AI agents. Very few can employ them — trust them on evidence,
            govern them, see their work, develop them, and survive a vendor outage. This page exists
            because most of this market is marketing: nothing appears below that is not running in
            production, and the numbers are fetched live when you load the page.
          </p>
        </section>

        {/* ── Live counters ── */}
        <section className="relative max-w-4xl mx-auto px-6 pb-12">
          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
            <h2 className="text-sm font-semibold text-dt-title">Live from production — right now</h2>
            {stats && <span className="text-[10px] text-dt-muted">fetched {new Date(stats.generated_at).toLocaleString()}</span>}
          </div>
          {failed ? (
            <p className="text-xs text-dt-muted border border-dt-border rounded-xl p-4">
              The live counter service is unreachable from your network right now — which is at least honest.
              Everything below still describes only what is wired in production.
            </p>
          ) : !s ? (
            <p className="text-xs text-dt-muted">Fetching live production counts…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Counter label="Digital employees at work" value={s.active_digital_employees} />
                <Counter label="Conversations handled" value={s.conversations_handled} />
                <Counter label="Work items completed" value={s.work_items_completed} />
                <Counter label="Escalations honored to humans" value={s.escalations_to_humans} sub="Refusing to answer is a feature" />
                <Counter label="Guardrail blocks enforced" value={s.guardrail_blocks_enforced} sub="Un-toggleable, recorded in an audit chain" />
                <Counter label="Certification exams passed" value={`${s.certification_exams.passed}/${s.certification_exams.run}`} sub="Autonomy is earned, never assumed" />
                <Counter label="Knowledge documents (current)" value={s.knowledge_documents} />
                <Counter label="Policy amendments adopted" value={s.amendments_adopted} sub="Each judged against replay evidence" />
                <Counter label="Hash-chained audit events" value={s.audit_chain_events} />
              </div>
              <p className="text-[11px] text-dt-muted mt-3">{stats?.scope} These numbers are small because they are real — we publish them anyway.</p>
            </>
          )}
        </section>

        {/* ── The incident ── */}
        <section className="relative max-w-4xl mx-auto px-6 pb-12">
          <h2 className="text-sm font-semibold text-dt-title mb-3">The incident we publish instead of hiding</h2>
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
            <p className="text-sm text-dt-support leading-relaxed">
              On <span className="text-dt-title">July 22, 2026</span>, our primary model provider disabled our
              organization account without warning — every digital employee's brain went dark, mid-pilot.
              Because the platform routes all model traffic through a provider-neutral spine with an
              automatic failover chain, the workforce was switched to a second provider (AWS Bedrock)
              and resumed work the same day: same employees, same guardrails, same calibrated trust levels,
              different brain vendor. This is the production log line from the first request served after the switch:
            </p>
            <pre className="mt-3 text-[11px] text-emerald-300 bg-black/40 border border-dt-border rounded-xl px-4 py-3 overflow-x-auto">
              [llm] de-answer: FAILOVER — anthropic failed (401), served by bedrock
            </pre>
            <p className="text-xs text-dt-muted mt-3">
              Most AI-employee products are single-keyed to one model vendor. Ask any vendor — including us —
              what happens to your workforce the day their provider relationship breaks. We can show you.
            </p>
          </div>
        </section>

        {/* ── Verify-it map ── */}
        <section className="relative max-w-4xl mx-auto px-6 pb-12">
          <h2 className="text-sm font-semibold text-dt-title mb-1">Every claim, verifiable in the product</h2>
          <p className="text-xs text-dt-muted mb-3">In a walkthrough, ask to see any of these live — each is a screen, not a slide.</p>
          <div className="rounded-2xl border border-dt-border bg-dt-card divide-y divide-dt-border">
            {[
              ['Whole-workforce board', 'What every employee is doing now, what fires next and when, what waits on a human — one screen.'],
              ['Employee File', 'Per-employee dossier: how it operates, trust earned from evidence, certifications, development plan, decision history.'],
              ['Guardrails that bite', "Type a refund demand into the live chat: the employee refuses, explains why, and files an escalation — you'll see the human task it created."],
              ['Certification exams', 'Real graded exams gate autonomy server-side. A failed exam means the employee cannot be promoted — the gate is in the database, not the UI.'],
              ['Outcome metering', 'Work is metered per resolved outcome (99¢-class rails), with escalated and blocked work counted free in the denominator.'],
              ['Hash-chained audit trail', 'Every decision, block, and approval appends to a tamper-evident chain you can export.'],
            ].map(([t, d]) => (
              <div key={t} className="px-4 py-3">
                <p className="text-xs font-medium text-dt-title">{t}</p>
                <p className="text-xs text-dt-support mt-0.5 leading-relaxed">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Buy vs build ── */}
        <section className="relative max-w-4xl mx-auto px-6 pb-12">
          <h2 className="text-sm font-semibold text-dt-title mb-3">The build-it-yourself math, from people who measured it</h2>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-dt-border bg-dt-card p-4">
              <p className="text-xl font-semibold text-dt-title">&gt;40%</p>
              <p className="text-xs text-dt-support mt-1 leading-relaxed">of agentic-AI projects predicted to be canceled by end-2027 — driven by cost, unclear value, and inadequate risk controls.</p>
              <a href={SOURCES.gartner} target="_blank" rel="noreferrer" className="text-[10px] text-indigo-300 hover:underline mt-1.5 inline-block">Gartner press release, Jun 2025 ↗</a>
            </div>
            <div className="rounded-2xl border border-dt-border bg-dt-card p-4">
              <p className="text-xl font-semibold text-dt-title">95%</p>
              <p className="text-xs text-dt-support mt-1 leading-relaxed">of enterprise GenAI pilots produced zero P&L impact; external partnerships succeeded about twice as often as internal builds.</p>
              <a href={SOURCES.mit} target="_blank" rel="noreferrer" className="text-[10px] text-indigo-300 hover:underline mt-1.5 inline-block">MIT NANDA, State of AI in Business 2025 (PDF) ↗</a>
            </div>
            <div className="rounded-2xl border border-dt-border bg-dt-card p-4">
              <p className="text-xl font-semibold text-dt-title">~130</p>
              <p className="text-xs text-dt-support mt-1 leading-relaxed">of the thousands of "agentic AI" vendors judged real by Gartner — the rest re-labeled chatbots and RPA. Hence this page.</p>
              <a href={SOURCES.gartner} target="_blank" rel="noreferrer" className="text-[10px] text-indigo-300 hover:underline mt-1.5 inline-block">Gartner, on agent washing ↗</a>
            </div>
          </div>
          <p className="text-[10px] text-dt-muted mt-2">Third-party figures, cited as published by their authors — not our measurements.</p>
        </section>

        {/* ── CTA ── */}
        <section className="relative max-w-4xl mx-auto px-6 pb-16">
          <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/10 p-6">
            <h2 className="text-base font-semibold text-white">See it live, not on slides</h2>
            <p className="text-sm text-dt-support mt-1.5 max-w-xl leading-relaxed">
              A 30-minute walkthrough covers the board, a live guardrail refusal, an employee's file, and
              the meter — on production, with the same honesty as this page.
            </p>
            <a href="mailto:hr@outsourcetel.com?subject=DreamTeam%20walkthrough" className="inline-block mt-4 text-sm px-4 py-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 hover:brightness-110 text-white shadow-[0_4px_16px_-4px_rgba(99,102,241,0.7)] transition-all">
              Request a walkthrough
            </a>
          </div>
          <p className="text-[10px] text-dt-muted mt-6">© {new Date().getFullYear()} Outsourcetel · DreamTeam AI — the digital-workforce OS. <a href="/terms" className="hover:underline">Terms</a> · <a href="/privacy" className="hover:underline">Privacy</a></p>
        </section>
      </div>
    </div>
  );
}
