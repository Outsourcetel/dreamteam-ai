-- 274_cross_de_missions.sql
-- ============================================================================
-- CROSS-DE (TEAM) MISSIONS (T2.4). Today a mission targets exactly one DE
-- (de_missions.de_id NOT NULL). This lets a manager give ONE order to a team /
-- role / supervisor; approve() then routes each scoped entity's case to the
-- RIGHT receiver DE. Single-DE missions are untouched (back-compat).
--
-- Enforcement rides for free: de-work binds every case to item.de_id's OWN
-- trust dial / guardrails / model / grants / action-gates, so routing physically
-- cannot launder work into a more-autonomous DE. Cancel stays cross-DE because
-- set_de_mission_state keys on mission_id (mig 248 / mig 273).
--
-- Designed via design→adversarial-verify (workflow wf_4af5f606-fb6, crossde
-- track, execute_ready=true). Adversary fixes folded in:
--   #1 client de_ids/supervisor never tenant-validated → cross-tenant write:
--      create_de_team_mission REJECTS any out-of-tenant/inactive de_id AT
--      CREATION; the edge resolver bounds every pick to an in-tenant candidate
--      set (edge-fn change, next commit).
--   #2 claim_de_work_items pause-guard: reproduced FROM LIVE (mig 249, lifecycle
--      guard preserved) + a NULL-safe anti-join so a paused/cancelled mission
--      stops claiming for single AND team missions, without dropping non-mission
--      work and without aborting the global claim.
--   #6 no blind DELETE in a global migration (the pre-dedupe hazard) — this
--      migration adds no dedupe index at all (see note below).
-- NOTE (deviation from the vetted plan, deliberate): the plan added a global
--   UNIQUE (mission_id, entity_ref) index as an idempotency backstop. We DROP
--   that: a multi-watcher STANDING mission (mig 273) legitimately opens cases
--   with the same (mission_id, entity_ref) from two different watchers, which
--   the index would make fail. Idempotency for team fan-out is already provided
--   by approve()'s explicit per-(mission,entity) exists-check plus the
--   status→'running' transition that rejects a second approve.
-- GLOBAL, additive. de_objectives.de_id stays NOT NULL (receiver resolved
-- BEFORE insert); routing reason lives in de_objectives.plan / mission.report.
-- ============================================================================

-- ── 1. de_missions: one DE OR a team target, never both, never neither ──────
ALTER TABLE de_missions ALTER COLUMN de_id DROP NOT NULL;
ALTER TABLE de_missions ADD COLUMN IF NOT EXISTS target_spec jsonb;
-- XOR: exactly one of (de_id, target_spec). Existing rows have de_id set and
-- target_spec null → num_nonnulls = 1 → all pass. Add NOT VALID then VALIDATE.
ALTER TABLE de_missions DROP CONSTRAINT IF EXISTS de_missions_target_xor;
ALTER TABLE de_missions ADD CONSTRAINT de_missions_target_xor
  CHECK (num_nonnulls(de_id, target_spec) = 1) NOT VALID;
ALTER TABLE de_missions VALIDATE CONSTRAINT de_missions_target_xor;

-- ── 2. Mission pause/cancel instantly stops claiming (fix #2) ───────────────
-- Reproduced FROM LIVE (mig 249). The two lifecycle-guard lines below are the
-- mig-249 fix and MUST stay. The only addition is the mission-status anti-join.
CREATE OR REPLACE FUNCTION public.claim_de_work_items(
  p_limit integer DEFAULT 10, p_worker text DEFAULT 'worker'::text, p_tenant_id uuid DEFAULT NULL::uuid)
RETURNS SETOF de_work_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  return query
  with due as (
    select w.id
    from de_work_items w
    join digital_employees de on de.id = w.de_id
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      -- WAVE-1 FIX (mig 249): an unavailable employee's items stay queued.
      and de.status = 'active'
      and de.lifecycle_status not in ('paused', 'retired', 'archived')
      -- T2.4: a paused/cancelled mission's fanned work stops claiming at once,
      -- for single AND team missions. NULL-safe: non-mission items (objective_id
      -- null, or objective without a mission) are unaffected.
      and not exists (
        select 1 from de_objectives o
        join de_missions m on m.id = o.mission_id
        where o.id = w.objective_id and m.status in ('paused', 'cancelled'))
      and (w.depends_on is null
           or exists (select 1 from de_work_items d where d.id = w.depends_on and d.status = 'done'))
    order by w.scheduled_for asc
    limit greatest(1, least(100, p_limit))
    for update skip locked
  )
  update de_work_items w
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = w.attempts + 1, updated_at = now()
    from due
   where w.id = due.id
  returning w.*;
end;
$function$;

-- ── 3. Guarded creation of a team mission (fix #1) ──────────────────────────
-- Role-gated like create_de_mission. Rejects any explicit/supervisor de_id that
-- is not in THIS tenant and active — so no client input can ever seed a
-- cross-tenant receiver. Inserts de_id NULL + target_spec (XOR-satisfying).
CREATE OR REPLACE FUNCTION public.create_de_team_mission(p_target_spec jsonb, p_directive text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_id uuid; v_kind text; v_routing text;
  v_de_ids uuid[]; v_sup uuid; v_arch text; v_bad int;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(
       ARRAY['tenant_owner','tenant_admin','tenant_manager']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF length(btrim(coalesce(p_directive,''))) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'directive_too_short');
  END IF;

  v_kind    := p_target_spec->>'kind';
  v_routing := coalesce(p_target_spec->>'routing', 'auto');
  IF v_kind NOT IN ('archetype','explicit','supervisor') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_target_kind');
  END IF;
  IF v_routing NOT IN ('auto','owner_continuity','least_loaded','round_robin') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_routing');
  END IF;

  IF v_kind = 'archetype' THEN
    v_arch := p_target_spec->>'archetype_key';
    IF v_arch IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'archetype_required');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM digital_employees
                   WHERE tenant_id = v_tenant AND archetype_key = v_arch AND status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_active_de_for_archetype');
    END IF;

  ELSIF v_kind = 'explicit' THEN
    BEGIN
      SELECT array_agg((x)::uuid) INTO v_de_ids
        FROM jsonb_array_elements_text(coalesce(p_target_spec->'de_ids', '[]'::jsonb)) x;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_de_ids');
    END;
    IF v_de_ids IS NULL OR array_length(v_de_ids, 1) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'de_ids_required');
    END IF;
    SELECT count(*) INTO v_bad FROM unnest(v_de_ids) d
     WHERE NOT EXISTS (SELECT 1 FROM digital_employees
                       WHERE id = d AND tenant_id = v_tenant AND status = 'active');
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'unknown_or_foreign_de');
    END IF;

  ELSE  -- supervisor
    BEGIN
      v_sup := (p_target_spec->>'supervisor_de_id')::uuid;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_supervisor_id');
    END;
    IF v_sup IS NULL OR NOT EXISTS (SELECT 1 FROM digital_employees
          WHERE id = v_sup AND tenant_id = v_tenant AND status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'unknown_or_foreign_supervisor');
    END IF;
  END IF;

  INSERT INTO de_missions (tenant_id, de_id, target_spec, directive_text, created_by)
  VALUES (v_tenant, NULL, p_target_spec, btrim(p_directive), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'mission_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.create_de_team_mission(jsonb, text) FROM anon;

NOTIFY pgrst, 'reload schema';
