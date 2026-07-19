-- ═══════════════════════════════════════════════════════════════
-- 190 — Playbook 3.0 Wave 5: self-amending procedures
--
-- When a playbook run fails (or a human describes a problem), the Practice
-- Engine drafts an AMENDMENT to the procedure, proves it by counterfactual
-- replay against past runs, and delivers it to a human as a redline for
-- one-click approval — the de-improve loop generalized from knowledge to
-- procedure. This table holds the proposed amendment + its evidence; the
-- approval flows through a human_tasks 'review_gate' card, and the trigger
-- below applies (or rejects) it on decision — same discipline as the
-- knowledge-revision auto-apply (mig 183).
-- ═══════════════════════════════════════════════════════════════

create table if not exists playbook_amendments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  definition_id  uuid not null references playbook_definitions(id) on delete cascade,
  trigger_reason text not null,                      -- what prompted this (failed run, problem text)
  current_steps  jsonb not null,                     -- snapshot of the steps at draft time
  proposed_steps jsonb not null,                     -- the amended steps (validated)
  rationale      text not null default '',           -- plain-language why
  redline        jsonb not null default '[]'::jsonb, -- [{change:'add'|'remove'|'edit', at, before, after}]
  replay_result  jsonb not null default '{}'::jsonb, -- counterfactual replay evidence
  status         text not null default 'review_pending'
                   check (status in ('draft','review_pending','approved','rejected','applied')),
  model_id       text,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists playbook_amendments_tenant_idx on playbook_amendments(tenant_id);
create index if not exists playbook_amendments_def_idx on playbook_amendments(definition_id);

alter table playbook_amendments enable row level security;
drop policy if exists "playbook_amendments_tenant_isolation" on playbook_amendments;
create policy "playbook_amendments_tenant_isolation" on playbook_amendments
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_amendments_updated_at on playbook_amendments;
create trigger playbook_amendments_updated_at
  before update on playbook_amendments
  for each row execute function update_updated_at();

-- ── apply: land the amended steps on the definition as a fresh DRAFT ──
-- The amendment never auto-publishes; it becomes the definition's draft so a
-- human still runs the normal publish gate (which validates + snapshots +
-- re-mirrors to the DE brain). This keeps the human in the loop for what
-- reaches customers, exactly like the rest of the platform.
create or replace function public.apply_playbook_amendment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_am playbook_amendments; begin
  select * into v_am from playbook_amendments where id = p_id;
  if not found then raise exception 'amendment not found'; end if;
  if v_am.status = 'applied' then return jsonb_build_object('ok', true, 'already', true); end if;

  update playbook_definitions
    set steps = v_am.proposed_steps, status = 'draft'
    where id = v_am.definition_id and tenant_id = v_am.tenant_id;

  update playbook_amendments set status = 'applied' where id = p_id;

  -- Audit is best-effort: append_audit_event enforces tenant membership via
  -- auth.uid(), which is absent on service/trigger paths — a failed audit
  -- must never block the apply itself.
  begin
    perform append_audit_event(
      v_am.tenant_id, 'Practice Engine', 'de',
      'Playbook amendment applied to draft — ready to review & publish',
      'config_change',
      jsonb_build_object('kind','playbook_amendment_applied','amendment_id',p_id,'definition_id',v_am.definition_id)
    );
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'definition_id', v_am.definition_id);
end; $function$;
revoke all on function public.apply_playbook_amendment(uuid) from public, anon;
grant execute on function public.apply_playbook_amendment(uuid) to authenticated, service_role;

create or replace function public.reject_playbook_amendment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
begin
  update playbook_amendments set status = 'rejected' where id = p_id and status <> 'applied';
  return jsonb_build_object('ok', true);
end; $function$;
revoke all on function public.reject_playbook_amendment(uuid) from public, anon;
grant execute on function public.reject_playbook_amendment(uuid) to authenticated, service_role;

-- ── approve/reject via the human_tasks review card (mirrors mig 183) ──
create or replace function public.sync_amendment_decision() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.related_table = 'playbook_amendments' and NEW.status in ('approved','rejected')
     and OLD.status is distinct from NEW.status then
    begin
      if NEW.status = 'approved' then
        perform public.apply_playbook_amendment(NEW.related_id);
      else
        perform public.reject_playbook_amendment(NEW.related_id);
      end if;
    exception when others then
      -- never let a failed apply roll back the human's decision
      raise warning 'sync_amendment_decision: % for amendment %: %', NEW.status, NEW.related_id, SQLERRM;
    end;
  end if;
  return NEW;
end; $function$;

drop trigger if exists trg_sync_amendment on human_tasks;
create trigger trg_sync_amendment
  after update of status on human_tasks
  for each row execute function sync_amendment_decision();
