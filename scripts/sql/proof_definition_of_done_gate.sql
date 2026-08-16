-- ⚠ THIS PROOF CALLS assess_definition_of_done_INTERNAL, and must.
-- It runs through scripts/db-query.mjs as `postgres`, where auth.uid() is NULL.
-- Migration 749 gave the public wrapper a hard "not authenticated" refusal and
-- moved the logic behind _internal, so the first call from this file would
-- abort the whole DO block.
--
-- ⚠⚠ AND THE TWO pg_get_functiondef PINS BELOW MUST READ _internal TOO. After
-- 749 the wrapper is eight lines of authority guard containing none of the
-- gate's logic, so a blacklist probe pointed at it answers "absent" BY
-- CONSTRUCTION, forever, no matter what the real function does — two paths,
-- one counted. The md5 fingerprint has the same problem: it would track a
-- wrapper that never changes while the logic it fingerprints moves underneath.
--
-- proof_definition_of_done_gate.sql  (mig 678)
-- ===========================================================================
-- ONE rolled-back transaction. Builds its own fixtures through the product's
-- real FKs, drives the REAL functions (record_action_execution,
-- claim_gated_action_execution, assess_definition_of_done) and the REAL
-- updates connector-hub issues, then RAISES so everything aborts.
--
-- Deliberately version-agnostic: run it against the deployed pre-678 function
-- and it reports the DEFECT; run it against 678 and it reports the FIX. It
-- prints the md5 of the body it ran against so the two runs cannot be
-- confused with each other.
--
-- ⚠ BOTH HALVES. Half these cases prove the gate stops passing work that has
-- not happened. The other half (C, E, H) prove it still PASSES work that did.
-- A gate that withholds everything would satisfy the first half completely and
-- be worthless.
--
-- DEV ONLY. Production carries mig 670's `human_tasks_push_ping` trigger,
-- which calls net.http_post on a pending human_task — a rolled-back proof must
-- not ring a founder's phone. Dev does not have that trigger (verified).
-- ===========================================================================
do $proof$
declare
  v_ten     uuid;
  v_def     uuid;
  v_de      uuid;
  v_pr      uuid;
  v_run     uuid;
  v_run2    uuid;
  v_rec     jsonb;
  v_gate    uuid;
  v_task    uuid;
  v_claim   jsonb;
  v_claimid uuid;
  v_origin  uuid;
  v_out     text := E'\n';
  v_v       jsonb;

  -- one scenario: raise a gate row against a fresh origin, return its task
  v_p       int;
  v_ok      boolean;
