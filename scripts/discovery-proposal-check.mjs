// The discovery-PROPOSAL-DECISION comparison, as a PURE function over
// already-fetched state — no database, no I/O, no clock. Same split, and the
// same reason, as provider-catalog-check.mjs and discovery-spine-check.mjs:
// certify.mjs runs against PRODUCTION, so the only honest way to prove one of
// these assertions can fail is to hand the REAL comparison a MUTATED COPY of
// live state and watch it fire — never to write a decided proposal, an
// orphaned employee or a dangling uuid into the live tables.
//
// certify.mjs fetches and formats; this decides. scripts/certify-mutation-
// test.mjs imports the SAME function and feeds it mutated copies of the SAME
// live state, so the fixtures exercise the real gate rather than a paraphrase
// of it.
//
// ⚠⚠ THE THING THIS FILE IS MOST AT RISK OF BEING.
// public.discovery_proposals holds ZERO rows today, and that is not a
// suspicion — it is measured: 0 proposals, 0 discovery_sessions, and 0
// audit_events carrying detail->>'kind' = 'discovery_proposal_decision'
// (checked, because in this repo zero rows is never on its own evidence that
// a feature never ran). Four of the assertions below are per-ROW assertions.
// Over an empty table they compare nothing, and a check that compared nothing
// renders identically to a clean result — the trap this repo has hit nine
// times in five days.
//
// So the row arms are NOT the whole gate. Four families of assertion are
// exercised on every single run, against live state, whether or not a single
// proposal has ever existed:
//
//   1. THE ROUTES (KIND_ROUTES x EXPECTED_KIND_TABLES x to_regclass x the kind
//      CHECK). A kind is "routable" only if the table its writer creates into
//      actually exists AND is the table the independent expectation names.
//      The second half is what stops KIND_ROUTES being a per-kind exemption
//      switch: pointing a kind at any LIVE table (de_conversations, say) used
//      to make every arm answer correctly, because every arm was derived from
//      the map itself. See EXPECTED_KIND_TABLES.
//   2. THE STATES (TERMINAL_STATES + NON_TERMINAL_STATES x
//      discovery_proposals_state_check). The row arms classify each row by
//      state; a state the CHECK admits and this file has never heard of would
//      be skipped by every one of them silently, while still counting in the
//      denominator. Closed in BOTH directions, the same way the kinds are.
//   3. THE RESOLVER CONTROLS. The dangling-uuid assertion depends on a SQL
//      CASE expression resolving a uuid against the table its kind creates.
//      A resolver that answered "yes, it exists" to everything would make that
//      assertion incapable of failing, and no row fixture could ever show it.
//      So every run drives the SAME expression FOUR ways per routable kind:
//      the nil uuid (must say NO), a row that demonstrably exists (must say
//      YES), that same row paired with ANOTHER tenant's id (must say NO — the
//      tenant predicate), and, where an exclusion is declared, a row the
//      exclusion is supposed to reject (must say NO). Every direction, every
//      run, sourced from HARDCODED expectations so the map cannot move both
//      sides of a comparison at once.
//   4. THE AUDIT-WRITE PERIMETER. The "was it ever created" relief below
//      (see hasCreationAudit) reads an audit event as evidence. That is only
//      admissible while nobody outside the governed path can write one, so
//      the perimeter is asserted on every run, not assumed.
//
// The row arms then report their own denominator explicitly, and zero rows is
// printed as a loud NOT-YET-EXERCISED line rather than swallowed — see
// `notes` in the return value and the section in certify.mjs that prints them.

/**
 * WHICH KINDS A WRITER CAN ACTUALLY ROUTE, and into what.
 *
 * This map is the declaration the plan's third assertion is phrased against:
 * "every distinct kind value present in the table is one the writers can
 * actually route". Adding a key here is the act of claiming a kind is
 * routable — and the claim is CHECKED, not taken: `table` must resolve live
 * (to_regclass), it must MATCH the independent expectation in
 * EXPECTED_KIND_TABLES, and the kind must be admitted by
 * discovery_proposals_kind_check.
 *
 * `conversation_type` IS DELIBERATELY ABSENT AND MUST NOT BE ADDED.
 *   - There is no conversation_types table (to_regclass -> null, measured
 *     again 2026-08-15), no writer, and nothing routes on
 *     de_conversations.category from a bare label.
 *   - task-3-contract.md S8 item 14: "Do not give any kind a per-kind
 *     exemption from the Task 5 certify assertions. If a kind cannot satisfy
 *     them, that kind is not ready to ship."
 *   - The founder's 2026-08-15 ruling makes the topic axis a real feature:
 *     it already exists as de_conversations.category driven by
 *     support_triage_rules, and the interview will write REAL rules
 *     (match_pattern + set_category) in the follow-up task. When that writer
 *     lands, conversation_type gains a route HERE and a matching entry in
 *     EXPECTED_KIND_TABLES pointing at support_triage_rules — together, in
 *     the same edit as the writer, never before it.
 *   - ⚠ AS OF 2026-08-15 THE EMITTER IS OFF. supabase/functions/_shared/
 *     discoveryProposals.ts no longer maps how_customers_reach_us to
 *     conversation_type and no longer pushes the draft (its
 *     DIMENSION_STRUCTURAL_KINDS header carries the reasons and the return
 *     conditions). This sentence used to claim a removal that had not
 *     happened; it is now true, and tests/discovery-proposals.test.ts's
 *     "conversation_type is NOT emitted" case is what keeps it true.
 *
 * `writer` is documentation with teeth ONLY in the audit trail — it is the
 * string a later auditor uses to tell an ordinary write from an ad-hoc one.
 * ⚠ Be honest about what it is not: no assertion in this file reads it, and
 * three of the five writers are browser TypeScript with no catalogue
 * presence, so there is nothing live to diff it against. EXPECTED_KIND_TABLES
 * below is the arm that actually has teeth.
 */
export const KIND_ROUTES = Object.freeze({
  connector: Object.freeze({
    table: 'connectors',
    writer: 'connectProvider (browser, as the signed-in human under RLS) then decide_discovery_proposal stamps the id',
  }),
  guardrail: Object.freeze({
    table: 'guardrail_rules',
    writer: 'addGuardrailRule (browser, under RLS) then decide_discovery_proposal stamps the id',
  }),
  procedure: Object.freeze({
    table: 'playbook_definitions',
    writer: 'playbook-draft edge function then decide_discovery_proposal stamps the id',
  }),
  employee: Object.freeze({
    table: 'digital_employees',
    writer: 'instantiate_role_archetype + install_role_kit + install_role_systems, inside decide_discovery_proposal',
    // ⚠ Two reasons this predicate is here, and they agree.
    // (1) The standing prohibition: nothing in this task may read or write a
    //     digital_employees row with is_workforce_assistant = true. The
    //     resolver returns a BOOLEAN and never a column value, and an
    //     assistant row is excluded from what it can answer YES about.
    // (2) It is also the correct semantics. instantiate_role_archetype does
    //     not mint Workspace Assistants; a discovery proposal whose
    //     created_object_id pointed at one would be a proposal claiming
    //     credit for the workspace's own admin desk, which is a finding, not
    //     a pass.
    // ⚠ Deleting this line used to cost nothing — the positive control
    // applied the SAME predicate to the SAME table, so both sides of the
    // comparison moved together. EXPECTED_KIND_EXCLUSIONS is the independent
    // statement that makes deleting it go red, in two separate arms.
    extra: 'not coalesce(_o.is_workforce_assistant, false)',
  }),
  trust_rule: Object.freeze({
    table: 'trust_policies',
    writer: 'seed_de_trust_policy + set_trust_ladder, inside decide_discovery_proposal (both in ONE sub-block)',
  }),
});

