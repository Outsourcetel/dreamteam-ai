-- ═══════════════════════════════════════════════════════════════
-- 715 — The definition says which engine owns it.
--
-- ── FIRST, A CORRECTION TO THE RECORD ──────────────────────────
-- Mig 713's header states that all 15 active archetype SOPs are "PROSE
-- DOCUMENTS, not executable step lists", and that keys like
-- 'open_the_books' and 'hand_it_over' "are not primitives at all". That
-- reading is wrong, and it has now propagated twice — mig 509 → mig 713 →
-- the brief that opened this work. Correcting it here because an applied
-- migration is not edited: public.schema_migrations keys on FILENAME, so
-- the repo must keep matching what actually ran.
--
-- Migs 509 and 511 DELIBERATELY re-authored role_archetypes.sop_playbook
-- into a SECOND EXECUTABLE FORMAT — {key, kind:'use_tool', work_kind,
-- tool, title, detail} — with its own compiler, compileSopToWorkItems
-- (de-work/index.ts:183). Measured 2026-08-12: that compiler had fired 28
-- times, most recently THAT DAY, producing Accounting's 38 work items and
-- Billing & Invoicing's 36. `open_the_books` is not prose that failed to
-- become a step. It is the step key that did the work.
--
-- Two other counts in that header are off by inheritance: it is TEN
-- affected definitions and FOURTEEN snapshots (their versions sum to 14),
-- not eleven; and SIX archetypes carry the use_tool format, not seven.
-- No snapshot contains an unknown primitive — all 14 use only
-- `instruction` and `checklist`, and fail on exactly two rules (no
-- trailing `complete`; title in `label` rather than `params.title`).
-- The snapshots are frozen copies of the PRE-509 format.
--
-- ── THE ACTUAL DEFECT ──────────────────────────────────────────
-- playbook_definitions.status='published' has THREE readers, and each
-- means something different by it:
--
--   get_de_briefing / get_de_briefing_for_objective  (migs 250, 268)
--       → render this into the DE's prompt as its SOP.   WANTS BOTH KINDS.
--   compileSopToWorkItems              (de-work/index.ts:183)
--       → compile this into de_work_items.               WANTS 'sop'.
--   startDefinitionRunServer           (playbook-execute:2299)
--       → this is runnable by me.                        WANTS 'procedure'.
--
-- Mig 713 named the disease exactly — "two different kinds of object
-- sharing one table is the actual defect" — and closed the insert door.
-- It did not TYPE the object. This migration does.
--
-- ── WHY DERIVED, NOT DECLARED ──────────────────────────────────
-- A stored `kind` that a later re-materialisation forgets to set is the
-- stored-marker-as-truth trap: the row would keep saying 'procedure'
-- while its steps became an SOP, and the compiler would silently stop
-- seeing a definition that used to work. Migs 509/511/649/650 each
-- rewrote `steps` in place, so that is not hypothetical — it is the
-- established pattern of this table. So `kind` is DERIVED from the steps
-- by trigger and cannot drift. A derived marker cannot lie.
--
-- ── AND A DEFECT FOUND BY BUILDING THE CHECK ───────────────────
-- The plan was to assert "the briefing renders identically before and
-- after". Building that assertion measured the baseline, and the baseline
-- is broken: get_de_briefing renders `coalesce(elem->>'label','step')`,
-- and use_tool steps carry `title`, not `label`. So Accounting DE's
-- entire SOP briefing reads:
--
--     ## Accounting / Reconciliation SOP
--     1. step
--     2. step
--     3. step
--     4. step
--
-- and render_playbook_structure (the objective briefing) does only
-- slightly better — `coalesce(label, key, 'step')` gives the bare key and
-- never the title or the detail. NEITHER reader has ever read `title` or
-- `detail`, which is where every word of a use_tool SOP's instruction
-- lives. Six live DEs have read a contentless briefing since mig 509
-- changed the format underneath these renderers. They still function only
-- because compileSopToWorkItems copies `detail` into each work item —
-- the procedure reaches them through the work item, never the briefing.
--
-- "Assert it unchanged" would therefore have CERTIFIED `1. step` as
-- correct: a checker that cannot fail. So the renderer is fixed here, and
-- the assertion proves both directions instead.
--
-- BEHAVIOUR CHANGE, STATED OUT LOUD: six DEs' briefings gain their real
-- SOP text. get_de_briefing also stops carrying its own copy of the
-- renderer and calls render_playbook_structure, which has strictly more
-- branches — so procedure-kind briefings gain decision/gate/action detail
-- they always should have had. One renderer, not two, is also one fewer
-- contract to drift.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. The classifier, in ONE place ────────────────────────────
-- Every caller (trigger, backfill, install_role_kit, assertions) asks
-- this one function. A second copy would be a second contract.
-- Top-level scan only: use_tool SOPs have no decision branches, and
-- playbook-execute steps carry no top-level `kind` (their DefStep is
-- {key,label,params,then_steps,else_steps}), so there is nothing nested
-- to find and no collision to guard against.
create or replace function public.playbook_definition_kind(p_steps jsonb)
returns text
language sql
immutable
as $function$
  select case
    when jsonb_typeof(p_steps) = 'array'
     and exists (select 1 from jsonb_array_elements(p_steps) s where s->>'kind' = 'use_tool')
    then 'sop'
    else 'procedure'
  end;
