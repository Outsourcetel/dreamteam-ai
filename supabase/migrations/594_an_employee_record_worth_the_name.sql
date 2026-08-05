-- 594 — an employee record worth the name.
--
-- `profiles` holds thirteen columns: id, user_id, tenant_id, full_name, avatar,
-- role, layer, is_active, last_seen_at, created_at, updated_at, department,
-- invited_by. That is a login, not a person. There is no job title, no start
-- date, no manager, no phone number, no address, no emergency contact — and no
-- EMAIL, despite `useUsers.ts` reading `row.email` on every render, which is
-- why the People page has always shown a blank email column.
--
-- ── The shape, and why it is three tables and not thirty columns ───────────
-- The fields differ by WHO MAY SEE THEM, and a single table cannot express
-- that. Row-level security answers "which rows", never "which columns".
--
--   profiles             — the directory. Who you are, what you do, who you
--                          report to. Visible to the workspace, because that
--                          is what a directory is for.
--   profile_private      — home address, date of birth, personal phone,
--                          emergency contact. Visible to the person and to
--                          owners/admins. Nobody else, including managers.
--   profile_compensation — pay. Readable by the person and owners/admins;
--                          WRITABLE by owners/admins only. Effective-dated, so
--                          a raise is a new row and the history survives.
--
-- ⚠ THE COLUMN-GRANT BOUNDARY THIS MIGRATION MUST NOT BREAK.
-- `profiles` carries an RLS policy "Users can update own profile" whose USING
-- clause is simply `auth.uid() = user_id` — which reads like any user may
-- rewrite any field of their own row, including `role`. And `profiles.role` IS
-- the authorization source: `auth_has_tenant_role` reads it directly.
--
-- It is not a hole, because the real boundary is a COLUMN grant: `authenticated`
-- holds UPDATE on exactly three columns — avatar, full_name, last_seen_at.
-- That is deliberate and it is what stops self-promotion to tenant_owner.
--
-- Every column added below therefore gets NO update grant to `authenticated`,
-- and all writes go through the SECURITY DEFINER functions at the bottom,
-- which check the caller's role explicitly. Granting UPDATE on the table to
-- make the new fields editable would silently hand every user their own role
-- column.

begin;

-- ── The directory ───────────────────────────────────────────────────────────

