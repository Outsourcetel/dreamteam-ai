-- 504_reroute_a_blocker.sql
-- ============================================================================
-- The third disposition from founder decision N4, built rather than deferred.
--
-- Answer and cancel-with-reason have worked since mig 483. Reroute had no
-- mechanism: the nearest thing, request_de_task, enforces a single-hop
-- delegation GRANT between two employees — which is the right model for a DE
-- handing work to a colleague, and the wrong one for a PERSON deciding the work
-- belongs elsewhere. request_de_task already has a human path for exactly that
-- (p_from_de_id NULL), so no grant is required and none is invented.
--
-- SEMANTICS, chosen so nothing is stranded or silently lost:
--   * the target employee receives a real task carrying the blocker's context
--   * the original step is CANCELLED with a reason naming where it went — it is
--     not left waiting, because nobody is coming back to it
--   * its dependants have depends_on CLEARED rather than being cascade-
--     cancelled. This is the mig-493 lesson: claim_de_work_items only claims an
--     item whose predecessor is 'done', so a cancelled parent would make every
--     descendant permanently unclaimable. The work moved; it was not abandoned.
--   * the decision is recorded as disposition 'rerouted' with the destination
--
-- Authority follows assignment (mig 503): the caller must be able to reach BOTH
-- employees — the one being unblocked and the one receiving the work. Rerouting
-- to an employee you cannot see would be a way to move work out of view.
-- ============================================================================

create or replace function public.reroute_de_escalation(
  p_task_id uuid,
  p_to_de_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_task human_tasks;
  v_item de_work_items;
  v_note text;
  v_to_name text;
  v_from_name text;
  v_req jsonb;
  n_freed int := 0;
begin
  -- mig 487: this is a sanctioned decision path.
  perform set_config('app.allow_task_decision', 'on', true);

  if v_tenant is null then raise exception 'not_authenticated'; end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then
    raise exception 'rerouting a blocker requires a reason — say why it belongs elsewhere';
  end if;

  select * into v_task from human_tasks where id = p_task_id and tenant_id = v_tenant;
  if v_task.id is null then raise exception 'task_not_found'; end if;
  if v_task.status <> 'pending' then raise exception 'already_decided: %', v_task.status; end if;
  if v_task.de_id is not null and not can_access_de(v_task.de_id) then
    raise exception 'insufficient_scope';
  end if;
  -- You may not move work to an employee you cannot see.
  if not can_access_de(p_to_de_id) then
    raise exception 'insufficient_scope_target';
  end if;
  if v_task.de_id is not distinct from p_to_de_id then
    raise exception 'already_owned_by_that_employee';
  end if;

  select coalesce(persona_name, name) into v_to_name from digital_employees
   where id = p_to_de_id and tenant_id = v_tenant;
  if v_to_name is null then raise exception 'target_not_found'; end if;
  select coalesce(persona_name, name) into v_from_name from digital_employees where id = v_task.de_id;

  if v_task.related_table = 'de_work_items' and v_task.related_id is not null then
    select * into v_item from de_work_items where id = v_task.related_id and tenant_id = v_tenant;
  end if;

  -- Hand the work over. The HUMAN path of request_de_task (from_de NULL) — a
  -- person reassigning does not need a DE-to-DE delegation grant.
  v_req := request_de_task(
    null, p_to_de_id,
    left(coalesce(v_item.title, v_task.title, 'Rerouted work'), 200),
    left(format('Rerouted from %s by a person. Reason: %s%s',
      coalesce(v_from_name, 'another employee'), v_note,
      case when coalesce(v_task.detail, '') <> ''
           then E'\n\nWhat the employee reported:\n' || left(v_task.detail, 2000) else '' end), 4000),
    null, 'normal', null,
    'de_work_items', v_item.id);

  if coalesce((v_req->>'ok')::boolean, false) is not true then
    raise exception 'reroute_failed: %', coalesce(v_req->>'error', 'unknown');
  end if;

  -- Close the original step, and free whatever was queued behind it.
  if v_item.id is not null then
    update de_work_items set
      status = 'cancelled', locked_at = null, locked_by = null, updated_at = now(),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
        'summary', left(format('Rerouted to %s: %s', v_to_name, v_note), 500),
        'rerouted', jsonb_build_object('task_id', p_task_id, 'to_de_id', p_to_de_id,
          'to_name', v_to_name, 'note', v_note, 'at', now()))
    where id = v_item.id and status in ('waiting_human', 'queued');

    -- NOT a cascade-cancel. The work moved; its dependants must stay runnable
    -- once the new owner delivers (mig 493's stranding lesson).
    with freed as (
      update de_work_items c set depends_on = null, updated_at = now()
       where c.depends_on = v_item.id and c.status in ('queued', 'waiting_human')
      returning c.id
    )
    select count(*) into n_freed from freed;
  end if;

  update human_tasks set
    status = 'rejected',
    disposition = 'rerouted',
    decision_note = v_note,
    decided_by = auth.uid(),
    decided_at = now()
  where id = p_task_id;

  update de_exceptions set
    status = 'denied', outcome = format('Rerouted to %s: %s', v_to_name, v_note), decided_at = now()
  where human_task_id = p_task_id and status = 'proposed';

  perform append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('Blocker rerouted from %s to %s — %s',
      coalesce(v_from_name, 'an employee'), v_to_name, left(v_task.title, 100)),
    'approval',
    jsonb_build_object('task_id', p_task_id, 'from_de_id', v_task.de_id, 'to_de_id', p_to_de_id,
      'work_item_id', v_item.id, 'dependants_freed', n_freed, 'note', v_note,
      'delegation_request', v_req));

  return jsonb_build_object('ok', true, 'disposition', 'rerouted',
    'to_de_id', p_to_de_id, 'to_name', v_to_name,
    'work_item_id', v_item.id, 'dependants_freed', n_freed);
end;
$function$;

revoke all on function public.reroute_de_escalation(uuid, uuid, text) from public, anon;
grant execute on function public.reroute_de_escalation(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';

do $a$
declare v_def text;
begin
  if to_regprocedure('public.reroute_de_escalation(uuid,uuid,text)') is null then
    raise exception '504: reroute was not created';
  end if;
  v_def := pg_get_functiondef('public.reroute_de_escalation(uuid,uuid,text)'::regprocedure);
  -- It must use the human delegation path, not invent a grant.
  if v_def not ilike '%request_de_task%' then
    raise exception '504: reroute does not hand the work anywhere';
  end if;
  -- Both scope checks must be present — moving work to an employee you cannot
  -- see would be a way to move it out of view.
  if (select count(*) from regexp_matches(v_def, 'can_access_de', 'g')) < 2 then
    raise exception '504: reroute does not check BOTH employees';
  end if;
  -- It must free dependants rather than cascade-cancelling them.
  if v_def not ilike '%depends_on = null%' then
    raise exception '504: dependants would be stranded behind the rerouted step';
  end if;
  -- And it must be a sanctioned decision path or the mig-487 guard blocks it.
  if v_def not ilike '%app.allow_task_decision%' then
    raise exception '504: reroute is not a sanctioned decision path — the ledger guard will reject it';
  end if;
  raise notice '504: reroute available — work moves, dependants stay runnable, both employees scope-checked';
end $a$;