$function$;

-- Perimeter (migs 610/630): never leave the default blanket EXECUTE.
-- Nothing outside the database calls this; the trigger reaches it as
-- SECURITY DEFINER, so `authenticated` needs no grant of its own.
revoke all on function public.playbook_definition_kind(jsonb) from public, anon, authenticated;
grant execute on function public.playbook_definition_kind(jsonb) to service_role;

-- ── 2. The column, and the trigger that makes it honest ────────
alter table public.playbook_definitions
  add column if not exists kind text not null default 'procedure';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'playbook_definitions_kind_chk') then
    alter table public.playbook_definitions
      add constraint playbook_definitions_kind_chk check (kind in ('sop', 'procedure'));
  end if;
end $$;

comment on column public.playbook_definitions.kind is
  'DERIVED, never declared: ''sop'' = compiled into de_work_items by de-work''s '
  'compileSopToWorkItems; ''procedure'' = run by playbook-execute. Set by trigger '
  'from the steps (mig 715) so it cannot drift from what the row actually holds.';

create or replace function public.playbook_definitions_set_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Deliberately ignores whatever the writer put in NEW.kind. The shape of
  -- the steps is the truth; a declaration is only an opinion about it.
  new.kind := public.playbook_definition_kind(new.steps);
  return new;
end;
$function$;

drop trigger if exists playbook_definitions_set_kind on public.playbook_definitions;
create trigger playbook_definitions_set_kind
  before insert or update of steps, kind on public.playbook_definitions
  for each row execute function public.playbook_definitions_set_kind();

-- Backfill every existing row. Fires the trigger too — same answer twice
-- is the point: the backfill and the trigger cannot disagree.
update public.playbook_definitions
   set kind = public.playbook_definition_kind(steps)
 where kind is distinct from public.playbook_definition_kind(steps);

-- Serves both new predicates: the compiler's (tenant, de, published, sop)
-- and the executor's (tenant, de, published, procedure).
create index if not exists playbook_definitions_de_kind_idx
  on public.playbook_definitions (tenant_id, de_id, status, kind);

