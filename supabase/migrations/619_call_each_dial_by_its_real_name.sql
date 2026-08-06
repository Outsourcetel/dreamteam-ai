-- 619 — call each dial by its real name.
--
-- 618's derive_de_autonomy_dials built its labels with
-- initcap(replace(key,'_',' ')), which produces "Crm actions",
-- "Erp Financials actions", "Payroll Hcm actions" and "Pos actions".
--
-- `system_categories` already holds the display name for every key — the same
-- table `de_autonomy.source_category` has a foreign key to — and it says CRM,
-- ERP Financials, Payroll & HCM, POS. Mangling a key into a label when the
-- product already has a vocabulary is how two names for one thing appear.
-- Also carries the description through, so a dial can explain what it governs
-- without the UI inventing its own copy.

begin;

-- Adding `description` changes the OUT row type, and Postgres refuses to
-- CREATE OR REPLACE across that ("cannot change return type of existing
-- function"). Safe to drop: this function was created minutes ago in 618 and
-- has no caller yet — asserted below rather than assumed.
do $guard$
declare v_callers int;
begin
  select count(*) into v_callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.proname <> 'derive_de_autonomy_dials'
    and pg_get_functiondef(p.oid) ~ 'derive_de_autonomy_dials';
  if v_callers > 0 then
    raise exception '% function(s) already call derive_de_autonomy_dials — dropping would break them', v_callers;
  end if;
end;
$guard$;

drop function if exists derive_de_autonomy_dials(uuid);

create or replace function derive_de_autonomy_dials(p_de_id uuid)
returns table(action_type text, source_category text, label text, description text,
              configured boolean, enabled boolean,
              max_amount_cents bigint, min_confidence integer)
language sql stable security definer set search_path = public as $$
  with de as (
    select d.id, d.tenant_id from digital_employees d
    where d.id = p_de_id and d.tenant_id = auth_tenant_id()
  ),
  cats as (
    select distinct g.resource_category as cat
    from data_access_grants g join de on g.subject_id = de.id
    where g.subject_kind = 'de' and g.resource_category is not null
  )
  select
    ('action:' || c.cat)::text                         as action_type,
    c.cat::text                                        as source_category,
    (coalesce(sc.label, c.cat) || ' actions')::text    as label,
    sc.description                                     as description,
    (a.id is not null)                                 as configured,
    coalesce(a.enabled, false)                         as enabled,
    a.max_amount_cents,
    a.min_confidence
  from cats c
  cross join de
  left join system_categories sc on sc.key = c.cat
  left join de_autonomy a
    on a.tenant_id = de.tenant_id and a.de_id = de.id
   and a.action_type = 'action:' || c.cat
   and a.playbook_id is null
  order by coalesce(sc.label, c.cat);
$$;

revoke execute on function derive_de_autonomy_dials(uuid) from public;
grant execute on function derive_de_autonomy_dials(uuid) to authenticated, service_role;

do $verify$
declare
  v_t   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_uid uuid;
  v_de  uuid;
  v_bad int;
  v_n   int;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;
  select user_id into v_uid from profiles where tenant_id = v_t and role = 'tenant_owner' limit 1;
  select id into v_de from digital_employees where tenant_id = v_t and name = 'Finance DE' limit 1;
  if v_uid is null or v_de is null then raise notice 'nothing to verify against'; return; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select count(*) into v_n from derive_de_autonomy_dials(v_de);
  if v_n = 0 then raise exception 'the widest employee derived no dials at all'; end if;

  -- The mangled forms must be gone.
  select count(*) into v_bad from derive_de_autonomy_dials(v_de)
  where label in ('Crm actions', 'Erp Financials actions', 'Payroll Hcm actions', 'Pos actions');
  if v_bad > 0 then raise exception '% dial(s) still carry a mangled label', v_bad; end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'the widest employee derives % dial(s), all named from system_categories', v_n;
end;
$verify$;

commit;
