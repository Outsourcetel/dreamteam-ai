-- ============================================================================
-- 719 — TIER C, SLICE 3 of 3: live grants with no `src/` caller.
--       AUTHORITY, IDENTITY, CREDENTIALS AND ORG STRUCTURE.
--       35 command-grants across 16 tables. docs/52 §5 (TIER C).
--
-- THE RISKIEST SLICE, DELIBERATELY LAST. Slices 1 (mig 717, 100 grants) and 2
-- (mig 718, 57 grants) were applied and verified first precisely so that any
-- caller this audit failed to find would have surfaced on content or config
-- rows — where being wrong costs a failed write — before anything here moved.
-- Both verified clean: the write-allowlist diff showed exactly the expected
-- sets vanished and nothing else, all 81 keep-set grants intact, no 42501.
--
-- Why each of these is worth removing (docs/52 §5, "highest-value entries"):
--
--   tenant_api_keys (I/U/D)          API credentials. A live write path to
--                                    credential rows bounded only by a
--                                    tenant-scoped policy.
--   tenant_ip_allowlists (I/U/D)     A user who can edit the IP allowlist can
--   tenant_ip_allowlist_entries      widen the perimeter that gates themselves.
--   tenant_session_policies (I/U/D)  Session lifetime and re-auth rules — a
--                                    self-modifiable security control.
--   sso_attribute_role_map (I/U/D)   Maps IdP attributes to roles. Write
--                                    access is role self-assignment at the
--                                    next login.
--   de_autonomy (I/U/D)              THE TRUST DIAL. project_org_level_trust
--                                    records that the dials are DERIVED and
--                                    governed; a direct write is a bypass of
--                                    the entire governance path, and mig 710's
--                                    proposer role exists precisely so that
--                                    nothing but a human decision moves it.
--   profiles (INSERT/DELETE)         Identity rows.
--   human_tasks (DELETE)             Deleting rows out of the approval queue.
--   workspaces, departments (I/U/D)  Org structure. Compare mig 643, which
--   org_units (DELETE)               nearly left 11 of 12 workspaces
--                                    administrable by nobody.
--   de_connected_systems (I/U/D)     Feeds read_de_system / list_de_system,
--                                    which format('%I') its source_table and
--                                    id_column. The allowlist holds, but a
--                                    writable binding table next to a
--                                    dynamic-SQL reader is a bad adjacency.
--   widget_keys, tenant_sso_policy,  DELETE only; their INSERT/UPDATE have
--   mcp_server_allowlist,            callers and are in the KEEP-SET.
--   guardrail_rules
--
-- ⛔ THE `profiles` CARVE-OUT — the one that would be silent. `profiles` is
-- revoked for INSERT and DELETE ONLY. It has NO table-level UPDATE grant and
-- never did: the self-service profile editor runs entirely on three
-- COLUMN-level UPDATE grants (avatar, full_name, last_seen_at), which are a
-- SEPARATE ACL that a table-level `REVOKE ALL` would delete without any census
-- reading `role_table_grants` ever noticing. This migration names INSERT and
-- DELETE explicitly, never ALL, and asserts all three column grants still
-- exist afterwards — as do migs 714, 716, 717 and 718.
--
-- ROLLBACK — one line per table, e.g.
--   grant insert, update, delete on table public.de_autonomy     to authenticated;
--   grant insert, update, delete on table public.tenant_api_keys to authenticated;
--   grant insert, delete         on table public.profiles        to authenticated;
--   grant delete                 on table public.human_tasks     to authenticated;
-- The VALUES list below IS the rollback list; see mig 717's header for the
-- do-block skeleton that replays it as grants.
-- ============================================================================

do $$
declare
  r              record;
  n_revoked      int := 0;
  n_absent       int := 0;
  n_targets      int := 0;
  n_sel_before   int;  n_sel_after   int;
  n_col_before   int;  n_col_after   int;
  n_svc_before   int;  n_svc_after   int;
  n_dml_after    int;
  still          text;
  lost           text;
