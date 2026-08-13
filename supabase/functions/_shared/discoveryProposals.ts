// discoveryProposals.ts — turning heard evidence into cards a person can
// actually decide on (.superpowers/sdd/2026-08-13-discovery-proposals-and-
// creation, Task 1: "proposals a person could actually decide on").
//
// discoveryCoverage.ts answers "what did the interview hear, per dimension".
// This module answers the next question: "what does that turn into, and
// what has to be on the card before a human can say yes, no, or not yet".
//
// THE HARD RULE, first because it is the one this whole programme exists to
// protect. Only a dimension actually marked 'heard' may produce a proposal.
// 'parked', 'skipped' and 'not_heard' all mean either there is no evidence to
// build from, or the customer explicitly said "not now" / "not relevant" —
// inventing a proposal from either is exactly the failure
// discovery_dimensions.guidance's "silence is not coverage" language
// (migrations 734/735) was written against, one layer further downstream.
// See proposalsFrom's very first check, below.
//
// THE SPLIT — flagged in this plan's progress.md PRE-FLIGHT note before this
// task started, with the resolution given, not re-opened here:
//
//   PURE (proposalsFrom derives a COMPLETE, self-validating payload, no
//   model call, no I/O):
//     employee          — from a dimension's serves_archetypes + the real
//                          role_archetypes row (systems = the archetype's
//                          required_connector_categories — §11b: "tool reach
//                          belongs on the card, not behind a link")
//     connector         — from matchProvider() over the dimension's evidence
//                          text against the live connector_providers catalog
//     conversation_type — label (the dimension's own title) + owner (the
//                          archetype it serves)
//
//   NOT PURE — proposalsFrom emits the SHAPE only, with needs_model_fill:
//   true and a payload that is DELIBERATELY incomplete. A model fills the
//   missing literal elsewhere (discovery-interview/index.ts, at interview
//   end), and the exact same validatePayload below is the only gate either
//   path's output ever passes through before it reaches discovery_proposals:
//     guardrail  — needs a pattern or a threshold (§11b, verbatim: "you
//                  cannot consent to a block you cannot predict")
//     procedure  — needs a trigger and at least one step
//     trust_rule — needs a cap — §11b: "the only kind where no card is short
//                  enough — it is the one proposal that removes a human"
//
// validatePayload is what makes that split honest rather than a loophole: a
// model-filled payload still missing its literal is refused exactly as a
// hand-built incomplete one would be. Never weaken it to let model output
// through unchecked — the refusal IS the feature.
//
// ZERO DENO-ONLY IMPORTS, same discipline as discoveryCoverage.ts and for
// the identical reason: this file must be importable both by vitest
// (tests/discovery-proposals.test.ts) and by discovery-interview/index.ts
// under Deno at deploy time. That is also why matchProvider is a SELF-
// CONTAINED reimplementation here rather than an import of
// src/lib/connectorApi.ts — that module's top-level `import { supabase }
// from '../supabase'` calls createClient(...) against
// import.meta.env.VITE_* at MODULE LOAD TIME (src/supabase.ts), which does
// not exist under Deno and would crash the deployed function the instant it
// tried to import this one. The 75-row PROVIDERS catalog itself is NOT
// duplicated — it stays exactly once, in public.connector_providers, read
// live by the caller and passed in as `providerCatalog`. Only the small,
// pure MATCHING algorithm is duplicated, and tests/discovery-proposals.test
// .ts's "matchProvider — duplicated on purpose, drift-guarded here" describe
// block is what keeps that duplication honest: it imports the real
// src/lib/connectorApi.ts matchProvider (a real vitest-only import — vitest
// runs on Vite, which resolves import.meta.env fine) and asserts identical
// output across a battery of cases. If the algorithms ever disagree, that
// test goes red; nothing here silently drifts.
//
// Never writes anything. Never reads or touches digital_employees at all
// (so is_workforce_assistant is trivially never touched) — proposalsFrom is
// pure data-in/data-out, and the only I/O this whole module performs is none.
// ============================================================

import type { DiscoveryCoverageMap } from './discoveryCoverage.ts';

