-- Migration 067: mechanical follow-up to migration 066, mirroring how
-- migration 063 followed migration 062 for the Remote Access write-audit
-- log. Migration 066 built the core tenant_activity_log table and the
-- log_tenant_activity() trigger function; this migration attaches
-- `trg_tenant_activity_log` to every public-schema base table that has a
-- tenant_id column, so an ordinary tenant member's write to ANY
-- tenant-scoped table is captured -- not just the two
-- (customer_accounts, support_tickets) used for the manual verification
-- pass alongside migration 066.
--
-- Excluded, same reasoning as migration 063 plus the two new tables this
-- feature itself introduces:
--   audit_events, audit_logs, audit_evidence -- already-immutable audit
--     tables; auditing writes to an audit table is redundant/circular.
--   platform_access_events -- the remote-access session log, a different
--     layer's session log, not tenant team activity.
--   tenant_ancestry -- system-maintained hierarchy structure, not user
--     content, already has its own maintenance trigger.
--   remote_access_write_log -- the sibling audit table from migrations
--     062/063; circular to audit (and semantically the wrong log -- it
--     captures platform-layer writes, log_tenant_activity() would filter
--     them out anyway since the writer has no home tenant).
--   tenant_activity_log itself -- this new table; auditing writes to
--     itself is circular for the same reason as the audit_* tables.
--
-- Re-confirmed live via information_schema.columns rather than trusting
-- the migration-063 list unchanged: same 78 qualifying tables today as
-- when migration 063 was written, no tenant-scoped tables have been
-- added or removed since. customer_accounts and support_tickets already
-- carry this trigger from the manual verification pass done alongside
-- migration 066; re-issued here too via the idempotent drop-then-create
-- so this migration is the single source of truth for the full
-- attachment list (78 tables total).
-- =====================================================================

