-- ============================================================================
-- 716 — TIER B: revoke the RLS-DEAD DML grants from `authenticated`.
--       468 command-grants across 171 tables. docs/52 §5.
--
-- THE CLASSIFICATION RULE, stated once. A grant is DEAD if the table has RLS
-- enabled and there is NO PERMISSIVE policy for that command applying to
-- `authenticated` or `public`. Postgres denies the command before the grant is
-- ever consulted, so revoking is a no-op on behaviour — it removes bookkeeping
-- that reads, to anyone auditing this database, like permission that was
-- granted on purpose.
--
-- Every public table has RLS enabled (294/294) and every one is owned by
-- `postgres`, so there is no "RLS off, grant is live regardless" tier. Only
-- PERMISSIVE policies count: a RESTRICTIVE policy only ever subtracts and can
-- never permit a command. The first pass of docs/52's census counted the 27
-- RESTRICTIVE policies as coverage and misclassified 7 tables as live; this
-- migration re-derives the classification AT APPLY TIME and refuses if any
-- target has become live since, rather than trusting a list measured earlier.
--
-- Classified per COMMAND, not per table: `opportunities` keeps INSERT/UPDATE
-- (both have callers) while its DELETE is Tier C. Tables appear in more than
-- one tier and that is the correct grain.
--
-- Notable entries: action_executions, action_definitions, tenants,
-- trust_policies, playbook_versions, schema_migrations, profile_compensation,
-- profile_private, connector_secrets, widget_key_secrets,
-- specialist_source_secrets, audit_logs (UPDATE/DELETE — its INSERT is live and
-- stays).
--
-- ⛔ ONE ENTRY IS DELIBERATELY HELD BACK — `de_deployment_stages` UPDATE.
-- It is RLS-dead AND it has a live caller: src/lib/workforceApi.ts:292,
-- `promoteDeploymentStage`. That call does not work today — with no PERMISSIVE
-- UPDATE policy, RLS matches zero rows and PostgREST returns SUCCESS WITH NO
-- ERROR, so the DE promotion button reports that it promoted a digital employee
-- and nothing changed. That is the trap this repo already recorded as
-- "RLS-denied write = PostgREST SUCCESS 0 rows" (project_role_gated_ui_audit).
--
-- Revoking the grant would convert a silent lie into a loud 42501 WITHOUT
-- fixing the feature. That is a behaviour change disguised as a cleanup, and it
-- belongs to whoever owns DE promotion. THE GRANT STAYS. The defect is real and
-- is reported separately: `de_deployment_stages` needs a PERMISSIVE UPDATE
-- policy (or an RPC), not a grant change. Tier B therefore carries 468, not 469.
--
-- ROLLBACK — every revoke in this migration is undone by its own GRANT. To
-- restore the prior state exactly, re-run the target list as grants:
--
--   do $$ declare r record; begin
--     for r in select * from (values
--       -- ... the same (table, command) pairs listed below ...
--     ) t(tbl, priv) loop
--       execute format('grant %s on table public.%I to authenticated', r.priv, r.tbl);
--     end loop;
--   end $$;
--
-- Because the list below IS the rollback list, a production problem tomorrow is
-- a paste: copy the VALUES block into the skeleton above. Per-table rollback is
-- a single line, e.g.
--   grant insert, update, delete on table public.ops_alerts to authenticated;
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
    ('account_activities','DELETE'), ('account_activities','INSERT'), ('account_activities','UPDATE'),
    ('account_writeback_requests','DELETE'), ('account_writeback_requests','INSERT'), ('account_writeback_requests','UPDATE'),
    ('action_definitions','DELETE'), ('action_definitions','INSERT'), ('action_definitions','UPDATE'),
    ('action_executions','DELETE'), ('action_executions','INSERT'), ('action_executions','UPDATE'),
    ('adapter_templates','DELETE'), ('adapter_templates','INSERT'), ('adapter_templates','UPDATE'),
    ('ai_change_log','DELETE'), ('ai_change_log','INSERT'), ('ai_change_log','UPDATE'),
    ('ai_session_messages','DELETE'), ('ai_session_messages','INSERT'), ('ai_session_messages','UPDATE'),
    ('ai_sessions','DELETE'), ('ai_sessions','INSERT'), ('ai_sessions','UPDATE'),
    ('ai_usage_events','DELETE'), ('ai_usage_events','INSERT'), ('ai_usage_events','UPDATE'),
    ('amendment_metrics','DELETE'),
    ('analytics_query_defs','DELETE'), ('analytics_query_defs','INSERT'), ('analytics_query_defs','UPDATE'),
    ('audit_evidence','DELETE'),
    ('audit_logs','DELETE'), ('audit_logs','UPDATE'),
    ('bank_transactions','DELETE'),
    ('billable_outcomes','DELETE'), ('billable_outcomes','INSERT'), ('billable_outcomes','UPDATE'),
    ('bills','DELETE'),
    ('certification_types','DELETE'), ('certification_types','INSERT'), ('certification_types','UPDATE'),
    ('close_tasks','DELETE'),
    ('close_workspaces','DELETE'),
    ('compliance_pack_rules','DELETE'), ('compliance_pack_rules','INSERT'), ('compliance_pack_rules','UPDATE'),
    ('compliance_packs','DELETE'), ('compliance_packs','INSERT'), ('compliance_packs','UPDATE'),
    ('computer_use_runtimes','DELETE'), ('computer_use_runtimes','INSERT'), ('computer_use_runtimes','UPDATE'),
    ('computer_use_tasks','DELETE'), ('computer_use_tasks','INSERT'), ('computer_use_tasks','UPDATE'),
    ('config_schema_instances','DELETE'),
    ('config_schema_templates','DELETE'), ('config_schema_templates','INSERT'), ('config_schema_templates','UPDATE'),
    ('connector_ingest_candidates','DELETE'), ('connector_ingest_candidates','INSERT'), ('connector_ingest_candidates','UPDATE'),
    ('connector_secrets','DELETE'), ('connector_secrets','INSERT'), ('connector_secrets','UPDATE'),
    ('connector_sync_cursors','DELETE'), ('connector_sync_cursors','INSERT'), ('connector_sync_cursors','UPDATE'),
    ('continuity_case_events','DELETE'), ('continuity_case_events','INSERT'), ('continuity_case_events','UPDATE'),
    ('continuity_cases','DELETE'), ('continuity_cases','INSERT'), ('continuity_cases','UPDATE'),
    ('continuity_writeback_requests','DELETE'), ('continuity_writeback_requests','INSERT'), ('continuity_writeback_requests','UPDATE'),
    ('conversation_facts','DELETE'), ('conversation_facts','INSERT'), ('conversation_facts','UPDATE'),
    ('customers','DELETE'),
    ('data_access_grants','DELETE'), ('data_access_grants','INSERT'), ('data_access_grants','UPDATE'),
    ('de_budget_policies','DELETE'), ('de_budget_policies','INSERT'), ('de_budget_policies','UPDATE'),
    ('de_case_events','DELETE'), ('de_case_events','INSERT'), ('de_case_events','UPDATE'),
    ('de_certifications','DELETE'), ('de_certifications','INSERT'), ('de_certifications','UPDATE'),
    ('de_channels','DELETE'), ('de_channels','INSERT'), ('de_channels','UPDATE'),
    ('de_decision_trace','DELETE'), ('de_decision_trace','INSERT'), ('de_decision_trace','UPDATE'),
    ('de_delegation_tokens','DELETE'), ('de_delegation_tokens','INSERT'), ('de_delegation_tokens','UPDATE'),
    ('de_deliverables','DELETE'), ('de_deliverables','INSERT'), ('de_deliverables','UPDATE'),
    ('de_deployment_stages','DELETE'), ('de_deployment_stages','INSERT'),
    ('de_escalation_rules','DELETE'), ('de_escalation_rules','INSERT'), ('de_escalation_rules','UPDATE'),
    ('de_exceptions','DELETE'), ('de_exceptions','INSERT'), ('de_exceptions','UPDATE'),
    ('de_experience','DELETE'), ('de_experience','INSERT'), ('de_experience','UPDATE'),
    ('de_improvements','DELETE'), ('de_improvements','INSERT'), ('de_improvements','UPDATE'),
    ('de_incidents','DELETE'), ('de_incidents','INSERT'), ('de_incidents','UPDATE'),
    ('de_kpi_readings','DELETE'), ('de_kpi_readings','INSERT'), ('de_kpi_readings','UPDATE'),
    ('de_kpis','DELETE'), ('de_kpis','INSERT'), ('de_kpis','UPDATE'),
    ('de_lifecycle_events','DELETE'), ('de_lifecycle_events','INSERT'), ('de_lifecycle_events','UPDATE'),
    ('de_memory','DELETE'), ('de_memory','INSERT'), ('de_memory','UPDATE'),
    ('de_missions','DELETE'), ('de_missions','INSERT'), ('de_missions','UPDATE'),
    ('de_model_routes','DELETE'), ('de_model_routes','INSERT'), ('de_model_routes','UPDATE'),
    ('de_objectives','DELETE'), ('de_objectives','INSERT'), ('de_objectives','UPDATE'),
    ('de_performance_reviews','DELETE'), ('de_performance_reviews','INSERT'), ('de_performance_reviews','UPDATE'),
    ('de_product_knowledge','DELETE'), ('de_product_knowledge','INSERT'), ('de_product_knowledge','UPDATE'),
    ('de_role_assignments','DELETE'), ('de_role_assignments','INSERT'), ('de_role_assignments','UPDATE'),
    ('de_skills','DELETE'), ('de_skills','INSERT'), ('de_skills','UPDATE'),
    ('de_spend_ledger','DELETE'), ('de_spend_ledger','INSERT'), ('de_spend_ledger','UPDATE'),
    ('de_system_verifications','DELETE'), ('de_system_verifications','INSERT'), ('de_system_verifications','UPDATE'),
    ('de_task_requests','DELETE'), ('de_task_requests','INSERT'), ('de_task_requests','UPDATE'),
    ('de_training_feedback','DELETE'), ('de_training_feedback','INSERT'), ('de_training_feedback','UPDATE'),
    ('de_training_modules','DELETE'), ('de_training_modules','INSERT'), ('de_training_modules','UPDATE'),
    ('de_training_progress','DELETE'), ('de_training_progress','INSERT'), ('de_training_progress','UPDATE'),
    ('de_work_items','DELETE'), ('de_work_items','INSERT'), ('de_work_items','UPDATE'),
    ('definition_of_done_log','DELETE'), ('definition_of_done_log','INSERT'), ('definition_of_done_log','UPDATE'),
    ('digital_employees','DELETE'),
    ('dunning_ladders','DELETE'), ('dunning_ladders','INSERT'), ('dunning_ladders','UPDATE'),
    ('dunning_rungs','DELETE'), ('dunning_rungs','INSERT'), ('dunning_rungs','UPDATE'),
    ('end_user_sessions','DELETE'), ('end_user_sessions','INSERT'), ('end_user_sessions','UPDATE'),
    ('escalation_signals','DELETE'), ('escalation_signals','INSERT'), ('escalation_signals','UPDATE'),
    ('escalations','DELETE'),
    ('eval_batch_items','DELETE'), ('eval_batch_items','INSERT'), ('eval_batch_items','UPDATE'),
    ('eval_batch_jobs','DELETE'), ('eval_batch_jobs','INSERT'), ('eval_batch_jobs','UPDATE'),
    ('eval_judgments','DELETE'), ('eval_judgments','INSERT'), ('eval_judgments','UPDATE'),
    ('eval_runs','DELETE'), ('eval_runs','INSERT'), ('eval_runs','UPDATE'),
    ('event_definitions','DELETE'), ('event_definitions','INSERT'), ('event_definitions','UPDATE'),
    ('evidence_feedback','DELETE'), ('evidence_feedback','INSERT'), ('evidence_feedback','UPDATE'),
    ('evidence_run_decisions','DELETE'), ('evidence_run_decisions','INSERT'), ('evidence_run_decisions','UPDATE'),
    ('evidence_runs','DELETE'), ('evidence_runs','INSERT'), ('evidence_runs','UPDATE'),
    ('exceptions','DELETE'),
    ('extraction_results','DELETE'), ('extraction_results','INSERT'), ('extraction_results','UPDATE'),
    ('extraction_templates','DELETE'), ('extraction_templates','INSERT'), ('extraction_templates','UPDATE'),
    ('feature_registry','DELETE'), ('feature_registry','INSERT'), ('feature_registry','UPDATE'),
    ('fin_accounts','DELETE'),
    ('fin_documents','DELETE'),
    ('governance_proposals','DELETE'), ('governance_proposals','INSERT'), ('governance_proposals','UPDATE'),
    ('grounded_confidence_shadow_log','DELETE'), ('grounded_confidence_shadow_log','INSERT'), ('grounded_confidence_shadow_log','UPDATE'),
    ('grounded_confidence_validation','DELETE'), ('grounded_confidence_validation','INSERT'), ('grounded_confidence_validation','UPDATE'),
    ('guardrail_adjudication_cache','DELETE'), ('guardrail_adjudication_cache','INSERT'), ('guardrail_adjudication_cache','UPDATE'),
    ('guardrail_adjudications','DELETE'), ('guardrail_adjudications','INSERT'), ('guardrail_adjudications','UPDATE'),
    ('invoice_activities','DELETE'), ('invoice_activities','INSERT'), ('invoice_activities','UPDATE'),
    ('invoice_payments','DELETE'), ('invoice_payments','INSERT'), ('invoice_payments','UPDATE'),
    ('invoice_writeback_requests','DELETE'), ('invoice_writeback_requests','INSERT'), ('invoice_writeback_requests','UPDATE'),
    ('invoices','DELETE'),
    ('journal_entries','DELETE'),
    ('knowledge_access_grants','DELETE'), ('knowledge_access_grants','INSERT'), ('knowledge_access_grants','UPDATE'),
    ('knowledge_conflict_probe_queue','DELETE'), ('knowledge_conflict_probe_queue','INSERT'), ('knowledge_conflict_probe_queue','UPDATE'),
    ('knowledge_conflicts','DELETE'), ('knowledge_conflicts','INSERT'), ('knowledge_conflicts','UPDATE'),
    ('knowledge_doc_access_paths','DELETE'), ('knowledge_doc_access_paths','INSERT'), ('knowledge_doc_access_paths','UPDATE'),
    ('knowledge_doc_collections','DELETE'), ('knowledge_doc_collections','INSERT'), ('knowledge_doc_collections','UPDATE'),
    ('knowledge_doc_scopes','DELETE'), ('knowledge_doc_scopes','INSERT'), ('knowledge_doc_scopes','UPDATE'),
    ('knowledge_doc_usage_daily','DELETE'), ('knowledge_doc_usage_daily','INSERT'), ('knowledge_doc_usage_daily','UPDATE'),
    ('knowledge_ingestion_items','DELETE'), ('knowledge_ingestion_items','INSERT'), ('knowledge_ingestion_items','UPDATE'),
    ('knowledge_ingestion_jobs','DELETE'), ('knowledge_ingestion_jobs','INSERT'), ('knowledge_ingestion_jobs','UPDATE'),
    ('knowledge_principal_group_members','DELETE'), ('knowledge_principal_group_members','INSERT'), ('knowledge_principal_group_members','UPDATE'),
    ('knowledge_principal_groups','DELETE'), ('knowledge_principal_groups','INSERT'), ('knowledge_principal_groups','UPDATE'),
    ('knowledge_revision_requests','DELETE'), ('knowledge_revision_requests','INSERT'), ('knowledge_revision_requests','UPDATE'),
    ('kpi_metric_catalog','DELETE'), ('kpi_metric_catalog','INSERT'), ('kpi_metric_catalog','UPDATE'),
    ('learned_tool_specs','DELETE'), ('learned_tool_specs','INSERT'), ('learned_tool_specs','UPDATE'),
    ('media_assets','UPDATE'),
    ('messages','DELETE'),
    ('oauth_connect_states','DELETE'), ('oauth_connect_states','INSERT'), ('oauth_connect_states','UPDATE'),
    ('onboarding_template_versions','DELETE'), ('onboarding_template_versions','INSERT'), ('onboarding_template_versions','UPDATE'),
    ('opportunity_activities','DELETE'), ('opportunity_activities','INSERT'), ('opportunity_activities','UPDATE'),
    ('opportunity_writeback_requests','DELETE'), ('opportunity_writeback_requests','INSERT'), ('opportunity_writeback_requests','UPDATE'),
    ('ops_alerts','DELETE'), ('ops_alerts','INSERT'), ('ops_alerts','UPDATE'),
    ('otel_spans','DELETE'), ('otel_spans','INSERT'), ('otel_spans','UPDATE'),
    ('outbound_drafts','DELETE'), ('outbound_drafts','INSERT'), ('outbound_drafts','UPDATE'),
    ('payment_promises','DELETE'), ('payment_promises','INSERT'), ('payment_promises','UPDATE'),
    ('payments','DELETE'),
    ('platform_runtime_config','DELETE'), ('platform_runtime_config','INSERT'), ('platform_runtime_config','UPDATE'),
    ('playbook_gaps','DELETE'), ('playbook_gaps','INSERT'), ('playbook_gaps','UPDATE'),
    ('playbook_trigger_fires','DELETE'), ('playbook_trigger_fires','INSERT'), ('playbook_trigger_fires','UPDATE'),
    ('playbook_versions','DELETE'), ('playbook_versions','INSERT'), ('playbook_versions','UPDATE'),
    ('posting_draft_lines','DELETE'), ('posting_draft_lines','INSERT'), ('posting_draft_lines','UPDATE'),
    ('posting_drafts','DELETE'), ('posting_drafts','INSERT'), ('posting_drafts','UPDATE'),
    ('profile_compensation','DELETE'), ('profile_compensation','INSERT'), ('profile_compensation','UPDATE'),
    ('profile_private','DELETE'), ('profile_private','INSERT'), ('profile_private','UPDATE'),
    ('rate_limit_counters','DELETE'), ('rate_limit_counters','INSERT'), ('rate_limit_counters','UPDATE'),
    ('role_archetypes','DELETE'), ('role_archetypes','INSERT'), ('role_archetypes','UPDATE'),
    ('role_certifications','DELETE'), ('role_certifications','INSERT'), ('role_certifications','UPDATE'),
    ('schema_migrations','DELETE'), ('schema_migrations','INSERT'), ('schema_migrations','UPDATE'),
    ('scim_tokens','DELETE'), ('scim_tokens','INSERT'), ('scim_tokens','UPDATE'),
    ('scim_user_links','DELETE'), ('scim_user_links','INSERT'), ('scim_user_links','UPDATE'),
    ('semantic_guardrail_cache','DELETE'), ('semantic_guardrail_cache','INSERT'), ('semantic_guardrail_cache','UPDATE'),
    ('semantic_guardrail_shadow_log','DELETE'), ('semantic_guardrail_shadow_log','INSERT'), ('semantic_guardrail_shadow_log','UPDATE'),
    ('sim_runs','DELETE'), ('sim_runs','INSERT'), ('sim_runs','UPDATE'),
    ('skill_catalog','DELETE'), ('skill_catalog','INSERT'), ('skill_catalog','UPDATE'),
    ('skill_categories','DELETE'), ('skill_categories','INSERT'), ('skill_categories','UPDATE'),
    ('specialist_source_secrets','DELETE'), ('specialist_source_secrets','INSERT'), ('specialist_source_secrets','UPDATE'),
    ('staleness_escalations','DELETE'), ('staleness_escalations','INSERT'), ('staleness_escalations','UPDATE'),
    ('tenant_billing_config','DELETE'), ('tenant_billing_config','INSERT'),
    ('tenant_brand_identity','DELETE'), ('tenant_brand_identity','INSERT'), ('tenant_brand_identity','UPDATE'),
    ('tenant_branding','DELETE'), ('tenant_branding','INSERT'), ('tenant_branding','UPDATE'),
    ('tenant_compliance_packs','DELETE'), ('tenant_compliance_packs','INSERT'), ('tenant_compliance_packs','UPDATE'),
    ('tenant_cost_tracking','DELETE'), ('tenant_cost_tracking','INSERT'), ('tenant_cost_tracking','UPDATE'),
    ('tenant_deletion_receipts','DELETE'), ('tenant_deletion_receipts','INSERT'), ('tenant_deletion_receipts','UPDATE'),
    ('tenant_deletion_requests','DELETE'), ('tenant_deletion_requests','INSERT'), ('tenant_deletion_requests','UPDATE'),
    ('tenant_feature_overrides','DELETE'), ('tenant_feature_overrides','INSERT'), ('tenant_feature_overrides','UPDATE'),
    ('tenant_feature_toggles','DELETE'), ('tenant_feature_toggles','INSERT'),
    ('tenant_pipeline_stages','DELETE'), ('tenant_pipeline_stages','INSERT'), ('tenant_pipeline_stages','UPDATE'),
    ('tenant_provisioning_requests','DELETE'), ('tenant_provisioning_requests','INSERT'), ('tenant_provisioning_requests','UPDATE'),
    ('tenant_usage_metrics','DELETE'), ('tenant_usage_metrics','INSERT'), ('tenant_usage_metrics','UPDATE'),
    ('tenants','DELETE'), ('tenants','INSERT'), ('tenants','UPDATE'),
    ('trust_policies','DELETE'), ('trust_policies','INSERT'), ('trust_policies','UPDATE'),
    ('unguarded_secdef_writers','DELETE'), ('unguarded_secdef_writers','INSERT'), ('unguarded_secdef_writers','UPDATE'),
    ('unit_tripwires','DELETE'), ('unit_tripwires','INSERT'), ('unit_tripwires','UPDATE'),
    ('usage_metrics','DELETE'), ('usage_metrics','INSERT'), ('usage_metrics','UPDATE'),
    ('vendors','DELETE'),
    ('watch_source_catalog','DELETE'), ('watch_source_catalog','INSERT'), ('watch_source_catalog','UPDATE'),
    ('watch_source_fields','DELETE'), ('watch_source_fields','INSERT'), ('watch_source_fields','UPDATE'),
    ('widget_key_secrets','DELETE'), ('widget_key_secrets','INSERT'), ('widget_key_secrets','UPDATE'),
    ('work_item_framing','DELETE'), ('work_item_framing','INSERT'), ('work_item_framing','UPDATE'),
    ('work_watcher_matches','DELETE'), ('work_watcher_matches','INSERT'), ('work_watcher_matches','UPDATE'),
    ('workforce_actions','DELETE'), ('workforce_actions','INSERT'),
    ('workforce_baselines','DELETE'), ('workforce_baselines','INSERT'), ('workforce_baselines','UPDATE'),
    ('workforce_conversations','DELETE'),
    ('workforce_team_members','DELETE'), ('workforce_team_members','INSERT'), ('workforce_team_members','UPDATE'),
    ('workforce_teams','DELETE'), ('workforce_teams','INSERT'), ('workforce_teams','UPDATE'),
    ('workforce_trust_posture','DELETE'), ('workforce_trust_posture','INSERT'), ('workforce_trust_posture','UPDATE');
  select count(*) into n_targets from _tier_targets;

  -- ── GUARD 1: the classification must still hold AT APPLY TIME ────────────
  -- Tier B's whole safety argument is "RLS already refuses this command, so
  -- the grant is bookkeeping". If a PERMISSIVE policy for that command has
  -- appeared since the audit was measured, the grant is now LIVE and revoking
  -- it is a behaviour change nobody signed off. Refuse rather than proceed.
  -- Only PERMISSIVE counts: a RESTRICTIVE policy only ever subtracts and can
  -- never permit a command — the first pass of docs/52's census counted them
  -- as coverage and misclassified 7 tables.
  for r in
    select t.tbl, t.priv from _tier_targets t
     where exists (select 1 from pg_class c
                    where c.relname=t.tbl and c.relnamespace='public'::regnamespace and c.relkind='r')
       and exists (select 1 from pg_policies p
                    where p.schemaname='public' and p.tablename=t.tbl
                      and p.permissive='PERMISSIVE'
                      and (p.cmd = t.priv or p.cmd='ALL')
                      and p.roles && array['authenticated','public']::name[])
  loop
    raise exception 'TIER B REFUSED: %.% now has a PERMISSIVE policy — it is no longer RLS-dead, so this revoke would change behaviour. Re-run the census before applying.', r.tbl, r.priv;
  end loop;

  -- ── THE REVOKE ───────────────────────────────────────────────────────────
  for r in select t.tbl, t.priv from _tier_targets t order by t.tbl, t.priv loop
    if exists (select 1 from pg_class c
                where c.relname=r.tbl and c.relnamespace='public'::regnamespace and c.relkind='r') then
      execute format('revoke %s on table public.%I from authenticated', r.priv, r.tbl);
      n_revoked := n_revoked + 1;
    else
      -- Replay-safety. dev is ~78 migrations behind prod and genuinely lacks
      -- some of these tables; a hard failure there would teach people to skip
      -- the dev rehearsal, which is where two bugs in migs 714/715 were caught.
      n_absent := n_absent + 1;
    end if;
  end loop;

  -- ── ASSERT: a REVOKE is not a description of the resulting privileges ────
  -- ⚠ to_regclass, never ::regclass. The cast RAISES 42P01 on a missing table,
  -- and Postgres does not promise to evaluate the existence filter first — the
  -- dev rehearsal failed here on tenant_brand_identity, a table dev does not
  -- have. to_regclass returns NULL instead, has_table_privilege(role, NULL, p)
  -- returns NULL, and the row drops out. Same lesson as
  -- project_dead_governance_controls: use to_regclass.
  select string_agg(t.tbl || '.' || t.priv, ', ') into still
    from _tier_targets t
   where to_regclass('public.' || quote_ident(t.tbl)) is not null
     and has_table_privilege('authenticated', to_regclass('public.' || quote_ident(t.tbl)), t.priv);
  if still is not null then
    raise exception 'TIER B FAILED: authenticated still holds %', left(still, 800);
  end if;

  -- ── ASSERT THE OTHER HALF: nothing beyond the target list moved ──────────
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
    raise exception 'TIER B OVER-REVOKED: authenticated SELECT went from % to %. SELECT is the product; naming the commands explicitly instead of ALL is what should have prevented this.', n_sel_before, n_sel_after;
  end if;
  if n_col_after <> n_col_before then
    raise exception 'TIER B CARVE-OUT BROKEN: profiles column-level grants went from % to %', n_col_before, n_col_after;
  end if;
  if n_col_before > 0 and (
        not has_column_privilege('authenticated','public.profiles','avatar','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','full_name','UPDATE')
     or not has_column_privilege('authenticated','public.profiles','last_seen_at','UPDATE')) then
    raise exception 'TIER B CARVE-OUT BROKEN: a profiles column-level UPDATE grant is gone — that is the entire self-service profile editor';
  end if;
  if n_svc_after <> n_svc_before then
    raise exception 'TIER B OVER-REVOKED: service_role grants went from % to %', n_svc_before, n_svc_after;
  end if;

  raise notice 'TIER B: % target(s); % revoked, % absent (table not in this database). authenticated now holds % INSERT/UPDATE/DELETE grant(s) on public base tables. SELECT unchanged at %; profiles column grants %; service_role unchanged at %.',
    n_targets, n_revoked, n_absent, n_dml_after, n_sel_after, n_col_after, n_svc_after;
end $$;
