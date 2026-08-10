-- 691 — the true COGS: human-review minutes, modeled honestly (G-D).
--
-- The AI side of every unit is metered to the token; the HUMAN side — the
-- founder deciding 22 of 641 monthly tasks, the 29:1 queue, the 54%
-- escalation share — is measured nowhere, and it is the binding cost.
-- MIT Sloan's 380% production-overrun figure is mostly this blindspot.
--
-- Nobody stopwatches the reviewer, so v1 is MODELED STANDARD MINUTES:
-- founder-editable minutes per decision TYPE × exam-filtered decided tasks,
-- attributed per employee where stamped, divided by LANDED outputs. Every
-- payload carries basis:'modeled_standard_minutes' — this number is never
-- dressed up as a measurement. The dollar line stays NULL with a G-A pointer
-- until the founder's baseline workbook lands an hourly cost.
--
-- Ratchet compliance by construction: decided tasks pass
-- evidence_is_production(origin) (mig 682); outputs pass
-- action_execution_landed() (mig 679) and the production-origin filters.

-- ── 1. Standard minutes: platform defaults + per-tenant overrides ──────────
create table if not exists review_time_standards (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete cascade,   -- NULL = platform default
  task_type  text not null check (task_type in
    ('approval_gate','review_gate','escalation','override','training_feedback',
     'trust_promotion','trust_demotion_notice','checklist','knowledge_revision',
     'inquiry_review','action_approval')),
  minutes    numeric not null check (minutes > 0 and minutes <= 60),
  source     text not null default 'default' check (source in ('default','founder')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists review_time_standards_scope_uq
  on review_time_standards (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), task_type);
alter table review_time_standards enable row level security;
drop policy if exists review_time_standards_read on review_time_standards;
create policy review_time_standards_read on review_time_standards for select using (
  tenant_id is null
  or tenant_id = public.auth_tenant_id()
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
-- Writes: service-role only for now (a founder-facing editor is a later,
-- separate surface). Postgres default INSERT/UPDATE grants stay revoked:
revoke insert, update, delete on review_time_standards from anon, authenticated;

-- Conservative defaults — deliberately LOW, so the modeled cost understates
-- rather than inflates (an honest floor, not a scary ceiling).
insert into review_time_standards (tenant_id, task_type, minutes, source)
values
  (null, 'action_approval',       2, 'default'),
  (null, 'approval_gate',         2, 'default'),
  (null, 'escalation',            4, 'default'),
  (null, 'inquiry_review',        4, 'default'),
  (null, 'review_gate',           3, 'default'),
  (null, 'knowledge_revision',    8, 'default'),
  (null, 'trust_promotion',       3, 'default'),
  (null, 'trust_demotion_notice', 2, 'default'),
  (null, 'checklist',             2, 'default'),
  (null, 'override',              3, 'default'),
  (null, 'training_feedback',     3, 'default')
on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), task_type) do nothing;

-- ── 2. Resolution: tenant override wins, else platform default, else 3 ─────
create or replace function public.resolve_review_minutes(p_tenant_id uuid, p_task_type text)
returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select minutes from review_time_standards
      where tenant_id = p_tenant_id and task_type = p_task_type),
    (select minutes from review_time_standards
      where tenant_id is null and task_type = p_task_type),
    3)
$$;
revoke all on function public.resolve_review_minutes(uuid, text) from public, anon, authenticated;

-- ── 3. The reader — service/definer-internal; the benchmark report and the
--       weekly digest are its consumers ─────────────────────────────────────
create or replace function public.get_review_cost_internal(p_tenant_id uuid, p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(365, p_days)));
  v_by_type jsonb; v_by_de jsonb;
  v_total_minutes numeric := 0; v_unattributed numeric := 0;
  v_landed bigint; v_resolutions bigint; v_work bigint; v_outputs bigint;
  v_monthly numeric; v_rate numeric; v_note text;
