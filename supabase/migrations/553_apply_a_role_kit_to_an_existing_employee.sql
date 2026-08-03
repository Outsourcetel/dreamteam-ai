-- 553: give an employee that already exists a role template.
--
-- Migration 552 made all twelve role kits installable, but install_role_kit is
-- only ever called from the hire path. Every employee hired before that — which
-- is every employee in fourteen of the fifteen workspaces — still has no Book
-- of Work, no SOP and no role guardrails, and the only way to get them was to
-- hire a replacement. That is not a real option for an employee that already
-- holds work.
--
-- This is one RPC rather than three calls from the browser, so the whole thing
-- is atomic, authorised once, and leaves a single audit record. It reuses
-- install_role_kit and install_role_systems exactly as the hire path does —
-- no second install engine.
--
-- RE-ROLING IS DELIBERATELY AWKWARD. Handing an Accounting employee the
-- Renewal Manager template changes what it watches and what it is allowed to
-- do, so an employee that already carries an archetype is refused unless the
-- caller explicitly passes p_allow_rerole. Adding a kit to an employee that
-- has none is the ordinary case and needs no flag.
begin;

create or replace function public.apply_role_kit_to_employee(
  p_de_id uuid,
  p_archetype_key text,
  p_allow_rerole boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_tenant  uuid;
  v_name    text;
  v_current text;
  v_arch    role_archetypes;
  v_kit     jsonb;
  v_systems int := 0;
begin
  select d.tenant_id, coalesce(nullif(d.persona_name, ''), d.name), d.archetype_key
    into v_tenant, v_name, v_current
    from digital_employees d
   where d.id = p_de_id and d.lifecycle_status <> 'retired';
  if v_tenant is null then
    raise exception 'employee not found, or retired';
  end if;

  -- A human action, so a real signed-in person is required — never the
  -- anonymous or service path.
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not exists (
      select 1 from profiles p
       where p.user_id = auth.uid()
         and (p.layer = 'platform'
              or (p.tenant_id = v_tenant
                  and p.role in ('tenant_owner', 'tenant_admin', 'tenant_manager')))) then
    raise exception 'not authorized to configure this employee';
  end if;

  -- A dormant workspace does not get new work-generating configuration.
  if not public.tenant_is_operational(v_tenant) then
    raise exception 'this workspace is suspended';
  end if;

  select * into v_arch from role_archetypes
   where key = p_archetype_key and status = 'active';
  if v_arch.key is null then raise exception 'unknown role template %', p_archetype_key; end if;

  if v_current is not null and v_current <> p_archetype_key and not coalesce(p_allow_rerole, false) then
    raise exception 'already_has_role: this employee is a % — re-roling changes what it watches and what it may do, so it must be confirmed', v_current;
  end if;

  -- Watchers + SOP + role guardrails (mig 552 made every template installable).
  v_kit := public.install_role_kit(p_de_id, p_archetype_key);

  -- Connected systems are additive; a failure here never costs the kit, which
  -- is how the hire path treats it too.
  begin
    v_systems := coalesce(public.install_role_systems(p_de_id, p_archetype_key), 0);
  exception when others then
    v_systems := 0;
  end;

  -- Record the role on the employee so role-scoped features (team missions,
  -- role-scoped improvements, the right certification exam) resolve.
  update digital_employees
     set archetype_key = p_archetype_key, updated_at = now()
   where id = p_de_id and archetype_key is distinct from p_archetype_key;

  perform append_audit_event(
    v_tenant, 'You', 'human',
    format('Applied the %s role template to %s — %s watcher(s), %s role guardrail(s), %s connected system(s)%s',
      v_arch.name, v_name,
      coalesce(v_kit->>'watchers_created', '0'),
      coalesce(v_kit->>'guardrails_created', '0'), v_systems,
      case when coalesce((v_kit->>'watchers_skipped')::int, 0) > 0
           then format(', %s watcher template(s) skipped', v_kit->>'watchers_skipped') else '' end),
    'config_change',
    jsonb_build_object('kind', 'role_kit_applied', 'de_id', p_de_id,
      'archetype_key', p_archetype_key, 'previous_archetype', v_current,
      'rerole', (v_current is not null and v_current <> p_archetype_key),
      'kit', v_kit, 'systems_installed', v_systems));

  return v_kit || jsonb_build_object(
    'systems_installed', v_systems,
    'previous_archetype', v_current,
    'archetype_name', v_arch.name,
    'employee', v_name);
end $fn$;

revoke all on function public.apply_role_kit_to_employee(uuid, text, boolean) from public, anon;
grant execute on function public.apply_role_kit_to_employee(uuid, text, boolean) to authenticated, service_role;

do $do$
declare v_t uuid; v_de uuid; v_n int;
begin
  -- It must exist and be reachable by a signed-in member, not by anon.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'apply_role_kit_to_employee') then
    raise exception '553: function was not created';
  end if;
  if has_function_privilege('anon', 'public.apply_role_kit_to_employee(uuid, text, boolean)', 'execute') then
    raise exception '553: anon can execute the role-kit RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.apply_role_kit_to_employee(uuid, text, boolean)', 'execute') then
    raise exception '553: signed-in members cannot execute the role-kit RPC';
  end if;

  -- NEGATIVE: with no JWT (this migration has none) it must refuse rather than
  -- quietly configure an employee on nobody's authority.
  select id into v_t from tenants where name = 'Harbor Peak Consulting';
  select id into v_de from digital_employees
   where tenant_id = v_t and not is_specialist and lifecycle_status <> 'retired'
   order by created_at limit 1;
  begin
    perform public.apply_role_kit_to_employee(v_de, 'renewal_manager');
    raise exception '553: the RPC ran without an authenticated caller';
  exception when others then
    if sqlerrm <> 'not_authenticated' then
      raise exception '553: expected not_authenticated, got: %', sqlerrm;
    end if;
  end;

  raise notice '553: apply_role_kit_to_employee installed; refuses an unauthenticated caller';
end $do$;

commit;
