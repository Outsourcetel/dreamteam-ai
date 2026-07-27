-- 380_handoff_returned_event_type.sql
-- ============================================================================
-- Handing a support conversation back to the digital employee always fails, and
-- silently undoes itself.
--
-- handoff_back_to_de() ends by recording the event:
--   insert into activity_events (..., event_type, text)
--   values (v_tenant, v_de_name, 'de', 'handoff_returned', ...)
--
-- But activity_events_event_type_check permits only:
--   resolved, escalated, kb_gap, error, config_change, approval,
--   quality_drift, certification_stale
--
-- 'handoff_returned' is not among them, so the INSERT raises — and because it is
-- the LAST statement in the function, everything before it rolls back with it:
--   · the conversation stays owned by the human, still 'human_handling'
--   · the guidance note never reaches the DE's conversation memory
--   · the pending escalation task stays open
-- The human sees an error, and the thread is stranded exactly where it was. The
-- customer is mid-conversation with nobody assigned to them.
--
-- This is the same failure mode as guardrail_rules_rule_type_check breaking
-- signup (fixed in mig 378's session): a function inserting a value its own
-- CHECK constraint does not allow. Worth naming as a class — the vocabulary
-- lives in two places and only one of them gets updated.
--
-- FIX DIRECTION: widen the constraint, not the function. A human returning a
-- conversation is a genuine, distinct workforce event and belongs in the
-- activity feed under its own name. Re-labelling it as 'approval' or 'resolved'
-- to fit the existing list would make the feed lie about what happened.
--
-- Scope checked before writing: of the support-path functions
-- (claim_support_conversation, send_human_reply, set_support_conversation_state,
-- approve_draft, handoff_back_to_de) only handoff_back_to_de writes an
-- activity_event, so the takeover direction does not carry the same bug.
-- ============================================================================

ALTER TABLE public.activity_events DROP CONSTRAINT IF EXISTS activity_events_event_type_check;
ALTER TABLE public.activity_events ADD CONSTRAINT activity_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'resolved', 'escalated', 'kb_gap', 'error', 'config_change', 'approval',
    'quality_drift', 'certification_stale',
    -- A human took the thread back to the digital employee (handoff_back_to_de).
    'handoff_returned'
  ]));

DO $assert$
DECLARE
  v_bad text;
  v_tenant uuid;
BEGIN
  -- 1. The value the function actually inserts must now be accepted.
  BEGIN
    SELECT id INTO v_tenant FROM tenants LIMIT 1;
    INSERT INTO activity_events (tenant_id, actor, actor_type, event_type, text)
    VALUES (v_tenant, '__mig380_selftest', 'de', 'handoff_returned', 'constraint self-test');
    DELETE FROM activity_events WHERE actor = '__mig380_selftest';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '380: handoff_returned is still rejected by the CHECK';
  END;

  -- 2. handoff_back_to_de must still be the function we think it is. If someone
  -- later changes the literal, widening the constraint here stops helping and
  -- nothing would say so.
  IF (SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'handoff_back_to_de') !~ 'handoff_returned'
  THEN RAISE EXCEPTION '380: handoff_back_to_de no longer inserts handoff_returned'; END IF;

  -- 3. Catch the SIBLINGS. Any other function inserting an event_type literal the
  -- constraint does not permit is the same latent bug waiting for its first real
  -- user. Reported rather than raised: an unrelated function should not block
  -- this fix, but nobody should have to rediscover it the way this one was found.
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL regexp_matches(
      regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'),
      'activity_events[^;]*?values[^;]*?''([a-z_]{4,})''[^;]*?;', 'g') AS m(lit)
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND m.lit[1] NOT IN ('resolved','escalated','kb_gap','error','config_change',
                          'approval','quality_drift','certification_stale',
                          'handoff_returned','de','human','system','user');
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE '380: ⚠ these functions may insert an unpermitted activity event_type — check them: %', v_bad;
  ELSE
    RAISE NOTICE '380: no other function appears to insert an unpermitted event_type';
  END IF;

  RAISE NOTICE '380: handing a conversation back to the DE no longer rolls itself back';
END $assert$;

NOTIFY pgrst, 'reload schema';
