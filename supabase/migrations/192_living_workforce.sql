-- ═══════════════════════════════════════════════════════════════
-- 192 — Living Workforce: the Playbook 3.0 patterns applied to the
-- other two workforce citizens, the DE and the Specialist.
--
-- Same spine, three tables shared across both entity kinds:
--   • workforce_entity_studies    — the Deep Study done at birth (D2)
--   • workforce_entity_amendments — a self-improvement redline (D4)
-- plus apply/reject + the human-review-card trigger (mirror mig 183/190).
--
-- GLOBAL by construction: schema + functions only, no tenant-specific
-- rows — every existing and future tenant gets this automatically.
-- ═══════════════════════════════════════════════════════════════

create table if not exists workforce_entity_studies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('de','specialist')),
  entity_id   uuid not null,
  brief_text  text not null,
  report      jsonb not null default '{}'::jsonb,
  model_id    text, input_tokens integer not null default 0, output_tokens integer not null default 0,
  created_at  timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (entity_kind, entity_id)
);
create index if not exists wf_entity_studies_tenant_idx on workforce_entity_studies(tenant_id);

create table if not exists workforce_entity_amendments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  entity_kind    text not null check (entity_kind in ('de','specialist')),
  entity_id      uuid not null,
  trigger_reason text not null,
  current_config jsonb not null,
  proposed_config jsonb not null,
  rationale      text not null default '',
  redline        jsonb not null default '[]'::jsonb,
  replay_result  jsonb not null default '{}'::jsonb,
  status         text not null default 'review_pending'
                   check (status in ('draft','review_pending','approved','rejected','applied')),
  model_id       text, input_tokens integer not null default 0, output_tokens integer not null default 0,
  created_at     timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists wf_entity_amend_tenant_idx on workforce_entity_amendments(tenant_id);
create index if not exists wf_entity_amend_entity_idx on workforce_entity_amendments(entity_kind, entity_id);

alter table workforce_entity_studies enable row level security;
alter table workforce_entity_amendments enable row level security;
drop policy if exists "wf_studies_iso" on workforce_entity_studies;
create policy "wf_studies_iso" on workforce_entity_studies for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
drop policy if exists "wf_amend_iso" on workforce_entity_amendments;
create policy "wf_amend_iso" on workforce_entity_amendments for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists wf_studies_updated_at on workforce_entity_studies;
create trigger wf_studies_updated_at before update on workforce_entity_studies for each row execute function update_updated_at();
drop trigger if exists wf_amend_updated_at on workforce_entity_amendments;
create trigger wf_amend_updated_at before update on workforce_entity_amendments for each row execute function update_updated_at();

-- ── apply: land the amended config on the entity (human already approved) ──
create or replace function public.apply_entity_amendment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_am workforce_entity_amendments; v_cfg jsonb; begin
  select * into v_am from workforce_entity_amendments where id = p_id;
  if not found then raise exception 'amendment not found'; end if;
  if v_am.status = 'applied' then return jsonb_build_object('ok', true, 'already', true); end if;
  v_cfg := v_am.proposed_config;

  if v_am.entity_kind = 'de' then
    update digital_employees set
      persona_name    = coalesce(v_cfg->>'persona_name', persona_name),
      description     = coalesce(v_cfg->>'description', description),
      purpose_statement = coalesce(v_cfg->>'purpose_statement', purpose_statement)
    where id = v_am.entity_id and tenant_id = v_am.tenant_id;
  else
    update specialist_profiles set charter = coalesce(v_cfg->>'charter', charter)
      where id = v_am.entity_id and tenant_id = v_am.tenant_id;
  end if;

  update workforce_entity_amendments set status = 'applied' where id = p_id;
  begin
    perform append_audit_event(v_am.tenant_id, 'Practice Engine', 'de',
      format('%s amendment applied — improved config landed', v_am.entity_kind),
      'config_change', jsonb_build_object('kind','entity_amendment_applied','amendment_id',p_id,'entity_kind',v_am.entity_kind,'entity_id',v_am.entity_id));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'entity_id', v_am.entity_id);
end; $function$;
revoke all on function public.apply_entity_amendment(uuid) from public, anon;
grant execute on function public.apply_entity_amendment(uuid) to authenticated, service_role;

create or replace function public.reject_entity_amendment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
begin update workforce_entity_amendments set status = 'rejected' where id = p_id and status <> 'applied';
  return jsonb_build_object('ok', true); end; $function$;
revoke all on function public.reject_entity_amendment(uuid) from public, anon;
grant execute on function public.reject_entity_amendment(uuid) to authenticated, service_role;

create or replace function public.sync_entity_amendment_decision() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.related_table = 'workforce_entity_amendments' and NEW.status in ('approved','rejected')
     and OLD.status is distinct from NEW.status then
    begin
      if NEW.status = 'approved' then perform public.apply_entity_amendment(NEW.related_id);
      else perform public.reject_entity_amendment(NEW.related_id); end if;
    exception when others then
      raise warning 'sync_entity_amendment_decision: % for %: %', NEW.status, NEW.related_id, SQLERRM;
    end;
  end if;
  return NEW;
end; $function$;
drop trigger if exists trg_sync_entity_amendment on human_tasks;
create trigger trg_sync_entity_amendment after update of status on human_tasks
  for each row execute function sync_entity_amendment_decision();