begin
  -- Decided review work in the window, exam-filtered, priced in standard minutes.
  select coalesce(jsonb_agg(jsonb_build_object(
           'type', t.type, 'count', t.n, 'minutes_each', t.mins, 'minutes', t.n * t.mins)
           order by t.n * t.mins desc), '[]'::jsonb),
         coalesce(sum(t.n * t.mins), 0)
    into v_by_type, v_total_minutes
    from (
      select h.type, count(*) as n, resolve_review_minutes(p_tenant_id, h.type) as mins
        from human_tasks h
       where h.tenant_id = p_tenant_id
         and h.status in ('approved', 'rejected')
         and h.decided_at >= v_from
         and evidence_is_production(h.origin)   -- 682: deciding an exam is not review work
       group by h.type
    ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'de_id', d.de_id, 'name', d.nm, 'minutes', d.mins) order by d.mins desc), '[]'::jsonb),
         coalesce(sum(d.mins) filter (where d.de_id is null), 0)
    into v_by_de, v_unattributed
    from (
      select h.de_id,
             coalesce(max(de.persona_name), max(de.name), 'unattributed') as nm,
             sum(resolve_review_minutes(p_tenant_id, h.type)) as mins
        from human_tasks h
        left join digital_employees de on de.id = h.de_id
       where h.tenant_id = p_tenant_id
         and h.status in ('approved', 'rejected')
         and h.decided_at >= v_from
         and evidence_is_production(h.origin)
       group by h.de_id
    ) d;

  -- Landed outputs in the same window (the denominators that make it a COGS).
  select count(*) into v_landed
    from action_executions a
   where a.tenant_id = p_tenant_id and a.subject_kind = 'de'
     and a.created_at >= v_from
     and public.action_execution_landed(a);          -- 679: claims are not outputs
  select count(*) into v_resolutions
    from billable_outcomes b
   where b.tenant_id = p_tenant_id and b.kind = 'resolution'
     and b.occurred_at >= v_from
     and evidence_is_production(b.origin);           -- 682
  select count(*) into v_work
    from de_work_items w
   where w.tenant_id = p_tenant_id and w.status = 'done' and w.created_at >= v_from;
  v_outputs := v_landed + v_resolutions + v_work;

  -- Dollars only when the founder's baseline exists — never invented (G-A).
  select avg_fte_cost_monthly_usd into v_monthly
    from workforce_baselines where tenant_id = p_tenant_id;
  if v_monthly is not null and v_monthly > 0 then
    v_rate := round(v_monthly / 173.33, 2);          -- monthly FTE -> hourly
    v_note := 'hourly rate derived from the workspace baseline';
  else
    v_rate := null;
    v_note := 'no human baseline on file — dollars unavailable until the G-A workbook lands';
  end if;

  return jsonb_build_object(
    'basis', 'modeled_standard_minutes',
    'window_days', greatest(1, least(365, p_days)),
    'decided', jsonb_build_object(
      'total_minutes', v_total_minutes, 'by_type', v_by_type,
      'by_de', v_by_de, 'unattributed_minutes', v_unattributed),
    'outputs', jsonb_build_object(
      'landed_actions', v_landed, 'resolutions', v_resolutions,
      'work_items_done', v_work, 'total', v_outputs),
    'minutes_per_output', case when v_outputs > 0 then round(v_total_minutes / v_outputs, 1) end,
    'hourly_rate_usd', v_rate,
    'modeled_cost_usd', case when v_rate is not null then round(v_total_minutes / 60.0 * v_rate, 2) end,
    'note', v_note);
end;
$function$;
revoke all on function public.get_review_cost_internal(uuid, integer) from public, anon, authenticated;
grant execute on function public.get_review_cost_internal(uuid, integer) to service_role;

