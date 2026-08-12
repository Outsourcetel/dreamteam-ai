-- ═══════════════════════════════════════════════════════════════
-- 713 — Published snapshots are gated AT THE TABLE.
--
-- THE DEFECT (found during the mig 712 build, flagged not fixed there):
-- 14 playbook_versions snapshots published 2026-07-21..2026-08-10 end in
-- an `instruction` step instead of the required `complete`. They landed
-- through SQL paths that never run playbook-execute's validateSteps.
--
-- WHAT THE RUNTIME ACTUALLY DOES WITH THEM (measured, not assumed —
-- 14/14 driven through the DEPLOYED validator on 2026-08-12):
-- startDefinitionRunServer re-validates the snapshot at
-- playbook-execute/index.ts:2299 and REFUSES with invalid_definition /
-- HTTP 422 BEFORE any playbook_runs row is created. So the class is not
-- "silently no-ops" — it is "cannot run at all", and production agrees:
-- all 11 affected definitions have ZERO runs, ever.
--
-- The silent-completion trap is real but currently UNREACHABLE: if the
-- step loop ever falls off the end without meeting a `complete` case,
-- index.ts:2260-2264 sets run.status='completed' and returns
-- {status:'completed'} — a run that did nothing, reported as finished.
-- Its own comment ("Defensive: validation guarantees a trailing complete
-- step") names line 2299 as the only thing standing between us and that.
-- ONE check, in one caller, is the whole guarantee. This migration makes
-- the guarantee structural instead: an invalid snapshot cannot EXIST, so
-- the fall-through cannot be reached even if 2299 is ever removed.
--
-- ── WHY A TRIGGER AND NOT A PER-PATH GATE ──────────────────────
-- The census found NINE distinct insert paths (4 live, 5 one-shot
-- migration blocks). The path that produced all 14 rows — install_role_kit
-- — was not in the original defect list at all; it was found by
-- enumerating. Gating per path leaves the NEXT path ungated by
-- construction, which is exactly how this defect was born. The table is
-- the only choke point every path must pass, and a pg_trigger row is a
-- DRIVING OBJECT the certify probe can pin without a prosrc token grep.
--
-- ── THE TWIN-DRIFT PROBLEM, BOUNDED ON PURPOSE ─────────────────
-- A SQL copy of validateSteps is a SECOND COPY OF A CONTRACT and will
-- drift. So this one is deliberately NOT a mirror. It is a FLOOR with a
-- statable boundary:
--
--     the floor decides EXACTLY what validateSteps decides from step
--     KEYS and their ORDER alone; everything params-dependent stays the
--     edge validator's sole authority.
--
-- That boundary is what makes parity checkable rather than hopeful:
-- scripts/playbook-gate-parity.mjs drives BOTH this function and the
-- DEPLOYED edge validator over a shared key-only fixture corpus and
-- asserts identical verdicts per code, plus set-equality of the primitive
-- vocabulary against PRIMITIVES in index.ts. A floor that refused MORE
-- than the validator would block legitimate publishes; a floor that
-- refused LESS would be the hole again. Both directions are asserted.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────
-- It does not correct the 14 legacy snapshots, and it does not touch
-- them: the trigger is INSERT/UPDATE-time only and every existing row
-- stays byte-identical. See the report accompanying this migration —
-- correcting them is a BEHAVIOUR CHANGE (11 published starter playbooks
-- in one tenant would go from "cannot run" to "runs"), and their source
-- of truth is prose, not steps. That decision is the founder's.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. The snapshot vocabulary, once, in SQL ────────────────────
-- Mirrors PRIMITIVES in supabase/functions/playbook-execute/index.ts:171.
-- `consult_specialist` is deliberately ABSENT: it was retired from the
-- engine, so a NEW snapshot using it must be refused exactly as the edge
-- validator refuses it (unknown_primitive). The certify probe's
-- SNAPSHOT_KEYS still carries it because HISTORICAL rows legally hold it.
create or replace function public.playbook_snapshot_primitives()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'check_account', 'generate_invoice', 'human_approval', 'guardrail_check',
    'connector_action', 'update_record', 'log_activity',
    'instruction', 'decision', 'checklist', 'wait', 'sub_playbook', 'agentic_step',
    'custom_step', 'start_onboarding', 'emit_event', 'check_knowledge',
    'read_reference', 'complete', 'gap_gate'
  ]::text[]
$$;

