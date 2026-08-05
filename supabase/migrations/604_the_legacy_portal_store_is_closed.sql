-- 604 — label the legacy portal store, now that nothing writes it.
--
-- The customer portal used to keep its own everything: its own retrieval over
-- `knowledge_articles`, its own audit, and its own conversation store. Commit
-- 88b96b2 routed EndUserChatPage through askDE, so portal threads now land in
-- `de_conversations` like every other channel; 8c6e268 deleted the 266-line
-- chain that fed these tables.
--
-- Measured before labelling, not assumed:
--
--   conversations   3 rows   tenant `outsourcetel` (Demo Workspace) only
--   messages        6 rows
--   escalations     3 rows   auto-raised by runPortalTurn on a failed audit
--   agent_actions   0 rows
--
-- All four: ZERO SQL writers, ZERO `.from(...)` writers in src/ or
-- supabase/functions. The last writer for every one of them was the chain that
-- was just removed.
--
-- ── Why comments and not DROP ────────────────────────────────────────────
-- These three rows are real portal history for a real (if demo) workspace, and
-- `escalations` records that a customer was handed to a human. Dropping a table
-- to prove a point is how you find the one reader nobody grepped for — and I
-- have mis-called reachability four times in this audit alone. A comment costs
-- nothing, survives, and tells the next person where the truth moved.
--
-- ⚠ SCOPE. The founder asked for `conversations` and `messages`. `escalations`
-- and `agent_actions` are labelled too because they hang off `conversations` by
-- foreign key and are in the identical state — marking half a dead cluster
-- leaves the schema documentation actively misleading, which is worse than
-- leaving it alone. Nothing is dropped and no data moves either way.
--
-- ⚠ NOT deprecated: `knowledge_articles`. The retired portal retrieval read it,
-- but so does `search_knowledge` (the audience-filtering survivor from mig 602),
-- and it is a different concept from a conversation store. Left alone.

begin;

do $check$
declare
  v_c int; v_m int; v_e int; v_a int;
begin
  select count(*) into v_c from conversations;
  select count(*) into v_m from messages;
  select count(*) into v_e from escalations;
  select count(*) into v_a from agent_actions;

  -- If any of these has GROWN since the legacy path was deleted, something is
  -- still writing and the label would be a lie. Refuse rather than document a
  -- table as dead while it is quietly in use.
  if v_c > 3 or v_m > 6 or v_e > 3 or v_a > 0 then
    raise exception
      'a supposedly retired table has grown (conversations %, messages %, escalations %, agent_actions %) — find the writer before labelling these deprecated',
      v_c, v_m, v_e, v_a;
  end if;
end;
$check$;

comment on table conversations is
  'DEPRECATED (mig 604). The live conversation table is de_conversations — every channel writes it, including the customer portal since commit 88b96b2 (channel = ''portal''), and the Support Inbox, triage, escalation and submit_csat all read it. These rows are the legacy portal store from before that change and are kept only so nothing is destroyed. Do not read or write this table in new code.';

comment on table messages is
  'DEPRECATED (mig 604). Superseded by de_messages, which holds the turns for de_conversations. These rows belonged to the retired portal path (runPortalTurn, deleted in 8c6e268). Do not read or write this table in new code.';

comment on table escalations is
  'DEPRECATED (mig 604). Raised by the retired portal path when its own answer audit failed. A customer handed to a human now becomes a human_task against a de_conversations thread, routed to a named owner by the assignment rules (migs 587/588). Kept for the record; do not write it.';

comment on table agent_actions is
  'DEPRECATED (mig 604). Empty, and part of the retired portal cluster hanging off `conversations`. Actions a digital employee takes are recorded in action_executions, which is what the approval gate, the audit chain and the trust ladder all read.';

do $verify$
declare v_missing text;
begin
  select string_agg(t, ', ') into v_missing
  from unnest(array['conversations','messages','escalations','agent_actions']) t
  where obj_description(('public.' || t)::regclass) is null
     or obj_description(('public.' || t)::regclass) not like 'DEPRECATED (mig 604)%';
  if v_missing is not null then
    raise exception 'comment did not land on: %', v_missing;
  end if;
end;
$verify$;

commit;
