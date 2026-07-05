-- ============================================================
-- Migration 031: Playbooks as the "document that executes".
--
-- The playbook becomes the DE operating charter: fully editable
-- step lists that mix EXPLANATION (instruction steps with embedded
-- media), FLOW CONTROL (decision / wait / sub_playbook) and WORK
-- (the existing primitives), plus per-DE playbook priorities.
--
--   playbook_runs      + parent_run_id (sub-playbook child runs)
--                      + resume_at     (wait-step wake-up time)
--                      + status 'waiting' (parked on wait / child run)
--   human_tasks        + type 'checklist' + checklist_state jsonb
--                        (item ticks — approve is gated on all ticked
--                        in the UI; the gate machinery is unchanged)
--   media_assets       + definition_id (step media for playbooks —
--                        profile_id stays for specialist media)
--   storage            + private bucket 'playbook-media', tenant-folder
--                        RLS (same pattern as specialist-media, 024)
--   de_playbook_charter — THE OPERATING CHARTER: which playbooks
--     a DE runs and in what priority order (lowest number first).
--     The dispatcher orders trigger fires by these priorities.
--
--   resume_playbook_on_task (REPLACED again): the SQL walker now parks
--     the run in 'resume_pending' at the FIRST post-gate step it cannot
--     advance natively (previously only connector_action) — the new
--     step types (instruction/decision/checklist/wait/sub_playbook)
--     need the HTTP executor, and the honest split stays honest.
-- ============================================================

-- ── playbook_runs: children, waits ──────────────────────────
alter table playbook_runs add column if not exists parent_run_id uuid references playbook_runs(id) on delete set null;
alter table playbook_runs add column if not exists resume_at timestamptz;

alter table playbook_runs drop constraint if exists playbook_runs_status_check;
alter table playbook_runs add constraint playbook_runs_status_check
  check (status in ('running', 'waiting_approval', 'resume_pending', 'waiting', 'completed', 'cancelled', 'failed'));

create index if not exists playbook_runs_parent_idx on playbook_runs(parent_run_id) where parent_run_id is not null;
create index if not exists playbook_runs_waiting_idx on playbook_runs(resume_at) where status = 'waiting';

-- ── human_tasks: checklist gates ────────────────────────────
alter table human_tasks drop constraint if exists human_tasks_type_check;
alter table human_tasks add constraint human_tasks_type_check
  check (type in ('approval_gate', 'review_gate', 'escalation', 'override',
                  'training_feedback', 'trust_promotion', 'trust_demotion_notice', 'checklist'));
alter table human_tasks add column if not exists checklist_state jsonb not null default '[]'::jsonb;

-- ── media_assets: playbook step media ───────────────────────
alter table media_assets add column if not exists definition_id uuid references playbook_definitions(id) on delete set null;
create index if not exists media_assets_definition_idx on media_assets(definition_id) where definition_id is not null;

-- ── STORAGE: private bucket 'playbook-media', tenant-folder RLS
--    Path convention: {tenant_id}/{uuid}-{filename} (mirrors 024) ──
insert into storage.buckets (id, name, public)
values ('playbook-media', 'playbook-media', false)
on conflict (id) do nothing;

drop policy if exists "playbook_media_tenant_select" on storage.objects;
create policy "playbook_media_tenant_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'playbook-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );

drop policy if exists "playbook_media_tenant_insert" on storage.objects;
create policy "playbook_media_tenant_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'playbook-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );

drop policy if exists "playbook_media_tenant_delete" on storage.objects;
create policy "playbook_media_tenant_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'playbook-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );

-- ============================================================
-- TABLE: de_playbook_charter — the DE operating charter.
-- Priority decides execution order when multiple active playbooks
-- fire from the same dispatch tick (lowest number runs first).
-- ============================================================
create table if not exists de_playbook_charter (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  de_id       uuid not null references digital_employees(id) on delete cascade,
  playbook_id uuid not null references playbook_definitions(id) on delete cascade,
  priority    integer not null default 100 check (priority between 1 and 1000),
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (de_id, playbook_id)
);

create index if not exists de_playbook_charter_tenant_idx on de_playbook_charter(tenant_id);
create index if not exists de_playbook_charter_de_idx on de_playbook_charter(de_id, priority) where active;

alter table de_playbook_charter enable row level security;

