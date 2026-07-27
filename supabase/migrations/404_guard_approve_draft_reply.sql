-- 404_guard_approve_draft_reply.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors). See docs/30 and migration 403's header for
-- the group-B fix shape and the mixed-line-endings hazard.
--
-- approve_draft_reply(p_message_id, p_edited_content) is the LIVE approval
-- path: `src/lib/supportInboxApi.ts:74`. It flips a pending draft message to
-- `sent` — the moment an AI-written reply becomes a reply the customer
-- actually receives — and takes ownership of the conversation. Approving one
-- for an employee you are not responsible for is the exact harm group B is
-- about, and unlike approve_draft this one is wired into the product.
--
-- ── Resolving the employee: via the conversation, not the message ──────────
-- de_messages has NO de_id column. The employee is a property of the
-- conversation, so the guard resolves de_conversations.de_id using the
-- conversation id the function has already looked up. One extra lookup, placed
-- after the existing workspace check so the cheaper test still runs first.
--
-- ── Null de_id: the null-tolerant shape, matching migration 386 ────────────
-- de_conversations.de_id is NULLABLE (14 such rows in production). The guard is
--
--     IF v_de IS NOT NULL AND NOT can_access_de(v_de) THEN RAISE
--
-- which is the exact negation of the wave-1 policy predicate
-- `(de_id IS NULL OR can_access_de(de_id))`. Same rule, same answer, expressed
-- as a refusal instead of a filter. Writing a bare `NOT can_access_de(v_de)`
-- here would make the actor stricter than the reader — a scoped user could SEE
-- an unattributed conversation and be unable to act on it, which is the
-- inconsistency migrations 400-402 had to correct in group A. Not repeating it.
--
-- The existing workspace-membership check is KEPT, not replaced: role ("which
-- doors") and assignment ("which rooms") are separate axes per docs/29.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'declare v_tenant uuid; v_conv uuid;';
  a_upd  text; v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_draft_reply';
  IF v_src IS NULL THEN RAISE EXCEPTION '404: approve_draft_reply not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '404: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_upd := '  update de_messages' || v_eol || '    set delivery = ''sent''';

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/404). The employee lives on the CONVERSATION —',
    '  -- de_messages has no de_id. Null-tolerant to match the mig-386 policy:',
    '  -- an unattributed conversation is actionable by anyone in the workspace,',
    '  -- exactly as it is readable by them.',
    '  select de_id into v_de from de_conversations where id = v_conv;',
    '  if v_de is not null and not public.can_access_de(v_de) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_upd]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '404: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_conv uuid; v_de uuid;');
  v_new := replace(v_new, a_upd, v_guard || v_eol || a_upd);

  IF v_new = v_src THEN
    RAISE EXCEPTION '404: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_draft_reply';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '404: expected exactly 1 guard, found %', v_guards;
  END IF;

  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '404: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  -- The null-tolerant shape is the whole point of this migration's reasoning.
  -- A bare NOT can_access_de would make the actor stricter than the reader.
  IF v_def NOT LIKE '%v_de is not null and not public.can_access_de(v_de)%' THEN
    RAISE EXCEPTION '404: the guard is not null-tolerant — it would diverge from the mig-386 policy';
  END IF;
  -- Order: guard before BOTH mutations.
  IF position('can_access_de' in v_def) > position('update de_messages' in v_def)
     OR position('can_access_de' in v_def) > position('update de_conversations' in v_def) THEN
    RAISE EXCEPTION '404: the guard lands after a mutation — the row is changed before it is checked';
  END IF;
  -- Both pre-existing gates must survive: authentication and workspace
  -- membership are the OTHER axis and are not replaced by scoping.
  IF v_def NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '404: the authentication check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not authorized for this workspace%' THEN
    RAISE EXCEPTION '404: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not_a_pending_draft%' OR v_def NOT LIKE '%human_owned%' THEN
    RAISE EXCEPTION '404: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: postgres has a null auth.uid(), so the first gate fires.
  BEGIN
    PERFORM public.approve_draft_reply('00000000-0000-0000-0000-000000000000'::uuid, NULL);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '404: expected the authentication gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '404: approve_draft_reply guarded — the live approve path (supportInboxApi.ts:74).';
END $assert$;

NOTIFY pgrst, 'reload schema';
