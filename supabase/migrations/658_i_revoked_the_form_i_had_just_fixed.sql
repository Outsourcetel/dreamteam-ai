-- 658_i_revoked_the_form_i_had_just_fixed.sql
-- ============================================================================
-- Migration 656 dropped and recreated `set_account_contact` with the new
-- `p_role` parameter, then ran:
--
--   revoke all on function public.set_account_contact(...) from public, anon;
--
-- That is the house rule — a new SECURITY DEFINER function must not inherit a
-- default EXECUTE grant. But the OLD function was reachable by `authenticated`,
-- and it held that reach THROUGH PUBLIC. Revoking PUBLIC therefore took
-- `authenticated` with it, and the Customer Success contact form — the very
-- thing 656 existed to unblock — could no longer call the RPC at all.
--
-- Measured, not inferred:
--   set_account_contact(..., p_role text)   anon=false  authed=FALSE
--   list_account_contacts(p_account_id)     anon=false  authed=true
--
-- ⚠ THE LESSON, which is the inverse of the one this repo already carries.
-- The standing warning is "revoking anon alone is theatre — `revoke from
-- public` does not remove the NAMED anon/authenticated grants Supabase adds by
-- default." Both are true, and which one bites depends on how the role got its
-- privilege in the first place. So the only reliable check is not which REVOKE
-- you wrote — it is `has_function_privilege` afterwards. This migration asserts
-- the end state rather than trusting the statement.
--
-- Caught by certify's execute-perimeter probe on the very next run, before
-- anyone touched the form. Pinning that surface is what turned a silent
-- breakage into a red bar.
-- ============================================================================

begin;

-- The contact form is a signed-in, role-gated action: the function itself
-- refuses anyone below manager (`auth_has_tenant_role`), so `authenticated` is
-- the correct reach — not anon, and not public.
grant execute on function
  public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid, text)
  to authenticated;

do $$
declare v_anon boolean; v_authed boolean;
begin
  select has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
    into v_anon, v_authed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_account_contact';

  -- Assert the END STATE, which is the only thing that is actually true.
  if not v_authed then
    raise exception '658: the contact form still cannot call set_account_contact';
  end if;
  if v_anon then
    raise exception '658: set_account_contact is reachable by anon — that is the internet';
  end if;

  -- The reader must match: same reach, or the panel lists nothing.
  select has_function_privilege('authenticated', p.oid, 'EXECUTE') into v_authed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_account_contacts';
  if not v_authed then
    raise exception '658: list_account_contacts is not reachable by the panel';
  end if;

  raise notice '658: contact form reachable by authenticated, closed to anon';
end $$;

commit;
