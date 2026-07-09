-- Migration 113: create_digital_employee never set owner_id.
--
-- Found during a pre-onboarding go-live audit (2026-07-09), triggered
-- by the founder asking "will every NEW tenant actually see this
-- working." Migration 110 added owner_id and backfilled every
-- EXISTING digital_employees row from created_by — but never touched
-- create_digital_employee's own INSERT, so every DE created since
-- Wave 2 shipped (in ANY tenant, not just the test tenant) has been
-- silently getting owner_id = NULL. Docs §13.6: "Every Digital
-- Employee has a defined owner" — that was only true for DEs that
-- existed before migration 110, not for anything created after it.
-- Same signature, so a plain create-or-replace is correct (no drop
-- needed, no overload risk).
-- ============================================================
create or replace function create_digital_employee(
  p_name text, p_description text default '', p_category text default 'Customer',
  p_department text default '', p_persona_name text default null,
  p_trust_level text default 'supervised', p_confidence_threshold integer default 75,
  p_required_approval boolean default false
) returns digital_employees
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role   text;
  v_is_active boolean;
  v_user   uuid := auth.uid();
  v_row    digital_employees;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then
      raise exception 'not a member of any tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can create a new Digital Employee';
    end if;
  else
    raise exception 'service-role callers must pass a tenant explicitly — use the seed do-block pattern for migration-time creation';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'a Digital Employee needs a name';
  end if;
  if p_trust_level not in ('supervised', 'established', 'trusted', 'autonomous') then
    raise exception 'trust_level must be one of: supervised, established, trusted, autonomous';
  end if;
  if p_confidence_threshold < 0 or p_confidence_threshold > 100 then
    raise exception 'confidence_threshold must be between 0 and 100';
  end if;

  insert into digital_employees (
    tenant_id, name, persona_name, description, category, department,
    status, lifecycle_status, trust_level, confidence_threshold, required_approval, created_by, owner_id
  ) values (
    v_tenant, trim(p_name), nullif(trim(coalesce(p_persona_name, '')), ''), coalesce(p_description, ''),
    coalesce(p_category, 'Customer'), coalesce(p_department, ''),
    'active', 'designed', p_trust_level, p_confidence_threshold, coalesce(p_required_approval, false), v_user, v_user
  )
  returning * into v_row;

  perform append_audit_event(
    v_tenant, coalesce((select full_name from profiles where user_id = v_user), 'you'), 'human',
    format('New Digital Employee created — %s%s (%s / %s)', v_row.name,
      case when v_row.persona_name is not null then format(' ("%s")', v_row.persona_name) else '' end,
      v_row.category, coalesce(nullif(v_row.department, ''), 'unassigned department')),
    'config_change',
    jsonb_build_object('kind', 'digital_employee_created', 'de_id', v_row.id, 'name', v_row.name,
      'persona_name', v_row.persona_name, 'category', v_row.category, 'department', v_row.department,
      'trust_level', v_row.trust_level, 'created_by', v_user)
  );

  return v_row;
end;
$function$;

-- Grants unchanged (same signature) — re-affirmed defensively rather
-- than assumed, matching this session's grant-hygiene discipline.
revoke all on function create_digital_employee(text, text, text, text, text, text, integer, boolean) from public;
revoke all on function create_digital_employee(text, text, text, text, text, text, integer, boolean) from anon;
grant execute on function create_digital_employee(text, text, text, text, text, text, integer, boolean) to authenticated, service_role;
