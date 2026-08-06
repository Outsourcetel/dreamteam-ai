-- 623 — the action gate is throwing, and it is my fault.
--
-- ⚠⚠ LIVE BREAKAGE. Right now every call to decide_action_execution — the gate
-- that decides whether ANY governed action runs, needs a human, or is blocked —
-- fails outright:
--
--   ERROR: function resolve_de_autonomy_chain(uuid, text[], uuid, text)
--          is not unique
--   HINT:  Could not choose a best candidate function.
--
-- Migration 618 added `p_playbook_id uuid default null` to BOTH
-- resolve_de_autonomy and resolve_de_autonomy_chain using CREATE OR REPLACE. A
-- different argument list does not replace, it OVERLOADS — and because the new
-- argument has a default, the existing four-argument call inside
-- decide_action_execution matches both candidates.
--
-- ⚠⚠ I ALREADY FIXED THIS EXACT DEFECT IN 620 — for set_de_autonomy — AND DID
-- NOT CHECK THE OTHER TWO FUNCTIONS I HAD EXTENDED THE SAME WAY IN THE SAME
-- MIGRATION. Fixing one instance of a class instead of all of them is the
-- precise failure these audits keep naming: I searched for the case I had in
-- mind rather than enumerating every function 618 touched.
--
-- It is also the third appearance of this one shape: `search_knowledge` in the
-- first duplicate audit, `set_de_autonomy` in 620, and now these two.
--
-- Found by the circuit-breaker migration's own verify block calling the gate.
-- Nothing in the app told me, because nothing has exercised a governed action
-- since 618 — the workspace is quiet, which is the only reason this did not
-- surface as customer-visible failure.

begin;

-- Drop the four-argument originals; keep the five-argument versions 618 wrote.
-- Order matters: the ambiguity persists until BOTH sides are resolved.
drop function if exists resolve_de_autonomy(uuid, text, uuid, text);
drop function if exists resolve_de_autonomy_chain(uuid, text[], uuid, text);

do $verify$
declare
  v_n int;
  v_t uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_d jsonb;
  v_e boolean;
begin
  -- Exactly one of each, or the gate stays broken.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_de_autonomy';
  if v_n <> 1 then raise exception '% overloads of resolve_de_autonomy remain', v_n; end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_de_autonomy_chain';
  if v_n <> 1 then raise exception '% overloads of resolve_de_autonomy_chain remain', v_n; end if;

  -- ⚠ And nothing else 618 touched may be ambiguous either. This is the check
  -- I should have run in 620 instead of fixing a single function.
  select count(*) into v_n from (
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_de_autonomy', 'resolve_de_autonomy', 'resolve_de_autonomy_chain',
                        'derive_de_autonomy_dials', 'get_workforce_trust_metrics')
    group by p.proname having count(*) > 1) x;
  if v_n > 0 then raise exception '% function(s) from the 618/621 work still have overloads', v_n; end if;

  if v_t is null then raise notice 'no workspace to verify the gate against'; return; end if;

  -- THE call that was failing. It must now return a decision.
  v_d := decide_action_execution(v_t, 'a harmless read', 'crm', false, null, null);
  if v_d->>'decision' is null then
    raise exception 'the gate returned no decision';
  end if;

  -- And the resolver it depends on must answer for a real employee.
  select enabled into v_e from resolve_de_autonomy(
    v_t, 'action:billing',
    (select id from digital_employees where tenant_id = v_t and status = 'active' order by created_at limit 1),
    'billing', null);
  if v_e is null then raise exception 'resolve_de_autonomy returned no row'; end if;

  raise notice 'the gate answers again: % (resolver reachable, one overload each)', v_d->>'decision';
end;
$verify$;

commit;
