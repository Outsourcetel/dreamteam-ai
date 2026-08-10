-- proof-676-onboarding-completion.sql
-- ===========================================================================
-- ONE rolled-back transaction. Builds its own fixtures through the product's
-- real FKs, drives the REAL functions (record_action_execution,
-- claim_gated_action_execution) and the REAL updates connector-hub issues,
-- then RAISES so the whole statement aborts and nothing is left behind.
--
-- It is deliberately version-agnostic: run it against the deployed mig-675
-- function and it reports the DEFECT; run it against mig 676 and it reports
-- the FIX. It prints the md5 of the function definition it ran against so the
-- two runs cannot be confused with each other.
--
-- DEV ONLY. Production carries mig 670's `human_tasks_push_ping` trigger,
-- which calls net.http_post on a pending human_task — a rolled-back proof must
-- not ring a founder's phone. Dev does not have that trigger.
-- ===========================================================================
do $proof$
declare
  v_ten     uuid;
  v_def     uuid;
  v_acct    uuid;
  v_tpl     uuid;
  v_ver     uuid;
  v_proj    uuid;
  v_rec     jsonb;
  v_gate    uuid;
  v_task    uuid;
  v_claim   jsonb;
  v_claimid uuid;
  v_out     text := E'\n';
  v_s       text;
  v_n       text;
  v_key     text;

  -- the three fixture items: one DE-owned bound item, one already signed off,
  -- one untouched go-live item.
  c_state constant jsonb := jsonb_build_array(
    jsonb_build_object('key', 'cfg', 'status', 'in_progress', 'note', 'proposed, waiting for approval'),
    jsonb_build_object('key', 'sig', 'status', 'signed_off',  'note', 'a person signed this'),
    jsonb_build_object('key', 'go',  'status', 'pending'));