/**
 * THE SAME FACT, STATED INDEPENDENTLY — and the reason it is not DRY.
 *
 * Every arm of the route family used to be DERIVED FROM KIND_ROUTES:
 * routeTablesSql() asked to_regclass about the map's own table, the resolver
 * was built from the map's own table, and the positive control sampled from
 * the map's own table. So pointing a kind at any LIVE table — `guardrail ->
 * de_conversations` — made all three answer correctly and the whole section
 * went silent in every channel it has. "The table exists" was never the
 * question; "is it the table the writer creates into" was.
 *
 * This map is that second statement, written once, used by:
 *   · the route arm, which DIFFS it against KIND_ROUTES in both directions;
 *   · resolverControlSql(), whose samples are drawn from THESE tables and
 *     handed to a resolver built from KIND_ROUTES — so a mismatch makes the
 *     positive control answer false against LIVE data, not against a literal.
 *
 * ⚠ Honest about its limits: this raises the cost of a per-kind exemption
 * from one line to two, and makes one of those two contradict live evidence.
 * It is not proof from the writer's own definition — three of the five
 * writers are browser TypeScript (connectProvider, addGuardrailRule, the
 * playbook-draft edge function), so there is no pg_get_functiondef to diff.
 * Do not upgrade this comment into a claim it does not make.
 */
export const EXPECTED_KIND_TABLES = Object.freeze({
  connector: 'connectors',
  guardrail: 'guardrail_rules',
  procedure: 'playbook_definitions',
  employee: 'digital_employees',
  trust_rule: 'trust_policies',
});

/**
 * ROWS A ROUTE'S RESOLVER MUST REFUSE, stated independently of the `extra`
 * predicate that implements the refusal.
 *
 * Keyed by kind; the value is a SQL boolean over `_s`, TRUE for exactly the
 * rows the resolver must answer FALSE about. resolverControlSql() samples one
 * such row and asserts the resolver rejects it, and samples the negation for
 * the positive arm — so neither arm is drawn through KIND_ROUTES.extra, and
 * deleting `extra` fires here (live) and in the pure-JS declaration arm.
 *
 * ⚠ Reading a Workspace Assistant's id is deliberate and bounded. The
 * standing prohibition is on reading or WRITING an is_workforce_assistant
 * row's DATA; this expression selects one id inside SQL, uses it only as the
 * right-hand side of an existence test, and returns a boolean. No assistant
 * id, name or column value ever leaves the database. Measured 2026-08-15: 18
 * assistant rows and 109 non-assistant rows exist, so both samples resolve.
 */
export const EXPECTED_KIND_EXCLUSIONS = Object.freeze({
  employee: 'coalesce(_s.is_workforce_assistant, false)',
});

/** The three states from which a proposal can never return to `pending`. */
export const TERMINAL_STATES = Object.freeze(['accepted', 'declined', 'parked']);
/** ...and the states that are not terminal. The two lists together must equal
 *  what discovery_proposals_state_check admits, in BOTH directions — see the
 *  STATES arm. A state this file has never heard of is skipped by every row
 *  assertion while still counting in the denominator, which is the quietest
 *  way a per-row gate can stop being one. */
export const NON_TERMINAL_STATES = Object.freeze(['pending']);
const TERMINAL = new Set(TERMINAL_STATES);
const KNOWN_STATES = new Set([...TERMINAL_STATES, ...NON_TERMINAL_STATES]);

/** The uuid the negative resolver control uses. gen_random_uuid() never
 *  produces the nil uuid, and no table in this schema defaults to it. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Values a CHECK ((col = ANY (ARRAY['a'::text, ...]))) definition admits.
 *  Same one-line parser provider-catalog-check.mjs uses on the connectors
 *  provider CHECK — one shape of constraint, one way of reading it. Used for
 *  BOTH discovery_proposals_kind_check and discovery_proposals_state_check,
 *  which are the same shape. */
