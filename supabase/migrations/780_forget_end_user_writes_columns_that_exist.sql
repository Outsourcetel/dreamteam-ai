-- 780_forget_end_user_writes_columns_that_exist.sql
-- ============================================================================
-- Fixes migration 779 the same day it shipped. forget_end_user set
-- `updated_at = now()` on de_conversations; that table has no updated_at
-- column (it carries created_at, last_message_at, triaged_at, snoozed_at,
-- csat_submitted_at). Every call raised 42703 and erased nothing.
--
-- It failed SAFELY — the function is one statement to the caller, so the
-- exception rolled the whole thing back and no subject was half-erased. But an
-- erasure function that always throws is worse than none: it would answer a
-- data-subject request with an error and leave the data in place.
--
-- Caught by running it against a real subject rather than reading it. The
-- guards were already right in 779 — a blank reference and a foreign tenant
-- were both refused — which is exactly why the write needed exercising too.
-- ============================================================================

create or replace function public.forget_end_user(
  p_tenant_id     uuid,
  p_end_user_ref  text,
  p_reason        text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor    text;
  v_convs    int := 0;
  v_msgs     int := 0;
  v_sessions int := 0;
  v_contacts int := 0;
  v_conv_ids uuid[];
begin
  -- ── rails ────────────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(btrim(p_end_user_ref), '') = '' then
    raise exception 'an end-user reference is required — refusing to erase on a blank subject';
  end if;
  if not (
    public.is_platform_admin()
    or (public.auth_tenant_id() = p_tenant_id
        and public.auth_has_tenant_role(array['tenant_owner', 'tenant_admin']))
  ) then
    raise exception 'only an owner or admin of this workspace may erase a person''s data';
  end if;

  select coalesce(full_name, 'unknown') into v_actor from profiles where user_id = auth.uid();

  -- ── the subject's conversations, resolved once and reused ────────────────
  select coalesce(array_agg(id), '{}') into v_conv_ids
    from de_conversations
   where tenant_id = p_tenant_id and end_user_ref = p_end_user_ref;

  -- ── measure BEFORE writing (see header) ──────────────────────────────────
  v_convs := coalesce(array_length(v_conv_ids, 1), 0);

  select count(*) into v_msgs from de_messages
   where tenant_id = p_tenant_id and role = 'user' and conversation_id = any(v_conv_ids);

  select count(*) into v_sessions from end_user_sessions
   where tenant_id = p_tenant_id and end_user_ref = p_end_user_ref;

  select count(*) into v_contacts from customer_account_contacts
   where tenant_id = p_tenant_id and end_user_ref = p_end_user_ref;

  -- ── erase ────────────────────────────────────────────────────────────────
  -- The person's own words go; the employee's replies stay, because they are
  -- the workspace's record of what it told a customer and they do not identify
  -- the customer once the identifiers above are gone.
  update de_messages
     set content = '[erased at the data subject''s request]'
   where tenant_id = p_tenant_id and role = 'user' and conversation_id = any(v_conv_ids);

  update de_conversations
     set end_user_ref = null,
         end_user_name = '[erased]',
         handoff_summary = case when handoff_summary is null then null
                                else '[erased at the data subject''s request]' end
   where id = any(v_conv_ids);

  delete from end_user_sessions
   where tenant_id = p_tenant_id and end_user_ref = p_end_user_ref;

  delete from customer_account_contacts
   where tenant_id = p_tenant_id and end_user_ref = p_end_user_ref;

  -- ── receipt ──────────────────────────────────────────────────────────────
  -- Audited under its own category so an erasure is findable later WITHOUT
  -- storing the reference that was erased. The subject key is deliberately not
  -- written into the audit detail: recording who was forgotten, in the log, in
  -- order to prove they were forgotten, defeats the point.
  perform public.append_audit_event(
    p_tenant_id, v_actor, 'human',
    format('Erased an end user''s personal data on request — %s conversation(s), %s message(s), %s session(s), %s contact(s)',
           v_convs, v_msgs, v_sessions, v_contacts),
    'privacy',
    jsonb_build_object(
      'conversations_pseudonymised', v_convs,
      'user_messages_erased',        v_msgs,
      'sessions_deleted',            v_sessions,
      'contacts_deleted',            v_contacts,
      'reason',                      coalesce(p_reason, 'data subject request')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'conversations_pseudonymised', v_convs,
    'user_messages_erased',        v_msgs,
    'sessions_deleted',            v_sessions,
    'contacts_deleted',            v_contacts,
    'nothing_found', (v_convs + v_sessions + v_contacts) = 0
  );
end;
$function$;

revoke all on function public.forget_end_user(uuid, text, text) from public, anon, authenticated;
grant execute on function public.forget_end_user(uuid, text, text) to authenticated;

comment on function public.forget_end_user(uuid, text, text) is
  'A-7: honours a data-subject erasure request. Pseudonymises the subject''s conversations and their own messages, deletes their sessions and contact rows, and returns a receipt counted BEFORE the writes. Owner/admin of the workspace, or platform admin. Deliberately does not record the erased reference in the audit detail.';