-- Mirrors POST_GATE_ALLOWED (index.ts:212) = SQL_RESUMABLE ∪ the HTTP-executor
-- steps. The complement — check_account, generate_invoice, human_approval —
-- is what may not follow a human gate, so the resume path stays
-- server-authoritative.
create or replace function public.playbook_snapshot_post_gate_allowed()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'guardrail_check', 'update_record', 'log_activity', 'complete',
    'connector_action', 'instruction', 'decision', 'checklist', 'wait',
    'sub_playbook', 'agentic_step', 'custom_step', 'start_onboarding',
    'emit_event', 'check_knowledge', 'read_reference', 'gap_gate'
  ]::text[]
$$;

-- ── 2. The floor: validateSteps' KEY-AND-ORDER rules, same codes ─
-- Returns the edge validator's own error CODES so the parity check can
-- compare verdicts code-for-code instead of "both said no".
-- Evaluation order matches validateSteps exactly: `empty` returns alone
-- (index.ts:287-289), and an unknown_primitive element is not counted
-- toward the multiple_* tallies (index.ts:302-305 returns from the
-- forEach body before the switch).
create or replace function public.playbook_snapshot_floor_errors(p_steps jsonb)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_errs   text[] := array[]::text[];
  v_prims  text[] := public.playbook_snapshot_primitives();
  v_post   text[] := public.playbook_snapshot_post_gate_allowed();
  v_len    int;
  v_elem   jsonb;
  v_key    text;
  i        int;
  v_complete int := 0;
  v_approval int := 0;
  v_invoice  int := 0;
  v_approval_idx int := -1;
  v_invoice_idx  int := -1;
  v_bad_step   boolean := false;
  v_unknown    boolean := false;
begin
  -- `empty` short-circuits, exactly as validateSteps does.
  if p_steps is null or jsonb_typeof(p_steps) is distinct from 'array'
     or jsonb_array_length(p_steps) = 0 then
    return array['empty'];
  end if;

  v_len := jsonb_array_length(p_steps);
  if v_len > 20 then
    v_errs := v_errs || 'too_many_steps';
  end if;

  for i in 0 .. v_len - 1 loop
    v_elem := p_steps->i;
    if jsonb_typeof(v_elem) is distinct from 'object'
       or jsonb_typeof(v_elem->'key') is distinct from 'string' then
      v_bad_step := true;
      continue;                                   -- validateSteps returns here
    end if;
    v_key := v_elem->>'key';
    if not (v_key = any(v_prims)) then
      v_unknown := true;
      continue;                                   -- validateSteps returns here
    end if;
    if v_key = 'complete' then v_complete := v_complete + 1; end if;
    if v_key = 'human_approval' then
      v_approval := v_approval + 1;
      if v_approval_idx = -1 then v_approval_idx := i; end if;
    end if;
    if v_key = 'generate_invoice' then
      v_invoice := v_invoice + 1;
      if v_invoice_idx = -1 then v_invoice_idx := i; end if;
    end if;
  end loop;

  if v_bad_step then v_errs := v_errs || 'bad_step'; end if;
  if v_unknown  then v_errs := v_errs || 'unknown_primitive'; end if;

  -- THE RULE THIS WHOLE MIGRATION EXISTS FOR (index.ts:529-531).
  if (p_steps->(v_len - 1))->>'key' is distinct from 'complete' then
    v_errs := v_errs || 'last_step';
  end if;

  if v_complete > 1 then v_errs := v_errs || 'multiple_complete'; end if;
  if v_invoice  > 1 then v_errs := v_errs || 'multiple_invoice';  end if;
  if v_approval > 1 then v_errs := v_errs || 'multiple_approval'; end if;

  -- human_approval gates an invoice, so an invoice must precede it
  -- (index.ts:548-550).
  if v_approval_idx <> -1 and (v_invoice_idx = -1 or v_invoice_idx > v_approval_idx) then
    v_errs := v_errs || 'approval_without_invoice';
  end if;

  -- Post-gate steps stay within the resumable set (index.ts:551-560).
  if v_approval_idx <> -1 then
    for i in v_approval_idx + 1 .. v_len - 1 loop
      v_key := (p_steps->i)->>'key';
      if v_key is not null and not (v_key = any(v_post)) then
        v_errs := v_errs || 'post_gate_primitive';
        exit;
      end if;
    end loop;
  end if;

  return v_errs;
end $$;

