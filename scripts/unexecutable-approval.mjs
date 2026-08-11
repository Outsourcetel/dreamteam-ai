// ============================================================================
// unexecutable-approval.mjs — Ring-0: a pending approval that cannot be
// carried out.
//
// WHY THIS EXISTS. On 2026-08-11 two defects of ONE class shipped and were
// fixed within hours of each other, and no gate in this repository could see
// either of them:
//
//   * mig 701 — `run_dunning_sweep` raised collections approvals with
//     `connector_id => null`. The browser's approval path hands that column
//     straight to connector-hub, which refuses at the door
//     (`connector_id_required`, HTTP 400) before reading anything else. The
//     refusal was silent: `invokeHub` returns rather than throws when the
//     payload carries an `error`, and the result was discarded. A person
//     clicked Approve, the task flipped to `approved`, the screen said the work
//     was done, and no customer was chased.
//
//   * mig 703 — `due_approved_actions`, the approved-action driver's selector,
//     JOINED `action_definitions` on `ae.action_definition_id` (so it held the
//     exact executor on every row) and then returned the action_key and the
//     LABEL and dropped the ID. connector-hub is then left to re-derive the
//     definition from (connector, action_key), and `resolveActionDefinition`
//     refuses rather than guess — `action_ambiguous` — because
//     `send_payment_reminder` on ERPNext has two live executors, one an
//     internal invoice comment and one an EMAIL TO THE CUSTOMER. That refusal
//     would have arrived on a five-minute cron with nobody watching.
//
// Both are the same sentence: a row is sitting in front of a human asking to be
// approved, and it could not be executed even if they said yes. mig 590 wrote
// the rule down — "checking that an executor EXISTS is not the same as checking
// it has what it needs" — and this is the standing check that rule never got.
//
// ⚠ THE RULE IS CONNECTOR-HUB'S, NOT A PARAPHRASE OF IT. Everything below is
// lifted from `resolveActionDefinition`
// (supabase/functions/connector-hub/index.ts:2160-2219, read live). A probe
// whose resolution rule disagrees with the runtime's is fiction, and it would
// manufacture findings and miss real ones in the same pass. The runtime's list
// query is
//
//     .eq('category', connectorCategory)    // ← the CONNECTOR's category
//     .eq('action_key', actionKey)
//     .eq('status', 'active')
//     .or(`scope.eq.platform,tenant_id.eq.${tenantId}`)
//
// and `candidates` narrows that list to
//
//     (scope === 'tenant'   && tenant_id === tenantId) ||
//     (scope === 'platform' && (!connectorProvider || provider === connectorProvider))
//
// Two details that a reasonable-looking rewrite gets wrong:
//   1. `category` comes from the CONNECTOR row (`connector.category`), not from
//      the action definition. The two disagreeing is precisely one of the ways
//      a pair goes unresolvable.
//   2. PROVIDER IS NOT IN THE LIST QUERY. It appears only in the `candidates`
//      narrowing, so a provider mismatch cannot by itself produce
//      `action_definition_not_found` on the exact-match branch. The brief for
//      this probe said "provider/category/status mismatch"; the hub says
//      category/status/visibility. The hub wins — it is the thing that runs.
//
// ⚠⚠ AND THE COUNT, BECAUSE ZERO FINDINGS FROM ZERO COMPARISONS LOOKS EXACTLY
// LIKE A CLEAN RESULT. mig 701 back-filled the two known-bad rows the morning
// this was written, so the naive form of this probe finds nothing and looks
// green from having compared nothing. The `no-comparisons` arm below is a
// VIOLATION, not a pass: if the population of pending approvals is empty, or
// candidate resolution made no comparisons, the probe says so and goes red.
// Seven gates in this repository have already shipped unable to fail; this one
// reports its own denominator on every run.
// ============================================================================

/**
 * @param {object}  [opts]
 * @param {string}  [opts.extra]  Extra population rows, as a SELECT with the
 *   shape (exec_id uuid, tenant_id uuid, connector_id uuid, named_def uuid,
 *   action_key text, slug text, title text), UNIONed into the live population.
 *   Used by certify-mutation-test.mjs to drive the REAL query with a
 *   synthesised violating row instead of writing to production.
 * @param {boolean} [opts.empty]  Drop the live population entirely — the only
 *   way to prove the no-comparisons guard can fire.
 */
