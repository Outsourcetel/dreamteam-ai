-- 406_guard_send_human_reply.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors). See docs/30 and migration 403's header.
--
-- send_human_reply(p_conversation_id, p_content) is the bluntest actor in the
-- whole worklist: it INSERTS a message straight into a customer conversation
-- with `delivery = 'sent'` and `confidence = 100`, then takes ownership of the
-- thread. There is no draft, no approval, no second look. Live at
-- `src/lib/supportInboxApi.ts:69`.
--
-- Unscoped, a person assigned to one employee could speak into any
-- conversation belonging to any other employee in the workspace, and the
-- message would be indistinguishable from a legitimate one.
--
-- ── What was already there, and what was not ───────────────────────────────
-- `_assert_conv_member(p_conversation_id)` — a group-C internal — already
-- checks WORKSPACE membership and returns the tenant. That is the role axis and
-- it is kept untouched. It says nothing about WHICH EMPLOYEE the conversation
-- belongs to, which is the assignment axis and the gap this closes.
--
-- ── Null-tolerant, matching migration 386 ──────────────────────────────────
-- de_conversations.de_id is nullable, so the guard is
-- `if v_de is not null and not can_access_de(v_de)` — the exact negation of the
-- wave-1 policy `(de_id IS NULL OR can_access_de(de_id))`. Same reasoning as
-- 404: an actor stricter than the corresponding reader is the divergence
-- migrations 400-402 had to undo in group A.
--
-- The guard goes after _assert_conv_member and before the INSERT, so the
-- cheaper workspace test still fails first and a non-member never learns
-- whether the conversation exists.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'declare v_tenant uuid; v_id uuid;';
  a_ins  text := '  insert into de_messages (tenant_id, conversation_id, role, content, confidence, escalated, delivery)';
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'send_human_reply';
  IF v_src IS NULL THEN RAISE EXCEPTION '406: send_human_reply not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '406: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/406). _assert_conv_member above proved WORKSPACE',
    '  -- membership; this proves responsibility for the EMPLOYEE. Two axes,',
    '  -- both required. Null-tolerant to match the mig-386 policy.',
    '  select de_id into v_de from de_conversations where id = p_conversation_id;',
    '  if v_de is not null and not public.can_access_de(v_de) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_ins]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '406: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_id uuid; v_de uuid;');
  v_new := replace(v_new, a_ins, v_guard || v_eol || a_ins);

  IF v_new = v_src THEN
    RAISE EXCEPTION '406: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'send_human_reply';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '406: expected exactly 1 guard, found %', v_guards;
  END IF;

  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '406: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  IF v_def NOT LIKE '%v_de is not null and not public.can_access_de(v_de)%' THEN
    RAISE EXCEPTION '406: the guard is not null-tolerant — it would diverge from the mig-386 policy';
  END IF;
  -- The workspace check must still run, and must still run FIRST.
  IF v_def NOT LIKE '%_assert_conv_member%' THEN
    RAISE EXCEPTION '406: _assert_conv_member was lost — the workspace axis is gone';
  END IF;
  -- Membership must come FIRST. If _assert_conv_member appears later in the
  -- body than the scope guard, the order is wrong and a non-member would learn
  -- whether the conversation exists before being turned away.
  IF position('_assert_conv_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '406: the scope guard runs before the workspace check — a non-member would learn whether the conversation exists';
  END IF;
  -- Guard before BOTH mutations.
  IF position('can_access_de' in v_def) > position('insert into de_messages' in v_def)
     OR position('can_access_de' in v_def) > position('update de_conversations' in v_def) THEN
    RAISE EXCEPTION '406: the guard lands after a mutation — the message is sent before it is checked';
  END IF;
  IF v_def NOT LIKE '%empty_message%' OR v_def NOT LIKE '%human_owned%' THEN
    RAISE EXCEPTION '406: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: the empty-content check is the first gate and needs no
  -- identity, so it must fire for postgres too.
  BEGIN
    PERFORM public.send_human_reply('00000000-0000-0000-0000-000000000000'::uuid, '   ');
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%empty_message%' THEN
    RAISE EXCEPTION '406: expected the empty_message gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '406: send_human_reply guarded — the no-approval send path (supportInboxApi.ts:69).';
END $assert$;

NOTIFY pgrst, 'reload schema';
