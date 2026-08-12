-- ============================================================================
-- 717 — TIER C, SLICE 1 of 3: live grants with no `src/` caller.
--       CONTENT, RETRIEVAL, CONVERSATION AND DOCUMENT ROWS.
--       100 command-grants across 45 tables. docs/52 §5 (TIER C).
--
-- THIS IS THE GENUINELY RISKY TIER, and it is worth saying why in one place.
-- Unlike Tier B, a PERMISSIVE policy exists for every grant below, so
-- `authenticated` CAN perform these commands today. Nothing in `src/` does —
-- that was established by an inverted scan of all 217 files under `src/`
-- (write verbs walked BACKWARDS to the nearest `.from()`, so a chained call is
-- resolved rather than guessed), by reading all 6 `asUser` edge-function
-- clients, and by mapping the 3 SECURITY INVOKER trigger functions that
-- perform DML. But **absence of a caller is evidence, not proof.** A caller
-- could live in a surface this audit did not read, or arrive tomorrow.
--
-- Hence slices. Each slice is a separate migration, separately committed,
-- separately verified, so a regression NAMES ITS OWN SLICE instead of pointing
-- at 192 grants at once. Each reverts with a one-line `grant`.
--
-- ⚠ SLICE ORDER: RISKIEST LAST. docs/52 §8 proposed the opposite — security
-- controls first, on the argument that they have the smallest blast radius and
-- are the most obvious if wrong. The founder's instruction inverts it, and the
-- founder's instruction is what shipped: any surprise caller should surface
-- here, on content rows, where being wrong costs a failed content write —
-- before slice 3 touches credentials, session policy and the trust dial.
--   slice 1 (this): content, retrieval, conversations, finance documents, ops
--   slice 2 (718):  config, policy and commercial objects
--   slice 3 (719):  authority — de_autonomy, tenant_api_keys,
--                   tenant_ip_allowlists, profiles, workspaces, human_tasks …
--
-- WHY THESE MATTER even though they are the "low-authority" slice:
-- `answer_cache`, `knowledge_chunks`, `knowledge_doc_chunks` and
-- `knowledge_articles` are the retrieval corpus — write access to them is
-- write access to what the digital employees read back as grounded truth.
-- Corpus poisoning is a quieter failure than a deleted row and a worse one.
--
-- ⛔ THE KEEP-SET GUARD. 81 command-grants across 38 tables have a proven
-- `src/` write caller. The migration below carries that list and REFUSES,
-- naming the pair, if any slice target collides with it — and after revoking,
-- it asserts every keep-set grant SURVIVED. That second assertion is the
-- mig-643 guard: that migration nearly left 11 of 12 workspaces administrable
-- by nobody, and a revoke that removes more than intended is invisible from
-- the revoking side, because REVOKE reports nothing either way.
--
-- ROLLBACK — one line per table, e.g.
--   grant insert, update, delete on table public.answer_cache to authenticated;
--   grant delete                 on table public.opportunities to authenticated;
-- The VALUES list below IS the rollback list: paste it into
--   do $$ declare r record; begin
--     for r in select * from (values <the list>) t(tbl,priv) loop
--       execute format('grant %s on table public.%I to authenticated', r.priv, r.tbl);
--     end loop; end $$;
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
    ('activity_events','DELETE'), ('activity_events','UPDATE'),
    ('agent_actions','DELETE'), ('agent_actions','INSERT'), ('agent_actions','UPDATE'),
    ('answer_cache','DELETE'), ('answer_cache','INSERT'), ('answer_cache','UPDATE'),
    ('audit_evidence','INSERT'), ('audit_evidence','UPDATE'),
    ('bank_transactions','INSERT'), ('bank_transactions','UPDATE'),
    ('bills','INSERT'), ('bills','UPDATE'),
    ('close_tasks','INSERT'), ('close_tasks','UPDATE'),
    ('close_workspaces','INSERT'), ('close_workspaces','UPDATE'),
    ('connector_actions','DELETE'),
    ('connector_objects','DELETE'),
    ('conversations','DELETE'), ('conversations','INSERT'), ('conversations','UPDATE'),
    ('customer_account_contacts','DELETE'), ('customer_account_contacts','INSERT'), ('customer_account_contacts','UPDATE'),
    ('customer_accounts','DELETE'),
    ('customers','INSERT'), ('customers','UPDATE'),
    ('de_consultation_grants','DELETE'),
    ('de_conversations','DELETE'), ('de_conversations','INSERT'), ('de_conversations','UPDATE'),
    ('de_development_items','DELETE'), ('de_development_items','INSERT'), ('de_development_items','UPDATE'),
    ('de_messages','DELETE'), ('de_messages','INSERT'), ('de_messages','UPDATE'),
    ('de_token_usage','DELETE'), ('de_token_usage','INSERT'), ('de_token_usage','UPDATE'),
    ('escalations','INSERT'), ('escalations','UPDATE'),
    ('exceptions','INSERT'), ('exceptions','UPDATE'),
    ('fin_accounts','INSERT'), ('fin_accounts','UPDATE'),
    ('fin_documents','INSERT'), ('fin_documents','UPDATE'),
    ('invoices','INSERT'), ('invoices','UPDATE'),
    ('journal_entries','INSERT'), ('journal_entries','UPDATE'),
    ('knowledge_articles','DELETE'), ('knowledge_articles','INSERT'), ('knowledge_articles','UPDATE'),
    ('knowledge_chunks','DELETE'), ('knowledge_chunks','INSERT'), ('knowledge_chunks','UPDATE'),
    ('knowledge_collections','UPDATE'),
    ('knowledge_doc_chunks','DELETE'), ('knowledge_doc_chunks','INSERT'), ('knowledge_doc_chunks','UPDATE'),
    ('knowledge_tags','DELETE'), ('knowledge_tags','INSERT'), ('knowledge_tags','UPDATE'),
    ('media_assets','DELETE'),
    ('messages','INSERT'), ('messages','UPDATE'),
    ('notifications','DELETE'), ('notifications','INSERT'), ('notifications','UPDATE'),
    ('opportunities','DELETE'),
    ('payments','INSERT'), ('payments','UPDATE'),
    ('playbook_amendments','DELETE'), ('playbook_amendments','INSERT'), ('playbook_amendments','UPDATE'),
    ('playbook_runs','DELETE'), ('playbook_runs','INSERT'), ('playbook_runs','UPDATE'),
    ('playbook_studies','DELETE'), ('playbook_studies','INSERT'), ('playbook_studies','UPDATE'),
    ('playbooks','DELETE'), ('playbooks','INSERT'), ('playbooks','UPDATE'),
    ('renewal_invoices','DELETE'),
    ('support_tickets','DELETE'),
    ('vendors','INSERT'), ('vendors','UPDATE'),
    ('workforce_conversations','INSERT'), ('workforce_conversations','UPDATE'),
    ('workforce_entity_amendments','DELETE'), ('workforce_entity_amendments','INSERT'), ('workforce_entity_amendments','UPDATE'),
    ('workforce_entity_studies','DELETE'), ('workforce_entity_studies','INSERT'), ('workforce_entity_studies','UPDATE');
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
    raise exception 'TIER C SLICE 1 REFUSED: %.% is in the KEEP-SET — it has a proven src/ write caller and revoking it would return 42501 to a working feature. This slice was mis-built.', r.tbl, r.priv;
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
    raise exception 'TIER C SLICE 1 FAILED: authenticated still holds %', left(still, 800);
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
    raise exception 'TIER C SLICE 1 OVER-REVOKED: the keep-set lost % — a feature with a live src/ caller is now getting 42501', left(lost, 800);
  end if;
  raise notice 'TIER C SLICE 1: keep-set survival checked against % grant(s) actually held before this migration.',
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
    raise exception 'TIER C SLICE 1 OVER-REVOKED: authenticated SELECT went from % to %', n_sel_before, n_sel_after;
  end if;
  if n_col_after <> n_col_before then
    raise exception 'TIER C SLICE 1 CARVE-OUT BROKEN: profiles column-level grants went from % to %', n_col_before, n_col_after;
  end if;
  if n_col_before > 0 and (
        not has_column_privilege('authenticated','public.profiles','avatar','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','full_name','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','last_seen_at','UPDATE')) then
    raise exception 'TIER C SLICE 1 CARVE-OUT BROKEN: a profiles column-level UPDATE grant is gone — that is the entire self-service profile editor';
  end if;
  if n_svc_after <> n_svc_before then
    raise exception 'TIER C SLICE 1 OVER-REVOKED: service_role grants went from % to %', n_svc_before, n_svc_after;
  end if;
  if to_regclass('public.de_deployment_stages') is not null
     and not has_table_privilege('authenticated','public.de_deployment_stages','UPDATE') then
    raise exception 'TIER C SLICE 1 CARVE-OUT BROKEN: de_deployment_stages UPDATE was revoked — it is deliberately held back (docs/52 §5)';
  end if;

  raise notice 'TIER C SLICE 1: % target(s); % revoked, % absent. authenticated now holds % INSERT/UPDATE/DELETE grant(s) on public base tables. Keep-set intact; SELECT unchanged at %; profiles column grants %; service_role unchanged at %.',
    n_targets, n_revoked, n_absent, n_dml_after, n_sel_after, n_col_after, n_svc_after;
end $$;
