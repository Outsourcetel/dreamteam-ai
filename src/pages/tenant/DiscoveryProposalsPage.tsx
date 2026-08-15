// DiscoveryProposalsPage — "the screen where a company sees what we
// recommend" (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation,
// Task 2). Reads discovery_proposals + discovery_capability_gaps and lets a
// person SELECT what they mean to accept, decline or park.
//
// TASK 3 — DECISIONS ARE LIVE, FOR ONE KIND. 'connector' now writes: its
// Accept runs the full Path B sequence (create the connector through the
// ordinary writer as the signed-in human under RLS, then stamp the proposal
// with the id it produced), and its Decline/Park call the same RPC with no
// object. The other five kinds are still read-only, and their controls stay
// disabled rather than becoming buttons that quietly do nothing.
//
// ⚠ WHAT DECIDES THAT, precisely — because this comment used to say
// "isDecidableKind is the single gate" and that was not true. The gate and the
// accept writer are ONE table, ACCEPT_WRITERS in src/lib/discoveryApi.ts:
// isDecidableKind asks whether a kind has an entry, acceptProposal runs the
// entry it finds. This page never names a writer. It did, twice — the per-card
// handler and the batch accept both called acceptConnectorProposal directly —
// so widening the gate by one word, which is exactly what the contract's risk
// order tells the next implementer to do for 'guardrail', would have shipped
// Decline and Park for that kind through a path nobody had built, while Accept
// answered with a sentence about systems to connect.
//
// ⚠ The banner near the top of this page says which is which, in plain
// language and in the page body — NOT as a title= tooltip on the disabled
// buttons (fix round 1, review: disabled elements never fire mouse events in
// a browser, so a tooltip there is invisible to every sighted user, always).
// When that banner and isDecidableKind disagree, the banner is the lie.
//
// ⚠ A REFUSAL MUST BE VISIBLE. The whole point of migration 740's last_error
// column is that a card which fails to become a thing says why, and still
// says why tomorrow. errorFor() below is where that lands on screen; a card
// that slid back to 'pending' with no explanation is the exact failure this
// step exists to prevent.
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PageHeaderV2, PanelCard, Banner, EmptyState, Button, Chip, DecisionCard, Drawer,
  Modal, INPUT_CLS,
} from '../../design/primitives';
import { LiveLoadingSkeleton } from '../../components/LiveDataStates';
import {
  getDiscoverySession, getLatestSessionWithProposals, listDiscoveryProposals,
  listDiscoveryDimensions, listCapabilityGapsForHeardDimensions,
  acceptProposal, decideDiscoveryProposal, isDecidableKind,
} from '../../lib/discoveryApi';
import type {
  DiscoveryProposal, DiscoverySession, DiscoveryDimension, DiscoveryCapabilityGap,
  DiscoveryDecision,
} from '../../lib/discoveryApi';
import {
  SECTION_ORDER, KIND_LABELS, batchModeFor, cardCopyFor, whatAcceptingWrites, trustRuleBlockReason,
  itemsForBatchMode,
} from '../../lib/discoveryProposalPresentation';
import type { ProposalKind } from '../../lib/discoveryProposalPresentation';
import type { Page } from '../../types';

// Fix round 1 (review, Important): this used to live ONLY in a title= on a
// disabled <button> — disabled elements never fire mouse events, so that
// tooltip could never appear to anyone. Said once, visibly, near the top of
// the page instead — customer voice, not "built in the following step".
//
// Task 3 rewrote it, because the old wording ("Accept, Decline and Park don't
// do anything on this screen") became false the moment connector decisions
// went live. A banner that is stale in the safe direction is still a lie.
const PARTLY_LIVE_EXPLANATION =
  "Systems to connect are ready to decide. The rest of these are still just for reading — we're finishing what accepting them does, so their buttons stay switched off until it's real.";
