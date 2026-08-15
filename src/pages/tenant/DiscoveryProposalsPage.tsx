// DiscoveryProposalsPage — "the screen where a company sees what we
// recommend" (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation,
// Task 2). Reads discovery_proposals + discovery_capability_gaps and lets a
// person SELECT what they mean to accept, decline or park.
//
// ⚠ NO DECISION WRITES HERE. decide_discovery_proposal does not exist yet —
// that is Task 3. Every Accept/Decline/Park control on this screen is
// rendered disabled, with a title explaining why, so nothing on this page
// can be mistaken for having saved anything. The only state that changes on
// this screen is local React state (which checkboxes are ticked, which
// Drawer is open) — src/lib/discoveryApi.ts performs zero writes.
//
// THE DESIGN LAW THIS SCREEN IMPLEMENTS — §11b of
// docs/superpowers/specs/2026-08-12-discovery-interview-design.md:
//   - one disclosure level per card (title + one sentence + the literal in
//     `meta`; rationale/source/evidence/what-accepting-writes live in the
//     Drawer, never duplicated on the card face);
//   - no all-at-once accept anywhere — the EULA shape Böhme & Köpsell (CHI
//     2010) showed gets accepted blind;
//   - guardrail and trust_rule NEVER batch (src/lib/
//     discoveryProposalPresentation.ts's batchModeFor is the single gate —
//     see tests/discovery-proposal-batching.test.ts for the proof);
//   - the capability-gap message renders BELOW the last batch as a
//     Banner tone="info" with no action control — never the two-column
//     layout spec §5 originally proposed, which §11b itself corrects.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PageHeaderV2, PanelCard, Banner, EmptyState, Button, Chip, DecisionCard, Drawer,
} from '../../design/primitives';
import { LiveLoadingSkeleton } from '../../components/LiveDataStates';
import {
  getDiscoverySession, getLatestSessionWithProposals, listDiscoveryProposals,
  listDiscoveryDimensions, listCapabilityGapsForHeardDimensions,
} from '../../lib/discoveryApi';
import type {
  DiscoveryProposal, DiscoverySession, DiscoveryDimension, DiscoveryCapabilityGap,
} from '../../lib/discoveryApi';
import {
  SECTION_ORDER, KIND_LABELS, batchModeFor, cardCopyFor, whatAcceptingWrites, trustRuleBlockReason,
} from '../../lib/discoveryProposalPresentation';
import type { ProposalKind } from '../../lib/discoveryProposalPresentation';
import type { Page } from '../../types';

const DECIDE_NOT_WIRED_YET = 'Deciding what happens next is built in the following step — nothing here saves yet.';

