-- 320_defofdone_w4_respond_de_task.sql
-- ============================================================================
-- §3 ACTION-HONESTY, definition-of-done W4 — respond_de_task terminal writer.
--
-- respond_de_task (mig 234, live — mig 269 does not redefine it) reflects a
-- 'completed' cross-DE task onto its objective by writing status='achieved'
-- DIRECTLY, bypassing the def-of-done check — a fourth way to mark done over a
-- pending action. Route that one branch through conclude_objective_verified
-- (mig 319): it assesses, logs (shadow + enforce), and only WITHHOLDS a false
-- 'achieved' when enforcing. 'declined'/'failed' → 'blocked' is unchanged (a
-- block is not a false "done"). Reproduced VERBATIM from mig 234; ONLY the
-- objective-status branch changed. Inert until the def-of-done flag enforces. GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.respond_de_task(p_request_id uuid, p_status text, p_result text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r de_task_requests; v_to_name text; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_status NOT IN ('accepted','in_progress','completed','declined','failed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_status');
  END IF;
  SELECT * INTO r FROM de_task_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT v_is_service AND r.tenant_id IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  IF r.status IN ('completed','declined','failed') THEN
    RETURN jsonb_build_object('ok', true, 'already', r.status);
  END IF;

  SELECT coalesce(persona_name, name) INTO v_to_name FROM digital_employees WHERE id = r.to_de_id;
  UPDATE de_task_requests
     SET status = p_status,
         result = coalesce(left(p_result, 4000), result),
         responded_at = coalesce(responded_at, now()),
         completed_at = CASE WHEN p_status IN ('completed','declined','failed') THEN now() ELSE completed_at END
   WHERE id = p_request_id;

  -- Reflect terminal states onto the receiver's case so the work engine closes it.
  -- §3 W4: 'completed' → 'achieved' now routes through conclude_objective_verified
  -- (assess + log + withhold-on-enforce); 'declined'/'failed' → 'blocked' unchanged.
  IF p_status IN ('completed','declined','failed') AND r.objective_id IS NOT NULL THEN
    IF p_status = 'completed' THEN
      PERFORM public.conclude_objective_verified(r.tenant_id, r.objective_id, 'achieved', 'cross-DE task completed');
    ELSE
      UPDATE de_objectives SET status = 'blocked' WHERE id = r.objective_id;
    END IF;
  END IF;

  BEGIN PERFORM append_audit_event_internal(r.tenant_id, coalesce(v_to_name,'DE'), 'de',
    coalesce(v_to_name,'DE') || ' marked task "' || r.title || '" as ' || p_status, 'de_consultation',
    jsonb_build_object('kind','de_task_response','request_id',r.id,'status',p_status));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END; $$;
REVOKE ALL ON FUNCTION public.respond_de_task(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.respond_de_task(uuid,text,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
