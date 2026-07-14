-- ============================================================
-- 151 — Support inbox (Phase 2): the human side of the unified
-- conversation=ticket. Humans see live conversations, take one over,
-- approve a DE's drafted reply, reply themselves, and resolve — all on
-- the SAME de_conversations/de_messages thread. Plus: enable Supabase
-- Realtime on both tables so the inbox (and the customer widget) update
-- live instead of polling.
--
-- All writes go through SECURITY DEFINER RPCs with a tenant-membership
-- check (no broad RLS write policies on customer-facing tables).
-- ============================================================

-- ── Live updates: add the conversation tables to the realtime publication ──
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'de_conversations') then
    alter publication supabase_realtime add table de_conversations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'de_messages') then
    alter publication supabase_realtime add table de_messages;
  end if;
exception when others then
  raise notice 'realtime publication add skipped: %', sqlerrm;
end $$;

-- Helper: assert the caller belongs to the conversation's tenant.
create or replace function public._assert_conv_member(p_conversation_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select tenant_id into v_tenant from de_conversations where id = p_conversation_id;
  if v_tenant is null then raise exception 'conversation_not_found'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = v_tenant)) then
    raise exception 'not authorized for this workspace';
  end if;
  return v_tenant;
end;
$function$;

-- Take a conversation over (human owns it now).
create or replace function public.claim_support_conversation(p_conversation_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid;
begin
  v_tenant := _assert_conv_member(p_conversation_id);
  update de_conversations set owner_user_id = auth.uid(), status = 'human_owned', last_message_at = now()
  where id = p_conversation_id;
end;
$function$;

-- Send a human reply — delivered straight to the customer.
create or replace function public.send_human_reply(p_conversation_id uuid, p_content text)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_id uuid;
begin
  if coalesce(trim(p_content), '') = '' then raise exception 'empty_message'; end if;
  v_tenant := _assert_conv_member(p_conversation_id);
  insert into de_messages (tenant_id, conversation_id, role, content, confidence, escalated, delivery)
  values (v_tenant, p_conversation_id, 'assistant', p_content, 100, false, 'sent')
  returning id into v_id;
  update de_conversations set owner_user_id = coalesce(owner_user_id, auth.uid()), status = 'human_owned', last_message_at = now()
  where id = p_conversation_id;
  return v_id;
end;
$function$;

-- Approve a DE's drafted reply (optionally edited) — deliver it.
create or replace function public.approve_draft_reply(p_message_id uuid, p_edited_content text default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_conv uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select tenant_id, conversation_id into v_tenant, v_conv
  from de_messages where id = p_message_id and delivery = 'draft_pending';
  if v_tenant is null then raise exception 'not_a_pending_draft'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = v_tenant)) then
    raise exception 'not authorized for this workspace';
  end if;
  update de_messages
    set delivery = 'sent', escalated = false,
        content = coalesce(nullif(trim(p_edited_content), ''), content)
  where id = p_message_id;
  update de_conversations set owner_user_id = coalesce(owner_user_id, auth.uid()), status = 'human_owned', last_message_at = now()
  where id = v_conv;
end;
$function$;

-- Set status (e.g. resolve / reopen) and/or priority.
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
end;
$function$;

grant execute on function public.claim_support_conversation(uuid) to authenticated;
grant execute on function public.send_human_reply(uuid, text) to authenticated;
grant execute on function public.approve_draft_reply(uuid, text) to authenticated;
grant execute on function public.set_support_conversation_state(uuid, text, text) to authenticated;
