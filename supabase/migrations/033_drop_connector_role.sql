-- ============================================================
-- Migration 033: Drop deprecated connectors.role column.
--
-- connectors.role was superseded by connectors.category in
-- migration 027 and kept only for rollout safety (see 027's
-- comment on the column). Cleanup pass #7 confirmed zero
-- remaining reads/writes of .role on connector rows anywhere in
-- src/ or supabase/functions/ — every consumer (connector-hub,
-- specialist-consult, category contracts, adapter templates,
-- the browser connectorApi mirror) has used category since 027.
--
-- Safe to drop: no code path references it, backfill to category
-- already ran in 027, and this migration is additive-only
-- elsewhere (no data loss beyond the column itself).
-- ============================================================

alter table connectors drop constraint if exists connectors_role_check;
alter table connectors drop column if exists role;
