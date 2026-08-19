-- 782_erasure_reaches_the_reply_that_quotes_them.sql
-- ============================================================================
-- Corrects a reasoning error in migration 779's header, found by testing the
-- erasure with realistic data instead of a greeting.
--
-- 779 erased only the messages the SUBJECT wrote, and argued that the
-- employee's replies could stay because they are "the workspace's record of
-- what it told a customer and they do not identify the customer once the
-- identifiers above are gone."
--
-- That is false whenever a reply quotes the customer back. The verification
-- asked "My account number is 55512345, can you check my balance?" and the
-- employee answered, correctly refusing — and repeated the account number in
-- its refusal. After the erasure the conversation was properly pseudonymised
-- (end_user_ref null, name '[erased]') and the account number was still
-- sitting in the assistant turn.
--
-- A rule that erases a person's words but not the words quoting them is not
-- erasure. Every message body in the subject's conversations now goes.
--
-- What survives is the conversation ROW — that it happened, when, its channel,
-- status and triage. That is the operational record 779 set out to keep, and
-- it holds no personal data once the identifiers and every body are gone.
--
-- ⚠ For anyone extending this later: the test that found it worked because the
-- payload looked like real customer data. A probe that asks "hello" proves the
-- function runs; it does not prove the function erases.
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
   where tenant_id = p_tenant_id and conversation_id = any(v_conv_ids);

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
   where tenant_id = p_tenant_id and conversation_id = any(v_conv_ids);

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
    'access_control',
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
