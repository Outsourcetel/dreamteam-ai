-- ============================================================================
-- 714 — TIER A: revoke TRUNCATE from `authenticated`, everywhere in `public`.
--
-- docs/52 §4. `authenticated` is the role every logged-in browser session runs
-- as — this repo's own note (mig 365) calls it "the internet". It held TRUNCATE
-- on 245 of 294 public base tables, and **PostgreSQL does not apply RLS to
-- TRUNCATE**. `playbook_versions` is the worked example: RLS on, exactly one
-- policy (SELECT), no DML policy at all — so RLS refuses INSERT/UPDATE/DELETE
-- from that role, and one TRUNCATE from the same role would destroy all 104
-- rows across every tenant without a policy ever being consulted.
--
-- It is LATENT, not live. docs/52 §2 checked six paths and all six are blocked
-- today (no LOGIN, no PostgREST verb, no invoker function with dynamic SQL, no
-- TRUNCATE statement anywhere in the database's own code, no `cron` USAGE, no
-- dblink). This migration is a pure subtraction: there is no caller.
--
-- ⚠ THE REVOKE IS NOT A DESCRIPTION OF THE RESULT. `REVOKE` succeeds whether or
-- not the grant was there, revokes nothing if the privilege arrived through a
-- role membership, and reports no rows either way. Everything below the loop is
-- the assertion that turns "I ran a statement" into "I measured the state".
--
-- ⚠ BOTH HALVES. Mig 643 nearly left 11 of 12 workspaces administrable by
-- nobody; a revoke that locks out a legitimate writer is the same defect
-- wearing the opposite mask. So this asserts what SURVIVED as hard as what
-- went: service_role and postgres keep TRUNCATE, `authenticated` keeps every
-- SELECT it had, and the three column-level UPDATE grants on `profiles` — the
-- entire self-service profile editor (docs/52 §3c) — are counted before and
-- after and must not move.
--
-- ROLLBACK. There is no reason to want one, but it must be a paste and not an
-- investigation. To restore the exact prior state:
--
--   do $$ declare r record; begin
--     for r in select c.relname from pg_class c
--               where c.relnamespace='public'::regnamespace and c.relkind in ('r','v')
--               order by 1
--     loop execute format('grant truncate on table public.%I to authenticated', r.relname); end loop;
--   end $$;
--
-- That re-grants TRUNCATE on all base tables and views. The prior state was 245
-- base tables + 3 views (`eval_gate`, `pipeline_summary`,
-- `tenant_sso_effective_policy`) — the 49 base tables that did NOT hold it are
-- listed in the ledger note at the foot of this file, so a literal restore is
-- possible if one is ever wanted. TRUNCATE on a view is inert in Postgres.
-- ============================================================================

do $$
declare
  r              record;
  n_trunc_before int;
  n_trunc_after  int;
  n_sel_before   int;
  n_sel_after    int;
  n_col_before   int;
  n_col_after    int;
  n_svc_before   int;
  n_svc_after    int;
  n_pg_before    int;
  n_pg_after     int;
  n_revoked      int := 0;
  n_base         int;
