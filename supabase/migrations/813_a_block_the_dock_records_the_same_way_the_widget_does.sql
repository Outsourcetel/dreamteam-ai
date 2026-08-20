-- 813_a_block_the_dock_records_the_same_way_the_widget_does.sql
-- ============================================================================
-- Register C-10 said "the guardrail layer has never blocked a production
-- message: of 455 assistant messages ever sent, ZERO carry delivery='blocked'
-- ... wired and untested, on the exact seam the product sells".
--
-- It has blocked. Thirteen times — 5 on the dock, 8 in exams — each one an
-- assistant message carrying the guardrail notice, confidence 0, escalated
-- true, with a human_task raised beside it. The layer works.
--
-- ── Two writers, two meanings, one of them counted ─────────────────────────
-- widget-ask inserts that notice with `delivery: 'blocked'`.
-- de-answer inserted the IDENTICAL notice and omitted `delivery` entirely, so
-- the row took the column default and landed as 'sent'.
--
-- Both are defensible read alone — the notice IS sent — but they cannot both
-- be right in the same column, and every count of delivery='blocked' therefore
-- measured the widget only. The widget has carried ONE message in its life;
-- the dock has carried 157 and exams 282. So a safety layer that had fired
-- thirteen times read as one that had never fired at all, on the seam the
-- product is sold on.
--
-- This is the two-paths-one-counted shape, and the cost here was not a wrong
-- number in a dashboard: it was a register item that read "wired and untested"
-- and would have sent somebody to debug a working control.
--
-- ── What this migration does ───────────────────────────────────────────────
-- The forward fix is in supabase/functions/de-answer/index.ts, shipped in the
-- same commit: that insert now sets delivery='blocked' explicitly.
--
-- This backfills the thirteen rows already written, because leaving them says
-- those blocks did not happen. The predicate is tight enough to be safe: the
-- content must be EXACTLY the guardrail notice de-answer emits, and the row
-- must carry confidence 0 and escalated true. Measured before writing: 13 rows
-- match, all of them delivery='sent', with no other combination present.
--
-- Content, timestamps and escalation are untouched. Only the delivery marker
-- moves, and it moves to the value the other writer already uses for the same
-- event.
-- ============================================================================

begin;

update public.de_messages
   set delivery = 'blocked'
 where role = 'assistant'
   and delivery = 'sent'
   and confidence = 0
   and escalated = true
   and content = 'I can''t help with that — it''s outside my guardrails. I''ve escalated to a human.';

-- ── Proof ───────────────────────────────────────────────────────────────────
-- Absence of a violation (CLAUDE.md rule 3): no guardrail-notice row may still
-- be recorded as plain 'sent'. Vacuously true on an environment holding none
-- of these rows, and still catches every real one — so this replays.
do $$
declare v_stragglers int;
begin
  select count(*) into v_stragglers
    from public.de_messages
   where role = 'assistant'
     and confidence = 0
     and escalated = true
     and delivery <> 'blocked'
     and content = 'I can''t help with that — it''s outside my guardrails. I''ve escalated to a human.';

  if v_stragglers <> 0 then
    raise exception '813: % guardrail-block notice(s) are still recorded as something other than blocked — the count of delivery=''blocked'' would keep under-reporting the layer', v_stragglers;
  end if;

  -- The vocabulary must still admit the value being written. A CHECK that
  -- stopped allowing 'blocked' would make the forward fix in de-answer throw
  -- on the next real block, which is the worst moment to find out.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.de_messages'::regclass
       and pg_get_constraintdef(oid) like '%blocked%')
  then
    raise exception '813: de_messages has no CHECK admitting delivery=''blocked'' — de-answer now writes it and would fail';
  end if;
end $$;

commit;
