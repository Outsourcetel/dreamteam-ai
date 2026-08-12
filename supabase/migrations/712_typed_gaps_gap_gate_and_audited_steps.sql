-- ═══════════════════════════════════════════════════════════════
-- 712 — Builder typed gaps: playbook_gaps + gap_gate groundwork +
--       audited/shape-guarded playbook steps writes.
--
-- Design of record: docs/superpowers/specs/2026-08-12-builder-typed-gaps-design.md
-- (founder-approved build). Three things land here:
--
-- 1. playbook_gaps — the validator's and Deep Study's objections become
--    ANSWERABLE typed rows instead of read-only prose. Four kinds, reusing
--    the onboarding @ask/answer-sheet vocabulary (docs spec §3-4):
--    answered = a person provided something; resolved = the platform
--    VERIFIED the evidence at recompile. A gap never resolves on the
--    user's say-so alone.
--
-- 2. playbook_definitions gains partial_publish_enabled (DEFAULT OFF —
--    the founder question on partial publish is still open; nothing can
--    partially publish until a human flips this per playbook) and
--    steps_updated_at (maintained by the trigger below, read by the
--    certify probe's data arm).
--
-- 3. THE GOVERNANCE HOLE (spec §1.4, proven live): on 2026-08-11 22:31 the
--    incident draft 88c1a2c1 was overwritten — 7 compiled steps became 8
--    prose sections named "Rabeel" — through a write path that audits
--    NOTHING (direct PostgREST update under RLS or a service credential).
--    Exactly one audit event exists for that definition. Two triggers close
--    the CLASS:
--      · playbook_steps_shape_guard: steps must be an array of objects each
--        carrying a non-empty string "key". Drafts may still be ENGINE-
--        invalid (the whole gap feature persists those); prose blobs that
--        are not steps at all can no longer land. Applies to EVERY write
--        path — PostgREST, RPC (ai_apply_change), service role — which is
--        the spec's Q7 recommendation implemented one level lower than the
--        function, so the second unvalidated write path cannot reopen.
--      · playbook_steps_audit: any UPDATE that changes steps appends an
--        audit event IN THE SAME STATEMENT. The audit write failing fails
--        the update — an un-audited steps update is now impossible, not
--        just unlikely. (INSERTs keep their existing creator-side audits;
--        the client-side duplicate for steps edits is removed in the same
--        commit.)
--
-- The gap_gate runtime primitive itself lives in playbook-execute (edge);
-- resume_playbook_on_task learns it here so an approved gap_gate task is
-- recorded as the WAIVER it is ("skip this step for this run"), never as
-- "Approved" — and rejection cancels the run, exactly two outcomes.
-- "Execute anyway" does not exist: the snapshot holds no executable form.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. The typed gap ledger ─────────────────────────────────────
create table if not exists playbook_gaps (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  definition_id uuid not null references playbook_definitions(id) on delete cascade,
  step_index    integer,
  kind          text not null check (kind in
                  ('missing_knowledge','missing_authority','missing_data','fixable_by_structure')),
  -- stable dedupe key: recompiles keep an unchanged objection's identity.
  gap_key       text not null,
  title         text not null default '',
  detail        text not null default '',
  source        text not null default 'study' check (source in ('validator','study','author')),
  -- the typed affordance contract, per kind (spec §4.2)
  ask           jsonb not null default '{}'::jsonb,
  status        text not null default 'open' check (status in ('open','answered','resolved','dismissed')),
  answer        jsonb,
  answered_by   uuid,
  answered_at   timestamptz,
  resolved_at   timestamptz,
  dismissed_by  uuid,
  dismissed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (definition_id, gap_key)
);

create index if not exists playbook_gaps_tenant_idx on playbook_gaps(tenant_id);
create index if not exists playbook_gaps_definition_idx on playbook_gaps(definition_id);

alter table playbook_gaps enable row level security;

-- Members read; NOBODY writes through the table from the browser. All row
-- creation/resolution is the compiler's (service role, bypasses RLS); the
-- two state changes a human may make go through the role-checked RPCs
-- below. No INSERT/UPDATE/DELETE policy for authenticated is deliberate.
drop policy if exists "playbook_gaps_tenant_read" on playbook_gaps;
create policy "playbook_gaps_tenant_read" on playbook_gaps
  for select using (tenant_id = public.auth_tenant_id());

drop trigger if exists playbook_gaps_updated_at on playbook_gaps;
create trigger playbook_gaps_updated_at
  before update on playbook_gaps
  for each row execute function update_updated_at();

-- ── 2. Definition columns ───────────────────────────────────────
alter table playbook_definitions
  add column if not exists partial_publish_enabled boolean not null default false;
alter table playbook_definitions
  add column if not exists steps_updated_at timestamptz;

-- ── 3. ONE guard trigger: shape first, then the audit write ─────
-- One function, one order — the first draft used two triggers and the
-- alphabetical firing order put the audit before the shape check, so
-- garbage was refused with a membership error instead of naming itself.
--
-- ⚠ append_audit_event carries its own caller guard (service_role or
-- tenant member). That composes into a strictly stronger property than
-- "audited": a steps UPDATE from a context that CANNOT be audited (e.g.
-- raw management-API SQL as postgres) now FAILS ENTIRELY rather than
-- landing silently. A future migration that must rewrite steps has to
-- say so out loud: ALTER TABLE playbook_definitions DISABLE TRIGGER
-- playbook_steps_guard; ... re-enable after. The certify probe pins the
-- trigger enabled, so a left-disabled guard cannot ship quietly.
create or replace function public.playbook_steps_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem  jsonb;
  v_uid   uuid;
  v_actor text;
begin
  if tg_op = 'UPDATE' and new.steps is not distinct from old.steps then
    return new;                    -- steps untouched: nothing to check
  end if;

  -- Shape: an array of objects, each with a non-empty string "key". Drafts
  -- may still be ENGINE-invalid (gaps exist for that); prose blobs that are
  -- not steps at all (the 22:31 "Rabeel" overwrite) can no longer land.
  if jsonb_typeof(new.steps) is distinct from 'array' then
    raise exception 'invalid_step_shape: steps must be a JSON array of step objects';
  end if;
  for v_elem in select jsonb_array_elements(new.steps) loop
    if jsonb_typeof(v_elem) <> 'object'
       or coalesce(nullif(v_elem->>'key', ''), '') = '' then
      raise exception 'invalid_step_shape: every step must be an object with a non-empty "key" naming an engine primitive (got: %)',
        left(v_elem::text, 120);
    end if;
  end loop;

  new.steps_updated_at := now();

  -- Audit, in the same statement as the write: if this insert fails, the
  -- steps update fails with it. INSERTs keep their existing creator-side
  -- audit events (playbook-draft, createDefinition) — no double-logging.
  if tg_op = 'UPDATE' then
    v_uid := auth.uid();
    if v_uid is not null then
      select coalesce(nullif(full_name, ''), 'A workspace member') into v_actor
        from profiles where user_id = v_uid limit 1;
      v_actor := coalesce(v_actor, 'A workspace member');
    else
      v_actor := 'Service or automation';
    end if;
    perform append_audit_event(
      new.tenant_id,
      v_actor,
      case when v_uid is not null then 'human' else 'system' end,
      format('Playbook steps changed — "%s" (%s): %s -> %s step(s)',
        new.name, new.key,
        case when jsonb_typeof(old.steps) = 'array' then jsonb_array_length(old.steps) else 0 end,
        jsonb_array_length(new.steps)),
      'config_change',
      jsonb_build_object(
        'kind', 'playbook_steps_updated',
        'definition_id', new.id,
        'definition_key', new.key,
        'steps_before', case when jsonb_typeof(old.steps) = 'array' then jsonb_array_length(old.steps) else 0 end,
        'steps_after', jsonb_array_length(new.steps),
        'user_id', v_uid,
        'via', 'db_trigger')
    );
  end if;
  return new;
end $$;

revoke all on function public.playbook_steps_guard() from public, anon, authenticated;

-- Retire the two-trigger first draft if it exists (dev saw it briefly).
drop trigger if exists playbook_steps_shape_guard on playbook_definitions;
drop trigger if exists playbook_steps_audit on playbook_definitions;
drop function if exists public.playbook_steps_shape_guard();
drop function if exists public.playbook_steps_audit();

drop trigger if exists playbook_steps_guard on playbook_definitions;
create trigger playbook_steps_guard
  before insert or update on playbook_definitions
  for each row execute function public.playbook_steps_guard();

-- ── 4. Answering and dismissing gaps — role-checked, audited ────
-- Safe defaults from the build brief: missing_authority answerable by
-- owner/admin ONLY; other kinds by the same roles that may edit playbooks
-- today (owner/admin/manager). Dismissing any gap is owner/admin only.
create or replace function public.answer_playbook_gap(p_gap_id uuid, p_answer jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap    playbook_gaps;
  v_tenant uuid := public.auth_tenant_id();
  v_uid    uuid := auth.uid();
  v_actor  text;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select * into v_gap from playbook_gaps
   where id = p_gap_id and tenant_id = v_tenant
   for update;
  if v_gap.id is null then
    raise exception 'gap_not_found';
  end if;
  if v_gap.status in ('resolved', 'dismissed') then
    raise exception 'gap_already_closed: %', v_gap.status;
  end if;
  if v_gap.kind = 'missing_authority' then
    if not public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
      raise exception 'authority_gap_requires_owner_or_admin';
    end if;
  else
    if not public.auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
      raise exception 'answering_requires_manager_role';
    end if;
  end if;
  if p_answer is null or jsonb_typeof(p_answer) <> 'object' then
    raise exception 'answer_must_be_an_object';
  end if;

  update playbook_gaps
     set answer = p_answer,
         status = 'answered',
         answered_by = v_uid,
         answered_at = now()
   where id = v_gap.id;

  select coalesce(nullif(full_name, ''), 'A workspace member') into v_actor
    from profiles where user_id = v_uid limit 1;
  perform append_audit_event(
    v_tenant, coalesce(v_actor, 'A workspace member'), 'human',
    format('Playbook gap answered — %s "%s" (%s)', v_gap.kind, v_gap.title, v_gap.gap_key),
    'config_change',
    jsonb_build_object('kind', 'playbook_gap_answered', 'gap_id', v_gap.id,
      'definition_id', v_gap.definition_id, 'gap_kind', v_gap.kind,
      'gap_key', v_gap.gap_key, 'answer', p_answer)
  );
  -- answered, NOT resolved — resolution is the recompile's verified verdict.
  return jsonb_build_object('ok', true, 'gap_id', v_gap.id, 'status', 'answered');
end $$;

create or replace function public.dismiss_playbook_gap(p_gap_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap    playbook_gaps;
  v_tenant uuid := public.auth_tenant_id();
  v_uid    uuid := auth.uid();
  v_actor  text;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'dismissing_requires_owner_or_admin';
  end if;
  select * into v_gap from playbook_gaps
   where id = p_gap_id and tenant_id = v_tenant
   for update;
  if v_gap.id is null then
    raise exception 'gap_not_found';
  end if;
  if v_gap.status in ('resolved', 'dismissed') then
    raise exception 'gap_already_closed: %', v_gap.status;
  end if;

  update playbook_gaps
     set status = 'dismissed', dismissed_by = v_uid, dismissed_at = now()
   where id = v_gap.id;

  select coalesce(nullif(full_name, ''), 'A workspace member') into v_actor
    from profiles where user_id = v_uid limit 1;
  perform append_audit_event(
    v_tenant, coalesce(v_actor, 'A workspace member'), 'human',
    format('Playbook gap dismissed — %s "%s" (%s)%s', v_gap.kind, v_gap.title, v_gap.gap_key,
      case when coalesce(p_note, '') <> '' then ': ' || left(p_note, 300) else '' end),
    'config_change',
    jsonb_build_object('kind', 'playbook_gap_dismissed', 'gap_id', v_gap.id,
      'definition_id', v_gap.definition_id, 'gap_kind', v_gap.kind,
      'gap_key', v_gap.gap_key, 'note', coalesce(p_note, ''))
  );
  return jsonb_build_object('ok', true, 'gap_id', v_gap.id, 'status', 'dismissed');
end $$;

-- The default-EXECUTE hole (migs 610+630): revoke, then grant deliberately.
revoke all on function public.answer_playbook_gap(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.dismiss_playbook_gap(uuid, text) from public, anon, authenticated;
grant execute on function public.answer_playbook_gap(uuid, jsonb) to authenticated;
grant execute on function public.dismiss_playbook_gap(uuid, text) to authenticated;

-- ── 5. resume_playbook_on_task learns gap_gate ──────────────────
-- Same body as the current production function (mig 059 sweep) with ONE
-- addition: when the waiting step is a gap_gate, approval records a WAIVER
-- ("skipped — gap unanswered, waived for this run"), never "Approved", and
-- the walk continues; rejection cancels the run exactly as before. The
-- blocked behaviour cannot run either way — the snapshot holds only a
-- frozen, non-executable copy.
create or replace function public.resume_playbook_on_task(p_task_id uuid, p_decision text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_run     playbook_runs;
  v_steps   jsonb;
  v_acct    text;
  v_inv     record;
  v_now     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  i         integer;
  v_step    jsonb;
  v_key     text;
  v_params  jsonb;
  v_ctx     jsonb;
  v_text    text;
  v_tbl     text;
  v_set     text;
  v_detail  text;
  v_gate_key text;
  v_waiver  text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_run
  from playbook_runs
  where waiting_task_id = p_task_id
    and status = 'waiting_approval'
  limit 1;

  if not found then
    return jsonb_build_object('resumed', false, 'reason', 'no_waiting_run');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_run.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_steps := v_run.steps;
  v_ctx   := coalesce(v_run.context, '{}'::jsonb);
  v_acct  := coalesce(nullif(v_ctx->>'account_name', ''),
             coalesce(nullif(split_part(v_steps->0->>'detail', ' · ', 1), ''), 'account'));

  -- ══════════════════════════════════════════════════════════
  -- LEGACY PATH: renewal_v1 (no definition) — unchanged behavior
  -- ══════════════════════════════════════════════════════════
  if v_run.definition_id is null then
    if p_decision = 'rejected' then
      v_steps := jsonb_set(v_steps, '{3,status}', '"cancelled"');
      v_steps := jsonb_set(v_steps, '{3,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{3,detail}', '"Rejected by human reviewer"');
      for i in 4 .. jsonb_array_length(v_steps) - 1 loop
        if v_steps->i->>'status' = 'pending' then
          v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
        end if;
      end loop;
      update playbook_runs
        set status = 'cancelled', current_step = 3, steps = v_steps, waiting_task_id = null
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Renewal DE', 'de',
        format('Renewal playbook [%s] — run cancelled (approval rejected)', v_acct),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
    end if;

    v_steps := jsonb_set(v_steps, '{3,status}', '"done"');
    v_steps := jsonb_set(v_steps, '{3,at}', to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, '{3,detail}', '"Approved by human reviewer"');
    perform append_audit_event(
      v_run.tenant_id, 'Renewal DE', 'de',
      format('Renewal playbook [%s] — step "Human approval" done: Approved by human reviewer', v_acct),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'step_key', 'human_approval', 'step_status', 'done', 'task_id', p_task_id)
    );

    select id, amount_cents into v_inv
    from renewal_invoices
    where tenant_id = v_run.tenant_id and account_id = v_run.account_id
    order by created_at desc
    limit 1;

    if v_inv.id is not null then
      update renewal_invoices set status = 'sent', cadence_stage = 1 where id = v_inv.id;
      v_steps := jsonb_set(v_steps, '{4,status}', '"done"');
      v_steps := jsonb_set(v_steps, '{4,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{4,detail}',
        to_jsonb(format('Invoice $%s sent · cadence Day-0 started', to_char(round(v_inv.amount_cents / 100.0), 'FM999,999,999'))));
      perform append_audit_event(
        v_run.tenant_id, 'Renewal DE', 'de',
        format('Renewal playbook [%s] — step "Send invoice" done: %s', v_acct, v_steps->4->>'detail'),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_key', 'mark_sent', 'step_status', 'done', 'invoice_id', v_inv.id)
      );
      insert into activity_events (tenant_id, actor, actor_type, event_type, text)
      values (v_run.tenant_id, 'Renewal DE', 'de', 'resolved',
        format('Renewal playbook sent invoice — %s ($%s), dunning cadence started',
          v_acct, to_char(round(v_inv.amount_cents / 100.0), 'FM999,999,999')));
    else
      v_steps := jsonb_set(v_steps, '{4,status}', '"skipped"');
      v_steps := jsonb_set(v_steps, '{4,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{4,detail}', '"Invoice not found for cadence update"');
    end if;

    v_steps := jsonb_set(v_steps, '{5,status}', '"done"');
    v_steps := jsonb_set(v_steps, '{5,at}', to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, '{5,detail}', '"Run completed"');

    update playbook_runs
      set status = 'completed', current_step = 5, steps = v_steps, waiting_task_id = null
      where id = v_run.id;

    perform append_audit_event(
      v_run.tenant_id, 'Renewal DE', 'de',
      format('Renewal playbook [%s] — run completed end-to-end', v_acct),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'invoice_id', v_inv.id, 'amount_cents', v_inv.amount_cents, 'resumed_by', 'resume_playbook_on_task')
    );

    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');
  end if;

  -- ══════════════════════════════════════════════════════════
  -- DEFINITION PATH: SQL advances guardrail_check / update_record /
  -- log_activity / complete natively. ANY other step (connector_action,
  -- instruction, decision, checklist, wait, sub_playbook, consult) parks
  -- the run in 'resume_pending' — the HTTP executor finishes it.
  -- ══════════════════════════════════════════════════════════
  i := v_run.current_step;  -- index of the gate step (human_approval, checklist or gap_gate)
  v_gate_key := coalesce(v_steps->i->>'key', 'human_approval');

  if p_decision = 'rejected' then
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'],
      (case when v_gate_key = 'checklist' then '"Checklist rejected by human reviewer"'
            when v_gate_key = 'gap_gate' then '"Run cancelled at the gap gate — the gap is unanswered and the human chose not to continue"'
            else '"Rejected by human reviewer"' end)::jsonb);
    for i in v_run.current_step + 1 .. jsonb_array_length(v_steps) - 1 loop
      if v_steps->i->>'status' = 'pending' then
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
      end if;
    end loop;
    update playbook_runs
      set status = 'cancelled', steps = v_steps, waiting_task_id = null
      where id = v_run.id;
    perform append_audit_event(
      v_run.tenant_id, 'Playbook DE', 'de',
      format('Playbook [%s] — run cancelled (%s rejected)', v_acct,
        case when v_gate_key = 'checklist' then 'checklist'
             when v_gate_key = 'gap_gate' then 'gap gate'
             else 'approval' end),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
    );
    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
  end if;

  -- Approved. A gap_gate NEVER becomes "done": approval means "skip this
  -- step for THIS run, gap still open" — recorded as the waiver it is.
  if v_gate_key = 'gap_gate' then
    v_waiver := format('skipped — gap unanswered, step waived for this run by human decision (task %s)', p_task_id);
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"skipped"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_waiver));
    perform append_audit_event(
      v_run.tenant_id, 'Playbook DE', 'de',
      format('Playbook [%s] — gap gate "%s" skipped for this run (gap stays open; answering it unblocks the next published version)',
        v_acct, coalesce(v_steps->i->>'label', 'gap gate')),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'step_key', 'gap_gate', 'step_status', 'skipped',
        'task_id', p_task_id, 'definition_id', v_run.definition_id,
        'gap_id', v_steps->i->'params'->>'gap_id')
    );
  else
    -- Gate step done. If the gate approved an invoice, send it.
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'],
      (case when v_gate_key = 'checklist' then '"Checklist completed — all items confirmed by a human"' else '"Approved by human reviewer"' end)::jsonb);
    perform append_audit_event(
      v_run.tenant_id, 'Playbook DE', 'de',
      format('Playbook [%s] — step "%s" done: %s', v_acct,
        case when v_gate_key = 'checklist' then 'Checklist' else 'Human approval' end,
        case when v_gate_key = 'checklist' then 'all items confirmed' else 'approved' end),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'step_key', v_gate_key, 'step_status', 'done', 'task_id', p_task_id, 'definition_id', v_run.definition_id)
    );
    if v_gate_key = 'human_approval' and (v_ctx->>'invoice_id') is not null then
      update renewal_invoices set status = 'sent', cadence_stage = 1
        where id = (v_ctx->>'invoice_id')::uuid and status = 'awaiting_approval';
    end if;
  end if;

  -- Walk the remaining steps.
  i := v_run.current_step + 1;
  while i <= jsonb_array_length(v_steps) - 1 loop
    v_step   := v_steps->i;
    v_key    := v_step->>'key';
    v_params := coalesce(v_step->'params', '{}'::jsonb);

    if v_key = 'guardrail_check' then
      v_detail := format('Re-checked invoice threshold post-approval — amount $%s (approved by human)',
        to_char(round(coalesce((v_ctx->>'invoice_amount_cents')::bigint, 0) / 100.0), 'FM999,999,999'));
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_detail));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Guardrail check" done: %s', v_acct, v_detail),
        'guardrail_check',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id, 'result', 'passed_post_approval')
      );

    elsif v_key = 'update_record' then
      v_tbl := v_params->>'table';
      v_set := v_params#>>'{set,status}';
      v_detail := null;
      if v_tbl = 'renewal_invoices' and v_set in ('sent', 'paid') and (v_ctx->>'invoice_id') is not null then
        update renewal_invoices set status = v_set where id = (v_ctx->>'invoice_id')::uuid;
        v_detail := format('renewal_invoices.status → %s', v_set);
      elsif v_tbl = 'support_tickets' and v_set in ('open', 'pending', 'resolved', 'escalated') and (v_ctx->>'ticket_id') is not null then
        update support_tickets set status = v_set where id = (v_ctx->>'ticket_id')::uuid and tenant_id = v_run.tenant_id;
        v_detail := format('support_tickets.status → %s', v_set);
      end if;
      if v_detail is null then
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"skipped"');
        v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"skipped: no target record in run context"');
      else
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
        v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_detail));
      end if;
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Update record" %s', v_acct, coalesce(v_detail, 'skipped: no target record')),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id)
      );

    elsif v_key = 'log_activity' then
      v_text := coalesce(v_params->>'text_template', 'Playbook step executed');
      v_text := replace(v_text, '{{account.name}}', coalesce(v_ctx->>'account_name', 'account'));
      v_text := replace(v_text, '{{invoice.amount}}',
        '$' || to_char(round(coalesce((v_ctx->>'invoice_amount_cents')::bigint, 0) / 100.0), 'FM999,999,999'));
      v_text := replace(v_text, '{{run.id}}', v_run.id::text);
      insert into activity_events (tenant_id, actor, actor_type, event_type, text)
      values (v_run.tenant_id, 'Playbook DE', 'de', 'resolved', v_text);
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_text));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Log activity" done: %s', v_acct, v_text),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id)
      );

    elsif v_key = 'complete' then
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"Run completed"');
      update playbook_runs
        set status = 'completed', current_step = i, steps = v_steps, waiting_task_id = null, context = v_ctx
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — run completed end-to-end', v_acct),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');

    else
      -- Needs the HTTP executor (connector_action, instruction, decision,
      -- checklist, wait, sub_playbook, gap_gate, …) — park the run; the
      -- edge function's 'advance' action finishes it. A gap_gate met here
      -- pauses again through its own executor case: two outcomes only.
      update playbook_runs
        set status = 'resume_pending', current_step = i, steps = v_steps, waiting_task_id = null, context = v_ctx
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — approved; parked at "%s" step for HTTP advance', v_acct, v_key),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'step_key', v_key, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'resume_pending', 'needs_http', true);
    end if;

    i := i + 1;
  end loop;

  update playbook_runs
    set status = 'completed', steps = v_steps, waiting_task_id = null, context = v_ctx
    where id = v_run.id;
  return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');
