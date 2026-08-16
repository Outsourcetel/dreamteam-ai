// discoveryApi.ts — data layer for the discovery proposal screen
// (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation, Tasks 2-3).
//
// Reads discovery_sessions, discovery_proposals, discovery_dimensions and
// discovery_capability_gaps (migrations 733-737, plus 740's last_error /
// last_error_at / attempts).
//
// WRITES two kinds: 'connector' through Path B, and — since migration 746 —
// 'employee' through Path A. Every other kind is still read-only here.
// ACCEPT_WRITERS below is the ONE table that says so: isDecidableKind asks
// whether a kind has an entry and acceptProposal runs the entry it finds, so a
// kind gains Accept, Decline and Park together or gains none of them. It
// carries the named reason each of the other four is not wired.
//
// ── PATH A, and why 'employee' has no browser half ───────────────────────
// The contract (task-3-contract.md §0/§4.4) splits the six kinds by whether
// their ordinary writer is reachable from SQL. 'employee' is: it is
// instantiate_role_archetype + install_role_kit + install_role_systems, all
// three of them Postgres functions, and `authenticated` holds only SELECT on
// digital_employees — so the browser could not insert the row even if it
// wanted to. decide_discovery_proposal therefore hires the employee ITSELF, in
// ONE transaction, and the client's job is a single call with a null object id.
//
// That is strictly better than the ordinary hire path, which is three RPCs in
// three transactions (hireApi.ts:104-149) and has already stranded half-hired
// employees; there is no window here in which an employee exists without its
// watchers, its SOP and its guardrails.
//
// ── PATH B, and why the browser does the writing ─────────────────────────
// The contract (task-3-contract.md §0) settles that "one RPC that calls the
// ordinary writer" is unsatisfiable: three of six kinds have no SQL writer at
// all. 'connector' is one of them — its ordinary writer is connectProvider in
// src/lib/connectorApi.ts, a PostgREST insert made by the signed-in human
// under RLS. So the sequence is split, exactly as the shipped precedent at
// src/lib/governanceAiApi.ts:111-153 (approveProposal) does it:
//
//   1. the browser creates the object through the ordinary writer, AS the
//      signed-in human, under RLS;
//   2. the browser calls decide_discovery_proposal(id, 'accepted', note,
//      <the id step 1 produced>) to stamp the proposal and link what it made.
//
// Inlining `insert into connectors` inside the SECURITY DEFINER RPC would be
// a second creation engine that bypasses the RLS the human path depends on
// (contract §8.3), which is why the split exists rather than being tidied
// away.
//
// ⚠ Never reads or writes a digital_employees row FROM THE BROWSER. The
// employee accept creates one, but it does so entirely inside
// decide_discovery_proposal: nothing in this file selects, inserts or updates
// that table, and instantiate_role_archetype does not set
// is_workforce_assistant (live body), so the row it makes takes the column's
// default of false. The Workspace Assistant stays out of reach on both sides.
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import { connectProvider, PROVIDERS } from './connectorApi';
import type { ConnectorProvider } from './connectorApi';
import { CATEGORIES } from './categoryContracts';
import type { SystemCategory } from './categoryContracts';
import { KIND_LABELS, PROPOSAL_KINDS } from './discoveryProposalPresentation';
import type { AcceptCompliancePack, ProposalKind, ProposalState } from './discoveryProposalPresentation';

export type { ProposalKind, ProposalState };

export interface DiscoveryProposal {
  id: string;
  session_id: string;
  tenant_id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  rationale: string | null;
  source_dimension: string | null;
  state: ProposalState;
  decided_by: string | null;
  decided_at: string | null;
  created_object_id: string | null;
  created_at: string;
  /** Migration 740. Why the last accept did not become a thing. This column
   *  is the entire reason Task 3 Step 3 is possible: before it, the table had
   *  12 columns and nowhere to put a refusal reason, so a writer that said no
   *  left the card sitting at 'pending' explaining nothing. The RPC writes it
   *  on the way back to 'pending'; the screen reads it back onto the card. */
  last_error: string | null;
  last_error_at: string | null;
  /** Bumped by the RPC each time an accept was tried and refused. */
  attempts: number;
}

export interface DiscoveryCoverageEntry {
  state: 'heard' | 'parked' | 'skipped' | 'not_heard';
  evidence: string | null;
  recorded_at?: string;
}

export interface DiscoverySession {
  id: string;
  tenant_id: string;
  status: 'running' | 'proposed' | 'accepted' | 'parked' | 'abandoned';
  coverage: Record<string, DiscoveryCoverageEntry>;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryDimension {
  key: string;
  title: string;
  ordinal: number;
}

export interface DiscoveryCapabilityGap {
  dimension_key: string;
  title: string;
  serves_archetypes: string[];
  planned_archetypes: string[];
  customer_message: string;
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) {
    throw new CustomerApiError(
      'This is a live-workspace screen — sign into your live workspace to see setup recommendations. (Demo companies have no discovery session to review.)',
      false,
    );
  }
  return tid;
}

/** The most recently-touched discovery session for this tenant that has at
 *  least one proposal. Deliberately NOT filtered by session status: natural
 *  completion inside discovery-interview/index.ts's 'answer' action never
 *  flips discovery_sessions.status off 'running' (only the caller-stops
 *  'end' action does, into 'parked'/'abandoned') — so "status = proposed"
 *  would silently miss the common case. "Has a proposal at all" is the only
 *  signal that is actually true today. */
export async function getLatestSessionWithProposals(): Promise<DiscoverySession | null> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_proposals')
    .select('session_id, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  const sessionId = data && data.length > 0 ? (data[0].session_id as string) : null;
  if (!sessionId) return null;
  return getDiscoverySession(sessionId);
}