-- ── 3. The gate itself ──────────────────────────────────────────
-- BEFORE INSERT OR UPDATE. The UPDATE arm is not decoration: a snapshot is
-- IMMUTABLE, so a steps rewrite is the "green the checker by editing the
-- evidence" move this repo has already paid for once. Unchanged steps
-- short-circuit, so version/published_by bookkeeping updates are free.
create or replace function public.playbook_versions_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_errs text[];
begin
  if tg_op = 'UPDATE' and new.steps is not distinct from old.steps then
    return new;
  end if;

  v_errs := public.playbook_snapshot_floor_errors(new.steps);
  if array_length(v_errs, 1) > 0 then
    raise exception
      'invalid_snapshot: a published playbook_versions snapshot must pass the engine floor (violations: %). '
      'The runtime re-validates every snapshot before it will start a run '
      '(playbook-execute validateSteps), so a snapshot that fails here could never have run — '
      'it would only have looked published. Publish through playbook-execute {action:''publish''}, '
      'which runs the full validator.',
      array_to_string(v_errs, ', ');
  end if;
  return new;
end $$;

revoke all on function public.playbook_versions_gate() from public, anon, authenticated;
revoke all on function public.playbook_snapshot_floor_errors(jsonb) from public, anon, authenticated;
revoke all on function public.playbook_snapshot_primitives() from public, anon, authenticated;
revoke all on function public.playbook_snapshot_post_gate_allowed() from public, anon, authenticated;
-- service_role only: the parity check and the edge function run there. No
-- browser caller needs these — the browser validates through the edge
-- validator, which is the authority they mirror.
grant execute on function public.playbook_snapshot_floor_errors(jsonb) to service_role;
grant execute on function public.playbook_snapshot_primitives() to service_role;
grant execute on function public.playbook_snapshot_post_gate_allowed() to service_role;

drop trigger if exists playbook_versions_gate on playbook_versions;
create trigger playbook_versions_gate
  before insert or update on playbook_versions
  for each row execute function public.playbook_versions_gate();

