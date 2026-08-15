// discoveryProposalPresentation.ts — pure card copy + batching rules for the
// discovery proposal screen (.superpowers/sdd/2026-08-13-discovery-proposals-
// and-creation, Task 2: "a screen that is short where that is safe").
//
// PURE ON PURPOSE, same discipline as supabase/functions/_shared/
// discoveryProposals.ts (Task 1): no supabase import, no I/O, so the rule
// that decides "does this kind ever get an Accept-all button" is provable
// with a unit test, not just readable in a switch statement inside a 1000-
// line page component. tests/discovery-proposal-batching.test.ts is that
// test — see its own header for exactly what would turn it red.
//
// ProposalKind/PROPOSAL_KINDS are DELIBERATELY re-declared here rather than
// imported from supabase/functions/_shared/discoveryProposals.ts — the same
// "cannot import across the supabase/ boundary cleanly" reason
// src/lib/categoryContracts.ts's own header already documents for its mirror
// of supabase/functions/_shared/categoryContracts.ts. Kept in sync by hand;
// six kinds is a smaller surface than that mirror already is.
//
// §11b (docs/superpowers/specs/2026-08-12-discovery-interview-design.md) is
// the design law this file encodes:
//   - guardrail and trust_rule NEVER batch — comparing guardrails across
//     rules is the disclosure the task exists to protect, and a trust_rule
//     is the one proposal that removes a human.
//   - conversation_type / procedure / connector are low-stakes enough that
//     their SECOND gate (publish / credential) is the real consent, so they
//     get "accept all N" with per-item unchecking.
//   - employee batches by department, but every card stays individually
//     visible — batching here is a GROUPING device, never a bulk-decide one.
// ============================================================

export type ProposalKind =
  | 'employee' | 'procedure' | 'connector' | 'guardrail' | 'trust_rule' | 'conversation_type';

export const PROPOSAL_KINDS: readonly ProposalKind[] =
  ['employee', 'procedure', 'connector', 'guardrail', 'trust_rule', 'conversation_type'];

export type ProposalState = 'pending' | 'accepted' | 'declined' | 'parked';

/** How a kind is presented on the screen. Nothing renders a batch control
 *  for a kind this function doesn't say to — the page component switches on
 *  this return value rather than re-deriving the rule inline, so the "never
 *  batch" guarantee lives in exactly one place. */
export type BatchMode = 'never' | 'department' | 'accept_all';

const NEVER_BATCH: ReadonlySet<ProposalKind> = new Set(['guardrail', 'trust_rule']);
const DEPARTMENT_BATCH: ReadonlySet<ProposalKind> = new Set(['employee']);

/** The single gate every section renderer calls. Exhaustive over
 *  PROPOSAL_KINDS by construction (the switch below has no default branch
 *  that could accidentally batch an unrecognised kind — see the test file's
 *  "every kind resolves" case, which fails loudly instead of falling
 *  through if a seventh kind is ever added here and forgotten there). */
export function batchModeFor(kind: ProposalKind): BatchMode {
  if (NEVER_BATCH.has(kind)) return 'never';
  if (DEPARTMENT_BATCH.has(kind)) return 'department';
  return 'accept_all';
}

export const KIND_LABELS: Record<ProposalKind, string> = {
  employee: 'People to hire',
  guardrail: 'Guardrails',
  trust_rule: 'Trust rules',
  connector: 'Systems to connect',
  procedure: 'Procedures',
  conversation_type: 'Conversation topics',
};

/** Reading order (docs/superpowers/sdd task-2-report.md explains the
 *  choice): employees first (who is involved), then the two kinds that
 *  never batch — guardrails and trust rules — read with full attention
 *  before any "accept all" fatigue, then the three low-stakes batches. */
export const SECTION_ORDER: readonly ProposalKind[] =
  ['employee', 'guardrail', 'trust_rule', 'connector', 'procedure', 'conversation_type'];

// ── small string helpers, same shape as discoveryProposals.ts's own ────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}
function isNumericLiteral(v: unknown): v is number | string {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    return t.length > 0 && /^-?\d+(\.\d+)?$/.test(t);
  }
  return false;
}
function numericLiteral(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '').replace(/%$/, '');
    const n = Number(t);
    return Number.isFinite(n) && t.length > 0 ? n : null;
  }
  return null;
}