alter table profiles
  add column if not exists employee_number   text,
  add column if not exists first_name        text,
  add column if not exists middle_name       text,
  add column if not exists last_name         text,
  add column if not exists preferred_name    text,
  add column if not exists pronouns          text,
  add column if not exists work_email        text,
  add column if not exists work_phone        text,
  add column if not exists mobile_phone      text,
  add column if not exists job_title         text,
  add column if not exists employment_type   text,
  add column if not exists employment_status text,
  add column if not exists hire_date         date,
  add column if not exists end_date          date,
  add column if not exists org_unit_id       uuid references org_units(id) on delete set null,
  add column if not exists reports_to_user_id uuid,
  add column if not exists work_location     text,
  add column if not exists time_zone         text,
  add column if not exists locale            text;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_employment_type_check') then
    alter table profiles add constraint profiles_employment_type_check
      check (employment_type is null or employment_type in
             ('full_time','part_time','contractor','intern','temporary'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_employment_status_check') then
    alter table profiles add constraint profiles_employment_status_check
      check (employment_status is null or employment_status in
             ('active','on_leave','notice_period','terminated'));
  end if;
end;
$c$;

create index if not exists idx_profiles_org_unit on profiles(org_unit_id) where org_unit_id is not null;
create index if not exists idx_profiles_reports_to on profiles(reports_to_user_id) where reports_to_user_id is not null;
create unique index if not exists idx_profiles_employee_number
  on profiles(tenant_id, employee_number) where employee_number is not null;

-- ── The private record ──────────────────────────────────────────────────────

create table if not exists profile_private (
  user_id     uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  date_of_birth date,
  personal_email text,
  personal_phone text,
  address_line1 text,
  address_line2 text,
  city          text,
  state_region  text,
  postal_code   text,
  country       text,
  emergency_contact_name         text,
  emergency_contact_relationship text,
  emergency_contact_phone        text,
  updated_at  timestamptz not null default now()
);

drop trigger if exists profile_private_updated_at on profile_private;
create trigger profile_private_updated_at before update on profile_private
  for each row execute function update_updated_at();

alter table profile_private enable row level security;

-- Yours, or an owner/admin's business. A manager is NOT included: needing to
-- approve someone's work is not a reason to hold their home address.
drop policy if exists profile_private_read on profile_private;
create policy profile_private_read on profile_private for select
  using (tenant_id = auth_tenant_id()
         and (user_id = auth.uid() or auth_has_tenant_role(array['tenant_owner','tenant_admin'])));

-- ── Pay ─────────────────────────────────────────────────────────────────────
-- Effective-dated rather than a single number, so a raise does not erase what
-- somebody was paid last year — which is exactly the record you need when a
-- pay dispute arrives.

create table if not exists profile_compensation (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  amount_cents  bigint not null,
  currency      text not null default 'USD',
  pay_frequency text not null default 'annual'
                check (pay_frequency in ('hourly','weekly','biweekly','semimonthly','monthly','annual')),
  effective_from date not null,
  effective_to   date,
  note          text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists idx_profile_comp_user on profile_compensation(tenant_id, user_id, effective_from desc);

alter table profile_compensation enable row level security;

-- You may see your own pay. Owners and admins may see anyone's. Nobody else,
-- and writes do not happen here at all — see set_employee_compensation.
drop policy if exists profile_compensation_read on profile_compensation;
create policy profile_compensation_read on profile_compensation for select
  using (tenant_id = auth_tenant_id()
         and (user_id = auth.uid() or auth_has_tenant_role(array['tenant_owner','tenant_admin'])));

-- ── Backfill what we can honestly derive ───────────────────────────────────

-- The email that was always missing. auth.users has it for all 21 accounts;
-- `profiles` never carried it, so the People page read `row.email` and got
-- undefined on every row.
update profiles p
   set work_email = u.email
  from auth.users u
 where u.id = p.user_id and p.work_email is null and u.email is not null;

-- Split full_name only where it is unambiguous. A two-part name is a first and
-- a last name; three or more parts could be a middle name, a compound surname
-- or a patronymic, and guessing wrong puts a person's name in the wrong field
-- on their own record. Those are left for a human to enter.
update profiles
   set first_name = split_part(btrim(full_name), ' ', 1),
       last_name  = split_part(btrim(full_name), ' ', 2)
 where full_name is not null
   and array_length(string_to_array(btrim(full_name), ' '), 1) = 2
   and first_name is null;

-- Place people in the tree where their recorded department resolves to a real
-- unit. `profiles.department` matched a real department row for 0 of 21
-- profiles, so most of these will stay null — which is the honest outcome.
update profiles p
   set org_unit_id = u.id
  from org_units u
 where u.tenant_id = p.tenant_id
   and u.kind in ('department','team')
   and btrim(lower(replace(u.name, '_', ' '))) = btrim(lower(replace(coalesce(p.department,''), '_', ' ')))
   and coalesce(p.department, '') <> ''
   and p.org_unit_id is null;

-- Everyone who exists and is active is, as far as the data says, employed.
update profiles set employment_status = 'active'
 where employment_status is null and coalesce(is_active, true);

-- ── Writes ──────────────────────────────────────────────────────────────────
-- SECURITY DEFINER because `authenticated` deliberately holds UPDATE on only
-- three columns of `profiles`. Each function states its own rule rather than
-- relying on a grant that was designed for a different purpose.

create or replace function update_employee_profile(p_user_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := auth_tenant_id();
  v_is_hr   boolean := auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']);
  v_is_self boolean := (p_user_id = auth.uid());
  v_key     text;
  -- What the person may change about themselves: how to reach them and how
  -- they are addressed. Not their job, their manager or their start date.
  v_self_ok text[] := array['preferred_name','pronouns','work_phone','mobile_phone','time_zone','locale'];
  v_hr_ok   text[] := array['employee_number','first_name','middle_name','last_name','preferred_name',
                            'pronouns','work_email','work_phone','mobile_phone','job_title',
                            'employment_type','employment_status','hire_date','end_date',
                            'org_unit_id','reports_to_user_id','work_location','time_zone','locale'];
  v_allowed text[];
  v_applied text[] := '{}';
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from profiles where user_id = p_user_id and tenant_id = v_tenant) then
    raise exception 'no_such_employee_in_this_workspace';
  end if;
  if not (v_is_hr or v_is_self) then
    raise exception 'not_allowed: only an owner, admin or manager may edit someone else''s record';
  end if;

  v_allowed := case when v_is_hr then v_hr_ok else v_self_ok end;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(v_allowed)) then
      -- Named explicitly rather than skipped. Silently dropping a field the
      -- caller asked to change is how a UI reports success on a write that
      -- never happened.
      raise exception 'field_not_editable: %', v_key;
    end if;
    v_applied := v_applied || v_key;
  end loop;

  if array_length(v_applied, 1) is null then
    return jsonb_build_object('ok', true, 'changed', 0);
  end if;

  -- A manager cannot report to themselves; a cycle here would hang any org
  -- chart that walks the line.
  if p_patch ? 'reports_to_user_id'
     and nullif(p_patch->>'reports_to_user_id','')::uuid = p_user_id then
    raise exception 'a person cannot report to themselves';
  end if;

  update profiles p set
    employee_number    = case when p_patch ? 'employee_number'    then nullif(p_patch->>'employee_number','')    else p.employee_number end,
    first_name         = case when p_patch ? 'first_name'         then nullif(p_patch->>'first_name','')         else p.first_name end,
    middle_name        = case when p_patch ? 'middle_name'        then nullif(p_patch->>'middle_name','')        else p.middle_name end,
    last_name          = case when p_patch ? 'last_name'          then nullif(p_patch->>'last_name','')          else p.last_name end,
    preferred_name     = case when p_patch ? 'preferred_name'     then nullif(p_patch->>'preferred_name','')     else p.preferred_name end,
    pronouns           = case when p_patch ? 'pronouns'           then nullif(p_patch->>'pronouns','')           else p.pronouns end,
    work_email         = case when p_patch ? 'work_email'         then nullif(p_patch->>'work_email','')         else p.work_email end,
    work_phone         = case when p_patch ? 'work_phone'         then nullif(p_patch->>'work_phone','')         else p.work_phone end,
    mobile_phone       = case when p_patch ? 'mobile_phone'       then nullif(p_patch->>'mobile_phone','')       else p.mobile_phone end,
    job_title          = case when p_patch ? 'job_title'          then nullif(p_patch->>'job_title','')          else p.job_title end,
    employment_type    = case when p_patch ? 'employment_type'    then nullif(p_patch->>'employment_type','')    else p.employment_type end,
    employment_status  = case when p_patch ? 'employment_status'  then nullif(p_patch->>'employment_status','')  else p.employment_status end,
    hire_date          = case when p_patch ? 'hire_date'          then nullif(p_patch->>'hire_date','')::date    else p.hire_date end,
    end_date           = case when p_patch ? 'end_date'           then nullif(p_patch->>'end_date','')::date     else p.end_date end,
    org_unit_id        = case when p_patch ? 'org_unit_id'        then nullif(p_patch->>'org_unit_id','')::uuid  else p.org_unit_id end,
    reports_to_user_id = case when p_patch ? 'reports_to_user_id' then nullif(p_patch->>'reports_to_user_id','')::uuid else p.reports_to_user_id end,
    work_location      = case when p_patch ? 'work_location'      then nullif(p_patch->>'work_location','')      else p.work_location end,
    time_zone          = case when p_patch ? 'time_zone'          then nullif(p_patch->>'time_zone','')          else p.time_zone end,
    locale             = case when p_patch ? 'locale'             then nullif(p_patch->>'locale','')             else p.locale end,
    updated_at         = now()
  where p.user_id = p_user_id and p.tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'changed', array_length(v_applied, 1), 'fields', to_jsonb(v_applied));
end;
$$;

grant execute on function update_employee_profile(uuid, jsonb) to authenticated, service_role;

create or replace function update_employee_private(p_user_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
  v_ok     boolean;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  v_ok := (p_user_id = auth.uid()) or auth_has_tenant_role(array['tenant_owner','tenant_admin']);
  if not v_ok then
    raise exception 'not_allowed: personal details are visible to the person and to owners and admins only';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id and tenant_id = v_tenant) then
    raise exception 'no_such_employee_in_this_workspace';
  end if;

  insert into profile_private as pp (user_id, tenant_id) values (p_user_id, v_tenant)
  on conflict (user_id) do nothing;

  update profile_private pp set
    date_of_birth   = case when p_patch ? 'date_of_birth'   then nullif(p_patch->>'date_of_birth','')::date else pp.date_of_birth end,
    personal_email  = case when p_patch ? 'personal_email'  then nullif(p_patch->>'personal_email','')  else pp.personal_email end,
    personal_phone  = case when p_patch ? 'personal_phone'  then nullif(p_patch->>'personal_phone','')  else pp.personal_phone end,
    address_line1   = case when p_patch ? 'address_line1'   then nullif(p_patch->>'address_line1','')   else pp.address_line1 end,
    address_line2   = case when p_patch ? 'address_line2'   then nullif(p_patch->>'address_line2','')   else pp.address_line2 end,
    city            = case when p_patch ? 'city'            then nullif(p_patch->>'city','')            else pp.city end,
    state_region    = case when p_patch ? 'state_region'    then nullif(p_patch->>'state_region','')    else pp.state_region end,
    postal_code     = case when p_patch ? 'postal_code'     then nullif(p_patch->>'postal_code','')     else pp.postal_code end,
    country         = case when p_patch ? 'country'         then nullif(p_patch->>'country','')         else pp.country end,
    emergency_contact_name         = case when p_patch ? 'emergency_contact_name'         then nullif(p_patch->>'emergency_contact_name','')         else pp.emergency_contact_name end,
    emergency_contact_relationship = case when p_patch ? 'emergency_contact_relationship' then nullif(p_patch->>'emergency_contact_relationship','') else pp.emergency_contact_relationship end,
    emergency_contact_phone        = case when p_patch ? 'emergency_contact_phone'        then nullif(p_patch->>'emergency_contact_phone','')        else pp.emergency_contact_phone end,
    updated_at = now()
  where pp.user_id = p_user_id and pp.tenant_id = v_tenant;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function update_employee_private(uuid, jsonb) to authenticated, service_role;

create or replace function set_employee_compensation(
  p_user_id uuid, p_amount_cents bigint, p_currency text,
  p_pay_frequency text, p_effective_from date, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  -- Owners and admins only. Deliberately NOT self: being able to read your own
  -- pay is reasonable, being able to set it is not.
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'not_allowed: only an owner or admin may set pay';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id and tenant_id = v_tenant) then
    raise exception 'no_such_employee_in_this_workspace';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'amount must be zero or more';
  end if;

  -- Close the previous open record the day before this one starts, rather than
  -- overwriting it. What somebody used to be paid is the record you need when
  -- a pay question arrives, and it is gone forever if a raise is an UPDATE.
  update profile_compensation
     set effective_to = p_effective_from - 1
   where tenant_id = v_tenant and user_id = p_user_id and effective_to is null
     and effective_from < p_effective_from;

  insert into profile_compensation
    (user_id, tenant_id, amount_cents, currency, pay_frequency, effective_from, note, created_by)
  values
    (p_user_id, v_tenant, p_amount_cents, coalesce(nullif(p_currency,''), 'USD'),
     coalesce(nullif(p_pay_frequency,''), 'annual'), p_effective_from, nullif(btrim(p_note),''), auth.uid())
  returning id into v_id;

  -- Pay changes are the kind of thing that must be answerable later.
  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = auth.uid()), 'An administrator'),
    'human',
    format('Set pay for %s', coalesce((select full_name from profiles where user_id = p_user_id), 'an employee')),
    'access_control',
    jsonb_build_object('kind','compensation_set','subject_user_id',p_user_id,
                       'effective_from',p_effective_from,'record_id',v_id));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

