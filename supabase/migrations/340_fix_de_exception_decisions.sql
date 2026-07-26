-- 340_fix_de_exception_decisions.sql
-- ============================================================================
-- The exceptions approval surface has never worked. THREE independent defects
-- stacked in one function, each of which alone would break it.
--
-- An "exception" is a Digital Employee saying "this situation isn't covered —
-- here's what I propose". Answering it is the human-in-the-loop moment the
-- product is built around. 16 real items are sitting unanswered right now
-- because every attempt to decide one fails.
--
--   1. STATE MISMATCH. Rows are created with status 'proposed' (the column
--      DEFAULT), but decide_de_exception required 'pending':
--          IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'already_decided'
--      'pending' is not even in the CHECK constraint, so no row can ever be in
--      it. This fires FIRST, which is why the UI shows "Somebody has already
--      answered this one" — the single most misleading message it could give
--      for a queue nobody has ever been able to touch.
--
--   2. VALUE MISMATCH. The UI sends 'approved' | 'rejected'
--      (src/lib/deWorkbenchApi.ts:177) and the function accepted 'rejected',
--      but the table CHECK allows ('proposed','approved','denied','auto_resolved').
--      Writing 'rejected' violates the constraint. So even past defect 1, a
--      rejection could not be stored.
--
--   3. INVALID AUDIT CATEGORY. It writes append_audit_event(..., 'decision', ...)
--      and 'decision' is not in the audit_events category CHECK. append_audit_event
--      raises, and because it is called inside the same transaction the whole
--      decision rolls back. So even past defects 1 and 2, an APPROVAL could not
--      be stored either. Verified: zero audit_events rows have category
--      'decision' — the write has never once succeeded.
--
-- All three verified against the live database before writing this.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Reproduced from the live definition; only the three broken lines change.
--   * Precondition now tests 'proposed', the state rows are actually in.
--   * 'rejected' is accepted at the API boundary and NORMALISED to 'denied' for
--     storage, so the existing UI keeps working with no frontend change and the
--     stored value satisfies the CHECK. Accepting 'denied' directly too, so a
--     future caller using the real vocabulary also works.
--   * Audit category becomes 'approval', which is valid and is what this is.
--
-- Deliberately NOT done: widening the status CHECK to admit 'pending' and
-- 'rejected'. Two spellings for one state is how this happened. The table's
-- vocabulary is correct; the function was wrong.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.decide_de_exception(
  p_exception_id uuid, p_decision text, p_outcome text DEFAULT NULL::text, p_learned boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_row de_exceptions;
  v_de_name text;
  v_status text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  IF p_decision NOT IN ('approved','rejected','denied') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;

  -- The UI's word is 'rejected'; the table's word is 'denied'. Translate at the
  -- boundary rather than teaching the table a second spelling.
  v_status := CASE WHEN p_decision = 'rejected' THEN 'denied' ELSE p_decision END;

  SELECT * INTO v_row FROM de_exceptions WHERE id = p_exception_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'exception_not_found'; END IF;
  -- 'proposed' is the state a new exception is actually in.
  IF v_row.status <> 'proposed' THEN RAISE EXCEPTION 'already_decided: %', v_row.status; END IF;

  SELECT name INTO v_de_name FROM digital_employees WHERE id = v_row.de_id;

  UPDATE de_exceptions SET
    status     = v_status,
    outcome    = p_outcome,
    learned    = coalesce(p_learned, false),
    decided_by = auth.uid(),
    decided_at = now()
  WHERE id = p_exception_id;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s exception %s — %s', coalesce(v_de_name, 'An employee'), v_status,
           left(v_row.situation, 120)),
    'approval',                                  -- 'decision' is not a valid category
    jsonb_build_object('exception_id', p_exception_id, 'de_id', v_row.de_id,
                       'decision', v_status, 'learned', coalesce(p_learned, false))
  );
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END$function$;

-- ── Prove all three are closed ──────────────────────────────────────────────
DO $assert$
DECLARE v_def text; v_valid boolean;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'decide_de_exception' AND p.prokind = 'f' LIMIT 1;

  IF v_def ~* '<>\s*''pending''' THEN RAISE EXCEPTION '340: still gates on the impossible ''pending'' state'; END IF;
  IF v_def ~* 'status\s*=\s*p_decision' THEN RAISE EXCEPTION '340: still writes the raw decision without normalising'; END IF;

  -- Every status this function can now write must satisfy the table CHECK.
  FOR v_valid IN SELECT true LOOP EXIT; END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.de_exceptions'::regclass
       AND pg_get_constraintdef(oid) ILIKE '%approved%'
       AND pg_get_constraintdef(oid) ILIKE '%denied%')
  THEN RAISE EXCEPTION '340: de_exceptions CHECK does not admit approved/denied'; END IF;

  -- And the audit category must be one the audit table accepts, or the whole
  -- decision rolls back exactly as it did before.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.audit_events'::regclass
       AND conname = 'audit_events_category_check'
       AND pg_get_constraintdef(oid) ILIKE '%''approval''%')
  THEN RAISE EXCEPTION '340: ''approval'' is not a valid audit category'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
