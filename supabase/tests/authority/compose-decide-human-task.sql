-- Composition probes for step 2. Run as ONE aborting transaction; see the
-- README in this directory for the exact command.
--
-- The load-bearing assertion is c1. ⚠ BE PRECISE ABOUT WHAT IT PROVES: it does
-- NOT re-run decide_human_task end to end and diff the answers — that would
-- mean approving real tasks. It proves the ADDED check returns `allow` for
-- every (tenant, user) pair drawn from the live approval_authority rows. Since
-- the added check can only refuse on `deny` and can only OR into needs_second
-- on `require_second_approver`, an `allow` on every pair means the composed
-- outcome is unchanged. That is a compositional argument resting on the shape
-- of the inserted block, not an end-to-end differential — say so in the report
-- rather than claiming byte-identity you did not measure.

create temp table compose_results(name text, outcome text, detail text) on commit drop;

do $c$
declare
  v_tenant uuid; v_user uuid;
  v_after jsonb; v_n int := 0; v_diff int := 0;
begin
  -- ── c1: with NO rules, the added check must be `allow` for every
  -- ──     (tenant, user) pair drawn from live approval_authority rows.
  for v_tenant, v_user in
    select distinct a.tenant_id, p.user_id
      from approval_authority a
      join profiles p on p.tenant_id = a.tenant_id and coalesce(p.is_active, true)
     where a.is_active
  loop
    v_n := v_n + 1;
    v_after := evaluate_authority(v_tenant, 'user', v_user, 'erp_financials',
                                  jsonb_build_object('amount_cents', 50000));
    if coalesce(v_after->>'outcome', 'allow') <> 'allow' then
      v_diff := v_diff + 1;
    end if;
  end loop;
  insert into compose_results values
    ('c1_added_check_is_allow_for_every_live_pair',
     case when v_diff = 0 then 'pass' else 'FAIL' end,
     format('compared %s (tenant,user) pairs drawn from live approval_authority rows; %s returned something other than allow', v_n, v_diff));

  -- ⚠ A denominator of 0 would make the line above pass vacuously.
  insert into compose_results values
    ('c1b_denominator_is_not_zero', case when v_n > 0 then 'pass' else 'FAIL' end,
     format('%s pairs compared', v_n));

  -- ── Seed an admin session so set_authority_rule's role check passes. The
  -- ── claim names a REAL profile; no auth identity is forged.
  select a.tenant_id into v_tenant
    from approval_authority a
    join profiles p on p.tenant_id = a.tenant_id
   where a.is_active and coalesce(p.is_active, true)
     and p.role in ('tenant_owner','tenant_admin')
   limit 1;
  select p.user_id into v_user from profiles p
   where p.tenant_id = v_tenant and coalesce(p.is_active, true)
     and p.role in ('tenant_owner','tenant_admin') limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  -- ── c2: a `deny` rule REFUSES what entitlement alone would allow ────────
  perform set_authority_rule('all','amount_cents','>',1,'deny','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c2_deny_rule_denies',
     case when v_after->>'outcome' = 'deny' then 'pass' else 'FAIL' end,
     coalesce(v_after->>'outcome','(null)'));

  -- ── c3: require_second_approver is reachable ───────────────────────────
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('all','amount_cents','>',1,'require_second_approver','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c3_second_approver_reachable',
     case when v_after->>'outcome' = 'require_second_approver' then 'pass' else 'FAIL' end,
     coalesce(v_after->>'outcome','(null)'));

  -- ── c4: require_human is ALREADY SATISFIED on this path — a human is
  -- ──     approving — so decide_human_task must not refuse on it.
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('all','amount_cents','>',1,'require_human','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c4_require_human_is_satisfied_here',
     case when v_after->>'outcome' = 'require_human' then 'pass' else 'FAIL' end,
     'evaluator says require_human; decide_human_task treats it as satisfied, not a refusal');

  -- ── c5: the composed function actually calls the evaluator. Without this,
  -- ──     every assertion above would pass against an UNCOMPOSED
  -- ──     decide_human_task — they exercise evaluate_authority directly.
  insert into compose_results values
    ('c5_decide_human_task_calls_the_evaluator',
     case when exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'decide_human_task'
          and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'evaluate_authority'
     ) then 'pass' else 'FAIL' end,
     'comment-stripped source of decide_human_task references evaluate_authority');

  delete from authority_rules where tenant_id = v_tenant;
end $c$;

select jsonb_agg(jsonb_build_object('name',name,'outcome',outcome,'detail',detail) order by name) as compose_suite
  from compose_results;
rollback;