begin
  -- ── what am I actually testing? ────────────────────────────────────────
  v_out := v_out || format('FUNCTION UNDER TEST  md5=%s%s',
    md5(pg_get_functiondef('public.complete_onboarding_item_from_execution()'::regprocedure)), E'\n');
  select v_out || format('TRIGGER UNDER TEST   %s%s', pg_get_triggerdef(tg.oid), E'\n')
    into v_out
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
   where c.relname = 'action_executions' and tg.tgname = 'trg_onboarding_item_completes';
  v_out := v_out || E'\n';

  -- ── fixtures, through the real FKs ─────────────────────────────────────
  select id into v_ten from public.tenants limit 1;
  select id into v_def from public.action_definitions limit 1;
  if v_ten is null or v_def is null then
    raise exception 'PROOF-676 CANNOT RUN: no tenant (%) or action_definition (%) on this database', v_ten, v_def;
  end if;

  insert into public.customer_accounts (tenant_id, name)
       values (v_ten, 'PROOF-676 account') returning id into v_acct;
  insert into public.onboarding_templates (tenant_id, name)
       values (v_ten, 'PROOF-676 template') returning id into v_tpl;
  insert into public.onboarding_template_versions (template_id, tenant_id, version, name, items)
       values (v_tpl, v_ten, 1, 'PROOF-676 v1', jsonb_build_array(
         jsonb_build_object('key','cfg','label','Configure the customer','phase','config','owner_type','de','requires_signoff',false),
         jsonb_build_object('key','sig','label','Signed item','phase','golive','owner_type','human','requires_signoff',true),
         jsonb_build_object('key','go','label','Go live','phase','golive','owner_type','human','requires_signoff',false)))
       returning id into v_ver;
  insert into public.onboarding_projects (tenant_id, account_id, template_version_id, name, items_state)
       values (v_ten, v_acct, v_ver, 'PROOF-676 project', c_state) returning id into v_proj;

  v_key := 'onboarding:' || v_proj::text || ':cfg';

  -- ══ (a)/(b) GATED: a human approves, the claim lands, the CALL FAILS ═══
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => v_key,
           p_request_summary => 'PROOF-676 gated proposal',
           p_receipt => null, p_result => null,
           p_task_title => 'PROOF-676 approve me', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  v_gate := (v_rec->>'id')::uuid;
  v_task := (v_rec->>'task_id')::uuid;

  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  0. after the GATE row (nothing sent)      cfg = %s   %s%s',
    v_s, case when v_s = 'in_progress' then 'OK' else 'UNEXPECTED' end, E'\n');

  -- the human says yes (mig 486's sanctioned decision path)
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;

  -- connector-hub claims the approval BEFORE calling out (the real function)
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  if v_claimid is null then
    raise exception 'PROOF-676 CANNOT RUN: the claim did not happen: %', v_claim;
  end if;

  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  A. after the CLAIM (still nothing sent)   cfg = %s   %s%s', v_s,
    case when v_s = 'done' then 'DEFECT — done before the call was made' else 'GOOD — not done yet' end, E'\n');

  -- ...and the external call fails. connector-hub/index.ts:7329 verbatim.
  update public.action_executions
     set decision = 'failed', resolves_task_id = null,
         result = '{"ok":false,"status":502,"error":"connector refused"}'::jsonb
   where id = v_claimid;

  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  B. after the CALL FAILED                  cfg = %s   %s%s', v_s,
    case when v_s = 'done' then 'DEFECT — an item marked done for work that FAILED'
         else 'CORRECT — a failed call did not complete the item' end, E'\n');

  -- ══ (c1) GATED SUCCESS — the same lifecycle, but the call returns ══════
  update public.onboarding_projects set items_state = c_state where id = v_proj;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'human_gated_destructive',
           p_destructive => true, p_idempotent => false, p_dedupe_key => v_key,
           p_request_summary => 'PROOF-676 gated proposal 2',
           p_receipt => null, p_result => null,
           p_task_title => 'PROOF-676 approve me 2', p_task_detail => '',
           p_create_task => true, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  v_gate := (v_rec->>'id')::uuid;
  v_task := (v_rec->>'task_id')::uuid;
  perform set_config('app.allow_task_decision', 'on', true);
  update public.human_tasks set status = 'approved' where id = v_task;
  select public.claim_gated_action_execution(v_ten, v_task, v_gate) into v_claim;
  v_claimid := (v_claim->>'claim_row_id')::uuid;
  -- connector-hub/index.ts:7324 verbatim — the success update, which does NOT
  -- touch `decision` (that is why mig 675's `update of decision` never saw it).
  update public.action_executions
     set receipt = 'CFG-4471 applied to the customer',
         result  = '{"ok":true,"status":200,"error":null,"ref":"CFG-4471"}'::jsonb
   where id = v_claimid;

  select i->>'status', i->>'note' into v_s, v_n from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  C1. GATED success (receipt landed)        cfg = %s   note=%L   %s%s', v_s, v_n,
    case when v_s = 'done' then 'CORRECT — a real receipt completes the item'
         else 'BROKEN — a genuine success did NOT complete the item' end, E'\n');

  -- ══ (c2) UNGATED SUCCESS — one insert, terminal on arrival ═════════════
  update public.onboarding_projects set items_state = c_state where id = v_proj;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => v_key,
           p_request_summary => 'PROOF-676 auto', p_receipt => 'CFG-9002 applied',
           p_result => '{"ok":true,"status":200,"error":null}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  select i->>'status', i->>'note' into v_s, v_n from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  C2. UNGATED success (auto_executed)       cfg = %s   note=%L   %s%s', v_s, v_n,
    case when v_s = 'done' then 'CORRECT — the ungated lifecycle still completes'
         else 'BROKEN — auto_executed no longer completes the item' end, E'\n');

  -- ══ (d) a human SIGN-OFF is terminal — a receipt must not downgrade it ══
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false,
           p_dedupe_key => 'onboarding:' || v_proj::text || ':sig',
           p_request_summary => 'PROOF-676 against a signed-off item',
           p_receipt => 'SIG-1 applied', p_result => '{"ok":true}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'sig';
  v_out := v_out || format('  D. receipt onto a SIGNED_OFF item         sig = %s   %s%s', v_s,
    case when v_s = 'signed_off' then 'CORRECT — a human decision was not downgraded'
         else 'BROKEN — a human sign-off was overwritten' end, E'\n');

  -- ══ (e) a PREVIEW is not a completion ══════════════════════════════════
  update public.onboarding_projects set items_state = c_state where id = v_proj;
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'preview',
           p_params => '{}'::jsonb, p_decision => 'previewed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => v_key,
           p_request_summary => 'PROOF-676 preview', p_receipt => 'this is only a preview',
           p_result => '{"ok":true}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  E. a PREVIEW with a receipt               cfg = %s   %s%s', v_s,
    case when v_s = 'in_progress' then 'CORRECT — a preview completes nothing'
         else 'BROKEN — a preview completed an item' end, E'\n');

  -- ══ (f) a wrongly-shaped key must be inert, not fatal ══════════════════
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false,
           p_dedupe_key => 'onboarding:not-a-uuid:cfg',
           p_request_summary => 'PROOF-676 malformed key', p_receipt => 'X-1',
           p_result => '{"ok":true}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  F. a MALFORMED dedupe_key                 cfg = %s   execution recorded=%s   %s%s',
    v_s, (v_rec->>'id') is not null,
    case when v_s = 'in_progress' and (v_rec->>'id') is not null
         then 'CORRECT — inert, and it did not roll back the execution'
         else 'BROKEN' end, E'\n');

  -- ══ (g) a success decision that CONTRADICTS its own result ═════════════
  select public.record_action_execution(
           p_tenant_id => v_ten, p_action_definition_id => v_def, p_connector_id => null,
           p_subject_kind => null, p_subject_id => null, p_mode => 'execute',
           p_params => '{}'::jsonb, p_decision => 'auto_executed',
           p_destructive => false, p_idempotent => false, p_dedupe_key => v_key,
           p_request_summary => 'PROOF-676 contradicting result', p_receipt => 'CFG-BAD',
           p_result => '{"ok":false,"status":500,"error":"the system rejected it"}'::jsonb,
           p_task_title => null, p_task_detail => null,
           p_create_task => false, p_origin_kind => null, p_origin_id => null)
    into v_rec;
  select i->>'status' into v_s from public.onboarding_projects p,
         jsonb_array_elements(p.items_state) i where p.id = v_proj and i->>'key' = 'cfg';
  v_out := v_out || format('  G. decision says done, result says ok:false cfg = %s   %s%s', v_s,
    case when v_s = 'in_progress' then 'CORRECT — a contradicted success completes nothing'
         else 'DEFECT — completed on a decision its own result denies' end, E'\n');

  raise exception E'PROOF-676 (rolled back on purpose)%', v_out;
end
$proof$;
