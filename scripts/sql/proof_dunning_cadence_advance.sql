-- proof_dunning_cadence_advance.sql  (mig 677)
-- ===========================================================================
-- ONE rolled-back transaction. Builds its own fixtures through the product's
-- real FKs, drives the REAL functions (record_action_execution,
-- claim_gated_action_execution) and the REAL updates connector-hub issues
-- (index.ts:7324 success / :7329 failure, verbatim), then RAISES so the whole
-- statement aborts and nothing is left behind.
--
-- It proves SIX things on real rows:
--   (a) OLD behaviour was wrong  — claim-only advanced the rung. Proven by
--       temporarily re-installing the mig-661 body AND its AFTER INSERT
--       trigger inside this same transaction, so (a) is measured, not argued.
--   (b) NEW — claim-only does NOT advance                        (PATH A)
--   (c) NEW — claim then SUCCESS does advance                    (PATH A)
--   (d) NEW — claim then SUCCESS does advance                    (PATH B)
--   (e) NEW — claim then FAILURE leaves the rung where it was    (PATH B)
--   (f) monotonicity preserved — a late LOWER rung does not drag it down,
--       and the UNGATED lifecycle still advances at INSERT.
--
-- DEV ONLY. Production carries mig 670's `human_tasks_push_ping` trigger,
-- which calls net.http_post on a pending human_task — a rolled-back proof must
-- not ring a founder's phone. Dev does not have that trigger (verified).
-- ===========================================================================
do $proof$
declare
  v_newdef  text;
  v_ten     uuid;
  v_cat     text;
  v_acct    uuid;
  v_inv     uuid;
  v_ladder  uuid;
  v_ad_low  uuid;
  v_ad_high uuid;
  v_ref     text;
  v_rec     jsonb;
  v_gate    uuid;
  v_task    uuid;
  v_claim   jsonb;
  v_cid     uuid;
  v_out     text := E'\n';
  v_s       int;
  v_s2      int;
  v_dedupe  text;