export function unexecutableApprovalSql(opts = {}) {
  const { extra = null, empty = false } = opts;
  return `
with pending as (
  -- THE POPULATION: every execution row parked in front of a human. Same
  -- shape the two fixed paths act on — the browser
  -- (resolve_action_execution_for_task -> resolveActionExecution) and the
  -- driver (due_approved_actions). 'expired' is excluded the way mig 642
  -- excludes it: only a task still awaiting a decision can still be approved.
  select ae.id                   as exec_id,
         ae.tenant_id            as tenant_id,
         ae.connector_id         as connector_id,
         ae.action_definition_id as named_def,
         ad.action_key           as action_key,
         t.slug                  as slug,
         ht.title                as title
    from human_tasks ht
    join action_executions ae  on ae.task_id = ht.id
    join action_definitions ad on ad.id = ae.action_definition_id
    join tenants t             on t.id = ae.tenant_id
   where ht.type = 'action_approval'
     and ht.status = 'pending'
     and ae.decision like 'human_gated%'
     and ae.rolled_back_at is null
     and ae.receipt is null${empty ? `
     -- MUTATION: population emptied, to prove the no-comparisons arm fires.
     and false` : ''}${extra ? `
  union all
${extra}` : ''}
),
selector as (
  -- Does the DRIVER's selector still hand the executor's identity forward?
  -- This is mig 703's defect, and it is the half of "ambiguous" that can
  -- actually fire today: action_executions.action_definition_id is NOT NULL at
  -- the table, so the row always KNOWS which executor was gated — the only way
  -- that knowledge fails to reach connector-hub is a caller that drops it.
  -- Anchored to the SELECT LIST, not to the bare token: mig 703 recorded a
  -- mutant that SURVIVED a bare match, because the JOIN condition
  -- \`ad.id = ae.action_definition_id\` further down satisfies it while the
  -- select list emits null::uuid. Comments are stripped first for the same
  -- reason mig 701 strips them — a pin satisfied by the prose above the code
  -- is green when it should be red.
  select coalesce(bool_or(
           regexp_replace(p.prosrc, '--[^\\n]*', '', 'g')
             ~ 'ae\\.connector_id,\\s*ae\\.action_definition_id'), false) as carries_executor
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'due_approved_actions'
),
resolved as (
  select p.*,
         c.id       as conn_id,
         c.category as conn_category,
         c.provider as conn_provider,
         coalesce(l.n_list, 0)     as n_list,
         coalesce(l.n_cand, 0)     as n_cand,
         coalesce(l.has_exact, false) as has_exact,
         l.opts
    from pending p
    -- The hub loads the connector by id AND tenant, and answers
    -- connector_not_found (404) when that misses.
    left join connectors c
      on c.id = p.connector_id and c.tenant_id = p.tenant_id
    left join lateral (
      select count(*) as n_list,
             count(*) filter (where
                  (d.scope = 'tenant'   and d.tenant_id = p.tenant_id)
               or (d.scope = 'platform'
                   and (coalesce(c.provider, '') = '' or d.provider = c.provider))
             ) as n_cand,
             bool_or(d.id = p.named_def) as has_exact,
             string_agg(coalesce(d.execution->>'execution_key', d.id::text), ' | '
                        order by coalesce(d.execution->>'execution_key', d.id::text)) as opts
        from action_definitions d
       where d.category   = c.category
         and d.action_key = p.action_key
         and d.status     = 'active'
         and (d.scope = 'platform' or d.tenant_id = p.tenant_id)
    ) l on true
),
counted as (
  select count(*) as population, coalesce(sum(n_list), 0) as comparisons from resolved
)

-- ── 1. UNROUTABLE — no connector can carry it. (mig 701's defect.) ──────────
select 'unroutable — ' || r.slug || ' / ' || coalesce(r.title, '(untitled)')
       || ' [execution ' || r.exec_id || ']: '
       || case when r.connector_id is null
               then 'action_executions.connector_id is NULL. connector-hub refuses at the door — connector_id_required, HTTP 400 — before it looks at the action at all, and the refusal is invisible to the approver.'
               else 'connector ' || r.connector_id || ' is not a connector of this workspace (deleted, or another tenant''s). connector-hub answers connector_not_found, HTTP 404.'
          end as violation,
       null::text as note
  from resolved r
 where r.connector_id is null or r.conn_id is null

union all

-- ── 2. AMBIGUOUS — more than one executor and nothing says which. (703.) ────
-- Two ways the disambiguator fails to reach the hub, and BOTH are checked:
--   a) the row itself does not carry one. Cannot happen while
--      action_executions.action_definition_id is NOT NULL — stated plainly
--      rather than pretended otherwise — and becomes live the day someone
--      drops that constraint or a new population arm carries nulls.
--   b) the caller that forwards the row drops it. That is mig 703 exactly, and
--      it is what makes this arm a real gate rather than decoration.
select 'ambiguous — ' || r.slug || ' / ' || coalesce(r.title, '(untitled)')
       || ' [execution ' || r.exec_id || ']: "' || r.action_key || '" has '
       || r.n_cand || ' registered executors on this connector (' || coalesce(r.opts, '?')
       || ') and '
       || case when r.named_def is null
               then 'the execution row names none of them'
               else 'public.due_approved_actions no longer forwards action_definition_id, so connector-hub is left to re-derive it'
          end
       || '. connector-hub refuses rather than guess — action_ambiguous — and on this pair the two executors are an internal note and an email to the customer.' as violation,
       null::text as note
  from resolved r
 cross join selector s
 where r.n_cand > 1
   and (r.named_def is null or not s.carries_executor)

union all

-- ── 3. MISMATCHED PAIR — the named executor is not reachable through the ────
--    named connector. connector-hub: action_definition_not_found.
-- Evaluated unconditionally, not gated on which branch the hub takes: a row
-- whose OWN recorded executor cannot be resolved through its OWN connector is
-- unexecutable however the caller asks for it.
select 'mismatched-pair — ' || r.slug || ' / ' || coalesce(r.title, '(untitled)')
       || ' [execution ' || r.exec_id || ']: the row names definition ' || r.named_def
       || ' (' || coalesce(nd.action_key, '?') || '), but '
       || case when nd.id is null then 'no such action definition exists'
               when nd.status <> 'active'
                 then 'its status is "' || nd.status || '" and the resolver only ever sees active definitions'
               when nd.category is distinct from r.conn_category
                 then 'it is registered in category "' || coalesce(nd.category, 'null')
                      || '" while the named connector is "' || coalesce(r.conn_category, 'null') || '"'
               when nd.scope = 'tenant' and nd.tenant_id is distinct from r.tenant_id
                 then 'it is tenant-scoped to another workspace'
               else 'it is not in the resolver''s visible set for this connector'
          end
       || '. connector-hub answers action_definition_not_found and nothing is sent.' as violation,
       null::text as note
  from resolved r
  left join action_definitions nd on nd.id = r.named_def
 where r.connector_id is not null and r.conn_id is not null
   and not r.has_exact

union all

-- ── 4. NO COMPARISONS — the gate that stops this gate becoming theatre. ─────
select 'no-comparisons — this probe examined ' || c.population
       || ' pending approval(s) and made ' || c.comparisons
       || ' candidate comparison(s). Zero of either means the three arms above '
       || 'proved NOTHING this run, and an empty result is indistinguishable '
       || 'from a clean one. Either the population query has drifted off the '
       || 'tables it means to read, or every pending approval resolves against '
       || 'an empty catalog — both are failures, neither is a pass.' as violation,
       null::text as note
  from counted c
 where c.population = 0 or c.comparisons = 0

union all

-- ── The denominator, surfaced on every run. \`violation\` is NULL, so certify
--    prints this and does not fail on it. Counting the comparisons is worth
--    nothing if nobody ever sees the count.
select null::text as violation,
       'unexecutable-approval: compared ' || c.population || ' pending approval(s) against '
       || c.comparisons || ' candidate definition(s)' as note
  from counted c
`;
}
