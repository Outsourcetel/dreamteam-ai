-- 555 — the draft-review leg, which could never once have run.
--
-- Found by 554's probe: with the config table restored and de-answer reading the
-- flag correctly, the draft leg STILL failed —
--   ERROR 42704: unrecognized configuration parameter "app.current_tenant_id"
--
-- All five functions of the reply-mode feature resolve the tenant like this:
--     v_tenant_id := current_setting('app.current_tenant_id')::uuid;
-- Nothing in this codebase has ever SET that GUC. Supabase does not set it, and
-- `current_setting` WITHOUT the missing_ok second argument RAISES rather than
-- returning NULL — so submit_draft_for_review's very next line,
--     IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'app.current_tenant_id not set'
-- is unreachable code guarding against a case that can never be reached.
-- It is the same pattern as the RLS policies in the never-applied
-- 20260719225435 migration, which 554 deliberately refused to copy.
--
-- SO THE FEATURE WAS BROKEN IN FOUR INDEPENDENT PLACES:
--   1. de_config did not exist                       → fixed in 554
--   2. set_de_config's ON CONFLICT was ambiguous     → fixed in 554
--   3. de-answer read `.data` on an array            → fixed + deployed
--   4. every draft function raised on the GUC        → this migration
-- Each one alone was enough to keep `draft_responses` empty forever, which is
-- exactly what it has been: zero rows, ever.
--
-- These functions were AMENDED repeatedly while dead — migs 385/395/396/403 added
-- DE reporting-line scoping, 457 added the learning-edit training pair. Real care
-- went into functions that raised on their sixth line every time. That is the cost
-- of a feature no test ever called.
--
-- WHERE THE TENANT COMES FROM NOW. Not a GUC — the data:
--   submit_draft_for_review  → digital_employees.tenant_id for p_de_id, then
--                              _assert_caller_tenant (permits the service role,
--                              which is what de-answer calls with, and validates
--                              a real signed-in user against their own tenant).
--   the other four           → public.auth_tenant_id(), this codebase's standard
--                              caller-identity function. It returns NULL for the
--                              service role, so `tenant_id = auth_tenant_id()`
--                              matches nothing — fail-closed, never a cross-tenant
--                              read. Resolving from the ROW's own tenant_id would
--                              have been circular and matched every tenant.
--
-- ALSO: all five are SECURITY DEFINER with NO pinned search_path — a real
-- injection surface on functions that write. Pinned here. Existing schema
-- qualification is kept, not removed, so the change is additive.
--
-- CREATE OR REPLACE throughout: DROP+CREATE would RESET THE GRANTS on five
-- governance functions.
--
-- ⚠ THIS DOES NOT MAKE reply-mode SAFE TO ENABLE YET. approve_draft,
-- reject_draft, get_pending_draft and get_pending_drafts_for_de have ZERO
-- callers anywhere in the app. Switch reply-mode on today and answers become
-- drafts that no screen can approve — the employee goes quiet until they expire.
-- The switch stays OFF everywhere. The review UI is the next piece of work.

BEGIN;

-- ── 1. submit_draft_for_review — the leg de-answer calls ────────────────────
-- Signature reproduced EXACTLY from the live definition, so this replaces the
-- function rather than adding a second overload beside it.
CREATE OR REPLACE FUNCTION public.submit_draft_for_review(
  p_de_id uuid, p_conversation_id uuid, p_user_question text,
  p_draft_content text, p_confidence numeric DEFAULT NULL::numeric,
  p_sources jsonb DEFAULT '[]'::jsonb, p_review_timeout_minutes integer DEFAULT 30)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_draft_id UUID;
  v_tenant_id UUID;
BEGIN
  -- The employee decides the workspace. A draft cannot belong anywhere else.
  SELECT tenant_id INTO v_tenant_id FROM digital_employees WHERE id = p_de_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'de_not_found: no such employee, so no workspace to file the draft under';
  END IF;
  -- SECURITY DEFINER + a caller-supplied id: without this, any signed-in user
  -- could file a draft against another workspace's employee.
  PERFORM public._assert_caller_tenant(v_tenant_id);

  INSERT INTO draft_responses (
    tenant_id, de_id, conversation_id, user_question,
    draft_content, confidence, sources, expires_at
  ) VALUES (
    v_tenant_id, p_de_id, p_conversation_id, p_user_question,
    p_draft_content, p_confidence, COALESCE(p_sources, '[]'::jsonb),
    now() + (p_review_timeout_minutes || ' minutes')::interval
  )
  RETURNING draft_id INTO v_draft_id;

  RETURN json_build_object(
    'draft_id', v_draft_id,
    'de_id', p_de_id,
    'conversation_id', p_conversation_id,
    'user_question', p_user_question,
    'draft_content', p_draft_content,
    'confidence', p_confidence,
    'sources', COALESCE(p_sources, '[]'::jsonb),
    'created_at', now()::text,
    'expires_at', (now() + (p_review_timeout_minutes || ' minutes')::interval)::text
  );
