-- 707 — the skills organ stops counting exams (the mig-571 defect, recreated
-- one table over, now fixed at ITS read too).
--
-- docs/51 offender #2 (founder-approved fix list, item 2). Live, measured
-- 2026-08-12: Technical Support (hq)'s de_skills row read "Escalated 97.5%
-- of 81 decisions (last 30 days) → Case Resolution level 1" — and 75 of
-- those 81 decisions were its own certification exams. The exam-filtered
-- performance metric (571) sees 6 real decisions for the same employee; the
-- skills organ still saw the exam. Worse than a wrong number on a page:
-- skill gaps feed the development program (mig 680), so exams were
-- MANUFACTURING remedial development work about exam behaviour.
--
-- This is the SECOND time this class shipped (571 fixed it in
-- get_de_performance_metrics on 2026-08-02; assess_de_skills_internal
-- re-created it). The ratchet that stops a THIRD ships beside this
-- migration in scripts/production-evidence.mjs (new sieve arms over
-- evidence_run_decisions / de_conversations count-reads) + certify
-- mutation cases.
--
-- THE FIX, using the write-boundary stamp mig 682 built:
--   · decision signals (Case Resolution, Judgment Calibration) and run
--     signals (Domain Grounding) now require evidence_is_production(origin)
--     on the evidence run — an exam run is judged by the exam's own
--     pass/fail, never twice;
--   · the CSAT signal excludes exam-channel conversations (671 axis) —
--     0 exam conversations have ever carried a CSAT rating (verified live),
--     so this is future-proofing, not a change in today's numbers;
--   · the action signal is untouched (action_executions carry no exam
--     linkage; the audit found that read honest).
-- Nothing is deleted: exams remain in the evidence spine as exams. Only
-- their claim to be a SKILL record is withdrawn.
--
-- Expected founder-visible change (measured before applying): with the
-- honest population, every currently-scored decision-based skill falls
-- under the 10-decision floor and reads "Not yet assessed" —
--   Technical Support (hq):  case_resolution L1 (97.5% of 81) → not assessed (6 real);
--                            judgment_calibration L4 (81)     → not assessed;
--                            domain_grounding L4 (100% of 82) → not assessed (7 real);
--   acme Support DE / Finance DE: stale exam-era rows (26 / 15 decisions)
--                            → not assessed (0 decisions in the live window).
-- Their three open 'skill_gap' development items retire with the evidence
-- that manufactured them. Blank and true beats scored and false.

BEGIN;