export default function DiscoveryProposalsPage({ setPage: _setPage }: { setPage?: (p: Page) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<DiscoverySession | null>(null);
  const [proposals, setProposals] = useState<DiscoveryProposal[]>([]);
  const [dimensions, setDimensions] = useState<DiscoveryDimension[]>([]);
  const [gaps, setGaps] = useState<DiscoveryCapabilityGap[]>([]);
  const [openProposal, setOpenProposal] = useState<DiscoveryProposal | null>(null);
  // Local UI selection only — the "accept all N, uncheck to opt out" state
  // for the two-batch kinds. Never sent anywhere. Keyed by proposal id.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const requestedSessionId = new URLSearchParams(window.location.search).get('session');
      const [dims, sess] = await Promise.all([
        listDiscoveryDimensions(),
        requestedSessionId ? getDiscoverySession(requestedSessionId) : getLatestSessionWithProposals(),
      ]);
      setDimensions(dims);
      setSession(sess);
      if (!sess) {
        setProposals([]);
        setGaps([]);
        return;
      }
      const props = await listDiscoveryProposals(sess.id);
      setProposals(props);
      setSelected(new Set(props.filter((p) => p.state === 'pending').map((p) => p.id)));
      const heardKeys = Object.entries(sess.coverage ?? {})
        .filter(([, v]) => v?.state === 'heard')
        .map(([k]) => k);
      setGaps(await listCapabilityGapsForHeardDimensions(heardKeys));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dimTitleByKey = useMemo(() => new Map(dimensions.map((d) => [d.key, d.title])), [dimensions]);

  const employeeProposals = useMemo(() => proposals.filter((p) => p.kind === 'employee'), [proposals]);
  const employeeNameByArchetype = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employeeProposals) {
      const key = String(e.payload.archetype_key ?? '');
      if (key) m.set(key, String(e.payload.name ?? key));
    }
    return m;
  }, [employeeProposals]);

  const pendingByKind = useMemo(() => {
    const m = new Map<ProposalKind, DiscoveryProposal[]>();
    for (const kind of SECTION_ORDER) m.set(kind, proposals.filter((p) => p.kind === kind && p.state === 'pending'));
    return m;
  }, [proposals]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const totalPending = useMemo(() => proposals.filter((p) => p.state === 'pending').length, [proposals]);

  // ── one card, every kind renders through this ───────────────────────────
  const renderCard = (p: DiscoveryProposal, opts: { checkbox?: boolean; blockedReason?: string | null } = {}) => {
    const copy = cardCopyFor(p.kind, p.payload, employeeNameByArchetype);
    const blocked = opts.blockedReason ?? null;
    const detail = blocked ?? copy.detail;
    const tone = blocked ? 'neutral' : 'warn';
    const actions = blocked ? (
      <Chip tone="neutral">Blocked</Chip>
    ) : (
      <>
        <Button kind="primary" size="sm" disabled title={DECIDE_NOT_WIRED_YET}>Accept</Button>
        <Button kind="secondary" size="sm" disabled title={DECIDE_NOT_WIRED_YET}>Decline</Button>
        <Button kind="ghost" size="sm" disabled title={DECIDE_NOT_WIRED_YET}>Park</Button>
        <Button kind="ghost" size="sm" onClick={() => setOpenProposal(p)}>Details</Button>
      </>
    );
    const card = (
      <DecisionCard
        tone={tone}
        title={copy.title}
        detail={detail}
        meta={copy.meta}
        actions={actions}
        nudge={blocked ? undefined : copy.nudge}
      />
    );
    if (!opts.checkbox) return <div key={p.id}>{card}</div>;
    return (
      <div key={p.id} className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-5 w-4 h-4 accent-dt-accent-strong shrink-0"
          checked={selected.has(p.id)}
          onChange={() => toggleSelected(p.id)}
          aria-label={`Include "${copy.title}"`}
        />
        <div className="flex-1 min-w-0">{card}</div>
      </div>
    );
  };

  // ── section renderers, one per BatchMode ────────────────────────────────

  const renderAcceptAllSection = (kind: ProposalKind) => {
    const items = pendingByKind.get(kind) ?? [];
    if (items.length === 0) return null;
    const selectedCount = items.filter((p) => selected.has(p.id)).length;
    return (
      <PanelCard
        key={kind}
        title={`${KIND_LABELS[kind]} (${items.length})`}
        actions={
          <Button kind="primary" size="sm" disabled title={DECIDE_NOT_WIRED_YET}>
            Accept {selectedCount} selected
          </Button>
        }
      >
        <p className="text-xs text-dt-muted mb-3">
          The real consent step for {KIND_LABELS[kind].toLowerCase()} comes later — publishing a procedure, or
          entering a credential for a connector. Uncheck anything you don't want proposed at all.
        </p>
        <div className="space-y-3">{items.map((p) => renderCard(p, { checkbox: true }))}</div>
      </PanelCard>
    );
  };

  const renderDepartmentSection = (kind: ProposalKind) => {
    const items = pendingByKind.get(kind) ?? [];
    if (items.length === 0) return null;
    const byDept = new Map<string, DiscoveryProposal[]>();
    for (const p of items) {
      const dept = String(p.payload.department ?? '').trim() || 'General';
      const list = byDept.get(dept) ?? [];
      list.push(p);
      byDept.set(dept, list);
    }
    return (
      <div key={kind} className="space-y-4">
        <h2 className="text-base font-semibold text-dt-title">{KIND_LABELS[kind]} ({items.length})</h2>
        {[...byDept.entries()].map(([dept, deptItems]) => (
          <PanelCard key={dept} title={`${dept} (${deptItems.length})`}>
            <div className="space-y-3">{deptItems.map((p) => renderCard(p))}</div>
          </PanelCard>
        ))}
      </div>
    );
  };

  const renderNeverBatchSection = (kind: ProposalKind) => {
    const items = pendingByKind.get(kind) ?? [];
    if (items.length === 0) return null;
    return (
      <PanelCard key={kind} title={`${KIND_LABELS[kind]} (${items.length})`}>
        <div className="space-y-3">
          {items.map((p) => {
            let blockedReason: string | null = null;
            if (p.kind === 'trust_rule') {
              blockedReason = trustRuleBlockReason(String(p.payload.de_ref ?? ''), employeeProposals);
            }
            return renderCard(p, { blockedReason });
          })}
        </div>
      </PanelCard>
    );
  };

  const sections = SECTION_ORDER.map((kind) => {
    const mode = batchModeFor(kind);
    if (mode === 'never') return renderNeverBatchSection(kind);
    if (mode === 'department') return renderDepartmentSection(kind);
    return renderAcceptAllSection(kind);
  }).filter(Boolean);

  // ── page shell ───────────────────────────────────────────────────────────
  return (
    <div className="px-6 pt-8 pb-10 max-w-dt-content mx-auto space-y-6">
      <PageHeaderV2
        title="What we recommend"
        subtitle="Based on your discovery interview — nothing here is live until you accept it."
      />

      {loading && <LiveLoadingSkeleton rows={5} />}

      {!loading && error && (
        <Banner tone="danger">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button kind="secondary" size="sm" onClick={() => void load()}>Retry</Button>
          </div>
        </Banner>
      )}

      {!loading && !error && !session && (
        <EmptyState headline="Nothing to review yet">
          Run the discovery interview first — once it hears something about your business, its recommendations
          show up here.
        </EmptyState>
      )}

      {!loading && !error && session && totalPending === 0 && gaps.length === 0 && (
        <EmptyState headline="Nothing left to decide">
          Every recommendation from this interview has already been decided, or none were ever produced.
        </EmptyState>
      )}

      {!loading && !error && session && (sections.length > 0 || gaps.length > 0) && (
        <div className="space-y-6">
          {sections}

          {/* §11b's correction to spec §5: NOT the two-column layout — a
              non-decision must never carry equal visual weight to a real
              one. This sits below every batch, alone, with no control that
              could approve, decline or park it — it is not a proposal. */}
          {gaps.length > 0 && (
            <div className="space-y-3">
              {gaps.map((g) => (
                <Banner key={g.dimension_key} tone="info">{g.customer_message}</Banner>
              ))}
            </div>
          )}
        </div>
      )}

      {openProposal && (
        <Drawer title="Why we're proposing this" onClose={() => setOpenProposal(null)}>
          <div className="space-y-4 text-sm text-dt-body">
            <div>
              <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">Source</div>
              <p>{dimTitleByKey.get(openProposal.source_dimension ?? '') ?? openProposal.source_dimension ?? 'Not recorded'}</p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">What you told us</div>
              <p className="text-dt-support">{openProposal.rationale ?? 'No rationale recorded.'}</p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">If you accept</div>
              <p className="text-dt-support">{whatAcceptingWrites(openProposal.kind)}</p>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
