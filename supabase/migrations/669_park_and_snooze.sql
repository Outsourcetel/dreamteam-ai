-- 669_park_and_snooze.sql
-- ==========================================================================
-- WHY: park & snooze (handoff 06 §C). "Taking a conversation over currently
-- sets status:'human_owned' and nothing else — no timer, no turn, no
-- reminder, which is where things get dropped." Park gives an owned
-- conversation a shelf and a return time.
--
-- DESIGN — read-time, not a sweep. Parked is a VIEW-state computed from two
-- columns, so there is no background job that can silently die (this repo
-- has already paid for sweeps that stopped and told nobody):
--   parked  ⟺  snoozed_at IS NOT NULL
--              AND (last_message_at IS NULL OR last_message_at <= snoozed_at)
--              AND (snoozed_until IS NULL OR snoozed_until > now())
-- · timed park: snoozed_until set → returns when the clock passes it (the
--   inbox re-evaluates on its existing 30s tick — no reload needed);
-- · "until they reply": snoozed_until NULL → ONLY a new message returns it,
--   because any inbound write bumps last_message_at past snoozed_at. That is
--   why park_support_conversation must NEVER touch last_message_at.
--
-- ⚠ Auto-close ("closes itself in 5 days") is DELIBERATELY not here: it
-- writes a status change no human made — a governance decision, not a
-- column. Named out, not quietly dropped.
-- ==========================================================================

begin;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'de_conversations' and column_name = 'snoozed_until') then
    raise exception 'snoozed_until already exists — 669 already applied';
  end if;
end $$;

alter table public.de_conversations
  add column snoozed_at timestamptz null,
  add column snoozed_until timestamptz null;

comment on column public.de_conversations.snoozed_at is
  'When the owner parked it. Parked is computed at read time — see mig 669 header.';
comment on column public.de_conversations.snoozed_until is
  'Timed return. NULL while snoozed_at is set = parked until the customer replies.';

-- ── park / unpark — same authority idiom as set_support_conversation_state:
-- SECURITY DEFINER + _assert_conv_member (tenant) + can_access_de (line). ──
create or replace function public.park_support_conversation(
  p_conversation_id uuid, p_until timestamptz default null
) returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_de uuid; v_owner uuid;
begin
  perform _assert_conv_member(p_conversation_id);
  select de_id, owner_user_id into v_de, v_owner from de_conversations where id = p_conversation_id;
  if v_de is not null and not public.can_access_de(v_de) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;
  -- Parking is an OWNER's shelf. Parking someone else's thread would hide
  -- their work from them; the UI only offers it on Mine, and the gate here
  -- makes that a rule rather than a layout choice.
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'not_yours: take the conversation over before parking it';
  end if;
  if p_until is not null and p_until <= now() then
    raise exception 'bad_until: the return time is already in the past';
  end if;
  -- ⚠ Deliberately does NOT touch last_message_at: "until they reply"
  -- works precisely because a park never looks like a message.
  update de_conversations
     set snoozed_at = now(), snoozed_until = p_until
   where id = p_conversation_id;
end;
$fn$;

create or replace function public.unpark_support_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_de uuid;
begin
  perform _assert_conv_member(p_conversation_id);
  select de_id into v_de from de_conversations where id = p_conversation_id;
  if v_de is not null and not public.can_access_de(v_de) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;
  update de_conversations
     set snoozed_at = null, snoozed_until = null
   where id = p_conversation_id;
end;
$fn$;

-- Grants per the standing rule: strip all three, grant back exactly who may
-- call — signed-in tenant members (the functions do their own authority).
revoke execute on function public.park_support_conversation(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.unpark_support_conversation(uuid) from public, anon, authenticated;
grant execute on function public.park_support_conversation(uuid, timestamptz) to authenticated;
grant execute on function public.unpark_support_conversation(uuid) to authenticated;

do $$
declare v_cols int; v_fns int;
begin
  select count(*) into v_cols from information_schema.columns
   where table_name = 'de_conversations' and column_name in ('snoozed_at','snoozed_until');
  if v_cols <> 2 then raise exception 'expected both snooze columns, found %', v_cols; end if;
  select count(*) into v_fns from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('park_support_conversation','unpark_support_conversation');
  if v_fns <> 2 then raise exception 'expected both park functions, found %', v_fns; end if;
  if has_function_privilege('anon', 'public.park_support_conversation(uuid, timestamptz)', 'EXECUTE') then
    raise exception 'anon can execute park — grants are wrong';
  end if;
  if not has_function_privilege('authenticated', 'public.park_support_conversation(uuid, timestamptz)', 'EXECUTE') then
    raise exception 'authenticated cannot execute park — grants are wrong';
  end if;
end $$;

commit;
