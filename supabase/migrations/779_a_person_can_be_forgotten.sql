-- 779_a_person_can_be_forgotten.sql
-- ============================================================================
-- Register A-7, and one of the four conditions docs/57 names for a GO.
--
-- The platform could already delete an entire customer WORKSPACE — delete_tenant
-- is well guarded and writes a receipt from rows counted before deletion. What
-- it could not do is honour the request an actual person makes: "delete what you
-- hold about me." No function existed. docs/62 ranked that a pilot blocker for
-- any EU or California customer, and docs/60 withdrew the overstatement that we
-- could not honour deletion at all — this is the half that was genuinely missing.
--
-- ── Erase by pseudonymisation, not DELETE ──────────────────────────────────
-- The subject stops being identifiable; the operational record that a
-- conversation happened survives. Three reasons, in order:
--   1. The audit chain is append-only and hash-linked (audit-chain-verifies-hq).
--      Deleting conversations underneath it would break verification to prove a
--      privacy point — trading one compliance property for another.
--   2. Support metrics counted those conversations. Removing rows retroactively
--      rewrites history that decisions were already made from.
--   3. Erasure requires that the data no longer identify a natural person. It
--      does not require the row to vanish. Removing the identifiers and the
--      content they wrote achieves the former without the collateral of the latter.
--
-- ── What it reaches ────────────────────────────────────────────────────────
-- Every column in this schema that identifies an end user, enumerated rather
-- than assumed (information_schema, 2026-08-19):
--   de_conversations        end_user_ref, end_user_name, handoff_summary
--   de_messages             the content the person themselves wrote (role='user')
--   end_user_sessions       end_user_ref, display_name  — DELETED, session state
--   customer_account_contacts  the whole row — it exists only to describe a person
-- connectors.display_name and trust_policies.display_name also matched the
-- column sweep and are deliberately NOT touched: they name systems and policies,
-- not people.
--
-- ── Counted before, not after ──────────────────────────────────────────────
-- The receipt reports what was erased as a MEASUREMENT taken before the writes,
-- for the same reason delete_tenant does it: a post-hoc count of zero cannot
-- tell "erased" from "was never there", and a receipt that cannot tell those
-- apart is not evidence.
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
                                else '[erased at the data subject''s request]' end,
         updated_at = now()
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