-- ── 3. The renderer learns the second format ───────────────────
-- A use_tool step's instruction lives in `title` + `detail`; the old
-- coalesce chain stopped at `key`. `tool` is named because the step's own
-- text should be able to say which tool finishes it — the employee still
-- decides HOW.
create or replace function public.render_playbook_structure(p_steps jsonb)
returns text
language sql
immutable
as $function$
  select string_agg(
    s.ord || '. ' || coalesce(s.elem->>'label', s.elem->>'title', s.elem->>'key', 'step') ||
    case
      when s.elem->>'kind' = 'use_tool' then
        coalesce(' — ' || (s.elem->>'detail'), '')
        || coalesce(' [tool: ' || nullif(s.elem->>'tool', 'none') || ']', '')
      else case s.elem->>'key'
        when 'instruction'     then coalesce(' — ' || (s.elem->'params'->>'body_md'), '')
        when 'checklist'       then ' — checklist: ' || coalesce((select string_agg(i.value #>> '{}', '; ')
                                                                  from jsonb_array_elements(s.elem->'params'->'items') i), '')
        when 'decision'        then ' — DECISION: if ' || coalesce(s.elem->'params'->>'on','(prior step)') || ' '
                                      || coalesce(s.elem->'params'->>'operator','') || ' ' || coalesce(s.elem->'params'->>'value','')
                                      || ' then ' || coalesce(jsonb_array_length(s.elem->'then_steps')::text,'0') || ' step(s), else '
                                      || coalesce(jsonb_array_length(s.elem->'else_steps')::text,'0')
        when 'human_approval'  then ' — GATE: pause here for human approval before continuing'
        when 'guardrail_check' then ' — GUARDRAIL CHECK: ' || coalesce(s.elem->'params'->>'check','')
        when 'consult_specialist' then ' — CONSULT a specialist: ' || coalesce(s.elem->'params'->>'question_template','')
        when 'check_knowledge' then ' — CHECK KNOWLEDGE for: ' || coalesce(s.elem->'params'->>'query_template','')
        when 'agentic_step'    then ' — JUDGMENT STEP (use tools to): ' || coalesce(s.elem->'params'->>'instructions', s.elem->'params'->>'goal_template','')
        when 'custom_step'     then ' — JUDGMENT STEP (use tools to): ' || coalesce(s.elem->'params'->>'instructions', s.elem->'params'->>'goal_template','')
        when 'connector_action' then ' — ACTION: ' || coalesce(
                                        s.elem->'params'->>'action_key',
                                        nullif((s.elem->'params'->>'provider') || '.' || (s.elem->'params'->>'op'), '.'),
                                        nullif((s.elem->'params'->>'category') || '.' || (s.elem->'params'->>'op'), '.'),
                                        'connector action') || ' (routed through the approval/guardrail gates)'
        when 'generate_invoice' then ' — ACTION: generate an invoice (gated for approval)'
        when 'update_record'   then ' — ACTION: update a record (gated)'
        when 'wait'            then ' — WAIT ' || coalesce(s.elem->'params'->>'duration_minutes','?') || ' minutes, then resume'
        when 'complete'        then ' — (procedure ends here)'
        else ''
      end
    end, E'\n' order by s.ord)
  from jsonb_array_elements(p_steps) with ordinality as s(elem, ord);
$function$;

-- ── 4. One renderer, not two ───────────────────────────────────
-- get_de_briefing carried its own inline copy (label-only, instruction +
-- checklist only). That copy is the reason six DEs read "1. step". It is
-- deleted here in favour of the shared renderer — the same one mig 268's
-- objective briefing already calls. NO kind filter: a DE reads its own
-- procedure whichever engine owns it, and filtering here for symmetry
-- would silently strip half of every DE's briefing.
create or replace function public.get_de_briefing(p_de_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_sop text;
  v_guard text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return jsonb_build_object('sop','','guardrails',''); end if;

  -- ALL attached, published SOPs (titled; newest first; capped at 4).
  select string_agg(sop_text, E'\n\n' order by upd desc)
  into v_sop
  from (
    select pd.updated_at as upd,
           '## ' || pd.name || E'\n' || render_playbook_structure(pd.steps) as sop_text
    from playbook_definitions pd
    where pd.de_id = p_de_id and pd.status = 'published'
    order by pd.updated_at desc
    limit 4
  ) sops;

  -- The DE's active guardrails, rendered as rules it must honour.
  select string_agg('- ' ||
    case r.rule_type
      when 'blocked_phrase' then 'Never commit to / say: ' || coalesce(r.pattern,'')
      when 'blocked_topic'  then 'Do not act on topic: ' || coalesce(r.pattern,'')
      when 'max_discount_pct' then 'Any discount above ' || coalesce(r.threshold::text,'0') || '% must be proposed for human approval'
      when 'require_approval_over_cents' then 'Any amount over $' || to_char(coalesce(r.threshold,0)/100.0,'FM999,999,990.00') || ' must be proposed for human approval'
      when 'frustration_signal' then 'Escalate to a human on: ' || coalesce(r.pattern,'')
      else coalesce(r.rule,'')
    end, E'\n')
  into v_guard
  from guardrail_rules_for_de(v_tenant, p_de_id,
       ARRAY['blocked_phrase','blocked_topic','max_discount_pct','require_approval_over_cents','frustration_signal'],
       null) r
  where r.active;

  return jsonb_build_object('sop', coalesce(v_sop,''), 'guardrails', coalesce(v_guard,''));
end;
$function$;

-- ── 5. install_role_kit says which kind it just installed ──────
-- Unchanged in every respect except the snapshot decision and the honesty
-- of its return value. Mig 713 skipped the snapshot when the FLOOR failed
-- and reported "this archetype's SOP is a reference document" — which we
-- now know is the wrong reason. An SOP is skipped because it belongs to a
-- different engine, not because it is prose.
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
  v_kind text;
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

  -- SOP playbook: attach to THIS DE + publish. name/description are
  -- coalesced (mig 552): six archetypes shipped an sop_playbook with no
  -- description key, and description is NOT NULL, so the insert threw and
  -- took the whole kit with it.
  if a.sop_playbook is not null then
    v_kind := public.playbook_definition_kind(a.sop_playbook->'steps');
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
    -- kind is set by the trigger from the steps — never written here.

    -- Only a PROCEDURE gets a runnable snapshot, and only if it clears the
    -- floor (mig 713). An SOP is compiled by de-work, never handed to
    -- playbook-execute, so a snapshot for it would be an object no engine
    -- owns. Both refusals are reported, never silent.
    if v_kind = 'procedure' then
      v_snapshot_errs := public.playbook_snapshot_floor_errors(a.sop_playbook->'steps');
      if coalesce(array_length(v_snapshot_errs, 1), 0) = 0 then
        insert into playbook_versions (definition_id, version, steps, published_by)
        values (v_pb_id, v_pb_version, a.sop_playbook->'steps', null)
        on conflict do nothing;
        v_snapshot_written := true;
      end if;
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
    'sop_playbook_kind', v_kind,
    'sop_snapshot_published', v_snapshot_written,
    'sop_snapshot_skipped_because', case
      when v_snapshot_written or v_pb_id is null then null
      when v_kind = 'sop' then
        'this archetype''s SOP is compiled into work items by the employee''s own '
        || 'work engine, not run by the playbook executor — there is no runnable '
        || 'snapshot to start, and the DE has its SOP'
      else 'this archetype''s procedure does not clear the snapshot floor ('
           || array_to_string(v_snapshot_errs, ', ')
           || ') — the DE has its definition; there is no runnable version to start'
    end);
end;
$function$;

-- Preserve the perimeter mig 218 set, exactly.
revoke all on function public.install_role_kit(uuid, text) from public, anon;
grant execute on function public.install_role_kit(uuid, text) to authenticated, service_role;

-- ── 6. Assertions — every pin inverted, every comparison counted ─
-- Zero findings from zero comparisons looks exactly like a clean result,
-- so each block below states HOW MANY rows it compared.
do $$
declare
  v_n            int;
  v_total        int;
  v_sop_defs     int;
  v_proc_defs    int;
  v_tenant       uuid;
  v_de           uuid;
  v_id           uuid;
  v_kind         text;
  v_txt          text;
  v_probe_insert text := null;
  v_probe_update text := null;
  v_probe_err    text := null;
  v_arch_sop     int;
  v_checked      int := 0;
begin
  -- A migration IS a service actor, and must say so before touching a path
  -- that writes the audit chain. playbook_steps_guard (added 2026-08-11 after
  -- the "Rabeel" prose overwrite) calls append_audit_event on every UPDATE of
  -- `steps`, and append_audit_event refuses anything that is neither
  -- service_role nor a tenant member — so the Management API path raises
  -- "not a member of this tenant". Transaction-local, the same set_config
  -- pattern resume_playbook_on_task already needs. NOT a workaround for the
  -- guard: the audit event still gets written, correctly attributed to
  -- 'Service or automation'.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── A1. The classifier answers BOTH ways ─────────────────────
  if public.playbook_definition_kind('[{"key":"x","kind":"use_tool"}]'::jsonb) <> 'sop' then
    raise exception 'ASSERT FAILED: a use_tool step must classify as sop';
  end if;
  if public.playbook_definition_kind('[{"key":"instruction","params":{"title":"t"}}]'::jsonb) <> 'procedure' then
    raise exception 'ASSERT FAILED: an instruction step must classify as procedure';
  end if;
  if public.playbook_definition_kind(null) <> 'procedure' then
    raise exception 'ASSERT FAILED: null steps must classify as procedure';
  end if;
  if public.playbook_definition_kind('{"not":"an array"}'::jsonb) <> 'procedure' then
    raise exception 'ASSERT FAILED: non-array steps must classify as procedure';
  end if;
  v_checked := v_checked + 4;

  -- ── A2. The trigger cannot be lied to, in BOTH directions ────
  -- A declaration is only an opinion; the steps are the truth.
  --
  -- This writes a real row to a real tenant's table, and playbook_definitions
  -- carries THREE after-triggers that would record it: trg_remote_access_audit,
  -- trg_tenant_activity_log, and playbook_steps_guard's append_audit_event into
  -- the hash-linked audit chain. A probe must not leave fingerprints in a live
  -- tenant's audit trail, so it runs inside a subtransaction that is ALWAYS
  -- rolled back — plpgsql variables survive the rollback, the rows do not.
  --
  -- The rollback must not become a way for the probe to pass by not running:
  -- both results start NULL, any unexpected error is captured, and all three
  -- are asserted AFTER the block.
  select tenant_id, de_id into v_tenant, v_de
    from playbook_definitions where de_id is not null limit 1;
  if v_tenant is null then
    raise exception 'ASSERT FAILED: no playbook_definitions row to borrow a tenant from';
  end if;

  begin
    insert into playbook_definitions
      (tenant_id, key, name, description, version, status, steps, trigger_type, de_id, kind)
    values
      (v_tenant, '__mig715_probe__', 'mig 715 probe', 'rolled back before this migration ends',
       1, 'draft', '[{"key":"instruction","params":{"title":"t","body_md":"b"}}]'::jsonb,
       'manual', v_de, 'sop')
    returning id, kind into v_id, v_probe_insert;

    update playbook_definitions
       set steps = '[{"key":"open_the_books","kind":"use_tool","title":"T","detail":"D","tool":"none"}]'::jsonb,
           kind = 'procedure'
     where id = v_id
    returning kind into v_probe_update;

    raise exception 'MIG715_PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'MIG715_PROBE_ROLLBACK' then v_probe_err := sqlerrm; end if;
  end;

  if v_probe_err is not null then
    raise exception 'ASSERT FAILED: the trigger probe could not run at all: %', v_probe_err;
  end if;
  if v_probe_insert is distinct from 'procedure' then
    raise exception 'ASSERT FAILED: row DECLARED sop with instruction steps landed as %, not procedure',
      coalesce(v_probe_insert, '<probe never ran>');
  end if;
  if v_probe_update is distinct from 'sop' then
    raise exception 'ASSERT FAILED: row DECLARED procedure with use_tool steps landed as %, not sop',
      coalesce(v_probe_update, '<probe never ran>');
  end if;
  if exists (select 1 from playbook_definitions where key = '__mig715_probe__') then
    raise exception 'ASSERT FAILED: the mig 715 probe row was not rolled back';
  end if;
  v_checked := v_checked + 2;

  -- ── A3. Whole table agrees, and the comparison was not empty ──
  select count(*) into v_total from playbook_definitions;
  select count(*) into v_n from playbook_definitions
   where kind is distinct from public.playbook_definition_kind(steps);
  if v_total = 0 then
    raise exception 'ASSERT FAILED: zero definitions compared — a clean result from an empty set proves nothing';
  end if;
  if v_n > 0 then
    raise exception 'ASSERT FAILED: % of % definitions disagree with the classifier', v_n, v_total;
  end if;
  select count(*) filter (where kind = 'sop'), count(*) filter (where kind = 'procedure')
    into v_sop_defs, v_proc_defs from playbook_definitions;
  raise notice 'mig 715: % definitions classified (% sop / % procedure), 0 disagreements',
    v_total, v_sop_defs, v_proc_defs;
  if v_sop_defs = 0 then
    raise exception 'ASSERT FAILED: not one definition classified as sop — the compiler would starve';
  end if;

  -- ── A4. The renderer, both formats ───────────────────────────
  v_txt := public.render_playbook_structure(
    '[{"key":"open_the_books","kind":"use_tool","title":"Open the ledger","detail":"State the balance.","tool":"none"}]'::jsonb);
  if v_txt not like '%Open the ledger%' or v_txt not like '%State the balance.%' then
    raise exception 'ASSERT FAILED: a use_tool step must render its title AND detail, got: %', v_txt;
  end if;
  if v_txt like '%open_the_books%' then
    raise exception 'ASSERT FAILED: a use_tool step with a title must not fall back to its key, got: %', v_txt;
  end if;
  v_txt := public.render_playbook_structure(
    '[{"key":"instruction","label":"Do the thing","params":{"body_md":"the body"}}]'::jsonb);
  if v_txt not like '%Do the thing%' or v_txt not like '%the body%' then
    raise exception 'ASSERT FAILED: a label-form step must still render its label and body, got: %', v_txt;
  end if;
  v_checked := v_checked + 2;

  -- ── A5. The briefing works for BOTH kinds ────────────────────
  -- The reader that must not be filtered. Proven behaviourally: a DE whose
  -- published definition is an sop must get real text, not "1. step".
  v_n := 0;
  for v_de, v_kind in
    select distinct on (pd.kind) pd.de_id, pd.kind
      from playbook_definitions pd
     where pd.de_id is not null and pd.status = 'published'
     order by pd.kind, pd.updated_at desc
  loop
    v_txt := public.get_de_briefing(v_de)->>'sop';
    if coalesce(v_txt, '') = '' then
      raise exception 'ASSERT FAILED: briefing empty for a % DE (%)', v_kind, v_de;
    end if;
    if v_txt ~ E'\\m[0-9]+\\. step\\M' then
      raise exception 'ASSERT FAILED: briefing for a % DE still renders placeholder steps: %', v_kind, left(v_txt, 200);
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < 2 then
    raise exception 'ASSERT FAILED: briefing proven for only % kind(s) — both must be exercised', v_n;
  end if;
  raise notice 'mig 715: briefing proven non-placeholder for % kinds', v_n;
  v_checked := v_checked + v_n;

  -- ── A6. install_role_kit kept its callers, and only its callers ─
  if not has_function_privilege('authenticated', 'public.install_role_kit(uuid, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: install_role_kit lost its callers (the hire path breaks)';
  end if;
  if has_function_privilege('anon', 'public.install_role_kit(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon must not execute install_role_kit';
  end if;
  if has_function_privilege('anon', 'public.playbook_definition_kind(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.playbook_definition_kind(jsonb)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: the classifier must not be reachable from the internet';
  end if;

  -- ── A7. The archetypes classify as measured ──────────────────
  select count(*) into v_arch_sop
    from role_archetypes a
   where a.status = 'active' and a.sop_playbook ? 'steps'
     and public.playbook_definition_kind(a.sop_playbook->'steps') = 'sop';
  select count(*) into v_total
    from role_archetypes a where a.status = 'active' and a.sop_playbook ? 'steps';
  if v_arch_sop = 0 then
    raise exception 'ASSERT FAILED: no active archetype classifies as sop — mig 509/511 authored six of them';
  end if;
  raise notice 'mig 715: % of % active archetype SOPs are use_tool-format (the rest install as procedures)',
    v_arch_sop, v_total;

  raise notice 'migration 715 assertions passed (% direct comparisons)', v_checked;
end $$;
