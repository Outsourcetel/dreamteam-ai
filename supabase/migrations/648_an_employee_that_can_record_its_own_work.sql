-- 648_an_employee_that_can_record_its_own_work.sql
-- ============================================================================
-- update_onboarding_item requires `auth.uid()` to be an active member of the
-- tenant. A digital employee has no uid, so it could do the setup work and then
-- be unable to record that it had. The checklist could only ever be ticked by a
-- person clicking — which makes the employee a recommendation engine with extra
-- steps, not a worker.
--
-- This adds the runtime path. It is the SAME function with the SAME guards, and
-- deliberately not a relaxation of them:
--   · project must be active
--   · the item must exist in the template AND in the project's state
--   · an item already signed off is terminal and cannot be touched
--   · an item marked done that `requires_signoff` STILL raises the review_gate
--     human task, exactly as before — the employee can finish the work, only a
--     person can sign it off
--   · and one guard the human path does not need: 'signed_off' is REFUSED as a
--     status outright. There is no argument an employee can pass that signs off
--     its own work.
--
-- WHO IT RECORDS. The human path writes the activity as actor 'You', type
-- 'human'. That would be a lie here and would corrupt the one ledger that says
-- who did what, so this writes the employee's name and actor_type 'de'. An
-- audit trail that cannot distinguish a person from an employee is worse than
-- none, because it reads as though a person checked.
--
-- SERVICE-ROLE ONLY. Not because employees are trusted more than users, but
-- because this is a runtime path with no browser session to authorise it. The
-- DE is verified to belong to the project's tenant on every call — passing
-- another tenant's de_id resolves to nothing and is refused.
-- ============================================================================

begin;

create or replace function public.update_onboarding_item_as_de(
  p_project_id uuid,
  p_de_id      uuid,
  p_key        text,
  p_status     text default null,
  p_note       text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_old       text;
  v_task_id   uuid;
  v_acct_name text;
  v_de_name   text;
  v_signoff   boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'update_onboarding_item_as_de is a runtime path; a person uses update_onboarding_item';
  end if;

  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;

  -- The employee must belong to THIS project's workspace. A de_id from another
  -- tenant resolves to nothing here — the same shape as the cross-tenant write
  -- holes mig 636 closed, refused before it can be exploited.
  select coalesce(persona_name, name) into v_de_name
    from digital_employees where id = p_de_id and tenant_id = v_proj.tenant_id;
  if v_de_name is null then
    return jsonb_build_object('error', 'employee_not_in_this_workspace');
  end if;

  if v_proj.status <> 'active' then
    return jsonb_build_object('error', 'project_not_active');
  end if;

  -- No employee signs off its own work. Ever.
  if p_status = 'signed_off' then
    return jsonb_build_object('error', 'signoff_is_a_human_decision');
  end if;
  if p_status is not null and p_status not in ('pending', 'in_progress', 'done', 'blocked') then
    return jsonb_build_object('error', 'bad_status');
  end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  if not found then return jsonb_build_object('error', 'template_version_not_found'); end if;

  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = p_key limit 1;
  if v_def is null then return jsonb_build_object('error', 'item_not_found'); end if;
  v_signoff := coalesce((v_def->>'requires_signoff')::boolean, false);

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'key' = p_key then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_state_missing'); end if;
  v_old := v_item->>'status';

  if v_old = 'signed_off' then
    return jsonb_build_object('error', 'item_already_signed_off');
  end if;

  if p_note is not null then
    v_item := v_item || jsonb_build_object('note', p_note);
  end if;
  -- Who did it, on the item itself — not just in the activity feed.
  v_item := v_item || jsonb_build_object('last_actor_de', p_de_id, 'last_actor_name', v_de_name);

  if p_status is not null and p_status <> v_old then
    v_item := v_item || jsonb_build_object('status', p_status);
    if p_status = 'done' then
      v_item := v_item || jsonb_build_object('done_at', now());
      if v_signoff then
        insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
        values (v_proj.tenant_id, 'review_gate',
                format('Onboarding sign-off — %s · %s', v_def->>'label', v_proj.name),
                format('%s marked "%s" done. It needs a human sign-off before the project can complete.',
                       v_de_name, v_def->>'label'),
                'de', 'onboarding_projects', p_project_id)
        returning id into v_task_id;
        v_item := v_item || jsonb_build_object('signoff_task_id', v_task_id);
      end if;
    end if;

    select name into v_acct_name from customer_accounts where id = v_proj.account_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_proj.tenant_id, v_proj.account_id, v_de_name, 'de',
            case when p_status = 'blocked' then 'escalated' else 'config_change' end,
            format('Onboarding — %s: %s → %s%s (%s)', v_def->>'label', v_old, p_status,
                   case when v_task_id is not null then ' · awaiting sign-off' else '' end,
                   coalesce(v_acct_name, v_proj.name)));
  end if;

  update onboarding_projects
     set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
   where id = p_project_id;

  -- A non-signoff item completing the project is the human function's rule and
  -- stays the human function's rule: an employee must not be able to drive a
  -- project to completed as a side effect of ticking the last box.
  return jsonb_build_object(
    'ok', true, 'item', p_key, 'status', coalesce(p_status, v_old),
    'signoff_task_id', v_task_id, 'recorded_by', v_de_name);
end;
$function$;

-- Supabase grants anon/authenticated as NAMED ROLES; `revoke from public` alone
-- leaves them (security_default_execute_grant).
revoke all on function public.update_onboarding_item_as_de(uuid, uuid, text, text, text)
  from public, anon, authenticated;

-- ── Prove the guards, including the ones that must REFUSE. ────────────────
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.update_onboarding_item_as_de(uuid,uuid,text,text,text)'::regprocedure);
  if v_def not ilike '%signoff_is_a_human_decision%' then
    raise exception '648: an employee could sign off its own work';
  end if;
  if v_def not ilike '%item_already_signed_off%' then
    raise exception '648: a signed-off item is no longer terminal';
  end if;
  if v_def not ilike '%requires_signoff%' or v_def not ilike '%review_gate%' then
    raise exception '648: the sign-off gate was dropped from the runtime path';
  end if;
  if v_def not ilike '%employee_not_in_this_workspace%' then
    raise exception '648: the cross-tenant check is missing';
  end if;
  if v_def not ilike '%''de''%' then
    raise exception '648: the activity would be recorded as if a person did it';
  end if;

  if has_function_privilege('anon', 'public.update_onboarding_item_as_de(uuid,uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.update_onboarding_item_as_de(uuid,uuid,text,text,text)', 'EXECUTE') then
    raise exception '648: the runtime path is reachable from the internet';
  end if;

  raise notice '648: runtime tick path installed; sign-off still human, cross-tenant refused, anon/authenticated revoked';
end $$;

commit;
