-- ============================================================
-- Migration 016: R4 server-side playbook executor + R5 trust dial v1
--   1. de_autonomy — per-tenant, per-action autonomy thresholds
--      (the trust dial). COMPOSITION RULE: autonomy NARROWS within
--      guardrails, never overrides them. An action auto-executes only
--      when BOTH the guardrail rule allows it (amount <= guardrail
--      threshold) AND (no autonomy row exists OR the autonomy row is
--      enabled with amount <= its max). Otherwise → human approval.
--   2. resume_playbook_on_task(task_id, decision) — SECURITY DEFINER
--      RPC that resumes/cancels a playbook run paused on a human task.
--      DESIGN CHOICE (R4): the resume logic lives fully in SQL so the
--      orchestration stays server-authoritative — no browser round-trip
--      is required between "task decided" and "run resumed". The
--      playbook-execute edge function performs start/advance/cancel;
--      this RPC is the human-gate resume path invoked by decideHumanTask.
-- ============================================================

-- ============================================================
-- TABLE: de_autonomy (trust dial v1)
-- ============================================================
create table if not exists de_autonomy (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  action_type       text not null
                      check (action_type in ('invoice_auto_send', 'answer_dock', 'answer_widget')),
  max_amount_cents  bigint,
  min_confidence    integer check (min_confidence is null or (min_confidence between 0 and 100)),
  enabled           boolean not null default false,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, action_type)
);

create index if not exists de_autonomy_tenant_idx on de_autonomy(tenant_id);

alter table de_autonomy enable row level security;

drop policy if exists "de_autonomy_tenant_isolation" on de_autonomy;
create policy "de_autonomy_tenant_isolation" on de_autonomy
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists de_autonomy_updated_at on de_autonomy;
create trigger de_autonomy_updated_at
  before update on de_autonomy
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: resume_playbook_on_task — server-authoritative human-gate resume.
-- Approve → human_approval done, invoice → sent + cadence Day-0,
-- mark_sent + complete done, run completed. Reject → run cancelled.
-- Idempotent: no waiting run for the task → no-op. Every transition
-- appends hash-chained audit events via append_audit_event().
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

  -- Caller must be a member of the run's tenant (or the service role).
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_run.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_steps := v_run.steps;
  v_acct  := coalesce(nullif(split_part(v_steps->0->>'detail', ' · ', 1), ''), 'account');

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

  -- Approved: human_approval done.
  v_steps := jsonb_set(v_steps, '{3,status}', '"done"');
  v_steps := jsonb_set(v_steps, '{3,at}', to_jsonb(v_now));
  v_steps := jsonb_set(v_steps, '{3,detail}', '"Approved by human reviewer"');
  perform append_audit_event(
    v_run.tenant_id, 'Renewal DE', 'de',
    format('Renewal playbook [%s] — step "Human approval" done: Approved by human reviewer', v_acct),
    'playbook_step',
    jsonb_build_object('run_id', v_run.id, 'step_key', 'human_approval', 'step_status', 'done', 'task_id', p_task_id)
  );

  -- Latest invoice for the run's account → sent + cadence Day-0.
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
end;
$$;

revoke all on function resume_playbook_on_task(uuid, text) from public;
grant execute on function resume_playbook_on_task(uuid, text) to authenticated, service_role;
