// ============================================================================
// advisory-boundary.mjs — Ring-0: the advisory layer cannot decide.
//
// Mig 705 put an ADVISORY BRIEF beside every pending approval: deterministic,
// SQL-derived evidence plus a rail-computed risk rank. The entire value of
// that layer rests on one sentence: IT NEVER DECIDES. It never calls
// decide_human_task, never touches human_tasks, never auto-approves. Gap 2
// (auto-approve) is a founder decision and is explicitly out of scope.
//
// The boundary is PRIVILEGE, not promise: every function that writes a brief
// is SECURITY DEFINER and OWNED by the NOLOGIN role `approval_brief_writer`,
// and that role holds exactly (a) EXECUTE on two read-only evidence readers
// and (b) SELECT/INSERT/UPDATE on approval_briefs. This probe re-asserts the
// whole arrangement on every certify run, because a boundary nobody
// re-measures is a boundary until the first quiet GRANT.
//
// ⚠ has_function_privilege / has_table_privilege answer INCLUDING inheritance
// through PUBLIC — the four-traps lesson that a REVOKE is not a description
// of the resulting privileges. That is why the arms ask the privilege
// question, never "was a revoke issued".
//
// ⚠ AND THE COUNT. The coverage half reports its own denominator on every
// run: how many pending approvals were scanned, how many briefs exist. Zero
// findings from zero comparisons looks exactly like a clean result, so an
// empty task scan is a VIOLATION, never a pass.
// ============================================================================

/**
 * @param {object}  [opts]
 * @param {string}  [opts.orphanExtra]  Extra rows for the coverage arm's task
 *   scan, as a SELECT with the shape (task_id uuid, tenant_id uuid, slug text,
 *   title text). Whether a row is FLAGGED still depends on the real
 *   approval_briefs table — a fixture carrying a task id that HAS a brief
 *   stays silent, which is what makes the mutation cases discriminating.
 * @param {boolean} [opts.emptyTasks]  Drop the coverage arm's task scan — the
 *   only way to prove its no-comparisons guard fires.
 */
