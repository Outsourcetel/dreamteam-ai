-- 671_triage_the_real_traffic_only.sql
-- ==========================================================================
-- WHY: the "skewed taxonomy" (115 of 164 categorised conversations landing
-- in `general`) turned out, on measurement, to be MEASUREMENT POLLUTION —
-- the exam-vs-production trap, again. Channel-by-channel:
--
--   exam channel:      282 conversations — 109 general + 49 how_to + 124
--                      untriaged. Every one is a certification question
--                      ("What is a guardrail?") filed under a CUSTOMER
--                      SUPPORT taxonomy. Meaningless by construction.
--   support channels:  173 conversations — 166 untriaged (all July, BEFORE
--                      the mig-233 trigger existed), 6 honest generals, and
--                      August's only support conversation triaged correctly.
--
-- The mechanism is healthy. The rules are fine (all 115 generals re-classify
-- to general under today's rules — the corpus, not the patterns). Three
-- fixes, none of which is "add keywords":
--   1. The trigger stops triaging non-support channels — exams are not
--      support traffic (the 570/571/572 lineage, extended to triage).
--   2. Exam categories are CLEARED — so the next analyst (I was the first)
--      cannot repeat the polluted measurement.
--   3. The 166-conversation July backlog is backfilled through the SAME
--      deterministic classifier the trigger runs — subject + first user
--      message, identical code path, nothing invented.
-- ==========================================================================

begin;

-- 1. Channel guard in the trigger — support traffic only.
CREATE OR REPLACE FUNCTION public.trg_triage_support_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conv de_conversations; v_first boolean; v_cls jsonb;
BEGIN
  IF coalesce(NEW.role,'') <> 'user' THEN RETURN NEW; END IF;
  BEGIN
    SELECT count(*) = 1 INTO v_first FROM de_messages
      WHERE conversation_id = NEW.conversation_id AND role = 'user';
    IF NOT v_first THEN RETURN NEW; END IF;

    SELECT * INTO v_conv FROM de_conversations WHERE id = NEW.conversation_id;
    IF v_conv.id IS NULL OR v_conv.category IS NOT NULL THEN RETURN NEW; END IF;  -- don't override
    -- ⚠ Mig 671: a SUPPORT taxonomy classifies SUPPORT traffic. Exams,
    -- voice-lab runs and whatever channels come next stay untriaged rather
    -- than mislabelled — 282 exam conversations wearing customer-support
    -- categories is how the first taxonomy analysis reached a false verdict.
    IF v_conv.channel NOT IN ('widget','hosted','portal','email','dock') THEN RETURN NEW; END IF;

    v_cls := public.classify_support_text(v_conv.tenant_id, coalesce(v_conv.subject,'') || ' ' || coalesce(NEW.content,''));
    UPDATE de_conversations
       SET category   = v_cls->>'category',
           severity   = v_cls->>'severity',
           priority   = v_cls->>'priority',
           triaged_at = now()
     WHERE id = NEW.conversation_id AND category IS NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- triage must never block a customer message landing
  END;
  RETURN NEW;
END; $$;

-- 2. Clear the meaningless exam categories (158 rows expected: 109 + 49).
UPDATE de_conversations
   SET category = NULL, triaged_at = NULL
 WHERE channel = 'exam' AND category IS NOT NULL;

-- 3. Backfill the July support backlog through the SAME classifier.
WITH firsts AS (
  SELECT c.id, c.tenant_id,
         coalesce(c.subject,'') || ' ' ||
         coalesce((SELECT m.content FROM de_messages m
                    WHERE m.conversation_id = c.id AND m.role = 'user'
                    ORDER BY m.created_at LIMIT 1), '') AS text
    FROM de_conversations c
   WHERE c.channel IN ('widget','hosted','portal','email','dock')
     AND c.category IS NULL
     AND EXISTS (SELECT 1 FROM de_messages m WHERE m.conversation_id = c.id AND m.role = 'user')
)
UPDATE de_conversations c
   SET category   = cls->>'category',
       severity   = coalesce(c.severity,   cls->>'severity'),
       priority   = coalesce(c.priority,   cls->>'priority'),
       triaged_at = now()
  FROM (SELECT id, public.classify_support_text(tenant_id, text) AS cls FROM firsts) f
 WHERE c.id = f.id;

-- Asserts: no categorised exams remain; the support backlog is triaged.
do $$
declare v_exam int; v_backlog int;
begin
  select count(*) into v_exam from de_conversations where channel='exam' and category is not null;
  if v_exam <> 0 then raise exception '% exam conversations still carry a category', v_exam; end if;
  select count(*) into v_backlog from de_conversations
   where channel in ('widget','hosted','portal','email','dock') and category is null
     and exists (select 1 from de_messages m where m.conversation_id=de_conversations.id and m.role='user');
  if v_backlog <> 0 then raise exception '% support conversations with a user message remain untriaged', v_backlog; end if;
end $$;

commit;