export async function getDiscoverySession(sessionId: string): Promise<DiscoverySession | null> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_sessions')
    .select('id, tenant_id, status, coverage, created_at, updated_at')
    .eq('id', sessionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data as DiscoverySession | null) ?? null;
}

export async function listDiscoveryProposals(sessionId: string): Promise<DiscoveryProposal[]> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_proposals')
    .select('id, session_id, tenant_id, kind, payload, rationale, source_dimension, state, decided_by, decided_at, created_object_id, created_at, last_error, last_error_at, attempts')
    .eq('tenant_id', tenantId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryProposal[];
}

/** discovery_dimensions has no tenant scoping — it's the shared spine, read
 *  by every workspace alike (migration 733's own RLS: `for select to
 *  authenticated using (true)`). Used only to turn a proposal's
 *  source_dimension key into the title shown in its Drawer. */
export async function listDiscoveryDimensions(): Promise<DiscoveryDimension[]> {
  const { data, error } = await supabase
    .from('discovery_dimensions')
    .select('key, title, ordinal')
    .order('ordinal', { ascending: true });
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryDimension[];
}

/** discovery_capability_gaps is a platform-wide VIEW (migration 734), not
 *  tenant data — every dimension carrying a planned_ archetype appears
 *  regardless of who is looking. Narrowed here to the dimensions THIS
 *  session actually marked 'heard', so the banner only ever states what
 *  this customer was actually told, not the platform's full unstaffed list. */
export async function listCapabilityGapsForHeardDimensions(heardKeys: readonly string[]): Promise<DiscoveryCapabilityGap[]> {
  if (heardKeys.length === 0) return [];
  const { data, error } = await supabase
    .from('discovery_capability_gaps')
    .select('dimension_key, title, serves_archetypes, planned_archetypes, customer_message')
    .in('dimension_key', heardKeys);
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryCapabilityGap[];
}

// ══ DECIDING ══════════════════════════════════════════════════════════════

export type DiscoveryDecision = 'accepted' | 'declined' | 'parked';

/** The result of a decision attempt.
 *
 *  ⚠ These functions RETURN a refusal rather than throwing it, which is a
 *  deliberate departure from approveProposal's `throw new Error(friendly(…))`.
 *  Two reasons, both structural. First, the screen has to attach a reason to
 *  ONE card among many — a thrown error loses which proposal it was about.
 *  Second, the batch accept decides several proposals in a row; an exception
 *  would abandon the rest of the batch on the first refusal and leave the
 *  person unable to tell which ones went through. A refusal here is an
 *  ordinary outcome with a reason attached, not an exception. */
export interface DecisionOutcome {
  ok: boolean;
  /** The state the proposal is in NOW, as the server reports it — which on a
   *  refusal is 'pending', not the decision that was asked for. */
  state?: ProposalState;
  /** Always set when ok is false. Plain language, already friendly. */
  error?: string;
  createdObjectId?: string | null;
  /** The RPC's machine-readable refusal code, verbatim and untranslated —
   *  today only 'already_decided'. Branch on THIS, never on the sentence: the
   *  sentence is written for a person and will be rewritten for a person, and
   *  a branch that greps it silently changes meaning when someone improves the
   *  wording. Absent when the refusal came from PostgREST rather than from the
   *  function body (a missing RPC, an RLS raise), because there is no code to
   *  report and inventing one would make a transport failure look like a
   *  decision. */
  code?: string;
  /** ACCEPT ONLY, and only when ok is true: the object this accept linked
   *  ALREADY EXISTED and nothing was inserted.
   *
   *  ⚠ Without this, `ok: true` covers two structurally different outcomes —
   *  "we created a connector, go and credential it" and "you already had this
   *  one, we touched nothing" — and the screen told both of them to go and
   *  enter a credential. A workspace with Zendesk already connected and
   *  working was sent to fix something that needed nothing. The find-then-
   *  insert in acceptConnectorProposal has always known which branch it took;
   *  it just had nowhere to say so on the success side.
   *
   *  ⚠ NOT yet carried into the audit event. decide_discovery_proposal's
   *  signature is (uuid, text, text, uuid) — there is no parameter for it, so
   *  the audit detail still names an object without recording that the object
   *  predates the decision. That is a real remaining gap in contract §6's
   *  reconstruction requirement, and it needs a 5th defaulted parameter on the
   *  RPC; see the ADDENDUM in task-3-contract.md. Do not fake it by writing it
   *  into p_note — the note is the customer's sentence, not a flag channel. */
  reusedExisting?: boolean;
  /** ACCEPT ONLY, and only for kinds the RPC creates itself (today: employee).
   *
   *  ⚠ A SILENT ZERO IS THE DEFECT THESE EXIST TO END. The hire wizard prints
   *  "0 connected systems" identically for "this archetype has none" and "the
   *  systems step refused", and there is no way from the outside to tell which
   *  happened. Migration 746 makes decide_discovery_proposal return
   *  systems_installed and watchers_skipped from install_role_systems' and
   *  install_role_kit's own return values, and writes the same two numbers into
   *  the audit detail — so the screen can say "it could not be connected to any
   *  of your systems" instead of saying nothing, and a person can check the
   *  sentence against the ledger.
   *
   *  `undefined` for kinds that do not report them (connector), which is
   *  different from 0 and must stay different: `?? 0` here would manufacture a
   *  fact about a connector accept. */
  systemsInstalled?: number;
  watchersSkipped?: number;
  /** ACCEPT ONLY, employee kind, migration 747.
   *
   *  ⚠ A HIRE CAN SWITCH ON WORKSPACE-WIDE BLOCKING RULES AND USED TO SAY
   *  NOTHING. instantiate_role_archetype attaches the archetype's mandatory
   *  compliance packs, materialising guardrail_rules with applies_to='all' and
   *  severity='blocking'. Those rows appeared in no counter, no audit detail
   *  and on no card — `guardrails_created` is install_role_kit's
   *  EMPLOYEE-SCOPED count and never included them.
   *
   *  THREE numbers rather than one, for the reason systemsInstalled has its own
   *  paragraph above: `created: 0` and "this workspace enforces no compliance
   *  rules at all" are opposite facts that read identically as a bare zero.
   *  `inForce` is what separates them, and `packs` names WHICH controls, since
   *  a rule the customer cannot name is a rule they cannot consent to.
   *
   *  `undefined` for every other kind — never `?? 0`. */
  compliancePacksAttached?: string[];
  complianceRulesCreated?: number;
  complianceRulesInForce?: number;
}

