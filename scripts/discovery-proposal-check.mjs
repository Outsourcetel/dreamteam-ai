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
//      the nil uuid IN A REAL TENANT (must say NO), a row that demonstrably
//      exists (must say YES), that same row paired with ANOTHER TENANT THAT
//      HOLDS A ROW HERE (must say NO — the tenant predicate), and, where an
//      exclusion is declared, a row the exclusion is supposed to reject (must
//      say NO). Every direction, every run, sourced from HARDCODED
//      expectations so the map cannot move both sides of a comparison at once.
//      ⚠ The two capitalised clauses are repairs, not decoration: the resolver
//      is a conjunction, and both of those arms were shipped with the TENANT
//      conjunct made unsatisfiable — by the nil tenant, and by a contrast
//      workspace that owned nothing in the table — so each answered NO for a
//      reason that had nothing to do with what it was testing. Each arm now
//      reports the tenant it handed the resolver and a live re-test that that
//      tenant owns a matchable row; see "WAS THE ARM ASKABLE AT ALL?" below.
//   4. THE EVIDENCE PERIMETER. The "the customer deleted it" relief below
//      reads TWO records, and they are deliberately written by two different
//      things: the governed path's own audit event, and an INDEPENDENT
//      tenant_activity_log DELETE row written by a trigger on the target
//      table at delete time. Both are only admissible while nobody outside
//      the governed path can write them, so the grants on audit_events AND on
//      tenant_activity_log are asserted on every run, and so is the presence
//      of the trigger that writes the second one.
//   5. THE EXCLUSION ANCHOR. An exclusion (today: the is_workforce_assistant
//      refusal) used to be two adjacent literals — delete both and the whole
//      control vanished without a single red. EXCLUSION_ANCHORS is a third
//      statement, and unlike the other two it is DRIVEN BY PRODUCTION: it
//      names the live column whose existence is the reason the exclusion has
//      to be there at all, and the arm asks the catalogue rather than the
//      file. See EXCLUSION_ANCHORS for what it does and does not close.
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

/**
 * THE THIRD STATEMENT — and the only one of the three that PRODUCTION can
 * contradict.
 *
 * ⚠⚠ WHAT THIS EXISTS TO FIX. Before it, an exclusion was TWO ADJACENT
 * LITERALS: KIND_ROUTES.<kind>.extra (the implementation) and
 * EXPECTED_KIND_EXCLUSIONS.<kind> (the declaration). Deleting ONE went red in
 * two arms, which is what the pair was built for. Deleting BOTH — a two-line
 * edit — went completely GREEN, and not by defeating a control: the control
 * CEASED TO EXIST. resolverControlSql() emits the `excluded` arm only when the
 * declaration names one, and the arms-required loop demands that arm for the
 * same reason, so both sides of the check disappeared together and the section
 * reported a clean result over one fewer comparison. Zero findings from zero
 * comparisons is indistinguishable from a pass. The tables pair has a reverse
 * diff standing behind it (EXPECTED_KIND_TABLES -> KIND_ROUTES, both
 * directions); the exclusions pair had nothing behind it at all.
 *
 * So this map deliberately does NOT restate the exclusion. A third literal
 * saying the same thing would only make it a three-line edit. It names the
 * LIVE COLUMN whose presence in production is the REASON the exclusion has to
 * exist, and the arm asks the catalogue: while public.digital_employees still
 * carries a boolean `is_workforce_assistant`, an exclusion for `employee` is
 * REQUIRED in both of the other two statements, and its absence from either is
 * a failure sourced from PRODUCTION rather than from a file the person making
 * the edit is already holding open.
 *
 * ⚠ WHAT IT DOES NOT CLOSE, said plainly rather than implied away. A
 * determined THREE-line edit — implementation, declaration, anchor — still
 * buys silence; nothing inside a checker can stop the checker's own author.
 * What changed is that the third line now has to delete a statement whose
 * deletion contradicts a column still sitting in production, and the arm that
 * notices is driven by that column rather than by the file. That is a
 * different diff to write and a different diff to review. It is not a proof.
 *
 * ⚠ WHAT LEAVES THE DATABASE, EXACTLY — the standing prohibition, honoured
 * line by line. THREE BOOLEANS per anchor and nothing else:
 *   (a) does the table resolve at all (to_regclass, catalogue only);
 *   (b) does a BOOLEAN column of that name exist on it (pg_attribute,
 *       catalogue only — no row is touched);
 *   (c) does AT LEAST ONE row carry it true.
 * (c) is the only one that reads an is_workforce_assistant row, it is an
 * EXISTS over the table, and its entire answer is one bit. No id, no name, no
 * charter, no config, not even a count. It is here because the `excluded`
 * control arm cannot be DRIVEN without such a row, and "the arm was not
 * driven" must stay distinguishable from "the arm passed" — the same reason
 * `sample_available` exists three functions down. The column is read through
 * `to_jsonb(_r) ->> '<column>'` rather than by name so that a DROPPED column
 * answers `false` here instead of killing the whole query with a raw 42703
 * that would say nothing about exclusions at all.
 */
export const EXCLUSION_ANCHORS = Object.freeze({
  employee: Object.freeze({
    table: 'digital_employees',
    column: 'is_workforce_assistant',
    why: 'instantiate_role_archetype does not mint Workspace Assistants, so an accepted proposal stamping one\'s id would be a proposal claiming credit for the workspace\'s own admin desk',
  }),
});

/** The anchors, asked of production. One row per anchor; three booleans each.
 *  See EXCLUSION_ANCHORS for exactly what those booleans are and why (c) is
 *  the narrowest read that can answer the question it is asked. */
export function exclusionAnchorSql() {
  const parts = Object.entries(EXCLUSION_ANCHORS).map(([kind, a]) =>
    `select '${kind}'::text as kind,
                 '${a.table}'::text as tbl,
                 '${a.column}'::text as col,
                 (to_regclass('public.${a.table}') is not null) as table_live,
                 exists (select 1 from pg_attribute _c
                          where _c.attrelid = to_regclass('public.${a.table}')
                            and _c.attname = '${a.column}'
                            and _c.atttypid = 'boolean'::regtype
                            and _c.attnum > 0 and not _c.attisdropped) as column_live,
                 exists (select 1 from public.${a.table} _r
                          where (to_jsonb(_r) ->> '${a.column}')::boolean) as excludable_row_exists`);
  if (parts.length === 0) {
    // An EMPTIED map must not become an EMPTY QUERY. certify would fetch zero
    // rows, the anchor loop would iterate zero times, and the section would
    // report a clean result having compared nothing — the exact failure this
    // file was written to distrust. Emit the SHAPE with no rows so the decider
    // still has something to refuse, by name.
    return `select null::text as kind, null::text as tbl, null::text as col,
                   null::boolean as table_live, null::boolean as column_live,
                   null::boolean as excludable_row_exists where false`;
  }
  return parts.join('\n          union all\n          ');
}

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