-- ── 4. install_role_kit: stop feeding the table prose ───────────
-- THE PATH THAT PRODUCED ALL 14 ROWS. It copies role_archetypes.sop_playbook
-- ->'steps' verbatim into playbook_versions. Measured on 2026-08-12: ALL 15
-- active archetype SOPs are PROSE DOCUMENTS, not executable step lists —
-- 15/15 fail the floor, and 7 of them use keys that are not primitives at
-- all ('open_the_books', 'hand_it_over', 'sop_notes', 'raise_discrepancies',
-- …). The sop_playbook column holds an SOP a DE reads; playbook_versions
-- holds a snapshot an executor RUNS. Two different kinds of object sharing
-- one table is the actual defect.
--
-- So the gate alone would break EVERY hire (100% of installs raise). The
-- fix is to stop attempting the invalid write — and to say so out loud in
-- the return value rather than skipping quietly, because a silent skip is
-- the same disease in a different organ.
--
-- BEHAVIOUR: unchanged where it counts. Before, the snapshot existed but
-- the runtime refused it (invalid_definition/422, zero runs ever). After,
-- there is no snapshot and the runtime refuses at the same door with
-- no_published_version/400. Nothing that ran before stops running; nothing
-- that could not run starts. The playbook_definitions row — which is what
-- the DE actually reads its SOP from — is written exactly as before.
create or replace function public.install_role_kit(p_de_id uuid, p_archetype_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  a role_archetypes;
  v_tenant uuid;
  v_watchers int := 0;
  v_skipped int := 0;
  v_guardrails int := 0;
  v_pb_key text;
  v_pb_id uuid;
  v_pb_version int;
  w jsonb;
  g jsonb;
  v_snapshot_errs text[] := array[]::text[];
  v_snapshot_written boolean := false;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'unknown DE %', p_de_id; end if;

  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = v_tenant
           and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to configure this DE';
  end if;

  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  -- Watchers: derive-your-own-work. validate_watcher_config enforces each
  -- kind's config shape. A template it refuses is SKIPPED and counted (mig
  -- 552) — it must not cost the employee its SOP and guardrails too.
  if a.watcher_templates is not null then
    for w in select * from jsonb_array_elements(a.watcher_templates) loop
      if not exists (
        select 1 from work_watchers
        where de_id = p_de_id and kind = w->>'kind' and label = w->>'label') then
        begin
          insert into work_watchers (tenant_id, de_id, kind, label, description, config, active)
          values (v_tenant, p_de_id, w->>'kind', w->>'label', w->>'description', w->'config', true);
          v_watchers := v_watchers + 1;
        exception when others then
          v_skipped := v_skipped + 1;
        end;
      end if;
    end loop;
  end if;

  -- SOP playbook: attach to THIS DE + publish (snapshot into playbook_versions).
  -- name/description are coalesced (mig 552): six archetypes shipped an
  -- sop_playbook with no description key, and description is NOT NULL, so the
  -- insert threw and took the whole kit with it.
  if a.sop_playbook is not null then
    v_pb_key := p_archetype_key || '_sop';
    insert into playbook_definitions
      (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
    values
      (v_tenant, v_pb_key,
       coalesce(a.sop_playbook->>'name', a.name || ' SOP'),
       coalesce(a.sop_playbook->>'description', a.sop_playbook->>'name', a.name || ' standard operating procedure'),
       1, 'published', a.sop_playbook->'steps', 'manual', p_de_id)
    on conflict (tenant_id, key) do update
      set name = excluded.name, description = excluded.description,
          steps = excluded.steps, status = 'published',
          version = playbook_definitions.version + 1, de_id = p_de_id,
          updated_at = now()
    returning id, version into v_pb_id, v_pb_version;

    -- mig 713: only snapshot what the engine could actually run. An SOP that
    -- is prose gets its definition (what the DE reads) and NO snapshot (what
    -- an executor would be handed) — reported, never silent.
    v_snapshot_errs := public.playbook_snapshot_floor_errors(a.sop_playbook->'steps');
    if coalesce(array_length(v_snapshot_errs, 1), 0) = 0 then
      insert into playbook_versions (definition_id, version, steps, published_by)
      values (v_pb_id, v_pb_version, a.sop_playbook->'steps', null)
      on conflict do nothing;
      v_snapshot_written := true;
    end if;
  end if;

  -- Role guardrails: employee-scoped. The permanent propose-only guarantee for
  -- money/terms is the destructive-action FLOOR in decide_action_execution;
  -- these state the rules to the DE and add amount/discount/phrase gates.
  if a.guardrail_templates is not null then
    for g in select * from jsonb_array_elements(a.guardrail_templates) loop
      if not exists (
        select 1 from guardrail_rules
        where tenant_id = v_tenant and scope = 'employee' and scope_ref = p_de_id::text
          and rule_type = g->>'rule_type' and rule = g->>'rule') then
        insert into guardrail_rules
          (tenant_id, rule, rule_type, pattern, threshold, severity, active, scope, scope_ref)
        values
          (v_tenant, g->>'rule', g->>'rule_type', g->>'pattern',
           nullif(g->>'threshold','')::bigint,
           coalesce(g->>'severity','blocking'), true, 'employee', p_de_id::text);
        v_guardrails := v_guardrails + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'de_id', p_de_id, 'archetype', p_archetype_key,
    'watchers_created', v_watchers, 'watchers_skipped', v_skipped,
    'guardrails_created', v_guardrails,
    'sop_playbook_id', v_pb_id,
    -- HONEST REPORTING (mig 713): say whether the runnable snapshot landed.
    'sop_snapshot_published', v_snapshot_written,
    'sop_snapshot_skipped_because', case
      when v_snapshot_written or v_pb_id is null then null
      else 'this archetype''s SOP is a reference document, not an executable step list ('
           || array_to_string(v_snapshot_errs, ', ')
           || ') — the DE has its SOP; there is no runnable version to start'
    end);
end
$function$;

-- Preserve the perimeter mig 218 set, exactly.
revoke all on function public.install_role_kit(uuid, text) from public, anon;
grant execute on function public.install_role_kit(uuid, text) to authenticated, service_role;

-- ── 5. Assertions — this migration proves itself ────────────────
do $$
declare
  v_bad int;
  v_ok  boolean;