CREATE OR REPLACE FUNCTION public.assess_de_skills_internal(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
      and tenant_is_operational(tenant_id)
  loop
    v_weak := '{}';

    -- ── raw signals, all windowed to the last 30 days ──
    -- mig 707: A CERTIFICATION EXAM IS NOT A SKILL RECORD (the 571 rule,
    -- ported to this organ's read). Exams run the live pipeline on purpose,
    -- so their decisions land here indistinguishable from customer work —
    -- counting them scored Technical Support "level 1, escalated 97.5% of 81"
    -- when 75 of the 81 were exam answers, and that score fed the development
    -- program. The origin stamp (682) is written at the boundary and
    -- backfilled; unknown origin defaults to production, so real work is
    -- never silently erased.
    select count(*), count(*) filter (where d.decision = 'needs_review'),
           round(avg(d.confidence) filter (where d.confidence is not null), 1)
      into v_dec_total, v_dec_escalated, v_dec_conf
    from evidence_run_decisions d
    join evidence_runs er on er.id = d.evidence_run_id
    where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id
      and public.evidence_is_production(er.origin)
      and d.created_at > now() - interval '30 days';

    -- Domain grounding measures GENUINE answer attempts only: a run
    -- that never reached the model (llm_not_configured — no key/budget,
    -- an infrastructure state, not a knowledge signal) or was withheld
    -- by a guardrail (blocked — a policy signal, not knowledge) does not
    -- count for or against the DE's domain knowledge. Denominator =
    -- answered + error (the DE tried); numerator = answered.
    -- mig 707: and an exam attempt is the EXAM's evidence, not this organ's.
    select count(*) filter (where answer_status in ('answered', 'error')),
           count(*) filter (where answer_status = 'blocked'),
           count(*) filter (where answer_status = 'answered')
      into v_run_total, v_run_blocked, v_run_answered
    from evidence_runs
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and public.evidence_is_production(origin)
      and created_at > now() - interval '30 days';

    -- mig 707: exam-channel threads carry no customer to rate them — 0 such
    -- rows exist (verified live) — but the axis is excluded on principle so
    -- this read can never regress into the class.
    select count(*) filter (where csat_submitted_at is not null),
           count(*) filter (where csat_score = 1)
      into v_csat_total, v_csat_pos
    from de_conversations
    where tenant_id = v_de.tenant_id and de_id = v_de.id
      and channel is distinct from 'exam'
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
$function$;

REVOKE ALL ON FUNCTION public.assess_de_skills_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assess_de_skills_internal(uuid) TO service_role;

-- ── Re-assess the hq workspace NOW and prove the record went honest ─────────
DO $probe$
DECLARE
  v_hq uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_ts uuid;
  v_n int; v_expect int;
  v_raw_before bigint; v_raw_after bigint;
  v_prof int; v_sample int; v_detail text;
  v_arms text := '';
BEGIN
  -- S1 (always): one signature.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname = 'public' AND p.proname = 'assess_de_skills_internal';
  IF v_n <> 1 THEN RAISE EXCEPTION 'S1 FAILED: % overloads of assess_de_skills_internal', v_n; END IF;

  -- S2 (always): perimeter — service_role only.
  IF has_function_privilege('anon', 'public.assess_de_skills_internal(uuid)', 'execute')
     OR has_function_privilege('authenticated', 'public.assess_de_skills_internal(uuid)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: assess_de_skills_internal executable by the perimeter';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.assess_de_skills_internal(uuid)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: service_role lost EXECUTE — the daily cron would silently stop';
  END IF;

  -- D-block: run the organ for the hq workspace and hold its output to an
  -- independent recount. Population-guarded (dev has no evidence rows) and
  -- honest about it: each arm names itself run or skipped.
  SELECT id INTO v_ts FROM digital_employees
   WHERE tenant_id = v_hq AND name = 'Technical Support' LIMIT 1;

  IF v_ts IS NOT NULL THEN
    SELECT count(*) INTO v_raw_before FROM evidence_run_decisions d
      JOIN evidence_runs er ON er.id = d.evidence_run_id
     WHERE er.tenant_id = v_hq AND er.de_id = v_ts;

    PERFORM public.assess_de_skills_internal(v_hq);

    -- D1: the stored sample equals the PRODUCTION population, not the exam one.
    SELECT count(*) INTO v_expect FROM evidence_run_decisions d
      JOIN evidence_runs er ON er.id = d.evidence_run_id
     WHERE er.tenant_id = v_hq AND er.de_id = v_ts
       AND public.evidence_is_production(er.origin)
       AND d.created_at > now() - interval '30 days';
    SELECT proficiency, sample_size, detail INTO v_prof, v_sample, v_detail
      FROM de_skills WHERE tenant_id = v_hq AND de_id = v_ts AND skill_key = 'case_resolution';
    IF v_sample IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'D1 FAILED: case_resolution sample=% but production decision count=% — the organ still counts something else', v_sample, v_expect;
    END IF;
    -- D2: under the 10-decision floor the skill must be UNSCORED, not scored
    -- on exams. (If real work later pushes the count past 10, a score over
    -- production decisions is the intended behaviour and this arm stays green.)
    IF v_expect < 10 AND v_prof IS NOT NULL THEN
      RAISE EXCEPTION 'D2 FAILED: % production decisions is under the floor yet proficiency=% — scored on a population it should not see', v_expect, v_prof;
    END IF;
    v_arms := v_arms || format(' D1+D2(sample=%s, prof=%s)', v_sample, coalesce(v_prof::text, 'null'));

    -- D3: nothing was deleted — the raw evidence (exams included) is intact.
    SELECT count(*) INTO v_raw_after FROM evidence_run_decisions d
      JOIN evidence_runs er ON er.id = d.evidence_run_id
     WHERE er.tenant_id = v_hq AND er.de_id = v_ts;
    IF v_raw_after <> v_raw_before THEN
      RAISE EXCEPTION 'D3 FAILED: raw decisions %→% — the migration must stop COUNTING evidence, never remove it', v_raw_before, v_raw_after;
    END IF;
    v_arms := v_arms || format(' D3(raw=%s intact)', v_raw_after);

    -- D4: if no skill remains weak (all proficiencies null or >2), the
    -- exam-manufactured skill_gap development item must have retired.
    IF NOT EXISTS (SELECT 1 FROM de_skills
                    WHERE tenant_id = v_hq AND de_id = v_ts
                      AND proficiency IS NOT NULL AND proficiency <= 2) THEN
      IF EXISTS (SELECT 1 FROM de_development_items
                  WHERE tenant_id = v_hq AND de_id = v_ts AND item_type = 'skill_gap'
                    AND source = 'detected' AND status IN ('proposed', 'in_progress')) THEN
        RAISE EXCEPTION 'D4 FAILED: no weak skill remains, yet the skill_gap development item is still open — the program is still chasing exam ghosts';
      END IF;
      v_arms := v_arms || ' D4(gap item retired)';
    ELSE
      v_arms := v_arms || ' D4(a weak skill legitimately remains — item stays)';
    END IF;
  ELSE
    v_arms := v_arms || ' D1-D4(SKIPPED: hq Technical Support absent — structural arms only)';
  END IF;

  RAISE NOTICE '707 asserts passed:%', v_arms;
END
$probe$;

COMMIT;