begin
  select count(*) into n_sel_before from information_schema.role_table_grants
   where table_schema='public' and grantee='authenticated' and privilege_type='SELECT';
  select count(*) into n_col_before from pg_attribute a join pg_class c on c.oid=a.attrelid
   where c.relnamespace='public'::regnamespace and c.relkind='r'
     and a.attacl is not null and a.attacl::text like '%authenticated%';
  select count(*) into n_svc_before from information_schema.role_table_grants
   where table_schema='public' and grantee='service_role'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','SELECT');

  create temp table _tier_targets (tbl text, priv text) on commit drop;
  insert into _tier_targets (tbl, priv) values
    ('de_autonomy','DELETE'), ('de_autonomy','INSERT'), ('de_autonomy','UPDATE'),
    ('de_connected_systems','DELETE'), ('de_connected_systems','INSERT'), ('de_connected_systems','UPDATE'),
    ('departments','DELETE'), ('departments','INSERT'), ('departments','UPDATE'),
    ('guardrail_rules','DELETE'),
    ('human_tasks','DELETE'),
    ('mcp_server_allowlist','UPDATE'),
    ('org_units','DELETE'),
    ('profiles','DELETE'), ('profiles','INSERT'),
    ('sso_attribute_role_map','DELETE'), ('sso_attribute_role_map','INSERT'), ('sso_attribute_role_map','UPDATE'),
    ('tenant_api_keys','DELETE'), ('tenant_api_keys','INSERT'), ('tenant_api_keys','UPDATE'),
    ('tenant_ip_allowlist_entries','DELETE'), ('tenant_ip_allowlist_entries','INSERT'), ('tenant_ip_allowlist_entries','UPDATE'),
    ('tenant_ip_allowlists','DELETE'), ('tenant_ip_allowlists','INSERT'), ('tenant_ip_allowlists','UPDATE'),
    ('tenant_session_policies','DELETE'), ('tenant_session_policies','INSERT'), ('tenant_session_policies','UPDATE'),
    ('tenant_sso_policy','DELETE'),
    ('widget_keys','DELETE'),
    ('workspaces','DELETE'), ('workspaces','INSERT'), ('workspaces','UPDATE');
  select count(*) into n_targets from _tier_targets;

  -- ── THE KEEP-SET: 81 command-grants across 38 tables that have a PROVEN
  --    src/ write caller (docs/52 §3a, independently re-derived by an inverted
  --    scan of all 217 files under src/ before this migration was written).
  --    These may never appear in a Tier C slice. The list is repeated in every
  --    slice on purpose: a guard that lives in one file and protects three is
  --    a guard that stops matching the thing it guards. ─────────────────────
  create temp table _keep_set (tbl text, priv text) on commit drop;
  insert into _keep_set (tbl, priv) values
    ('activity_events','INSERT'),
    ('approval_authority','DELETE'), ('approval_authority','INSERT'), ('approval_authority','UPDATE'),
    ('audit_logs','INSERT'),
    ('connector_actions','INSERT'), ('connector_actions','UPDATE'),
    ('connector_objects','INSERT'), ('connector_objects','UPDATE'),
    ('connectors','DELETE'), ('connectors','INSERT'), ('connectors','UPDATE'),
    ('customer_accounts','INSERT'), ('customer_accounts','UPDATE'),
    ('de_consultation_grants','INSERT'), ('de_consultation_grants','UPDATE'),
    ('de_playbook_charter','DELETE'), ('de_playbook_charter','INSERT'), ('de_playbook_charter','UPDATE'),
    ('de_profile_fields','INSERT'),
    ('golden_qa','DELETE'), ('golden_qa','INSERT'), ('golden_qa','UPDATE'),
    ('guardrail_rules','INSERT'), ('guardrail_rules','UPDATE'),
    ('health_score_config','INSERT'), ('health_score_config','UPDATE'),
    ('human_tasks','INSERT'), ('human_tasks','UPDATE'),
    ('knowledge_collections','DELETE'), ('knowledge_collections','INSERT'),
    ('knowledge_docs','DELETE'), ('knowledge_docs','INSERT'), ('knowledge_docs','UPDATE'),
    ('knowledge_gap_policies','UPDATE'),
    ('mcp_server_allowlist','DELETE'), ('mcp_server_allowlist','INSERT'),
    ('media_assets','INSERT'),
    ('onboarding_projects','UPDATE'),
    ('onboarding_templates','DELETE'), ('onboarding_templates','INSERT'), ('onboarding_templates','UPDATE'),
    ('opportunities','INSERT'), ('opportunities','UPDATE'),
    ('org_unit_members','DELETE'), ('org_unit_members','INSERT'), ('org_unit_members','UPDATE'),
    ('org_units','INSERT'), ('org_units','UPDATE'),
    ('playbook_definitions','INSERT'), ('playbook_definitions','UPDATE'),
    ('playbook_event_rules','DELETE'), ('playbook_event_rules','INSERT'), ('playbook_event_rules','UPDATE'),
    ('playbook_schedules','DELETE'), ('playbook_schedules','INSERT'), ('playbook_schedules','UPDATE'),
    ('push_subscriptions','DELETE'), ('push_subscriptions','INSERT'), ('push_subscriptions','UPDATE'),
    ('renewal_invoices','INSERT'), ('renewal_invoices','UPDATE'),
    ('support_tickets','INSERT'), ('support_tickets','UPDATE'),
    ('support_triage_rules','DELETE'), ('support_triage_rules','INSERT'), ('support_triage_rules','UPDATE'),
    ('tenant_entity_fields','INSERT'),
    ('tenant_outcome_pricing','INSERT'), ('tenant_outcome_pricing','UPDATE'),
    ('tenant_sso_policy','INSERT'), ('tenant_sso_policy','UPDATE'),
    ('widget_keys','INSERT'), ('widget_keys','UPDATE'),
    ('work_assignment_rules','DELETE'), ('work_assignment_rules','INSERT'), ('work_assignment_rules','UPDATE'),
    ('work_watchers','DELETE'), ('work_watchers','INSERT'), ('work_watchers','UPDATE'),
    ('workforce_actions','UPDATE');

  -- ── GUARD: refuse to revoke anything with a known live caller ────────────
  for r in select t.tbl, t.priv from _tier_targets t
            join _keep_set k on k.tbl = t.tbl and k.priv = t.priv
  loop
    raise exception 'TIER C SLICE 3 REFUSED: %.% is in the KEEP-SET — it has a proven src/ write caller and revoking it would return 42501 to a working feature. This slice was mis-built.', r.tbl, r.priv;
  end loop;

  -- ── Snapshot which keep-set grants are ACTUALLY HELD right now. The
  --    survival assertion below compares against THIS, not against the full
  --    keep-set: an environment that never had a grant did not lose it to
  --    this migration. The first draft asserted the full list and the dev
  --    rehearsal failed on 11 pairs dev has never held — the same shape of
  --    mistake as migs 714/715, and the third time the rehearsal caught it.
  create temp table _keep_before (tbl text, priv text) on commit drop;
  insert into _keep_before (tbl, priv)
  select k.tbl, k.priv from _keep_set k
   where to_regclass('public.' || quote_ident(k.tbl)) is not null
     and has_table_privilege('authenticated', to_regclass('public.' || quote_ident(k.tbl)), k.priv);

  -- ── THE REVOKE ───────────────────────────────────────────────────────────
  for r in select t.tbl, t.priv from _tier_targets t order by t.tbl, t.priv loop
    if to_regclass('public.' || quote_ident(r.tbl)) is not null then
      execute format('revoke %s on table public.%I from authenticated', r.priv, r.tbl);
      n_revoked := n_revoked + 1;
    else
      n_absent := n_absent + 1;   -- replay-safety; dev lacks some prod tables
    end if;
  end loop;

  -- ── ASSERT: the targets actually lost the privilege ──────────────────────
  -- to_regclass, never ::regclass: the cast RAISES 42P01 on a table this
  -- database does not have, and Postgres does not promise to evaluate the
  -- existence filter first.
  select string_agg(t.tbl || '.' || t.priv, ', ') into still
    from _tier_targets t
   where to_regclass('public.' || quote_ident(t.tbl)) is not null
     and has_table_privilege('authenticated', to_regclass('public.' || quote_ident(t.tbl)), t.priv);
  if still is not null then
    raise exception 'TIER C SLICE 3 FAILED: authenticated still holds %', left(still, 800);
  end if;

  -- ── ASSERT THE OTHER HALF: every keep-set grant SURVIVED ─────────────────
  -- This is the mig-643 guard. A revoke that removes more than intended is
  -- invisible from the revoking side, because REVOKE reports nothing either
  -- way. The keep-set is where a legitimate writer would be locked out, so it
  -- is checked directly rather than inferred from a count.
  select string_agg(k.tbl || '.' || k.priv, ', ') into lost
    from _keep_before k
   where not has_table_privilege('authenticated', to_regclass('public.' || quote_ident(k.tbl)), k.priv);
  if lost is not null then
    raise exception 'TIER C SLICE 3 OVER-REVOKED: the keep-set lost % — a feature with a live src/ caller is now getting 42501', left(lost, 800);
  end if;
  raise notice 'TIER C SLICE 3: keep-set survival checked against % grant(s) actually held before this migration.',
    (select count(*) from _keep_before);

  select count(*) into n_sel_after from information_schema.role_table_grants
   where table_schema='public' and grantee='authenticated' and privilege_type='SELECT';
  select count(*) into n_col_after from pg_attribute a join pg_class c on c.oid=a.attrelid
   where c.relnamespace='public'::regnamespace and c.relkind='r'
     and a.attacl is not null and a.attacl::text like '%authenticated%';
  select count(*) into n_svc_after from information_schema.role_table_grants
   where table_schema='public' and grantee='service_role'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','SELECT');
  select count(*) into n_dml_after from information_schema.role_table_grants g
   where g.table_schema='public' and g.grantee='authenticated'
     and g.privilege_type in ('INSERT','UPDATE','DELETE')
     and exists (select 1 from pg_class c
                  where c.relname=g.table_name and c.relnamespace='public'::regnamespace and c.relkind='r');

  if n_sel_after <> n_sel_before then
    raise exception 'TIER C SLICE 3 OVER-REVOKED: authenticated SELECT went from % to %', n_sel_before, n_sel_after;
  end if;
  if n_col_after <> n_col_before then
    raise exception 'TIER C SLICE 3 CARVE-OUT BROKEN: profiles column-level grants went from % to %', n_col_before, n_col_after;
  end if;
  if n_col_before > 0 and (
        not has_column_privilege('authenticated','public.profiles','avatar','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','full_name','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','last_seen_at','UPDATE')) then
    raise exception 'TIER C SLICE 3 CARVE-OUT BROKEN: a profiles column-level UPDATE grant is gone — that is the entire self-service profile editor';
  end if;
  if n_svc_after <> n_svc_before then
    raise exception 'TIER C SLICE 3 OVER-REVOKED: service_role grants went from % to %', n_svc_before, n_svc_after;
  end if;
  if to_regclass('public.de_deployment_stages') is not null
     and not has_table_privilege('authenticated','public.de_deployment_stages','UPDATE') then
    raise exception 'TIER C SLICE 3 CARVE-OUT BROKEN: de_deployment_stages UPDATE was revoked — it is deliberately held back (docs/52 §5)';
  end if;

  raise notice 'TIER C SLICE 3: % target(s); % revoked, % absent. authenticated now holds % INSERT/UPDATE/DELETE grant(s) on public base tables. Keep-set intact; SELECT unchanged at %; profiles column grants %; service_role unchanged at %.',
    n_targets, n_revoked, n_absent, n_dml_after, n_sel_after, n_col_after, n_svc_after;
end $$;
