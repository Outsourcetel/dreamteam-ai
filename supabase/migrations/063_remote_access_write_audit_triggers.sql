-- Migration 063: gap 5 follow-up. Migration 062 built the core write-audit
-- mechanism for Remote Access (the log table + the trigger function) but
-- deliberately deferred the mechanical work of attaching the trigger to
-- every tenant-scoped table to a separate migration. This is that
-- follow-up: attach `trg_remote_access_audit` to every public-schema base
-- table that has a tenant_id column, so a remote-access write to ANY
-- tenant-scoped table is captured, not just the two (customer_accounts,
-- support_tickets) used for the original manual verification pass.
--
-- Excluded (confirmed reasoning, not re-litigated here):
--   audit_events, audit_logs, audit_evidence -- already-immutable audit
--     tables; auditing writes to an audit table is redundant/circular.
--   platform_access_events -- the remote-access session log itself.
--   tenant_ancestry -- system-maintained hierarchy structure, not user
--     content, already has its own maintenance trigger.
--   remote_access_write_log -- the write-audit log created by migration
--     062 itself; also has a tenant_id column, but auditing writes to the
--     audit log (which only the SECURITY DEFINER trigger function ever
--     writes to) would be redundant/circular for the same reason as the
--     audit_* tables above. Not in the founder's original exclusion list
--     because it didn't exist before migration 062 in this same PR.
--
-- customer_accounts and support_tickets already carry this trigger from
-- the manual verification pass done alongside migration 062; re-issued
-- here too via the idempotent drop-then-create so this migration is the
-- single source of truth for the full attachment list (78 tables total).
-- =====================================================================

