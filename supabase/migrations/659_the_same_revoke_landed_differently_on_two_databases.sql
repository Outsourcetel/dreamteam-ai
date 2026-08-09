-- 659_the_same_revoke_landed_differently_on_two_databases.sql
-- ============================================================================
-- Migration 658 PASSED on production and FAILED on dev, on this assertion:
--
--   658: list_account_contacts is not reachable by the panel
--
-- Same statement, same function, two different outcomes. On production
-- `list_account_contacts` still had EXECUTE for `authenticated` after 657's
-- `revoke all ... from public, anon`; on dev it did not. Whether a role keeps
-- its privilege after that revoke depends on HOW it held it — a named grant
-- survives, a privilege inherited through PUBLIC does not — and the two
-- databases had drifted on that detail without anyone noticing.
--
-- The consequence was quiet but real: 658 landed on production and did not land
-- on dev, so the migration ledgers diverged. A migration that succeeds in one
-- environment and fails in another is a worse problem than a migration that
-- fails everywhere, because only one of those gets noticed.
--
-- This states the END STATE explicitly for both functions on both databases,
-- rather than relying on what a revoke happened to leave behind. Idempotent: on
-- production these grants already hold and it changes nothing.
--
-- ⚠ THE RULE THIS PAIR ESTABLISHES. `revoke` statements are not a description
-- of the resulting privileges — they are one input to it. The only trustworthy
-- check is `has_function_privilege` AFTER the fact, asserted in the migration.
-- Both of this repo's standing warnings are instances of the same thing:
--   · "revoking anon alone is theatre" — the named grant survives.
--   · this one — revoking PUBLIC can take an inherited grant with it.
-- ============================================================================

begin;

grant execute on function public.list_account_contacts(uuid) to authenticated;
grant execute on function
  public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid, text)
  to authenticated;

do $$
declare r record; v_bad text := '';
begin
  for r in
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_account_contact', 'list_account_contacts',
                         'delete_account_contact')
  loop
    -- Reachable by a signed-in user (the functions enforce role themselves),
    -- and never by anon.
    if not r.authed then v_bad := v_bad || format('%s unreachable by authenticated; ', r.proname); end if;
    if r.anon      then v_bad := v_bad || format('%s REACHABLE BY ANON; ', r.proname); end if;
  end loop;

  if v_bad <> '' then
    raise exception '659: %', v_bad;
  end if;

  raise notice '659: the contact read/write/delete trio is reachable by authenticated and closed to anon, on this database';
end $$;

commit;
