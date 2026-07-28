-- 490_dispatcher_sees_revived_objectives.sql
-- ============================================================================
-- A gap introduced by migration 482 and caught during wave-1 verification.
--
-- 482 made 'blocked' objectives revivable: conclude_objective_wake re-arms them
-- at 24h instead of setting next_wake_at NULL, and both wake_due_objectives and
-- begin_objective_wake were widened to admit them. Verified working: the waker
-- returns 5 blocked objectives and the claim succeeds.
--
-- But dispatch_de_work_internal — the cron entry point — keeps its OWN early-out
-- predicate, and that one still read status IN ('open','in_progress'). So when a
-- tenant's only due work is a revived blocked objective, the dispatcher returns
-- 'idle — nothing due' and never invokes de-work at all. The revival would be
-- inert in precisely the case it exists for: an employee that said 'I am
-- blocked' and needs to be re-assessed.
--
-- Reproduced from the LIVE definition with a single-hit anchor; only the status
-- list changes. The queued-work-items arm, the vault secret read, the ops alert
-- on a missing secret, the anon+dispatch-secret header pair, max_items and the
-- 60s timeout are all untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dispatch_de_work_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  v_req_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM de_work_items WHERE status = 'queued' AND scheduled_for <= now() AND tenant_is_operational(tenant_id))
     AND NOT EXISTS (SELECT 1 FROM de_objectives WHERE status IN ('open','in_progress','blocked') AND tenant_is_operational(tenant_id)
                       AND ( (next_wake_at IS NOT NULL AND next_wake_at <= now())
                             OR NOT EXISTS (SELECT 1 FROM de_work_items w WHERE w.objective_id = de_objectives.id) ))
  THEN
    RETURN 'idle — nothing due';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — de-work items are queued but the work engine cron cannot run them.',
      jsonb_build_object('cron', 'dispatch_de_work_internal'));
    RETURN 'no dispatch secret';
  END IF;
  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/de-work'),
    body := '{"action":"run","max_items":3}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'x-dispatch-secret',v_secret)
  , timeout_milliseconds := 60000) INTO v_req_id;
  RETURN 'de-work dispatched, req ' || v_req_id;
END;
$function$
;


do $a$
declare v_def text; n int;
begin
  v_def := pg_get_functiondef('public.dispatch_de_work_internal()'::regprocedure);
  if v_def not ilike '%''open'',''in_progress'',''blocked''%' then
    raise exception '490: the dispatcher still cannot see a revived blocked objective';
  end if;
  if v_def not ilike '%tenant_is_operational%' then
    raise exception '490: lost the mig-430 suspension guard';
  end if;
  if v_def not ilike '%x-dispatch-secret%' then
    raise exception '490: lost the dispatch-secret header';
  end if;
  select count(*) into n from de_objectives where status='blocked' and next_wake_at is not null;
  raise notice '490: dispatcher now sees % revived blocked objective(s)', n;
end $a$;
