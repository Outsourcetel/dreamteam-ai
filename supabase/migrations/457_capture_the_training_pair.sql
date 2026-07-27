-- 457_capture_the_training_pair.sql
-- ============================================================================
-- docs/34 increment 3: stop destroying the most valuable signal in the product.
--
-- ── The finding ──────────────────────────────────────────────────────────
-- Two approval paths ALREADY let a human correct an employee's work before it
-- goes out. Both then overwrite the original, so the correction survives and
-- the thing it corrected does not:
--
--   approve_draft        draft_content = COALESCE(p_edited_content, draft_content)
--                        edited_content = p_edited_content
--                        → after an edit BOTH columns hold the edited text.
--                          The original is gone.
--
--   approve_draft_reply  content = coalesce(nullif(trim(p_edited_content),''), content)
--                        → de_messages.content IS the delivered message, so it
--                          MUST become the edit. The original is gone.
--
-- An `(original, corrected)` pair is a supervised training example written by
-- the person best placed to know, at the moment of work, at zero marginal cost.
-- A correction on its own is just the current value: it says nothing about what
-- was wrong. We have been generating the best signal available and discarding
-- half of it on every edit.
--
-- ── Why a side table rather than fixing the overwrite ────────────────────
-- Tempting to simply stop clobbering `draft_content` — the column pair already
-- exists. Rejected: something downstream sends `draft_content`, and leaving the
-- ORIGINAL there would deliver the un-corrected text to a customer. The
-- overwrite is load-bearing on the delivery path, and this migration must not
-- touch what gets sent. For de_messages there is no choice at all: `content` is
-- the message.
--
-- So: capture BEFORE the update, into a table of its own. Nothing about
-- delivery changes. Purely additive.
--
-- ── One corpus, not two ─────────────────────────────────────────────────
-- `human_tasks.decision_edit` (mig 455) already holds the pair for task
-- decisions. This table takes the draft paths and uses the SAME closed reason
-- vocabulary, so edits from every surface aggregate into one answer to "what
-- does this employee get wrong". Two stores with two shapes could not be added
-- up — the same argument that made rejections and edits share a vocabulary.
--
-- Scoped like every other DE-attached table in this wave: RLS on, tenant +
-- null-tolerant can_access_de, SELECT only for clients. Writes come exclusively
-- from the two SECURITY DEFINER functions below, so there is no client write
-- path to guard.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.de_learning_edits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  de_id        uuid REFERENCES public.digital_employees(id) ON DELETE SET NULL,
  source_kind  text NOT NULL CHECK (source_kind IN ('draft_response', 'de_message', 'human_task')),
  source_id    uuid NOT NULL,
  before_text  text NOT NULL,
  after_text   text NOT NULL,
  reason_code  text,
  note         text,
  edited_by    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Same closed vocabulary as human_tasks (mig 455). Kept identical on purpose:
  -- edits and rejections must aggregate together or neither number means much.
  CONSTRAINT de_learning_edits_reason_code_check CHECK (
    reason_code IS NULL OR reason_code IN (
      'wrong_facts','wrong_tone','missing_context','incomplete',
      'not_permitted','customer_specific','other')),
  -- A "pair" where both halves are equal is not an edit; it is noise that would
  -- dilute every rate computed from this table.
  CONSTRAINT de_learning_edits_actually_changed_check CHECK (btrim(before_text) <> btrim(after_text))
);

COMMENT ON TABLE public.de_learning_edits IS
  'The (before, after) training pairs produced when a human corrected an employee''s work before approving it. Written only by SECURITY DEFINER approval functions; the source records overwrite their originals, so this is the only place the pair survives.';

CREATE INDEX IF NOT EXISTS de_learning_edits_de_idx     ON public.de_learning_edits (de_id, created_at DESC);
CREATE INDEX IF NOT EXISTS de_learning_edits_tenant_idx ON public.de_learning_edits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS de_learning_edits_reason_idx ON public.de_learning_edits (tenant_id, reason_code) WHERE reason_code IS NOT NULL;

