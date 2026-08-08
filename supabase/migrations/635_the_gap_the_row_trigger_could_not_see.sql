-- 635 — the gap a ROW trigger could not see, and an action with no executor
--
-- Two unrelated leftovers, both found while finishing the specialist
-- retirement and the audit-immutability wording.
--
-- ════════════════════════════════════════════════════════════════════════
-- 1. audit_events: a row trigger does not fire on TRUNCATE
-- ════════════════════════════════════════════════════════════════════════
--
-- The Governance page tells an owner the record cannot be altered, and that
-- is the one sentence they will repeat to an auditor. It is very nearly true:
--
--   · trigger audit_events_no_update_delete fires on UPDATE and DELETE and
--     raises for every role including service_role
--   · anon and authenticated hold SELECT and nothing else, so no path
--     through the product can even attempt a write
--   · every row is hash-chained and verify_audit_chain walks it
--
-- But that trigger is FOR EACH ROW, and TRUNCATE does not produce rows — it
-- deallocates the table's pages. A row trigger never fires, so `TRUNCATE
-- audit_events` would have emptied the entire immutable record in one
-- statement without raising anything. service_role and postgres both hold
-- TRUNCATE on this table.
--
-- ⚠ THE OTHER "GAP" I FLAGGED IS NOT ONE, AND MUST NOT BE CLOSED.
-- audit_events_immutable lets a DELETE through when a session sets
-- app.allow_audit_purge. That looked like an escape hatch until I read who
-- uses it: delete_tenant (migration 194, and again in 371). It is how a
-- deleted workspace's records go with the workspace, which is what a customer
-- asking to be erased is entitled to. Removing it would break tenant
-- deletion. It stays, deliberately, and the page wording is written to be
-- true alongside it: nothing can alter or remove a record while the workspace
-- exists; deleting the workspace takes the record with it.
--
-- ════════════════════════════════════════════════════════════════════════
-- 2. action_definitions: retire create_specialist
-- ════════════════════════════════════════════════════════════════════════
--
-- Migration 611 retired the specialist role and dropped digital_employees'
-- is_specialist and specialist_key. The connector-hub executor behind
-- `create_specialist` inserted a row setting both, so every call returned
-- create_failed with a Postgres "column does not exist". The executor is gone
-- as of today's deploy; the DEFINITION is still ACTIVE, platform-scoped and
-- marked destructive — advertised to all 16 tenants with nothing behind it.
--
-- ⚠ DISABLED, NOT DELETED. action_executions references action_definitions
-- ON DELETE CASCADE and two executions exist. Deleting the row would erase
-- its own history, which is the same mistake 611 avoided by retiring
-- specialist rows rather than removing them.

begin;

-- ── ASSERT THE BEFORE STATE ─────────────────────────────────────────────
-- A migration that would be a no-op should say so loudly rather than report
-- success having changed nothing.
do $$
begin
  if to_regclass('public.audit_events') is null then
    raise exception '635: audit_events does not exist';
  end if;
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.audit_events'::regclass
       and not tgisinternal and (tgtype & 32) <> 0
  ) then
    raise exception '635: a TRUNCATE trigger already exists on audit_events';
  end if;
  if not exists (
    select 1 from action_definitions
     where action_key = 'create_specialist' and status = 'active'
  ) then
    raise exception '635: create_specialist is not active — nothing to retire';
  end if;
end $$;

-- ── 1. block TRUNCATE on the record ─────────────────────────────────────
create or replace function public.audit_events_no_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'audit_events cannot be truncated — the record is append-only. Deleting a tenant removes its own rows through delete_tenant.';
end;
$$;

revoke all on function public.audit_events_no_truncate() from public, anon, authenticated;

-- FOR EACH STATEMENT: TRUNCATE produces no rows, which is exactly why the
-- existing row-level trigger could not see it.
create trigger audit_events_no_truncate_stmt
  before truncate on public.audit_events
  for each statement execute function public.audit_events_no_truncate();

-- ── 2. retire the action with no executor ───────────────────────────────
update action_definitions
   set status = 'disabled', updated_at = now()
 where action_key = 'create_specialist'
   and status = 'active';

-- ── ASSERT THE AFTER STATE ──────────────────────────────────────────────
do $$
declare v_trunc int; v_active int; v_disabled int;
begin
  select count(*) into v_trunc from pg_trigger
   where tgrelid = 'public.audit_events'::regclass
     and not tgisinternal and (tgtype & 32) <> 0;
  if v_trunc <> 1 then
    raise exception '635: expected 1 TRUNCATE trigger on audit_events, found %', v_trunc;
  end if;

  select count(*) filter (where status = 'active'),
         count(*) filter (where status = 'disabled')
    into v_active, v_disabled
    from action_definitions where action_key = 'create_specialist';
  if v_active <> 0 or v_disabled < 1 then
    raise exception '635: create_specialist still active (% active, % disabled)', v_active, v_disabled;
  end if;

  -- The row trigger this one complements must still be there. Adding a guard
  -- that silently replaced the stronger one would be worse than no guard.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.audit_events'::regclass
       and tgname = 'audit_events_no_update_delete' and tgenabled = 'O'
  ) then
    raise exception '635: the UPDATE/DELETE trigger is missing or disabled';
  end if;
end $$;

commit;