export type ProposalKind =
  | 'employee' | 'procedure' | 'connector' | 'guardrail' | 'trust_rule' | 'conversation_type';

/** The exact six kinds discovery_proposals.kind's CHECK constraint accepts
 *  (migration 737). Kept here, not re-derived, so an unknown kind is refused
 *  by name rather than silently treated as "no rule for this one". */
export const PROPOSAL_KINDS: readonly ProposalKind[] =
  ['employee', 'procedure', 'connector', 'guardrail', 'trust_rule', 'conversation_type'];

const KNOWN_KINDS: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

/** Anything shaped like a discovery_dimensions row — only the fields this
 *  module reads are required, the same minimal-surface pattern
 *  discoveryCoverage.ts's DiscoveryDimensionLike already uses here, so a
 *  fixture and a live DB row are equally valid without an index signature
 *  forcing every caller's row type to declare one. */
export interface DiscoveryDimensionForProposals {
  key: string;
  title: string;
  serves_archetypes: readonly string[];
  produces?: readonly string[];
}

/** Anything shaped like a role_archetypes row — only what an employee card
 *  needs. required_connector_categories is what makes "the systems it will
 *  be able to touch" derivable WITHOUT a model: it is already structured
 *  data on the archetype, not prose that needs interpreting. */
export interface ArchetypeLike {
  key: string;
  name: string;
  domain: string;
  required_connector_categories?: readonly string[];
}

/** Mirrors src/lib/connectorApi.ts's ProviderCatalogRow exactly (same field
 *  names) so a caller can pass rows straight off `select provider_key,
 *  label, category, aliases from connector_providers` without reshaping. */
export interface ProviderCatalogRow {
  provider_key: string;
  label: string;
  category: string;
  aliases: readonly string[];
}

export interface ProviderMatch {
  provider_key: string;
  matched_on: string;
  confidence: 'exact' | 'alias' | 'partial';
}

export interface ProposalDraft {
  kind: ProposalKind;
  /** For a pure kind (employee/connector/conversation_type): complete and
   *  guaranteed to pass validatePayload(kind, payload) as emitted — proven
   *  by tests/discovery-proposals.test.ts's own "derives a complete,
   *  self-validating ... draft" cases, not merely asserted here.
   *  For a model-filled kind (guardrail/procedure/trust_rule): deliberately
   *  incomplete, and WILL be refused by validatePayload until a model fills
   *  in the missing literal. Never write an incomplete payload straight to
   *  discovery_proposals. */
  payload: Record<string, unknown>;
  rationale: string;
  source_dimension: string;
  /** true only for guardrail/procedure/trust_rule — see the module header's
   *  "THE SPLIT". Never true for a pure kind. */
  needs_model_fill: boolean;
}

// ── matchProvider — duplicated from src/lib/connectorApi.ts, see the module
// header for exactly why, and tests/discovery-proposals.test.ts for the
// drift guard that keeps the duplication honest. Kept byte-for-byte
// equivalent in BEHAVIOUR (not necessarily formatting) to the original. ──

/** Space-padded, punctuation-flattened, so `includes()` is a word-boundary
 *  test. Case is deliberately NOT touched here — the two passes in
 *  matchProvider below want different answers about it. */