ALTER TABLE public.de_learning_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS de_learning_edits_select ON public.de_learning_edits;
CREATE POLICY de_learning_edits_select ON public.de_learning_edits
  FOR SELECT USING (tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS de_learning_edits_de_scope ON public.de_learning_edits;
CREATE POLICY de_learning_edits_de_scope ON public.de_learning_edits
  AS RESTRICTIVE FOR SELECT
  USING ((de_id IS NULL) OR public.can_access_de(de_id));

-- Read-only to clients. No INSERT/UPDATE/DELETE grant at all: the only writers
-- are the SECURITY DEFINER functions below, which means there is no client
-- write path that could need a guard. (RLS without a GRANT is a table nobody
-- can read — mig 379's lesson — so SELECT is granted explicitly.)
-- ⚠ REVOKE FIRST. Supabase's default privileges grant a new public table to
-- `authenticated` on creation, so the write privileges exist before this file
-- says anything — only RLS default-deny (no permissive INSERT policy) would be
-- stopping them. That is a safety resting on something being ABSENT rather than
-- enforced: the day someone adds a permissive write policy for an unrelated
-- reason, writes open with no DE scoping behind them. Caught by this
-- migration's own assertion on the first run.
REVOKE ALL ON public.de_learning_edits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.de_learning_edits TO authenticated;

-- ── approve_draft: capture before the overwrite ───────────────────────────
DO $patch1$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int;
  a_decl text := '  v_de_id UUID;';
  a_sel  text := '  SELECT de_id INTO v_de_id';
  a_ret  text := '  RETURN json_build_object(''ok'', true);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='approve_draft';
  IF v_src IS NULL THEN RAISE EXCEPTION '457: approve_draft not found'; END IF;
  IF v_src LIKE '%de_learning_edits%' THEN RAISE NOTICE '457: approve_draft already captures'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  FOR v_hits IN SELECT (length(v_src)-length(replace(v_src,a,'')))/length(a)
                  FROM unnest(ARRAY[a_decl,a_sel,a_ret]) a LOOP
    IF v_hits <> 1 THEN RAISE EXCEPTION '457: an approve_draft anchor matched % times', v_hits; END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, '  v_de_id UUID;' || v_eol || '  v_before TEXT;');
  -- Same statement that already resolves the DE, so the captured original is
  -- guaranteed to be the row the UPDATE below will overwrite.
  v_new := replace(v_new, a_sel, '  SELECT de_id, draft_content INTO v_de_id, v_before');
  v_new := replace(v_new, a_ret, array_to_string(ARRAY[
    '  -- Training pair (mig 457). Only when the approver actually changed',
    '  -- something; an unedited approval is not an edit. Written AFTER the',
    '  -- update so a failed approval leaves no learning row claiming otherwise.',
    '  IF p_edited_content IS NOT NULL',
    '     AND btrim(p_edited_content) <> btrim(coalesce(v_before, '''')) THEN',
    '    INSERT INTO de_learning_edits (tenant_id, de_id, source_kind, source_id,',
    '                                   before_text, after_text, note, edited_by)',
    '    VALUES (current_setting(''app.current_tenant_id'')::uuid, v_de_id,',
    '            ''draft_response'', p_draft_id, v_before, p_edited_content,',
    '            nullif(btrim(coalesce(p_notes, '''')), ''''), v_user_id);',
    '  END IF;',
    '',
    a_ret], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '457: approve_draft edit did not land'; END IF;
  EXECUTE v_new;
END $patch1$;

-- ── approve_draft_reply: capture before the delivered content changes ─────
DO $patch2$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int;
  a_decl text := 'declare v_tenant uuid; v_conv uuid; v_de uuid;';
  a_sel  text := '  select tenant_id, conversation_id into v_tenant, v_conv';
  a_end  text := '  where id = v_conv;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='approve_draft_reply';
  IF v_src IS NULL THEN RAISE EXCEPTION '457: approve_draft_reply not found'; END IF;
  IF v_src LIKE '%de_learning_edits%' THEN RAISE NOTICE '457: approve_draft_reply already captures'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  FOR v_hits IN SELECT (length(v_src)-length(replace(v_src,a,'')))/length(a)
                  FROM unnest(ARRAY[a_decl,a_sel,a_end]) a LOOP
    IF v_hits <> 1 THEN RAISE EXCEPTION '457: an approve_draft_reply anchor matched % times', v_hits; END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_conv uuid; v_de uuid; v_before text;');
  v_new := replace(v_new, a_sel,  '  select tenant_id, conversation_id, content into v_tenant, v_conv, v_before');
  v_new := replace(v_new, a_end, array_to_string(ARRAY[
    a_end,
    '',
    '  -- Training pair (mig 457). de_messages.content IS the delivered message,',
    '  -- so the overwrite above is correct and unavoidable — this is the only',
    '  -- place the original survives.',
    '  if nullif(trim(p_edited_content), '''') is not null',
    '     and btrim(p_edited_content) <> btrim(coalesce(v_before, '''')) then',
    '    insert into de_learning_edits (tenant_id, de_id, source_kind, source_id,',
    '                                   before_text, after_text, edited_by)',
    '    values (v_tenant, v_de, ''de_message'', p_message_id,',
    '            v_before, p_edited_content, auth.uid());',
    '  end if;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '457: approve_draft_reply edit did not land'; END IF;
  EXECUTE v_new;
END $patch2$;

DO $assert$
DECLARE d text; r text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='approve_draft';
  SELECT pg_get_functiondef(p.oid) INTO r FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='approve_draft_reply';

  IF d NOT LIKE '%de_learning_edits%' THEN RAISE EXCEPTION '457: approve_draft does not capture'; END IF;
  IF r NOT LIKE '%de_learning_edits%' THEN RAISE EXCEPTION '457: approve_draft_reply does not capture'; END IF;

  -- ⚠ THE DELIVERY PATHS MUST BE UNTOUCHED. This migration captures; it must
  -- not change a single character of what reaches a customer.
  IF d NOT LIKE '%draft_content = COALESCE(p_edited_content, draft_content)%' THEN
    RAISE EXCEPTION '457: approve_draft delivery path changed — the sent text is no longer the edit';
  END IF;
  IF r NOT LIKE '%content = coalesce(nullif(trim(p_edited_content), ''''), content)%' THEN
    RAISE EXCEPTION '457: approve_draft_reply delivery path changed — the sent message is no longer the edit';
  END IF;
  -- The wave-2 guards must survive both splices.
  IF d NOT LIKE '%can_access_de%' OR r NOT LIKE '%can_access_de%' THEN
    RAISE EXCEPTION '457: a DE guard was lost in the splice';
  END IF;
  -- Capture must be conditional; an unedited approval is not a training pair.
  IF d NOT LIKE '%btrim(p_edited_content) <> btrim(coalesce(v_before%'
     OR r NOT LIKE '%btrim(p_edited_content) <> btrim(coalesce(v_before%' THEN
    RAISE EXCEPTION '457: capture is unconditional — unedited approvals would be recorded as edits';
  END IF;

  -- Table shape and reachability.
  IF NOT has_table_privilege('authenticated','public.de_learning_edits','SELECT') THEN
    RAISE EXCEPTION '457: authenticated cannot SELECT the corpus — the policies would never be reached';
  END IF;
  IF has_table_privilege('authenticated','public.de_learning_edits','INSERT') THEN
    RAISE EXCEPTION '457: clients can INSERT training pairs — the corpus must be written only by the approval functions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.de_learning_edits'::regclass
                   AND polname='de_learning_edits_de_scope' AND polpermissive=false) THEN
    RAISE EXCEPTION '457: the DE scope policy is missing or PERMISSIVE';
  END IF;

  -- The no-op guard actually bites.
  BEGIN
    INSERT INTO de_learning_edits (tenant_id, de_id, source_kind, source_id, before_text, after_text)
    VALUES ((SELECT id FROM tenants LIMIT 1), NULL, 'draft_response',
            '00000000-0000-0000-0000-000000000000', 'same', 'same');
    RAISE EXCEPTION '457: a no-change pair was accepted — the corpus would fill with noise';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO v_n FROM de_learning_edits;
  RAISE NOTICE '457: training-pair corpus live (% rows). Delivery paths untouched; capture is conditional on a real edit.', v_n;
END $assert$;

NOTIFY pgrst, 'reload schema';