END;
$function$;

-- ── 2. get_pending_draft ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_pending_draft(p_draft_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT json_build_object(
      'draft_id', draft_id, 'de_id', de_id, 'conversation_id', conversation_id,
      'user_question', user_question, 'draft_content', draft_content,
      'confidence', confidence, 'sources', sources,
      'created_at', created_at::text, 'expires_at', expires_at::text
    )
    FROM draft_responses
    WHERE draft_id = p_draft_id
      AND status = 'pending'
      AND expires_at > now()
      AND tenant_id = public.auth_tenant_id()
      -- DE scoping (mig 385/395): a draft belongs to one employee, and
      -- draft_responses.de_id is NOT NULL, so there is no null case here.
      AND public.can_access_de(de_id)
  );
END;
$function$;

-- ── 3. get_pending_drafts_for_de ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_pending_drafts_for_de(p_de_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN json_agg(
    json_build_object(
      'draft_id', draft_id, 'de_id', de_id, 'conversation_id', conversation_id,
      'user_question', user_question, 'draft_content', draft_content,
      'confidence', confidence, 'sources', sources,
      'created_at', created_at::text, 'expires_at', expires_at::text
    )
  ) FILTER (WHERE draft_id IS NOT NULL)
  FROM draft_responses
  WHERE de_id = p_de_id
    AND status = 'pending'
    AND expires_at > now()
    AND tenant_id = public.auth_tenant_id()
    -- Kept schema-qualified even though search_path is now pinned: belt and
    -- braces cost nothing and removing it would be a silent widening.
    AND public.can_access_de(de_id);
END;
$function$;

-- ── 4. approve_draft ────────────────────────────────────────────────────────
-- Body reproduced from the LIVE definition; only tenant resolution and
-- search_path change. The mig-457 training pair is preserved exactly, including
-- its "an unedited approval is not an edit" rule.
CREATE OR REPLACE FUNCTION public.approve_draft(
  p_draft_id uuid, p_edited_content text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_de_id UUID;
  v_before TEXT;
  v_tenant UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no_workspace: this account is not attached to a workspace';
  END IF;

  -- DE scoping (mig 385/403). Resolve the row FIRST, on exactly the same
  -- terms the UPDATE below uses, then refuse. draft_responses.de_id is NOT
  -- NULL, so a null here means no such draft in this workspace.
  SELECT de_id, draft_content INTO v_de_id, v_before
    FROM draft_responses
   WHERE draft_id = p_draft_id AND tenant_id = v_tenant;

  IF v_de_id IS NULL THEN
    RAISE EXCEPTION 'draft_not_found: no such draft in this workspace';
  END IF;
  IF NOT public.can_access_de(v_de_id) THEN
    RAISE EXCEPTION 'not_responsible_for_de: this employee is not in your reporting line';
  END IF;

  UPDATE draft_responses
     SET status = 'approved',
         draft_content = COALESCE(p_edited_content, draft_content),
         edited_content = p_edited_content,
         approved_at = now(),
         approved_by = v_user_id
   WHERE draft_id = p_draft_id AND tenant_id = v_tenant;

  -- Training pair (mig 457). Only when the approver actually changed
  -- something; an unedited approval is not an edit. Written AFTER the
  -- update so a failed approval leaves no learning row claiming otherwise.
  IF p_edited_content IS NOT NULL
     AND btrim(p_edited_content) <> btrim(coalesce(v_before, '')) THEN
    INSERT INTO de_learning_edits (tenant_id, de_id, source_kind, source_id,
                                   before_text, after_text, note, edited_by)
    VALUES (v_tenant, v_de_id, 'draft_response', p_draft_id, v_before,
            p_edited_content, nullif(btrim(coalesce(p_notes, '')), ''), v_user_id);
  END IF;

  RETURN json_build_object('ok', true);
END;
$function$;

-- ── 5. reject_draft ─────────────────────────────────────────────────────────
-- The live version reported ok:true whether or not anything was updated, so a
-- rejection aimed at another workspace's draft looked successful. Now it says so.
CREATE OR REPLACE FUNCTION public.reject_draft(p_draft_id uuid, p_reason text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_tenant UUID;
  v_rows INT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no_workspace: this account is not attached to a workspace';
  END IF;

  UPDATE draft_responses
     SET status = 'rejected', rejected_at = now(), rejected_by = v_user_id
   WHERE draft_id = p_draft_id AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'draft_not_found: no such draft in this workspace';
  END IF;

  RETURN json_build_object('ok', true);
END;
$function$;

-- ── 6. Behavioural asserts ──────────────────────────────────────────────────
-- Would these pass if the feature were broken? No — every one of these calls
-- raises 42704 on the CURRENT definitions, which is precisely why draft_responses
-- has never held a row.
-- Would they pass if this change were a no-op? Same answer: 42704.
--
-- HONEST LIMIT, stated rather than papered over: approve_draft and reject_draft
-- check auth.uid() FIRST and raise 'Not authenticated' before ever reaching the
-- tenant lookup. A migration runs with a NULL auth.uid(), so their happy path
-- CANNOT be exercised here without forging an auth session, which this project
-- does not do. Their fix is identical in kind to the three proven below, but it
-- is INFERRED, not proven. It needs a signed-in click to confirm.
DO $probe$
DECLARE
  v_de     UUID;
  v_tenant UUID;
  v_resp   JSONB;
  v_before INT;
  v_after  INT;
  v_row    draft_responses;
  v_ignore JSON;
BEGIN
  SELECT id, tenant_id INTO v_de, v_tenant
    FROM digital_employees ORDER BY created_at LIMIT 1;
  IF v_de IS NULL THEN
    RAISE EXCEPTION 'ASSERT SETUP FAILED: no digital employee exists to probe with';
  END IF;

  BEGIN
    SELECT count(*) INTO v_before FROM draft_responses;

    -- B1: the write leg de-answer depends on. Raises 42704 today.
    v_resp := submit_draft_for_review(v_de, gen_random_uuid(),
                'probe: what are your support hours?',
                'We are open 9-5, Monday to Friday.', 0.91,
                '[{"title":"probe","url":""}]'::jsonb, 60)::jsonb;

    SELECT count(*) INTO v_after FROM draft_responses;
    IF v_after <> v_before + 1 THEN
      RAISE EXCEPTION 'B1 FAILED: draft_responses % -> %, expected exactly +1', v_before, v_after;
    END IF;
    IF v_resp->>'draft_id' IS NULL THEN
      RAISE EXCEPTION 'B1 FAILED: no draft_id returned — de-answer keys off this exact field';
    END IF;

    -- B2: the draft landed in the EMPLOYEE'S workspace, not a GUC's idea of one.
    SELECT * INTO v_row FROM draft_responses
      WHERE draft_id = (v_resp->>'draft_id')::uuid;
    IF v_row.tenant_id IS DISTINCT FROM v_tenant THEN
      RAISE EXCEPTION 'B2 FAILED: draft filed under tenant %, employee belongs to %',
                      v_row.tenant_id, v_tenant;
    END IF;
    IF v_row.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'B2 FAILED: draft status is %, expected pending (nothing to review otherwise)',
                      v_row.status;
    END IF;

    -- B3: the two readers no longer RAISE. They return nothing here because
    -- auth_tenant_id() is NULL for this caller — that is the fail-closed
    -- behaviour we want, and it is a clean return rather than an error.
    v_ignore := get_pending_draft((v_resp->>'draft_id')::uuid);
    IF v_ignore IS NOT NULL THEN
      RAISE EXCEPTION 'B3 FAILED: get_pending_draft returned data to a caller with no workspace: %', v_ignore;
    END IF;
    v_ignore := get_pending_drafts_for_de(v_de);
    IF v_ignore IS NOT NULL THEN
      RAISE EXCEPTION 'B3 FAILED: get_pending_drafts_for_de leaked to a caller with no workspace: %', v_ignore;
    END IF;

    RAISE NOTICE '555 asserts passed: a draft is created, filed to the right workspace, and the readers fail closed.';
    RAISE EXCEPTION 'probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'probe_rollback' THEN RAISE; END IF;
  END;
END
$probe$;

COMMIT;