drop trigger if exists trg_tenant_activity_log on action_definitions;
create trigger trg_tenant_activity_log after insert or update or delete on action_definitions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on action_executions;
create trigger trg_tenant_activity_log after insert or update or delete on action_executions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on activity_events;
create trigger trg_tenant_activity_log after insert or update or delete on activity_events for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on adapter_templates;
create trigger trg_tenant_activity_log after insert or update or delete on adapter_templates for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on agent_actions;
create trigger trg_tenant_activity_log after insert or update or delete on agent_actions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on ai_usage_events;
create trigger trg_tenant_activity_log after insert or update or delete on ai_usage_events for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on answer_cache;
create trigger trg_tenant_activity_log after insert or update or delete on answer_cache for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on bank_transactions;
create trigger trg_tenant_activity_log after insert or update or delete on bank_transactions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on bills;
create trigger trg_tenant_activity_log after insert or update or delete on bills for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on capabilities;
create trigger trg_tenant_activity_log after insert or update or delete on capabilities for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on close_tasks;
create trigger trg_tenant_activity_log after insert or update or delete on close_tasks for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on close_workspaces;
create trigger trg_tenant_activity_log after insert or update or delete on close_workspaces for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on connectors;
create trigger trg_tenant_activity_log after insert or update or delete on connectors for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on conversation_facts;
create trigger trg_tenant_activity_log after insert or update or delete on conversation_facts for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on conversations;
create trigger trg_tenant_activity_log after insert or update or delete on conversations for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on customer_accounts;
create trigger trg_tenant_activity_log after insert or update or delete on customer_accounts for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on customers;
create trigger trg_tenant_activity_log after insert or update or delete on customers for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on data_access_grants;
create trigger trg_tenant_activity_log after insert or update or delete on data_access_grants for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_autonomy;
create trigger trg_tenant_activity_log after insert or update or delete on de_autonomy for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_conversations;
create trigger trg_tenant_activity_log after insert or update or delete on de_conversations for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_experience;
create trigger trg_tenant_activity_log after insert or update or delete on de_experience for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_messages;
create trigger trg_tenant_activity_log after insert or update or delete on de_messages for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_playbook_assignments;
create trigger trg_tenant_activity_log after insert or update or delete on de_playbook_assignments for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on de_playbook_charter;
create trigger trg_tenant_activity_log after insert or update or delete on de_playbook_charter for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on departments;
create trigger trg_tenant_activity_log after insert or update or delete on departments for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on digital_employees;
create trigger trg_tenant_activity_log after insert or update or delete on digital_employees for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on end_user_sessions;
create trigger trg_tenant_activity_log after insert or update or delete on end_user_sessions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on escalations;
create trigger trg_tenant_activity_log after insert or update or delete on escalations for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on eval_runs;
create trigger trg_tenant_activity_log after insert or update or delete on eval_runs for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on evidence_feedback;
create trigger trg_tenant_activity_log after insert or update or delete on evidence_feedback for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on evidence_run_decisions;
create trigger trg_tenant_activity_log after insert or update or delete on evidence_run_decisions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on evidence_runs;
create trigger trg_tenant_activity_log after insert or update or delete on evidence_runs for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on exceptions;
create trigger trg_tenant_activity_log after insert or update or delete on exceptions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on fin_accounts;
create trigger trg_tenant_activity_log after insert or update or delete on fin_accounts for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on fin_documents;
create trigger trg_tenant_activity_log after insert or update or delete on fin_documents for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on golden_qa;
create trigger trg_tenant_activity_log after insert or update or delete on golden_qa for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on guardrail_rules;
create trigger trg_tenant_activity_log after insert or update or delete on guardrail_rules for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on health_score_config;
create trigger trg_tenant_activity_log after insert or update or delete on health_score_config for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on human_tasks;
create trigger trg_tenant_activity_log after insert or update or delete on human_tasks for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on inbox_watch_state;
create trigger trg_tenant_activity_log after insert or update or delete on inbox_watch_state for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on invoices;
create trigger trg_tenant_activity_log after insert or update or delete on invoices for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on journal_entries;
create trigger trg_tenant_activity_log after insert or update or delete on journal_entries for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_articles;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_articles for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_chunks;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_chunks for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_doc_chunks;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_doc_chunks for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_doc_scopes;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_doc_scopes for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_docs;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_docs for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on knowledge_revision_requests;
create trigger trg_tenant_activity_log after insert or update or delete on knowledge_revision_requests for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on media_assets;
create trigger trg_tenant_activity_log after insert or update or delete on media_assets for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on messages;
create trigger trg_tenant_activity_log after insert or update or delete on messages for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on notifications;
create trigger trg_tenant_activity_log after insert or update or delete on notifications for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on onboarding_projects;
create trigger trg_tenant_activity_log after insert or update or delete on onboarding_projects for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on onboarding_template_versions;
create trigger trg_tenant_activity_log after insert or update or delete on onboarding_template_versions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on onboarding_templates;
create trigger trg_tenant_activity_log after insert or update or delete on onboarding_templates for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on opportunities;
create trigger trg_tenant_activity_log after insert or update or delete on opportunities for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on payments;
create trigger trg_tenant_activity_log after insert or update or delete on payments for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbook_definitions;
create trigger trg_tenant_activity_log after insert or update or delete on playbook_definitions for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbook_event_rules;
create trigger trg_tenant_activity_log after insert or update or delete on playbook_event_rules for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbook_runs;
create trigger trg_tenant_activity_log after insert or update or delete on playbook_runs for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbook_schedules;
create trigger trg_tenant_activity_log after insert or update or delete on playbook_schedules for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbook_trigger_fires;
create trigger trg_tenant_activity_log after insert or update or delete on playbook_trigger_fires for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on playbooks;
create trigger trg_tenant_activity_log after insert or update or delete on playbooks for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on profiles;
create trigger trg_tenant_activity_log after insert or update or delete on profiles for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on renewal_invoices;
create trigger trg_tenant_activity_log after insert or update or delete on renewal_invoices for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on scribe_requests;
create trigger trg_tenant_activity_log after insert or update or delete on scribe_requests for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on spec_consultations;
create trigger trg_tenant_activity_log after insert or update or delete on spec_consultations for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on specialist_profiles;
create trigger trg_tenant_activity_log after insert or update or delete on specialist_profiles for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on staleness_escalations;
create trigger trg_tenant_activity_log after insert or update or delete on staleness_escalations for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on staleness_policies;
create trigger trg_tenant_activity_log after insert or update or delete on staleness_policies for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on support_tickets;
create trigger trg_tenant_activity_log after insert or update or delete on support_tickets for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on tenant_ai_usage;
create trigger trg_tenant_activity_log after insert or update or delete on tenant_ai_usage for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on tenant_feature_overrides;
create trigger trg_tenant_activity_log after insert or update or delete on tenant_feature_overrides for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on trust_policies;
create trigger trg_tenant_activity_log after insert or update or delete on trust_policies for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on usage_metrics;
create trigger trg_tenant_activity_log after insert or update or delete on usage_metrics for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on vendors;
create trigger trg_tenant_activity_log after insert or update or delete on vendors for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on widget_keys;
create trigger trg_tenant_activity_log after insert or update or delete on widget_keys for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on work_item_framing;
create trigger trg_tenant_activity_log after insert or update or delete on work_item_framing for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on workspaces;
create trigger trg_tenant_activity_log after insert or update or delete on workspaces for each row execute function log_tenant_activity();
