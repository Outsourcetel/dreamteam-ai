// DiscoveryProposalsPage — "the screen where a company sees what we
// recommend" (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation,
// Task 2). Reads discovery_proposals + discovery_capability_gaps and lets a
// person SELECT what they mean to accept, decline or park.
//
// TASK 3 — DECISIONS ARE LIVE, FOR TWO KINDS.
//   'connector' writes through Path B: its Accept creates the connector via the
//   ordinary writer as the signed-in human under RLS, then stamps the proposal
//   with the id it produced.
//   'employee' writes through Path A (migration 746): its Accept is ONE call —
//   decide_discovery_proposal hires the employee itself, in one transaction,
//   because all three of its ordinary writers are SQL and `authenticated` holds
//   only SELECT on digital_employees.
// Decline and Park call the same RPC with no object for both. The other three
// kinds are still read-only, and their controls stay disabled rather than
// becoming buttons that quietly do nothing.
//
// ⚠ THE HIRE'S CONFIRMATION SAYS WHAT ACTUALLY HAPPENED, INCLUDING A ZERO.
// The RPC returns systems_installed and watchers_skipped from the writers' own
// return values, and this screen prints them. "0 connected systems" printed
// with no explanation is the existing hire wizard's defect — it reads the same
// for "this role has none" and for "the systems step refused" — so the sentence
// here names the outcome instead of the number alone.
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
  acceptProposal, decideDiscoveryProposal, isDecidableKind, decidableKindsSentence,
  listCompliancePacksForArchetypes,
} from '../../lib/discoveryApi';
import type {
  DiscoveryProposal, DiscoverySession, DiscoveryDimension, DiscoveryCapabilityGap,
  DiscoveryDecision,
} from '../../lib/discoveryApi';
import {
  SECTION_ORDER, KIND_LABELS, batchModeFor, cardCopyFor, whatAcceptingWrites, trustRuleBlockReason,
  itemsForBatchMode, needsAcceptConfirmation, acceptAllSectionBlurb, topicAcceptability,
} from '../../lib/discoveryProposalPresentation';
import type { AcceptCompliancePack, ProposalKind } from '../../lib/discoveryProposalPresentation';
import type { Page } from '../../types';

// Fix round 1 (review, Important): this used to live ONLY in a title= on a
// disabled <button> — disabled elements never fire mouse events, so that
// tooltip could never appear to anyone. Said once, visibly, near the top of
// the page instead — customer voice, not "built in the following step".
//
// Task 3 rewrote it, because the old wording ("Accept, Decline and Park don't
// do anything on this screen") became false the moment connector decisions
// went live. A banner that is stale in the safe direction is still a lie.
//
// ⚠ AND IT WENT STALE AGAIN, WHICH IS WHY IT IS NO LONGER A LITERAL. The Task 3
// wording was "Systems to connect are ready to decide. The rest of these are
// still just for reading" — true for exactly as long as 'connector' was the
// only wired kind, and false the minute migration 746 wired 'employee', in a
// file that says three lines further down that when this banner and
// isDecidableKind disagree, the banner is the lie. Now it is BUILT from
// ACCEPT_WRITERS via decidableKindsSentence(), so it cannot disagree with the
// buttons: adding a kind to that table rewrites this sentence in the same edit.
const partlyLiveExplanation = () =>
  `You can decide ${decidableKindsSentence()} now. The rest of these are still just for reading — we're finishing what accepting them does, so their buttons stay switched off until it's real.`;
const NOTHING_LIVE_EXPLANATION =
  "You're looking these over, not deciding yet. Accept, Decline and Park don't do anything on this screen — you'll make the real call once this is turned on for you.";

/** What a customer is told after a hire actually goes through.
 *
 *  ⚠ THREE SENTENCES, AND THE MIDDLE ONE IS THE POINT. `systems_installed`
 *  comes back from install_role_systems' own return value (migration 746), and
 *  a ZERO there is a fact this screen has to say out loud rather than round off.
 *  The existing hire wizard prints "0 connected systems" identically for "this
 *  role has none to connect" and "the systems step refused" — indistinguishable
 *  from the outside, so the person is never told the difference and never fixes
 *  it. Here the zero gets a sentence and somewhere to go.
 *
 *  ⚠ `undefined` is NOT zero. A kind that does not report the counter says
 *  nothing about systems at all, rather than claiming none — see
 *  DecisionOutcome's own note on why `?? 0` would manufacture a fact. */