grant execute on function set_employee_compensation(uuid, bigint, text, text, date, text) to authenticated, service_role;

-- ── Reading one record, with what was withheld named ───────────────────────

create or replace function get_employee_record(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := auth_tenant_id();
  v_self    boolean := (p_user_id = auth.uid());
  v_admin   boolean := auth_has_tenant_role(array['tenant_owner','tenant_admin']);
  v_profile jsonb;
  v_private jsonb;
  v_comp    jsonb;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;

  select to_jsonb(p) - 'id' into v_profile
  from profiles p where p.user_id = p_user_id and p.tenant_id = v_tenant;
  if v_profile is null then raise exception 'no_such_employee_in_this_workspace'; end if;

  if v_self or v_admin then
    select to_jsonb(pp) into v_private from profile_private pp
     where pp.user_id = p_user_id and pp.tenant_id = v_tenant;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.effective_from desc), '[]'::jsonb) into v_comp
      from profile_compensation c where c.user_id = p_user_id and c.tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'profile', v_profile,
    'private', v_private,
    'compensation', v_comp,
    -- Say what is missing and why. A blank section that might mean "no data"
    -- or might mean "not for you" is worse than either answer.
    'withheld', case when v_self or v_admin then '[]'::jsonb
                     else jsonb_build_array('private', 'compensation') end,
    'can_edit_job', auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']),
    'can_edit_private', (v_self or v_admin),
    'can_edit_pay', v_admin
  );
end;
$$;

grant execute on function get_employee_record(uuid) to authenticated, service_role;

-- ── The boundary this migration was most at risk of breaking ──────────────

do $assert$
declare v_cols text;
begin
  -- `authenticated` must still hold UPDATE on exactly the original three
  -- columns. If adding fields had widened this, every user would have gained
  -- write access to their own `role` — and `auth_has_tenant_role` reads it.
  select string_agg(column_name, ',' order by column_name) into v_cols
  from information_schema.column_privileges
  where table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'UPDATE';

  if coalesce(v_cols, '') <> 'avatar,full_name,last_seen_at' then
    raise exception 'PRIVILEGE BOUNDARY MOVED — authenticated can now update: %', v_cols;
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') then
    raise exception 'authenticated gained UPDATE on profiles.role — self-promotion is possible';
  end if;
end;
$assert$;

commit;
