-- ============================================================================
-- 718 — TIER C, SLICE 2 of 3: live grants with no `src/` caller.
--       CONFIG, POLICY AND COMMERCIAL OBJECTS.
--       57 command-grants across 24 tables. docs/52 §5 (TIER C).
--
-- Slice 1 (mig 717) revoked 100 grants across 45 content/retrieval tables and
-- was verified before this one: the write-allowlist diff showed exactly the
-- expected set vanished and nothing else, all 81 keep-set grants intact, and
-- the Postgres log carried no 42501 in the window after it applied.
--
-- This slice moves up one rung in authority. These are the tables that decide
-- how the product BEHAVES rather than what it contains — agentic step policies,
-- learning policies, staleness policies, guardrail-adjacent config, feature
-- toggles, billing config, pricing, and the commercial objects
-- (agreements, catalog items, agreement lines). None has a `src/` write caller.
--
-- ⚠ Note the per-COMMAND grain, because it is what makes this safe. Several
-- tables here keep grants that ARE called and lose only the ones that are not:
--   · knowledge_gap_policies — UPDATE is in the keep-set and STAYS; only its
--     INSERT and DELETE are revoked here.
--   · tenant_entity_fields — INSERT is in the keep-set and STAYS; UPDATE and
--     DELETE go.
--   · tenant_outcome_pricing — INSERT/UPDATE stay; only DELETE goes.
--   · playbook_definitions — INSERT/UPDATE stay; only DELETE goes.
--   · health_score_config — INSERT/UPDATE stay; only DELETE goes.
--   · de_profile_fields — INSERT stays; UPDATE/DELETE go.
--   · onboarding_projects — UPDATE stays; INSERT/DELETE go.
--   · digital_employees — INSERT/UPDATE go; its DELETE was already RLS-dead
--     and went in Tier B.
-- A per-table revoke would have broken every one of those. The keep-set guard
-- below is what enforces the distinction rather than trusting this comment.
--
-- ROLLBACK — one line per table, e.g.
--   grant insert, delete on table public.knowledge_gap_policies to authenticated;
--   grant delete         on table public.playbook_definitions   to authenticated;
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
    ('agentic_step_policies','DELETE'), ('agentic_step_policies','INSERT'), ('agentic_step_policies','UPDATE'),
    ('agreement_lines','DELETE'), ('agreement_lines','INSERT'), ('agreement_lines','UPDATE'),
    ('ai_model_pricing','DELETE'), ('ai_model_pricing','INSERT'), ('ai_model_pricing','UPDATE'),
    ('capabilities','DELETE'), ('capabilities','INSERT'), ('capabilities','UPDATE'),
    ('commercial_agreements','DELETE'), ('commercial_agreements','INSERT'), ('commercial_agreements','UPDATE'),
    ('commercial_catalog_items','DELETE'), ('commercial_catalog_items','INSERT'), ('commercial_catalog_items','UPDATE'),
    ('continuity_stage_config','DELETE'), ('continuity_stage_config','INSERT'), ('continuity_stage_config','UPDATE'),
    ('de_assignments','DELETE'), ('de_assignments','INSERT'), ('de_assignments','UPDATE'),
    ('de_learning_policies','DELETE'), ('de_learning_policies','INSERT'), ('de_learning_policies','UPDATE'),
    ('de_playbook_assignments','DELETE'), ('de_playbook_assignments','INSERT'), ('de_playbook_assignments','UPDATE'),
    ('de_profile_fields','DELETE'), ('de_profile_fields','UPDATE'),
    ('digital_employees','INSERT'), ('digital_employees','UPDATE'),
    ('health_score_config','DELETE'),
    ('knowledge_gap_policies','DELETE'), ('knowledge_gap_policies','INSERT'),
    ('onboarding_projects','DELETE'), ('onboarding_projects','INSERT'),
    ('playbook_definitions','DELETE'),
    ('staleness_policies','DELETE'), ('staleness_policies','INSERT'), ('staleness_policies','UPDATE'),
    ('system_categories','DELETE'), ('system_categories','INSERT'), ('system_categories','UPDATE'),
    ('tenant_ai_usage','DELETE'), ('tenant_ai_usage','INSERT'), ('tenant_ai_usage','UPDATE'),
    ('tenant_billing_config','UPDATE'),
    ('tenant_comms_settings','DELETE'), ('tenant_comms_settings','INSERT'), ('tenant_comms_settings','UPDATE'),
    ('tenant_entity_fields','DELETE'), ('tenant_entity_fields','UPDATE'),
    ('tenant_feature_toggles','UPDATE'),
    ('tenant_outcome_pricing','DELETE');
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
    raise exception 'TIER C SLICE 2 REFUSED: %.% is in the KEEP-SET — it has a proven src/ write caller and revoking it would return 42501 to a working feature. This slice was mis-built.', r.tbl, r.priv;
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
    raise exception 'TIER C SLICE 2 FAILED: authenticated still holds %', left(still, 800);
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
    raise exception 'TIER C SLICE 2 OVER-REVOKED: the keep-set lost % — a feature with a live src/ caller is now getting 42501', left(lost, 800);
  end if;
  raise notice 'TIER C SLICE 2: keep-set survival checked against % grant(s) actually held before this migration.',
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
    raise exception 'TIER C SLICE 2 OVER-REVOKED: authenticated SELECT went from % to %', n_sel_before, n_sel_after;
  end if;
  if n_col_after <> n_col_before then
    raise exception 'TIER C SLICE 2 CARVE-OUT BROKEN: profiles column-level grants went from % to %', n_col_before, n_col_after;
  end if;
  if n_col_before > 0 and (
        not has_column_privilege('authenticated','public.profiles','avatar','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','full_name','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','last_seen_at','UPDATE')) then
    raise exception 'TIER C SLICE 2 CARVE-OUT BROKEN: a profiles column-level UPDATE grant is gone — that is the entire self-service profile editor';
  end if;
  if n_svc_after <> n_svc_before then
    raise exception 'TIER C SLICE 2 OVER-REVOKED: service_role grants went from % to %', n_svc_before, n_svc_after;
  end if;
  if to_regclass('public.de_deployment_stages') is not null
     and not has_table_privilege('authenticated','public.de_deployment_stages','UPDATE') then
    raise exception 'TIER C SLICE 2 CARVE-OUT BROKEN: de_deployment_stages UPDATE was revoked — it is deliberately held back (docs/52 §5)';
  end if;

  raise notice 'TIER C SLICE 2: % target(s); % revoked, % absent. authenticated now holds % INSERT/UPDATE/DELETE grant(s) on public base tables. Keep-set intact; SELECT unchanged at %; profiles column grants %; service_role unchanged at %.',
    n_targets, n_revoked, n_absent, n_dml_after, n_sel_after, n_col_after, n_svc_after;
end $$;
