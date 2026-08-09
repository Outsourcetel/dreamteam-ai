-- 660_close_the_anon_delete_and_converge_both.sql
-- ============================================================================
-- Migration 659 asserted the end state of the contact read/write/delete trio
-- and PASSED on production while FAILING on dev with:
--
--   659: delete_account_contact REACHABLE BY ANON;
--
-- That is a real hole, and it is exactly the kind this repo has shipped before:
-- a function that DELETES a customer's contact, callable by an anonymous
-- caller. It exists on dev and not on production, so the two databases had
-- drifted on the privilege — which is the same class of divergence 659 was
-- written to fix, found one function further along.
--
-- Dev is a test project, so the exposure is bounded. It is still the wrong
-- default and it is fixed here rather than left as "only dev".
--
-- This migration is the FINAL state of the trio and is idempotent: on
-- production the revoke is a no-op and the grants already hold. It exists as a
-- separate step because 659 had already been recorded on production, and an
-- applied migration is not edited — the ledger is a history, not a draft.
--
-- ⚠ WHY THE ASSERTION IS THE POINT. Three migrations in a row (656, 658, 659)
-- were each written believing the privilege state was known, and each was wrong
-- in a different way:
--   656 revoked PUBLIC and silently took `authenticated` with it.
--   658 assumed both databases would agree, and they did not.
--   659 assumed the trio was clean apart from what it was fixing, and found an
--       anon-reachable delete.
-- None of those was discovered by reading the REVOKE statements. Every one was
-- caught by asserting `has_function_privilege` afterwards — in a migration, or
-- by certify's execute-perimeter probe on the next run. Write the assertion.
-- ============================================================================

begin;

-- Never anon. These three all act on a named customer's contact record.
revoke all on function public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid, text) from anon, public;
revoke all on function public.list_account_contacts(uuid) from anon, public;
revoke all on function public.delete_account_contact(uuid) from anon, public;

-- Then grant back EXACTLY the reach each needs. Stated positively, because a
-- revoke's leftovers are not a specification.
grant execute on function public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid, text) to authenticated;
grant execute on function public.list_account_contacts(uuid) to authenticated;
grant execute on function public.delete_account_contact(uuid) to authenticated;

do $$
declare r record; v_bad text := '';
begin
  for r in
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_account_contact', 'list_account_contacts', 'delete_account_contact')
  loop
    if not r.authed then v_bad := v_bad || format('%s unreachable by authenticated; ', r.proname); end if;
    if r.anon      then v_bad := v_bad || format('%s REACHABLE BY ANON; ', r.proname); end if;
  end loop;
  if v_bad <> '' then raise exception '660: %', v_bad; end if;

  -- And the round trip 656/657 exist for: a role must be writeable AND readable.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='set_account_contact'
                    and pg_get_function_identity_arguments(p.oid) like '%p_role%') then
    raise exception '660: set_account_contact cannot write a role';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='list_account_contacts'
                    and p.prosrc like '%''role'', c.role%') then
    raise exception '660: list_account_contacts cannot read a role back';
  end if;

  raise notice '660: contact trio — authenticated only, no anon, role writeable and readable';
end $$;

commit;
