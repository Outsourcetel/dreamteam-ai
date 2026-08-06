-- 617 — one answer to "who may sign this".
--
-- Round 5 flagged `check_approval_sod` as a governance control that was never
-- wired, and the instruction was to wire it. Reading the live path first showed
-- that would have been the WRONG move, so this migration does the opposite.
--
-- There are TWO implementations of approval control in this database:
--
--   LIVE   approval_authority + has_approval_authority + decide_human_task
--   DEAD   sod_policies       + check_approval_sod
--
-- The live one already does almost everything the dead one offers:
--
--   authority to approve at all      LIVE ✓ (per user / role / org unit, per category)
--   a spending ceiling               LIVE ✓ (max_amount_cents)
--   dual control over a threshold    LIVE ✓ (second_approver_above_cents ->
--                                     needs_second -> first_approver_id)
--   the second approver must differ  LIVE ✓ (first_approver_id = auth.uid()
--                                     re-parks it rather than completing)
--
-- The only thing `check_approval_sod` adds is approver ≠ PREPARER — and that
-- control has no subject in this product. Every approval task in the system is
-- raised by a digital employee (305) or by the platform (63). ZERO are created
-- by a human, so there is no preparer for an approver to collide with. The
-- design is that a person approves a DE's work; that is the feature, not a
-- violation of it.
--
-- Wiring the dead twin would therefore have created a SECOND policy table and a
-- second answer to "can this person approve" — the precise duplication these
-- audits exist to remove ([[five department lists]], [[two AR stacks]]).
--
-- ⚠ THE REAL GAP IS CONFIGURATION, NOT CODE, and it is not fixed here because
-- it is not mine to invent: `approval_authority` holds **0 rows across all 16
-- workspaces**, so has_approval_authority answers
--
--     {"allowed": true, "needs_second": false,
--      "reason": "no approval limits are declared in this workspace"}
--
-- to a five-million-dollar approval. That is a defensible default for a fresh
-- workspace, and the Organisation page already says so in plain words — "No
-- limits are set, so there are none. Today anyone who can see an approval can
-- grant it." Someone has to decide the numbers.
--
-- Safe to drop: no SQL caller, no foreign key, no reference in src/ or
-- supabase/functions/, and 0 policy rows ever written.

begin;

do $verify$
declare
  v_sql_callers int;
  v_fks         int;
  v_rows        int;
begin
  select count(*) into v_sql_callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.proname <> 'check_approval_sod'
    and pg_get_functiondef(p.oid) ~ '(check_approval_sod|sod_policies)';
  if v_sql_callers > 0 then
    raise exception '% function(s) still reference the SoD twin — refusing to drop', v_sql_callers;
  end if;

  select count(*) into v_fks from pg_constraint c join pg_class f on f.oid = c.confrelid
  where f.relname = 'sod_policies' and c.contype = 'f';
  if v_fks > 0 then
    raise exception '% foreign key(s) point at sod_policies', v_fks;
  end if;

  select count(*) into v_rows from sod_policies;
  if v_rows > 0 then
    raise exception 'sod_policies holds % row(s) — somebody configured a policy; stop and reconcile it with approval_authority first', v_rows;
  end if;
end;
$verify$;

drop function if exists check_approval_sod(uuid, text, uuid, uuid, bigint, uuid);
drop table if exists sod_policies;

do $verify$
declare
  v_left    int;
  v_live    int;
  v_verdict jsonb;
  v_tid     uuid := (select id from tenants where slug = 'outsourcetel-hq');
begin
  select count(*) into v_left from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'check_approval_sod';
  if v_left > 0 then
    raise exception 'check_approval_sod survived — a drop with the wrong signature is a SILENT no-op';
  end if;
  if to_regclass('public.sod_policies') is not null then
    raise exception 'sod_policies survived';
  end if;

  -- The LIVE mechanism must be untouched: table, check, and the decision path.
  if to_regclass('public.approval_authority') is null then
    raise exception 'approval_authority is gone — the live path was damaged';
  end if;
  select count(*) into v_live from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('has_approval_authority', 'decide_human_task');
  if v_live < 2 then
    raise exception 'the live approval path lost a function (% of 2)', v_live;
  end if;

  -- And it must still answer. This asserts the CURRENT honest answer: with no
  -- limits declared it permits — so if this ever starts returning allowed=false,
  -- somebody has configured limits and that is worth knowing.
  if v_tid is not null then
    v_verdict := has_approval_authority(
      (select user_id from profiles where tenant_id = v_tid and role = 'tenant_owner' limit 1),
      v_tid, 'spend', 500000000);
    raise notice 'live check still answers: %', v_verdict->>'reason';
  end if;

  raise notice 'the SoD twin is gone; approval_authority + has_approval_authority + decide_human_task intact';
end;
$verify$;

commit;