function padForWordMatch(s: string): string {
  return ` ${s.replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Resolve free text ("we run everything through xero") to known providers.
 *
 *  Deliberately conservative: it matches on WORD BOUNDARIES only, and
 *  returns an empty array rather than a best guess — proposalsFrom acts on
 *  what this returns (a connector proposal, and later, once accepted, an
 *  employee's access grant), so a false positive is worse than a miss. A
 *  miss just means the interview asks one more question.
 *
 *  Two passes, and the second is why an ordinary-word product name still
 *  resolves:
 *   1. ALIASES, case-insensitively. connector_providers.aliases is already
 *      filtered against AMBIGUOUS_ALIASES at seed time (migration 729), so
 *      nothing reaching this function's `catalog` argument is a bare
 *      English word.
 *   2. The EXACT LABEL, case-SENSITIVELY. "we use Close" is a proper noun
 *      and resolves; "we close deals" is a verb and does not. Sentence-
 *      initial capitals are lowered first, because a capital at the start
 *      of a sentence is grammar, not a product name.
 */
export function matchProvider(text: string, catalog: readonly ProviderCatalogRow[]): ProviderMatch[] {
  const cased = padForWordMatch(
    text.replace(/(^|[.!?\n]\s*)([A-Z])/g, (_m, pre: string, c: string) => pre + c.toLowerCase()),
  );
  const lower = cased.toLowerCase();
  const hits = new Map<string, ProviderMatch>();

  const record = (row: ProviderCatalogRow, matchedOn: string, confidence: ProviderMatch['confidence']) => {
    const existing = hits.get(row.provider_key);
    if (!existing || (existing.confidence !== 'exact' && confidence === 'exact')) {
      hits.set(row.provider_key, { provider_key: row.provider_key, matched_on: matchedOn, confidence });
    }
  };

  for (const row of catalog) {
    for (const alias of row.aliases) {
      const needle = padForWordMatch(alias).toLowerCase();
      if (needle.trim() === '') continue;
      if (!lower.includes(needle)) continue;
      record(row, alias,
        alias.toLowerCase() === row.label.toLowerCase() ? 'exact'
          : alias === row.provider_key ? 'exact' : 'alias');
    }
    const label = padForWordMatch(row.label);
    if (label.trim() !== '' && cased.includes(label)) record(row, row.label, 'exact');
  }
  return [...hits.values()];
}

// ── validatePayload — the single gate for both the pure and the model-filled
// path. Every branch states, in its own thrown message, the words the
// contract test regexes look for, so a failing check here fails LOUD and
// specific rather than "invalid payload". ──

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nonEmptyArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v.filter((x) => str(x).length > 0 || (typeof x === 'number' && Number.isFinite(x))) : [];
}

/** A "cap"/"threshold" style value: a real number, or a non-empty string
 *  (e.g. "$10,000" typed by a model as prose-adjacent text is still a
 *  literal a human can read and predict against — 0 is deliberately a valid
 *  cap, so this is NOT a truthiness check). */
function hasCapLikeContent(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim().length > 0;
  return false;
}

/**
 * validatePayload — throws with a specific, greppable reason on any payload
 * that does not carry what §11b says a person needs to decide on for that
 * kind. Never returns a value; a payload that passes simply does not throw.
 *
 * THIS IS THE GATE FOR BOTH PATHS. Called on a pure ProposalDraft's payload
 * as emitted by proposalsFrom (must never throw — proven in the test suite)
 * and, separately, on a model-filled guardrail/procedure/trust_rule payload
 * before either is ever inserted into discovery_proposals
 * (discovery-interview/index.ts). Do not special-case a model-filled payload
 * to skip a check a hand-built one would face — an incomplete card is
 * incomplete regardless of who almost finished it.
 */
export function validatePayload(kind: ProposalKind, payload: Record<string, unknown>): void {
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(`validatePayload: unknown proposal kind "${String(kind)}" — must be one of ${PROPOSAL_KINDS.join(', ')}`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`validatePayload: ${kind} proposal has no payload to decide on`);
  }

  switch (kind) {
    case 'conversation_type': {
      // §11b: "label + owner — one line. A label acts on nothing." Demanding
      // more here is the theatre the design doc explicitly warns against.
      if (!str(payload.label)) {
        throw new Error('validatePayload: conversation_type proposal has no label');
      }
      if (!str(payload.owner_ref)) {
        throw new Error('validatePayload: conversation_type proposal names no owner — a topic nobody owns is not something a person can decide to route');
      }
      return;
    }

    case 'connector': {
      // §11b: "provider + what it reads/writes + 'you still enter the
      // credential'". The credential step is the SECOND gate, not the only
      // one — what it can touch has to be on THIS card.
      if (!str(payload.provider_key)) {
        throw new Error('validatePayload: connector proposal names no provider');
      }
      const reads = nonEmptyArray(payload.reads);
      const writes = nonEmptyArray(payload.writes);
      if (reads.length === 0 && writes.length === 0) {
        throw new Error(
          `validatePayload: connector proposal for "${str(payload.provider_key)}" names nothing it reads or writes — the credential step is the second gate, but what it can touch has to be on the card first`,
        );
      }
      return;
    }

    case 'procedure': {
      // §11b: "name + trigger + 'draft; runs only when you publish'".
      const name = str(payload.name);
      if (!name) {
        throw new Error('validatePayload: procedure proposal has no name');
      }
      if (!str(payload.trigger)) {
        throw new Error(`validatePayload: procedure "${name}" has no trigger — when it runs is not decidable without one`);
      }
      if (nonEmptyArray(payload.steps).length === 0) {
        throw new Error(`validatePayload: procedure "${name}" has no steps — an empty draft is nothing a person can review, approve or decline`);
      }
      return;
    }

    case 'employee': {
      // §11b: "the systems it will be able to touch ... tool reach belongs
      // on the card, not behind a link."
      const name = str(payload.name);
      if (!name) {
        throw new Error('validatePayload: employee proposal has no name');
      }
      if (nonEmptyArray(payload.systems).length === 0) {
        throw new Error(
          `validatePayload: employee "${name}" does not say what systems it can touch — tool reach belongs on the card, not behind a link, and no access at all is not a fact anyone can consent to`,
        );
      }
      return;
    }

    case 'guardrail': {
      // §11b, verbatim: "the rule sentence and its literal pattern or
      // threshold, verbatim ... you cannot consent to a block you cannot
      // predict."
      const rule = str(payload.rule);
      if (!rule) {
        throw new Error('validatePayload: guardrail proposal has no rule sentence');
      }
      const pattern = str(payload.pattern);
      if (!pattern && !hasCapLikeContent(payload.threshold)) {
        throw new Error(
          `validatePayload: guardrail "${rule}" carries no literal pattern or threshold — you cannot consent to a block you cannot predict`,
        );
      }
      return;
    }

    case 'trust_rule': {
      // §11b: "employee + action category + the dollar/confidence cap + what
      // happens above it ... the only kind where no card is short enough —
      // it is the one proposal that removes a human."
      if (!str(payload.de_ref)) {
        throw new Error('validatePayload: trust_rule proposal names no employee (de_ref)');
      }
      if (!str(payload.action_category)) {
        throw new Error('validatePayload: trust_rule proposal names no action_category');
      }
      if (!hasCapLikeContent(payload.cap)) {
        throw new Error(
          `validatePayload: trust_rule for "${str(payload.action_category)}" carries no cap — an amount, confidence value or threshold — this is the one proposal that removes a human, and no cap is no decision`,
        );
      }
      return;
    }
  }
}

// ── proposalsFrom — pure. See the module header for the full split. ────────

export interface ProposalsFromOptions {
  /** Live public.connector_providers rows. Omit (or pass []) to skip
   *  connector derivation entirely — proposalsFrom never throws for a
   *  missing catalog, it simply proposes no connectors, exactly like
   *  matchProvider itself returning [] for an empty catalog. */
  providerCatalog?: readonly ProviderCatalogRow[];
}

/** Which STRUCTURAL kinds (conversation_type / procedure / guardrail /
 *  trust_rule) a given dimension can produce, keyed by dimension `key` —
 *  NOT by parsing discovery_dimensions.produces' free-form prose, which is
 *  written for a human reader and is not a stable machine contract (its
 *  wording has already changed twice, migrations 733→734→735, without the
 *  underlying dimension keys moving). `employee` and `connector` are
 *  deliberately absent from this table: both are derived generically for
 *  ANY dimension from serves_archetypes / matched evidence respectively,
 *  never from a hardcoded per-dimension list — the same "never hand-
 *  maintain what can be derived" discipline discovery_capability_gaps
 *  itself is built on (migration 733's own header).
 *
 *  Mapped from the spine's own design (docs/superpowers/specs/2026-08-12-
 *  discovery-interview-design.md §3 and the 14-dimension guidance text,
 *  migration 734):
 *   - how_customers_reach_us is the one dimension whose own produces list
 *     is about channels/routing for customer contact — the natural source
 *     of a conversation_type.
 *   - must_never_happen (734, ordinal 11) is the SOLE guardrail source —
 *     "capture the hard lines ... these become guardrails rather than
 *     judgment calls".
 *   - who_signs_off (734, ordinal 12) is the SOLE trust_rule source —
 *     "the actual dollar thresholds and approval chains that gate action
 *     ... recurs almost verbatim across nearly every role" — i.e. it is
 *     where every approval number in the whole interview is meant to
 *     surface, including money_out's, so money_out itself does not double
 *     as a second trust_rule source.
 *   - money_in / how_work_gets_delivered / repetitive_work each name a
 *     concrete recurring procedure in their own `produces` text
 *     (overdue-invoice procedure; dispatch/scheduling procedure;
 *     close-cadence / dunning-cadence / renewal-cadence procedure).
 *  Dimensions not listed here produce no structural kind — what_we_do
 *  (vocabulary only), winning_business / after_the_sale / money_out /
 *  systems_of_record / the_workforce_itself (employee/connector only, via
 *  the generic paths above), and who_is_who / what_good_looks_like (org
 *  contacts and KPI targets — §11b lists both under "Safely deferred",
 *  no proposal kind among the six fits either). */
const DIMENSION_STRUCTURAL_KINDS: Readonly<Record<string, readonly ProposalKind[]>> = {
  how_customers_reach_us: ['conversation_type'],
  money_in: ['procedure'],
  how_work_gets_delivered: ['procedure'],
  repetitive_work: ['procedure'],
  must_never_happen: ['guardrail'],
  who_signs_off: ['trust_rule'],
};

/**
 * proposalsFrom — pure, no model call, no I/O.
 *
 * Reads each dimension's coverage entry and, for every dimension actually
 * marked 'heard' (the hard rule — see the module header), emits zero or more
 * ProposalDraft objects:
 *   - one 'employee' draft per real (non-`planned_`) archetype the dimension
 *     serves, deduplicated by archetype key across the WHOLE call (several
 *     dimensions commonly name the same archetype — e.g. renewal_manager
 *     appears in money_in, money_out, after_the_sale and repetitive_work —
 *     and a person should see that role proposed once, not four times);
 *   - zero or more 'connector' drafts from matchProvider() over the
 *     dimension's evidence text, deduplicated by provider_key across the
 *     whole call the same way;
 *   - the dimension's own structural kind(s) from DIMENSION_STRUCTURAL_KINDS,
 *     if any — conversation_type is emitted complete; procedure/guardrail/
 *     trust_rule are emitted as an intentionally incomplete SHAPE with
 *     needs_model_fill: true (see the module header's "THE SPLIT").
 *
 * A dimension key present in `dimensions` but absent from
 * DIMENSION_STRUCTURAL_KINDS simply contributes no structural draft — this
 * is not an error, most of the fourteen dimensions are employee/connector-
 * only or produce nothing proposal-shaped at all (what_we_do; who_is_who;
 * what_good_looks_like).
 */
export function proposalsFrom(
  dimensions: readonly DiscoveryDimensionForProposals[],
  coverage: DiscoveryCoverageMap,
  archetypes: readonly ArchetypeLike[],
  options: ProposalsFromOptions = {},
): ProposalDraft[] {
  const providerCatalog = options.providerCatalog ?? [];
  const archetypeByKey = new Map(archetypes.map((a) => [a.key, a] as const));
  const drafts: ProposalDraft[] = [];
  const seenArchetypes = new Set<string>();
  const seenProviders = new Set<string>();

  for (const dim of dimensions) {
    const entry = coverage[dim.key];
    // THE HARD RULE. 'parked' has no evidence to close on by construction
    // (coverageAfter never requires it); 'skipped' is an explicit "not
    // relevant"; 'not_heard' is simply never reached. None of the three is
    // grounds for a proposal — inventing one from silence is the exact
    // failure the whole discovery programme exists to prevent, one layer
    // downstream of coverageAfter's own "silence is not coverage" gate.
    if (!entry || entry.state !== 'heard') continue;
    const evidence = str(entry.evidence);
    const evidenceLine = evidence || '(marked heard with no evidence text recorded)';

    // ---- employee: purely derived from serves_archetypes -----------------
    // Generic over EVERY dimension — never a hardcoded per-dimension list —
    // per the DE genericity discipline this codebase already holds itself
    // to elsewhere (never hardcode a department).
    for (const archKey of dim.serves_archetypes) {
      // A `planned_` archetype names a capability this product cannot staff
      // yet (migration 734's founder-specified escape hatch) — that is
      // discovery_capability_gaps' job to surface, never an invented role
      // here.
      if (archKey.startsWith('planned_')) continue;
      if (seenArchetypes.has(archKey)) continue;
      const arch = archetypeByKey.get(archKey);
      // A dimension may name an archetype key that does not resolve against
      // the archetypes actually passed in (stale data, or a caller passing
      // a partial list) — never invent a role for it.
      if (!arch) continue;
      seenArchetypes.add(archKey);
      const systems = nonEmptyArray(arch.required_connector_categories).map((s) => String(s));
      drafts.push({
        kind: 'employee',
        payload: {
          name: arch.name,
          job: arch.name,
          department: arch.domain,
          archetype_key: arch.key,
          systems,
          starts_supervised: true,
          sends_nothing: true,
          comes_with_published_sop: true,
        },
        rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
        source_dimension: dim.key,
        needs_model_fill: false,
      });
    }

    // ---- connector: purely derived via matchProvider ----------------------
    // Generic over EVERY dimension's evidence, same reasoning as above.
    if (evidence && providerCatalog.length) {
      for (const match of matchProvider(evidence, providerCatalog)) {
        if (seenProviders.has(match.provider_key)) continue;
        const row = providerCatalog.find((p) => p.provider_key === match.provider_key);
        if (!row) continue; // defensive: matchProvider only ever returns keys from the catalog it was given
        seenProviders.add(match.provider_key);
        drafts.push({
          kind: 'connector',
          payload: {
            provider_key: row.provider_key,
            label: row.label,
            category: row.category,
            matched_on: match.matched_on,
            confidence: match.confidence,
            // Category is real, structured data on the catalog row — a
            // system-level statement of what it touches, derivable with no
            // model. Field-level mapping (which objects, which actions) is
            // explicitly deferred by §11b ("connector field mappings and
            // action enablement") to after acceptance.
            reads: [`${row.category} records`],
            writes: [],
            credential_note: 'You still enter the credential yourself.',
          },
          rationale: `"${row.label}" matched (${match.confidence}, on "${match.matched_on}") in evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: false,
        });
      }
    }

    // ---- this dimension's own structural kind(s) --------------------------
    for (const kind of DIMENSION_STRUCTURAL_KINDS[dim.key] ?? []) {
      if (kind === 'conversation_type') {
        const ownerArchKey = dim.serves_archetypes.find((k) => !k.startsWith('planned_') && archetypeByKey.has(k));
        drafts.push({
          kind: 'conversation_type',
          payload: {
            label: dim.title,
            owner_ref: ownerArchKey ? `archetype:${ownerArchKey}` : 'unassigned',
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: false,
        });
      } else if (kind === 'procedure') {
        drafts.push({
          kind: 'procedure',
          payload: {
            name: null,
            trigger: null,
            steps: [],
            evidence,
            note: 'draft; runs only when you publish',
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      } else if (kind === 'guardrail') {
        drafts.push({
          kind: 'guardrail',
          payload: {
            rule: evidence || dim.title,
            pattern: null,
            threshold: null,
            severity: 'blocking',
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      } else if (kind === 'trust_rule') {
        drafts.push({
          kind: 'trust_rule',
          payload: {
            de_ref: null,
            action_category: null,
            cap: null,
            evidence,
          },
          rationale: `Heard evidence for "${dim.title}": ${evidenceLine}`,
          source_dimension: dim.key,
          needs_model_fill: true,
        });
      }
    }
  }

  return drafts;
}
