-- 502_per_archetype_performance_contract.sql
-- ============================================================================
-- docs/37 MOVE 2 + founder decision D3, executed.
--
-- D3 (locked): for a renewal employee, good work is
--   PRIMARY    revenue retained; renewals closed on time
--   SECONDARY  notice deadlines never missed; uplift captured where
--              contractual; the case recorded at close
--
-- Until now every employee was measured by support metrics. Migration 491
-- stopped those fabricating zeros — a queue employee now honestly reports "not
-- measured" — and 499/500 added generic work counts. This is the layer that
-- says what those counts MEAN for a given role.
--
-- ── SHAPE: a metric LIBRARY in code, a CONTRACT in config ──────────────────
-- role_archetypes is platform-level (no tenant_id), so one row reaches every
-- tenant present and future — the pattern migration 497 established for
-- autonomy_templates. The contract holds only REFERENCES: which metrics matter
-- to this role, at which tier, against what target. The formulas live in this
-- function as a closed, whitelisted set — never as SQL carried in data.
-- Adding a sixth archetype that reuses existing metrics is one UPDATE. Adding a
-- genuinely new measure is one branch here plus that UPDATE. That is the
-- honest genericity claim; anything stronger would mean executing strings from
-- a table, which this codebase deliberately does not do (watch_source_catalog
-- exists for the same reason).
--
-- ── THE HONESTY THIS RETURNS ───────────────────────────────────────────────
-- Every metric reports `measurable` alongside its value, and a plain-language
-- `unmeasurable_because` when it is false. That matters because most of D3's
-- contract CANNOT be computed yet, and saying so is the point:
--
--   * NO continuity case has ever closed — in any tenant, ever. All three at
--     outsourcetel-hq sit at stage 'discovered' with outcome NULL, and the
--     case-event ledger holds three rows, all "case opened". The close path is
--     fully built and reachable from three entry points; it has simply never
--     been exercised. So "revenue retained" and "closed on time" have a
--     denominator of ZERO and must read "not measured", never 0%.
--   * continuity_cases has NO closed_at column, so a close TIME can only come
--     from continuity_case_events. updated_at is not a substitute — setting a
--     next step bumps it too.
--   * expected_uplift_cents and loss_reason have NO WRITER ANYWHERE. So uplift
--     CAPTURED is unmeasurable; only uplift ENTITLED is computable, and it is
--     exactly $8,400 on the Lakeshore agreement. Reporting entitled-as-captured
--     would be the same class of lie this whole programme is removing.
--   * Not one notice deadline has elapsed for this tenant yet, so "deadlines
--     missed" is a true 0 rather than an unmeasured one — and the forward-
--     looking companion (deadlines approaching) is the number that is actually
--     useful today.
-- ============================================================================

alter table public.role_archetypes add column if not exists performance_contract jsonb not null default '[]'::jsonb;

comment on column public.role_archetypes.performance_contract is
  'What good work means for this role, as [{metric_key, tier, target}] REFERENCES into the metric library in get_de_contract_metrics. Platform-level, so one row reaches every tenant. Deliberately not SQL: formulas stay in code, contracts stay in config.';

update public.role_archetypes
   set performance_contract = '[
     {"metric_key": "revenue_retained_cents",   "tier": "primary",   "target": null},
     {"metric_key": "renewals_closed_on_time",  "tier": "primary",   "target": 100},
     {"metric_key": "notice_deadlines_missed",  "tier": "secondary", "target": 0},
     {"metric_key": "uplift_entitled_cents",    "tier": "secondary", "target": null},
     {"metric_key": "cases_recorded_at_close",  "tier": "secondary", "target": 100},
     {"metric_key": "deadlines_approaching_30d","tier": "secondary", "target": null}
   ]'::jsonb
 where key = 'renewal_manager';

