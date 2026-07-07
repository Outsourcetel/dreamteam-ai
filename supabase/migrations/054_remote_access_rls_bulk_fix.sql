-- Migration 054: Remote Access -- route the inlined tenant-scoping RLS
-- policies through auth_tenant_id(), for the 62 policies where the
-- substitution is a pure, unconditional tenant filter.
-- =====================================================================
-- Migration 053 extended auth_tenant_id() so that during an ACTIVE
-- remote-access session it resolves to the session's target tenant
-- instead of the (always-NULL, by design) tenant_id of a platform-layer
-- operator's own profile row. That works -- but a live survey of
-- pg_policies found the majority of tenant-scoped tables never call
-- auth_tenant_id() at all: they inline the same profiles lookup
-- directly in the policy (`tenant_id IN (select profiles.tenant_id
-- from profiles where profiles.user_id = auth.uid())`, or the `=
-- ... LIMIT 1` variant). Those inlined policies bypass auth_tenant_id()
-- entirely, so Remote Access unlocked only the minority of tables that
-- happened to already call the function (mostly finance/close tables),
-- while core product tables -- customer_accounts, support_tickets,
-- opportunities, digital_employees, playbooks, knowledge_docs,
-- human_tasks, guardrail_rules, and ~50 more -- kept returning zero
-- rows to a platform admin even mid-session. Confirmed live: as a
-- simulated platform admin with an active session targeting Acme
-- Telecom, `select count(*) from customer_accounts where tenant_id =
-- '<acme>'` returned 0 despite the row genuinely existing.
--
-- This migration covers every policy where the inlined subquery was the
-- ENTIRE tenant-scoping predicate (optionally OR'd with an unconditional
-- `scope = 'platform'` clause that doesn't touch tenant resolution at
-- all) -- i.e. where swapping the subquery for auth_tenant_id() is a
-- pure textual substitution with no other predicate (role, layer, join)
-- riding along. For a normal tenant user this is byte-identical
-- behavior: auth_tenant_id() itself does the same "look up my own
-- profiles.tenant_id" lookup first and only ever falls through to the
-- remote-access-session branch when that lookup is NULL (structurally
-- only possible for platform-layer accounts). The only case that
-- changes is a platform admin (tenant_id NULL) with an active,
-- audited remote-access session.
--
-- A further ~19 policies were deliberately EXCLUDED from this migration
-- because they combine the tenant lookup with an additional predicate
-- (a role = ANY (...) check, a `layer = 'platform'` check, or an
-- is_platform_admin()/requested_by_user_id OR-branch) where a blind
-- find-and-replace would silently change behavior for ordinary tenant
-- users (e.g. dropping a role gate that currently restricts writes to
-- tenant_owner/tenant_admin/tenant_manager). Those get individual,
-- judgment-preserving treatment in migration 055.
--
-- Uses `alter policy ... using (...) with check (...)` -- this changes
-- the expressions in place on the existing policy object (no drop, no
-- window where the policy doesn't exist, no need to also re-grant
-- anything since the policy's identity/ownership never changes).
-- =====================================================================

alter policy "action_executions_tenant_select" on public.action_executions
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "activity_events_tenant_isolation" on public.activity_events
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "agent_actions_tenant" on public.agent_actions
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "ai_usage_tenant_read" on public.ai_usage_events
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "answer_cache_tenant_isolation" on public.answer_cache
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "audit_events_tenant_insert" on public.audit_events
  to public
  with check ((tenant_id = auth_tenant_id()));

alter policy "audit_events_tenant_select" on public.audit_events
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "audit_logs_tenant_insert" on public.audit_logs
  to public
  with check ((tenant_id = auth_tenant_id()));

alter policy "audit_logs_tenant_read" on public.audit_logs
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "capabilities_tenant_read" on public.capabilities
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "connectors_tenant_isolation" on public.connectors
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "conversation_facts_tenant_select" on public.conversation_facts
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "customer_accounts_tenant_isolation" on public.customer_accounts
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "data_access_grants_tenant_select" on public.data_access_grants
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "de_autonomy_tenant_isolation" on public.de_autonomy
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "de_conversations_tenant_isolation" on public.de_conversations
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "de_experience_tenant_select" on public.de_experience
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "de_messages_tenant_isolation" on public.de_messages
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "dpa_tenant_isolation" on public.de_playbook_assignments
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "de_playbook_charter_tenant_isolation" on public.de_playbook_charter
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "departments_tenant_read" on public.departments
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "de_tenant_select" on public.digital_employees
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "end_user_sessions_tenant_read" on public.end_user_sessions
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "eval_runs_tenant_read" on public.eval_runs
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "evidence_feedback_tenant_select" on public.evidence_feedback
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "evidence_run_decisions_tenant_select" on public.evidence_run_decisions
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "evidence_runs_tenant_select" on public.evidence_runs
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "golden_qa_tenant_isolation" on public.golden_qa
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "guardrail_rules_tenant_isolation" on public.guardrail_rules
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "health_score_config_tenant_isolation" on public.health_score_config
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "human_tasks_tenant_isolation" on public.human_tasks
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "inbox_watch_state_tenant_select" on public.inbox_watch_state
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "knowledge_chunks_tenant" on public.knowledge_chunks
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "knowledge_doc_chunks_tenant_isolation" on public.knowledge_doc_chunks
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "knowledge_doc_scopes_tenant_select" on public.knowledge_doc_scopes
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "knowledge_docs_tenant_isolation" on public.knowledge_docs
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "knowledge_revision_requests_tenant_select" on public.knowledge_revision_requests
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "media_assets_tenant_isolation" on public.media_assets
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "onboarding_projects_tenant_isolation" on public.onboarding_projects
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "onboarding_tv_tenant_read" on public.onboarding_template_versions
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "onboarding_templates_tenant_isolation" on public.onboarding_templates
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "opportunities_tenant_isolation" on public.opportunities
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "playbook_definitions_tenant_isolation" on public.playbook_definitions
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "playbook_event_rules_tenant_isolation" on public.playbook_event_rules
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "playbook_runs_tenant_isolation" on public.playbook_runs
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "playbook_schedules_tenant_isolation" on public.playbook_schedules
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "playbook_trigger_fires_tenant_select" on public.playbook_trigger_fires
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "pb_tenant_isolation" on public.playbooks
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "renewal_invoices_tenant_isolation" on public.renewal_invoices
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "scribe_requests_tenant_select" on public.scribe_requests
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "spec_consultations_tenant_select" on public.spec_consultations
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "specialist_profiles_tenant_isolation" on public.specialist_profiles
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "staleness_escalations_tenant_select" on public.staleness_escalations
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "staleness_policies_tenant_isolation" on public.staleness_policies
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "support_tickets_tenant_isolation" on public.support_tickets
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "trust_policies_tenant_read" on public.trust_policies
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "usage_metrics_tenant_read" on public.usage_metrics
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "widget_keys_tenant_isolation" on public.widget_keys
  to public
  using ((tenant_id = auth_tenant_id()))
  with check ((tenant_id = auth_tenant_id()));

alter policy "workspaces_tenant_read" on public.workspaces
  to public
  using ((tenant_id = auth_tenant_id()));

alter policy "action_definitions_read" on public.action_definitions
  to public
  using (((scope = 'platform'::text) OR (tenant_id = auth_tenant_id())));

alter policy "adapter_templates_select" on public.adapter_templates
  to public
  using (((scope = 'platform'::text) OR (tenant_id = auth_tenant_id())));

alter policy "work_item_framing_read" on public.work_item_framing
  to public
  using (((scope = 'platform'::text) OR (tenant_id = auth_tenant_id())));