function hireConfirmation(
  title: string,
  outcome: {
    systemsInstalled?: number; watchersSkipped?: number;
    complianceRulesCreated?: number; compliancePacksAttached?: string[];
  },
): string {
  const parts = [`${title} — hired. They start supervised and send nothing until you say so.`];
  if (outcome.systemsInstalled === 0) {
    parts.push('They could not be connected to any of your systems yet — you can wire those up on their Employee File.');
  } else if (typeof outcome.systemsInstalled === 'number') {
    parts.push(`Connected to ${outcome.systemsInstalled} of your systems.`);
  }
  if (typeof outcome.watchersSkipped === 'number' && outcome.watchersSkipped > 0) {
    parts.push(`${outcome.watchersSkipped} of the things they were meant to watch could not be set up — their Book of Work will be short until that is looked at.`);
  }
  // ⚠ SAID AFTER THE FACT AS WELL AS BEFORE IT. The drawer warns that a hire
  // switches on workspace-wide blocking rules; this is the receipt that it
  // actually did. Migration 747 reports the delta, so a second finance hire —
  // which attaches nothing because the pack is already on — correctly says
  // nothing here rather than claiming two more rules. A zero is silence, not a
  // sentence: there is nothing to tell anyone about.
  if (typeof outcome.complianceRulesCreated === 'number' && outcome.complianceRulesCreated > 0) {
    const n = outcome.complianceRulesCreated;
    const packs = (outcome.compliancePacksAttached ?? []).join(', ');
    parts.push(`This role also switched on ${n} blocking compliance rule${n === 1 ? '' : 's'}${packs ? ` (${packs})` : ''} that now apply to every employee in this workspace — you can review or remove them under Compliance & Guardrails.`);
  }
  return parts.join(' ');
}

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
  // ⚠ AND SO DOES ACCEPT, when accepting switches on blocking rules this
  // workspace does not already have. See needsAcceptConfirmation for why this
  // is conditional rather than universal, and the modal at the bottom for what
  // it shows.
  const [acceptTarget, setAcceptTarget] = useState<DiscoveryProposal | null>(null);
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

  // ⚠ WHAT ACCEPTING A HIRE ALSO SWITCHES ON, looked up because the payload
  // does not carry it. 7 of the 15 active archetypes attach a compliance pack,
  // and a pack materialises BLOCKING rules with applies_to='all' — controls on
  // every employee in the workspace, arriving as a side effect of one hire.
  // Nothing showed them before migration 747, and a rule the customer was never
  // shown is a rule they cannot have consented to (§11b).
  //
  // ⚠ null, NOT an empty Map, until the read comes back. The drawer says "not
  // checked yet" for an archetype it has no entry for, so an empty Map here
  // would turn "we haven't looked" into "there are none" — the exact
  // manufactured fact this page refuses elsewhere with `?? 0`.
  const [packsByArchetype, setPacksByArchetype] = useState<Map<string, AcceptCompliancePack[]> | null>(null);
  useEffect(() => {
    const keys = employeeProposals.map((e) => String(e.payload.archetype_key ?? '')).filter(Boolean);
    if (keys.length === 0) { setPacksByArchetype(new Map()); return; }
    let live = true;
    void listCompliancePacksForArchetypes(keys).then((m) => { if (live) setPacksByArchetype(m); });
    return () => { live = false; };
  }, [employeeProposals]);

  /** The pack facts for ONE proposal, in the shape every disclosure point takes.
   *
   *  ⚠ ONE BUILDER, THREE READERS — the card face, the accept confirmation and
   *  the Details drawer. Before this, only the drawer had it, and the drawer is
   *  the one place a person does not have to go before clicking Accept. Three
   *  hand-built objects would be three chances for the card and the confirmation
   *  to say different things about the same hire.
   *
   *  ⚠ `undefined` propagates deliberately, twice over: the Map is null until
   *  the lookup lands, and a Map with no entry for this archetype means the read
   *  came back empty (listCompliancePacksForArchetypes returns an EMPTY map on
   *  any failure, precisely so a failed read cannot read as "no packs"). Both
   *  reach the copy functions as `undefined`, which they render as "not checked
   *  yet" and which needsAcceptConfirmation treats as a reason TO confirm. */
  const acceptContextFor = useCallback((p: DiscoveryProposal) => (
    p.kind === 'employee'
      ? { compliancePacks: packsByArchetype?.get(String(p.payload.archetype_key ?? '')) }
      : undefined
  ), [packsByArchetype]);

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
            ? (p.kind === 'employee'
              ? hireConfirmation(title, outcome)
              // ⚠ 751: a guardrail accept is NOT "waiting for your credential".
              // It is the opposite — the rule is live the moment it lands, with
              // no second gate behind it, which is exactly why this sentence
              // says so and says where to undo it. A connector's card can
              // afford to be quiet about consequences because the credential
              // step is still ahead of the customer; a guardrail's cannot.
              : p.kind === 'guardrail'
                ? (outcome.reusedExisting
                  ? `${title} — you already had exactly this rule, so nothing new was created. It is switched on, under Compliance & Guardrails.`
                  : `${title} — switched on now. It applies to every employee in this workspace, and you can take it off again under Compliance & Guardrails.`)
              // ⚠ 752: a procedure accept is the OPPOSITE of a guardrail's, and
              // saying so is the point. A guardrail is live the instant it
              // lands; a procedure is a DRAFT and every path that RUNS a
              // definition filters on `published` — eight gates across five
              // callers, enumerated in migration 752's header — so nothing runs
              // it until the customer says so.
              // Neither "waiting for your credential" nor "switched on now" is
              // true of it, and this card's whole safety argument is the second
              // gate — so the sentence names it.
              : p.kind === 'procedure'
                ? (outcome.reusedExisting
                  ? `${title} — this one had already been drafted, so nothing new was written. It is under Playbooks as a draft, and it runs nothing until you publish it.`
                  : `${title} — drafted. You'll find it under Playbooks as a draft: read it over, change anything, and it runs nothing until you publish it.`)
              // ⚠ 753: a trust rule is the OPPOSITE of a guardrail in the one
              // way that matters here — a guardrail is live the instant it
              // lands, and this changes nothing at all. The flash says so in
              // the founder's own framing rather than congratulating the
              // customer on a limit that is not switched on, and it names where
              // the setting turned up so "we wrote it down" is checkable.
              // `enforcesToday` is read as a BOOLEAN, not for truthiness: if a
              // future version of the RPC ever stops reporting it, this must
              // fall back to saying less rather than to claiming false.
              //
              // ⚠⚠ FIX ROUND 2: this used to say "this employee still brings
              // everything to you", which is a claim about the employee's
              // SUPERVISION and not about what the accept did. de_autonomy has
              // seven writers (pg_proc, live) and only trust_apply_level is
              // downstream of a trust level — an archetype carrying
              // `autonomy_templates` gets an ENABLED dial written at HIRE, so a
              // level-0 employee can already be acting on its own. The
              // enumeration and the live corroboration are on the card copy in
              // src/lib/discoveryProposalPresentation.ts. The flash now claims
              // only what this accept controls.
              : p.kind === 'trust_rule'
                ? `${title} — written down. Nothing changes today: this records the limit and switches nothing on, and you'll find the setting under its Trust settings at level 0${outcome.enforcesToday === false ? ', switched off' : ''}. Moving it off level 0 is a separate decision, and nothing here makes it for you.`
              // ⚠ 754: THE FOURTH KIND TO JOIN THIS CHAIN, and the first one
              // that had to be ADDED rather than adjusted. Until this arm
              // existed a conversation topic fell through to the CONNECTOR
              // sentence below and was told "set up and waiting for your
              // credential … under Systems" — three things wrong at once:
              // there is no credential, there is no second gate at all, and the
              // rule is not under Systems.
              // What the accept really does is INSERT a row into
              // support_triage_rules under RLS (createTriageRuleFromProposal),
              // and classify_support_text reads EVERY active rule in the
              // workspace on the first user message of every support
              // conversation — so the rule is labelling traffic before this
              // sentence has finished rendering. That makes it a guardrail-shaped
              // card, not a connector-shaped one: 751's rule applies, and the
              // sentence has to say it is live and where the off switch is.
              // ⚠ LABELLED, NEVER ROUTED. de_conversations.de_id is stamped at
              // INSERT by widget-ask and email-inbound, before the first message
              // exists, and no reader of `category` picks an employee — which is
              // the promise the OLD version of this card made and 754 removed.
              // ⚠ AND THE ORDER, because it is the one thing that bounds the
              // change: an accepted topic lands in the 200..9998 band, behind
              // every built-in category, so Safety (10) and Security (20) still
              // win where the words overlap. Probe 18(c3) drives that collision.
              : p.kind === 'conversation_type'
                ? (outcome.reusedExisting
                  ? `${title} — you already had exactly this topic, so nothing new was created. It is switched on and filing conversations under "${topicAcceptability(p.payload).category}", and it is under Support › Triage rules.`
                  : `${title} — switched on now. From this moment a new conversation whose first message uses those words is filed under "${topicAcceptability(p.payload).category}"; your built-in categories like Safety and Security still come first. ${outcome.routesToEmployee ? `${outcome.ownerName || 'The person on that card'} takes these over as soon as they are live in your workspace — nothing about who answers changes before that, and conversations already open keep the person they have.` : 'Whoever usually answers still answers them.'} You can reword it, hand it to someone or take it off under Support › Triage rules.`)
              // ⚠ TWO different true things, not one convenient one. An accept
              // that RE-USED a connector the workspace already had inserted
              // nothing — telling that person to go and enter a credential sends
              // them to fix a system that is very possibly already connected and
              // working. acceptProposal reports which branch it took.
              : outcome.reusedExisting
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
    //
    // ⚠⚠ 752: AND IT WAS ABOUT TO BE FALSE ABOUT AN ENTIRE BATCH. This sentence
    // was written when `connector` was the only kind in an accept-all section;
    // `procedure` joins that section the moment it becomes decidable
    // (batchModeFor returns 'accept_all' for anything outside NEVER_BATCH and
    // DEPARTMENT_BATCH), and a procedure has no credential and never will. The
    // batch is always ONE kind — renderAcceptAllSection is per-kind and
    // itemsForBatchMode filters to it — so the noun comes off the batch rather
    // than being assumed.
    //
    // ⚠⚠⚠ 754: AND IT WAS ABOUT TO BE FALSE ABOUT AN ENTIRE BATCH AGAIN, in the
    // one kind that arrives ten at a time. batchModeFor('conversation_type')
    // is 'accept_all', so ten accepted topics replayed the connector sentence
    // verbatim — "10 set up, each waiting for your credential" — about ten
    // triage rules that are live, have no credential and are not under Systems.
    // The mode is right (ten cards is exactly what it is for); the noun was not.
    const batchKind = targets[0]?.kind;
    const outcomeNoun = batchKind === 'procedure' ? 'drafted'
      : batchKind === 'conversation_type' ? 'switched on'
      : 'set up';
    const outcomeTail = batchKind === 'procedure'
      ? ', each a draft under Playbooks that runs nothing until you publish it'
      : batchKind === 'conversation_type'
        ? ', each filing new conversations under its own topic from now on — they are under Support › Triage rules, where you can reword or remove any of them'
        : ', each waiting for your credential';
    const alreadyHad = batchKind === 'procedure'
      ? 'you already had every one of them drafted, so nothing new was written'
      : batchKind === 'conversation_type'
        ? 'you already had every one of them, so nothing new was created — and every one of them is still switched on'
        : 'you already had every one of them, so nothing new was created';
    const newlyCreated = accepted - reused;
    const setUpPhrase = accepted === 0
      ? `Nothing was ${outcomeNoun}.`
      : reused === 0
        ? `${accepted} ${outcomeNoun}${outcomeTail}.`
        : newlyCreated === 0
          ? `${accepted} accepted — ${alreadyHad}.`
          : `${newlyCreated} ${outcomeNoun}${outcomeTail}; ${reused} you already had, so nothing new was ${batchKind === 'procedure' ? 'written' : 'created'} for those.`;
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
    // ⚠ THE FOURTH ARGUMENT IS THE CONSENT, and it is here rather than only in
    // the Drawer because Accept is here. See cardCopyFor's own note.
    const copy = cardCopyFor(p.kind, p.payload, employeeNameByArchetype, acceptContextFor(p));
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
            {/* ⚠ NOT AN UNCONDITIONAL runDecision ANY MORE. This fired on one
                click, with no confirmation, for a decision that hires an
                employee AND switches on workspace-wide BLOCKING rules — while
                Decline and Park, which create nothing, both stopped to ask for
                a sentence. needsAcceptConfirmation is the single gate: it is
                true only when this accept adds compliance rules the workspace
                does not already have, or when we could not establish whether it
                does. Everything else still goes straight through, because a
                confirmation on every accept is one nobody reads. */}
            <Button kind="primary" size="sm" disabled={working}
              onClick={() => {
                if (needsAcceptConfirmation(p.kind, acceptContextFor(p))) setAcceptTarget(p);
                else void runDecision(p, 'accepted', null);
              }}>
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
        {/* ⚠ PER KIND, and read from the presentation module rather than
            written here. The literal that used to sit inline promised "the real
            consent step comes later" for every kind in this section — true of a
            connector's credential and a procedure's publish, and false of a
            conversation topic, which is live the instant it lands. See
            acceptAllSectionBlurb's own header. */}
        <p className="text-xs text-dt-muted mb-3">{acceptAllSectionBlurb(kind)}</p>
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
          <Banner tone="neutral">{anyDecidable ? partlyLiveExplanation() : NOTHING_LIVE_EXPLANATION}</Banner>

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

      {/* ⚠ THE ONE THING THIS WHOLE MIGRATION EXISTS FOR, PUT WHERE THE DECISION
          IS TAKEN. The pack disclosure used to render only inside the Drawer,
          behind a "Details" button, while Accept sat on the card and fired
          immediately — so the ordinary path through this screen was: read a
          job title, click Accept, and have two blocking rules start applying to
          every employee in the workspace, with the sentence explaining that
          never rendered on screen at all. Measured: 4 of 18 workspaces held a
          pack, so 14 were exposed on their first such hire.

          It asks ONLY when there is something new to disclose (see
          needsAcceptConfirmation), and it shows the SAME sentence the drawer
          shows, from the same function and the same context object, so the two
          cannot drift. The Cancel is the real default: a person who opened this
          by accident loses nothing by closing it. */}
      {acceptTarget && (
        <Modal
          size="md"
          title="This hire also switches on compliance rules"
          onClose={() => setAcceptTarget(null)}
        >
          <div className="space-y-3">
            <p className="text-sm text-dt-body leading-relaxed">
              {cardCopyFor(acceptTarget.kind, acceptTarget.payload, employeeNameByArchetype, acceptContextFor(acceptTarget)).title}
            </p>
            <p className="text-sm text-dt-support leading-relaxed">
              {whatAcceptingWrites(acceptTarget.kind, acceptTarget.payload, acceptContextFor(acceptTarget))}
            </p>
            {/* The rules themselves are not on the payload and are not fetched
                here — the pack's rule TEXT lives on the Compliance page, which
                this names rather than paraphrases. Naming the pack and counting
                its rules is what the customer needs to decide; reading them is
                one link away and always available afterwards. */}
            <p className="text-xs text-dt-muted leading-relaxed">
              You can see exactly what a pack blocks, and take it back off, under Compliance &amp; Guardrails.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 mt-5">
            <Button kind="ghost" size="sm" onClick={() => setAcceptTarget(null)}>Cancel</Button>
            <Button
              kind="primary"
              size="sm"
              onClick={() => {
                const target = acceptTarget;
                setAcceptTarget(null);
                void runDecision(target, 'accepted', null);
              }}
            >
              Hire them
            </Button>
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
              {/* ⚠ THE THIRD ARGUMENT IS THE CONSENT. For an employee, this is
                  where the drawer names the compliance pack the hire switches on
                  and how many BLOCKING, workspace-wide rules that is. Passing
                  `undefined` while the lookup is still in flight is deliberate:
                  the sentence then says it has not been checked, rather than
                  implying there is nothing to check.
                  ⚠ AND IT IS NO LONGER THE ONLY PLACE THIS RENDERS. The same
                  context object, from the same builder, now reaches the card
                  face and the accept confirmation — this drawer used to be the
                  only one, which meant the disclosure was optional reading for
                  a decision that was one click away. */}
              <p className="text-dt-support">
                {whatAcceptingWrites(openProposal.kind, openProposal.payload, acceptContextFor(openProposal))}
              </p>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
