-- DE-C1: the Skills Framework (constitution §4) — evidence-assessed
-- proficiency, opening Wave C.
--
-- The constitution's §4.4 is the whole design constraint, verbatim:
-- "Skills are NOT self-reported. They are assessed from observable
-- evidence." digital_employees.skills has been a jsonb column since
-- migration 001 ({name, proficiency, evidence}) — static, self-
-- reported, displayed nowhere. This migration replaces that idea with
-- a real assessment: five platform-defined skills (one per §4.2
-- category), each bound to exactly ONE observable evidence signal this
-- platform already captures, assessed on a rolling 30-day window.
--
-- ANTI-FABRICATION RULES enforced here:
--   1. Every skill maps to a REAL signal (no invented competencies).
--   2. Below a minimum sample size → proficiency is NULL
--      ("insufficient evidence"), never a guessed number. On a young
--      workspace most skills read "not yet assessed" — that is the
--      honest output, not a gap to paper over.
--   3. Auto-assessment CAPS AT LEVEL 4. Level 5 ("Expert — can inform
--      Capability design", §4.3) is a human judgment the machine must
--      not award to itself.
--   4. Proficiency thresholds are invented v1 judgment calls (this
--      codebase has no historical baseline) — flagged here explicitly,
--      same category as the frustration>=50 / dev-needs precedents.
--
-- NOT built (honest scope): per-work-category skill breakdowns (e.g.
-- "Billing Process" vs "Helpdesk Process") would require tagging each
-- evidence run with the capability/skill it exercised — a real
-- evidence-schema change, deferred. This assesses each skill at the
-- employee level from its whole-workspace evidence.

-- ────────────────────────────────────────────────────────────────
-- 1. Skill catalog — platform-defined taxonomy (§4.2). Reference data,
--    seeded below; readable by any authenticated user.
-- ────────────────────────────────────────────────────────────────
create table if not exists skill_catalog (
  skill_key    text primary key,
  name         text not null,
  category     text not null check (category in ('domain', 'process', 'communication', 'analytical', 'integration')),
  description  text not null,
  signal_label text not null,       -- plain-language name of the evidence signal
  higher_is_better boolean not null default true,
  min_sample   integer not null,    -- below this → insufficient evidence
  sort_order   integer not null default 0
);

alter table skill_catalog enable row level security;
drop policy if exists skill_catalog_read on skill_catalog;
create policy skill_catalog_read on skill_catalog for select to authenticated using (true);

insert into skill_catalog (skill_key, name, category, description, signal_label, higher_is_better, min_sample, sort_order) values
  ('case_resolution', 'Case Resolution', 'process',
   'Handling standard and non-standard work independently without kicking it to a human.',
   'Escalation rate on real decisions (lower is better)', false, 10, 1),
  ('judgment_calibration', 'Judgment Calibration', 'analytical',
   'Reaching confident, well-grounded decisions rather than hesitating on everything.',
   'Average confidence across real decisions', true, 10, 2),
  ('domain_grounding', 'Domain Knowledge Grounding', 'domain',
   'Actually having the knowledge to answer, rather than coming up empty.',
   'Share of non-blocked runs that produced a real answer', true, 10, 3),
  ('communication_quality', 'Communication Quality', 'communication',
   'The quality of what customers actually receive, as they rate it.',
   'Positive CSAT rate (thumbs up share)', true, 5, 4),
  ('system_integration', 'System Integration', 'integration',
   'Executing actions against connected systems successfully, not failing on them.',
   'Action execution success rate', true, 5, 5)
on conflict (skill_key) do update set
  name = excluded.name, category = excluded.category, description = excluded.description,
  signal_label = excluded.signal_label, higher_is_better = excluded.higher_is_better,
  min_sample = excluded.min_sample, sort_order = excluded.sort_order;

-- ────────────────────────────────────────────────────────────────
-- 2. Per-employee assessed proficiency.
-- ────────────────────────────────────────────────────────────────
create table if not exists de_skills (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  de_id        uuid not null references digital_employees(id) on delete cascade,
  skill_key    text not null references skill_catalog(skill_key),
  proficiency  integer check (proficiency is null or (proficiency between 1 and 5)),  -- null = insufficient evidence
  sample_size  integer not null default 0,
  signal_value numeric,             -- the raw measured signal (e.g. 12.5 = 12.5% escalation)
  detail       text not null default '',
  assessed_at  timestamptz not null default now(),
  unique (tenant_id, de_id, skill_key)
);

create index if not exists de_skills_de_idx on de_skills(tenant_id, de_id);

alter table de_skills enable row level security;
drop policy if exists de_skills_tenant_select on de_skills;
create policy de_skills_tenant_select on de_skills
  for select to authenticated using (tenant_id = auth_tenant_id());
-- Writes only via the assessment RPCs below.

-- ────────────────────────────────────────────────────────────────
-- 3. de_development_items: allow a 'skill_gap' item so §4.5 ("skill
--    gaps drive Development recommendations") is real. One consolidated
--    item per DE listing the sub-threshold skills, refreshed each
--    assessment (the on-conflict unique key is (tenant, de, item_type),
--    so one skill_gap item, not one per skill — matching how
--    escalation_spike etc. work).
-- ────────────────────────────────────────────────────────────────
alter table de_development_items drop constraint if exists de_development_items_item_type_check;
alter table de_development_items add constraint de_development_items_item_type_check
  check (item_type in ('confidence_gap', 'escalation_spike', 'error_rate', 'guardrail_pattern', 'skill_gap', 'manual'));

-- ────────────────────────────────────────────────────────────────
-- 4. The assessment — service-side, idempotent, 30-day window.
--    Loops non-retired DEs; computes each skill from its real signal;
--    upserts de_skills; emits a skill_updated audit event on a
--    material proficiency change; and keeps the skill_gap development
--    item in sync. Thresholds are v1 judgment calls (flagged above).
-- ────────────────────────────────────────────────────────────────
create or replace function assess_de_skills_internal(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_de record;
  v_updated integer := 0;
  -- signal scratch
  v_dec_total integer; v_dec_escalated integer; v_dec_conf numeric;
  v_run_total integer; v_run_blocked integer; v_run_answered integer;
  v_csat_total integer; v_csat_pos integer;
  v_act_total integer; v_act_ok integer;
  -- per-skill result
  v_prof integer; v_prev integer; v_sample integer; v_value numeric; v_detail text;
  v_weak text[];
  v_weak_names text;
begin
  for v_de in
    select id, tenant_id, name from digital_employees
    where lifecycle_status not in ('retired', 'archived')
      and (p_tenant_id is null or tenant_id = p_tenant_id)
  loop
    v_weak := '{}';

    -- ── raw signals, all windowed to the last 30 days ──
    select count(*), count(*) filter (where d.decision = 'needs_review'),
           round(avg(d.confidence) filter (where d.confidence is not null), 1)
      into v_dec_total, v_dec_escalated, v_dec_conf
    from evidence_run_decisions d
    join evidence_runs er on er.id = d.evidence_run_id
    where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id
      and d.created_at > now() - interval '30 days';

    -- Domain grounding measures GENUINE answer attempts only: a run
    -- that never reached the model (llm_not_configured — no key/budget,
    -- an infrastructure state, not a knowledge signal) or was withheld
    -- by a guardrail (blocked — a policy signal, not knowledge) does not
    -- count for or against the DE's domain knowledge. Denominator =
    -- answered + error (the DE tried); numerator = answered.
    select count(*) filter (where answer_status in ('answered', 'error')),
           count(*) filter (where answer_status = 'blocked'),
           count(*) filter (where answer_status = 'answered')
      into v_run_total, v_run_blocked, v_run_answered
    from evidence_runs
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and created_at > now() - interval '30 days';

    select count(*) filter (where csat_submitted_at is not null),
           count(*) filter (where csat_score = 1)
      into v_csat_total, v_csat_pos
    from de_conversations
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and csat_submitted_at > now() - interval '30 days';

    select count(*) filter (where decision in ('auto_executed', 'executed_after_approval', 'failed')),
           count(*) filter (where decision in ('auto_executed', 'executed_after_approval'))
      into v_act_total, v_act_ok
    from action_executions
    where tenant_id = v_de.tenant_id and subject_kind = 'de' and subject_id = v_de.id
      and mode = 'execute' and created_at > now() - interval '30 days';

    -- ── skill 1: Case Resolution (escalation rate, lower better) ──
    v_sample := coalesce(v_dec_total, 0);
    if v_sample >= 10 then
      v_value := round(100.0 * v_dec_escalated / v_sample, 1);
      v_prof := case when v_value <= 10 then 4 when v_value <= 25 then 3 when v_value <= 50 then 2 else 1 end;
      v_detail := format('Escalated %s%% of %s decisions (last 30 days). Lower is better; level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 real decisions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'case_resolution', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Case Resolution'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 2: Judgment Calibration (avg confidence, higher better) ──
    v_sample := coalesce(v_dec_total, 0);
    if v_sample >= 10 and v_dec_conf is not null then
      v_value := v_dec_conf;
      v_prof := case when v_value >= 80 then 4 when v_value >= 65 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('Average confidence %s%% across %s decisions (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 real decisions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'judgment_calibration', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Judgment Calibration'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 3: Domain Grounding (answered share of non-blocked) ──
    v_sample := coalesce(v_run_total, 0);
    if v_sample >= 10 then
      v_value := round(100.0 * v_run_answered / v_sample, 1);
      v_prof := case when v_value >= 90 then 4 when v_value >= 75 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('Produced a real answer on %s%% of %s genuine answer attempts (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 10 genuine answer attempts needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'domain_grounding', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Domain Knowledge Grounding'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 4: Communication Quality (positive CSAT) ──
    v_sample := coalesce(v_csat_total, 0);
    if v_sample >= 5 then
      v_value := round(100.0 * v_csat_pos / v_sample, 1);
      v_prof := case when v_value >= 90 then 4 when v_value >= 75 then 3 when v_value >= 50 then 2 else 1 end;
      v_detail := format('%s%% positive across %s ratings (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 5 customer ratings needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'communication_quality', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'Communication Quality'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── skill 5: System Integration (action success rate) ──
    v_sample := coalesce(v_act_total, 0);
    if v_sample >= 5 then
      v_value := round(100.0 * v_act_ok / v_sample, 1);
      v_prof := case when v_value >= 95 then 4 when v_value >= 85 then 3 when v_value >= 60 then 2 else 1 end;
      v_detail := format('%s%% of %s executed actions succeeded (last 30 days). Level 5 is human-awarded.', v_value, v_sample);
    else
      v_prof := null; v_value := null;
      v_detail := format('Not yet assessed — %s of the 5 executed actions needed.', v_sample);
    end if;
    call upsert_de_skill(v_de.tenant_id, v_de.id, 'system_integration', v_prof, v_sample, v_value, v_detail, v_prev);
    if v_prof is not null and v_prof <= 2 then v_weak := array_append(v_weak, 'System Integration'); end if;
    if v_prof is distinct from v_prev then v_updated := v_updated + 1; end if;

    -- ── §4.5: skill gaps drive Development. One consolidated item per
    --    DE, refreshed; removed when no skills are weak. ──
    if array_length(v_weak, 1) is not null then
      v_weak_names := array_to_string(v_weak, ', ');
      insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, baseline_value, status)
      values (v_de.tenant_id, v_de.id, 'skill_gap', 'detected', 'medium',
        format('%s is below Proficient (level 3) on: %s. These are assessed from real 30-day evidence — target level 3+.', v_de.name, v_weak_names),
        'skill_proficiency', 3, 2, 'proposed')
      on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
      do update set description = excluded.description, updated_at = now();
    else
      -- No weak skills → retire any still-open detected skill_gap item.
      update de_development_items set status = 'completed', updated_at = now()
      where tenant_id = v_de.tenant_id and de_id = v_de.id and item_type = 'skill_gap'
        and source = 'detected' and status in ('proposed', 'in_progress');
    end if;
  end loop;

  return jsonb_build_object('skills_changed', v_updated);
end;
$$;

revoke all on function assess_de_skills_internal(uuid) from public, anon, authenticated;
grant execute on function assess_de_skills_internal(uuid) to service_role;

-- Helper: upsert one skill row and return the PRIOR proficiency (for
-- material-change detection + the skill_updated event). A PROCEDURE so
-- the INOUT prior-value can be read back via CALL. Service-only; emits
-- the audit event on a real change.
create or replace procedure upsert_de_skill(
  p_tenant_id uuid, p_de_id uuid, p_skill_key text,
  p_prof integer, p_sample integer, p_value numeric, p_detail text,
  inout p_prev integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select proficiency into p_prev from de_skills
  where tenant_id = p_tenant_id and de_id = p_de_id and skill_key = p_skill_key;

  insert into de_skills (tenant_id, de_id, skill_key, proficiency, sample_size, signal_value, detail, assessed_at)
  values (p_tenant_id, p_de_id, p_skill_key, p_prof, p_sample, p_value, p_detail, now())
  on conflict (tenant_id, de_id, skill_key)
  do update set proficiency = excluded.proficiency, sample_size = excluded.sample_size,
                signal_value = excluded.signal_value, detail = excluded.detail, assessed_at = now();

  -- §4.4: a material change in a skill's proficiency emits a
  -- skill_updated event. Only a real level change (both sides
  -- non-null and different) counts — first assessment / evidence
  -- appearing is noted but not spammed as a "change".
  if p_prev is not null and p_prof is not null and p_prev <> p_prof then
    select name into v_name from skill_catalog where skill_key = p_skill_key;
    perform append_audit_event_internal(
      p_tenant_id, 'Skills assessment', 'system',
      format('%s proficiency changed from level %s to level %s', coalesce(v_name, p_skill_key), p_prev, p_prof),
      'config_change',
      jsonb_build_object('kind', 'skill_updated', 'de_id', p_de_id, 'skill_key', p_skill_key, 'from', p_prev, 'to', p_prof)
    );
  end if;
end;
$$;

revoke all on procedure upsert_de_skill(uuid, uuid, text, integer, integer, numeric, text, integer) from public, anon, authenticated;
grant execute on procedure upsert_de_skill(uuid, uuid, text, integer, integer, numeric, text, integer) to service_role;

-- On-demand authed wrapper (an "Assess now" button for owner/admins).
-- Resolves its own tenant via auth_tenant_id() (Remote-Access-aware),
-- so the client never has to pass — or know — the tenant id.
create or replace function assess_de_skills()
returns setof de_skills
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can run a skills assessment';
  end if;
  perform assess_de_skills_internal(v_tenant);
  return query select * from de_skills where tenant_id = v_tenant;
end;
$$;

revoke all on function assess_de_skills() from public, anon;
grant execute on function assess_de_skills() to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. Daily cadence (§4.4 "rolling 30-day basis" — window is 30 days,
--    refreshed daily). Own plain-SQL cron, same pattern as the
--    incident + dev-needs sweeps.
-- ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-skill-assessment-daily') then
    perform cron.unschedule('de-skill-assessment-daily');
  end if;
  perform cron.schedule('de-skill-assessment-daily', '30 6 * * *', 'select assess_de_skills_internal()');
end $$;

-- Initial assessment across all workspaces.
select assess_de_skills_internal();