const NOTHING_LIVE_EXPLANATION =
  "You're looking these over, not deciding yet. Accept, Decline and Park don't do anything on this screen — you'll make the real call once this is turned on for you.";

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
  // Refusals from THIS session, keyed by proposal id. Deliberately NOT cleared
  // by load(): a refused proposal is still pending, so its card comes back,
  // and it must come back still saying why.
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Decline and Park collect a sentence first — see the modal at the bottom.
  const [noteTarget, setNoteTarget] = useState<{ proposal: DiscoveryProposal; decision: DiscoveryDecision } | null>(null);
  const [noteText, setNoteText] = useState('');
  /** Every proposal id this page has ever rendered. Lets load() tell "the
   *  person unchecked this" apart from "this is new", which a Set of the
   *  currently-checked ids alone cannot. */
  const seenIds = useRef<Set<string>>(new Set());

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
      // ⚠ Before Task 3 this was a plain overwrite, which was harmless because
      // load() only ever ran once. It runs after every decision now, and an
      // overwrite would silently RE-CHECK anything the person had deliberately
      // unchecked — handing back a batch containing the two items they just
      // opted out of, with the count next to the button agreeing. Unchecking
      // is the only control §11b gives someone over a batch, so it has to
      // survive a refresh: a proposal this page has shown before keeps exactly
      // the state it was left in, and only one it has never shown starts
      // checked.
      setSelected((prev) => {
        const next = new Set<string>();
        for (const p of props) {
          if (p.state !== 'pending') continue;
          if (!seenIds.current.has(p.id) || prev.has(p.id)) next.add(p.id);
        }
        for (const p of props) seenIds.current.add(p.id);
        return next;
      });
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

  // Every proposal still awaiting a decision, kind-mixed on purpose: the
  // three renderers below each route their slice of this through
  // itemsForBatchMode, which is what actually enforces which kind belongs
  // in which section — not this array, and not which renderer happens to
  // get called with which kind. See itemsForBatchMode's own header.
  const pendingProposals = useMemo(() => proposals.filter((p) => p.state === 'pending'), [proposals]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const totalPending = useMemo(() => proposals.filter((p) => p.state === 'pending').length, [proposals]);

  // ⚠ PARK IS A PAUSE, AND A PAUSE NEEDS SOMEWHERE TO WAIT. Migration 741
  // widened its compare-and-swap to admit 'parked' precisely so a parked
  // proposal STAYS decidable, and the confirmation tells the customer "you can
  // come back to it". Until this section existed, that was false in the
  // product: every renderer read `pendingProposals`, nothing anywhere listed a
  // parked row, and the only way back was a decision path with no door. That
  // is the pile of nineteen undecided proposals this whole surface was built
  // to stop, reproduced one state to the left.
  const parkedProposals = useMemo(() => proposals.filter((p) => p.state === 'parked'), [proposals]);

  const anyDecidable = useMemo(() => pendingProposals.some((p) => isDecidableKind(p.kind)), [pendingProposals]);

  // ── deciding ────────────────────────────────────────────────────────────

  const noteFor = (p: DiscoveryProposal) => cardCopyFor(p.kind, p.payload, employeeNameByArchetype).title;

  /** Record one outcome. A refusal is written onto the card it belongs to;
   *  a success clears any older reason so a stale one cannot outlive it. */
  const recordOutcome = (p: DiscoveryProposal, message: string | null) => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(p.id, message); else next.delete(p.id);
      return next;
    });
  };

  const runDecision = useCallback(async (
    p: DiscoveryProposal,
    decision: DiscoveryDecision,
    note: string | null,
  ) => {
    setBusy((prev) => new Set(prev).add(p.id));
    setFlash(null);
    try {
      // Accept is the only decision that has to create something first, so it
      // is the only one that goes through a per-kind writer — and it goes
      // through acceptProposal, which LOOKS THE WRITER UP in the same table
      // isDecidableKind reads. Naming acceptConnectorProposal here (which this
      // line used to do) made the writer a second, hardcoded gate that the
      // documented one could not see.
      //
      // Decline and park create nothing by definition and call the RPC
      // directly with a null object id — the plan's "a declined proposal
      // creates nothing" is a property of there being no writer on this branch
      // at all, not of a flag someone could flip.
      const outcome = decision === 'accepted'
        ? await acceptProposal(p, note)
        : await decideDiscoveryProposal(p.id, decision, note, null);

      const title = noteFor(p);
      if (!outcome.ok) {
        recordOutcome(p, outcome.error ?? 'That did not go through, and the workspace did not say why.');
      } else {
        recordOutcome(p, null);
        setFlash(
          decision === 'accepted'
            // ⚠ TWO different true things, not one convenient one. An accept
            // that RE-USED a connector the workspace already had inserted
            // nothing — telling that person to go and enter a credential sends
            // them to fix a system that is very possibly already connected and
            // working. acceptProposal reports which branch it took.
            ? (outcome.reusedExisting
              ? `${title} — you already had this one, so nothing new was created. It's recorded as accepted, and it's under Systems.`
              : `${title} — set up and waiting for your credential. You'll find it under Systems.`)
            : decision === 'declined'
              ? `${title} — turned down. Nothing was created.`
              : `${title} — set aside. You can come back to it.`,
        );
      }
    } catch (err) {
      recordOutcome(p, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(p.id); return next; });
      await load();
    }
  }, [load, employeeNameByArchetype]);

  /** The section-level "Accept N selected". Sequential on purpose: each accept
   *  finds-then-inserts against `connectors`, so running them together would
   *  let two accepts race past each other's find. Slower, and countable. */
  const acceptSelected = useCallback(async (items: readonly DiscoveryProposal[]) => {
    const targets = items.filter((p) => selected.has(p.id));
    if (targets.length === 0) return;
    setBatchBusy(true);
    setFlash(null);
    const failed = new Map<string, string>();
    let accepted = 0;
    let reused = 0;
    for (const p of targets) {
      try {
        // ⚠ acceptProposal, not acceptConnectorProposal. This call site was
        // the SECOND hardcoded writer — the review named only the per-card one
        // — so widening isDecidableKind would have routed a batch of some
        // other kind straight into the connector writer.
        const outcome = await acceptProposal(p, null);
        if (outcome.ok) { accepted += 1; if (outcome.reusedExisting) reused += 1; }
        else failed.set(p.id, outcome.error ?? 'That did not go through, and the workspace did not say why.');
      } catch (err) {
        failed.set(p.id, err instanceof Error ? err.message : String(err));
      }
    }
    setErrors((prev) => {
      const next = new Map(prev);
      for (const p of targets) next.delete(p.id);
      for (const [id, msg] of failed) next.set(id, msg);
      return next;
    });
    // Counts, not a verdict: "all done" over a batch where two failed is the
    // reassurance that hides the thing the person needs to act on.
    //
    // ⚠ And "each waiting for your credential" was false about part of the
    // batch the moment one accept re-used a connector the workspace already
    // had. Two counts said separately beats one tidy sentence that is wrong
    // about some of the rows it covers.
    const newlyCreated = accepted - reused;
    const setUpPhrase = accepted === 0
      ? 'Nothing was set up.'
      : reused === 0
        ? `${accepted} set up, each waiting for your credential.`
        : newlyCreated === 0
          ? `${accepted} accepted — you already had every one of them, so nothing new was created.`
          : `${newlyCreated} set up and waiting for your credential; ${reused} you already had, so nothing new was created for those.`;
    setFlash(
      failed.size === 0
        ? setUpPhrase
        : `${setUpPhrase} ${failed.size} of ${targets.length} did not go through — the reason is on each card below.`,
    );
    setBatchBusy(false);
    await load();
  }, [selected, load]);

  /** What this card should be saying about its own last failure.
   *  The in-session message wins when there is one — it is the more specific
   *  of the two, and can name a client-side refusal the RPC never saw.
   *  Otherwise last_error, which is what survives a reload: migration 740
   *  exists so a refusal is still on the card tomorrow morning. One of them,
   *  never both saying the same thing twice. */
  const errorFor = (p: DiscoveryProposal): string | null => {
    const live = errors.get(p.id);
    if (live) return live;
    if (p.last_error) {
      return p.attempts > 1
        ? `${p.last_error} (tried ${p.attempts} times)`
        : p.last_error;
    }
    return null;
  };

  // ── one card, every kind renders through this ───────────────────────────
  const renderCard = (p: DiscoveryProposal, opts: { checkbox?: boolean; blockedReason?: string | null } = {}) => {
    const copy = cardCopyFor(p.kind, p.payload, employeeNameByArchetype);
    const blocked = opts.blockedReason ?? null;
    const detail = blocked ?? copy.detail;
    const tone = blocked ? 'neutral' : 'warn';
    // Fix round 1 (review, minor): the blocked branch used to REPLACE the
    // whole action row with just a "Blocked" chip, which took the Details
    // button with it — the one card a reader can't act on is exactly the
    // one they'd most want to read. Details now survives both branches.
    // isDecidableKind decides whether the three controls are live, and it
    // reads ACCEPT_WRITERS — the SAME table acceptProposal looks the writer up
    // in. That is what makes it a gate rather than a label: a kind cannot be
    // admitted here without an accept writer existing, and cannot gain one
    // without being admitted here. (It was a label until 2026-08-15: this
    // comment claimed to be "the ONLY gate" while the writer was chosen by a
    // hardcoded ternary two functions away, and by a second hardcoded call in
    // the batch accept.) A kind the table does not name keeps the disabled
    // controls it had before Task 3 — never a live button whose handler is a
    // no-op, which is the shape that makes a screen look governed while
    // nothing behind it moves.
    const live = isDecidableKind(p.kind) && !blocked;
    const working = busy.has(p.id) || batchBusy;
    const failure = errorFor(p);
    const actions = (
      <>
        {blocked ? (
          <Chip tone="neutral">Blocked</Chip>
        ) : live ? (
          <>
            <Button kind="primary" size="sm" disabled={working} onClick={() => void runDecision(p, 'accepted', null)}>
              {busy.has(p.id) ? 'Setting up…' : 'Accept'}
            </Button>
            <Button kind="secondary" size="sm" disabled={working} onClick={() => { setNoteText(''); setNoteTarget({ proposal: p, decision: 'declined' }); }}>
              Decline
            </Button>
            <Button kind="ghost" size="sm" disabled={working} onClick={() => { setNoteText(''); setNoteTarget({ proposal: p, decision: 'parked' }); }}>
              Park
            </Button>
          </>
        ) : (
          <>
            <Button kind="primary" size="sm" disabled>Accept</Button>
            <Button kind="secondary" size="sm" disabled>Decline</Button>
            <Button kind="ghost" size="sm" disabled>Park</Button>
          </>
        )}
        <Button kind="ghost" size="sm" onClick={() => setOpenProposal(p)}>Details</Button>
      </>
    );
    const card = (
      <DecisionCard
        tone={failure ? 'danger' : tone}
        title={copy.title}
        detail={detail}
        meta={copy.meta}
        actions={actions}
        nudge={blocked ? undefined : copy.nudge}
      />
    );
    // The refusal sits BELOW its own card, in its own Banner, rather than in
    // `nudge` — nudge is the accent-coloured encouragement slot, and a reason
    // something failed is not encouragement. It renders whether the failure
    // came from this click or from last_error on a page loaded fresh.
    const body = failure
      ? (
        <div className="space-y-2">
          {card}
          <Banner tone="danger">{failure}</Banner>
        </div>
      )
      : card;
    if (!opts.checkbox) return <div key={p.id}>{body}</div>;
    return (
      <div key={p.id} className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-5 w-4 h-4 accent-dt-accent-strong shrink-0"
          checked={selected.has(p.id)}
          onChange={() => toggleSelected(p.id)}
          disabled={working}
          aria-label={`Include "${copy.title}"`}
        />
        <div className="flex-1 min-w-0">{body}</div>
      </div>
    );
  };

  // ── section renderers, one per BatchMode ────────────────────────────────

  const renderAcceptAllSection = (kind: ProposalKind) => {
    // itemsForBatchMode(kind, 'accept_all', ...) returns [] for guardrail or
    // trust_rule even if this renderer is ever called with one by mistake —
    // that mis-call is exactly what tests/discovery-proposal-batching.test.ts's
    // "the exact bypass the review named" case proves stays closed.
    const items = itemsForBatchMode(kind, 'accept_all', pendingProposals);
    if (items.length === 0) return null;
    const selectedCount = items.filter((p) => selected.has(p.id)).length;
    // Same gate as the per-card controls, so the batch button and the buttons
    // inside it can never disagree about whether this kind is live. It is
    // still a batch of N individual accepts, each with its own object and its
    // own stamp — §11b's "no all-at-once accept anywhere" is about there being
    // no control that decides EVERY kind at once, which this is not.
    const live = isDecidableKind(kind);
    return (
      <PanelCard
        key={kind}
        title={`${KIND_LABELS[kind]} (${items.length})`}
        actions={
          <Button
            kind="primary"
            size="sm"
            disabled={!live || batchBusy || selectedCount === 0}
            onClick={live ? () => void acceptSelected(items) : undefined}
          >
            {batchBusy ? 'Setting up…' : `Accept ${selectedCount} selected`}
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
    const items = itemsForBatchMode(kind, 'department', pendingProposals);
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
    const items = itemsForBatchMode(kind, 'never', pendingProposals);
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

      {/* ⚠ `parkedProposals.length` belongs in this condition. Without it, a
          customer who parks everything is told "nothing left to decide" while
          holding a stack of things they explicitly asked to come back to —
          an all-clear manufactured by the reader's own state, which is the
          same defect the support inbox's filtered empty state had to fix. */}
      {!loading && !error && session && totalPending === 0 && gaps.length === 0 && parkedProposals.length === 0 && (
        <EmptyState headline="Nothing left to decide">
          Every recommendation from this interview has already been decided, or none were ever produced.
        </EmptyState>
      )}

      {!loading && !error && session && (sections.length > 0 || gaps.length > 0 || parkedProposals.length > 0) && (
        <div className="space-y-6">
          <Banner tone="neutral">{anyDecidable ? PARTLY_LIVE_EXPLANATION : NOTHING_LIVE_EXPLANATION}</Banner>

          {/* tone="info", not a success green: Banner offers info/warn/danger/
              neutral on purpose ("one recipe per severity"), and a
              confirmation is not a severity. Reaching for a fifth tone here
              would have widened a primitive to say "it worked" — which the
              sentence already says. */}
          {flash && <Banner tone="info">{flash}</Banner>}

          {sections}

          {/* Set aside — below every live decision, because these are not
              waiting on the customer's attention today; they are waiting on
              the customer. Rendered through the SAME renderCard as everything
              else, so Accept and Decline are genuinely available: picking one
              up again is just deciding it, and migration 741's compare-and-swap
              admits 'parked' for exactly that. No checkboxes — a batch control
              over things somebody deliberately deferred would undo the
              deferral. */}
          {parkedProposals.length > 0 && (
            <PanelCard title={`Set aside for later (${parkedProposals.length})`}>
              <p className="text-sm text-dt-support mb-3">
                You asked to come back to these. Nothing was created and nothing was turned down —
                they are here whenever you are ready.
              </p>
              <div className="space-y-3">
                {parkedProposals.map((p) => renderCard(p))}
              </div>
            </PanelCard>
          )}

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

      {/* Decline and Park ask for a sentence; Accept does not. That asymmetry
          is deliberate. An accept's reason is the card the person just read —
          it is on screen and it is in the audit detail verbatim. A decline's
          reason exists nowhere else at all: discovery_proposals has no note
          column, so the only copy of "why we said no to this" is the one
          written here and carried into the audit event. Park is the same, and
          worse — an unexplained park is how a pile of undecided
          recommendations becomes invisible. Optional, not compulsory: a rule
          that stops someone saying "no" until they justify it is a way of
          forcing things through, not an authority model. */}
      {noteTarget && (
        <Modal
          size="md"
          title={noteTarget.decision === 'declined' ? 'Turning this down' : 'Setting this aside'}
          onClose={() => setNoteTarget(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-dt-support">
              {noteTarget.decision === 'declined'
                ? `Nothing gets created for "${noteFor(noteTarget.proposal)}".`
                : `"${noteFor(noteTarget.proposal)}" stays on this list — you can decide it later.`}
              {' '}Your reason is the only record of why, so it is worth a line. You can leave it blank.
            </p>
            <textarea
              className={INPUT_CLS}
              rows={3}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={noteTarget.decision === 'declined' ? 'We already have this covered elsewhere…' : 'Want to talk it over with the team first…'}
              aria-label="Your reason"
            />
            <div className="flex items-center justify-end gap-2">
              <Button kind="ghost" size="sm" onClick={() => setNoteTarget(null)}>Cancel</Button>
              <Button
                kind="primary"
                size="sm"
                onClick={() => {
                  const target = noteTarget;
                  setNoteTarget(null);
                  void runDecision(target.proposal, target.decision, noteText.trim() || null);
                }}
              >
                {noteTarget.decision === 'declined' ? 'Decline it' : 'Park it'}
              </Button>
            </div>
          </div>
        </Modal>
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
              <p className="text-dt-support">{whatAcceptingWrites(openProposal.kind, openProposal.payload)}</p>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
