-- 657_and_a_role_nobody_could_read.sql
-- ============================================================================
-- Migration 656 made a contact's role WRITEABLE. This makes it READABLE.
--
-- `list_account_contacts` builds its jsonb object field by field and never
-- included `role`, so the Customer Success panel could not show one, could not
-- pre-fill it when editing a contact, and would silently blank it on every save
-- if the form sent back what it had loaded. Half a fix is its own defect: a
-- value you can set and never see is indistinguishable from one that did not
-- save.
--
-- Same signature, so `create or replace` genuinely replaces — no overload risk
-- here, unlike 656 where the argument list changed and the function had to be
-- dropped first.
-- ============================================================================

begin;

create or replace function public.list_account_contacts(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
    'email', c.email, 'phone', c.phone, 'mobile', c.mobile, 'title', c.title,
    'is_primary', c.is_primary,
    -- mig 657: the role an employee asks for by name. Absent here since 609,
    -- which is why the panel could not display or preserve it.
    'role', c.role,
    -- Where it came from, so nobody edits a mirrored row expecting it to stick.
    'source', coalesce(c.source, 'entered by hand')
  ) order by c.is_primary desc, c.last_name, c.first_name), '[]'::jsonb)
  from customer_account_contacts c
  where c.account_id = p_account_id and c.tenant_id = auth_tenant_id();
$function$;

revoke all on function public.list_account_contacts(uuid) from public, anon;

do $$
declare v_src text; v_n int;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_account_contacts';
  if v_src not like '%''role'', c.role%' then
    raise exception '657: the reader still does not return role';
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_account_contacts';
  if v_n <> 1 then raise exception '657: % overloads of list_account_contacts', v_n; end if;

  -- The round trip must be closed: writeable (656) AND readable (657).
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'set_account_contact'
                    and pg_get_function_identity_arguments(p.oid) like '%p_role%') then
    raise exception '657: set_account_contact cannot write a role — 656 did not land';
  end if;

  raise notice '657: role is now both writeable and readable';
end $$;

commit;