create or replace function public.get_de_contract_metrics(p_tenant_id uuid, p_de_id uuid)
returns table(
  metric_key text,
  tier text,
  label text,
  unit text,
  value numeric,
  target numeric,
  measurable boolean,
  unmeasurable_because text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_arch text;
  v_contract jsonb;
  c jsonb;
  -- denominators, resolved once
  v_cases int;            -- continuity cases owned by this employee
  v_closed int;           -- ...that reached a terminal stage
  v_deadlines_passed int; -- agreements whose notice deadline has elapsed
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if not (is_platform_admin()
            or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
      raise exception 'not authorized to view this workspace''s performance data';
    end if;
  end if;
  if not (auth.role() is null or auth.role() = 'service_role' or public.can_access_de(p_de_id)) then
    raise exception 'not authorized to view this employee';
  end if;

  select d.archetype_key into v_arch from digital_employees d
   where d.id = p_de_id and d.tenant_id = p_tenant_id;
  if v_arch is null then
    -- No archetype, no contract. Honest silence beats a generic scorecard:
    -- 94 of 116 employees platform-wide have no archetype at all.
    return;
  end if;

  select a.performance_contract into v_contract from role_archetypes a where a.key = v_arch;
  if v_contract is null or v_contract = '[]'::jsonb then
    return;
  end if;

  select count(*),
         count(*) filter (where cc.outcome is not null)
    into v_cases, v_closed
    from continuity_cases cc
   where cc.tenant_id = p_tenant_id and cc.de_id = p_de_id;

  select count(*) into v_deadlines_passed
    from commercial_agreements ag
    join continuity_cases cc on cc.agreement_id = ag.id and cc.de_id = p_de_id
   where ag.tenant_id = p_tenant_id and ag.notice_deadline is not null and ag.notice_deadline < current_date;

  for c in select * from jsonb_array_elements(v_contract) loop
    metric_key := c->>'metric_key';
    tier       := c->>'tier';
    target     := nullif(c->>'target', '')::numeric;
    value      := null;
    measurable := true;
    unmeasurable_because := null;

    case metric_key

      when 'revenue_retained_cents' then
        label := 'Revenue retained'; unit := 'cents';
        if v_closed = 0 then
          measurable := false;
          unmeasurable_because := 'No renewal has been closed yet, so there is nothing retained to count. The closing path exists and has never been used.';
        else
          select coalesce(sum(cc.baseline_cents), 0) into value
            from continuity_cases cc
            left join continuity_stage_config sc
              on sc.tenant_id = cc.tenant_id and sc.stage_key = cc.stage_key
           where cc.tenant_id = p_tenant_id and cc.de_id = p_de_id
             and cc.outcome is not null and coalesce(sc.category, '') = 'won';
        end if;

      when 'renewals_closed_on_time' then
        label := 'Renewals closed on time'; unit := 'percent';
        if v_closed = 0 then
          measurable := false;
          unmeasurable_because := 'No renewal has been closed yet — the percentage has no denominator. Reporting 0% would say the employee missed every renewal, which is not what happened.';
        else
          -- A close TIME can only come from the event ledger: continuity_cases
          -- has no closed_at, and updated_at is bumped by set_next_step too.
          select round(100.0 * count(*) filter (
                   where ev.created_at::date <= ag.notice_deadline) / nullif(count(*), 0), 1)
            into value
            from continuity_cases cc
            join commercial_agreements ag on ag.id = cc.agreement_id
            join lateral (
              select min(e.created_at) as created_at from continuity_case_events e
               where e.objective_id = cc.objective_id and e.to_stage is distinct from 'discovered'
            ) ev on true
           where cc.tenant_id = p_tenant_id and cc.de_id = p_de_id
             and cc.outcome is not null and ag.notice_deadline is not null;
        end if;

      when 'notice_deadlines_missed' then
        label := 'Notice deadlines missed'; unit := 'count';
        -- A true measurement even at zero: the deadlines simply have not
        -- arrived yet. Distinct from "not measured".
        select count(*) into value
          from commercial_agreements ag
          join continuity_cases cc on cc.agreement_id = ag.id and cc.de_id = p_de_id
         where ag.tenant_id = p_tenant_id
           and ag.notice_deadline is not null and ag.notice_deadline < current_date
           and cc.outcome is null;

      when 'deadlines_approaching_30d' then
        label := 'Deadlines inside 30 days'; unit := 'count';
        select count(*) into value
          from commercial_agreements ag
          join continuity_cases cc on cc.agreement_id = ag.id and cc.de_id = p_de_id
         where ag.tenant_id = p_tenant_id
           and ag.notice_deadline is not null
           and ag.notice_deadline >= current_date
           and ag.notice_deadline < current_date + 30
           and cc.outcome is null;

      when 'uplift_entitled_cents' then
        label := 'Contractual uplift entitled'; unit := 'cents';
        -- ENTITLED, not captured. expected_uplift_cents has no writer anywhere
        -- in the schema, so captured is unmeasurable and calling this "captured"
        -- would be a fabrication.
        select coalesce(sum(round(ag.baseline_value_cents
                 * (ag.attributes->>'contractual_increase_pct')::numeric / 100.0)), 0)
          into value
          from commercial_agreements ag
          join continuity_cases cc on cc.agreement_id = ag.id and cc.de_id = p_de_id
         where ag.tenant_id = p_tenant_id
           and ag.baseline_value_cents is not null
           and (ag.attributes->>'contractual_increase_pct') is not null;

      when 'cases_recorded_at_close' then
        label := 'Cases recorded at close'; unit := 'percent';
        if v_closed = 0 then
          measurable := false;
          unmeasurable_because := 'No case has closed yet, so there is nothing to have recorded.';
        else
          value := round(100.0 * v_closed / nullif(v_cases, 0), 1);
        end if;

      else
        label := metric_key; unit := 'unknown';
        measurable := false;
        unmeasurable_because := 'This role''s contract names a metric the library does not implement.';
    end case;

    return next;
  end loop;
end;
$function$;

revoke all on function public.get_de_contract_metrics(uuid, uuid) from public, anon;
grant execute on function public.get_de_contract_metrics(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; r record; n int; n_unmeas int;
begin
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice '502: no fixture — proof SKIPPED'; return; end if;

  select count(*) into n from get_de_contract_metrics(v_tenant, '40d688eb-016d-4f74-8049-1ab2f660182d');
  if n <> 6 then
    raise exception '502: the renewal contract returned % metrics, expected 6', n;
  end if;

  -- The three that genuinely cannot be computed must SAY SO rather than
  -- reporting zero. This is the whole point of the block.
  select count(*) into n_unmeas from get_de_contract_metrics(v_tenant, '40d688eb-016d-4f74-8049-1ab2f660182d')
   where not measurable;
  if n_unmeas = 0 then
    raise exception '502: every metric claims to be measurable — but no renewal has ever closed';
  end if;

  -- An unmeasurable metric must carry NO value. A value beside measurable=false
  -- is exactly the fabrication this migration exists to prevent.
  select count(*) into n from get_de_contract_metrics(v_tenant, '40d688eb-016d-4f74-8049-1ab2f660182d')
   where not measurable and value is not null;
  if n > 0 then
    raise exception '502: % unmeasurable metrics still carry a number', n;
  end if;

  -- The entitled uplift must be the real contractual figure, not zero: the
  -- Lakeshore agreement carries 7% on a $120,000 baseline.
  select * into r from get_de_contract_metrics(v_tenant, '40d688eb-016d-4f74-8049-1ab2f660182d')
   where metric_key = 'uplift_entitled_cents';
  if coalesce(r.value, 0) <= 0 then
    raise exception '502: contractual uplift computed as % — the Lakeshore 7%% should be visible', coalesce(r.value, -1);
  end if;

  -- An employee with no archetype must get an empty contract, not a generic one.
  select count(*) into n from digital_employees d
   where d.tenant_id = v_tenant and d.archetype_key is null limit 1;
  if n > 0 then
    select count(*) into n from get_de_contract_metrics(v_tenant,
      (select id from digital_employees where tenant_id = v_tenant and archetype_key is null limit 1));
    if n <> 0 then
      raise exception '502: an employee with no archetype was given a contract anyway';
    end if;
  end if;

  raise notice '502: renewal contract resolves — % of 6 metrics honestly report they cannot be computed yet', n_unmeas;
end $a$;
