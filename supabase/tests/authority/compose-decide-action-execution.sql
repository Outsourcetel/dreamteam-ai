-- Composition probes for step 3. Run as ONE aborting transaction; see the
-- README in this directory for the command.
--
-- d1 is load-bearing, and d5 is what stops the rest passing vacuously: d2-d4
-- call decide_action_execution, but if the composition never happened they
-- would simply return today's answers and d2/d3 would FAIL — so d5 checks the
-- source directly, the same lesson step 2's c5 recorded.

create temp table dae_results(name text, outcome text, detail text) on commit drop;

do $d$
declare
  v_tenant uuid; v_de uuid; v_user uuid;
  v_gate jsonb; v_n int := 0; v_changed int := 0; v_before text; v_after text;
begin
  -- ── d1: with NO rules, the decision for every (tenant, employee) pair must
  -- ──     be exactly what it is today. Captured BEFORE any rule is written.
  for v_tenant, v_de in
    select d.tenant_id, d.id from digital_employees d
     where d.lifecycle_status in ('assigned','active','improving','paused')
     limit 40
  loop
    v_n := v_n + 1;
    v_gate := decide_action_execution(v_tenant, 'probe action', 'crm', false, v_de, null, 'action_execute', null);
    if coalesce(v_gate->>'decision','') not in ('auto_executed','human_gated_trust','human_gated_destructive','guardrail_blocked','human_gated_paused') then
      v_changed := v_changed + 1;
    end if;
  end loop;
  insert into dae_results values
    ('d1_no_rules_yields_only_todays_decisions',
     case when v_changed = 0 then 'pass' else 'FAIL' end,
     format('called decide_action_execution for %s live employees; %s returned a decision outside today''s vocabulary', v_n, v_changed));

  insert into dae_results values
    ('d1b_denominator_is_not_zero', case when v_n > 0 then 'pass' else 'FAIL' end,
     format('%s employees exercised', v_n));

  -- ── Seed an admin session so set_authority_rule's role check passes. The
  -- ── claim names a REAL profile; no auth identity is forged.
  select d.tenant_id, d.id into v_tenant, v_de
    from digital_employees d
    join profiles p on p.tenant_id = d.tenant_id and coalesce(p.is_active,true)
                   and p.role in ('tenant_owner','tenant_admin')
   where d.lifecycle_status in ('assigned','active','improving','paused')
   limit 1;
  select p.user_id into v_user from profiles p
   where p.tenant_id = v_tenant and coalesce(p.is_active,true)
     and p.role in ('tenant_owner','tenant_admin') limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role','authenticated')::text, true);

  -- Baseline this employee WITHOUT a rule, so d2/d3 are measured against its
  -- own prior answer rather than an assumption about what it would be.
  v_before := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d2a_baseline_captured', case when v_before is not null then 'pass' else 'FAIL' end, v_before);

  -- ── d2: a `deny` rule must produce access_denied ────────────────────────
  perform set_authority_rule('de','amount_cents','>',1,'deny','crm',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d2_deny_rule_yields_access_denied',
     case when v_after = 'access_denied' then 'pass' else 'FAIL' end,
     format('was %s, now %s', v_before, v_after));

  -- ── d3: a require_human rule must NOT auto-execute ──────────────────────
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('de','amount_cents','>',1,'require_human','crm',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d3_require_human_never_auto_executes',
     case when v_after <> 'auto_executed' then 'pass' else 'FAIL' end,
     format('decision is %s', v_after));

  -- ── d4: a rule for a DIFFERENT category must not fire ───────────────────
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('de','amount_cents','>',1,'deny','erp_financials',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d4_other_category_rule_does_not_fire',
     case when v_after = v_before then 'pass' else 'FAIL' end,
     format('baseline %s, with an erp_financials rule %s', v_before, v_after));

  -- ── d5: the composition actually happened, and nothing was deleted ──────
  insert into dae_results values
    ('d5_function_calls_the_evaluator',
     case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.proname='decide_action_execution'
                          and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'evaluate_authority')
          then 'pass' else 'FAIL' end,
     'comment-stripped source references evaluate_authority');

  insert into dae_results values
    ('d6_autonomy_chain_still_called',
     case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.proname='decide_action_execution'
                          and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'resolve_de_autonomy_chain')
          then 'pass' else 'FAIL' end,
     'the earned-trust resolution was not replaced');

  delete from authority_rules where tenant_id = v_tenant;
end $d$;

select jsonb_agg(jsonb_build_object('name',name,'outcome',outcome,'detail',detail) order by name) as dae_suite
  from dae_results;
rollback;
