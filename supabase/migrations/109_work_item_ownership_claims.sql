-- Migration 109: Wave 1.2 — give every ticket an owner.
--
-- THE BUG, confirmed live in production before this fix: poll_de_work_
-- sources_targets (036) returns one row per (connector, subject) where
-- the subject has >= search access — by design, so multiple DEs or
-- specialists can each be granted the same connector/category. But
-- handlePollDeWorkSources (specialist-consult) fetches ALL targets
-- ONCE up front, before its for-loop starts, and inbox_watch_state's
-- cursor is keyed by (tenant_id, connector_id) only — NOT by subject.
-- So when N subjects are eligible on the same connector, all N target
-- rows carry the IDENTICAL (stale) last_seen_external_ref captured at
-- the same moment, and each subject's iteration independently
-- recomputes the SAME "new items" diff and fully reprocesses it —
-- separate evidence_runs, separate decisions, and if an action_
-- definition is registered for the category, potentially separate
-- REAL actions (e.g. a double-send) for the exact same item.
--
-- Confirmed live on Acme Telecom (the real test tenant) at the time of
-- this migration: 5 distinct (connector, category) pairs already have
-- 2 eligible subjects each (a DE + a specialist on crm/product_system/
-- helpdesk, two DEs on erp_financials) — this is not a hypothetical
-- edge case, it is already the tenant's live configuration.
--
-- THE FIX: a real claim/lock, not a routing heuristic. Before any
-- subject does the expensive work (evidence gathering, triage, acting)
-- on a newly-seen item, it must first win an atomic claim on
-- (tenant_id, connector_id, external_ref). Whichever subject's
-- INSERT lands first owns the item; every other subject's attempt
-- hits the unique constraint and skips it outright — no evidence run,
-- no decision, no audit noise. This is race-safe regardless of which
-- subject's target the for-loop happens to reach first, and it
-- persists across cron ticks (unlike the connector-level cursor), so
-- it also guards the (rarer) case of two ticks racing.
--
-- ALSO FOUND AND FIXED WHILE HERE: inbox_watch_state (034) grants
-- anon/authenticated full INSERT/UPDATE/DELETE/TRUNCATE at the SQL
-- level. RLS is enabled with only a SELECT policy, so INSERT/UPDATE/
-- DELETE are correctly blocked in practice (no matching policy =
-- implicit deny for non-bypassrls roles) — but TRUNCATE is NOT
-- governed by row-level security in Postgres at all, so the anon
-- TRUNCATE grant is a real, live, unmitigated privilege: any caller
-- able to run SQL as anon could wipe every tenant's proactive-poll
-- cursor. Same class of default-schema-privilege leak this session
-- has repeatedly found and fixed elsewhere — closed here too, since
-- this migration already touches this exact subsystem.
-- ============================================================

-- ── inbox_watch_state: strip the dangling write grants (RLS already
-- proves only SELECT was ever intended — no INSERT/UPDATE/DELETE
-- policy exists for any non-bypassrls role). ───────────────────────
revoke insert, update, delete, truncate, trigger, references on inbox_watch_state from anon;
revoke insert, update, delete, truncate, trigger, references on inbox_watch_state from authenticated;
revoke all on inbox_watch_state from public;

-- ── work_item_claims: the atomic ownership record. ─────────────────
create table if not exists work_item_claims (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  connector_id             uuid not null references connectors(id) on delete cascade,
  external_ref             text not null,
  category                 text not null,
  owner_subject_kind       text not null check (owner_subject_kind in ('de', 'specialist')),
  owner_subject_id         uuid not null,
  evidence_run_decision_id uuid references evidence_run_decisions(id) on delete set null,
  claimed_at               timestamptz not null default now(),
  unique (tenant_id, connector_id, external_ref)
);

create index if not exists work_item_claims_tenant_owner_idx
  on work_item_claims (tenant_id, owner_subject_kind, owner_subject_id);

alter table work_item_claims enable row level security;

create policy work_item_claims_tenant_select on work_item_claims
  for select using (tenant_id = auth_tenant_id());

-- Fresh table picks up this project's default schema privileges
-- (anon + authenticated + service_role all get table-level rights by
-- default) — the same trap caught repeatedly this session. The claim
-- itself is written exclusively by the service-role edge function
-- (handlePollDeWorkSources); the only client-facing need today is
-- read visibility for a future "who owns this ticket" view, already
-- scoped correctly by the SELECT policy above.
revoke all on work_item_claims from public;
revoke all on work_item_claims from anon;
revoke insert, update, delete, truncate, trigger, references on work_item_claims from authenticated;
grant select on work_item_claims to authenticated;
grant all on work_item_claims to service_role;