begin
  v_out := v_out || format('FUNCTION UNDER TEST  md5=%s%s',
    md5(pg_get_functiondef('public.assess_definition_of_done_internal(uuid,text,uuid,uuid)'::regprocedure)), E'\n');
  v_out := v_out || format('BLACKLIST STILL PRESENT? %s%s',
    position($tok$<> 'failed'$tok$ in
      pg_get_functiondef('public.assess_definition_of_done_internal(uuid,text,uuid,uuid)'::regprocedure)) > 0, E'\n\n');

  select id into v_ten from public.tenants limit 1;
  select id into v_def from public.action_definitions limit 1;
  if v_ten is null or v_def is null then
    raise exception 'PROOF-678 CANNOT RUN: no tenant (%) or action_definition (%)', v_ten, v_def;
  end if;
  perform set_config('app.allow_task_decision', 'on', true);

  -- ══ A. the task is still PENDING — a gate row nobody has approved ══════
  v_origin := gen_random_uuid();
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 A pending', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 A', p_task_detail => '', p_create_task => true,
           p_origin_kind => 'de_work_item', p_origin_id => v_origin) into v_rec;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  A. task still PENDING                    verified=%s pending=%s   %s%s',
    v_ok, v_p, case when not v_ok then 'CORRECT — an unapproved action is not done' else 'BROKEN' end, E'\n');

  -- ══ B. APPROVED + CLAIMED, nothing sent yet — THE DEFECT ═══════════════
  v_origin := gen_random_uuid();
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 B claim only', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 B', p_task_detail => '', p_create_task => true,
           p_origin_kind => 'de_work_item', p_origin_id => v_origin) into v_rec;
  v_gate := (v_rec->>'id')::uuid; v_task := (v_rec->>'task_id')::uuid;
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  if v_claimid is null then
    raise exception 'PROOF-678 CANNOT RUN: the claim did not happen: %', v_claim;
  end if;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  B. CLAIM ONLY (nothing sent)             verified=%s pending=%s   %s%s',
    v_ok, v_p, case when v_ok then 'DEFECT — the gate passed work that has not happened'
                    else 'CORRECT — withheld until the call returns' end, E'\n');

  -- ══ C. the same claim, then the CALL RETURNS (index.ts:7324 verbatim) ══
  --      THE HALF THAT PROVES THE GATE IS NOT SIMPLY BROKEN.
  update public.action_executions
     set receipt = 'REQ-8801 accepted by the customer system',
         result  = '{"ok":true,"status":200,"error":null,"ref":"REQ-8801"}'::jsonb
   where id = v_claimid;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  C. CLAIM then SUCCESS (receipt landed)   verified=%s pending=%s   %s%s',
    v_ok, v_p, case when v_ok then 'CORRECT — a genuine completion still PASSES'
                    else 'BROKEN — the gate withholds work that really finished' end, E'\n');

  -- ══ D. a different approval whose call FAILS (index.ts:7329 verbatim) ══
  v_origin := gen_random_uuid();
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 D failure', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 D', p_task_detail => '', p_create_task => true,
           p_origin_kind => 'de_work_item', p_origin_id => v_origin) into v_rec;
  v_gate := (v_rec->>'id')::uuid; v_task := (v_rec->>'task_id')::uuid;
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  update public.action_executions
     set decision = 'failed', resolves_task_id = null,
         result = '{"ok":false,"status":502,"error":"connector refused"}'::jsonb
   where id = v_claimid;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  D. CLAIM then FAILURE                    verified=%s pending=%s   %s%s',
    v_ok, v_p, case when not v_ok then 'CORRECT — a failed call does not count as done'
                    else 'DEFECT — work that FAILED passed the gate' end, E'\n');

  -- ══ E. the UNGATED lifecycle — one insert carrying everything ══════════
  --      It has no human_task, so it never enters the count. Must still pass.
  v_origin := gen_random_uuid();
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 E ungated', p_receipt => 'AUTO-3310 applied',
           p_result => '{"ok":true,"status":200,"error":null}'::jsonb,
           p_task_title => null, p_task_detail => null, p_create_task => false,
           p_origin_kind => 'de_work_item', p_origin_id => v_origin) into v_rec;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  E. UNGATED success (auto_executed)       verified=%s pending=%s   %s%s',
    v_ok, v_p, case when v_ok and v_p = 0 then 'CORRECT — the ungated lifecycle is untouched'
                    else 'BROKEN — the ungated path now withholds' end, E'\n');

  -- ══ F. a landed execution that was then ROLLED BACK ════════════════════
  v_origin := gen_random_uuid();
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 F rollback', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 F', p_task_detail => '', p_create_task => true,
           p_origin_kind => 'de_work_item', p_origin_id => v_origin) into v_rec;
  v_gate := (v_rec->>'id')::uuid; v_task := (v_rec->>'task_id')::uuid;
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  update public.action_executions
     set receipt = 'REQ-9999 applied', result = '{"ok":true,"status":200}'::jsonb,
         rolled_back_at = now()
   where id = v_claimid;
  v_v := public.assess_definition_of_done_internal(v_ten, 'de_work_item', v_origin, null);
  v_ok := (v_v->>'verified')::boolean; v_p := (v_v->>'pending_count')::int;
  v_out := v_out || format('  F. landed, then ROLLED BACK              verified=%s pending=%s   %s%s',
    v_ok, v_p, case when not v_ok then 'CORRECT — an undone action is not a completion'
                    else 'DEFECT — a reversed action still reads as done' end, E'\n');

  -- ══ clause (d), the agentic_run fail-CLOSED anchor ═════════════════════
  insert into public.digital_employees (tenant_id, name) values (v_ten, 'PROOF-678 DE') returning id into v_de;
  insert into public.playbook_runs (tenant_id) values (v_ten) returning id into v_pr;

  -- ══ G. resolved ONLY by a mig-642 `expired` tombstone ══════════════════
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 G voided', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 G', p_task_detail => '', p_create_task => true,
           p_origin_kind => null, p_origin_id => null) into v_rec;
  v_task := (v_rec->>'task_id')::uuid;
  insert into public.agentic_step_runs (tenant_id, de_id, playbook_run_id, goal, step_index,
                                        status, last_gated_human_task_id)
       values (v_ten, v_de, v_pr, 'PROOF-678 G goal', 0, 'running', v_task) returning id into v_run;
  -- mig 642's tombstone, shape copied from production: a non-failed decision,
  -- no receipt, and a result that says in words that nothing was executed.
  insert into public.action_executions (tenant_id, action_definition_id, mode, decision,
                                        resolves_task_id, receipt, result)
       values (v_ten, v_def, 'execute', 'expired', v_task, null,
               '{"reason":"Approved but never executed. Voided before a scheduled executor existed."}'::jsonb);
  update public.human_tasks set status = 'expired' where id = v_task;
  v_v := public.assess_definition_of_done_internal(v_ten, 'agentic_run', v_run, null);
  v_ok := (v_v->>'verified')::boolean;
  v_out := v_out || format('  G. resolved by an EXPIRED tombstone      verified=%s unresolved=%s   %s%s',
    v_ok, v_v->>'unresolved',
    case when not v_ok then 'CORRECT — "approved but never executed" is not evidence of execution'
         else 'DEFECT — a voided approval read as a completion' end, E'\n');

  -- ══ H. the same anchor, resolved by a GENUINE landed execution ═════════
  --      THE SECOND HALF-PROOF: clause (d) must still verify real work.
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-678 H genuine', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-678 H', p_task_detail => '', p_create_task => true,
           p_origin_kind => null, p_origin_id => null) into v_rec;
  v_gate := (v_rec->>'id')::uuid; v_task := (v_rec->>'task_id')::uuid;
  insert into public.agentic_step_runs (tenant_id, de_id, playbook_run_id, goal, step_index,
                                        status, last_gated_human_task_id)
       values (v_ten, v_de, v_pr, 'PROOF-678 H goal', 1, 'running', v_task) returning id into v_run2;
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  v_v := public.assess_definition_of_done_internal(v_ten, 'agentic_run', v_run2, null);
  v_out := v_out || format('  H1. anchor, CLAIM ONLY                   verified=%s   %s%s',
    (v_v->>'verified')::boolean,
    case when not (v_v->>'verified')::boolean then 'CORRECT — withheld before the call'
         else 'DEFECT — the anchor passed a pre-call claim' end, E'\n');
  update public.action_executions
     set receipt = 'REQ-7710 applied', result = '{"ok":true,"status":200}'::jsonb
   where id = v_claimid;
  v_v := public.assess_definition_of_done_internal(v_ten, 'agentic_run', v_run2, null);
  v_ok := (v_v->>'verified')::boolean;
  v_out := v_out || format('  H2. anchor, GENUINE completion           verified=%s   %s%s',
    v_ok, case when v_ok then 'CORRECT — the anchor still passes real work'
               else 'BROKEN — the fail-closed anchor never releases' end, E'\n');

  raise exception E'PROOF-678 (rolled back on purpose)%', v_out;
end
$proof$;
