-- ═══════════════════════════════════════════════════════════════
-- 152 — Attach the tenant activity-log trigger to the security &
-- access tables that shipped AFTER the migration-067 trigger batch.
--
-- The Security & Access page gains a real, tenant-wide "Access &
-- security activity" timeline (date-windowed, default 7 days). That
-- timeline reads tenant_activity_log. Migration 067 attached
-- trg_tenant_activity_log to every base table that existed then, but
-- the API-key (090), session-policy (091), and IP-allowlist (092)
-- tables came later and were never wired in — so key creation /
-- revocation and IP changes were silently absent from the log.
--
-- log_tenant_activity() (migration 066) is safe to attach anywhere:
-- it no-ops unless auth.uid() resolves to a profile whose tenant_id
-- matches the row's tenant_id, and it swallows every exception. All
-- four tables below carry a tenant_id column, so the actor↔row tenant
-- match works; the two tenant_id-keyed tables simply log a null
-- row_pk, which the UI already tolerates.
-- ═══════════════════════════════════════════════════════════════

drop trigger if exists trg_tenant_activity_log on tenant_api_keys;
create trigger trg_tenant_activity_log
  after insert or update or delete on tenant_api_keys
  for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on tenant_session_policies;
create trigger trg_tenant_activity_log
  after insert or update or delete on tenant_session_policies
  for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on tenant_ip_allowlists;
create trigger trg_tenant_activity_log
  after insert or update or delete on tenant_ip_allowlists
  for each row execute function log_tenant_activity();

drop trigger if exists trg_tenant_activity_log on tenant_ip_allowlist_entries;
create trigger trg_tenant_activity_log
  after insert or update or delete on tenant_ip_allowlist_entries
  for each row execute function log_tenant_activity();
