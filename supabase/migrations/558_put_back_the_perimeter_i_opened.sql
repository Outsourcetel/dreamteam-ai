-- 558 — close the perimeter 556 opened, and drop the reader for a queue that
-- is not being built.
--
-- The invariant suite caught this, which is what it is for:
--   "the 25 revoked functions stay revoked"
--   expected [ 'reject_draft' ] to deeply equal []
--
-- 556 granted EXECUTE on reject_draft to `authenticated` so a draft review
-- screen could reject something. reject_draft is on the authenticated-perimeter
-- revoke list, and I moved it off that list without noticing.
--
-- The grant is also now pointless. 556 was written BEFORE tracing the estate
-- turned up three parallel draft mechanisms and showed that a queue on
-- draft_responses would be a fourth review surface for a problem the Support
-- Inbox and human_tasks already solve. Internal reply-mode now files a
-- "Reply to approve" human task instead, so NOTHING in the app reads or writes
-- draft_responses. A grant made for a screen that was then deliberately not
-- built is pure surface.
--
-- list_pending_drafts() goes the same way and for the same reason: I added it in
-- 556 as that queue's reader. There is no queue. Leaving a new SECURITY DEFINER
-- function reachable by every signed-in user, to serve a screen that does not
-- exist, is exactly the "written and never read" pattern this codebase keeps
-- paying for.
--
-- WHAT 556 KEEPS, deliberately: the TRUNCATE/DELETE/UPDATE revoke from
-- authenticated, the anon revoke, and the single ANDed RLS policy. Those were
-- real holes — authenticated could TRUNCATE the table and TRUNCATE ignores RLS
-- entirely — and they stay fixed whether or not anything reads the table today.

BEGIN;

-- Back onto the perimeter. The function stays FIXED (555 gave it a real tenant
-- check and a pinned search_path); it is simply not reachable from a browser.
REVOKE EXECUTE ON FUNCTION public.reject_draft(uuid, text) FROM authenticated;

DROP FUNCTION IF EXISTS public.list_pending_drafts();

DO $probe$
DECLARE v_n INT;
BEGIN
  IF has_function_privilege('authenticated', 'public.reject_draft(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAILED: authenticated can still execute reject_draft — the perimeter is still open';
  END IF;
  IF to_regprocedure('public.list_pending_drafts()') IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: list_pending_drafts still exists';
  END IF;

  -- And the 556 fixes that MUST survive this migration: re-asserted here so a
  -- later reader can see they were not quietly reverted along with the grant.
  IF has_table_privilege('authenticated', 'draft_responses', 'TRUNCATE') THEN
    RAISE EXCEPTION 'FAILED: authenticated can TRUNCATE draft_responses again';
  END IF;
  IF has_table_privilege('anon', 'draft_responses', 'SELECT') THEN
    RAISE EXCEPTION 'FAILED: anon can SELECT draft_responses again';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename = 'draft_responses' AND cmd IN ('SELECT', 'ALL');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAILED: % SELECT/ALL policies on draft_responses, expected 1', v_n;
  END IF;

  RAISE NOTICE '558: perimeter restored, unused reader dropped, 556 security fixes intact.';
END
$probe$;

COMMIT;