begin
  -- the trigger is present, enabled, and wired to the right function
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
     where c.relname = 'playbook_versions'
       and t.tgname = 'playbook_versions_gate'
       and t.tgenabled = 'O'
       and p.proname = 'playbook_versions_gate') then
    raise exception 'ASSERT FAILED: playbook_versions_gate trigger missing, disabled, or misrouted';
  end if;

  -- THE FLOOR ACTUALLY REFUSES (a checker that cannot fail is theatre).
  -- Every arm inverted: the violating shape must be named, the clean twin
  -- must be silent.
  if not ('last_step' = any(public.playbook_snapshot_floor_errors(
      '[{"key":"instruction"},{"key":"instruction"}]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch a missing trailing complete';
  end if;
  if not ('unknown_primitive' = any(public.playbook_snapshot_floor_errors(
      '[{"key":"teleport_money"},{"key":"complete"}]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch an unknown primitive';
  end if;
  if not ('empty' = any(public.playbook_snapshot_floor_errors('[]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch an empty step list';
  end if;
  if not ('multiple_complete' = any(public.playbook_snapshot_floor_errors(
      '[{"key":"complete"},{"key":"complete"}]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch two complete steps';
  end if;
  if not ('approval_without_invoice' = any(public.playbook_snapshot_floor_errors(
      '[{"key":"human_approval"},{"key":"complete"}]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch an approval gating nothing';
  end if;
  if not ('post_gate_primitive' = any(public.playbook_snapshot_floor_errors(
      '[{"key":"generate_invoice"},{"key":"human_approval"},{"key":"check_account"},{"key":"complete"}]'::jsonb))) then
    raise exception 'ASSERT FAILED: floor did not catch a post-gate primitive';
  end if;
  -- ...and passes what the engine accepts (a floor that refuses everything
  -- is as broken as one that refuses nothing).
  if coalesce(array_length(public.playbook_snapshot_floor_errors(
      '[{"key":"check_account"},{"key":"checklist"},{"key":"complete"}]'::jsonb), 1), 0) <> 0 then
    raise exception 'ASSERT FAILED: floor refused a valid snapshot (false positive)';
  end if;
  if coalesce(array_length(public.playbook_snapshot_floor_errors(
      '[{"key":"generate_invoice"},{"key":"human_approval"},{"key":"log_activity"},{"key":"complete"}]'::jsonb), 1), 0) <> 0 then
    raise exception 'ASSERT FAILED: floor refused a valid gated invoice snapshot (false positive)';
  end if;

  -- THE TRIGGER FIRES ON A REAL INSERT — proven, not assumed. Rolled back.
  begin
    insert into playbook_versions (definition_id, version, steps, published_by)
    values ('00000000-0000-4000-8000-000000000713'::uuid, 1,
            '[{"key":"instruction"}]'::jsonb, null);
    raise exception 'ASSERT FAILED: the gate let a no-complete snapshot INSERT succeed';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'invalid_snapshot:%' then raise; end if;   -- our refusal
    when foreign_key_violation then
      raise exception 'ASSERT FAILED: the FK fired before the gate did — the gate never ran';
  end;

  -- EXISTING ROWS UNTOUCHED. The 14 legacy snapshots must still be there,
  -- byte-identical: this migration gates the door, it does not rewrite
  -- immutable history.
  select count(*) into v_bad from playbook_versions v
   where jsonb_typeof(v.steps) is distinct from 'array'
      or jsonb_array_length(v.steps) = 0
      or (v.steps->(jsonb_array_length(v.steps)-1))->>'key' is distinct from 'complete';
  if v_bad <> 14 then
    raise warning 'mig 713: expected the 14 named legacy snapshots to still be present, found % — investigate before moving the probe pin', v_bad;
  end if;

  -- EXECUTE perimeter (migs 610+630)
  if has_function_privilege('anon', 'public.playbook_snapshot_floor_errors(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.playbook_snapshot_floor_errors(jsonb)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon/authenticated must not execute the floor validator';
  end if;
  if not has_function_privilege('service_role', 'public.playbook_snapshot_floor_errors(jsonb)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: service_role lost the floor validator (the parity check breaks)';
  end if;
  if has_function_privilege('authenticated', 'public.playbook_versions_gate()', 'EXECUTE')
     or has_function_privilege('anon', 'public.playbook_versions_gate()', 'EXECUTE') then
    raise exception 'ASSERT FAILED: the trigger function must not be directly executable';
  end if;
  if not has_function_privilege('authenticated', 'public.install_role_kit(uuid, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: install_role_kit lost its callers (the hire path breaks)';
  end if;
  if has_function_privilege('anon', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon must not execute install_role_kit';
  end if;

  -- THE HIRE PATH STILL WORKS. install_role_kit must no longer ATTEMPT the
  -- invalid snapshot write for any active archetype — otherwise the gate
  -- above turns every hire into an exception.
  select bool_and(coalesce(array_length(public.playbook_snapshot_floor_errors(a.sop_playbook->'steps'), 1), 0) > 0)
    into v_ok
    from role_archetypes a where a.status = 'active' and a.sop_playbook ? 'steps';
  if v_ok is not null and v_ok then
    raise notice 'mig 713: all active archetype SOPs are reference documents (0 runnable snapshots) — install_role_kit now skips the snapshot write and reports it';
  end if;

  raise notice 'migration 713 assertions passed';
end $$;
