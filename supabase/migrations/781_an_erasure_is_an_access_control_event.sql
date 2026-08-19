-- 781_an_erasure_is_an_access_control_event.sql
-- ============================================================================
-- Third and final correction to forget_end_user, and the same defect class I
-- fixed in migration 769 six hours earlier: a value written that its table's
-- CHECK forbids.
--
--   audit_events_category_check allows: resolved | escalated | approval |
--   guardrail_check | guardrail_block | config_change | playbook_step |
--   invoice | connector_sync | connector_action | evidence_step |
--   access_control | knowledge_revision | inquiry_triage | action_execution |
--   de_memory | de_consultation | guardrail_adjudication
--
-- 779 wrote 'privacy'. Not in the list, so the receipt insert raised 23514 and
-- the whole erasure rolled back — safely, but never completing.
--
-- 'access_control' is the honest home rather than a new category: this schema
-- deliberately keeps a closed vocabulary, and an erasure IS a change to who can
-- reach what. Adding a nineteenth value to satisfy one caller would be the
-- widen-the-CHECK move migration 769 argued against.
--
-- ── Worth recording plainly ────────────────────────────────────────────────
-- Three migrations to land one function: 779 wrote a column that does not
-- exist, 780 fixed that and left a category that does not exist, 781 fixes the
-- category. Every one of the three was caught by RUNNING the function against a
-- real subject, and none by reading it. The guards were correct from the first
-- attempt; only the writes were wrong, and only exercise found them.
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
