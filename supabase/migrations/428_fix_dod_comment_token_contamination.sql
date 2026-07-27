-- 428_fix_dod_comment_token_contamination.sql
-- ============================================================================
-- Repairs a measurement defect introduced by migration 425 — mine, minutes
-- earlier. No behaviour changes; this edits one comment line.
--
-- ── Why a whole migration for a comment ──────────────────────────────────
-- Throughout wave 2, "is this function scoped, and by how many guards" is
-- measured by counting occurrences of the literal `can_access_de` in the live
-- body. docs/30 and the project memory both record that the invariant
--
--     occurrences of the token  ==  real guard calls
--
-- is what every independent verification in this wave depends on. Migration 414
-- failed its own assertion for breaking it (a comment mentioning the token
-- counted as a second guard), and the comments there were reworded rather than
-- loosening the counter, precisely so the invariant would keep holding.
--
-- Migration 425 then broke it again, in the other direction. Its injected
-- comment reads "...so can_access_de is the wrong tool and is not used" — which
-- is TRUE and worth saying, but it means assess_definition_of_done now matches
-- `like '%can_access_de%'` while containing no guard at all. Two consequences,
-- both bad and both silent:
--
--   1. the function reads as DE-scoped in any census that greps for the token,
--      when it is not scoped and correctly needs no scoping;
--   2. the standing "which SECURITY DEFINER functions still read a wave-1 table
--      unguarded" count EXCLUDES it, so a genuinely unguarded reader would be
--      hidden by a comment.
--
-- A wrong number that looks right is the failure mode this whole wave has been
-- guarding against. 425's tenant fix is correct and stays; only the wording
-- changes, to say the same thing without the literal token.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_old text := '  -- per-employee, so can_access_de is the wrong tool and is not used.';
  a_new text := '  -- per-employee, so the DE-scoping predicate is the wrong tool here and is';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assess_definition_of_done';
  IF v_src IS NULL THEN RAISE EXCEPTION '428: assess_definition_of_done not found'; END IF;

  IF v_src NOT LIKE '%can_access_de%' THEN
    RAISE NOTICE '428: already clean, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, a_old, ''))) / length(a_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '428: expected 1 contaminated comment line, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_old, a_new || ' not applied.');
  IF v_new = v_src THEN
    RAISE EXCEPTION '428: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assess_definition_of_done';

  -- The invariant this migration exists to restore: the token appears nowhere,
  -- because there is no guard here and there should be no appearance of one.
  IF v_def LIKE '%can_access_de%' THEN
    RAISE EXCEPTION '428: the token is still present — the census would still misread this function as scoped';
  END IF;

  -- ⚠ 425's actual fix must be untouched. Rewording a comment must not have
  -- cost the cross-tenant guard it was describing.
  IF v_def NOT LIKE '%not authorized for this workspace%' THEN
    RAISE EXCEPTION '428: the mig-425 tenant guard was lost — the cross-tenant hole is open again';
  END IF;
  IF v_def NOT LIKE '%p.tenant_id = p_tenant_id or p.layer = ''platform''%' THEN
    RAISE EXCEPTION '428: the tenant comparison was lost in the rewrite';
  END IF;
  IF position('not authorized for this workspace' in v_def) > position('from action_executions ae' in v_def) THEN
    RAISE EXCEPTION '428: the tenant guard is no longer ahead of the reads';
  END IF;
  IF v_def NOT LIKE '%v_unresolved := true%' OR v_def NOT LIKE '%pending_count%' THEN
    RAISE EXCEPTION '428: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.assess_definition_of_done(v_tenant, 'agentic_run',
             '00000000-0000-0000-0000-000000000000'::uuid, NULL) INTO v_out;
    IF v_out->>'verified' IS NULL THEN
      RAISE EXCEPTION '428: the function no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '428: counter invariant restored — token occurrences again equal real guard calls, wave-wide.';
END $assert$;

NOTIFY pgrst, 'reload schema';
