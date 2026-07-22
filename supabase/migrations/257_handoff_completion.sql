-- ============================================================================
-- 257 — HANDOFF COMPLETION (docs/19 G3: agent → human → agent, closed)
--
-- The inbox could already take over, reply, and resolve. What was missing is
-- the way BACK: a human finishes with a thread and returns it to the Digital
-- Employee — with a close-the-loop lesson the DE actually remembers (de_memory
-- is conversation-scoped-recalled by de-answer on the very next message).
-- Plus: escalation tasks stop lingering in the Approvals desk once a human
-- has visibly handled the thread, and email drafts become editable before
-- approval (outbound_drafts had no member write path at all).
-- ============================================================================

-- ── 1) Hand a conversation back to its DE, teaching it on the way out. ──
create or replace function public.handoff_back_to_de(p_conversation_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_de uuid; v_status text; v_de_name text;
begin
  v_tenant := _assert_conv_member(p_conversation_id);
  select de_id, status into v_de, v_status from de_conversations where id = p_conversation_id;
  if v_status = 'resolved' then raise exception 'conversation_resolved'; end if;
  if v_de is null then raise exception 'no_de_on_conversation'; end if;

  update de_conversations
     set status = 'ai_handling', owner_user_id = null, handoff_summary = null, last_message_at = now()
   where id = p_conversation_id;

  -- The lesson: written into the DE's conversation-scoped memory, which
  -- de-answer recalls on the next customer message in this thread.
  if coalesce(btrim(p_note), '') <> '' then
    perform de_memory_write(
      v_tenant, v_de,
      'A human teammate handled part of this conversation and handed it back with this guidance: ' || btrim(p_note),
      null, 'conversation', p_conversation_id::text, 'episodic', 0.9, 'human', null);
  end if;

  -- The thread is visibly handled — its pending escalation tasks are done.
  update human_tasks
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where tenant_id = v_tenant and related_table = 'de_conversations'
     and related_id = p_conversation_id and type = 'escalation' and status = 'pending';

  select coalesce(persona_name, name, 'the DE') into v_de_name from digital_employees where id = v_de;
  insert into activity_events (tenant_id, actor, actor_type, event_type, text)
  values (v_tenant, v_de_name, 'de', 'handoff_returned',
          'A human handed the conversation back to ' || v_de_name
          || case when coalesce(btrim(p_note), '') <> '' then ' with guidance: ' || left(btrim(p_note), 200) else '' end);
end;
$function$;

-- ── 2) Resolving a thread also settles its pending escalation tasks
--       (previously they sat in the Approvals desk forever). ──
create or replace function public.set_support_conversation_state(p_conversation_id uuid, p_status text default null, p_priority text default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid;
begin
  v_tenant := _assert_conv_member(p_conversation_id);
  if p_status is not null and p_status not in ('ai_handling','needs_human','human_owned','resolved') then raise exception 'bad_status'; end if;
  if p_priority is not null and p_priority not in ('low','normal','high','urgent') then raise exception 'bad_priority'; end if;
  update de_conversations
    set status = coalesce(p_status, status), priority = coalesce(p_priority, priority), last_message_at = now()
  where id = p_conversation_id;
  if p_status = 'resolved' then
    update human_tasks
       set status = 'approved', decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where tenant_id = v_tenant and related_table = 'de_conversations'
       and related_id = p_conversation_id and type = 'escalation' and status = 'pending';
  end if;
end;
$function$;

-- ── 3) Edit an outbound draft before approving it (inbox edit-then-send).
--       outbound_drafts writes were service-role-only (mig 179); members
--       could approve verbatim or nothing. Pending drafts only. ──
create or replace function public.edit_outbound_draft(p_draft_id uuid, p_body text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if coalesce(btrim(p_body), '') = '' or length(btrim(p_body)) < 10 then raise exception 'draft body required (min 10 chars)'; end if;
  select tenant_id into v_tenant from outbound_drafts where id = p_draft_id and status = 'pending_approval';
  if v_tenant is null then raise exception 'not_a_pending_draft'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = v_tenant)) then
    raise exception 'not authorized for this workspace';
  end if;
  update outbound_drafts set body = btrim(p_body), updated_at = now() where id = p_draft_id;
end;
$function$;

grant execute on function public.handoff_back_to_de(uuid, text) to authenticated;
grant execute on function public.set_support_conversation_state(uuid, text, text) to authenticated;
grant execute on function public.edit_outbound_draft(uuid, text) to authenticated;
revoke all on function public.handoff_back_to_de(uuid, text) from public, anon;
revoke all on function public.edit_outbound_draft(uuid, text) from public, anon;

NOTIFY pgrst, 'reload schema';
