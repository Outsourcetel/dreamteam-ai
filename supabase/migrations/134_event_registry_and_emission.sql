-- ============================================================
-- Wave 2b — Tenant-defined trigger events (registry + emission)
--
-- Before this, the event set that can start a playbook was frozen in three
-- coupled places: a CHECK on playbook_event_rules.event_key (4 keys), the
-- if/elsif ladder in dispatch_due_triggers (each branch polls a fixed domain
-- table), and a hardcoded EventKey/EVENT_META map in the frontend. A tenant
-- could not define its own trigger.
--
-- This adds an event_definitions registry (mirrors action_definitions) with
-- two kinds:
--   polled  — platform-defined, code-backed: the existing 4, unchanged. Their
--             dispatch_due_triggers branches keep polling exactly as before.
--   emitted — tenant- or platform-defined, data-backed: fired via the new
--             emit_tenant_event() RPC, which inserts the SAME
--             playbook_trigger_fires rows the poller does. Emitted events ride
--             the exact same downstream rails (playbook-execute's dispatch
--             action converts pending_start fires into runs, cooldown/dedup
--             included) — no new run machinery.
--
-- Safe tenant-defined POLLING isn't possible yet (needs arbitrary SQL — unsafe
-- — or Wave 4's generic entity spine), so tenants can only define emitted
-- events. The webhook that fires them authenticates with the existing
-- tenant_api_keys system (verify_tenant_api_key, migration 090) — no new secret.
-- ============================================================

-- 1) Registry table
create table if not exists event_definitions (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null check (scope in ('platform','tenant')),
  tenant_id     uuid references tenants(id) on delete cascade,
  event_key     text not null,
  label         text not null,
  description   text not null default '',
  kind          text not null default 'emitted' check (kind in ('polled','emitted')),
  params_schema jsonb not null default '[]'::jsonb,
  active        boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint event_definitions_scope_tenant_chk check (
    (scope = 'platform' and tenant_id is null) or
    (scope = 'tenant'   and tenant_id is not null)
  )
);

-- One event_key per tenant (and one per platform). Coalesce-unique so the
-- platform rows (tenant_id null) share a namespace without colliding on NULLs.
create unique index if not exists event_definitions_key_uniq
  on event_definitions (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), event_key);

create index if not exists event_definitions_lookup_idx
  on event_definitions (event_key) where active;

alter table event_definitions enable row level security;

drop policy if exists event_definitions_read on event_definitions;
create policy event_definitions_read on event_definitions
  for select using (scope = 'platform' or tenant_id = auth_tenant_id());

drop trigger if exists event_definitions_updated_at on event_definitions;
create trigger event_definitions_updated_at before update on event_definitions
  for each row execute function update_updated_at();

-- 2) Seed the 4 existing events as platform polled rows (their
--    dispatch_due_triggers branches are unchanged). Idempotent.
insert into event_definitions (scope, tenant_id, event_key, label, description, kind, params_schema)
select 'platform', null, v.event_key, v.label, v.description, 'polled', v.params_schema
from (values
  ('invoice_overdue', 'Invoice overdue',
   'Fires for each sent invoice past its due date by N days (default 7).',
   '[{"name":"overdue_days","type":"number","required":false,"help":"Days past due before firing (default 7)"}]'::jsonb),
  ('ticket_synced_high_priority', 'High-priority ticket synced',
   'Fires when a high-priority ticket lands from the Zendesk sync.',
   '[{"name":"priority","type":"string","required":false,"help":"Priority to match (default p1)"}]'::jsonb),
  ('account_at_risk', 'Account flips to at-risk',
   'Fires when an account health score drops it into the at-risk state. Optional minimum ARR filter.',
   '[{"name":"min_arr_cents","type":"number","required":false,"help":"Only fire above this ARR (cents)"}]'::jsonb),
  ('opportunity_won', 'Opportunity won',
   'Fires when an opportunity is closed-won. Optional minimum deal-size filter.',
   '[{"name":"min_amount_cents","type":"number","required":false,"help":"Only fire above this deal size (cents)"}]'::jsonb)
) as v(event_key, label, description, params_schema)
where not exists (
  select 1 from event_definitions e where e.scope = 'platform' and e.event_key = v.event_key
);

-- 3) Drop the frozen CHECK — validation now lives in the create-rule path and
--    emit_tenant_event, which check event_definitions. Existing rules keep
--    working (their keys are the seeded platform rows).
alter table playbook_event_rules drop constraint if exists playbook_event_rules_event_key_check;

-- 4) upsert_event_definition — tenants register their own emitted events.
--    Mirrors upsert_action_definition (035/090): owner/admin gated, tenant
--    scope + emitted kind forced for non-service callers, cross-tenant guard.
create or replace function public.upsert_event_definition(
  p_id uuid, p_scope text, p_tenant_id uuid, p_event_key text,
  p_label text, p_description text, p_kind text, p_params_schema jsonb
) returns event_definitions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row event_definitions;
  v_user uuid := auth.uid();
  v_role text;
  v_is_active boolean;
  v_tenant_check uuid;
  v_existing_tenant uuid;