-- ── 4. The benchmark report carries the human side beside the AI side ──────
-- (682 verbatim + the human_review block; CREATE OR REPLACE preserves ACL.)
create or replace function public.get_benchmark_report(
  p_tenant_id uuid, p_de_id uuid default null, p_days integer default 30
) returns jsonb
language plpgsql security definer set search_path to 'public' stable as $function$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(365, p_days)));
  v_outcomes jsonb; v_quality jsonb; v_csat jsonb; v_cost jsonb; v_sim jsonb; v_review jsonb;
  v_res bigint; v_esc bigint; v_cost_cents numeric;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  -- Billable resolutions only (a human-handled conversation is not an AI
  -- resolution); escalations and blocks all stay in the denominator.
  select count(*) filter (where kind = 'resolution' and billable),
         count(*) filter (where kind = 'escalation')
    into v_res, v_esc
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at >= v_from
     and evidence_is_production(origin)   -- 682
     and (p_de_id is null or de_id = p_de_id);
  v_outcomes := jsonb_build_object(
    'resolutions', v_res, 'escalations', v_esc,
    'resolution_rate_pct', case when v_res + v_esc > 0 then round(100.0 * v_res / (v_res + v_esc), 1) end);

  select jsonb_build_object(
      'graded', count(*),
      'pass_rate_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where verdict = 'pass') / count(*), 1) end,
      'avg_score', case when count(*) > 0 then round(avg(score), 1) end)
    into v_quality
    from eval_judgments
   where tenant_id = p_tenant_id and created_at >= v_from
     and coalesce(source, 'online') not in ('golden', 'simulation')   -- 682: exams grade certification, not live quality
     and (p_de_id is null or de_id = p_de_id);

  -- CSAT is a ±1 thumbs field: % positive is the honest statistic (an
  -- "average of 0.33" is meaningless to a reader).
  select jsonb_build_object(
      'ratings', count(*),
      'positive_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where csat_score = 1) / count(*), 1) end)
    into v_csat
    from de_conversations
   where tenant_id = p_tenant_id and csat_submitted_at is not null and csat_submitted_at >= v_from
     and channel is distinct from 'exam'   -- 682
     and (p_de_id is null or de_id = p_de_id);

  select coalesce(sum(
      u.input_tokens  / 1000000.0 * coalesce(pr.input_price_per_million, 0) * 100
    + u.output_tokens / 1000000.0 * coalesce(pr.output_price_per_million, 0) * 100), 0)
    into v_cost_cents
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
   where u.tenant_id = p_tenant_id and u.created_at >= v_from
     and evidence_is_production(u.origin)   -- 682
     and (p_de_id is null or u.de_id = p_de_id);
  v_cost := jsonb_build_object(
    'ai_spend_cents', round(v_cost_cents),
    'cost_per_resolution_cents', case when v_res > 0 then round(v_cost_cents / v_res) end);

  select jsonb_build_object('mode', mode, 'passed', passed, 'total', total,
                            'avg_score', avg_score, 'status', status, 'ran_at', started_at)
    into v_sim
    from sim_runs
   where tenant_id = p_tenant_id and candidate = false and status in ('passed', 'failed')
     and (p_de_id is null or de_id = p_de_id)
   order by started_at desc limit 1;

  -- 691 (G-D): the human side of the COGS, beside the AI side. Tenant-wide
  -- (the modeled minutes attribute per-DE inside the block itself).
  v_review := public.get_review_cost_internal(p_tenant_id, greatest(1, least(365, p_days)));

  return jsonb_build_object(
    'window_days', greatest(1, least(365, p_days)),
    'de_id', p_de_id,
    'generated_at', now(),
    'outcomes', v_outcomes,
    'judged_quality', v_quality,
    'csat', v_csat,
    'cost', v_cost,
    'human_review', v_review,
    'capability', coalesce(v_sim, jsonb_build_object('status', 'no_simulation_yet')),
    'definitions', jsonb_build_object(
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers that were NOT later handed to a human, as a share of ALL metered outcomes in the window — every escalation, hand-off, and guardrail block counts in the denominator. Certification-exam traffic is excluded from numerator and denominator alike (mig 682).',
      'judged_quality', 'Share of graded LIVE answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone. Certification (golden) and simulation grades are excluded — they measure the exam, not the work.',
      'csat', 'Percent of customer-submitted thumbs ratings that were positive. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend on production traffic in the window divided by billable resolutions delivered.',
      'human_review', 'MODELED, not measured: decided review tasks × founder-editable standard minutes per decision type (exam-origin decisions excluded), divided by landed outputs. Dollars appear only when the workspace baseline (G-A) is on file.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$function$;

-- ── 5. Prove it, in this transaction ───────────────────────────────────────
do $$
declare v_n bigint; v_t uuid; v_r jsonb; v_probe uuid;
begin
  select count(*) into v_n from review_time_standards where tenant_id is null;
  if v_n <> 11 then raise exception '691: expected 11 platform-default standards, found %', v_n; end if;

  select id into v_t from tenants order by created_at limit 1;

  -- Override precedence: a tenant row beats the default, deletion restores it.
  insert into review_time_standards (tenant_id, task_type, minutes, source)
  values (v_t, 'action_approval', 7, 'founder') returning id into v_probe;
  if resolve_review_minutes(v_t, 'action_approval') <> 7 then
    raise exception '691: tenant override did not win';
  end if;
  delete from review_time_standards where id = v_probe;
  if resolve_review_minutes(v_t, 'action_approval') <> 2 then
    raise exception '691: default did not restore after override removal';
  end if;
  if resolve_review_minutes(v_t, 'checklist') <> 2 then
    raise exception '691: platform default not resolved';
  end if;

  -- The reader returns the honest shape, labeled as a model, never a measurement.
  v_r := get_review_cost_internal(v_t, 30);
  if (v_r->>'basis') is distinct from 'modeled_standard_minutes' then
    raise exception '691: basis label missing — the model must never pose as a measurement';
  end if;
  if not (v_r ? 'decided' and v_r ? 'outputs' and v_r ? 'minutes_per_output' and v_r ? 'note') then
    raise exception '691: reader payload incomplete: %', v_r;
  end if;
  if coalesce((v_r->'decided'->>'total_minutes')::numeric, -1) < 0 then
    raise exception '691: negative modeled minutes';
  end if;

  -- The benchmark report now carries the human side, with its definition.
  v_r := get_benchmark_report(v_t);
  if not (v_r ? 'human_review') then
    raise exception '691: benchmark report lacks human_review';
  end if;
  if (v_r->'definitions'->>'human_review') not ilike '%MODELED%' then
    raise exception '691: the definition does not declare the model honestly';
  end if;
end $$;
