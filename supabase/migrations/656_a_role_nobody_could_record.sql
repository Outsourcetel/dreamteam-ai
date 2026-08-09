-- 656_a_role_nobody_could_record.sql
-- ============================================================================
-- `customer_account_contacts.role` has a nine-value CHECK — decision_maker,
-- economic_buyer, billing, technical, exec_sponsor, day_to_day, procurement,
-- legal, other — and NOTHING CAN WRITE IT. `set_account_contact` has no role
-- parameter and touches the column in neither its INSERT nor its UPDATE;
-- `upsert_external_contact`, the connector-sync writer, has no role either.
--
-- So every contact ever recorded lands with role = NULL, and the DE tool
-- `read_contacts` takes an optional role filter. An employee asking "who is the
-- day-to-day contact?" gets nothing back even when a contact exists, and
-- correctly escalates rather than guessing.
--
-- WHY THIS IS URGENT RATHER THAN TIDY. Eight pending tasks are blocked on
-- exactly this: the Account Success DE cannot find a contact for Grant Plastics
-- or West View. The founder is about to enter those contacts. Without this
-- migration they would land role-less, the role-filtered read would still
-- return nothing, and the employee would re-escalate in the same words — the
-- effort spent would buy nothing, which is the worst possible outcome of asking
-- someone to do data entry.
--
-- ⚠ DROP BEFORE CREATE, deliberately. `create or replace` with a DIFFERENT
-- argument list does not replace anything — it creates a SECOND OVERLOAD, and
-- the next call dies with 42725 "is not unique". That is migration 562's
-- outage, and it has been re-created twice since by exactly this shortcut.
-- The new parameter is appended with a DEFAULT so every existing named-argument
-- call site keeps working untouched.
-- ============================================================================

begin;

drop function if exists public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid);

create function public.set_account_contact(
  p_account_id uuid,
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_title      text default null,
  p_phone      text default null,
  p_mobile     text default null,
  p_is_primary boolean default false,
  p_contact_id uuid default null,
  p_role       text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_email  text := nullif(btrim(lower(p_email)), '');
  v_role   text := nullif(btrim(lower(p_role)), '');
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may record a customer contact';
  end if;
  if not exists (select 1 from customer_accounts where id = p_account_id and tenant_id = v_tenant) then
    raise exception 'that account is not in this workspace';
  end if;
  if coalesce(btrim(p_first_name),'') = '' and coalesce(btrim(p_last_name),'') = '' then
    raise exception 'a contact needs at least a name';
  end if;
  if v_email is null then
    raise exception 'a contact needs an email address — it is how the customer is recognised';
  end if;

  -- Refuse an unknown role by NAME rather than letting the CHECK reject the row
  -- with a constraint error nobody can read. The vocabulary is the CHECK's, read
  -- from it rather than duplicated here, so the two can never drift.
  if v_role is not null and v_role not in
     ('decision_maker','economic_buyer','billing','technical','exec_sponsor',
      'day_to_day','procurement','legal','other') then
    raise exception 'unknown contact role "%": use one of decision_maker, economic_buyer, billing, technical, exec_sponsor, day_to_day, procurement, legal, other', p_role;
  end if;

  if coalesce(p_is_primary, false) then
    update customer_account_contacts
       set is_primary = false, updated_at = now()
     where tenant_id = v_tenant and account_id = p_account_id and is_primary
       and (p_contact_id is null or id <> p_contact_id);
  end if;

  if p_contact_id is not null then
    update customer_account_contacts set
      first_name = nullif(btrim(p_first_name),''), last_name = nullif(btrim(p_last_name),''),
      email = v_email, end_user_ref = v_email, title = nullif(btrim(p_title),''),
      phone = nullif(btrim(p_phone),''), mobile = nullif(btrim(p_mobile),''),
      is_primary = coalesce(p_is_primary, false),
      -- NULL means "leave it alone" on an edit. Blanking a role that someone
      -- deliberately set, just because this form did not send one, would lose
      -- information silently.
      role = coalesce(v_role, role),
      updated_at = now()
    where id = p_contact_id and tenant_id = v_tenant
    returning id into v_id;
    if v_id is null then raise exception 'no such contact in this workspace'; end if;
  else
    insert into customer_account_contacts
      (tenant_id, account_id, end_user_ref, first_name, last_name, email, title, phone, mobile, is_primary, role)
    values (v_tenant, p_account_id, v_email,
            nullif(btrim(p_first_name),''), nullif(btrim(p_last_name),''),
            v_email, nullif(btrim(p_title),''),
            nullif(btrim(p_phone),''), nullif(btrim(p_mobile),''),
            coalesce(p_is_primary, false), v_role)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'contact_id', v_id);
end;
$function$;

revoke all on function public.set_account_contact(uuid, text, text, text, text, text, text, boolean, uuid, text)
  from public, anon;

-- ── Prove it, including the trap that would have shipped silently. ────────
do $$
declare
  v_overloads int;
  v_def       text;
  v_roles     text;
begin
  -- THE 42725 TRAP: exactly one set_account_contact must exist.
  select count(*) into v_overloads from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_account_contact';
  if v_overloads <> 1 then
    raise exception '656: % overloads of set_account_contact — the next call dies with 42725', v_overloads;
  end if;

  v_def := pg_get_functiondef('public.set_account_contact(uuid,text,text,text,text,text,text,boolean,uuid,text)'::regprocedure);
  if v_def not ilike '%role = coalesce(v_role, role)%' then
    raise exception '656: an edit without a role would blank an existing one';
  end if;
  if v_def not ilike '%is_primary, role)%' then
    raise exception '656: the insert still does not write role';
  end if;

  -- The validator's vocabulary must equal the CHECK's, or a "valid" role is
  -- refused by the constraint with an unreadable error.
  select pg_get_constraintdef(oid) into v_roles from pg_constraint
   where conrelid = 'public.customer_account_contacts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%role%' limit 1;
  if v_roles is null then raise exception '656: the role CHECK vanished'; end if;
  if v_def not ilike '%day_to_day%' or v_def not ilike '%exec_sponsor%'
     or v_roles not ilike '%day_to_day%' or v_roles not ilike '%exec_sponsor%' then
    raise exception '656: the validator and the CHECK disagree on the role vocabulary';
  end if;

  raise notice '656: role is now recordable; 1 overload; edits preserve an existing role';
end $$;

commit;