begin
  -- ── BEFORE: the three numbers this migration must move, and must not ─────
  select count(*) into n_trunc_before from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated'
     and privilege_type = 'TRUNCATE';

  select count(*) into n_sel_before from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated'
     and privilege_type = 'SELECT';

  select count(*) into n_col_before from pg_attribute a
    join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and a.attacl is not null and a.attacl::text like '%authenticated%';

  select count(*) into n_base from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r';

  select count(*) into n_svc_before from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and has_table_privilege('service_role', c.oid, 'TRUNCATE');
  select count(*) into n_pg_before from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and has_table_privilege('postgres', c.oid, 'TRUNCATE');

  -- ── THE REVOKE ───────────────────────────────────────────────────────────
  -- Driven off the grant catalogue itself, not a transcribed list of 248 names:
  -- the loop revokes exactly the surface that holds the privilege, so it is
  -- correct on a replay against a rebuilt database with a different table set.
  -- `ON TABLE` is the generic relation form and covers the 3 view grants too.
  for r in
    select distinct g.table_name
      from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.grantee = 'authenticated'
       and g.privilege_type = 'TRUNCATE'
     order by 1
  loop
    execute format('revoke truncate on table public.%I from authenticated', r.table_name);
    n_revoked := n_revoked + 1;
  end loop;

  -- ── AFTER: assert, do not assume ─────────────────────────────────────────
  select count(*) into n_trunc_after from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated'
     and privilege_type = 'TRUNCATE';

  select count(*) into n_sel_after from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated'
     and privilege_type = 'SELECT';

  select count(*) into n_col_after from pg_attribute a
    join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and a.attacl is not null and a.attacl::text like '%authenticated%';

  select count(*) into n_svc_after from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and has_table_privilege('service_role', c.oid, 'TRUNCATE');
  select count(*) into n_pg_after from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and has_table_privilege('postgres', c.oid, 'TRUNCATE');

  -- 1. The half that had to go.
  if n_trunc_after <> 0 then
    raise exception 'TIER A FAILED: authenticated still holds TRUNCATE on % relation(s) in public (was %, revoked %)',
      n_trunc_after, n_trunc_before, n_revoked;
  end if;

  -- 2. The half that had to stay — the roles that actually run migrations,
  --    delete_tenant, and every maintenance script. A SECURITY DEFINER
  --    function whose owner lost a privilege fails at CALL time, not here.
  --
  --    ⚠ Asserted as a DELTA (before = after), not as "every table has it".
  --    The first draft of this block asserted the latter and the dev rehearsal
  --    failed on `de_connected_systems` — because on dev service_role is
  --    missing TRUNCATE on 199 tables for reasons that predate and have
  --    nothing to do with this migration. An assertion that encodes one
  --    environment's state is not an assertion about the change; it is a
  --    tripwire that fires on the wrong thing and gets deleted by whoever
  --    hits it next. What this migration must prove is that it took nothing
  --    from these two roles.
  if n_svc_after <> n_svc_before then
    raise exception 'TIER A OVER-REVOKED: service_role TRUNCATE went from % to % relation(s)', n_svc_before, n_svc_after;
  end if;
  if n_pg_after <> n_pg_before then
    raise exception 'TIER A OVER-REVOKED: postgres TRUNCATE went from % to % relation(s)', n_pg_before, n_pg_after;
  end if;
  -- The worked example from §0, named explicitly so the failure message says
  -- the thing a reader cares about rather than a count.
  if not has_table_privilege('service_role', 'public.playbook_versions', 'TRUNCATE')
     or not has_table_privilege('postgres',  'public.playbook_versions', 'TRUNCATE') then
    raise exception 'TIER A OVER-REVOKED: service_role/postgres lost TRUNCATE on playbook_versions';
  end if;

  -- 3. SELECT is the product. `REVOKE ALL` would have taken it; naming the one
  --    privilege is why it did not. Measured, not trusted.
  if n_sel_after <> n_sel_before then
    raise exception 'TIER A OVER-REVOKED: authenticated SELECT went from % to %', n_sel_before, n_sel_after;
  end if;

  -- 4. The carve-out. `profiles.avatar/full_name/last_seen_at` carry
  --    column-level UPDATE for authenticated and are the whole self-service
  --    profile editor (docs/52 §3c). A table-level REVOKE ALL deletes them
  --    silently — column ACLs are a separate ACL from the table ACL, so a
  --    census that reads only role_table_grants cannot see them go.
  --    Delta first (environment-independent), then the named check, which
  --    only applies where the grants exist at all — dev has none.
  if n_col_after <> n_col_before then
    raise exception 'TIER A CARVE-OUT BROKEN: profiles column grants went from % to %',
      n_col_before, n_col_after;
  end if;
  if n_col_before > 0 and (
        not has_column_privilege('authenticated', 'public.profiles', 'avatar',        'UPDATE')
     or not has_column_privilege('authenticated', 'public.profiles', 'full_name',     'UPDATE')
     or not has_column_privilege('authenticated', 'public.profiles', 'last_seen_at',  'UPDATE')) then
    raise exception 'TIER A CARVE-OUT BROKEN: a profiles column-level UPDATE grant is gone';
  end if;

  raise notice 'TIER A: revoked TRUNCATE from authenticated on % relation(s) (% base tables in public). authenticated SELECT unchanged at %; profiles column grants intact at %.',
    n_revoked, n_base, n_sel_after, n_col_after;
end $$;

-- ── LEDGER NOTE — the exact prior state, so the rollback can be literal ─────
-- 245 of 294 public base tables held TRUNCATE for `authenticated`, plus 3 views
-- (`eval_gate`, `pipeline_summary`, `tenant_sso_effective_policy`).
--
-- These 49 base tables did NOT hold it, measured on production 2026-08-12
-- immediately before this migration. The blanket re-grant above would give
-- TRUNCATE to these 49 as well; a byte-exact restore must exclude them:
--
--   agentic_step_messages, agentic_step_policies, agentic_step_runs,
--   approval_briefs, audit_chain_anomalies, audit_chain_state, audit_events,
--   auth_login_lockouts, benchmark_samples, de_config, de_config_audit_log,
--   de_config_schemas, de_consultation_grants, de_development_items,
--   de_exceptions, de_learned_behavior_cluster_members,
--   de_learned_behavior_clusters, de_learning_edits, de_learning_policies,
--   de_objective_wakes, dispatch_log, dormancy_writer_exemptions,
--   draft_responses, human_tasks, inbox_watch_state,
--   knowledge_gap_cluster_members, knowledge_gap_clusters,
--   knowledge_gap_policies, platform_access_events, platform_capability_grants,
--   platform_config, platform_invites, platform_kb_change_impacts,
--   platform_kb_changes, platform_knowledge_audit, platform_knowledge_chunks,
--   platform_knowledge_docs, platform_knowledge_shelf_state,
--   platform_knowledge_usage_daily, remote_access_write_log,
--   sso_attribute_role_map, system_categories, tenant_activity_log,
--   tenant_ancestry, tenant_domains, tenant_llm_credentials,
--   tenant_parity_exemptions, tenant_sso_policy, work_item_claims
--
-- The 245/49 split carries no design intent: it is an artefact of when each
-- table was created relative to the default-privilege history (§6). That is
-- precisely why mig 715 fixes the defaults — without it, table 295 is born
-- holding TRUNCATE again and this migration decays silently.
