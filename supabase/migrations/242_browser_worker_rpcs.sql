-- 242_browser_worker_rpcs.sql
-- ============================================================================
-- The thin, governed RPC surface the Browser Operator runtime worker uses.
-- The worker (Node/Steel/Playwright, self-hosted — see runtime/browser-operator)
-- never touches tables directly; it goes through these so the mig-182 gate stays
-- authoritative:
--   • next_approved_browser_task — hand the worker the next APPROVED browser task
--     to attempt (it then calls the mig-182 claim_computer_use_task, which is the
--     atomic race-safe gate; concurrent workers can't double-claim).
--   • append_browser_task_step — record one governed step (action/url/screenshot/
--     note) and flip claimed→running (the mig-182 trigger re-verifies approval +
--     an active runtime on that transition).
--   • finish_browser_task — close the task done/failed with a result.
-- All service-role only. Additive, GLOBAL.
-- ============================================================================

-- Next approved browser task to attempt (oldest first). The worker claims it via
-- the existing claim_computer_use_task, which wins atomically vs other workers.
CREATE OR REPLACE FUNCTION public.next_approved_browser_task()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t computer_use_tasks;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'service-role only'; END IF;
  SELECT * INTO t FROM computer_use_tasks
    WHERE status = 'approved' AND engine IN ('browser_dom','browser_vision')
    ORDER BY updated_at ASC LIMIT 1;
  IF t.id IS NULL THEN RETURN jsonb_build_object('ok', true, 'task', NULL); END IF;
  RETURN jsonb_build_object('ok', true, 'task', jsonb_build_object(
    'id', t.id, 'tenant_id', t.tenant_id, 'de_id', t.de_id, 'goal', t.goal,
    'allowed_domains', t.allowed_domains, 'max_steps', t.max_steps,
    'engine', t.engine, 'credential_policy', t.credential_policy));
END; $$;
REVOKE ALL ON FUNCTION public.next_approved_browser_task() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_approved_browser_task() TO service_role;

-- Record one step + move claimed→running (the mig-182 trigger re-checks approval
-- + active runtime on that transition, so a reaped worker's task stalls safely).
CREATE OR REPLACE FUNCTION public.append_browser_task_step(p_task_id uuid, p_step jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'service-role only'; END IF;
  UPDATE computer_use_tasks
     SET status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
         audit = coalesce(audit, '[]'::jsonb) || jsonb_build_array(coalesce(p_step, '{}'::jsonb)),
         updated_at = now()
   WHERE id = p_task_id AND status IN ('claimed','running');
END; $$;
REVOKE ALL ON FUNCTION public.append_browser_task_step(uuid,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_browser_task_step(uuid,jsonb) TO service_role;

-- Close a task. done/failed are not gated by the mig-182 trigger (it only guards
-- claimed/running), so a worker can always report an outcome.
CREATE OR REPLACE FUNCTION public.finish_browser_task(p_task_id uuid, p_status text, p_result text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'service-role only'; END IF;
  IF p_status NOT IN ('done','failed') THEN RAISE EXCEPTION 'status must be done or failed'; END IF;
  UPDATE computer_use_tasks
     SET status = p_status, result = left(coalesce(p_result, ''), 8000), updated_at = now()
   WHERE id = p_task_id AND status IN ('claimed','running');
END; $$;
REVOKE ALL ON FUNCTION public.finish_browser_task(uuid,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_browser_task(uuid,text,text) TO service_role;
