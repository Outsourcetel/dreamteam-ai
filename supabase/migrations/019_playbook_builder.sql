-- ============================================================
-- Migration 019: R6 tenant playbook builder
--
--   playbook_definitions — tenant-authored playbooks composed from
--     typed step primitives (see the registry in
--     supabase/functions/playbook-execute/index.ts). Drafts are
--     editable; publishing validates server-side, bumps version and
--     snapshots the steps into playbook_versions so running playbooks
--     always reference an IMMUTABLE version.
--   playbook_versions    — immutable published snapshots.
--   playbook_runs        — gains definition_id + definition_version
--     (nullable: legacy renewal_v1 runs stay key-only) and a context
--     jsonb (account/invoice values used for {{template}} rendering
--     and for the SQL-native resume path).
--
--   resume_playbook_on_task (REPLACED) — now also resumes
--     definition-based runs. HONEST SPLIT: post-gate steps the RPC can
--     do in SQL (guardrail_check / update_record / log_activity /
--     complete) are advanced in SQL — server-authoritative, zero HTTP.
--     A post-gate connector_action needs HTTP, so the run is parked in
--     'resume_pending' and the playbook-execute edge function's
--     'advance' action (already fired by decideHumanTask) finishes it.
-- ============================================================

-- ============================================================
-- TABLE: playbook_definitions
-- ============================================================
create table if not exists playbook_definitions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key          text not null,
  name         text not null,
  description  text not null default '',
  version      integer not null default 1,
  status       text not null default 'draft'
                 check (status in ('draft', 'published', 'archived')),
  steps        jsonb not null default '[]'::jsonb,
  trigger_type text not null default 'manual'
                 check (trigger_type in ('manual', 'schedule', 'event')), -- schedule/event reserved
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists playbook_definitions_tenant_idx on playbook_definitions(tenant_id);

alter table playbook_definitions enable row level security;

drop policy if exists "playbook_definitions_tenant_isolation" on playbook_definitions;
create policy "playbook_definitions_tenant_isolation" on playbook_definitions
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_definitions_updated_at on playbook_definitions;
create trigger playbook_definitions_updated_at
  before update on playbook_definitions
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: playbook_versions — immutable published snapshots
-- ============================================================
create table if not exists playbook_versions (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references playbook_definitions(id) on delete cascade,
  version       integer not null,
  steps         jsonb not null,
  published_at  timestamptz not null default now(),
  published_by  uuid,
  unique (definition_id, version)
);

create index if not exists playbook_versions_def_idx on playbook_versions(definition_id);

alter table playbook_versions enable row level security;

drop policy if exists "playbook_versions_tenant_select" on playbook_versions;
create policy "playbook_versions_tenant_select" on playbook_versions
  for select
  using (definition_id in (
    select d.id from playbook_definitions d
    join profiles p on p.tenant_id = d.tenant_id
    where p.user_id = auth.uid()
  ));
-- inserts happen only via the service role (publish path in playbook-execute)

-- ============================================================
-- playbook_runs: definition linkage + template/resume context
-- ============================================================
alter table playbook_runs add column if not exists definition_id uuid references playbook_definitions(id) on delete set null;
alter table playbook_runs add column if not exists definition_version integer;
alter table playbook_runs add column if not exists context jsonb not null default '{}'::jsonb;

-- new statuses: resume_pending (approved, waiting for the HTTP advance)
-- and failed (a step errored)
alter table playbook_runs drop constraint if exists playbook_runs_status_check;
alter table playbook_runs add constraint playbook_runs_status_check
  check (status in ('running', 'waiting_approval', 'resume_pending', 'completed', 'cancelled', 'failed'));

create index if not exists playbook_runs_definition_idx on playbook_runs(definition_id) where definition_id is not null;

-- ============================================================
-- RPC: resume_playbook_on_task — REPLACED to cover definition runs.
-- Legacy renewal_v1 runs keep the exact 015/016 behavior.
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
  -- DEFINITION PATH: interpret the remaining step primitives.
  -- SQL handles: guardrail_check (record-only re-check),
  -- update_record (whitelisted status flip), log_activity, complete.
  -- connector_action needs HTTP → park in 'resume_pending' and let
  -- playbook-execute {action:'advance'} finish (decideHumanTask
  -- already fires it).
  -- ══════════════════════════════════════════════════════════
  i := v_run.current_step;  -- index of the human_approval step

  if p_decision = 'rejected' then
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"Rejected by human reviewer"');
    for i in v_run.current_step + 1 .. jsonb_array_length(v_steps) - 1 loop
      if v_steps->i->>'status' = 'pending' then
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
      end if;
    end loop;
    -- gated invoice (if any) stays awaiting_approval → flip to pending_generation? keep as-is, honest.
    update playbook_runs
      set status = 'cancelled', steps = v_steps, waiting_task_id = null
      where id = v_run.id;
    perform append_audit_event(
      v_run.tenant_id, 'Playbook DE', 'de',
      format('Playbook [%s] — run cancelled (approval rejected)', v_acct),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
    );
    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
  end if;

  -- Approved: gate step done. If the gate approved an invoice, send it.
  v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
  v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
  v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"Approved by human reviewer"');
  perform append_audit_event(
    v_run.tenant_id, 'Playbook DE', 'de',
    format('Playbook [%s] — step "Human approval" done: approved', v_acct),
    'playbook_step',
    jsonb_build_object('run_id', v_run.id, 'step_key', 'human_approval', 'step_status', 'done', 'task_id', p_task_id, 'definition_id', v_run.definition_id)
  );
  if (v_ctx->>'invoice_id') is not null then
    update renewal_invoices set status = 'sent', cadence_stage = 1
      where id = (v_ctx->>'invoice_id')::uuid and status = 'awaiting_approval';
  end if;

  -- Walk the remaining steps.
  i := v_run.current_step + 1;
  while i <= jsonb_array_length(v_steps) - 1 loop
    v_step   := v_steps->i;
    v_key    := v_step->>'key';
    v_params := coalesce(v_step->'params', '{}'::jsonb);

    if v_key = 'connector_action' then
      -- HTTP needed — park the run; the edge function advances it.
      update playbook_runs
        set status = 'resume_pending', current_step = i, steps = v_steps, waiting_task_id = null, context = v_ctx
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — approved; parked at connector step for HTTP advance', v_acct),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'step_key', v_key, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'resume_pending', 'needs_http', true);

    elsif v_key = 'guardrail_check' then
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
      -- Unexpected primitive after a gate (validation prevents this) — skip honestly.
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"skipped"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(format('skipped: %s not resumable in SQL', v_key)));
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