/** One kind's accept writer: its ordinary validated writer, wrapped to return
 *  a DecisionOutcome. Decline and Park need no per-kind writer — they create
 *  nothing by definition and go straight to the RPC. */
type AcceptWriter = (proposal: DiscoveryProposal, note: string | null) => Promise<DecisionOutcome>;

/** ⚠ THE SINGLE TABLE — which kinds this screen can decide, and for each one
 *  the writer its Accept runs. A kind gains Accept, Decline and Park together
 *  or gains none of them.
 *
 *  It is one table because it used to be two facts that could disagree.
 *  `isDecidableKind` was documented in two places as "the ONLY gate", and it
 *  was not: DiscoveryProposalsPage hardcoded `decision === 'accepted' ? await
 *  acceptConnectorProposal(p, note) : …` in its per-card handler AND called
 *  acceptConnectorProposal directly again in its batch accept. So the gate
 *  admitted a kind and the writer was chosen somewhere else entirely.
 *
 *  What that cost, concretely. Contract §9 tells the next implementer to ship
 *  'guardrail' next. Following the comment and adding `|| kind === 'guardrail'`
 *  to the gate would have shipped Decline and Park for guardrails THE SAME
 *  MINUTE — writing real terminal state, a real decided_by and real audit
 *  events through a path nobody built, because migration 741's role bar and
 *  compare-and-swap are kind-agnostic and only its accept arm switches on
 *  kind. Accept would meanwhile have routed a guardrail into the connector
 *  writer and answered with a sentence about systems to connect.
 *
 *  Adding a kind here now means writing its accept writer in the same edit.
 *  There is no way left to half-open a kind. */
const ACCEPT_WRITERS: Partial<Record<ProposalKind, AcceptWriter>> = {
  // An arrow, not a bare reference: the writer is declared further down this
  // file and the indirection resolves at call time, so the table can sit next
  // to the gate it feeds instead of at the bottom of the module.
  connector: (proposal, note) => acceptConnectorProposal(proposal, note),
  employee: (proposal, note) => acceptEmployeeProposal(proposal, note),
};

/** The kinds this screen can decide, derived from the ONE table above and
 *  never written out a second time.
 *
 *  ⚠ It exists because the page's banner used to name them in prose —
 *  "Systems to connect are ready to decide. The rest of these are still just
 *  for reading" — and that sentence became false the minute a second kind was
 *  wired, in a file that says of itself "when that banner and isDecidableKind
 *  disagree, the banner is the lie". A sentence built from the table cannot
 *  disagree with the table. */
export function decidableKinds(): ProposalKind[] {
  return PROPOSAL_KINDS.filter((k) => acceptWriterFor(k) !== null);
}

/** ...and the same list as something a person reads, in the screen's own
 *  words. Oxford-comma-free plain English, lower-cased from KIND_LABELS so the
 *  label and the button can never drift apart either. */