/** The uuid the negative resolver control uses AS AN ID, and nothing else.
 *  gen_random_uuid() never produces the nil uuid, and no table in this schema
 *  defaults to it — re-measured 2026-08-15: 0 rows carry id = nil across all
 *  five target tables.
 *
 *  ⚠⚠ IT MUST NEVER BE HANDED TO THE RESOLVER AS A **TENANT** AGAIN. It was,
 *  and that made the negative arm a question the resolver could no longer be
 *  asked: the resolver is `_o.id = <id> and _o.tenant_id = <tenant>`, and
 *  measured live, 0 rows across all five target tables carry tenant_id = nil
 *  and no `tenants` row has the nil id. So the TENANT conjunct alone forced
 *  `false` and the ID conjunct — the only thing the arm exists to test — was
 *  never consulted. The demonstration: mis-edit the id conjunct to
 *  `(_o.id = idExpr or idExpr is not null)` and negative answered false
 *  (passing), positive true (passing), cross_tenant false (passing), excluded
 *  false (passing), while the per-row dangling assertion answered TRUE for any
 *  uuid in the proposal's own tenant. The negative arm now takes the SAMPLED
 *  row's real tenant, so `false` can only come from the id. */
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
 * ⚠⚠ THIS PREDICATE IS NOT, AND NEVER WAS, EVIDENCE THAT THE OBJECT EXISTED.
 * The comment that used to stand here said "a dangling uuid that was never
 * created satisfies none of them". THAT WAS FALSE, for exactly the rows this
 * feature produces, and it is worth being precise about why because the shape
 * recurs: migration 741 writes `created_object_id` (:536-540) and the audit
 * event carrying `created_object_id`/`created_object_table` (:542-549) FROM
 * THE SAME TWO VARIABLES, unconditionally, in ONE transaction. Conditions
 * (a)-(e) below therefore hold BY CONSTRUCTION for every row the governed path
 * ever writes. `has_creation_audit` was true for all of them, the dangling
 * FAILURE arm was reachable only through a writer that does not exist, and the
 * demonstration is one deletion: remove 741:455-461 (the Zone-3 guard that
 * checks the connector actually belongs to this workspace) and a garbage uuid
 * is classified `retired` and printed as a green note.
 *
 * The relief was granted by the accept restating itself. It is not narrow
 * evidence; it is the same sentence read twice.
 *
 * ⚠ SO WHAT THIS PREDICATE IS FOR NOW, and it is still load-bearing in one
 * direction: an accepted row whose object RESOLVES but which no audit event
 * records is a row stamped by a SECOND path — one with its own grants and no
 * reconstruction record. That arm reads this and is unaffected by everything
 * above, because it fires on the ABSENCE of a record the governed path always
 * writes. Absence of a self-written record is evidence; presence of one is
 * not. The relief itself now needs hasDeletionRecordSql() as well — see there.
 *
 * The five conditions, unchanged:
 *   (a) belongs to the SAME tenant as the proposal,
 *   (b) is a discovery_proposal_decision with decision='accepted',
 *   (c) names THIS proposal_id,
 *   (d) names EXACTLY the created_object_id the row still carries, and
 *   (e) names the created_object_table the INDEPENDENT expectation
 *       (EXPECTED_KIND_TABLES) gives for this kind — not the route map's.
 * (d) and (e) are what make it useless as a relief and useful as a
 * second-path detector: they are the two fields 741 copies verbatim.
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

/**
 * DID ANYTHING OUTSIDE THE ACCEPT EVER SEE THIS OBJECT?
 *
 * ⚠⚠ THIS IS THE CONJUNCT THAT MAKES THE RETIRED RELIEF MEAN SOMETHING, and
 * the whole reason it can is that decide_discovery_proposal cannot write it.
 * `public.tenant_activity_log` is written by `log_tenant_activity`, an AFTER
 * INSERT OR UPDATE OR DELETE row trigger installed on all five target tables
 * (measured 2026-08-15: connectors, digital_employees, guardrail_rules,
 * playbook_definitions, trust_policies all carry trg_tenant_activity_log, and
 * `delete_logged` re-asserts it on every run). On a DELETE it records
 * tenant_id, table_name, operation='DELETE' and row_pk = the deleted row's id.
 *
 * Different writer, different statement, different transaction, and — this is
 * the part that matters — it can only exist if the row ITSELF existed and was
 * then removed. A uuid that was never created has no DELETE record, because
 * there was never a row for the trigger to fire on. That is evidence of the
 * kind the audit event above only appeared to be.
 *
 * So `retired` now requires BOTH: the governed path recorded creating exactly
 * this object, AND something outside the governed path recorded exactly this
 * object being deleted. Neither alone is enough, and the demonstration that
 * used to defeat the relief (drop 741's Zone-3 guard, pass a garbage uuid)
 * now goes RED, because no trigger ever fired for a row that never existed.
 *
 * ⚠ WHAT THIS COSTS, and every item is a FALSE RED rather than a false green,
 * which is the direction a relief is allowed to be wrong in:
 *   · `log_tenant_activity` returns early when auth.uid() is null or when the
 *     actor's profile tenant differs from the row's. A deletion by
 *     service_role, by a migration, or by a platform operator therefore leaves
 *     NO record and the row goes red. Correct: those are not the customer
 *     decision this relief exists to forgive.
 *   · the trigger body ends `exception when others then null`, so a failed
 *     insert is swallowed. A genuine customer deletion can lose its record and
 *     go red. Named, not hidden.
 *   · anything that prunes tenant_activity_log ages the relief out.
 * ⚠ AND IT HAS NEVER BEEN GRANTED. Measured 2026-08-15: tenant_activity_log
 *   holds 5 DELETE rows in total and ZERO for `connectors`, and
 *   discovery_proposals holds zero rows, so this conjunct has relieved nothing
 *   and cannot yet. It is BUILT, not proven-live. The mutation cases drive it
 *   in both directions; production has not.
 *
 * ⚠ ADMISSIBLE ONLY WHILE THE BROWSER CANNOT WRITE IT. Measured 2026-08-15:
 * `authenticated` holds SELECT on tenant_activity_log and NOTHING else, `anon`
 * holds no INSERT. Asserted on every run by the evidence-perimeter arm, for
 * the same reason audit_events is — a forgeable record is not a record.
 */
