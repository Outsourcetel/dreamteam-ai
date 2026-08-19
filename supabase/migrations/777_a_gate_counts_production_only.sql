-- 777_a_gate_counts_production_only.sql
-- ============================================================================
-- Registers C-3 and C-4 — the same defect in two organs: a read that counts
-- ALL evidence, exam and production alike, feeding a number a human or a gate
-- then acts on. docs/51 called this class "a metric that measures the TEST",
-- and mig 682 already gave the platform the predicate to say otherwise:
-- `evidence_is_production(origin)`.
--
-- ── C-3 is the one that can change behaviour ───────────────────────────────
-- `de_records_gate` branch (d) gates on error rate over a 56-day window and,
-- when the rate exceeds 15%, appends 'degraded_metrics' — which flips
-- `external_reply_mode` to draft. Its read was:
--
--     from evidence_runs er
--    where er.tenant_id = ... and er.de_id = ... and er.created_at > 56 days
--
-- No origin predicate. So an exam run failing on a HARNESS error — the test
-- rig breaking, not the employee — counted toward the rate that decides
-- whether that employee is allowed to answer a customer without review.
--
-- Not hypothetical: measured today, **75 of 287 evidence runs (26%) carry a
-- non-production origin**. A quarter of the sample feeding this gate was never
-- production work.
--
-- ── C-4 is the same shape, immaterial today, fixed anyway ──────────────────
-- `get_workforce_trust_metrics` reads decided human_tasks with no origin
-- predicate. Exactly one exercise task exists, so the number is right today.
-- It is fixed here because the two organs share one rule, and a rule applied
-- in one place and not the other is how these come back.
--
-- ── What is deliberately NOT changed ───────────────────────────────────────
-- The 15% threshold, the 56-day window and the 10-run sample floor all stay.
-- This narrows WHICH runs are counted; it does not move the bar. A gate that
-- became easier to pass in the same commit that changed its population would
-- be impossible to attribute later.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.de_records_gate(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(gated boolean, reasons text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_reasons text[] := '{}';
  v_cert record;
  v_fp text;
  v_n bigint;       -- GI-4: this DE's 56d evidence-run volume
  v_failed bigint;  -- GI-4: this DE's 56d failed-run count
  v_req boolean;        -- GI-9: tenant opted into mandatory cert?
  v_req_since timestamptz;
  v_de_created timestamptz;
  v_arch text;
  v_has_exam boolean;
  v_has_pass boolean;
begin
  -- (a) Exam certifications (role_certifications): latest row decides.
  select rc.status, rc.config_fingerprint into v_cert
    from role_certifications rc
   where rc.tenant_id = p_tenant_id and rc.de_id = p_de_id
   order by rc.evaluated_at desc nulls last, rc.created_at desc limit 1;
  if found then
    if v_cert.status = 'failed' then
      v_reasons := array_append(v_reasons, 'failed_certification');
    elsif v_cert.status = 'passed' and v_cert.config_fingerprint is not null then
      v_fp := public.de_config_fingerprint(p_de_id);
      if v_fp is not null and v_fp <> v_cert.config_fingerprint then
        v_reasons := array_append(v_reasons, 'stale_certification');
      end if;
    end if;
  end if;

  -- (b) Governance certifications (de_certifications): an expired cert not
  --     superseded by a newer active one of the same type gates.
  if exists (
    select 1 from de_certifications c
     where c.tenant_id = p_tenant_id and c.de_id = p_de_id and c.status = 'expired'
       and not exists (
         select 1 from de_certifications c2
          where c2.tenant_id = p_tenant_id and c2.de_id = p_de_id
            and c2.cert_type = c.cert_type and c2.status = 'active'
            and c2.created_at > c.created_at)
  ) then
    v_reasons := array_append(v_reasons, 'expired_certification');
  end if;

  -- (c) GI-4: an OPEN CRITICAL incident on THIS employee gates. de_id is
  --     required so a tenant-level (null-de_id) incident never over-gates one
  --     employee. Self-clears the moment the incident moves off 'open'.
  if exists (
    select 1 from de_incidents i
     where i.tenant_id = p_tenant_id and i.de_id = p_de_id
       and i.status = 'open' and i.severity = 'critical'
  ) then
    v_reasons := array_append(v_reasons, 'open_critical_incident');
  end if;

  -- (d) GI-4: degraded performance gates on ERROR RATE ONLY (never escalation —
  --     escalation self-manufactures under gating; see header). Scoped to this
  --     employee, 56-day recoverable window, >=10-run sample floor so a DE with
  --     little/no run volume is never gated. Div-by-zero guarded. The inner
  --     block fails CLOSED with a distinct diagnosable reason so a throwing
  --     metric query can never bubble up and silently un-gate a fail-open path.
  begin
    select count(*)::bigint,
           count(*) filter (where er.status = 'failed')::bigint
      into v_n, v_failed
      from evidence_runs er
     where er.tenant_id = p_tenant_id and er.de_id = p_de_id
       and er.created_at > now() - interval '56 days'
       -- C-3: production evidence only. 75 of 287 runs carry a non-production
       -- origin, and an exam failing on a harness error must never count toward
       -- an error rate that flips external_reply_mode.
       and public.evidence_is_production(er.origin);
    if coalesce(v_n, 0) >= 10
       and (100.0 * coalesce(v_failed, 0) / nullif(v_n, 0)) > 15 then
      v_reasons := array_append(v_reasons, 'degraded_metrics');
    end if;
  exception when others then
    v_reasons := array_append(v_reasons, 'metrics_check_unavailable');
  end;

  -- (e) GI-9: MANDATORY CERTIFICATION — opt-in per tenant (default off),
  --     grandfathered by hire date, honest per CURRENT role. A DE that has never
  --     passed its current role's exam is supervised, but ONLY when (i) the tenant
  --     explicitly opted in, (ii) the DE was hired AFTER opt-in, (iii) an exam
  --     actually exists for its role. Opt-in is an EXPLICIT-true DIRECT read (never
  --     is_feature_enabled_internal, which fails OPEN). The cert/exam lookups fail
  --     CLOSED inside their own block so a throw on an opted-in tenant goes supervised.
  if p_de_id is not null then
    select tfo.enabled, tfo.updated_at
      into v_req, v_req_since
      from tenant_feature_overrides tfo
     where tfo.tenant_id = p_tenant_id
       and tfo.feature_key = 'require_certification';
    if coalesce(v_req, false) then
      begin
        select d.created_at into v_de_created
          from digital_employees d
         where d.id = p_de_id and d.tenant_id = p_tenant_id;
        -- Grandfather: only DEs hired after opt-in must certify.
        if v_de_created is not null and v_de_created > v_req_since then
          v_arch := public.resolve_de_archetype(p_de_id);
          select exists (
            select 1 from golden_qa gq
             where gq.tenant_id = p_tenant_id and gq.active = true
               and (gq.archetype_key is null or gq.archetype_key = v_arch)
          ) into v_has_exam;
          select exists (
            select 1 from role_certifications rc
             where rc.tenant_id = p_tenant_id and rc.de_id = p_de_id
               and rc.status = 'passed'
               and rc.archetype_key is not distinct from v_arch
          ) into v_has_pass;
          if coalesce(v_has_exam, false) and not coalesce(v_has_pass, false) then
            v_reasons := array_append(v_reasons, 'never_certified');
          end if;
        end if;
      exception when others then
        v_reasons := array_append(v_reasons, 'certification_check_unavailable');
      end;
    end if;
  end if;

  return query select coalesce(array_length(v_reasons, 1), 0) > 0, v_reasons;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.get_workforce_trust_metrics(p_tenant_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := coalesce(p_tenant_id, auth_tenant_id());
  v_since  timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  -- A rate on fewer events than this is noise dressed as a measurement.
  c_min_actions   constant int := 10;
  c_min_decisions constant int := 5;
  v_ran        int;  v_auto     int;  v_gated   int;
  v_blocked    int;  v_failed   int;  v_reversed int;
  v_reversed_ever int;
  v_decided    int;  v_unchanged int; v_edited  int;  v_rejected int;
  v_median_s   numeric; v_snap int;
  v_employees  int;  v_with_rule int; v_incidents int;
  v_considered int;   -- everything the gate ruled on: performed + gated + blocked
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  -- mig 664: v_tenant may have been CHOSEN by the caller via p_tenant_id.
  -- Prove membership of it. Membership only, deliberately: ordinary members
  -- read this panel today and a role gate would newly deny them.
  if coalesce(auth.role(), '') <> 'service_role' and not (
       is_platform_admin()
       or exists (select 1 from profiles p
                   where p.user_id = auth.uid() and p.tenant_id = v_tenant
                     and coalesce(p.is_active, true))
     ) then
    raise exception 'not authorized to view this workspace''s trust metrics';
  end if;

  select
    count(*) filter (where decision in ('auto_executed','executed_after_approval')),
    count(*) filter (where decision = 'auto_executed'),
    count(*) filter (where decision in ('human_gated_destructive','human_gated_trust')),
    count(*) filter (where decision = 'guardrail_blocked'),
    count(*) filter (where decision = 'failed'),
    count(*) filter (where rolled_back_at is not null)
  into v_ran, v_auto, v_gated, v_blocked, v_failed, v_reversed
  from action_executions
  where tenant_id = v_tenant and created_at >= v_since;

  v_considered := v_ran + v_gated + v_blocked;

  select count(*) into v_reversed_ever
  from action_executions where tenant_id = v_tenant and rolled_back_at is not null;

  select
    count(*),
    count(*) filter (where status = 'approved' and decision_edit is null),
    count(*) filter (where status = 'approved' and decision_edit is not null),
    count(*) filter (where status = 'rejected'),
    percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at))),
    count(*) filter (where decided_at - created_at < interval '1 minute')
  into v_decided, v_unchanged, v_edited, v_rejected, v_median_s, v_snap
  from human_tasks
  where tenant_id = v_tenant and status in ('approved','rejected')
    and decided_at is not null and decided_at >= v_since
    -- C-4: same rule as the gate above — an exercise task is not workforce trust.
    and public.evidence_is_production(origin);

  select count(*) into v_employees
  from digital_employees where tenant_id = v_tenant and status = 'active';

  select count(distinct de_id) into v_with_rule
  from de_autonomy where tenant_id = v_tenant and de_id is not null;

  select count(*) into v_incidents
  from de_incidents where tenant_id = v_tenant and occurred_at >= v_since;

  return jsonb_build_object(
    'window_days', greatest(coalesce(p_days, 30), 1),
    'as_of', now(),

    -- ⚠ Sample gates. The UI reads these FIRST and says "not enough yet"
    -- rather than printing a rate built on three events.
    'min_actions_for_a_rate', c_min_actions,
    'min_decisions_for_a_rate', c_min_decisions,
    -- ⚠ TWO DENOMINATORS, TWO FLAGS. Rates about how work was DECIDED divide by
    -- everything the gate ruled on (performed + gated + blocked); rates about
    -- what the workforce DID divide by what was actually performed. Here that
    -- is 12 vs 4 — one flag would have told the UI the wrong story, and my own
    -- first assertion in this migration got it wrong for exactly that reason.
    'enough_considered', (v_considered >= c_min_actions),
    'enough_performed', (v_ran >= c_min_actions),
    'enough_decisions', (v_decided >= c_min_decisions),

    'actions_considered', v_considered,
    'actions_performed', v_ran,
    'autonomy_rate', case when v_ran >= c_min_actions
      then round((v_auto::numeric / v_ran) * 100, 1) end,
    'actions_autonomous', v_auto,

    'decisions', v_decided,
    'decisions_unchanged', v_unchanged,
    'decisions_edited', v_edited,
    'decisions_rejected', v_rejected,
    'acceptance_rate', case when v_decided >= c_min_decisions
      then round((v_unchanged::numeric / v_decided) * 100, 1) end,
    'edit_rate', case when v_decided >= c_min_decisions
      then round((v_edited::numeric / v_decided) * 100, 1) end,
    'reject_rate', case when v_decided >= c_min_decisions
      then round((v_rejected::numeric / v_decided) * 100, 1) end,

    'median_seconds_to_decide', case when v_decided > 0 then round(coalesce(v_median_s, 0)) end,
    'decided_under_a_minute', v_snap,
    'rubber_stamp_risk', (v_decided >= c_min_decisions and coalesce(v_median_s, 999999) < 60),

    'guardrail_blocks', v_blocked,
    'guardrail_block_rate', case when v_considered >= c_min_actions
      then round((v_blocked::numeric / v_considered) * 100, 1) end,
    'human_gated', v_gated,
    'failures', v_failed,

    -- Recorded, never exercised. The flag is what stops a 0% reading as proof.
    'interventions', v_reversed,
    'intervention_rate', case when v_ran >= c_min_actions
      then round((v_reversed::numeric / v_ran) * 100, 1) end,
    'intervention_ever_recorded', (v_reversed_ever > 0),

    -- ⚠ COUNT, not a rate by default. Incidents are raised by conversations,
    -- evaluations and gates as well as by actions, so dividing them by actions
    -- performed produced 700% here. A rate only when the base is real.
    'incidents', v_incidents,
    'incident_rate_per_100_actions', case when v_ran >= c_min_actions
      then round((v_incidents::numeric / v_ran) * 100, 1) end,

    'employees_active', v_employees,
    'employees_with_a_rule', v_with_rule,
    'rule_coverage_rate', case when v_employees > 0
      then round((v_with_rule::numeric / v_employees) * 100, 1) end
  );
end;
$function$

;
