-- 647_a_case_per_project_not_a_daily_sweep.sql
-- ============================================================================
-- Onboarding ran on a daily SHIFT: a `schedule` watcher firing every 1440
-- minutes called "Daily onboarding progress review". It has no source and reads
-- no projects — it just wakes the employee once a day to go and look. The unit
-- of work was "a day", not "a customer".
--
-- The unit of work is a customer. One project, one case, worked to completion.
-- Mig 646 registered onboarding_projects as a watchable source; this makes the
-- switch.
--
-- WHY A CASE PER PROJECT IS ACTUALLY EXACTLY ONE. Two independent mechanisms,
-- both already in run_work_watchers' generic arm — neither invented here:
--   1. The query itself excludes anything this watcher has already matched:
--      `AND NOT EXISTS (SELECT 1 FROM work_watcher_matches m
--                        WHERE m.watcher_id = $3 AND m.subject_ref = t.id::text)`
--      so a project that has ever opened a case never opens another.
--   2. work_watcher_matches carries UNIQUE (watcher_id, occurrence_key) with
--      occurrence_key = id|field|op|value — no date in it, so ticking again
--      cannot manufacture a second occurrence.
-- Run the tick a hundred times: one case.
--
-- AND IT ARRIVES KNOWING THINGS. The generic arm writes
-- `jsonb_object_agg_subset(v_row, v_cat.subject_columns)` into plan.subject —
-- name, status, target_golive, progress_pct, account_id — which de-work now
-- renders into the prompt, alongside the project record and its checklist from
-- the desk added in 646. The daily sweep could not do this: a shift has no
-- subject, so the employee woke holding a date.
--
-- THE CONDITION is `progress_pct < 100`. progress_pct is NOT NULL DEFAULT 0, so
-- a project matches the moment it is created — which is the point. Combined
-- with the catalog's base predicate (`completed_at IS NULL`), finished work is
-- never handed out.
--
-- RETIRED, NOT DELETED. The daily sweep watcher is deactivated and its template
-- removed from the archetype. The row stays so the history of what it opened
-- remains readable.
--
-- ⚠ HONEST LIMIT, stated because the assertions below cannot: this will match
-- nothing today. The only onboarding_projects row in the system belongs to
-- acme-telecom, which is SUSPENDED and has no onboarding employee; the only
-- onboarding employee is in outsourcetel-hq, which has no projects. The watcher
-- is correct and live, and it is waiting for a project to exist. That is a data
-- gap, not a defect, and it must not be reported as "working".
-- ============================================================================

begin;

-- ── 1. The archetype: swap the shift for the per-project signal. ──────────
-- Every future onboarding hire installs this instead. The unrelated
-- "weak start" health watcher is preserved untouched.
update role_archetypes
   set watcher_templates = (
     select jsonb_agg(t)
       from jsonb_array_elements(watcher_templates) t
      where t->>'label' <> 'Daily onboarding progress review'
   ) || jsonb_build_array(jsonb_build_object(
     'kind', 'state_condition',
     'label', 'Onboarding project needs setup work',
     'description', 'Open one case per customer being onboarded, and work it to go-live. Replaces the daily review shift: the unit of work is a customer, not a day.',
     'config', jsonb_build_object(
       'source', 'onboarding_projects',
       'field',  'progress_pct',
       'op',     'lt',
       'value',  '100',
       'response_window', jsonb_build_object('unit', 'days', 'amount', 3))))
 where key = 'onboarding';

-- ── 2. Existing employees: install the new signal. ────────────────────────
-- The BEFORE trigger trg_validate_work_watcher runs validate_watcher_config on
-- this insert, so a config the installer would refuse cannot land here either.
insert into work_watchers (tenant_id, de_id, kind, label, config, active)
select de.tenant_id, de.id, 'state_condition',
       'Onboarding project needs setup work',
       jsonb_build_object(
         'source', 'onboarding_projects',
         'field',  'progress_pct',
         'op',     'lt',
         'value',  '100',
         'response_window', jsonb_build_object('unit', 'days', 'amount', 3)),
       true
  from digital_employees de
  join tenants t on t.id = de.tenant_id
 where t.status = 'active'
   and de.archetype_key = 'onboarding'
   and not exists (
     select 1 from work_watchers w
      where w.tenant_id = de.tenant_id and w.de_id = de.id
        and w.kind = 'state_condition'
        and w.config->>'source' = 'onboarding_projects');

-- ── 3. Retire the shift. Deactivated, not deleted. ────────────────────────
update work_watchers
   set active = false
 where kind = 'schedule'
   and label = 'Daily onboarding progress review'
   and active;

-- ── 4. Prove the swap, both directions. ───────────────────────────────────
do $$
declare
  v_sweeps_live int;
  v_installed   int;
  v_expected    int;
  v_tmpl_sweep  int;
  v_tmpl_new    int;
  v_tmpl_kept   int;
begin
  -- The shift is gone from the archetype, the new signal is there, and the
  -- unrelated watcher it shipped alongside was NOT collateral damage.
  select count(*) into v_tmpl_sweep from role_archetypes r,
         jsonb_array_elements(r.watcher_templates) t
   where r.key = 'onboarding' and t->>'label' = 'Daily onboarding progress review';
  select count(*) into v_tmpl_new from role_archetypes r,
         jsonb_array_elements(r.watcher_templates) t
   where r.key = 'onboarding' and t->'config'->>'source' = 'onboarding_projects';
  select count(*) into v_tmpl_kept from role_archetypes r,
         jsonb_array_elements(r.watcher_templates) t
   where r.key = 'onboarding' and t->>'label' = 'New account off to a weak start';

  if v_tmpl_sweep <> 0 then raise exception '647: the daily sweep is still in the archetype'; end if;
  if v_tmpl_new  <> 1 then raise exception '647: expected 1 per-project template, found %', v_tmpl_new; end if;
  if v_tmpl_kept <> 1 then raise exception '647: the unrelated health watcher was destroyed — collateral damage'; end if;

  -- No daily sweep is still running anywhere.
  select count(*) into v_sweeps_live from work_watchers
   where kind = 'schedule' and label = 'Daily onboarding progress review' and active;
  if v_sweeps_live <> 0 then
    raise exception '647: % daily sweep watcher(s) still active', v_sweeps_live;
  end if;

  -- Every onboarding employee in a live workspace now owns the new signal.
  select count(*) into v_expected
    from digital_employees de join tenants t on t.id = de.tenant_id
   where t.status = 'active' and de.archetype_key = 'onboarding';
  select count(*) into v_installed
    from work_watchers w
    join digital_employees de on de.id = w.de_id
    join tenants t on t.id = w.tenant_id
   where t.status = 'active' and de.archetype_key = 'onboarding'
     and w.kind = 'state_condition' and w.config->>'source' = 'onboarding_projects'
     and w.active;

  if v_expected = 0 then
    raise notice '647: no onboarding employees in active tenants here — install skipped (expected on dev/replay)';
  elsif v_installed <> v_expected then
    raise exception '647: % onboarding employees but % have the per-project watcher', v_expected, v_installed;
  else
    raise notice '647: % onboarding employee(s) switched from a daily shift to a case per project', v_installed;
  end if;
end $$;

commit;
