-- 725_a_person_can_edit_their_own_name.sql
-- ============================================================================
-- The founder signed up, opened My Profile, and every box was empty — including
-- the one field we already knew. `profiles.full_name` said "Derek McIntyre" the
-- whole time; the sidebar, the people picker and the support inbox were all
-- reading it. The profile form was the only surface in the product that neither
-- showed that name nor let anyone change it.
--
-- ── Measured before writing a line (prod, 2026-08-12) ─────────────────────
--   select count(*), count(full_name), count(first_name),
--          count(job_title), count(work_email) from public.profiles;
--     total 23 · full_name 21 · first_name 8 · job_title 0 · work_email 21
--
-- Twenty-one of twenty-three rows carry a full_name, because signup collects
-- it. ZERO carry a job_title, because nothing on any path ever asks. The form
-- led with first_name and last_name — two fields no code path populates — and
-- omitted the one field that actually carries a person's identity here. This
-- migration makes that field editable; the screen change puts it first.
--
-- ── Why BOTH allow-lists, and why that is not scope creep ────────────────
-- The obvious change is "add full_name to the self-editable set". On its own
-- that would have shipped a fix the complainant could not use, because the
-- gate is an EITHER/OR, not a union:
--
--     v_allowed := case when v_is_hr then v_hr_ok else v_self_ok end;
--
-- v_is_hr is true for tenant_owner. The founder editing his OWN name takes the
-- HR branch and never reads v_self_ok at all. Adding the field to v_self_ok
-- alone leaves `field_not_editable: full_name` on exactly the account that
-- reported the bug — a fix that looks right in the diff and changes nothing on
-- the screen. So full_name joins both lists: the self list so an ordinary
-- employee may correct their own name, the HR list so an owner or admin may
-- too, which they can already do for first_name and last_name either way.
--
-- ⚠ THE SET CLAUSE IS HALF THE CHANGE. An allow-list entry with no matching
-- column assignment is the worst outcome available: the write passes every
-- check, returns ok=true with changed=1 and a `fields` array naming full_name,
-- and stores nothing. The screen would report success on a save that never
-- happened — the same shape as F-6 one migration ago. Both halves, or neither.
--
-- ⚠ NOT a permissions bug and NOT a backfill. update_employee_profile is
-- SECURITY DEFINER, so the narrow `authenticated` column grant on profiles was
-- never what blocked this; the allow-list was. And nothing here writes data:
-- work_email is still empty on both real self-signups, and that is fixed by
-- OFFERING the sign-in address in the form, not by inventing rows.
--
-- Everything else in this function is reproduced byte-for-byte from the live
-- definition (pg_get_functiondef, read 2026-08-12 before editing).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_employee_profile(p_user_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := auth_tenant_id();
  v_is_hr   boolean := auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']);
  v_is_self boolean := (p_user_id = auth.uid());
  v_key     text;
  -- What the person may change about themselves: their name, how to reach them
  -- and how they are addressed. Not their job, their manager or their start
  -- date. full_name is here because a person owning what they are CALLED is
  -- the least controversial edit in the product, and because it is the only
  -- name field signup ever fills in.
  v_self_ok text[] := array['full_name','preferred_name','pronouns','work_phone','mobile_phone','time_zone','locale'];
  v_hr_ok   text[] := array['employee_number','full_name','first_name','middle_name','last_name','preferred_name',
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
    full_name          = case when p_patch ? 'full_name'          then nullif(p_patch->>'full_name','')          else p.full_name end,
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
$function$;

-- The default EXECUTE grant is the standing trap in this repo: a fresh
-- CREATE OR REPLACE hands EXECUTE to PUBLIC unless it is taken back. Restated
-- here so this file is safe to replay on its own.
REVOKE ALL ON FUNCTION public.update_employee_profile(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_employee_profile(uuid, jsonb) TO authenticated;