end
$function$;

-- Preserve the existing perimeter exactly: authenticated may execute (it is
-- the decide-flow's resume hook), anon/public may not.
revoke all on function public.resume_playbook_on_task(uuid, text) from public, anon;
grant execute on function public.resume_playbook_on_task(uuid, text) to authenticated;

-- ── 6. Assertions — this migration proves itself ────────────────
do $$
declare
  v_cnt integer;
begin
  -- table + columns landed
  if to_regclass('public.playbook_gaps') is null then
    raise exception 'ASSERT FAILED: playbook_gaps missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_name = 'playbook_definitions' and column_name = 'partial_publish_enabled') then
    raise exception 'ASSERT FAILED: partial_publish_enabled missing';
  end if;

  -- partial publish defaults OFF
  if (select column_default from information_schema.columns
       where table_name = 'playbook_definitions' and column_name = 'partial_publish_enabled') !~* 'false' then
    raise exception 'ASSERT FAILED: partial_publish_enabled must default to false';
  end if;

  -- RLS on and no write policy for authenticated on playbook_gaps
  if not (select relrowsecurity from pg_class where oid = 'public.playbook_gaps'::regclass) then
    raise exception 'ASSERT FAILED: RLS not enabled on playbook_gaps';
  end if;
  select count(*) into v_cnt from pg_policy
   where polrelid = 'public.playbook_gaps'::regclass and polcmd in ('a','w','d','*');
  if v_cnt > 0 then
    raise exception 'ASSERT FAILED: playbook_gaps must have NO client write policies (found %)', v_cnt;
  end if;

  -- the guard trigger present and enabled
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.playbook_definitions'::regclass
                    and tgname = 'playbook_steps_guard' and tgenabled = 'O') then
    raise exception 'ASSERT FAILED: playbook_steps_guard trigger missing or disabled';
  end if;

  -- EXECUTE perimeter: exactly authenticated on the two gap RPCs; nothing for anon
  if has_function_privilege('anon', 'public.answer_playbook_gap(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.dismiss_playbook_gap(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon must not execute the gap RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.answer_playbook_gap(uuid, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.dismiss_playbook_gap(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: authenticated must be able to execute the gap RPCs';
  end if;
  if has_function_privilege('anon', 'public.resume_playbook_on_task(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: anon must not execute resume_playbook_on_task';
  end if;
  if not has_function_privilege('authenticated', 'public.resume_playbook_on_task(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT FAILED: authenticated lost resume_playbook_on_task (decide-flow hook breaks)';
  end if;
  if has_function_privilege('authenticated', 'public.playbook_steps_guard()', 'EXECUTE')
     or has_function_privilege('anon', 'public.playbook_steps_guard()', 'EXECUTE') then
    raise exception 'ASSERT FAILED: trigger function must not be directly executable';
  end if;

  raise notice 'migration 712 assertions passed';
end $$;