begin
  if p_scope not in ('platform','tenant') then
    raise exception 'scope must be platform or tenant';
  end if;
  if p_scope = 'tenant' and p_tenant_id is null then
    raise exception 'tenant scope requires tenant_id';
  end if;
  if p_scope = 'platform' and p_tenant_id is not null then
    raise exception 'platform scope must not carry a tenant_id';
  end if;
  if p_kind not in ('polled','emitted') then
    raise exception 'kind must be polled or emitted';
  end if;
  if p_event_key !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'event_key must be lowercase letters, digits and underscores (e.g. deal_signed)';
  end if;

  -- Trusted-server gate: auth.role() is NULL for direct DB connections
  -- (postgres / pg_cron / Management API) and 'service_role' for the
  -- service key — both trusted. Only real PostgREST callers are gated.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if p_scope = 'platform' then
      raise exception 'only the platform (service role) can define platform-scope events';
    end if;
    if p_kind <> 'emitted' then
      raise exception 'tenants can only define emitted events (polled events need platform code)';
    end if;
    select tenant_id, role, coalesce(is_active, true) into v_tenant_check, v_role, v_is_active
      from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can register events';
    end if;
    if p_id is not null then
      select tenant_id into v_existing_tenant from event_definitions where id = p_id;
      if found and v_existing_tenant is distinct from p_tenant_id then
        raise exception 'not authorized to modify this event definition';
      end if;
    end if;
  end if;

  insert into event_definitions (id, scope, tenant_id, event_key, label, description, kind, params_schema, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_scope, p_tenant_id, p_event_key, p_label,
          coalesce(p_description, ''), p_kind, coalesce(p_params_schema, '[]'::jsonb), v_user)
  on conflict (id) do update set
    event_key = excluded.event_key, label = excluded.label, description = excluded.description,
    kind = excluded.kind, params_schema = excluded.params_schema, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function public.upsert_event_definition(uuid, text, uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.upsert_event_definition(uuid, text, uuid, text, text, text, text, jsonb) to authenticated, service_role;

-- 5) emit_tenant_event — the emission core. Inserts the same
--    playbook_trigger_fires rows the poller does, with the identical
--    cooldown/dedup logic (byte-faithful to dispatch_due_triggers), so
--    emitted events become runs on the next dispatch cycle like any other.
--    service_role (webhook + the emit_event playbook step) bypasses the gate;
--    an authenticated caller (manual "Fire event") must be an owner/admin of
--    the tenant.
create or replace function public.emit_tenant_event(
  p_tenant_id uuid,
  p_event_key text,
  p_target_ref text default null,
  p_target_account_id uuid default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_is_active boolean;
  v_tenant_check uuid;
  v_evt event_definitions;
  v_rule record;
  v_recent record;
  v_ref text;
  v_pending integer := 0;
  v_skipped integer := 0;
begin
  -- Trusted-server gate (same as upsert_event_definition above).
  if auth.role() is not null and auth.role() <> 'service_role' then
    select tenant_id, role, coalesce(is_active, true) into v_tenant_check, v_role, v_is_active
      from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can fire events';
    end if;
  end if;

  -- The event must exist for this tenant (own event preferred, else platform)
  -- and be active.
  select * into v_evt from event_definitions
   where event_key = p_event_key and active
     and (scope = 'platform' or tenant_id = p_tenant_id)
   order by (scope = 'tenant') desc
   limit 1;
  if v_evt.id is null then
    return jsonb_build_object('ok', false, 'error', 'event_not_found', 'event_key', p_event_key);
  end if;

  v_ref := coalesce(nullif(p_target_ref, ''), p_target_account_id::text, '');

  for v_rule in
    select r.*, d.status as def_status
    from playbook_event_rules r
    join playbook_definitions d on d.id = r.definition_id
    where r.active and r.tenant_id = p_tenant_id and r.event_key = p_event_key
  loop
    if v_rule.def_status <> 'published' then
      continue;  -- unpublished definition: nothing runnable
    end if;

    -- Cooldown / dedup — identical shape to dispatch_due_triggers.
    select * into v_recent from playbook_trigger_fires
      where event_rule_id = v_rule.id and target_ref = v_ref
        and status in ('pending_start', 'started')
        and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
      order by fired_at desc limit 1;
    if found then
      if not exists (
        select 1 from playbook_trigger_fires
        where event_rule_id = v_rule.id and target_ref = v_ref
          and status = 'skipped_dedup' and fired_at > v_recent.fired_at
      ) then
        insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
        values (p_tenant_id, 'event', v_rule.id, v_rule.definition_id, p_target_account_id, v_ref, 'skipped_dedup',
                format('event "%s" already fired within the %sh cooldown', p_event_key, v_rule.cooldown_hours));
        v_skipped := v_skipped + 1;
      end if;
    else
      insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
      values (p_tenant_id, 'event', v_rule.id, v_rule.definition_id, p_target_account_id, v_ref, 'pending_start',
              format('emitted event "%s"%s', p_event_key,
                     case when p_payload ? 'source' then ' from '||(p_payload->>'source') else '' end));
      update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
      v_pending := v_pending + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'event_key', p_event_key, 'fires_created', v_pending, 'skipped', v_skipped);
end;
$function$;

revoke all on function public.emit_tenant_event(uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function public.emit_tenant_event(uuid, text, text, uuid, jsonb) to authenticated, service_role;