export function kindCheckValues(def) {
  return new Set([...String(def ?? '').matchAll(/'([^']+)'::text/g)].map((m) => m[1]));
}

/** Both enum CHECKs on the table, in one round trip, so certify.mjs and the
 *  mutation harness cannot fetch different vocabularies. */
export function constraintDefsSql() {
  return `select conname, pg_get_constraintdef(oid) as def
            from pg_constraint
           where conrelid = 'public.discovery_proposals'::regclass
             and conname in ('discovery_proposals_kind_check','discovery_proposals_state_check')`;
}

/** `case <kindExpr> when 'connector' then 'connectors' … end` — the EXPECTED
 *  table name as SQL, for the audit-event cross-check below. */
function expectedTableCaseSql(kindExpr) {
  const arms = Object.entries(EXPECTED_KIND_TABLES)
    .map(([k, t]) => `when '${k}' then '${t}'`).join(' ');
  return `case ${kindExpr} ${arms} else null end`;
}

/**
 * THE RESOLVER. Does `idExpr` name a row that is actually alive in the table
 * that `kindExpr`'s writer creates into, AND OWNED BY `tenantExpr`?
 *
 * Returns NULL when there is no id to resolve, and NULL when the kind has no
 * arm — deliberately three-valued, because "there is no route for this kind"
 * and "the route found nothing" are different findings and the caller reports
 * them differently.
 *
 * It is built from KIND_ROUTES rather than written out, so a route and its
 * resolver arm cannot drift: a kind added to the map gains an arm here in the
 * same edit, and the controls below fail loudly if it somehow does not.
 *
 * ⚠ THE TENANT PREDICATE IS NOT OPTIONAL, and `tenantExpr` therefore has no
 * default. Without it, a created_object_id pointing at ANOTHER WORKSPACE'S
 * connector resolves true and certify calls it clean — the same shape as the
 * SECDEF functions migrations 662-664 exist to fix, where a tenant id passed
 * as a parameter became the authorisation. All five target tables carry
 * tenant_id (measured 2026-08-15). Dropping the argument throws here rather
 * than silently widening the resolver, and the `cross_tenant` control arm
 * fires against live data if the predicate is removed from the string.
 *
 * @param {string} kindExpr   a SQL expression yielding the proposal's kind
 * @param {string} idExpr     a SQL expression yielding a uuid (or null)
 * @param {string} tenantExpr a SQL expression yielding the OWNING tenant's id
 */
export function objectResolvesSql(kindExpr, idExpr, tenantExpr) {
  if (typeof tenantExpr !== 'string' || tenantExpr.trim() === '') {
    throw new Error('objectResolvesSql: tenantExpr is REQUIRED — a resolver with no tenant predicate answers true for another workspace\'s row, which is the whole defect the cross_tenant control exists to catch');
  }
  const arms = Object.entries(KIND_ROUTES).map(([kind, r]) =>
    `        when ${kindExpr} = '${kind}' then exists (select 1 from public.${r.table} _o`
    + ` where _o.id = ${idExpr} and _o.tenant_id = ${tenantExpr}${r.extra ? ` and ${r.extra}` : ''})`).join('\n');
  return `case\n        when ${idExpr} is null then null\n${arms}\n        else null\n      end`;
}

/**
 * DELIBERATELY TENANT-BLIND, and used for exactly one thing: telling "the
 * object is gone" apart from "the object belongs to somebody else".
 *
 * ⚠ This is NOT the resolver and must never be substituted for it. It exists
 * because those two produce very different findings — a deleted object is a
 * customer's decision, a cross-tenant pointer is a security event — and a
 * single false verdict cannot say which. Never widen objectResolvesSql to
 * match this; the direction of that mistake is silent.
 */
export function objectExistsAnyTenantSql(kindExpr, idExpr) {
  const arms = Object.entries(KIND_ROUTES).map(([kind, r]) =>
    `        when ${kindExpr} = '${kind}' then exists (select 1 from public.${r.table} _x`
    + ` where _x.id = ${idExpr})`).join('\n');
  return `case\n        when ${idExpr} is null then null\n${arms}\n        else null\n      end`;
}

/**
 * DID THE GOVERNED PATH RECORD CREATING THIS OBJECT?
 *
 * Not decoration — this is what lets an accepted proposal whose object the
 * customer LATER DELETED be told apart from an accepted proposal that never
 * created anything. `authenticated` holds DELETE on `connectors` (measured
 * true; false for the other four target tables), that DELETE is wired to live
 * UI (connectorApi.ts:1108 from LiveConnectorsPage and McpServersPage), and
 * nothing in the product can retire a decided proposal — authenticated holds
 * no UPDATE and no DELETE on discovery_proposals and the RPC refuses a
 * non-pending row. Without this distinction the first customer who removes a
 * connector they accepted turns certify permanently, unclearably red, which
 * is the "tick everyone learns to ignore" outcome certify exists to remove.
 *
 * ⚠⚠ WHY THIS IS NOT A CHECK THAT CANNOT FAIL — read before weakening it.
 * The relief is deliberately narrow. It requires an audit event that
 *   (a) belongs to the SAME tenant as the proposal,
 *   (b) is a discovery_proposal_decision with decision='accepted',
 *   (c) names THIS proposal_id,
 *   (d) names EXACTLY the created_object_id the row still carries, and
 *   (e) names the created_object_table the INDEPENDENT expectation
 *       (EXPECTED_KIND_TABLES) gives for this kind — not the route map's.
 * A dangling uuid that was never created satisfies none of them, so the
 * dangling assertion still goes red — that is the whole point, and there is a
 * mutation case pinned on it in both directions. What the relief costs is
 * stated plainly: it trusts the audit event's own record of what was created,
 * which is weaker than the object's existence. Two things bound that cost —
 * the audit chain is hash-linked over `detail`, and `authenticated` holds no
 * INSERT/UPDATE/DELETE on audit_events (measured 2026-08-15; asserted on
 * every run by the audit-write perimeter arm, so the day that changes this
 * relief goes red rather than quietly becoming forgeable).
 */
function hasCreationAuditSql() {
  return `exists (
              select 1 from public.audit_events ae
               where ae.tenant_id = p.tenant_id
                 and ae.detail ->> 'kind' = 'discovery_proposal_decision'
                 and ae.detail ->> 'decision' = 'accepted'
                 and ae.detail ->> 'proposal_id' = p.id::text
                 and ae.detail ->> 'created_object_id' = p.created_object_id::text
                 and ae.detail ->> 'created_object_table' = ${expectedTableCaseSql('p.kind')})`;
}

/** Every proposal row, with the dangling-uuid verdict computed alongside it. */
export function proposalsSql() {
  return `select p.id::text as id,
                 p.kind,
                 p.state,
                 p.tenant_id::text as tenant_id,
                 (p.decided_by is not null) as has_decided_by,
                 (p.decided_at is not null) as has_decided_at,
                 p.created_object_id::text as created_object_id,
                 (p.last_error is not null) as has_last_error,
                 p.attempts,
                 ${objectResolvesSql('p.kind', 'p.created_object_id', 'p.tenant_id')} as object_resolves,
                 ${objectExistsAnyTenantSql('p.kind', 'p.created_object_id')} as object_exists_anywhere,
                 ${hasCreationAuditSql()} as has_creation_audit
            from public.discovery_proposals p`;
}

/**
 * THE ARM THAT STOPS THE DANGLING-UUID ASSERTION BEING THEATRE.
 *
 * Up to four controls per routable kind, all driving the resolver expression
 * above — the same text proposalsSql() embeds, not a copy of it. Every sample
 * is drawn from EXPECTED_KIND_TABLES and EXPECTED_KIND_EXCLUSIONS, never from
 * KIND_ROUTES, so no arm can be satisfied by editing the map:
 *
 *   negative     — the nil uuid, which exists in no table. Must answer false.
 *                  If it answers true, the resolver cannot detect a dangling
 *                  id and every accepted row would pass regardless. If it
 *                  answers NULL, the resolver has no arm for a kind
 *                  KIND_ROUTES calls routable.
 *   positive     — the id AND tenant of a row that demonstrably exists in the
 *                  EXPECTED table. Must answer true. A resolver joined on the
 *                  wrong column, or pointed at the wrong table, answers false
 *                  here — which is what says so on the day it happens rather
 *                  than the day someone accepts a proposal.
 *   cross_tenant — that same real row's id paired with a DIFFERENT tenant's
 *                  id. Must answer false. This is the only arm that can see
 *                  the tenant predicate: delete it and every other arm still
 *                  answers correctly while a created_object_id pointing at
 *                  another workspace's connector reads as clean.
 *   excluded     — where EXPECTED_KIND_EXCLUSIONS names one, a row the
 *                  exclusion is supposed to reject (today: an
 *                  is_workforce_assistant employee), with its OWN tenant, so
 *                  the only thing that can make it resolve is the missing
 *                  exclusion. Must answer false. Deleting `extra` from
 *                  KIND_ROUTES used to cost nothing at all.
 *
 * `sample_available` is reported rather than assumed: an empty (or
 * single-tenant) target table has no sample, and a missing sample is printed
 * as a named gap, not silently treated as a pass. Measured 2026-08-15: all
 * five tables are non-empty (109 non-assistant employees + 18 assistants, 90
 * trust policies, 201 guardrail rules, 26 connectors, 107 playbook
 * definitions) and each spans 17-18 of the 18 tenants, so all four arms have
 * samples today.
 *
 * ⚠ Both scalar subqueries in a pair carry the SAME `order by _s.id limit 1`,
 * so the id and the tenant provably come from the SAME row. Two bare LIMIT 1
 * subqueries could legally pick different rows and the positive arm would go
 * red for a reason that is not its own.
 */
export function resolverControlSql() {
  const parts = [];
  for (const kind of Object.keys(KIND_ROUTES)) {
    // Hardcoded on purpose. Sampling from KIND_ROUTES[kind].table would put
    // the same value on both sides of every comparison below.
    const tbl = EXPECTED_KIND_TABLES[kind];
    if (!tbl) {
      // A kind in the map with no independent expectation cannot be sampled
      // honestly. Emit a row that the decider REFUSES rather than skipping
      // the kind silently, which would drop it out of the control count too.
      parts.push(`select '${kind}'::text as kind, 'positive'::text as arm, false as sample_available, null::boolean as resolves`);
      continue;
    }
    const excl = EXPECTED_KIND_EXCLUSIONS[kind] ?? null;
    const pick = (col, where) => `(select _s.${col} from public.${tbl} _s`
      + `${where ? ` where ${where}` : ''} order by _s.id limit 1)`;

    const okId = pick('id', excl ? `not (${excl})` : null);
    const okTenant = pick('tenant_id', excl ? `not (${excl})` : null);
    const otherTenant = `(select _t.id from public.tenants _t where _t.id is distinct from ${okTenant} order by _t.id limit 1)`;

    parts.push(`select '${kind}'::text as kind, 'negative'::text as arm, true as sample_available,
                 ${objectResolvesSql(`'${kind}'`, `'${NIL_UUID}'::uuid`, `'${NIL_UUID}'::uuid`)} as resolves`);
    parts.push(`select '${kind}'::text, 'positive'::text, (${okId} is not null),
                 ${objectResolvesSql(`'${kind}'`, okId, okTenant)}`);
    parts.push(`select '${kind}'::text, 'cross_tenant'::text, (${okId} is not null and ${otherTenant} is not null),
                 ${objectResolvesSql(`'${kind}'`, okId, otherTenant)}`);
    if (excl) {
      const exId = pick('id', excl);
      const exTenant = pick('tenant_id', excl);
      parts.push(`select '${kind}'::text, 'excluded'::text, (${exId} is not null),
                 ${objectResolvesSql(`'${kind}'`, exId, exTenant)}`);
    }
  }
  return parts.join('\n          union all\n          ');
}

/** to_regclass for every routed table AND every expected table, in one round
 *  trip. Both sets, because the route arm has to be able to say "the map
 *  points somewhere live but wrong" — which needs the liveness of the table
 *  the map names AND the one it should have named. */
export function routeTablesSql() {
  const tables = [...new Set([
    ...Object.values(KIND_ROUTES).map((r) => r.table),
    ...Object.values(EXPECTED_KIND_TABLES),
  ])];
  return `select t as tbl, (to_regclass('public.' || t) is not null) as table_live
            from unnest(array[${tables.map((t) => `'${t}'`).join(', ')}]::text[]) t`;
}

/** Every overload of the decision RPC, by oid — never by a text signature.
 *  has_function_privilege on a NAME Postgres cannot resolve raises 42883, and
 *  migration 741 is not applied yet; an ERROR here would make this section red
 *  for a reason that is not its own. Zero rows is a state this file reasons
 *  about explicitly (see the decider arms) rather than a crash. */
export function deciderSql() {
  return `select p.oid::regprocedure::text as sig,
                 has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                 has_function_privilege('service_role',  p.oid, 'execute') as service_role,
                 has_function_privilege('anon',          p.oid, 'execute') as anon,
                 has_function_privilege('public',        p.oid, 'execute') as pub,
                 p.prosecdef as secdef
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
           order by 1`;
}

/** Table privileges this section reasons about — the decision table's, and
 *  audit_events', because the "was it ever created" relief is only admissible
 *  while nobody outside the governed path can write an audit event. Defined
 *  once and imported by both callers so certify and the mutation harness
 *  cannot end up asking production two different questions. */
export function privSql() {
  return `select
      has_table_privilege('authenticated','public.discovery_proposals','select') as tbl_select_authenticated,
      has_table_privilege('authenticated','public.discovery_proposals','insert') as tbl_insert_authenticated,
      has_table_privilege('authenticated','public.discovery_proposals','update') as tbl_update_authenticated,
      has_table_privilege('authenticated','public.discovery_proposals','delete') as tbl_delete_authenticated,
      has_table_privilege('anon','public.discovery_proposals','select') as tbl_select_anon,
      has_table_privilege('authenticated','public.audit_events','insert') as audit_insert_authenticated,
      has_table_privilege('authenticated','public.audit_events','update') as audit_update_authenticated,
      has_table_privilege('authenticated','public.audit_events','delete') as audit_delete_authenticated,
      has_table_privilege('anon','public.audit_events','insert') as audit_insert_anon`;
}

/** privSql()'s row -> the shape discoveryProposalFailures reads. One mapping,
 *  two callers, so a renamed column cannot silently become `undefined` (which
 *  is falsy, which is "no privilege", which is a pass) in one of them. */
export function mapPriv(row) {
  return {
    tblSelectAuthenticated: row?.tbl_select_authenticated,
    tblInsertAuthenticated: row?.tbl_insert_authenticated,
    tblUpdateAuthenticated: row?.tbl_update_authenticated,
    tblDeleteAuthenticated: row?.tbl_delete_authenticated,
    tblSelectAnon: row?.tbl_select_anon,
    auditInsertAuthenticated: row?.audit_insert_authenticated,
    auditUpdateAuthenticated: row?.audit_update_authenticated,
    auditDeleteAuthenticated: row?.audit_delete_authenticated,
    auditInsertAnon: row?.audit_insert_anon,
  };
}

/**
 * @param {object} s live state, all of it already fetched
 * @param {object[]} s.proposals  proposalsSql() rows — EVERY row, unfiltered
 * @param {object[]} s.controls   resolverControlSql() rows
 * @param {object[]} s.routeTables routeTablesSql() rows
 * @param {Set<string>|string[]} s.kindsInCheck values discovery_proposals_kind_check admits
 * @param {Set<string>|string[]} s.statesInCheck values discovery_proposals_state_check admits
 * @param {object} s.priv         privilege booleans, see mapPriv
 * @param {object[]} s.deciders   deciderSql() rows (may be empty — 741 not applied)
 * @param {object}  [s.routes]    KIND_ROUTES override. certify NEVER passes this —
 *   it exists so scripts/certify-mutation-test.mjs can perform the exact edits
 *   someone would make to buy silence (adding conversation_type to the map;
 *   pointing a kind at a live-but-wrong table) and watch the live to_regclass
 *   and expectation arms refuse them. A gate whose un-gameability is only
 *   asserted in a comment is not asserted.
 * @returns {{failures: string[], notes: string[], proposalsExamined: number,
 *            terminalExamined: number, acceptedExamined: number,
 *            retiredExamined: number, routesExamined: number,
 *            expectationsExamined: number, statesExamined: number,
 *            controlsExamined: number, kindsPresent: string[]}}
 */
export function discoveryProposalFailures(s) {
  const proposals = s.proposals ?? [];
  const controls = s.controls ?? [];
  const routeTables = s.routeTables ?? [];
  const kindsInCheck = s.kindsInCheck instanceof Set ? s.kindsInCheck : new Set(s.kindsInCheck ?? []);
  const statesInCheck = s.statesInCheck instanceof Set ? s.statesInCheck : new Set(s.statesInCheck ?? []);
  const priv = s.priv ?? {};
  const deciders = s.deciders ?? [];
  const routes = s.routes ?? KIND_ROUTES;
  const failures = [];
  const notes = [];

  const routeKinds = Object.keys(routes);
  const liveTables = new Map(routeTables.map((r) => [r.tbl, r.table_live === true]));

  // ── THE ROUTES ──────────────────────────────────────────────────────────
  // Exercised on every run regardless of how many proposals exist. This is
  // part of what stops an empty table from making this section vacuous.
  if (routeKinds.length === 0) {
    failures.push('KIND_ROUTES is EMPTY — no kind can be routed, so the "kinds the writers can route" assertion compares every proposal against nothing and can never fire');
  }
  if (routeTables.length === 0) {
    failures.push('examined ZERO route target tables — the to_regclass fetch returned nothing, so "the route points at a real table" was not actually checked; a route pointing at a dropped table would pass');
  }
  for (const kind of routeKinds) {
    const tbl = routes[kind].table;
    const live = liveTables.get(tbl);
    if (live === undefined) {
      failures.push(`kind "${kind}" routes to public.${tbl}, which was not resolved by the route-table fetch — the route is unverified, and an unverified route is not a route`);
    } else if (!live) {
      failures.push(`kind "${kind}" is declared routable into public.${tbl}, which to_regclass cannot resolve — a writer cannot create a row in a table that does not exist. If this fired because a kind was added to KIND_ROUTES to silence a row assertion, that is the exemption task-3-contract.md S8 item 14 forbids.`);
    }
    if (kindsInCheck.size && !kindsInCheck.has(kind)) {
      failures.push(`kind "${kind}" is declared routable but discovery_proposals_kind_check does not admit it — no row can ever carry that kind, so the route is dead code claiming coverage`);
    }
  }
  if (kindsInCheck.size === 0) {
    failures.push('discovery_proposals_kind_check yielded ZERO admitted kind values — the constraint was dropped, renamed, or the parser stopped matching it; either way the "routable kind" comparison lost the vocabulary it compares against');
  }

  // ── THE ROUTES, SECOND STATEMENT ────────────────────────────────────────
  // "The table exists" was never the question. KIND_ROUTES is otherwise a
  // per-kind exemption switch: point a kind at ANY live table and to_regclass
  // says yes, the resolver is built from the same entry so it answers
  // correctly, and the section goes silent in every channel it has.
  // EXPECTED_KIND_TABLES is the independent statement; both directions are
  // checked, because DROPPING a kind from the map is the other half of the
  // same exemption (a kind nobody routes has no row assertion to fail).
  let expectationsExamined = 0;
  for (const kind of routeKinds) {
    const expected = EXPECTED_KIND_TABLES[kind];
    expectationsExamined++;
    if (expected === undefined) {
      failures.push(`kind "${kind}" is declared routable in KIND_ROUTES but has NO entry in EXPECTED_KIND_TABLES — a route with only one statement behind it is a per-kind exemption switch. Declare the kind in both places, in the same edit as its writer.`);
    } else if (routes[kind].table !== expected) {
      failures.push(`kind "${kind}" routes to public.${routes[kind].table}, but EXPECTED_KIND_TABLES independently says public.${expected}. A route pointed at a LIVE BUT WRONG table passes to_regclass and drags the resolver with it, which is exactly how this section could be silenced without a single red. One of the two statements is wrong; find out which before changing either.`);
    }
  }
  for (const kind of Object.keys(EXPECTED_KIND_TABLES)) {
    if (!routeKinds.includes(kind)) {
      expectationsExamined++;
      failures.push(`EXPECTED_KIND_TABLES declares kind "${kind}" routable into public.${EXPECTED_KIND_TABLES[kind]}, but KIND_ROUTES does not route it at all — dropping a kind from the map removes every row assertion for it silently, which buys the same silence as a bogus route`);
    }
  }
  // The exclusion, in both directions, in pure JS — the live half is the
  // `excluded` control arm below. Two independent detectors, because the
  // single one that existed (a positive control drawing the same predicate
  // from the same map entry) could not fail.
  for (const kind of Object.keys(EXPECTED_KIND_EXCLUSIONS)) {
    expectationsExamined++;
    const extra = routes[kind]?.extra;
    if (!routeKinds.includes(kind)) {
      failures.push(`EXPECTED_KIND_EXCLUSIONS names kind "${kind}", which KIND_ROUTES does not route — the exclusion has nothing to apply to`);
    } else if (typeof extra !== 'string' || extra.trim() === '') {
      failures.push(`kind "${kind}" must exclude rows matching "${EXPECTED_KIND_EXCLUSIONS[kind]}" from what its resolver can answer YES about, and KIND_ROUTES carries no \`extra\` predicate for it. For employee this is the is_workforce_assistant exclusion: without it, an accepted proposal stamping the Workspace Assistant's id reads as a legitimately created employee.`);
    }
  }
  for (const kind of routeKinds) {
    if (routes[kind].extra && !EXPECTED_KIND_EXCLUSIONS[kind]) {
      expectationsExamined++;
      failures.push(`kind "${kind}" carries an \`extra\` resolver predicate that EXPECTED_KIND_EXCLUSIONS does not declare — the predicate is therefore driven by no control arm, and deleting it would cost nothing. State what it must reject, or remove it.`);
    }
  }
  const admittedButUnroutable = [...kindsInCheck].filter((k) => !routeKinds.includes(k)).sort();

  // ── WHICH RESOLVER THE ROW ARM ACTUALLY USES ────────────────────────────
  // The control arms drive objectResolvesSql. They cannot see WHICH resolver
  // proposalsSql() embeds — and this file now contains a second, deliberately
  // tenant-blind one (objectExistsAnyTenantSql) whose only job is to tell
  // "gone" from "another workspace's". Swap the two and every control arm
  // still answers correctly while the row assertion quietly loses its tenant
  // predicate: a control set that proves an expression is right proves nothing
  // about an expression nobody wired in. So the wiring is compared, not
  // assumed. Constant across fixtures on purpose — this is a property of the
  // file, and if it is ever false it is false for every run.
  expectationsExamined++;
  const wiredResolver = objectResolvesSql('p.kind', 'p.created_object_id', 'p.tenant_id');
  if (!proposalsSql().includes(wiredResolver)) {
    failures.push('proposalsSql() no longer embeds the TENANT-SCOPED resolver that the control arms drive. Every negative/positive/cross_tenant/excluded control would keep answering correctly while the per-row dangling assertion ran against a different expression — most likely objectExistsAnyTenantSql, which has no tenant predicate by design. A control set proves nothing about an expression nobody wired in.');
  }

  // ── THE STATES ──────────────────────────────────────────────────────────
  // Every row assertion below classifies a row by state. TERMINAL_STATES was
  // a JS literal compared against nothing, unlike KIND_ROUTES which IS
  // compared — so a future `expired` state would be admitted by the CHECK,
  // written by something, and skipped by every per-row arm here while still
  // counting in the denominator. Closed both ways.
  if (statesInCheck.size === 0) {
    failures.push('discovery_proposals_state_check yielded ZERO admitted state values — the constraint was dropped, renamed, or the parser stopped matching it; every row arm below classifies rows by state against a vocabulary that is now empty');
  }
  for (const st of statesInCheck) {
    if (!KNOWN_STATES.has(st)) {
      failures.push(`discovery_proposals_state_check admits state "${st}", which this checker classifies as neither terminal nor pending. Every per-row assertion (terminal-needs-decided_by/at, accepted-needs-created_object_id, pending-must-not-wear-a-decider, pending-attempts-needs-a-reason) would SKIP a row in that state and still count it in the denominator. Classify it in TERMINAL_STATES or NON_TERMINAL_STATES before anything can write it.`);
    }
  }
  for (const st of KNOWN_STATES) {
    if (statesInCheck.size && !statesInCheck.has(st)) {
      failures.push(`this checker classifies "${st}" as a discovery_proposals state, but discovery_proposals_state_check does not admit it — no row can ever carry it, so every assertion keyed on that state compares nothing while looking exactly like one that passed`);
    }
  }

  // ── THE RESOLVER CONTROLS ───────────────────────────────────────────────
  // The other half. The dangling-uuid assertion is only as good as the
  // expression that decides "does this uuid name a live row", and a resolver
  // that says yes to everything is invisible from the row side.
  if (controls.length === 0) {
    failures.push('examined ZERO resolver controls — the dangling-created_object_id assertion rests entirely on a SQL resolver that was never driven in any direction this run, which is exactly the shape of a check that cannot fail');
  }
  const missingSamples = [];
  for (const c of controls) {
    const tblOf = () => `public.${EXPECTED_KIND_TABLES[c.kind] ?? routes[c.kind]?.table ?? '?'}`;
    if (c.arm === 'negative') {
      if (c.resolves === true) {
        failures.push(`RESOLVER BROKEN for kind "${c.kind}": it reports that ${NIL_UUID} — a uuid that exists in no table — resolves to a live row. With this resolver, an accepted proposal carrying ANY dangling uuid would pass, so the assertion below is incapable of failing.`);
      } else if (c.resolves === null || c.resolves === undefined) {
        failures.push(`RESOLVER HAS NO ARM for kind "${c.kind}", which KIND_ROUTES declares routable — objectResolvesSql fell through to its else branch, so created_object_id for this kind is never checked against anything`);
      }
    } else if (c.arm === 'positive') {
      if (c.sample_available === false) {
        missingSamples.push(`${c.kind}/positive (${tblOf()} has no sample row)`);
      } else if (c.resolves !== true) {
        failures.push(`RESOLVER BROKEN for kind "${c.kind}": handed the id AND owning tenant of a row that demonstrably exists in ${tblOf()} — the table EXPECTED_KIND_TABLES names, not the one KIND_ROUTES names — it answered ${JSON.stringify(c.resolves)} instead of true. Either the resolver joins on the wrong column, or KIND_ROUTES points this kind at a different table than the one its writer creates into. Every future accepted proposal of this kind would be reported dangling when it is not.`);
      }
    } else if (c.arm === 'cross_tenant') {
      if (c.sample_available === false) {
        missingSamples.push(`${c.kind}/cross_tenant (${tblOf()} has no row, or only one tenant exists to contrast with)`);
      } else if (c.resolves !== false) {
        failures.push(`RESOLVER HAS NO TENANT PREDICATE for kind "${c.kind}": handed a real row's id paired with a DIFFERENT tenant's id, it answered ${JSON.stringify(c.resolves)} instead of false. A created_object_id pointing at ANOTHER WORKSPACE'S row therefore reads as a legitimately created object, and certify calls it clean — the same shape as a tenant id passed as a parameter becoming the authorisation (migrations 662-664).`);
      }
    } else if (c.arm === 'excluded') {
      if (c.sample_available === false) {
        missingSamples.push(`${c.kind}/excluded (no row in ${tblOf()} matches "${EXPECTED_KIND_EXCLUSIONS[c.kind] ?? '?'}")`);
      } else if (c.resolves !== false) {
        failures.push(`RESOLVER EXCLUSION GONE for kind "${c.kind}": handed a row that "${EXPECTED_KIND_EXCLUSIONS[c.kind] ?? '?'}" identifies as one it must REFUSE, it answered ${JSON.stringify(c.resolves)} instead of false. For employee that row is a Workspace Assistant: an accept stamping its id would be a proposal claiming credit for the workspace's own admin desk, and this section would report it clean.`);
      }
    } else {
      failures.push(`unknown resolver control arm "${c.arm}" for kind "${c.kind}" — the control set does not match what this function knows how to judge`);
    }
  }
  for (const kind of routeKinds) {
    const arms = ['negative', 'positive', 'cross_tenant'];
    if (EXPECTED_KIND_EXCLUSIONS[kind]) arms.push('excluded');
    for (const arm of arms) {
      if (!controls.some((c) => c.kind === kind && c.arm === arm)) {
        failures.push(`no ${arm} resolver control was run for routable kind "${kind}" — a direction the resolver is never driven in is a direction whose defect no row fixture could ever reveal`);
      }
    }
  }
  if (missingSamples.length) {
    notes.push(`discovery-proposal-decisions: NO RESOLVER SAMPLE for ${missingSamples.join(', ')} — ${missingSamples.length} control arm(s) were NOT driven this run. Not a pass for those arms.`);
  }

  // ── THE AUDIT-WRITE PERIMETER ───────────────────────────────────────────
  // Unconditional, not "only when a row was relieved". The retired-object
  // relief further down reads an audit event as evidence that the governed
  // path created something; that is admissible only while the browser cannot
  // write one. Measured 2026-08-15: authenticated holds SELECT on
  // audit_events and nothing else, anon holds no INSERT.
  for (const [verb, key] of [['INSERT', 'auditInsertAuthenticated'], ['UPDATE', 'auditUpdateAuthenticated'], ['DELETE', 'auditDeleteAuthenticated']]) {
    if (priv[key]) {
      failures.push(`authenticated can ${verb} audit_events — the "this object was created and later deleted" relief below reads an audit event as evidence, and with this grant a browser can forge (or erase) that evidence. Either revoke it, or the relief must be withdrawn and an accepted proposal whose object is gone goes back to being an unclearable red.`);
    }
  }
  if (priv.auditInsertAnon) {
    failures.push('anon can INSERT audit_events — the audit trail the whole reconstruction argument rests on is writable by the anonymous internet');
  }

  // ── THE ROW ASSERTIONS (the plan's four) ────────────────────────────────
  const kindsPresent = [...new Set(proposals.map((p) => p.kind))].sort();
  let terminalExamined = 0;
  let acceptedExamined = 0;
  let retiredExamined = 0;
  const retired = [];

  for (const p of proposals) {
    const where = `discovery_proposals ${p.id} (kind=${p.kind}, state=${p.state})`;

    // 3. Every distinct kind present is one the writers can actually route.
    if (!routeKinds.includes(p.kind)) {
      failures.push(`${where}: kind "${p.kind}" is not one any writer can route — there is no ordinary validated writer and no target table for it, so this proposal can be shown to a customer and can never become a thing. Fix the emitter, never this list (task-3-contract.md S8 item 14).`);
    }
    // A state nothing here classifies is a row every arm below skips.
    if (!KNOWN_STATES.has(p.state)) {
      failures.push(`${where}: state "${p.state}" is one this checker classifies as neither terminal nor pending, so every assertion below skipped this row while the denominator still counted it — the quietest way a per-row gate stops being one`);
    }

    if (TERMINAL.has(p.state)) {
      terminalExamined++;
      // 1. No terminal state without BOTH decided_by and decided_at.
      // Two arms, not one, so the message says which half is missing —
      // decided_by absent means the decision has no human behind it (the
      // service_role accept the contract's S1 forbids); decided_at absent
      // means it has no position in the audit timeline.
      if (!p.has_decided_by) {
        failures.push(`${where}: reached a terminal state with NO decided_by — nobody is recorded as having made this decision. Under service_role auth.uid() is null, which is exactly how a decision loses its human (task-3-contract.md S1).`);
      }
      if (!p.has_decided_at) {
        failures.push(`${where}: reached a terminal state with NO decided_at — the decision cannot be placed in time or matched to its audit event`);
      }
    }

    if (p.state === 'accepted') {
      acceptedExamined++;
      // 2. No accepted row without a created_object_id.
      if (!p.created_object_id) {
        failures.push(`${where}: ACCEPTED with no created_object_id — the customer was told this became a real thing and nothing records what. task-3-contract.md S3 makes this state unreachable by claiming the row OUTSIDE the writer's sub-block and stamping the id in the same transaction; reaching it means state was flipped before the writer returned an id (S8 item 8).`);
      } else if (p.object_resolves === false && p.object_exists_anywhere === true) {
        // Worse than dangling, and a different finding: the id names a LIVE
        // row belonging to somebody else. Never relieved by an audit event —
        // a correct decision cannot have created another tenant's row.
        failures.push(`${where}: ACCEPTED and carries created_object_id ${p.created_object_id}, which names a LIVE row in ${routes[p.kind]?.table ? `public.${routes[p.kind].table}` : 'its target table'} BELONGING TO ANOTHER WORKSPACE. A created-object id is not its own authorisation (741's Zone-3 guard says so for connector); this is the cross-tenant pointer that guard exists to prevent, recorded as a completed decision.`);
      } else if (p.object_resolves === false && p.has_creation_audit === true) {
        // 4b. RESOLVES TO NOTHING *NOW*, but the governed path recorded
        // creating exactly this object. `authenticated` holds DELETE on
        // connectors and it is wired to live UI, so this is a customer
        // decision, not a defect — and there is nothing in the product that
        // could retire the proposal, so treating it as a failure would make
        // certify permanently, unclearably red. Reported, never silent.
        retiredExamined++;
        retired.push(`${p.id} (${p.kind})`);
      } else if (p.object_resolves === false) {
        // 4. The one this task designed: a stored uuid is not a created
        // thing. Reached only when NO audit event records this proposal
        // creating this object — a uuid that was never created has none.
        const target = routes[p.kind]?.table
          ? `public.${routes[p.kind].table}`
          : `any table (kind "${p.kind}" has no route, so there is not even a table it could be in)`;
        failures.push(`${where}: ACCEPTED and carries created_object_id ${p.created_object_id}, which resolves to NO live row in ${target} for this workspace, AND no audit event records this proposal ever creating it (same tenant, decision=accepted, matching proposal_id, matching created_object_id, matching created_object_table). This is the stored-marker-as-truth trap: the proposal, the card and the audit event all say the thing exists, and it does not — and nothing says it ever did.`);
      } else if (p.object_resolves === null || p.object_resolves === undefined) {
        failures.push(`${where}: ACCEPTED and carries created_object_id ${p.created_object_id}, but the resolver returned NO VERDICT for kind "${p.kind}" (it fell through to its else branch), so nothing checked whether that id names anything at all — unchecked is not clean`);
      } else if (p.has_creation_audit === false) {
        // The other direction on the same evidence, and the reason the
        // relief above is not a one-way valve: an accepted row whose object
        // exists but which NO audit event records deciding means the stamp
        // arrived from somewhere other than decide_discovery_proposal. Two
        // paths, one counted.
        failures.push(`${where}: ACCEPTED with a created_object_id that resolves, but NO audit event records this decision creating it. Every accept through decide_discovery_proposal writes state, created_object_id and the audit event in ONE transaction (task-3-contract.md S3/S6), so a row with the first two and not the third was stamped by a second path — and a second path has its own grants, its own authority model and no reconstruction record.`);
      }
      // The accept path's last write is `set created_object_id = …,
      // last_error = null`. An accepted row still carrying a refusal reason
      // means the success and failure arms both ran, or the success arm ran
      // partially — either way the row is not what it claims.
      if (p.has_last_error) {
        failures.push(`${where}: ACCEPTED but still carries last_error — the accept path clears it on success (task-3-contract.md S3), so this row went through both arms or through a half of one`);
      }
    } else if (p.created_object_id) {
      // The inverse of assertion 2, and the worse half of it: a proposal that
      // was NOT accepted must not have created anything. The plan's Step 1
      // test says so in as many words — "a declined proposal creates nothing".
      // A `pending` row with an id is the Zone-3 revert having left the stamp
      // behind, which would make a retry create a SECOND object.
      failures.push(`${where}: NOT accepted, yet carries created_object_id ${p.created_object_id} — a proposal the customer did not accept has something recorded against it. If state is pending this is the revert-to-pending path leaving its stamp, and the next retry creates a second object.`);
    }

    // ── The refusal reason and its counter are written TOGETHER ───────────
    // Plan Task 3 Step 3: "a writer that refuses must leave the proposal
    // pending with the reason visible. A proposal that silently fails to
    // become a thing is the worst outcome available here." Contract S3 writes
    // last_error, last_error_at and attempts = attempts + 1 in ONE statement,
    // so the two can only disagree if a later edit split them — and the
    // direction that matters is a moved counter with no reason behind it,
    // which is exactly the silent failure Step 3 exists to make impossible.
    if (p.has_last_error && p.attempts === 0) {
      failures.push(`${where}: carries last_error but attempts is 0 — the reason and the counter are written in the SAME statement (task-3-contract.md S3), so one of the two writes was dropped and the retry count no longer reflects what happened`);
    }
    if (p.state === 'pending' && p.attempts > 0 && !p.has_last_error) {
      failures.push(`${where}: PENDING after ${p.attempts} attempt(s) and carries NO last_error — a writer refused and the reason is gone. This is the silent failure plan Task 3 Step 3 exists to prevent: the card shows a proposal that will not become a thing and says nothing about why.`);
    }

    // The revert path (task-3-contract.md S3) sets state back to 'pending'
    // AND clears decided_by/decided_at. A pending row wearing a decider is a
    // row that reads undecided on the screen and decided in the ledger.
    if (p.state === 'pending' && (p.has_decided_by || p.has_decided_at)) {
      failures.push(`${where}: PENDING but carries ${[p.has_decided_by ? 'decided_by' : null, p.has_decided_at ? 'decided_at' : null].filter(Boolean).join(' and ')} — the screen shows this as undecided while the row records a decision`);
    }
  }

  if (retired.length) {
    notes.push(`discovery-proposal-decisions: ${retired.length} ACCEPTED proposal(s) point at an object that NO LONGER EXISTS but whose creation IS recorded in the audit trail — ${retired.join(', ')}. Treated as retired, not dangling: the customer deleted the thing they accepted (authenticated holds DELETE on connectors, wired to Systems and MCP Servers). NOT a silent pass — if one of these should have been impossible to delete, that is a product decision to make now.`);
  }

  // ── The decision path is the ONLY way a row reaches a terminal state ─────
  // What makes assertion 1 enforceable rather than hopeful: if the browser
  // could UPDATE this table, decided_by would be whatever the browser chose
  // to write, and the assertion would be checking a self-report.
  if (!priv.tblSelectAuthenticated) {
    failures.push('authenticated CANNOT SELECT discovery_proposals — the decision screen could not read a single proposal');
  }
  for (const [verb, key] of [['INSERT', 'tblInsertAuthenticated'], ['UPDATE', 'tblUpdateAuthenticated'], ['DELETE', 'tblDeleteAuthenticated']]) {
    if (priv[key]) {
      failures.push(`authenticated can ${verb} discovery_proposals — every decision must go through decide_discovery_proposal, which is what stamps decided_by from auth.uid() and writes the audit event. With this grant a browser can set state='accepted' with any decided_by it likes, and the assertions above become a check on a self-report.`);
    }
  }
  if (priv.tblSelectAnon) {
    failures.push('anon can SELECT discovery_proposals — an unauthenticated reader can see every workspace\'s draft employees, guardrails and trust caps');
  }

  // ── The decision RPC's own grants ───────────────────────────────────────
  // Migration 741 is not applied yet, so zero rows here is today's honest
  // state — but it is a state with a consequence, not a skip: if the table
  // holds decided rows and no decider exists, something else decided them.
  if (deciders.length === 0) {
    if (terminalExamined > 0) {
      failures.push(`${terminalExamined} proposal(s) are in a terminal state but public.decide_discovery_proposal DOES NOT EXIST — they were decided by something other than the governed path`);
    } else {
      notes.push('discovery-proposal-decisions: public.decide_discovery_proposal is NOT INSTALLED yet (migration 741 unapplied), so its four grant assertions compared nothing this run. They are not passing; they have no function to examine.');
    }
  } else {
    if (deciders.length > 1) {
      failures.push(`public.decide_discovery_proposal has ${deciders.length} overloads (${deciders.map((d) => d.sig).join(' , ')}) — PostgREST routes by argument shape, so a second overload is a second decision path with its own grants`);
    }
    for (const d of deciders) {
      if (!d.authenticated) {
        failures.push(`${d.sig}: authenticated CANNOT execute it — the signed-in owner/admin has no way to decide a proposal, so the decision screen is dead`);
      }
      if (d.service_role) {
        failures.push(`${d.sig}: service_role CAN execute it. Under service_role auth.uid() is null, and task-3-contract.md S1 measured four safety mechanisms that then fail OPEN at once — instantiate_role_archetype and install_role_kit SKIP their authority check rather than fail it, append_audit_event drops its actor stamp, and decided_by is unsatisfiable. REVOKE it; do not pin it.`);
      }
      if (d.anon) {
        failures.push(`${d.sig}: anon CAN execute it — the anonymous internet can accept a proposal`);
      }
      if (d.pub) {
        failures.push(`${d.sig}: PUBLIC holds EXECUTE — Postgres's default grant was never revoked (migs 610/630's doctrine)`);
      }
      if (!d.secdef) {
        failures.push(`${d.sig}: is not SECURITY DEFINER — authenticated holds no UPDATE on discovery_proposals, so a SECURITY INVOKER decider cannot write the decision it was called to make`);
      }
    }
  }

  // ── The denominator, always, and loudest when it is zero ────────────────
  if (proposals.length === 0) {
    notes.push('discovery-proposal-decisions: ⚠ NOT YET EXERCISED — public.discovery_proposals holds ZERO rows, so the ROW assertions (terminal-needs-decided_by/at, accepted-needs-created_object_id, kind-must-be-routable, created_object_id-must-resolve-in-this-tenant, accepted-needs-its-creation-audit) compared ZERO rows this run and prove NOTHING about production behaviour yet. They are not green; they have nothing to examine. The route, expectation, state, resolver-control and audit-perimeter arms above DID run and are what this section actually proved today.');
  }

  return {
    failures,
    notes,
    proposalsExamined: proposals.length,
    terminalExamined,
    acceptedExamined,
    retiredExamined,
    routesExamined: routeKinds.length,
    expectationsExamined,
    statesExamined: statesInCheck.size,
    controlsExamined: controls.length,
    kindsPresent,
    admittedButUnroutable,
  };
}
