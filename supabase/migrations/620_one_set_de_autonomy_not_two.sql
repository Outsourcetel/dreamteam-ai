-- 620 — one set_de_autonomy, not two.
--
-- ⚠⚠ I BROKE THE AUTONOMY WRITER IN 618 AND THIS FIXES IT.
--
-- 618 added `p_playbook_id uuid default null` to set_de_autonomy with CREATE OR
-- REPLACE. A different argument list does not REPLACE — it OVERLOADS. So the
-- database ended up holding both:
--
--   set_de_autonomy(text,boolean,bigint,integer,uuid,text)        -> de_autonomy
--   set_de_autonomy(text,boolean,bigint,integer,uuid,text,uuid)   -> jsonb
--
-- and because the seventh argument has a default, an existing six-argument call
-- matches BOTH:
--
--   ERROR: function set_de_autonomy(...) is not unique
--   HINT:  Could not choose a best candidate function.
--
-- Every current caller passes exactly those six named parameters
-- (WorkforceTrustDefaults, LiveWorkforceDEs via setAutonomyDial), so from 618
-- until now, changing any trust dial in the app would have failed outright.
--
-- This is precisely the defect the first duplicate audit found in
-- `search_knowledge` — two arities, overlapping because of defaults, PostgREST
-- unable to choose. Found here by TESTING a six-argument call rather than
-- reading the migration back.
--
-- Two further things 618 got wrong, fixed here:
--
--   · it returned jsonb, but the client does `data as DEAutonomy` and reads
--     row.enabled / row.max_amount_cents to write its audit line — both would
--     have been undefined, so every audit entry would have read "disabled".
--     Returns the ROW again, as the original did.
--   · the old six-arg version is DROPPED rather than left beside the new one.

begin;

-- Order matters: drop the ambiguous pair, then create exactly one.
drop function if exists set_de_autonomy(text, boolean, bigint, integer, uuid, text);
drop function if exists set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid);

create function set_de_autonomy(
  p_action_type text, p_enabled boolean, p_max_amount_cents bigint,
  p_min_confidence integer, p_de_id uuid, p_source_category text,
  p_playbook_id uuid default null
) returns de_autonomy
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
  v_row    de_autonomy;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may change what an employee may do on its own';
  end if;
  -- ⚠ An employee is REQUIRED. A NULL de_id used to mean "workspace default,
  -- applies to everybody", which migration 618 removed.
  if p_de_id is null then
    raise exception 'a rule must name the employee it governs — workspace-wide defaults were removed in migration 618';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    raise exception 'that employee is not in this workspace';
  end if;
  if p_playbook_id is not null
     and not exists (select 1 from playbook_definitions where id = p_playbook_id and tenant_id = v_tenant) then
    raise exception 'that playbook is not in this workspace';
  end if;

  insert into de_autonomy (tenant_id, action_type, enabled, max_amount_cents, min_confidence,
                           de_id, source_category, playbook_id, updated_by, updated_at)
  values (v_tenant, p_action_type, coalesce(p_enabled, false), p_max_amount_cents, p_min_confidence,
          p_de_id, nullif(btrim(p_source_category), ''), p_playbook_id, auth.uid(), now())
  on conflict (tenant_id, action_type,
               coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(source_category, ''))
  do update set enabled = excluded.enabled,
                max_amount_cents = excluded.max_amount_cents,
                min_confidence = excluded.min_confidence,
                updated_by = excluded.updated_by,
                updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid) from public;
grant execute on function set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid) to authenticated, service_role;

-- ── Prove there is exactly one, and that a six-argument call resolves ────
do $verify$
declare
  v_n    int;
  v_t    uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_uid  uuid;
  v_de   uuid;
  v_row  de_autonomy;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_de_autonomy';
  if v_n <> 1 then
    raise exception '% overloads of set_de_autonomy exist — the ambiguity is still there', v_n;
  end if;

  if v_t is null then raise notice 'no workspace to verify against'; return; end if;
  select user_id into v_uid from profiles where tenant_id = v_t and role = 'tenant_owner' limit 1;
  select id into v_de from digital_employees where tenant_id = v_t and status = 'active' order by created_at limit 1;
  if v_uid is null or v_de is null then raise notice 'nothing to verify against'; return; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- THE call the app makes: six named parameters, no playbook. This is what
  -- errored with "is not unique" before the drop.
  select * into v_row from set_de_autonomy(
    p_action_type => 'action:__probe620__', p_enabled => true,
    p_max_amount_cents => 2500, p_min_confidence => null,
    p_de_id => v_de, p_source_category => 'billing');

  if v_row.id is null then raise exception 'the six-argument call returned no row'; end if;
  if v_row.enabled is not true or v_row.max_amount_cents <> 2500 then
    raise exception 'the returned ROW is wrong (enabled=%, amount=%) — the client reads these for its audit line',
      v_row.enabled, v_row.max_amount_cents;
  end if;

  -- And a workspace-wide write must still be refused.
  begin
    perform set_de_autonomy('action:__probe620__', true, 1, null, null, 'billing');
    raise exception 'a workspace-wide rule was accepted';
  exception when others then
    if sqlerrm like '%a workspace-wide rule was accepted%' then raise; end if;
  end;

  delete from de_autonomy where action_type = 'action:__probe620__';
  perform set_config('request.jwt.claims', null, true);

  raise notice 'one set_de_autonomy, the app''s six-argument call resolves and returns its row';
end;
$verify$;

commit;
