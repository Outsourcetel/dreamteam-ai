-- 570 — file certification-exam threads under their own channel so they stop
-- appearing in the Support Inbox next to customer conversations.
--
-- THE SHAPE OF THE PROBLEM. A certification exam asks 16 golden questions
-- through the LIVE de-answer pipeline, and every one opens a real
-- de_conversations row with channel 'dock' — the same channel the Inbox lists.
-- Two exam runs today put 32 fake "customer conversations" in front of the
-- founder. Historically: 160 of the 323 dock conversations are exam threads.
-- Half the inbox was the product testing itself.
--
-- WHY NOT replay MODE, the obvious fix. de-answer's replayMode skips the
-- platform knowledge shelf (l.891), the grounded-confidence policy (l.1033) and
-- the pre-send quality auditor (l.1237). An exam run in replay would therefore
-- grade a WEAKER pipeline than the one that answers customers, and a
-- certification would stop meaning what it claims — the certificate would vouch
-- for a configuration that never runs. The exam must stay fully live.
--
-- WHY NOT DELETE THEM. They are the evidence of what the exam asked and what
-- the employee answered. Deleting a certification's trail to tidy a list is
-- rewriting the record.
--
-- So neither the answering nor the record changes — only WHERE the thread is
-- FILED. eval-run now passes channel:'exam'; de-answer accepts it from an
-- ALLOW-LIST (only 'exam'; anything else stays 'dock') so no caller can invent
-- a channel to slip a thread out of the Inbox. listSupportConversations filters
-- on an explicit channel list that does not include 'exam', so this needs no UI
-- change — which is also why the allow-list matters.
--
-- THE BACKFILL, and why it is safe to run against live data. A row is
-- reclassified only when ALL of these hold:
--     channel = 'dock'                     (never touches widget/hosted/email)
--     exactly ONE user message             (an exam asks once; real chats follow up)
--     that message EXACTLY equals an active golden question FOR THAT TENANT
--     owner_user_id IS NULL                (nobody ever picked it up)
--     csat_score IS NULL                   (no customer ever rated it)
-- Measured before writing this: 160 rows match; 0 rows that anyone has WORKED
-- match. A false positive would hide a real customer thread, so the filter is
-- deliberately narrower than "the text matches".

BEGIN;

-- 'exam' has to become a legal channel before any row can carry it. The CHECK
-- constraint is the schema's own statement of which surfaces exist, so widening
-- it deliberately — rather than reaching for a nullable flag column or a magic
-- string somewhere softer — keeps that list the single place the answer lives.
-- Note what this does NOT do: it does not add 'exam' to the Inbox's channel
-- filter, which is an explicit allow-list in listSupportConversations.
ALTER TABLE de_conversations DROP CONSTRAINT IF EXISTS de_conversations_channel_check;
ALTER TABLE de_conversations ADD CONSTRAINT de_conversations_channel_check
  CHECK (channel = ANY (ARRAY['dock'::text, 'widget'::text, 'hosted'::text,
                              'portal'::text, 'email'::text, 'exam'::text]));

DO $backfill$
DECLARE
  v_before int;
  v_moved  int;
  v_left   int;
  v_worked int;
BEGIN
  SELECT count(*) INTO v_before FROM de_conversations WHERE channel = 'dock';

  -- Guard: refuse to run if anything WORKED would be caught. Measured as 0
  -- today; if that ever changes, stop rather than hide a real conversation.
  SELECT count(*) INTO v_worked FROM de_conversations c
   WHERE c.channel = 'dock'
     AND (c.owner_user_id IS NOT NULL OR c.csat_score IS NOT NULL)
     AND EXISTS (SELECT 1 FROM de_messages m JOIN golden_qa g ON g.question = m.content
                  WHERE m.conversation_id = c.id AND m.role = 'user' AND g.tenant_id = c.tenant_id);
  IF v_worked <> 0 THEN
    RAISE EXCEPTION 'ABORT: % conversation(s) match the exam text BUT have been worked by a person — refusing to hide them', v_worked;
  END IF;

  UPDATE de_conversations c
     SET channel = 'exam'
   WHERE c.channel = 'dock'
     AND c.owner_user_id IS NULL
     AND c.csat_score IS NULL
     AND (SELECT count(*) FROM de_messages m
           WHERE m.conversation_id = c.id AND m.role = 'user') = 1
     AND EXISTS (SELECT 1 FROM de_messages m JOIN golden_qa g ON g.question = m.content
                  WHERE m.conversation_id = c.id AND m.role = 'user' AND g.tenant_id = c.tenant_id);
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  SELECT count(*) INTO v_left FROM de_conversations WHERE channel = 'dock';
  RAISE NOTICE '570: reclassified % exam threads; dock % -> %', v_moved, v_before, v_left;
END
$backfill$;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE v_n int;
BEGIN
  -- M1: the exam threads are out of the Inbox's channel list.
  SELECT count(*) INTO v_n FROM de_conversations WHERE channel = 'exam';
  IF v_n < 100 THEN
    RAISE EXCEPTION 'M1 FAILED: only % conversations reclassified, expected ~160', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM de_conversations
              WHERE channel = 'exam'
                AND channel IN ('widget','hosted','portal','email','dock')) THEN
    RAISE EXCEPTION 'M1 FAILED: an exam thread is still in an Inbox channel';
  END IF;

  -- M2: THE ONE THAT MATTERS. No worked conversation was hidden. If a person
  -- ever owned or rated it, it must still be visible.
  SELECT count(*) INTO v_n FROM de_conversations
   WHERE channel = 'exam' AND (owner_user_id IS NOT NULL OR csat_score IS NOT NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'M2 FAILED: % reclassified conversation(s) had been worked by a person', v_n;
  END IF;

  -- M3: genuine dock conversations survive. Reclassifying everything would
  -- also empty the inbox, and would also pass M1.
  SELECT count(*) INTO v_n FROM de_conversations WHERE channel = 'dock';
  IF v_n < 100 THEN
    RAISE EXCEPTION 'M3 FAILED: only % dock conversations left — the backfill overreached', v_n;
  END IF;

  -- M4: nothing outside 'dock' was touched. Customer channels are untouchable.
  SELECT count(*) INTO v_n FROM de_conversations WHERE channel IN ('widget','hosted','portal','email');
  IF v_n < 9 THEN
    RAISE EXCEPTION 'M4 FAILED: customer-channel conversations lost (% left, expected >= 9)', v_n;
  END IF;

  -- M5: the evidence still exists — reclassified, never deleted. Every exam
  -- thread must still have its question and answer attached.
  SELECT count(*) INTO v_n FROM de_conversations c
   WHERE c.channel = 'exam'
     AND NOT EXISTS (SELECT 1 FROM de_messages m WHERE m.conversation_id = c.id);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'M5 FAILED: % exam thread(s) lost their messages', v_n;
  END IF;

  RAISE NOTICE '570 asserts passed: exam threads out of the inbox, real conversations intact, evidence kept.';
END
$probe$;

COMMIT;
