-- 405_guard_edit_outbound_draft.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors). See docs/30 and migration 403's header.
--
-- edit_outbound_draft(p_draft_id, p_body) rewrites the BODY of an outbound
-- draft awaiting approval — live at `src/lib/supportInboxApi.ts:143`. The harm
-- if unscoped is subtle and worse than it first looks: this is the edit step
-- BEFORE the approval step, so changing the text of another employee's pending
-- draft puts words in that employee's mouth, and the approver downstream sees
-- only the edited version. Nothing in the approval flow re-reads the original.
--
-- ── Resolution costs nothing extra here ────────────────────────────────────
-- The body already runs `select tenant_id into v_tenant from outbound_drafts
-- where id = ... and status = 'pending_approval'`. The employee comes off the
-- same row, so the guard extends that SELECT rather than adding a second one —
-- and it is therefore guaranteed to be the same row the UPDATE will touch.
--
-- outbound_drafts.de_id is NOT NULL, so a plain `not can_access_de(v_de)` is
-- correct here; there is no unattributed case, and the existing
-- `not_a_pending_draft` check already handles a missing row. Contrast 404,
-- where de_conversations.de_id is nullable and the guard must be null-tolerant
-- to stay consistent with the migration-386 policy.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'declare v_tenant uuid;';
  a_sel  text := 'select tenant_id into v_tenant from outbound_drafts where id = p_draft_id and status = ''pending_approval'';';
  a_upd  text := '  update outbound_drafts set body = btrim(p_body), updated_at = now() where id = p_draft_id;';
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'edit_outbound_draft';
  IF v_src IS NULL THEN RAISE EXCEPTION '405: edit_outbound_draft not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '405: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/405). outbound_drafts.de_id is NOT NULL and comes',
    '  -- off the very row the UPDATE below will touch, so no null case and no',
    '  -- chance of guarding a different row than the one being changed.',
    '  if not public.can_access_de(v_de) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_sel, a_upd]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '405: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_de uuid;');
  v_new := replace(v_new, a_sel,
    'select tenant_id, de_id into v_tenant, v_de from outbound_drafts where id = p_draft_id and status = ''pending_approval'';');
  v_new := replace(v_new, a_upd, v_guard || v_eol || a_upd);

  IF v_new = v_src THEN
    RAISE EXCEPTION '405: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_nullable text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'edit_outbound_draft';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '405: expected exactly 1 guard, found %', v_guards;
  END IF;

  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '405: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  -- The guard is only sound if v_de is actually populated from the draft row.
  IF v_def NOT LIKE '%select tenant_id, de_id into v_tenant, v_de from outbound_drafts%' THEN
    RAISE EXCEPTION '405: v_de is not resolved from the draft row — the guard would test a null';
  END IF;
  IF position('can_access_de' in v_def) > position('update outbound_drafts' in v_def) THEN
    RAISE EXCEPTION '405: the guard lands AFTER the UPDATE — the row is mutated before it is checked';
  END IF;
  IF v_def NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '405: the authentication check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not authorized for this workspace%' THEN
    RAISE EXCEPTION '405: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%min 10 chars%' OR v_def NOT LIKE '%not_a_pending_draft%' THEN
    RAISE EXCEPTION '405: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- The NOT NULL claim justifies the non-null-tolerant guard shape. Assert it.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'outbound_drafts' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '405: outbound_drafts.de_id is nullable — this guard needs the null-tolerant shape used in 404';
  END IF;

  BEGIN
    PERFORM public.edit_outbound_draft('00000000-0000-0000-0000-000000000000'::uuid, 'a body long enough to pass');
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '405: expected the authentication gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '405: edit_outbound_draft guarded — live at supportInboxApi.ts:143.';
END $assert$;

NOTIFY pgrst, 'reload schema';