drop trigger if exists trg_remote_access_audit on action_definitions;
create trigger trg_remote_access_audit after insert or update or delete on action_definitions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on action_executions;
create trigger trg_remote_access_audit after insert or update or delete on action_executions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on activity_events;
create trigger trg_remote_access_audit after insert or update or delete on activity_events for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on adapter_templates;
create trigger trg_remote_access_audit after insert or update or delete on adapter_templates for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on agent_actions;
create trigger trg_remote_access_audit after insert or update or delete on agent_actions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on ai_usage_events;
create trigger trg_remote_access_audit after insert or update or delete on ai_usage_events for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on answer_cache;
create trigger trg_remote_access_audit after insert or update or delete on answer_cache for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on bank_transactions;
create trigger trg_remote_access_audit after insert or update or delete on bank_transactions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on bills;
create trigger trg_remote_access_audit after insert or update or delete on bills for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on capabilities;
create trigger trg_remote_access_audit after insert or update or delete on capabilities for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on close_tasks;
create trigger trg_remote_access_audit after insert or update or delete on close_tasks for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on close_workspaces;
create trigger trg_remote_access_audit after insert or update or delete on close_workspaces for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on connectors;
create trigger trg_remote_access_audit after insert or update or delete on connectors for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on conversation_facts;
create trigger trg_remote_access_audit after insert or update or delete on conversation_facts for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on conversations;
create trigger trg_remote_access_audit after insert or update or delete on conversations for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on customer_accounts;
create trigger trg_remote_access_audit after insert or update or delete on customer_accounts for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on customers;
create trigger trg_remote_access_audit after insert or update or delete on customers for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on data_access_grants;
create trigger trg_remote_access_audit after insert or update or delete on data_access_grants for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_autonomy;
create trigger trg_remote_access_audit after insert or update or delete on de_autonomy for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_conversations;
create trigger trg_remote_access_audit after insert or update or delete on de_conversations for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_experience;
create trigger trg_remote_access_audit after insert or update or delete on de_experience for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_messages;
create trigger trg_remote_access_audit after insert or update or delete on de_messages for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_playbook_assignments;
create trigger trg_remote_access_audit after insert or update or delete on de_playbook_assignments for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on de_playbook_charter;
create trigger trg_remote_access_audit after insert or update or delete on de_playbook_charter for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on departments;
create trigger trg_remote_access_audit after insert or update or delete on departments for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on digital_employees;
create trigger trg_remote_access_audit after insert or update or delete on digital_employees for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on end_user_sessions;
create trigger trg_remote_access_audit after insert or update or delete on end_user_sessions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on escalations;
create trigger trg_remote_access_audit after insert or update or delete on escalations for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on eval_runs;
create trigger trg_remote_access_audit after insert or update or delete on eval_runs for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on evidence_feedback;
create trigger trg_remote_access_audit after insert or update or delete on evidence_feedback for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on evidence_run_decisions;
create trigger trg_remote_access_audit after insert or update or delete on evidence_run_decisions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on evidence_runs;
create trigger trg_remote_access_audit after insert or update or delete on evidence_runs for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on exceptions;
create trigger trg_remote_access_audit after insert or update or delete on exceptions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on fin_accounts;
create trigger trg_remote_access_audit after insert or update or delete on fin_accounts for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on fin_documents;
create trigger trg_remote_access_audit after insert or update or delete on fin_documents for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on golden_qa;
create trigger trg_remote_access_audit after insert or update or delete on golden_qa for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on guardrail_rules;
create trigger trg_remote_access_audit after insert or update or delete on guardrail_rules for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on health_score_config;
create trigger trg_remote_access_audit after insert or update or delete on health_score_config for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on human_tasks;
create trigger trg_remote_access_audit after insert or update or delete on human_tasks for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on inbox_watch_state;
create trigger trg_remote_access_audit after insert or update or delete on inbox_watch_state for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on invoices;
create trigger trg_remote_access_audit after insert or update or delete on invoices for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on journal_entries;
create trigger trg_remote_access_audit after insert or update or delete on journal_entries for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_articles;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_articles for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_chunks;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_chunks for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_doc_chunks;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_doc_chunks for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_doc_scopes;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_doc_scopes for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_docs;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_docs for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on knowledge_revision_requests;
create trigger trg_remote_access_audit after insert or update or delete on knowledge_revision_requests for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on media_assets;
create trigger trg_remote_access_audit after insert or update or delete on media_assets for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on messages;
create trigger trg_remote_access_audit after insert or update or delete on messages for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on notifications;
create trigger trg_remote_access_audit after insert or update or delete on notifications for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on onboarding_projects;
create trigger trg_remote_access_audit after insert or update or delete on onboarding_projects for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on onboarding_template_versions;
create trigger trg_remote_access_audit after insert or update or delete on onboarding_template_versions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on onboarding_templates;
create trigger trg_remote_access_audit after insert or update or delete on onboarding_templates for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on opportunities;
create trigger trg_remote_access_audit after insert or update or delete on opportunities for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on payments;
create trigger trg_remote_access_audit after insert or update or delete on payments for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbook_definitions;
create trigger trg_remote_access_audit after insert or update or delete on playbook_definitions for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbook_event_rules;
create trigger trg_remote_access_audit after insert or update or delete on playbook_event_rules for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbook_runs;
create trigger trg_remote_access_audit after insert or update or delete on playbook_runs for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbook_schedules;
create trigger trg_remote_access_audit after insert or update or delete on playbook_schedules for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbook_trigger_fires;
create trigger trg_remote_access_audit after insert or update or delete on playbook_trigger_fires for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on playbooks;
create trigger trg_remote_access_audit after insert or update or delete on playbooks for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on profiles;
create trigger trg_remote_access_audit after insert or update or delete on profiles for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on renewal_invoices;
create trigger trg_remote_access_audit after insert or update or delete on renewal_invoices for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on scribe_requests;
create trigger trg_remote_access_audit after insert or update or delete on scribe_requests for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on spec_consultations;
create trigger trg_remote_access_audit after insert or update or delete on spec_consultations for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on specialist_profiles;
create trigger trg_remote_access_audit after insert or update or delete on specialist_profiles for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on staleness_escalations;
create trigger trg_remote_access_audit after insert or update or delete on staleness_escalations for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on staleness_policies;
create trigger trg_remote_access_audit after insert or update or delete on staleness_policies for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on support_tickets;
create trigger trg_remote_access_audit after insert or update or delete on support_tickets for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on tenant_ai_usage;
create trigger trg_remote_access_audit after insert or update or delete on tenant_ai_usage for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on tenant_feature_overrides;
create trigger trg_remote_access_audit after insert or update or delete on tenant_feature_overrides for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on trust_policies;
create trigger trg_remote_access_audit after insert or update or delete on trust_policies for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on usage_metrics;
create trigger trg_remote_access_audit after insert or update or delete on usage_metrics for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on vendors;
create trigger trg_remote_access_audit after insert or update or delete on vendors for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on widget_keys;
create trigger trg_remote_access_audit after insert or update or delete on widget_keys for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on work_item_framing;
create trigger trg_remote_access_audit after insert or update or delete on work_item_framing for each row execute function log_remote_access_write();

drop trigger if exists trg_remote_access_audit on workspaces;
create trigger trg_remote_access_audit after insert or update or delete on workspaces for each row execute function log_remote_access_write();