/** "action:erp_financials" / "writeback:crm" / "answer_dock" → "Erp
 *  Financials" / "Crm" / "Answer Dock". Display only — never compared
 *  against, never stored (same discipline as statusVocabulary.ts). */
export function humanizeToken(raw: string): string {
  const t = raw.replace(/^action:/, '').replace(/^writeback:/, '').replace(/[_:]+/g, ' ').trim();
  if (!t) return raw;
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

const CATEGORY_SHORT_LOCAL: Record<string, string> = {
  crm: 'CRM', helpdesk: 'Helpdesk', knowledge_base: 'Knowledge base',
  erp_financials: 'ERP / Financials', billing: 'Billing',
  payroll_hcm: 'Payroll / HCM', pos: 'Point of sale',
  product_system: 'Product system',
  ads: 'Ads', social: 'Social', web_analytics: 'Web analytics',
  other: 'Other',
};

/** A connector category ("erp_financials") to the same short label
 *  src/lib/categoryContracts.ts's CATEGORY_SHORT already uses elsewhere in
 *  the app — duplicated here (not imported) to keep this module's only
 *  dependency being plain data, no risk of pulling in anything with I/O.
 *  Falls back to humanizeToken for anything outside the known set (an
 *  employee's required_connector_categories can legitimately name a
 *  provider-specific category this table doesn't know about). */
export function humanizeSystem(key: string): string {
  return CATEGORY_SHORT_LOCAL[key] ?? humanizeToken(key);
}

/** "10000" / 10000 / "$10,000" → "$10,000". answer_dock/answer_widget are
 *  the two action categories set_trust_ladder confidence-gates instead of
 *  dollar-gating (src/lib/trustApi.ts's own trustLevelSettings encodes the
 *  same split) — so a cap on either reads as a confidence percentage, not
 *  money. */
export function formatCap(actionCategory: string, cap: unknown): string {
  const n = numericLiteral(cap);
  if (n === null) return str(cap) || 'no cap recorded';
  const usesConfidence = actionCategory === 'answer_dock' || actionCategory === 'answer_widget';
  if (usesConfidence) return `${n}% confidence`;
  return `$${n.toLocaleString('en-US')}`;
}

/** guardrail's enforceable literal, verbatim per §11b: "matches: X" for a
 *  pattern, "over $X" for a threshold — never both, pattern wins if both
 *  are somehow present because a pattern is the more specific literal. */
export function guardrailLiteral(payload: Record<string, unknown>): string {
  const pattern = str(payload.pattern);
  if (pattern) return `matches: ${pattern}`;
  if (isNumericLiteral(payload.threshold)) return `over ${formatCap('', payload.threshold)}`;
  return 'no literal recorded yet';
}

// ── card copy ────────────────────────────────────────────────────────────

export interface ProposalCardCopy {
  title: string;
  /** One sentence of consequence — what accepting actually changes. */
  detail: string;
  /** The enforceable literal — the one fact §11b says a card cannot omit. */
  meta: string;
  /** "The one thing changeable later" — reduces the felt weight of a
   *  decision that IS in fact editable afterward, without pretending the
   *  decision itself is reversible before it's made. */
  nudge?: string;
}

/** The one function every card in the screen calls for its copy. Takes only
 *  data — kind + payload + an employee-name lookup for the two kinds
 *  (conversation_type's owner_ref, trust_rule's de_ref) that reference an
 *  employee by "archetype:<key>" rather than carrying a name of their own. */
export function cardCopyFor(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  employeeNameByArchetype: ReadonlyMap<string, string>,
): ProposalCardCopy {
  const archetypeOf = (ref: string) => (ref.startsWith('archetype:') ? ref.slice('archetype:'.length) : ref);

  switch (kind) {
    case 'conversation_type': {
      const label = str(payload.label) || 'New topic';
      const ownerRef = str(payload.owner_ref);
      const ownerName = ownerRef && ownerRef !== 'unassigned' ? employeeNameByArchetype.get(archetypeOf(ownerRef)) : undefined;
      return {
        title: `Track "${label}" as a conversation topic`,
        detail: 'Conversations get tagged and routed under this topic from now on.',
        meta: ownerName ? `Routes to: ${ownerName}` : 'No owner yet — you can assign one when you publish.',
        nudge: 'You can rename or reassign this topic later.',
      };
    }

    case 'connector': {
      const label = str(payload.label) || str(payload.provider_key) || 'this system';
      const reads = strArray(payload.reads);
      const writes = strArray(payload.writes);
      const touches = [reads.length ? `reads ${reads.join(', ')}` : null, writes.length ? `writes ${writes.join(', ')}` : null]
        .filter(Boolean).join(', ');
      return {
        title: `Connect ${label}`,
        detail: 'We set it up ready to go — you still enter the credential yourself.',
        meta: `${label} · ${touches || 'nothing configured yet'}`,
        nudge: 'You can turn on more of what it can read or write once it is connected.',
      };
    }

    case 'procedure': {
      const name = str(payload.name) || 'this procedure';
      const trigger = str(payload.trigger) || 'a trigger you will confirm';
      return {
        title: `Draft the "${name}" procedure`,
        detail: 'This becomes a draft — nothing runs until you publish it.',
        meta: `Trigger: ${trigger}`,
        nudge: 'Every step is editable before you publish it.',
      };
    }

    case 'employee': {
      const name = str(payload.name) || 'This role';
      const systems = strArray(payload.systems).map(humanizeSystem);
      return {
        title: `Add ${name} to your team`,
        detail: 'Comes with a published SOP. Starts supervised, drafts everything, sends nothing until you say so.',
        meta: systems.length ? `Systems: ${systems.join(', ')}` : 'No systems requested yet.',
        nudge: 'You can add or remove systems any time after hiring.',
      };
    }

    case 'guardrail': {
      const rule = str(payload.rule) || 'New guardrail';
      return {
        title: rule,
        detail: 'Anything matching this is blocked before it reaches a customer.',
        meta: guardrailLiteral(payload),
        nudge: 'You can edit or remove this rule later in Governance.',
      };
    }

    case 'trust_rule': {
      const deRef = str(payload.de_ref);
      const employeeName = deRef ? employeeNameByArchetype.get(archetypeOf(deRef)) : undefined;
      const who = employeeName ?? 'This employee';
      const actionCategory = str(payload.action_category);
      const cap = formatCap(actionCategory, payload.cap);
      return {
        title: `Let ${who} act on its own up to ${cap}`,
        detail: 'Above this, it stops and asks you first.',
        meta: `${who} · ${humanizeToken(actionCategory) || 'unnamed category'} · up to ${cap}`,
        nudge: 'You can lower or raise this cap later in Trust settings.',
      };
    }
  }
}

/** What accepting a proposal of this kind actually creates — the Drawer's
 *  "what accepting writes" line. Deliberately plain, not a repeat of the
 *  card's own detail sentence. */
export function whatAcceptingWrites(kind: ProposalKind): string {
  switch (kind) {
    case 'employee': return 'Creates a digital employee — draft, supervised — with its SOP and requested systems attached.';
    case 'connector': return 'Creates a connector record for this system, waiting on your credential.';
    case 'procedure': return 'Creates a draft procedure definition. It will not run until you publish it.';
    case 'conversation_type': return 'Adds this as a routable conversation topic.';
    case 'guardrail': return 'Creates an enforced guardrail rule with this exact pattern or threshold.';
    case 'trust_rule': return 'Creates or raises this employee’s trust policy, up to the stated cap.';
  }
}

/** §11b requirement 4: a trust_rule proposal may not be decided before the
 *  employee it names has actually been accepted — set_trust_ladder raises
 *  an EXISTING trust_policies row, and nothing in the hire path creates one
 *  ahead of acceptance (progress.md's ordering-constraint note; live
 *  measured 66 of 107 employees carry none). Returns null when the trust
 *  rule is decidable right now; otherwise the exact reason to show, never a
 *  hidden card.
 *
 *  Three distinguishable outcomes, not two — the difference between "you
 *  haven't said yes yet" and "nobody proposed this employee at all" is real
 *  information for whoever's reading the card. */
export function trustRuleBlockReason(
  deRef: string,
  employeeProposals: readonly { payload: Record<string, unknown>; state: string }[],
): string | null {
  const key = deRef.startsWith('archetype:') ? deRef.slice('archetype:'.length) : deRef;
  const match = employeeProposals.find((e) => str(e.payload.archetype_key) === key);
  if (!match) {
    return `Blocked — no employee matching "${key || deRef}" was proposed this session.`;
  }
  if (match.state === 'accepted') return null;
  const name = str(match.payload.name) || key;
  return `Blocked until you accept ${name} — a trust rule cannot exist without the employee it governs.`;
}
