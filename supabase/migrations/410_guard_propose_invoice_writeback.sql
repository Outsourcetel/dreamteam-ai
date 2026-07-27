-- 410_guard_propose_invoice_writeback.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — the write-back sub-group. See docs/30.
--
-- ── Why this sub-group is the sharpest end of group B ──────────────────────
-- Everything guarded so far moves rows inside DreamTeam. These four propose
-- changes to a CUSTOMER'S SYSTEM OF RECORD, and they do not always stop for a
-- human: when decide_action_execution returns 'auto_executed' the write is
-- applied IMMEDIATELY via apply_invoice_writeback_internal. Unscoped, a person
-- assigned to one employee could trigger a write into the billing record on
-- behalf of an employee they have no relationship with — and where the trust
-- dial permits auto-execution, with nobody in the loop at all.
--
-- This one is invoices: money. Note the existing design already treats it that
-- way — ANY status change on an invoice is marked destructive so it always
-- gates. But log_activity and set_next_step are NOT destructive and CAN
-- auto-execute, so "it always gates" is not true of the function as a whole.
--
-- ── The refusal mechanism matches the function's own contract ──────────────
-- Group B's rule is REFUSE EXPLICITLY, NEVER FILTER. It is not "always RAISE".
-- These four communicate every failure through an {ok:false, error:...}
-- envelope — bad_op, de_not_found, not_tenant_member, invoice_not_in_tenant.
-- Raising here would break every caller's error handling for no security gain,
-- so the guard returns `not_responsible_for_de` in the same envelope, sitting
-- directly beside not_tenant_member. That is an explicit refusal the caller can
-- see and handle; it is nothing like a silently filtered UPDATE.
--
-- The error CODE stays identical across all of group B so it remains greppable
-- and the frontend has one string to handle.
--
-- ── Placement and null-handling ────────────────────────────────────────────
-- Immediately after the tenant check: role axis first, then assignment axis,
-- both before the target invoice is looked up — so a caller who fails either
-- never learns whether the invoice exists.
--
-- No null-tolerance, and it is not an oversight: the de_not_found check above
-- has already proven p_de_id resolves to a real employee, so p_de_id cannot be
-- null by the time the guard runs. service_role is unaffected — can_access_de
-- returns true for it by name, which is what keeps the workers running.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_tenant text := '  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_tenant_member''); END IF;';
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_invoice_writeback';
  IF v_src IS NULL THEN RAISE EXCEPTION '410: propose_invoice_writeback not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '410: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/410). Role axis above, assignment axis here — both',
    '  -- before the invoice is looked up, so a refused caller never learns',
    '  -- whether it exists. p_de_id is proven to resolve by the de_not_found',
    '  -- check above, so no null case. Refuses through this function''''s own',
    '  -- error envelope rather than raising; see the header.',
    '  IF NOT public.can_access_de(p_de_id) THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de''); END IF;'
    ], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_tenant, ''))) / length(a_tenant);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '410: expected 1 tenant check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_tenant, a_tenant || v_eol || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '410: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_invoice_writeback';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '410: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%not_responsible_for_de%' THEN
    RAISE EXCEPTION '410: the guard does not refuse — an actor must refuse explicitly, not filter';
  END IF;
  -- Refusal must be a RETURN in the error envelope, not a silent fall-through.
  IF v_def NOT LIKE '%RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'')%' THEN
    RAISE EXCEPTION '410: the guard does not return the error envelope this function contracts on';
  END IF;
  -- Order: tenant check first, then scope, then everything that acts.
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '410: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('decide_action_execution' in v_def)
     OR position('can_access_de' in v_def) > position('INSERT INTO invoice_writeback_requests' in v_def)
     OR position('can_access_de' in v_def) > position('apply_invoice_writeback_internal' in v_def) THEN
    RAISE EXCEPTION '410: the guard lands after the gate, the request insert, or the auto-apply';
  END IF;
  -- The money floor and the closed enum are the product guarantees this
  -- function exists to make. A rewrite that lost either would be a regression
  -- far worse than the gap being closed.
  IF v_def NOT LIKE '%open, paid, partial, overdue, void%' THEN
    RAISE EXCEPTION '410: the closed status enum was lost — the anti-hallucination guarantee is gone';
  END IF;
  IF v_def NOT LIKE '%v_destructive := true%' THEN
    RAISE EXCEPTION '410: the destructive flag was lost — invoice status changes would stop being human-gated';
  END IF;
  IF v_def NOT LIKE '%invoice_not_in_tenant%' OR v_def NOT LIKE '%auto_applied%' THEN
    RAISE EXCEPTION '410: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: a bad op needs no identity and must still be rejected
  -- in contract. Proves the body compiles and the envelope survived.
  SELECT public.propose_invoice_writeback(
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid,
           'not_a_real_op', '{}'::jsonb) INTO v_out;
  IF v_out->>'error' <> 'bad_op' THEN
    RAISE EXCEPTION '410: expected bad_op, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '410: propose_invoice_writeback guarded — the auto_executed path writes to billing with nobody in the loop.';
END $assert$;

NOTIFY pgrst, 'reload schema';