begin
  -- ── what am I actually testing? ────────────────────────────────────────
  v_newdef := pg_get_functiondef('public.advance_dunning_cadence()'::regprocedure);
  v_out := v_out || format('FUNCTION UNDER TEST  md5=%s%s', md5(v_newdef), E'\n');
  select v_out || format('TRIGGER UNDER TEST   %s%s', pg_get_triggerdef(tg.oid), E'\n')
    into v_out
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
   where c.relname = 'action_executions' and tg.tgname = 'trg_advance_dunning_cadence';
  v_out := v_out || E'\n';

  -- ── fixtures, through the real FKs ─────────────────────────────────────
  select id into v_ten from public.tenants order by created_at limit 1;
  select key into v_cat from public.system_categories order by key limit 1;
  if v_ten is null or v_cat is null then
    raise exception 'PROOF-677 CANNOT RUN: no tenant (%) or system_category (%) on this database', v_ten, v_cat;
  end if;

  v_ref := 'PROOF-677-' || substr(gen_random_uuid()::text, 1, 8);

  insert into public.customer_accounts (tenant_id, name)
       values (v_ten, 'PROOF-677 account') returning id into v_acct;

  -- 30 days overdue: past rung 1 (7d) and rung 2 (21d), NOT past rung 3 (45d).
  insert into public.renewal_invoices
       (tenant_id, account_id, amount_cents, status, due_date, cadence_stage,
        source_provider, source_external_ref, outstanding_cents, payments_reconciled_at)
       values (v_ten, v_acct, 4500000, 'sent', current_date - 30, 0,
               'erpnext', v_ref, 4500000, now())
       returning id into v_inv;

  -- A tenant ladder of this proof's own, so nothing depends on seed data
  -- (dev carries no dunning_ladders rows at all).
  insert into public.dunning_ladders (tenant_id, name, active)
       values (v_ten, 'PROOF-677 ladder', true) returning id into v_ladder;
  insert into public.dunning_rungs (ladder_id, stage, after_days_overdue, label, tone, action_key, requires_approval)
       values (v_ladder, 1,  7, 'PROOF friendly',  'friendly', 'proof_677_low',  true),
              (v_ladder, 2, 21, 'PROOF firm',      'firm',     'proof_677_high', true),
              (v_ladder, 3, 45, 'PROOF final',     'final',    'proof_677_high', true);

  insert into public.action_definitions (scope, tenant_id, category, action_key, label, provider, execution, status)
       values ('tenant', v_ten, v_cat, 'proof_677_low',  'PROOF low rung',  'proof', '{"execution_key":"erpnext.x"}'::jsonb, 'active')
       returning id into v_ad_low;
  insert into public.action_definitions (scope, tenant_id, category, action_key, label, provider, execution, status)
       values ('tenant', v_ten, v_cat, 'proof_677_high', 'PROOF high rung', 'proof', '{"execution_key":"erpnext.x"}'::jsonb, 'active')
       returning id into v_ad_high;

  v_out := v_out || format('FIXTURES  invoice=%s  ref=%s  due=%s (%s days overdue)  stage=0%s',
                           v_inv, v_ref, current_date - 30, 30, E'\n');
  v_out := v_out || format('          ladder rungs: 1@7d=proof_677_low, 2@21d=proof_677_high, 3@45d=proof_677_high%s%s',
                           E'\n', E'\n');

  -- ═══════════════════════════════════════════════════════════════════════
  -- (a) THE OLD BEHAVIOUR. Re-install the mig-661 body and its AFTER INSERT
  --     trigger, run the gated lifecycle up to the CLAIM, and read the rung.
  -- ═══════════════════════════════════════════════════════════════════════
  execute $old$
    create or replace function public.advance_dunning_cadence()
    returns trigger language plpgsql security definer set search_path to 'public'
    as $function$
    declare v_invoice uuid; v_stage int; v_key text; v_ref text;
    begin
      if new.decision not in ('executed_after_approval', 'auto_executed') then return null; end if;
      if new.dedupe_key is not null and new.dedupe_key like 'dunning:%' then
        v_invoice := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
        v_stage   := nullif(split_part(new.dedupe_key, ':', 3), '')::int;
      else
        select ad.action_key into v_key from action_definitions ad where ad.id = new.action_definition_id;
        if v_key is null then return null; end if;
        v_ref := nullif(btrim(new.params->>'external_ref'), '');
        if v_ref is null then return null; end if;
        select ri.id into v_invoice from renewal_invoices ri
         where ri.tenant_id = new.tenant_id and ri.source_external_ref = v_ref limit 1;
        if v_invoice is null then return null; end if;
        select max(r.stage) into v_stage
          from dunning_rungs r join dunning_ladders l on l.id = r.ladder_id
          join renewal_invoices ri on ri.id = v_invoice
         where l.active and (l.tenant_id = new.tenant_id or l.tenant_id is null)
           and r.action_key = v_key and ri.due_date is not null
           and (current_date - ri.due_date) >= coalesce(r.after_days_overdue, 0);
      end if;
      if v_invoice is null or v_stage is null then return null; end if;
      update renewal_invoices set cadence_stage = greatest(coalesce(cadence_stage, 0), v_stage), updated_at = now()
       where id = v_invoice and tenant_id = new.tenant_id;
      return null;
    exception when others then return null; end;
    $function$;
  $old$;
  drop trigger if exists trg_advance_dunning_cadence on public.action_executions;
  create trigger trg_advance_dunning_cadence after insert on public.action_executions
    for each row execute function public.advance_dunning_cadence();

  v_dedupe := format('dunning:%s:2', v_inv);
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_high, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref), p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => v_dedupe,
           p_request_summary => 'PROOF-677 (a) firm follow-up', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-677 (a) approve me', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null) into v_rec;
  v_gate := (v_rec->>'id')::uuid;  v_task := (v_rec->>'task_id')::uuid;
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  if (v_claim->>'claim_row_id') is null then
    raise exception 'PROOF-677 CANNOT RUN: the claim did not happen: %', v_claim;
  end if;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (a) OLD, claim only, nothing sent      stage=%s  %s%s', v_s,
    case when v_s = 2 then 'DEFECT CONFIRMED — the rung climbed before the chase was sent'
         else 'NOT REPRODUCED — expected 2' end, E'\n');

  -- restore the migration-677 function and trigger
  execute v_newdef;
  drop trigger if exists trg_advance_dunning_cadence on public.action_executions;
  create trigger trg_advance_dunning_cadence after insert or update on public.action_executions
    for each row execute function public.advance_dunning_cadence();

  -- ═══════════════════════════════════════════════════════════════════════
  -- (b)+(c) PATH A under mig 677: claim, then the success UPDATE.
  -- ═══════════════════════════════════════════════════════════════════════
  update public.renewal_invoices set cadence_stage = 0 where id = v_inv;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_high, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref), p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => v_dedupe,
           p_request_summary => 'PROOF-677 (b/c) firm follow-up', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-677 (b/c) approve me', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null) into v_rec;
  v_gate := (v_rec->>'id')::uuid;  v_task := (v_rec->>'task_id')::uuid;
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_cid := (v_claim->>'claim_row_id')::uuid;
  if v_cid is null then raise exception 'PROOF-677 (b) claim failed: %', v_claim; end if;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (b) NEW, claim only (PATH A)          stage=%s  %s%s', v_s,
    case when v_s = 0 then 'PASS — a claim taken before the call does NOT advance the rung'
         else 'FAIL — expected 0' end, E'\n');

  -- connector-hub/index.ts:7324 verbatim: receipt + result only, NOT decision.
  update public.action_executions
     set receipt = 'ERP reminder REM-4471 sent to the customer',
         result  = '{"ok":true,"status":200,"error":null,"ref":"REM-4471"}'::jsonb
   where id = v_cid;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (c) NEW, claim then SUCCESS (PATH A)  stage=%s  %s%s', v_s,
    case when v_s = 2 then 'PASS — the rung advances on the receipt-only UPDATE the old trigger could not see'
         else 'FAIL — expected 2 (the stage came from the key dunning:<invoice>:2)' end, E'\n');

  -- ═══════════════════════════════════════════════════════════════════════
  -- (d) PATH B — the EMPLOYEE's identical chase, generic dedupe key, invoice
  --     resolved from params->>'external_ref' and the rung read from the
  --     ladder. This is the path that was dead until mig 661.
  -- ═══════════════════════════════════════════════════════════════════════
  update public.renewal_invoices set cadence_stage = 0 where id = v_inv;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_high, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref, 'note', 'Payment reminder'),
           p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false,
           -- the generic key connector-hub writes: <action_definition_id>:<params json>
           p_dedupe_key => v_ad_high::text || ':{"external_ref":"' || v_ref || '"}',
           p_request_summary => 'PROOF-677 (d) employee-sent chase', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-677 (d) approve me', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null) into v_rec;
  v_gate := (v_rec->>'id')::uuid;  v_task := (v_rec->>'task_id')::uuid;
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_cid := (v_claim->>'claim_row_id')::uuid;
  if v_cid is null then raise exception 'PROOF-677 (d) claim failed: %', v_claim; end if;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  update public.action_executions
     set receipt = 'ERP reminder REM-9001 sent to the customer',
         result  = '{"ok":true,"status":200,"error":null,"ref":"REM-9001"}'::jsonb
   where id = v_cid;
  select cadence_stage into v_s2 from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (d) NEW, PATH B claim=%s then SUCCESS  stage=%s  %s%s', v_s, v_s2,
    case when v_s = 0 and v_s2 = 2
         then 'PASS — claim did not advance; the receipt did, at rung 2 read from dunning_rungs (30d overdue clears 21d, not 45d)'
         else 'FAIL — expected claim=0 then 2' end, E'\n');

  -- ═══════════════════════════════════════════════════════════════════════
  -- (e) PATH B — claim, then the call FAILS. connector-hub/index.ts:7329.
  -- ═══════════════════════════════════════════════════════════════════════
  update public.renewal_invoices set cadence_stage = 0 where id = v_inv;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_high, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref, 'note', 'Payment reminder'),
           p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false,
           p_dedupe_key => v_ad_high::text || ':{"external_ref":"' || v_ref || '","n":2}',
           p_request_summary => 'PROOF-677 (e) chase that fails', p_receipt => null, p_result => null,
           p_task_title => 'PROOF-677 (e) approve me', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null) into v_rec;
  v_gate := (v_rec->>'id')::uuid;  v_task := (v_rec->>'task_id')::uuid;
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_cid := (v_claim->>'claim_row_id')::uuid;
  if v_cid is null then raise exception 'PROOF-677 (e) claim failed: %', v_claim; end if;
  update public.action_executions
     set decision = 'failed', resolves_task_id = null,
         result = '{"ok":false,"status":502,"error":"the accounting system refused"}'::jsonb
   where id = v_cid;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (e) NEW, claim then FAILURE           stage=%s  %s%s', v_s,
    case when v_s = 0 then 'PASS — a failed send does not burn the rung; the sweep can chase again'
         else 'FAIL — expected 0, the rung was burnt for work that never happened' end, E'\n');

  -- ═══════════════════════════════════════════════════════════════════════
  -- (f) MONOTONICITY. Ungated success at the HIGH rung (2), then a late
  --     ungated success at the LOW rung (1) must not drag it back down.
  -- ═══════════════════════════════════════════════════════════════════════
  update public.renewal_invoices set cadence_stage = 0 where id = v_inv;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_high, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref), p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-677 (f) ungated high rung',
           p_receipt => 'ERP reminder REM-7000 sent', p_result => '{"ok":true,"status":200}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null) into v_rec;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_ad_low, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => jsonb_build_object('external_ref', v_ref), p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => null,
           p_request_summary => 'PROOF-677 (f) late LOW rung',
           p_receipt => 'ERP reminder REM-7001 sent', p_result => '{"ok":true,"status":200}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null) into v_rec;
  select cadence_stage into v_s2 from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('VERDICT (f) monotonicity: ungated high=%s then late low -> %s  %s%s', v_s, v_s2,
    case when v_s = 2 and v_s2 = 2
         then 'PASS — the ungated lifecycle still advances at INSERT, and greatest() refused the lower rung'
         else 'FAIL — expected 2 then 2' end, E'\n');

  -- ── extra, cheap, and worth knowing: a stray later UPDATE of an
  --    already-landed row must NOT recompute a higher rung on elapsed time. ─
  update public.renewal_invoices set due_date = current_date - 60 where id = v_inv;
  update public.action_executions set params = params || '{"backfilled":true}'::jsonb
   where dedupe_key is null and params->>'external_ref' = v_ref;
  select cadence_stage into v_s from public.renewal_invoices where id = v_inv;
  v_out := v_out || format('  (extra) stray UPDATE after the invoice aged to 60d  stage=%s  %s%s', v_s,
    case when v_s = 2 then 'PASS — the transition guard refused to re-climb on elapsed time'
         else 'FAIL — the ladder climbed without a chase being sent' end, E'\n');

  raise exception E'PROOF-677 (rolled back on purpose)%', v_out;
end
$proof$;