export function decidableKindsSentence(): string {
  const labels = decidableKinds().map((k) => KIND_LABELS[k].toLowerCase());
  if (labels.length === 0) return 'nothing';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The one lookup. isDecidableKind and acceptProposal both go through it, so
 *  "can this be decided?" and "what writes it?" are answered by the same
 *  expression rather than by two that happen to agree today. */
function acceptWriterFor(kind: ProposalKind): AcceptWriter | null {
  return ACCEPT_WRITERS[kind] ?? null;
}

/** Which kinds this screen can actually decide today — derived from
 *  ACCEPT_WRITERS, never a list of its own.
 *
 *  'connector' and 'employee' — deliberately, and each omission has a named
 *  reason:
 *   - 'guardrail'  — Path B, next in the contract's risk order (§9 #2); the
 *                    accept path is not written yet, and BLOCKER 3 restricts
 *                    it to pattern-bearing rules when it is.
 *   - 'procedure'  — Path B via the playbook-draft edge function; not written.
 *   - 'trust_rule' — Path A, last by the contract's own ordering, and blocked
 *                    on BLOCKER 4: 90 trust_policies rows exist with 0 ladders
 *                    and 0 above level 0, so accepting one today writes a
 *                    policy nothing consults while the card says a human has
 *                    been taken out of the loop.
 *   - 'conversation_type' — no table and no writer (to_regclass(
 *                    'public.conversation_types') is null), and nothing routes
 *                    on it today. A topic axis DOES exist and is live
 *                    (de_conversations.category, driven by
 *                    support_triage_rules), and the founder's ruling of
 *                    2026-08-15 is that the interview will eventually write
 *                    REAL triage rules rather than a label. That is a separate
 *                    task with its own writer. Until it lands, an accept path
 *                    here could only be a no-op — the exact "looks governed and
 *                    is not" artefact this whole step exists to prevent.
 *
 *  A kind that is not here keeps its controls switched off on the screen,
 *  rather than offering a button that quietly does nothing. */
export function isDecidableKind(kind: ProposalKind): boolean {
  return acceptWriterFor(kind) !== null;
}

/** Accept a proposal of ANY decidable kind, by looking its writer up in the
 *  table above. The screen calls THIS; it must never name a writer itself,
 *  which is how the second, uncounted path got there in the first place.
 *
 *  A kind with no writer is refused here rather than falling into whichever
 *  writer happens to be first — the refusal is the honest outcome, and it can
 *  only be reached if something upstream let a control through that
 *  isDecidableKind had already switched off. */
export async function acceptProposal(
  proposal: DiscoveryProposal,
  note: string | null,
): Promise<DecisionOutcome> {
  const writer = acceptWriterFor(proposal.kind);
  if (!writer) {
    // ⚠ The list of what IS switched on is read from the table, not typed out.
    // This sentence used to end "only systems to connect are", which stopped
    // being true the moment employee was wired — in the function whose whole
    // job is to be the single source of that answer.
    return {
      ok: false,
      error: `Accepting a "${proposal.kind}" recommendation is not switched on yet — ${decidableKindsSentence()} are. Nothing was changed.`,
    };
  }
  return writer(proposal, note);
}

/** Turn a raw Postgres / PostgREST message into something a business owner
 *  can act on. Same shape and intent as governanceAiApi.ts's `friendly`. */
function friendlyDecisionError(raw: string, attempted?: DiscoveryDecision, state?: string | null): string {
  if (raw.includes('already_decided')) {
    // ⚠ Parking something already parked is not somebody else deciding it.
    // Migration 741's compare-and-swap admits 'parked' so a parked proposal
    // stays decidable, and refuses only the redundant re-park — which is a
    // double-click, not a conflict. Telling that person "somebody already
    // decided this one" describes an event that did not happen and sends them
    // to reload a page that will look exactly the same.
    if (attempted === 'parked' && state === 'parked') {
      return 'This one is already set aside — it is waiting under "Set aside for later" whenever you want to pick it up.';
    }
    return 'Somebody already decided this one. Reload the page to see where it landed.';
  }
  if (raw.includes('only workspace owners and admins')) {
    return 'Only a workspace owner or admin can decide a setup recommendation.';
  }
  if (raw.includes('unknown discovery proposal')) {
    return 'That recommendation is no longer there — it may have been cleared while this page was open.';
  }
  // PostgREST's PGRST202 when the function is absent from the schema cache.
  // True today by construction: migration 741 is claimed but not yet applied,
  // so this is the message a person would actually meet, and it should not
  // read like a crash.
  if (raw.includes('Could not find the function') || raw.includes('schema cache')) {
    return 'Deciding is not switched on in this workspace yet — the step that records your decision has not been installed. Nothing was changed.';
  }
  if (raw.includes('row-level security') || raw.includes('violates row-level')) {
    return 'Your workspace role does not allow adding a system. Nothing was changed.';
  }
  // ── the two refusals the employee accept can meet ────────────────────────
  // ⚠ HONEST ABOUT WHAT THIS FIXES AND WHAT IT DOES NOT. These translate the
  // IN-SESSION message only. When the RPC's Zone-3 sub-block refuses, it also
  // writes the RAW sqlerrm into discovery_proposals.last_error, and the card
  // reads THAT back on the next load (errorFor in DiscoveryProposalsPage) — so
  // a person who reloads still sees `unknown archetype renewal_manager`. Fixing
  // that properly means the RPC phrasing its own refusals, which is why the two
  // it CAN phrase (no archetype_key, no name) are written in words there rather
  // than left to a NOT NULL violation.
  if (raw.includes('unknown archetype')) {
    return 'The role this recommendation wanted to hire is no longer available to hire, so nobody was created. Nothing else was changed.';
  }
  if (raw.includes('kind not yet routable')) {
    return 'Accepting this kind of recommendation is not switched on yet, so nothing was created. It is still waiting for a decision.';
  }
  return raw;
}

/** Drop a trailing "Nothing was changed." from a refusal sentence.
 *
 *  ⚠ That clause is TRUE for the refusals friendlyDecisionError names — a
 *  missing RPC, an RLS raise — whenever nothing else has run, which is every
 *  Decline and every Park. It is FALSE on the accept half of Path B, where the
 *  browser has already created or found the connector before the RPC was
 *  called at all. So it is kept where it is true and removed where it is not,
 *  instead of being deleted from the vocabulary or left to contradict the
 *  sentence beside it. */
function stripNothingChanged(raw: string): string {
  return raw.replace(/\s*Nothing was changed\.?\s*$/i, '').trim();
}

/**
 * Stamp a decision onto a proposal. On Path B, `createdObjectId` is the id of
 * the object the browser has ALREADY created through the ordinary writer.
 *
 * ⚠ No client-side "is it still pending?" pre-check, on purpose. That would be
 * check-then-act, and both of two concurrent clicks pass it. The RPC's
 * compare-and-swap IS the double-click guard; the second caller matches zero
 * rows and comes back 'already_decided'. Adding a pre-check here would not help
 * and would make the real guard look optional.
 *
 * ⚠ The predicate is NOT `where state = 'pending'`, which is what this comment
 * used to say and what a reader would otherwise assume. Migration 741 widened
 * it to:
 *
 *     where state in ('pending','parked')
 *       and not (state = 'parked' and p_decision = 'parked')
 *
 * because park is a PAUSE — a parked proposal has to stay decidable or the
 * "you can come back to it" promise is a lie — while a second identical park
 * is a double-click and must not write a second audit row. Believing the
 * narrower predicate is exactly the mistake that makes the Set-aside section
 * look impossible.
 */
export async function decideDiscoveryProposal(
  proposalId: string,
  decision: DiscoveryDecision,
  note: string | null,
  createdObjectId: string | null,
): Promise<DecisionOutcome> {
  const { data, error } = await supabase.rpc('decide_discovery_proposal', {
    p_proposal_id: proposalId,
    p_decision: decision,
    p_note: note && note.trim() ? note.trim() : null,
    p_created_object_id: createdObjectId,
  });

  // ⚠ BOTH halves have to be read, and each catches a different failure.
  //   `error`   — .rpc() RESOLVES on a Postgres error; the promise does not
  //               reject, so a missing `if (error)` swallows every RAISE in
  //               the function (the role bar, the unknown-proposal refusal).
  //   `data.ok` — the RPC returns jsonb precisely so this is answerable. Had
  //               it returned a composite, PostgREST would serialise a NULL
  //               one as a row of all-NULL columns and `if (!data)` could
  //               never fire — the defect that logged one human's approval
  //               three times in 37 seconds.
  if (error) return { ok: false, error: friendlyDecisionError(error.message) };

  const res = (data ?? null) as
    | {
        ok?: boolean; state?: ProposalState; error?: string;
        created_object_id?: string | null;
        // Migration 746, employee accepts only. Absent for every other kind.
        systems_installed?: number; watchers_skipped?: number;
        // Migration 747, employee accepts only. Same rule: absent stays absent.
        compliance_packs_attached?: string[];
        compliance_rules_created?: number;
        compliance_rules_in_force?: number;
      }
    | null;

  // `!== true` rather than `=== false`: an absent or reshaped `ok` is a
  // refusal we cannot read, and treating it as success is how a proposal ends
  // up looking decided when nothing happened.
  if (!res || res.ok !== true) {
    return {
      ok: false,
      state: res?.state,
      // The RAW code alongside the friendly sentence. Callers that need to
      // know WHICH refusal this was (acceptConnectorProposal has to say
      // different true things about the connector it just made depending on
      // whether the proposal was already decided) branch on this, so nobody
      // has to grep the customer-facing wording to find out.
      code: res?.error ?? undefined,
      // `decision` and `res.state` are both passed so the already_decided
      // sentence can tell a genuine conflict apart from a re-park.
      error: friendlyDecisionError(
        res?.error ?? 'That decision was not recorded, and the workspace did not say why.',
        decision,
        res?.state ?? null,
      ),
    };
  }
  // ⚠ `typeof … === 'number'`, never `?? 0`. A connector accept does not report
  // these at all, and a defaulted 0 would tell a person their connector reached
  // zero systems — a fact nobody measured. Absent stays absent.
  return {
    ok: true,
    state: res.state,
    createdObjectId: res.created_object_id ?? null,
    systemsInstalled: typeof res.systems_installed === 'number' ? res.systems_installed : undefined,
    watchersSkipped: typeof res.watchers_skipped === 'number' ? res.watchers_skipped : undefined,
    compliancePacksAttached: Array.isArray(res.compliance_packs_attached)
      ? res.compliance_packs_attached.map(String)
      : undefined,
    complianceRulesCreated: typeof res.compliance_rules_created === 'number' ? res.compliance_rules_created : undefined,
    complianceRulesInForce: typeof res.compliance_rules_in_force === 'number' ? res.compliance_rules_in_force : undefined,
  };
}

/**
 * Which compliance packs each of these archetypes would switch on, and whether
 * this workspace already holds them.
 *
 * ⚠ WHY THE CARD NEEDS THIS AT ALL. The proposal payload carries an
 * archetype_key and nothing else about compliance, so the drawer cannot say
 * what accepting attaches without looking it up. Until it did, accepting an
 * `accounting`, `billing_ar`, `fpa`, `bdr`, `google_ads`, `marketing` or `sdr`
 * recommendation silently switched on two BLOCKING rules that apply to every
 * employee in the workspace — measured live, 7 of 15 active archetypes.
 *
 * ⚠ `already_attached` IS NOT DECORATION. It is the difference between "this
 * adds two blocking rules" and "this adds none, you already have them", and
 * getting it wrong in either direction is an overclaim on a consent screen.
 * tenant_compliance_packs is RLS-scoped to the reader's own workspace, so this
 * needs no tenant parameter — and passing one would be the tenant-id-as-
 * authorisation shape migrations 662-664 exist to stop.
 *
 * Every table read here is SELECT-able by `authenticated`: role_archetypes,
 * compliance_packs and compliance_pack_rules are shared catalogues (RLS
 * `auth.uid() is not null`), tenant_compliance_packs is member-scoped.
 *
 * Returns an EMPTY MAP on any read failure rather than throwing: the drawer
 * treats "no entry" as not-established and says so, which is honest, whereas a
 * throw would take the proposals page down over a decorative sentence.
 */
export async function listCompliancePacksForArchetypes(
  archetypeKeys: readonly string[],
): Promise<Map<string, AcceptCompliancePack[]>> {
  const out = new Map<string, AcceptCompliancePack[]>();
  const keys = Array.from(new Set(archetypeKeys.filter(Boolean)));
  if (keys.length === 0) return out;

  const [archRes, packRes, ruleRes, mineRes] = await Promise.all([
    supabase.from('role_archetypes').select('key, compliance_pack_keys').in('key', keys),
    supabase.from('compliance_packs').select('key, name'),
    supabase.from('compliance_pack_rules').select('pack_key'),
    supabase.from('tenant_compliance_packs').select('pack_key'),
  ]);
  if (archRes.error || packRes.error || ruleRes.error) return out;

  const nameOf = new Map<string, string>();
  for (const p of (packRes.data ?? []) as { key: string; name: string }[]) nameOf.set(p.key, p.name);

  const ruleCount = new Map<string, number>();
  for (const r of (ruleRes.data ?? []) as { pack_key: string }[]) {
    ruleCount.set(r.pack_key, (ruleCount.get(r.pack_key) ?? 0) + 1);
  }

  // ⚠ A FAILED READ IS NOT "NOT ATTACHED". If the member-scoped read errored we
  // cannot tell, and defaulting to false would claim the accept adds rules it
  // may not. Reporting nothing at all makes the card say "not checked yet",
  // which is the true statement.
  if (mineRes.error) return out;
  const mine = new Set(((mineRes.data ?? []) as { pack_key: string }[]).map((r) => r.pack_key));

  for (const a of (archRes.data ?? []) as { key: string; compliance_pack_keys: string[] | null }[]) {
    out.set(a.key, (a.compliance_pack_keys ?? []).map((pk) => ({
      pack_key: pk,
      name: nameOf.get(pk) ?? pk,
      rule_count: ruleCount.get(pk) ?? 0,
      already_attached: mine.has(pk),
    })));
  }
  return out;
}

/**
 * Accept an 'employee' proposal — the whole of Path A, which is one call.
 *
 * There is no browser half. `authenticated` holds only SELECT on
 * digital_employees, so the client could not create the row under RLS even if
 * the split-path shape were wanted here; and the three ordinary writers
 * (instantiate_role_archetype, install_role_kit, install_role_systems) are all
 * Postgres functions, so decide_discovery_proposal calls them itself inside a
 * single transaction. `createdObjectId` is passed as NULL deliberately: the RPC
 * refuses to be told what it created, and returns the id it made.
 *
 * ⚠ NO CLIENT-SIDE PRE-CHECKS. The payload's archetype_key and name are
 * validated inside the RPC, in words, before anything is written — and
 * instantiate_role_archetype refuses an unknown or non-active archetype on its
 * own. Re-implementing either here would be a second validator that can
 * disagree with the one that actually guards the write, which is the shape the
 * connector writer's own header warns about.
 *
 * ⚠ NO "have we already hired this archetype?" LOOKUP either, and that is a
 * deliberate difference from acceptConnectorProposal's find-then-insert. Path B
 * needs one because the browser writes first and stamps second, so a crash
 * between the two leaves an orphan. Here the create and the stamp are the same
 * transaction: the compare-and-swap's row lock is held to COMMIT, so an
 * employee cannot exist without the proposal that made it being decided. A
 * second click gets `already_decided` and hires nobody — driven, not argued, by
 * migration 746's probe 12.
 */
async function acceptEmployeeProposal(
  proposal: DiscoveryProposal,
  note: string | null,
): Promise<DecisionOutcome> {
  if (proposal.kind !== 'employee') {
    return {
      ok: false,
      error: `That is a "${proposal.kind}" recommendation, not somebody to hire. Nothing was changed.`,
    };
  }
  return decideDiscoveryProposal(proposal.id, 'accepted', note, null);
}

/**
 * Accept a 'connector' proposal — the full Path B sequence.
 *
 * COLUMN MAPPING. The payload carries provider_key / label / category /
 * reads / writes and nothing else, so three columns are decided here rather
 * than copied. Each choice is measured, not stylistic:
 *
 *  · base_url → '' (EMPTY STRING), never connector_providers.default_base_url.
 *    `connectors_base_url_safe_check` is
 *      COALESCE(base_url,'') = '' OR is_safe_external_url(base_url)
 *    (read from pg_constraint), so '' is explicitly legal. The catalogue's
 *    default_base_url is not a safe source: 45 of its 75 rows hold prose like
 *    "not needed for Asana", which fails the check outright, and the 23 that
 *    do pass are fictitious placeholders (https://acme.zendesk.com) — writing
 *    one would put a plausible, resolvable, WRONG hostname on the row this
 *    customer is about to hand a credential to. '' is the honest value; the
 *    human supplies the real root when they connect it.
 *
 *  · status → 'pending_credentials', set EXPLICITLY. The column default is
 *    'disconnected', which says something different — "was connected, isn't
 *    now" — about a row nobody has ever connected.
 *
 *  · access_mode → 'fetch_only', decided explicitly. The default is 'ingest',
 *    the MORE permissive of the two values connectors_access_mode_check
 *    admits: ingest keeps a searchable working copy of the customer's content,
 *    fetch_only reads at answer time and keeps only the citation trail. The
 *    card this was accepted from promises reads of "<category> records" and no
 *    writes, and nobody has configured which objects yet — so taking a stored
 *    copy of data whose scope was never agreed is more than was consented to.
 *    fetch_only is the least-permissive value that still honours the card, and
 *    the owner can widen it later on the connector's own screen.
 *
 * ⚠ NO data_access_grants ROW IS WRITTEN, and that is the load-bearing rule
 * for this kind. Verified against the live body of
 * poll_de_work_sources_targets (pg_get_functiondef, read 2026-08-15):
 *     from connectors c
 *     join data_access_grants g on g.tenant_id = c.tenant_id
 *      and ((g.resource_kind = 'connector' and g.resource_id = c.id)
 *           or (g.resource_kind = 'category' and g.resource_category = c.category))
 *      and access_permission_level(g.permission) >= access_permission_level('search')
 *     where c.status <> 'disconnected'
 * It is an INNER join, and the status filter now ADMITS 'pending_credentials',
 * so for a connector-scoped grant the grant is the only thing standing between
 * a staged row and the poller. We write none.
 *
 * ⚠ But that is only half the story, and the other half is measured rather
 * than assumed: the join's SECOND arm keys on CATEGORY, not on this
 * connector's id. Live counts — 95 category-scoped grants across 18 tenants,
 * every one of them at or above 'search', versus 28 connector-scoped ones. So
 * in a workspace that already holds a category grant covering this connector's
 * category, the staged row IS admitted by the poller without anyone granting
 * it anything, and withholding the grant does not by itself close that door.
 * What still holds there is the promise the card actually makes: connector-hub
 * reads connector_secrets_decrypted and answers {error:'no_credentials'} (400)
 * when there is none, and this path writes no secret. The credential is the
 * gate; the withheld grant is the belt.
 *
 * ⚠ AND THE READERS HAD TO CHANGE, which is the part this comment used to
 * state as a hazard and leave there. `pending_credentials` had never been
 * written by anything (`select status, count(*) from connectors group by 1` →
 * connected 24, disconnected 2, on 2026-08-15) and FOUR "a connector we can
 * actually call" selectors were spelled `<> 'disconnected'`, so every one of
 * them ADMITTED the value this function is the first writer of. Fixed in the
 * same change, to an allow-list plus a deterministic order, in
 * supabase/functions/_shared/connectorSelection.ts:
 *     playbook-execute/index.ts   ×3  (execRegisteredAction, category_op, action_key)
 *     specialist-consult/index.ts ×1
 * The two SQL readers — poll_de_work_sources_targets and
 * poll_support_inbox_targets, quoted above — still carry `c.status <>
 * 'disconnected'` verbatim and are NOT fixed here: they need a migration, and
 * this workstream is not permitted to write one. Until that lands, the
 * withheld data_access_grants row and the missing credential are the only two
 * things between a staged connector and those two pollers. See the ADDENDUM in
 * .superpowers/sdd/2026-08-13-discovery-proposals-and-creation/task-3-contract.md.
 *
 * ⚠ NOT EXPORTED, on purpose. The only way to reach this writer is
 * acceptProposal, which finds it in ACCEPT_WRITERS. Exporting it is what let
 * the screen name it directly in two places and turn a documented gate into a
 * label.
 */
async function acceptConnectorProposal(
  proposal: DiscoveryProposal,
  note: string | null,
): Promise<DecisionOutcome> {
  if (proposal.kind !== 'connector') {
    return {
      ok: false,
      error: `This screen can only act on systems to connect yet, and that is a "${proposal.kind}" recommendation. Nothing was changed.`,
    };
  }
  const tenantId = await requireTenantId();

  const providerKey = String(proposal.payload.provider_key ?? '').trim();
  const label = String(proposal.payload.label ?? '').trim();
  const category = String(proposal.payload.category ?? '').trim();
  const name = label || providerKey || 'that system';

  // Both of these refuse BEFORE anything is written, so a bad payload cannot
  // leave a half-made row behind. They also refuse rather than defaulting:
  // guessing a provider or a category would create a connector the customer
  // never saw on the card.
  if (!providerKey || !Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
    return {
      ok: false,
      error: `We do not have an adapter for "${providerKey || 'that system'}" yet, so there is nothing to set up. Nothing was changed.`,
    };
  }
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      error: `"${name}" came through without a system category we recognise (${category ? `"${category}"` : 'none at all'}), so we stopped rather than guess at what it would be allowed to touch. Nothing was changed.`,
    };
  }
  const provider = providerKey as ConnectorProvider;

  // ── THE CRASH WINDOW ────────────────────────────────────────────────────
  // Path B writes the object in one round trip and stamps the proposal in a
  // second. A browser that dies between them leaves an orphan connector with
  // the proposal still 'pending' — and `connectors` carries no unique index
  // that would object to a duplicate on retry, so a naive second click would
  // mint a second row.
  //
  // So: FIND first, insert only when absent, exactly the shape
  // provision_platform_admin_connector_internal uses
  // (`select id into v_conn from connectors where tenant_id = … and provider
  // = … limit 1; if v_conn is null then insert …`). A retry re-finds the row
  // the crashed attempt made and stamps THAT id instead of duplicating it.
  //
  // It also means accepting a system the workspace already connected reuses
  // the real connector rather than shadowing it — and we never UPDATE what we
  // find, so a live credential and a working status are left untouched.
  //
  // Honest residual: this narrows the window, it does not close it. Two tabs
  // clicking Accept at the same instant can both find nothing and both insert.
  // The RPC's compare-and-swap still guarantees only one of them stamps, so
  // the outcome is a spare disconnected connector row, not a double decision.
  // ⚠ THE FIND MUST BE TOTAL AND IT MUST READ `status`. Three separate
  // corrections, each measured:
  //
  //  - `.eq('category', …)`: one provider can legitimately be registered under
  //    two categories. Matching on provider alone reuses the wrong one.
  //  - `.order('id')`: `created_at` can tie to the millisecond, and does —
  //    tenant a1b2c3d4-…-0001 holds two `generic_rest` connectors with
  //    IDENTICAL created_at. Without a second key the "same" accept can stamp
  //    a different created_object_id each time, which is nondeterminism in the
  //    one field the audit contract makes load-bearing for reconstruction.
  //    connectorSelection.ts states the rule: a total order has to be total.
  //  - `status`: see below. Reusing a row is only good news if the row works.
  const { data: existing, error: findErr } = await supabase
    .from('connectors')
    .select('id, status')
    .eq('tenant_id', tenantId)
    .eq('provider', provider)
    .eq('category', category)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (findErr) {
    return { ok: false, error: `We could not check whether ${name} is already set up: ${friendlyDecisionError(findErr.message)}` };
  }

  const existingRow = existing && existing.length > 0
    ? (existing[0] as { id: string; status: string | null })
    : null;
  const found = existingRow ? String(existingRow.id) : null;
  // ⚠ "You already had this one, so nothing new was created" is only TRUE for
  // a connector that actually works. Live counts: connected 24, disconnected 2.
  // A workspace that purged a credential holds a `disconnected` row; matching
  // it and reporting "already set up" drops the credential instruction, which
  // is the entire promise of this card — and the proposal is terminal
  // afterwards (`authenticated` holds no UPDATE on discovery_proposals and the
  // RPC refuses a non-pending row), so no path in the product can re-decide
  // it. The customer is left with a system that cannot run and a card that
  // says it is done. Only 'connected' earns the reassuring sentence.
  const foundWorking = existingRow?.status === 'connected';
  let connectorId = found;

  if (!connectorId) {
    try {
      const { connector } = await connectProvider({
        provider,
        displayName: label,           // payload says `label`; the column is display_name
        baseUrl: '',                  // see the base_url note above — never default_base_url
        category: category as SystemCategory,
        accessMode: 'fetch_only',     // see the access_mode note above — explicit, not defaulted
        secrets: {},                  // none, by design: entering one is the customer's second gate
        status: 'pending_credentials',
      });
      connectorId = connector?.id ? String(connector.id) : null;
    } catch (err) {
      return { ok: false, error: `${name} could not be set up: ${friendlyDecisionError(err instanceof Error ? err.message : String(err))}` };
    }
    // RLS refusal is a live possibility here, not a theoretical one:
    // connectors_tenant_write reads `tenant_id = auth_tenant_id() AND
    // auth_has_tenant_role(['tenant_owner','tenant_admin'])` (read from
    // pg_policy), so anyone below admin writes nothing at all.
    //
    // ⚠ Being precise about WHICH guard catches it, because the two are often
    // conflated. The repo's standing warning — "an RLS-denied write returns
    // PostgREST success with 0 rows" — is about a filtered UPDATE/DELETE. On
    // INSERT the policy is a WITH CHECK, which RAISES 42501, and either way
    // connectProvider ends its write with `.single()`, which turns "not
    // exactly one row" into an error too. So the refusal actually arrives at
    // the catch above, and this null check is a belt, not the buckle: it
    // cannot fire while the ordinary writer keeps `.single()`.
    //
    // It stays anyway, because the thing it protects against is the one that
    // must never happen — stamping a proposal 'accepted' against an object we
    // did not see come back, which is the worst state this table has.
    if (!connectorId) {
      return {
        ok: false,
        error: `${name} was not created — your workspace role does not allow adding a system. Nothing was changed, and this is still waiting for a decision.`,
      };
    }
  }

  const outcome = await decideDiscoveryProposal(proposal.id, 'accepted', note, connectorId);
  if (!outcome.ok) {
    // ⚠ THREE sentences, each true, in this order: what actually happened to
    // `connectors`, why the stamp did not land, and what to do next.
    //
    // The version this replaces composed a message that contradicted itself on
    // literally every click available today. friendlyDecisionError's PGRST202
    // branch ends "Nothing was changed.", migration 741 is written and not yet
    // applied, so the sentence a person actually met read "Zendesk was set up,
    // but we could not record your decision: Deciding is not switched on in
    // this workspace yet … Nothing was changed." — while a real connectors row
    // sat in their workspace. stripNothingChanged removes the clause on this
    // branch only, because this is the branch where it is false.
    const reason = stripNothingChanged(outcome.error ?? '');
    // Three cases, not two. A row that exists but is not connected still needs
    // its credential, and saying "already set up" would withhold the one
    // instruction that matters.
    const whatHappened = foundWorking
      ? `${name} was already connected in your workspace, so nothing new was created.`
      : found
        ? `${name} already had a connector in your workspace, and it is still waiting for a credential.`
        : `${name} was set up — the connector exists and is waiting for a credential.`;
    // ⚠ "Accepting again is safe — it will re-use the same connector" was said
    // on the already_decided arm too, and there it is FALSE. A proposal that
    // has reached a terminal state answers already_decided forever: clicking
    // again cannot help, and on the created branch the connector just minted
    // stays linked to no decision at all. So that arm gets its own sentence —
    // branching on the RPC's CODE, never on the customer-facing wording, which
    // is written to be rewritten. It also does not repeat friendlyDecisionError's
    // generic already-decided line, which would say "reload the page" twice.
    if (outcome.code === 'already_decided') {
      return {
        ...outcome,
        error: `${whatHappened} But this recommendation had already been decided${outcome.state ? ` — it is ${outcome.state} now` : ''}, so your decision was not recorded and it will not take another one. Reload the page to see where it landed.`,
      };
    }
    const whatNext = found
      ? 'Nothing else changed, and this is still waiting for a decision — you can try again once that is sorted out.'
      : `Accepting again is safe — it will re-use the ${name} connector that now exists rather than making a second one.`;
    return { ...outcome, error: `${whatHappened} We could not record your decision: ${reason} ${whatNext}` };
  }
  // ⚠ WHICH BRANCH THIS WAS. `ok: true` covers "we inserted a connector" and
  // "you already had one and we touched nothing", and the screen used to tell
  // both of them to go and enter a credential — sending someone with a live,
  // credentialled Zendesk off to fix a system that needed nothing. The find at
  // the top of this function is the only place that knows; this carries it.
  //
  // ⚠ `foundWorking`, not `found !== null`. Reusing a DISCONNECTED row is not
  // "you already had this one" — that row cannot act until someone enters a
  // credential, and the screen must keep saying so. Getting this wrong is
  // worse than the bug it replaced, because the proposal is terminal
  // afterwards and nothing in the product can re-open it.
  return { ...outcome, reusedExisting: foundWorking };
}