export function advisoryBoundarySql(opts = {}) {
  const { orphanExtra = null, emptyTasks = false } = opts;
  return `
with role_present as (
  select exists (select 1 from pg_roles where rolname = 'approval_brief_writer') as ok
),
-- ⚠ Resolved as an OID join, not a name literal: has_function_privilege('name',…)
-- RAISES 42704 when the role does not exist, which would turn the exact
-- violation this probe most needs to report (role-gone) into a probe ERROR.
-- Joining pg_roles makes the privilege arms yield zero rows in that state and
-- lets arm 1 speak. Proven by the role-gone live mutant on dev.
brief_role as (
  select oid from pg_roles where rolname = 'approval_brief_writer'
),
live_fns as (
  select p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         r.rolname as owner,
         p.prosecdef,
         p.provolatile,
         regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') as src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname = 'public'
),
tasks as (
  -- THE COVERAGE POPULATION: every pending approval as the human sees it.
  -- LEFT join to tenants so a task whose workspace row is gone still counts.
  select ht.id as task_id, ht.tenant_id,
         coalesce(t.slug, '(tenant ' || ht.tenant_id || ' missing)') as slug,
         ht.title
    from human_tasks ht
    left join tenants t on t.id = ht.tenant_id
   where ht.type = 'action_approval'
     and ht.status = 'pending'${emptyTasks ? `
     -- MUTATION: task scan emptied, to prove the no-comparisons guard fires.
     and false` : ''}${orphanExtra ? `
  union all
${orphanExtra}` : ''}
),
counted as (
  select (select count(*) from tasks) as task_population,
         (select count(*) from approval_briefs) as briefs_total,
         (select count(*) from tasks k
           where not exists (select 1 from approval_briefs b where b.task_id = k.task_id)) as missing
)

-- ── 1. ROLE GONE — a boundary with no subject. ──────────────────────────────
select 'role-gone — the approval_brief_writer role does not exist. Every brief '
       || 'writer would now run as whatever owns it (postgres holds every '
       || 'privilege), and the advisory boundary has no subject to assert.' as violation,
       null::text as note
  from role_present where not ok

union all

-- ── 2. CAN DECIDE — the one thing the advisory layer must never do. ─────────
select 'can-decide — approval_brief_writer holds EXECUTE on public.' || f.sig
       || '. The advisory layer can now call the decision RPC; a brief that '
       || 'can decide is not advice, it is an approver nobody hired.' as violation,
       null::text as note
  from live_fns f, brief_role br
 where f.sig like 'decide_human_task(%'
   and has_function_privilege(br.oid, f.oid, 'EXECUTE')

union all

-- ── 3. CAN WRITE THE QUEUE — decide_human_task is not the only pen. ─────────
select 'can-write-queue — approval_brief_writer holds ' || v.priv
       || ' on public.human_tasks. human_tasks.status IS the human''s decision; '
       || 'a layer that can write that column can approve without ever calling '
       || 'the RPC.' as violation,
       null::text as note
  from (values ('INSERT'), ('UPDATE'), ('DELETE')) v(priv), brief_role br
 where has_table_privilege(br.oid, 'public.human_tasks'::regclass, v.priv)

union all

-- ── 4. IDENTITY DRIFT — writers must RUN AS the role; readers must be unable
--      to write (STABLE is engine-enforced, not convention). ────────────────
select 'identity-drift — ' || exp.sig || ': '
       || case when f.oid is null then 'function is GONE — the advisory layer lost a limb and the boundary claims below it are vacuous'
               when f.owner is distinct from exp.owner
                 then 'owned by ' || f.owner || ', expected ' || exp.owner
                      || case when exp.kind = 'writer'
                              then ' — a writer owned by anything but the boundary role runs with that owner''s privileges and the boundary is theatre'
                              else ' — the readers bypass RLS deliberately and must stay under postgres, never under a role someone can widen' end
               when exp.kind = 'writer' and not f.prosecdef
                 then 'no longer SECURITY DEFINER — it now runs as the CALLER, and authenticated callers hold EXECUTE on decide_human_task'
               when exp.kind = 'reader' and f.provolatile = 'v'
                 then 'VOLATILE — a reader that may write is a writer in waiting; STABLE is what makes the engine itself refuse'
               when exp.sig = 'list_approval_briefs()' and f.src not ilike '%refresh_approval_briefs_internal%'
                 then 'no longer recomputes before returning — it would serve a STORED brief as current truth, the stored-marker trap this repo has paid for four times'
          end as violation,
       null::text as note
  from (values
    -- ⚠ identity arguments INCLUDE parameter names (proven on dev: '(uuid)'
    -- matched nothing and reported all three as GONE).
    ('list_approval_briefs()',                             'approval_brief_writer', 'writer'),
    ('refresh_approval_briefs_internal(p_tenant_id uuid)', 'approval_brief_writer', 'writer'),
    ('approval_brief_on_new_task()',                       'approval_brief_writer', 'writer'),
    ('compute_approval_brief(p_task_id uuid)',             'postgres',              'reader'),
    ('pending_approval_briefables(p_tenant_id uuid)',      'postgres',              'reader')
  ) exp(sig, owner, kind)
  left join live_fns f on f.sig = exp.sig
 where f.oid is null
    or f.owner is distinct from exp.owner
    or (exp.kind = 'writer' and not f.prosecdef)
    or (exp.kind = 'reader' and f.provolatile = 'v')
    or (exp.sig = 'list_approval_briefs()' and f.src not ilike '%refresh_approval_briefs_internal%')

union all

-- ── 5. READER PERIMETER — their task/tenant parameter would otherwise BE the
--      authorisation (the mig-662 class). ───────────────────────────────────
select 'reader-reachable — ' || f.sig || ' is executable by ' || who.r
       || '. It takes an id from its caller and reads across tenants by '
       || 'design; the only lawful callers are the brief writer and the '
       || 'service role.' as violation,
       null::text as note
  from live_fns f
 cross join (values ('anon'), ('authenticated'), ('public')) who(r)
 where f.sig in ('compute_approval_brief(p_task_id uuid)',
                 'pending_approval_briefables(p_tenant_id uuid)',
                 'refresh_approval_briefs_internal(p_tenant_id uuid)')
   and has_function_privilege(who.r, f.oid, 'EXECUTE')

union all

-- ── 6. REACHABLE DECIDER — the two-paths trap. The role must not be able to
--      reach ANY function that writes the queue or calls the decider, not
--      just the front door. Trigger-returning functions are excluded because
--      Postgres refuses to call them directly. ─────────────────────────────
select 'reachable-decider — approval_brief_writer can EXECUTE public.' || f.sig
       || ', whose body ' ||
       case when f.src ~* '\\mdecide_human_task\\s*\\(' then 'calls decide_human_task'
            else 'writes human_tasks' end
       || '. The boundary holds only if NOTHING the role can reach can decide.' as violation,
       null::text as note
  from live_fns f
  join pg_proc p on p.oid = f.oid
 cross join brief_role br
 where p.prorettype <> 'trigger'::regtype
   and p.prokind in ('f','p')
   and has_function_privilege(br.oid, f.oid, 'EXECUTE')
   and (f.src ~* 'update\\s+(public\\.)?human_tasks'
     or f.src ~* '\\mdecide_human_task\\s*\\(')

union all

-- ── 7. COVERAGE — a pending approval without a brief. The trigger writes one
--      at birth and the migration backfilled the stock, so a missing row
--      means the coverage machinery broke. ─────────────────────────────────
select 'missing-brief — ' || k.slug || ' / ' || coalesce(k.title, '(untitled)')
       || ' [task ' || k.task_id || ']: pending approval with NO brief row. '
       || 'Either trg_approval_brief_on_new_task stopped firing or the row '
       || 'was removed; the decider is back to a raw request.' as violation,
       null::text as note
  from tasks k
 where not exists (select 1 from approval_briefs b where b.task_id = k.task_id)

union all

-- ── 8. NO COMPARISONS — the guard against this gate becoming theatre. ───────
select 'no-comparisons — the coverage arm scanned ' || c.task_population
       || ' pending approval task(s). Zero means arm 7 proved nothing this '
       || 'run: either the population query drifted off human_tasks or every '
       || 'approval vanished at once — both are failures, neither is a pass.' as violation,
       null::text as note
  from counted c
 where c.task_population = 0

union all

-- ── The denominator, surfaced on every run (violation NULL: printed, never
--    failed on). ─────────────────────────────────────────────────────────────
select null::text as violation,
       'advisory-boundary: scanned ' || c.task_population
       || ' pending approval task(s); ' || c.missing || ' without a brief; '
       || c.briefs_total || ' brief(s) stored' as note
  from counted c
`;
}
