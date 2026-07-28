-- 486_rename_decide_de_escalation.sql
-- ============================================================================
-- Migration 483 introduced resolve_de_escalation(p_task_id, ...) — but that
-- name was ALREADY TAKEN: resolve_de_escalation(p_tenant_id, p_de_id) has
-- existed for some time and returns a tenant's escalation thresholds
-- (frustration_threshold, always_escalate_topics). Different signatures, so
-- nothing broke — but one name now means two unrelated things, and the older
-- one is a READ while the new one DECIDES. That is exactly the ambiguity a
-- future caller resolves the wrong way.
--
-- Renamed to decide_de_escalation, which is also the truer verb: it records a
-- decision. Caught before any client wired to it, so there is no caller to
-- migrate — the UI work lands against the new name.
-- ============================================================================

create or replace function public.decide_de_escalation(
  p_task_id uuid,
  p_disposition text,
  p_instruction text default null,
  p_assign_role text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_task human_tasks;
  v_de_name text;
  v_instruction text;
  v_moved uuid;
begin
  -- mig 486: this is a sanctioned decision path (see guard_human_task_decision).
  perform set_config('app.allow_task_decision', 'on', true);

  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'insufficient_role';
  end if;
  if p_disposition not in ('answered','cancelled','rerouted') then
    raise exception 'disposition must be answered | cancelled | rerouted';
  end if;

  select * into v_task from human_tasks where id = p_task_id and tenant_id = v_tenant;
  if v_task.id is null then raise exception 'task_not_found'; end if;
  if v_task.status <> 'pending' then raise exception 'already_decided: %', v_task.status; end if;
  if v_task.de_id is not null and not can_access_de(v_task.de_id) then
    raise exception 'insufficient_scope';
  end if;

  v_instruction := nullif(btrim(coalesce(p_instruction, '')), '');
  if p_disposition = 'cancelled' and v_instruction is null then
    raise exception 'cancelling a blocker requires a reason';
  end if;

  update human_tasks set
    status = case when p_disposition = 'cancelled' then 'rejected'
                  when p_disposition = 'answered' then 'approved'
                  else status end,
    disposition = p_disposition,
    decision_note = coalesce(v_instruction, decision_note),
    assigned_role = coalesce(p_assign_role, assigned_role),
    decided_by = auth.uid(),
    decided_at = now()
  where id = p_task_id;

  if p_disposition = 'rerouted' then
    v_moved := resume_de_work_from_decision(p_task_id, 'rerouted', v_instruction);
  else
    select resolved_work_item_id into v_moved from human_tasks where id = p_task_id;
  end if;

  select name into v_de_name from digital_employees where id = v_task.de_id;
  perform append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s escalation %s — %s', coalesce(v_de_name, 'An employee'), p_disposition, left(v_task.title, 120)),
    'approval',
    jsonb_build_object('task_id', p_task_id, 'de_id', v_task.de_id,
      'disposition', p_disposition, 'instruction', v_instruction,
      'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null));

  return jsonb_build_object('ok', true, 'disposition', p_disposition,
    'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null);
end;
$function$;

revoke all on function public.decide_de_escalation(uuid, text, text, text) from public, anon;
grant execute on function public.decide_de_escalation(uuid, text, text, text) to authenticated;

-- Remove the colliding overload created in 483. Named by full signature so the
-- pre-existing resolve_de_escalation(uuid, uuid) is untouched.
drop function if exists public.resolve_de_escalation(uuid, text, text, text);

notify pgrst, 'reload schema';

do $a$
declare n int;
begin
  if to_regprocedure('public.decide_de_escalation(uuid,text,text,text)') is null then
    raise exception '486: decide_de_escalation was not created';
  end if;
  if to_regprocedure('public.resolve_de_escalation(uuid,text,text,text)') is not null then
    raise exception '486: the colliding overload still exists';
  end if;
  -- The pre-existing reader must survive untouched.
  if to_regprocedure('public.resolve_de_escalation(uuid,uuid)') is null then
    raise exception '486: the original resolve_de_escalation(uuid,uuid) was destroyed';
  end if;
  select count(*) into n from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
   where nsp.nspname = 'public' and p.proname = 'resolve_de_escalation';
  if n <> 1 then raise exception '486: expected exactly 1 resolve_de_escalation, found %', n; end if;
  raise notice '486: renamed to decide_de_escalation; the pre-existing threshold reader is intact';
end $a$;