drop policy if exists "de_playbook_charter_tenant_isolation" on de_playbook_charter;
create policy "de_playbook_charter_tenant_isolation" on de_playbook_charter
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists de_playbook_charter_updated_at on de_playbook_charter;
create trigger de_playbook_charter_updated_at
  before update on de_playbook_charter
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: dispatch_due_triggers — REPLACED to honor the DE operating
-- charter: when several active schedules/event rules match, playbooks
-- with a LOWER de_playbook_charter.priority are evaluated (and thus
-- inserted as 'pending_start' fires, and started) FIRST. Unassigned
-- playbooks default to priority 1000 (last). Logic is otherwise
-- IDENTICAL to migration 020 — only the iteration order changed.
-- ============================================================
create or replace function dispatch_due_triggers(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sched      record;
  v_rule       record;
  v_acct       record;
  v_inv        record;
  v_ticket     record;
  v_pending    integer := 0;
  v_skipped    integer := 0;
  v_days       integer;
  v_priority   text;
  v_within     integer;
  v_recent     record;
begin
  -- ── (a) due schedules — lowest DE-assigned priority first ──
  for v_sched in
    select s.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = s.definition_id and a.active), 1000) as charter_priority
    from playbook_schedules s
    join playbook_definitions d on d.id = s.definition_id
    where s.active
      and s.next_fire_at is not null
      and s.next_fire_at <= now()
      and (p_tenant_id is null or s.tenant_id = p_tenant_id)
    order by charter_priority asc, s.next_fire_at asc
    for update of s skip locked
  loop
    if v_sched.def_status <> 'published' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, 'error',
              'definition is not published — schedule fired into the void');
      v_skipped := v_skipped + 1;
    elsif v_sched.account_selector->>'mode' = 'single' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id,
              (v_sched.account_selector->>'account_id')::uuid, 'pending_start',
              format('schedule due at %s (single account, charter priority %s)', v_sched.next_fire_at, v_sched.charter_priority));
      v_pending := v_pending + 1;
    else
      v_within := coalesce((v_sched.account_selector->>'renewal_within_days')::int, 60);
      for v_acct in
        select id from customer_accounts
        where tenant_id = v_sched.tenant_id
          and renewal_date is not null
          and renewal_date <= (current_date + v_within)
      loop
        insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
        values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, v_acct.id, 'pending_start',
                format('schedule due at %s (renewal within %s days, charter priority %s)', v_sched.next_fire_at, v_within, v_sched.charter_priority));
        v_pending := v_pending + 1;
      end loop;
    end if;

    update playbook_schedules set last_fired_at = now() where id = v_sched.id;
  end loop;

  -- ── (b) event rules — lowest DE-assigned priority first ────
  for v_rule in
    select r.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = r.definition_id and a.active), 1000) as charter_priority
    from playbook_event_rules r
    join playbook_definitions d on d.id = r.definition_id
    where r.active
      and d.status = 'published'
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
    order by charter_priority asc
  loop
    if v_rule.event_key = 'invoice_overdue' then
      v_days := coalesce((v_rule.params->>'overdue_days')::int, 7);
      for v_inv in
        select id, account_id from renewal_invoices
        where tenant_id = v_rule.tenant_id
          and status = 'sent'
          and due_date is not null
          and due_date < (current_date - v_days)
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_inv.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_inv.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'skipped_dedup',
                    format('invoice already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'pending_start',
                  format('invoice overdue > %s days (charter priority %s)', v_days, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'ticket_synced_high_priority' then
      v_priority := coalesce(v_rule.params->>'priority', 'p1');
      for v_ticket in
        select id, account_id from support_tickets
        where tenant_id = v_rule.tenant_id
          and source = 'zendesk'
          and priority = v_priority
          and created_at > now() - interval '7 days'
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'skipped_dedup',
                    format('ticket already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'pending_start',
                  format('%s ticket synced from Zendesk (charter priority %s)', v_priority, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$$;

revoke all on function dispatch_due_triggers(uuid) from public;
grant execute on function dispatch_due_triggers(uuid) to service_role;

-- ============================================================
-- RPC: resume_playbook_on_task — REPLACED. Same honest split as 019,
-- generalized: the SQL walker advances only what it can do natively
-- (guardrail_check / update_record / log_activity / complete); ANY
-- other post-gate step (connector_action + the new document steps)
-- parks the run in 'resume_pending' for the HTTP executor.
-- Also: 'checklist' gates resume through the same path — the gate
-- step detail reflects a completed checklist instead of an approval.
-- ============================================================
create or replace function resume_playbook_on_task(
  p_task_id  uuid,
  p_decision text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
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
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_run.tenant_id
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
  i := v_run.current_step;  -- index of the gate step (human_approval or checklist)
  v_gate_key := coalesce(v_steps->i->>'key', 'human_approval');

  if p_decision = 'rejected' then
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'],
      (case when v_gate_key = 'checklist' then '"Checklist rejected by human reviewer"' else '"Rejected by human reviewer"' end)::jsonb);
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
        case when v_gate_key = 'checklist' then 'checklist' else 'approval' end),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
    );
    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
  end if;

  -- Approved: gate step done. If the gate approved an invoice, send it.
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
      -- checklist, wait, sub_playbook, consult_specialist, …) — park the
      -- run; the edge function's 'advance' action finishes it.
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

  -- No explicit complete step (validation requires one, but be safe).
  update playbook_runs
    set status = 'completed', current_step = jsonb_array_length(v_steps) - 1, steps = v_steps, waiting_task_id = null, context = v_ctx
    where id = v_run.id;
  return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');
end;
$$;

revoke all on function resume_playbook_on_task(uuid, text) from public;
grant execute on function resume_playbook_on_task(uuid, text) to authenticated, service_role;
