-- 544_dropping_a_function_drops_its_grants_too.sql
-- ============================================================================
-- The knowledge invariant suite caught two anon-executable RPCs immediately
-- after 543. Both are mine, and the second is the instructive one.
--
--   knowledge_unfiled_count   new in 543, never revoked. My omission.
--   search_knowledge_docs     ALREADY had anon revoked. 543 needed to add a
--                             parameter, and adding a DEFAULTed parameter
--                             creates a second overload rather than replacing
--                             the function — so 543 DROPPED the old signature
--                             and created the new one. A DROP takes the
--                             function's GRANTS with it, and CREATE starts from
--                             the default, which grants EXECUTE to PUBLIC.
--
-- So a migration whose subject was "make unfiled documents reachable" silently
-- re-opened a search RPC to anonymous callers. Nothing in the diff looked like
-- a permission change; the privilege was collateral damage of the drop.
--
-- ⚠ THE RULE: any migration that DROPs and recreates a function must restate
-- its REVOKEs. The grant is not part of the body you carefully reproduced, so
-- reproducing the body faithfully is not enough.
--
-- Neither function leaks data — both resolve the tenant from the caller and
-- return nothing without one — but "it returns nothing anyway" is exactly the
-- reasoning that mig 330 had to undo across 26 RPCs. anon shares a NULL
-- auth.uid() with service role, so a guard written against the UID cannot tell
-- them apart, and the perimeter is the grant.
-- ============================================================================

REVOKE ALL ON FUNCTION public.knowledge_unfiled_count() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_knowledge_docs(text,text[],text,text,uuid,boolean,integer,integer,text,boolean)
  FROM PUBLIC, anon;

notify pgrst, 'reload schema';

DO $a$
DECLARE v_bad text := '';
BEGIN
  -- Would this pass if the revokes were a no-op? No — both were anon-executable
  -- a moment ago, which is how the suite found them.
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE '%knowledge%'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF coalesce(v_bad, '') <> '' THEN
    RAISE EXCEPTION '544: still anon-executable: %', v_bad;
  END IF;

  -- ...and a signed-in user must still be able to search, or the Library goes
  -- blank for everyone. Revoking too widely is the other way to break this.
  IF NOT has_function_privilege('authenticated',
        'public.search_knowledge_docs(text,text[],text,text,uuid,boolean,integer,integer,text,boolean)'::regprocedure,
        'EXECUTE') THEN
    RAISE EXCEPTION '544: the revoke also cut off authenticated — the Library would show nothing';
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.knowledge_unfiled_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '544: authenticated cannot read the unfiled count — the new tree node would always show zero';
  END IF;

  RAISE NOTICE '544: no knowledge RPC is anon-executable; authenticated retains both';
END $a$;
