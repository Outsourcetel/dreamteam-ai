-- 577 — a message left on the phone must actually reach a human.
--
-- THE BUG, in the DE's own words. When a caller asks for a callback,
-- voice-webhook writes a voice_messages row and hands the model this line:
--
--     "Message recorded for the team. Tell the caller it has been passed on."
--
-- The Digital Employee then says that to a real person. Nothing was passed on.
-- No task was created, no one was notified, and NOTHING anywhere reads the
-- voice_messages table — verified by grep across the app, the edge functions
-- and the migrations: the only other mention is a comment. Both live test
-- calls ended with the caller asking for a callback, so a front-desk pilot
-- would have lost every message while promising every caller it got through.
--
-- This is the written-never-read pattern from the Employee File truth audit
-- (docs/15), except pointed at a customer rather than at an operator.
--
-- The fix is a promise the system can keep: the message and the human task
-- are written in ONE transaction. Either a human owes this caller a callback,
-- or the DE never claimed otherwise — voice-webhook only speaks the
-- reassuring line when this function hands back a task id.
--
-- Deliberately NOT done: priority 'high'. All 713 existing tasks are 'normal'
-- and no reader consults the column, so writing 'high' would invent a second
-- signal nobody reads — the very defect being fixed here. Visibility comes
-- from the queue and the Calls tab instead.

create or replace function public.record_voice_message(
  p_tenant_id    uuid,
  p_de_id        uuid,
  p_call_id      text,
  p_caller_name  text,
  p_caller_phone text,
  p_message      text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_msg_id  uuid;
  v_task_id uuid;
  v_who     text;
  v_actor   text;
begin
  -- Service role (or a migration context, where auth.role() is NULL) only.
  -- Written against auth.ROLE: anon shares a NULL uid with service_role
  -- (mig 330), so only the role string keeps anon out.
  if auth.role() is not null and auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  if coalesce(btrim(p_message), '') = '' then
    raise exception 'a voice message needs message text';
  end if;

  insert into voice_messages (tenant_id, de_id, call_id, caller_name, caller_phone, message)
  values (p_tenant_id, p_de_id, nullif(btrim(coalesce(p_call_id, '')), ''),
          nullif(btrim(coalesce(p_caller_name, '')), ''),
          nullif(btrim(coalesce(p_caller_phone, '')), ''),
          btrim(p_message))
  returning id into v_msg_id;

  -- Name the caller honestly. "a caller" beats inventing one, and the phone
  -- number is the thing the human actually needs to act.
  v_who := coalesce(nullif(btrim(coalesce(p_caller_name, '')), ''), 'a caller');

  insert into human_tasks (
    tenant_id, de_id, type, source, status, title, detail,
    related_table, related_id
  ) values (
    p_tenant_id, p_de_id, 'escalation', 'de', 'pending',
    format('Call back %s%s', v_who,
           case when coalesce(btrim(coalesce(p_caller_phone, '')), '') <> ''
                then ' on ' || btrim(p_caller_phone) else '' end),
    format('Left on a phone call%s.%s%s',
           case when coalesce(btrim(coalesce(p_call_id, '')), '') <> ''
                then ' (call ' || btrim(p_call_id) || ')' else '' end,
           E'\n\n', btrim(p_message)),
    'voice_messages', v_msg_id
  ) returning id into v_task_id;

  -- The audit chain is where "we told a caller we would ring back" becomes a
  -- commitment on the record rather than a row in a table nobody reads.
  select coalesce(persona_name, name, 'Digital Employee') into v_actor
    from digital_employees where id = p_de_id and tenant_id = p_tenant_id;

  perform public.append_audit_event_internal(
    p_tenant_id,
    coalesce(v_actor, 'Digital Employee'), 'de',
    format('Took a message on a phone call and raised a callback task for %s', v_who),
    'escalated',
    jsonb_build_object(
      'kind', 'voice_message_taken', 'de_id', p_de_id, 'channel', 'voice',
      'voice_message_id', v_msg_id, 'human_task_id', v_task_id,
      'call_id', nullif(btrim(coalesce(p_call_id, '')), ''),
      'caller_phone_given', coalesce(btrim(coalesce(p_caller_phone, '')), '') <> ''
    )
  );

  return jsonb_build_object('ok', true, 'message_id', v_msg_id, 'task_id', v_task_id);
end $$;

revoke all on function public.record_voice_message(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_voice_message(uuid, uuid, text, text, text, text) to service_role;

comment on function public.record_voice_message(uuid, uuid, text, text, text, text) is
  'Records a phone message AND the human task to answer it, atomically. voice-webhook may only tell a caller the message was passed on when this returns a task_id.';

-- Backfill: any message taken before this migration has no task and no owner.
-- Two exist from the live spike calls; leaving them silently unactioned would
-- repeat the defect at a smaller scale.
do $$
declare
  r record;
  v_task_id uuid;
  n int := 0;
begin
  for r in
    select m.* from voice_messages m
    where not exists (
      select 1 from human_tasks t
       where t.related_table = 'voice_messages' and t.related_id = m.id)
  loop
    insert into human_tasks (
      tenant_id, de_id, type, source, status, title, detail, related_table, related_id
    ) values (
      r.tenant_id, r.de_id, 'escalation', 'de', 'pending',
      format('Call back %s%s', coalesce(nullif(btrim(coalesce(r.caller_name, '')), ''), 'a caller'),
             case when coalesce(btrim(coalesce(r.caller_phone, '')), '') <> ''
                  then ' on ' || btrim(r.caller_phone) else '' end),
      format('Left on a phone call before callback tasks existed — raised retroactively.%s%s', E'\n\n', r.message),
      'voice_messages', r.id
    ) returning id into v_task_id;
    n := n + 1;
  end loop;
  raise notice 'backfilled % callback task(s)', n;
end $$;