function hasDeletionRecordSql() {
  return `exists (
              select 1 from public.tenant_activity_log tal
               where tal.tenant_id = p.tenant_id
                 and tal.operation = 'DELETE'
                 and tal.table_name = ${expectedTableCaseSql('p.kind')}
                 and tal.row_pk = p.created_object_id::text)`;
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
                 ${hasCreationAuditSql()} as has_creation_audit,
                 ${hasDeletionRecordSql()} as has_deletion_record
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
 *   negative     — the nil uuid, which exists in no table, paired with the
 *                  SAMPLED ROW'S OWN TENANT. Must answer false. If it answers
 *                  true, the resolver cannot detect a dangling id and every
 *                  accepted row would pass regardless. If it answers NULL, the
 *                  resolver has no arm for a kind KIND_ROUTES calls routable.
 *                  ⚠ The tenant is REAL on purpose — see NIL_UUID. Handed the
 *                  nil tenant, this arm answered false because no row anywhere
 *                  carries tenant_id = nil, so the id conjunct it exists to
 *                  test was never reached.
 *   positive     — the id AND tenant of a row that demonstrably exists in the
 *                  EXPECTED table. Must answer true. A resolver joined on the
 *                  wrong column, or pointed at the wrong table, answers false
 *                  here — which is what says so on the day it happens rather
 *                  than the day someone accepts a proposal.
 *   cross_tenant — that same real row's id paired with a DIFFERENT tenant's
 *                  id — and, since 2026-08-15, a different tenant THAT HOLDS
 *                  AT LEAST ONE ROW IN THIS KIND'S TABLE. Must answer false.
 *                  This is the only arm that can see the tenant predicate:
 *                  delete it and every other arm still answers correctly while
 *                  a created_object_id pointing at another workspace's
 *                  connector reads as clean.
 *                  ⚠ The contrast tenant used to be `tenants order by id limit
 *                  1` — the existence of a second WORKSPACE, not of a second
 *                  workspace's ROW. A contrast tenant that owns nothing in the
 *                  table makes the tenant conjunct unsatisfiable for every row
 *                  in it, so the arm answers false for the same reason the nil
 *                  tenant did, and the conjunction is never exercised. It
 *                  passed today only by data accident: measured 2026-08-15 the
 *                  lowest-id tenant (0765bcbb…) happens to hold a row in all
 *                  five tables, while tenant a0000000-…-0001 holds employees
 *                  and NOTHING ELSE — pick that one and four of the five arms
 *                  go vacuous with nothing said. Both halves are now stated:
 *                  the contrast tenant is CHOSEN as one that holds a row, and
 *                  the arm REPORTS which tenant it used together with a live
 *                  re-test that that tenant does hold one.
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
 *
 * ── THE THREE COLUMNS THAT SAY THE ARM WAS ASKABLE ─────────────────────────
 * The resolver is a CONJUNCTION (`_o.id = … and _o.tenant_id = … [and extra]`)
 * and any single unsatisfiable conjunct forces the whole thing false. So an
 * arm that must answer FALSE proves nothing unless every conjunct it is NOT
 * testing is satisfiable — otherwise `false` is over-determined and the arm
 * answers correctly no matter what the conjunct under test does. Both defects
 * this section shipped were exactly that, on the tenant conjunct. The controls
 * therefore carry their own askability with them:
 *
 *   sample_tenant            the tenant that OWNS the sampled row.
 *   handed_tenant            the tenant actually passed to the resolver as
 *                            tenantExpr — equal to sample_tenant everywhere
 *                            except cross_tenant, where it is the contrast.
 *   handed_tenant_holds_row  live re-test: does handed_tenant own at least one
 *                            row in the EXPECTED table that this kind's
 *                            resolver could match apart from the id? If not,
 *                            the tenant conjunct is unsatisfiable and `false`
 *                            was never the id's doing.
 *
 * The `excluded` arm reports NULL for all three, and that is not an oversight:
 * its sample is an is_workforce_assistant row, the standing prohibition allows
 * a BOOLEAN out of such a row and nothing else, and a tenant_id is not a
 * boolean. It needs none of them — its id and tenant are drawn from the SAME
 * row by the same `order by _s.id limit 1`, so `_o.id = … and _o.tenant_id =
 * …` is satisfied by construction and the exclusion is the only conjunct that
 * can force false. The `positive` arm needs no re-test either: `resolves =
 * true` already proves every conjunct satisfiable.
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
      parts.push(`select '${kind}'::text as kind, 'positive'::text as arm, false as sample_available,
                 null::boolean as resolves, null::text as sample_tenant, null::text as handed_tenant,
                 null::boolean as handed_tenant_holds_row`);
      continue;
    }
    const excl = EXPECTED_KIND_EXCLUSIONS[kind] ?? null;
    const pick = (col, where) => `(select _s.${col} from public.${tbl} _s`
      + `${where ? ` where ${where}` : ''} order by _s.id limit 1)`;

    const okId = pick('id', excl ? `not (${excl})` : null);
    const okTenant = pick('tenant_id', excl ? `not (${excl})` : null);

    // "Does this tenant own a row the resolver could match APART FROM the id?"
    // — the satisfiability of every conjunct the arm is not testing, asked of
    // live data rather than assumed. EXPECTED_KIND_EXCLUSIONS is written over
    // `_s` (pick's alias) and this subquery is nested INSIDE the tenants scan
    // below, so it takes its own alias and the predicate is rewritten onto it;
    // a second copy of the predicate would be a second thing to keep in step.
    const exclH = excl ? excl.replaceAll('_s.', '_h.') : null;
    const holdsRow = (tenantExpr) => `exists (select 1 from public.${tbl} _h`
      + ` where _h.tenant_id = ${tenantExpr}${exclH ? ` and not (${exclH})` : ''})`;

    // ⚠ THE CONTRAST TENANT IS CHOSEN FOR HOLDING A ROW, not for existing.
    // Still drawn from public.tenants — a workspace, not merely a tenant_id
    // value that happens to appear in the table — but now the lowest-id
    // workspace THAT OWNS SOMETHING HERE. Without the exists() this picked
    // whatever tenant sorted first (measured 2026-08-15: 0765bcbb…, which
    // holds a row in all five tables purely by accident) and would have gone
    // vacuous the moment that changed, or the moment a table's rows moved.
    const otherTenant = `(select _t.id from public.tenants _t`
      + ` where _t.id is distinct from ${okTenant} and ${holdsRow('_t.id')}`
      + ` order by _t.id limit 1)`;

    // ⚠ THE NEGATIVE ARM TAKES A REAL TENANT. See NIL_UUID: handed the nil
    // tenant it answered false because nothing anywhere carries tenant_id =
    // nil, which is not the question. `sample_available` is now honest about
    // its own precondition — an empty table has no tenant to hand it.
    parts.push(`select '${kind}'::text as kind, 'negative'::text as arm, (${okTenant} is not null) as sample_available,
                 ${objectResolvesSql(`'${kind}'`, `'${NIL_UUID}'::uuid`, okTenant)} as resolves,
                 ${okTenant}::text as sample_tenant, ${okTenant}::text as handed_tenant,
                 ${holdsRow(okTenant)} as handed_tenant_holds_row`);
    parts.push(`select '${kind}'::text, 'positive'::text, (${okId} is not null),
                 ${objectResolvesSql(`'${kind}'`, okId, okTenant)},
                 ${okTenant}::text, ${okTenant}::text, ${holdsRow(okTenant)}`);
    parts.push(`select '${kind}'::text, 'cross_tenant'::text, (${okId} is not null and ${otherTenant} is not null),
                 ${objectResolvesSql(`'${kind}'`, okId, otherTenant)},
                 ${okTenant}::text, ${otherTenant}::text, ${holdsRow(otherTenant)}`);
    if (excl) {
      const exId = pick('id', excl);
      const exTenant = pick('tenant_id', excl);
      // ⚠ NULL TENANT COLUMNS, DELIBERATELY. exTenant names an
      // is_workforce_assistant row; the standing prohibition permits a BOOLEAN
      // out of such a row and nothing else, and a tenant_id is not a boolean —
      // so it is used ONLY inside the resolver, as the right-hand side of an
      // existence test, exactly as EXPECTED_KIND_EXCLUSIONS' header says. The
      // arm does not need the columns: see the header above.
      parts.push(`select '${kind}'::text, 'excluded'::text, (${exId} is not null),
                 ${objectResolvesSql(`'${kind}'`, exId, exTenant)},
                 null::text, null::text, null::boolean`);
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
  // `delete_logged` is the perimeter of the retired relief, asked per table.
  // hasDeletionRecordSql() reads a tenant_activity_log DELETE row as the ONE
  // piece of evidence decide_discovery_proposal cannot write; that evidence
  // only exists while log_tenant_activity is still attached to the table ON
  // DELETE. Drop the trigger and the relief silently becomes unreachable —
  // every genuinely-deleted object turns red with a message about dangling
  // uuids that would send the reader to the wrong place entirely. Asserted, so
  // the day it happens the section names the trigger instead.
  // `to_regproc` (not `::regproc`) because a MISSING function must answer
  // null, not raise 42883 and take the whole section down with it.
  // tgtype & 8 is TRIGGER_TYPE_DELETE — a trigger installed for INSERT only
  // would satisfy a bare existence test and log nothing on the one operation
  // this relief depends on.
  return `select t as tbl,
                 (to_regclass('public.' || t) is not null) as table_live,
                 exists (select 1 from pg_trigger tg
                          where tg.tgrelid = to_regclass('public.' || t)
                            and not tg.tgisinternal
                            and tg.tgfoid = to_regproc('public.log_tenant_activity')
                            and (tg.tgtype & 8) <> 0) as delete_logged
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
 *  the TWO evidence tables', because the retired relief reads a record from
 *  each and neither is admissible if the browser can write it. audit_events
 *  carries the governed path's own account of the accept; tenant_activity_log
 *  carries the trigger's account of the DELETE, which is the half the RPC
 *  cannot write and therefore the half that has to stay unforgeable. Defined
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
      has_table_privilege('anon','public.audit_events','insert') as audit_insert_anon,
      has_table_privilege('authenticated','public.tenant_activity_log','insert') as activity_insert_authenticated,
      has_table_privilege('authenticated','public.tenant_activity_log','update') as activity_update_authenticated,
      has_table_privilege('authenticated','public.tenant_activity_log','delete') as activity_delete_authenticated,
      has_table_privilege('anon','public.tenant_activity_log','insert') as activity_insert_anon`;
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
    activityInsertAuthenticated: row?.activity_insert_authenticated,
    activityUpdateAuthenticated: row?.activity_update_authenticated,
    activityDeleteAuthenticated: row?.activity_delete_authenticated,
    activityInsertAnon: row?.activity_insert_anon,
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
 * @param {object[]} [s.anchorProbes] exclusionAnchorSql() rows. Required in
 *   practice — certify always passes them; the default of [] exists only so an
 *   older caller fails LOUDLY on the "never driven" arm instead of throwing.
 * @param {object} [s.exclusions] EXPECTED_KIND_EXCLUSIONS override, and
 * @param {object} [s.anchors]    EXCLUSION_ANCHORS override. certify NEVER
 *   passes either. They exist for one reason: the way an exclusion actually
 *   gets silenced is by DELETING literals, and a mutation case that can only
 *   mutate `routes` can only ever perform HALF of that edit. With these, the
 *   harness can perform the whole two-line edit (drop `extra` AND drop the
 *   declaration) and watch the production-sourced anchor refuse it — which is
 *   the only way that claim is asserted rather than asserted-about.
 * @param {object} [s.wiring] {sql, scoped, blind} override for the resolver-
 *   WIRING block. certify NEVER passes this either. The block compares the
 *   text proposalsSql() emits against the two resolver expressions, so there
 *   is no state to mutate — without an injection point its four assertions
 *   could only be proven by editing this file, which is the shape of a pin
 *   nobody ever exercises. All three keys are supplied together by each
 *   fixture so exactly ONE of the four can be made to fire at a time.
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
  const exclusions = s.exclusions ?? EXPECTED_KIND_EXCLUSIONS;
  const anchors = s.anchors ?? EXCLUSION_ANCHORS;
  const anchorProbes = s.anchorProbes ?? [];
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
  // ⚠ EVERY `expectationsExamined++` IN THIS SECTION IS UNCONDITIONAL, and it
  // is worth saying why in the code rather than in a commit message. Two of
  // them used to sit INSIDE their failure branch, so the number counted
  // FINDINGS while claiming to count COMPARISONS: it read 7 when 17
  // comparisons were made, and — the part that makes it worse than having no
  // number at all — it moved DOWN to 6 when someone performed the two-line
  // exclusion exemption, because the loop that no longer had a key to compare
  // simply stopped counting. A denominator that shrinks as coverage is removed
  // does not merely fail to warn; it reports the removal as a smaller, tidier
  // check. The whole honesty argument for this section is "count the
  // comparisons, not the findings", and it is only worth anything while the
  // count is taken before the verdict.
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
    expectationsExamined++;
    if (!routeKinds.includes(kind)) {
      failures.push(`EXPECTED_KIND_TABLES declares kind "${kind}" routable into public.${EXPECTED_KIND_TABLES[kind]}, but KIND_ROUTES does not route it at all — dropping a kind from the map removes every row assertion for it silently, which buys the same silence as a bogus route`);
    }
  }

  // ── THE EXCLUSIONS, IN THREE STATEMENTS ─────────────────────────────────
  // The implementation (KIND_ROUTES.<kind>.extra), the declaration
  // (EXPECTED_KIND_EXCLUSIONS.<kind>) and the ANCHOR (EXCLUSION_ANCHORS, which
  // names a column and is answered by PRODUCTION). The first two used to be
  // the whole story and they are ADJACENT LITERALS: delete both and the
  // `excluded` control arm was not defeated, it was never emitted, and the
  // arms-required loop below stopped demanding it in the same stroke. Nothing
  // failed because nothing was compared.
  //
  // The kinds iterated here are therefore the UNION of the declared exclusions
  // and the anchored ones — deliberately, so that deleting a declaration does
  // not also delete the comparison that would have caught it. That is the same
  // property `expectationsExamined` needs: the loop must not get shorter when
  // coverage is removed.
  const exclusionKinds = [...new Set([
    ...Object.keys(exclusions),
    ...Object.keys(anchors),
  ])].sort();
  if (Object.keys(anchors).length === 0) {
    failures.push('EXCLUSION_ANCHORS is EMPTY — the only statement about exclusions that production can contradict has been removed, so the implementation and the declaration are once again two adjacent literals that can be deleted together in one diff with nothing left to notice');
  }
  if (Object.keys(anchors).length > 0 && anchorProbes.length === 0) {
    failures.push('examined ZERO exclusion anchors — exclusionAnchorSql() returned no rows, so the live half of the exclusion check was never driven this run. The declaration and the implementation were compared only against each other, which is the arrangement the anchor exists to end.');
  }
  for (const kind of exclusionKinds) {
    expectationsExamined++;
    const declared = exclusions[kind];
    const extra = routes[kind]?.extra;
    const anchor = anchors[kind];
    const probe = anchorProbes.find((a) => a.kind === kind);

    // ── the anchor's own health. A stale anchor is worse than none: it makes
    // the two arms below skip while looking like they ran.
    if (anchor) {
      if (!probe) {
        failures.push(`EXCLUSION_ANCHORS names kind "${kind}" but no anchor probe row came back for it — the live statement was not driven, so the exclusion is once again backed only by the two literals that can be deleted together`);
      } else if (probe.table_live !== true) {
        failures.push(`the exclusion anchor for kind "${kind}" names public.${anchor.table}, which to_regclass cannot resolve — the anchor cannot answer, and an anchor that cannot answer is not an anchor`);
      } else if (probe.column_live !== true) {
        failures.push(`the exclusion anchor for kind "${kind}" names public.${anchor.table}.${anchor.column}, which production does not carry as a boolean column. Either the column was renamed or dropped — in which case the exclusion's whole basis has moved and BOTH the \`extra\` predicate and EXPECTED_KIND_EXCLUSIONS are now describing something that does not exist — or the anchor was edited to point somewhere harmless, which is the third line of a three-line exemption.`);
      }
      if (anchor.table !== EXPECTED_KIND_TABLES[kind]) {
        failures.push(`the exclusion anchor for kind "${kind}" names public.${anchor.table} but EXPECTED_KIND_TABLES independently says public.${EXPECTED_KIND_TABLES[kind] ?? '(nothing)'} — an anchor pointed at a different table asks production a question about rows the resolver will never see`);
      }
    }

    // ── THE ARM THAT MAKES THE TWO-LINE EDIT GO RED. Both halves are demanded
    // by the ANCHOR, so neither can be excused by deleting the other.
    const anchorLive = anchor && probe?.table_live === true && probe?.column_live === true;
    if (anchorLive && (typeof declared !== 'string' || declared.trim() === '')) {
      failures.push(`public.${anchor.table} still carries the boolean column ${anchor.column}, which is the entire reason kind "${kind}" needs a resolver exclusion (${anchor.why}) — and EXPECTED_KIND_EXCLUSIONS no longer declares one. Deleting the declaration does not defeat the \`excluded\` control arm, it DELETES it: resolverControlSql() emits that arm only when a declaration names it, so the check stops existing rather than failing. Restore the declaration, or say out loud why production carrying that column no longer matters.`);
    }
    if (anchorLive && (typeof extra !== 'string' || extra.trim() === '')) {
      failures.push(`public.${anchor.table} still carries the boolean column ${anchor.column}, and KIND_ROUTES carries no \`extra\` predicate for kind "${kind}" — so the resolver will answer YES about exactly the rows it must refuse. For employee that row is a Workspace Assistant: an accepted proposal stamping its id would read as a legitimately created employee.`);
    }
    if (anchorLive && typeof declared === 'string' && !declared.includes(anchor.column)) {
      failures.push(`EXPECTED_KIND_EXCLUSIONS for kind "${kind}" is "${declared}", which does not mention ${anchor.column} — the declaration has drifted off the column the anchor says is the reason it exists. One of the two is wrong; the anchor is the one production can confirm.`);
    }
    if (anchorLive && typeof extra === 'string' && !extra.includes(anchor.column)) {
      failures.push(`kind "${kind}" carries the \`extra\` predicate "${extra}", which does not mention ${anchor.column} — the resolver is excluding something, but not the thing the anchor names, and the \`excluded\` control samples by the DECLARATION so it would keep answering false for a reason that is not this predicate's`);
    }

    // ── the original two directions, kept: they say something the anchor does
    // not, namely that the two literals agree with each other.
    if (typeof declared === 'string' && declared.trim() !== '') {
      if (!routeKinds.includes(kind)) {
        failures.push(`EXPECTED_KIND_EXCLUSIONS names kind "${kind}", which KIND_ROUTES does not route — the exclusion has nothing to apply to`);
      } else if (typeof extra !== 'string' || extra.trim() === '') {
        failures.push(`kind "${kind}" must exclude rows matching "${declared}" from what its resolver can answer YES about, and KIND_ROUTES carries no \`extra\` predicate for it. For employee this is the is_workforce_assistant exclusion: without it, an accepted proposal stamping the Workspace Assistant's id reads as a legitimately created employee.`);
      }
    }
  }
  for (const kind of routeKinds) {
    expectationsExamined++;
    if (routes[kind].extra && !exclusions[kind]) {
      failures.push(`kind "${kind}" carries an \`extra\` resolver predicate that EXPECTED_KIND_EXCLUSIONS does not declare — the predicate is therefore driven by no control arm, and deleting it would cost nothing. State what it must reject, or remove it.`);
    }
  }
  const admittedButUnroutable = [...kindsInCheck].filter((k) => !routeKinds.includes(k)).sort();

  // ── WHICH RESOLVERS THE ROW ARM ACTUALLY USES — BOTH SLOTS ──────────────
  // The control arms drive objectResolvesSql. They cannot see WHICH resolver
  // proposalsSql() embeds — and this file contains a second, deliberately
  // tenant-blind one (objectExistsAnyTenantSql) whose only job is to tell
  // "gone" from "another workspace's". Swap the two and every control arm
  // still answers correctly while the row assertion quietly loses its tenant
  // predicate: a control set that proves an expression is right proves nothing
  // about an expression nobody wired in. So the wiring is compared, not
  // assumed. Constant across fixtures on purpose — this is a property of the
  // file, and if it is ever false it is false for every run.
  //
  // ⚠⚠ FOUR ASSERTIONS, NOT ONE, AND THE SECOND SLOT IS WHY. This block used
  // to guard the tenant-SCOPED slot only. `object_exists_anywhere` decides
  // which of two very different findings an unresolvable id produces:
  //   · resolves=false AND exists_anywhere=TRUE  -> the SECURITY failure ("a
  //     LIVE row BELONGING TO ANOTHER WORKSPACE"), never relieved;
  //   · resolves=false AND exists_anywhere=false -> the retired NOTE, relieved
  //     by an audit event and printed as a customer's own deletion.
  // Put objectResolvesSql in the second slot and a cross-tenant pointer reads
  // exists_anywhere = FALSE, so it falls out of the failure arm into the note
  // arm: a security event silently downgraded to a customer decision, with no
  // control, no row fixture and no arm noticing. Hence: each slot must carry
  // the right expression (assertions 1 and 2), AND each expression must still
  // BE what its name claims (3 and 4) — because widening
  // objectExistsAnyTenantSql in place rebuilds proposalsSql() from the widened
  // text and both `includes` checks keep passing. Two of these compare wiring;
  // two compare the defining property. Neither pair is sufficient alone.
  const wiring = s.wiring ?? null;
  const wiredSql = wiring?.sql ?? proposalsSql();
  const wiredResolver = wiring?.scoped ?? objectResolvesSql('p.kind', 'p.created_object_id', 'p.tenant_id');
  const wiredBlind = wiring?.blind ?? objectExistsAnyTenantSql('p.kind', 'p.created_object_id');
  expectationsExamined++;
  if (!wiredSql.includes(wiredResolver)) {
    failures.push('proposalsSql() no longer embeds the TENANT-SCOPED resolver that the control arms drive. Every negative/positive/cross_tenant/excluded control would keep answering correctly while the per-row dangling assertion ran against a different expression — most likely objectExistsAnyTenantSql, which has no tenant predicate by design. A control set proves nothing about an expression nobody wired in.');
  }
  expectationsExamined++;
  if (!wiredSql.includes(wiredBlind)) {
    failures.push('proposalsSql() no longer computes object_exists_anywhere with the TENANT-BLIND resolver (objectExistsAnyTenantSql). That column is the ONLY thing separating the cross-tenant SECURITY failure from the retired NOTE: with the tenant-scoped expression in this slot, an accepted row pointing at another workspace\'s live object reports exists_anywhere = false, drops out of the failure arm and is printed as a green note saying the customer deleted something. No resolver control can see this — the controls drive the other expression.');
  }
  expectationsExamined++;
  if (!wiredResolver.includes('tenant_id')) {
    failures.push('the resolver that proposalsSql() computes object_resolves with carries NO tenant_id predicate. A created_object_id pointing at ANOTHER WORKSPACE\'S row then resolves true and the row arm calls it a legitimately created object — the same shape as a tenant id passed as a parameter becoming the authorisation (migrations 662-664). The cross_tenant control arm is meant to catch this against live data; this is the static half, because that arm has twice been rendered unaskable by its own tenant argument.');
  }
  expectationsExamined++;
  if (wiredBlind.includes('tenant_id')) {
    failures.push('objectExistsAnyTenantSql has gained a tenant_id predicate, so object_exists_anywhere is no longer tenant-blind. It exists for exactly one job — telling "the object is gone" apart from "the object belongs to somebody else" — and a tenant-scoped version answers false for BOTH, which merges the security failure into the retired note. Widening it in place is invisible to the two wiring comparisons above, because proposalsSql() is built from this same text.');
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
      if (c.sample_available === false) {
        missingSamples.push(`${c.kind}/negative (${tblOf()} holds no row, so there is no real tenant to hand this arm)`);
      } else if (c.resolves === true) {
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
        missingSamples.push(`${c.kind}/cross_tenant (${tblOf()} has no row, or no OTHER tenant holds one to contrast with)`);
      } else if (c.resolves !== false) {
        failures.push(`RESOLVER HAS NO TENANT PREDICATE for kind "${c.kind}": handed a real row's id paired with a DIFFERENT tenant's id, it answered ${JSON.stringify(c.resolves)} instead of false. A created_object_id pointing at ANOTHER WORKSPACE'S row therefore reads as a legitimately created object, and certify calls it clean — the same shape as a tenant id passed as a parameter becoming the authorisation (migrations 662-664).`);
      }
    } else if (c.arm === 'excluded') {
      if (c.sample_available === false) {
        missingSamples.push(`${c.kind}/excluded (no row in ${tblOf()} matches "${exclusions[c.kind] ?? '?'}")`);
      } else if (c.resolves !== false) {
        failures.push(`RESOLVER EXCLUSION GONE for kind "${c.kind}": handed a row that "${exclusions[c.kind] ?? '?'}" identifies as one it must REFUSE, it answered ${JSON.stringify(c.resolves)} instead of false. For employee that row is a Workspace Assistant: an accept stamping its id would be a proposal claiming credit for the workspace's own admin desk, and this section would report it clean.`);
      }
    } else {
      failures.push(`unknown resolver control arm "${c.arm}" for kind "${c.kind}" — the control set does not match what this function knows how to judge`);
    }

    // ── WAS THE ARM ASKABLE AT ALL? ───────────────────────────────────────
    // ⚠⚠ THE DEFECT CLASS THIS WHOLE FILE EXISTS FOR, TWICE OVER, AND BOTH
    // TIMES ON THE SAME CONJUNCT. The resolver is `_o.id = <id> and
    // _o.tenant_id = <tenant> [and <extra>]`. An arm that must answer FALSE
    // proves something only if every conjunct it is NOT testing is
    // SATISFIABLE — otherwise `false` is over-determined and the arm answers
    // correctly whatever the conjunct under test does. Shipped twice:
    //   · negative was handed the NIL tenant, and nothing anywhere carries
    //     tenant_id = nil (measured: 0 rows in all five tables, no such
    //     tenants row), so it could no longer be asked about the id;
    //   · cross_tenant took `tenants order by id limit 1` — a second
    //     WORKSPACE, not a second workspace's ROW — so a contrast tenant that
    //     owned nothing in the table made the tenant conjunct unsatisfiable
    //     for every row and the arm passed vacuously. It held today only
    //     because the lowest-id tenant happens to own a row in all five
    //     tables; tenant a0000000-…-0001 owns employees and nothing else.
    // Both arms therefore now carry the tenant they handed the resolver AND a
    // live re-test that it owns a matchable row. The re-test is computed from
    // the tenant that was REPORTED, not from the predicate that chose it, so
    // weakening the choice changes the answer instead of moving both sides.
    // positive needs none of this (resolves = true already proves every
    // conjunct satisfiable) and excluded needs none either (its id and tenant
    // come from the same row, so only the exclusion can force false).
    if ((c.arm === 'negative' || c.arm === 'cross_tenant') && c.sample_available !== false) {
      const handed = c.handed_tenant ?? null;
      if (!handed) {
        failures.push(`CONTROL NOT ASKABLE: the ${c.arm} arm for kind "${c.kind}" claims a sample but does not report WHICH tenant it handed the resolver, so nothing can tell whether its \`false\` came from the conjunct under test or from a tenant predicate that no row in ${tblOf()} could ever satisfy. An arm that cannot say what it was asked is not a control.`);
      } else if (handed === NIL_UUID) {
        failures.push(`CONTROL FORCED FALSE BY ITS OWN TENANT ARGUMENT: the ${c.arm} arm for kind "${c.kind}" handed the resolver the NIL tenant. Measured live: no row in any of the five target tables carries tenant_id = nil and no tenants row has that id, so \`_o.tenant_id = <nil>\` alone makes the resolver false and the conjunct this arm exists to test is never reached. Mis-edit the id conjunct to \`(_o.id = idExpr or idExpr is not null)\` and all four arms still answer correctly while the per-row dangling assertion answers true for ANY uuid in the proposal's own tenant.`);
      } else if (c.arm === 'cross_tenant' && c.sample_tenant && handed === c.sample_tenant) {
        failures.push(`CONTRAST TENANT IS THE SAMPLE TENANT for kind "${c.kind}" (${handed}): the cross_tenant arm is supposed to hand a real row's id to a DIFFERENT workspace. Handed the row's own tenant it is a duplicate of the positive arm, and the tenant predicate — the only thing this arm exists to see — is not exercised in either direction.`);
      } else if (c.handed_tenant_holds_row !== true) {
        failures.push(`CONTROL NOT ASKABLE for kind "${c.kind}"/${c.arm}: the tenant it handed the resolver (${handed}) owns NO row in ${tblOf()} that this kind's resolver could match. The tenant conjunct is therefore unsatisfiable for every row in the table, so the arm answers \`false\` because of the tenant and not because of the thing it is testing — the same defect the NIL-tenant negative arm shipped. ${c.arm === 'cross_tenant' ? 'Choose a contrast workspace that actually holds a row here (public.tenants ... where exists(...)), or report the arm as having no sample.' : 'Hand it the sampled row\'s own tenant.'}`);
      }
    }
  }
  for (const kind of routeKinds) {
    const arms = ['negative', 'positive', 'cross_tenant'];
    if (exclusions[kind]) arms.push('excluded');
    for (const arm of arms) {
      if (!controls.some((c) => c.kind === kind && c.arm === arm)) {
        failures.push(`no ${arm} resolver control was run for routable kind "${kind}" — a direction the resolver is never driven in is a direction whose defect no row fixture could ever reveal`);
      }
    }
  }
  // ⚠ THE LOOP ABOVE DEMANDS THE `excluded` ARM ONLY WHEN THE DECLARATION
  // NAMES ONE — which is exactly how the two-line edit escaped it: delete the
  // declaration and the arm stops being required in the same stroke that stops
  // it being emitted. So the requirement is ALSO stated from the side the edit
  // cannot reach. If production says an excludable row exists for an anchored
  // kind, that arm had a sample and must have been driven.
  for (const [kind, anchor] of Object.entries(anchors)) {
    const probe = anchorProbes.find((a) => a.kind === kind);
    if (probe?.excludable_row_exists !== true) continue;
    const arm = controls.find((c) => c.kind === kind && c.arm === 'excluded');
    if (!arm) {
      failures.push(`production holds at least one row in public.${anchor.table} with ${anchor.column} = true, and NO \`excluded\` resolver control was driven for kind "${kind}". The arm is emitted only when EXPECTED_KIND_EXCLUSIONS declares an exclusion, so its absence means the declaration is gone — and with it the one direction that proves the resolver refuses the rows it must refuse. This is the two-line exemption seen from the live side.`);
    } else if (arm.sample_available === false) {
      failures.push(`the \`excluded\` control for kind "${kind}" reports NO SAMPLE, but the anchor measured live that public.${anchor.table} does hold a row with ${anchor.column} = true. The declared predicate "${exclusions[kind] ?? '(none)'}" therefore selects nothing that the anchor's column selects — the arm is being skipped for a reason that is not the absence of such rows, and a skipped arm reads exactly like a passing one.`);
    }
  }
  if (missingSamples.length) {
    notes.push(`discovery-proposal-decisions: NO RESOLVER SAMPLE for ${missingSamples.join(', ')} — ${missingSamples.length} control arm(s) were NOT driven this run. Not a pass for those arms.`);
  }
  // WHICH WORKSPACE EACH cross_tenant ARM CONTRASTED WITH, printed by certify
  // on a GREEN run too. The arm's `false` is only meaningful against a
  // contrast that owns a row here, and which contrast it got is chosen from
  // live data — so it can change without any edit. A number that only appears
  // when something is wrong cannot show a control quietly going vacuous;
  // this is the same reason the zero-row denominator is printed every run.
  const crossTenantContrasts = controls
    .filter((c) => c.arm === 'cross_tenant')
    .map((c) => `${c.kind}<-${c.handed_tenant ? String(c.handed_tenant).slice(0, 8) : 'NONE'}`);

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

  // ── THE OTHER HALF OF THE EVIDENCE PERIMETER ────────────────────────────
  // The retired relief now needs a tenant_activity_log DELETE row as well —
  // the half decide_discovery_proposal cannot write, which is the only reason
  // the relief means anything. That makes tenant_activity_log evidence, and
  // evidence anyone can write is not evidence. Measured 2026-08-15:
  // authenticated holds SELECT and nothing else; anon holds no INSERT.
  for (const [verb, key] of [['INSERT', 'activityInsertAuthenticated'], ['UPDATE', 'activityUpdateAuthenticated'], ['DELETE', 'activityDeleteAuthenticated']]) {
    if (priv[key]) {
      failures.push(`authenticated can ${verb} tenant_activity_log — the retired relief reads a DELETE row from that table as the one piece of evidence the accept itself cannot write, and with this grant a browser can forge (or erase) it. A dangling created_object_id would then be excusable by writing a row that says the object was deleted.`);
    }
  }
  if (priv.activityInsertAnon) {
    failures.push('anon can INSERT tenant_activity_log — the deletion record the retired relief rests on is writable by the anonymous internet');
  }
  // And the writer of that evidence. If log_tenant_activity is no longer
  // attached ON DELETE to a target table, the relief for that kind becomes
  // unreachable: every genuinely-deleted object goes red under a message about
  // dangling uuids that points the reader at the wrong problem entirely.
  for (const kind of routeKinds) {
    const tbl = EXPECTED_KIND_TABLES[kind] ?? routes[kind]?.table;
    const row = routeTables.find((r) => r.tbl === tbl);
    if (!row || row.table_live !== true) continue; // already reported above
    if (row.delete_logged !== true) {
      failures.push(`public.${tbl} carries no log_tenant_activity trigger firing ON DELETE, so nothing outside decide_discovery_proposal records a row of this table being removed. The retired relief for kind "${kind}" requires exactly that record; without the trigger it can never be granted, and the first customer who deletes an accepted ${kind} turns this section red with a message about a uuid that was never created — which would be false. Restore the trigger, or withdraw the relief deliberately and say so here.`);
    }
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
      } else if (p.object_resolves === false
                 && p.has_creation_audit === true
                 && p.has_deletion_record === true) {
        // 4b. RESOLVES TO NOTHING *NOW*, and TWO records agree about why: the
        // governed path recorded creating exactly this object, AND a trigger
        // on the target table recorded exactly this object being DELETED.
        //
        // ⚠⚠ THE SECOND CONJUNCT IS THE WHOLE FIX, so it is worth stating what
        // was wrong. The relief used to rest on has_creation_audit alone, and
        // migration 741 writes created_object_id (:536-540) and the audit
        // event carrying created_object_id/created_object_table (:542-549)
        // from the SAME two variables, unconditionally, in ONE transaction. So
        // the relief was granted by the accept restating itself: TRUE by
        // construction for every governed row, the dangling FAILURE arm below
        // reachable only through a writer that does not exist, and the
        // demonstration a single deletion — remove 741:455-461 (the Zone-3
        // check that the connector belongs to this workspace) and a garbage
        // uuid was classified retired and printed as a green note.
        //
        // hasDeletionRecordSql() is evidence decide_discovery_proposal cannot
        // write. A tenant_activity_log DELETE row exists only if the row
        // itself existed and was then removed — a uuid that was never created
        // never had a row for the trigger to fire on. Both records are
        // required: the first says the governed path made it, the second says
        // something outside that path watched it go.
        //
        // ⚠ It has never been granted. Measured 2026-08-15: zero DELETE rows
        // for connectors in tenant_activity_log, zero proposals. BUILT, not
        // proven-live; the mutation cases are what drive it in both
        // directions today.
        retiredExamined++;
        retired.push(`${p.id} (${p.kind})`);
      } else if (p.object_resolves === false) {
        // 4. The one this task designed: a stored uuid is not a created thing.
        // Reached whenever the two records do not BOTH corroborate a deletion,
        // and the message says which one is missing — because "nothing was
        // ever created" and "the governed path created it and no deletion was
        // ever recorded" send the reader to completely different places.
        const target = routes[p.kind]?.table
          ? `public.${routes[p.kind].table}`
          : `any table (kind "${p.kind}" has no route, so there is not even a table it could be in)`;
        const evidence = p.has_creation_audit === true
          ? 'An audit event DOES record this proposal creating it — but decide_discovery_proposal writes that event and created_object_id from the same variables in the same transaction, so it is the accept restating itself and is not evidence the object ever existed. What is MISSING is the independent half: NO tenant_activity_log DELETE row records this id being removed from that table, and that row is written by a trigger on the table itself, which can only fire if a row was there to delete.'
          : 'NO audit event records this proposal ever creating it (same tenant, decision=accepted, matching proposal_id, matching created_object_id, matching created_object_table), and NO tenant_activity_log DELETE row records it ever being removed. Nothing outside the stored uuid has ever seen this object.';
        failures.push(`${where}: ACCEPTED and carries created_object_id ${p.created_object_id}, which resolves to NO live row in ${target} for this workspace. ${evidence} This is the stored-marker-as-truth trap: the proposal, the card and the audit event all say the thing exists, and it does not.`);
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
    notes.push(`discovery-proposal-decisions: ${retired.length} ACCEPTED proposal(s) point at an object that NO LONGER EXISTS, whose creation IS recorded in the audit trail AND whose DELETION is independently recorded in tenant_activity_log by the trigger on the target table — ${retired.join(', ')}. Treated as retired, not dangling: the customer deleted the thing they accepted (authenticated holds DELETE on connectors, wired to Systems and MCP Servers). Both records are required; the audit event alone would be the accept restating itself. NOT a silent pass — if one of these should have been impossible to delete, that is a product decision to make now.`);
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
    notes.push('discovery-proposal-decisions: ⚠ NOT YET EXERCISED — public.discovery_proposals holds ZERO rows, so the ROW assertions (terminal-needs-decided_by/at, accepted-needs-created_object_id, kind-must-be-routable, created_object_id-must-resolve-in-this-tenant, accepted-needs-its-creation-audit, gone-object-needs-BOTH-records) compared ZERO rows this run and prove NOTHING about production behaviour yet. They are not green; they have nothing to examine. The route, expectation, exclusion-anchor, state, resolver-control and evidence-perimeter arms above DID run and are what this section actually proved today.');
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
    // Reported separately from expectationsExamined so that "the live half of
    // the exclusion check was driven" is a number on its own line rather than
    // an invisible contribution to a bigger one. Zero here with a non-empty
    // EXCLUSION_ANCHORS is a failure above, not a quiet 0.
    anchorsExamined: anchorProbes.length,
    statesExamined: statesInCheck.size,
    controlsExamined: controls.length,
    // Which workspace each cross_tenant arm contrasted with. Printed every
    // run — see where it is built.
    crossTenantContrasts,
    kindsPresent,
    admittedButUnroutable,
  };
}
