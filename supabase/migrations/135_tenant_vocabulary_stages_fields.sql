-- ============================================================
-- Wave 4 — Configure & relabel: tenant vocabulary, configurable
-- pipeline stages, custom entity fields.
--
-- Founder-approved architecture (over a speculative generic-entity
-- rebuild): keep the proven work-object tables, add a per-tenant
-- configuration layer that removes the B2B-SaaS hardcoding a tenant
-- actually sees — the served-party noun ("Customers" → Patients /
-- Clients / Orders…), the value metric ("ARR" → whatever they call
-- it), the pipeline stage names, and extra fields on the served-party
-- record. All industry-template-seedable. The full entity-spine
-- rebuild waits for real non-SaaS tenant evidence (4 of the 5 tables
-- have zero inbound FKs, so they migrate cheaply when that day comes).
-- ============================================================

-- ── 1) Tenant vocabulary ────────────────────────────────────────
alter table tenants
  add column if not exists vocabulary jsonb not null default '{}'::jsonb;

-- update_tenant_general_settings recreated from its LIVE body
-- (pg_get_functiondef) with one addition: a trailing p_vocabulary
-- param, applied only when non-null so every existing caller is
-- untouched. Shallow-validated: must be a jsonb object.
create or replace function public.update_tenant_general_settings(
  p_tenant_id uuid, p_name text, p_industry text, p_accent_color text,
  p_vocabulary jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_caller_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.manage');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s settings cannot be changed';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'organization name is required';
  end if;
  if p_vocabulary is not null and jsonb_typeof(p_vocabulary) <> 'object' then
    raise exception 'vocabulary must be a JSON object';
  end if;

  if not v_is_platform then
    select tenant_id, role, coalesce(is_active, true) into v_caller_tenant, v_role, v_is_active
    from profiles where user_id = auth.uid();

    if v_caller_tenant is distinct from p_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only an owner or admin of this organization may change these settings';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
  end if;

  update tenants
  set name = btrim(p_name), industry = nullif(btrim(coalesce(p_industry, '')), ''),
      accent_color = p_accent_color,
      vocabulary = coalesce(p_vocabulary, vocabulary),
      updated_at = now()
  where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id);
end;
$function$;

-- The 4-arg overload is superseded by the 5-arg one (defaulted param);
-- drop the old signature so PostgREST doesn't see an ambiguous pair.
drop function if exists public.update_tenant_general_settings(uuid, text, text, text);

revoke all on function public.update_tenant_general_settings(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.update_tenant_general_settings(uuid, text, text, text, jsonb) to authenticated, service_role;

-- ── 2) Configurable pipeline stages ─────────────────────────────
-- The OPEN stages a tenant's pipeline moves through, ordered. 'won'
-- and 'lost' remain fixed terminal semantics (close RPCs, win-rate,
-- the opportunity_won polled event) and may not be redefined. A
-- tenant with no rows here uses the platform default four — no
-- provisioning-contract change needed, nothing breaks for existing
-- tenants.
create table if not exists tenant_pipeline_stages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  stage_key  text not null,
  label      text not null,
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, stage_key)
);

create index if not exists tenant_pipeline_stages_tenant_idx
  on tenant_pipeline_stages(tenant_id, position);

alter table tenant_pipeline_stages enable row level security;

drop policy if exists tenant_pipeline_stages_read on tenant_pipeline_stages;
create policy tenant_pipeline_stages_read on tenant_pipeline_stages
  for select using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- Replace-all write RPC (owner/admin). Refuses to drop a stage that
-- open opportunities still sit in — honest error, never silent data
-- stranding.
create or replace function public.set_pipeline_stages(p_stages jsonb)
returns setof tenant_pipeline_stages
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_stage record;
  v_keys text[] := '{}';
  v_pos integer := 0;
  v_orphan record;
begin
  -- Trusted-server gate (migration-125 pattern).
  if auth.role() is not null and auth.role() <> 'service_role' then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active
      from profiles where user_id = v_user;
    if v_tenant is null then raise exception 'not a member of any tenant'; end if;
    if not v_is_active then raise exception 'account is deactivated'; end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can change pipeline stages';
    end if;
  else
    raise exception 'set_pipeline_stages requires an authenticated tenant caller';
  end if;

  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) < 1 then
    raise exception 'stages must be a non-empty array of {key, label}';
  end if;
  if jsonb_array_length(p_stages) > 12 then
    raise exception 'at most 12 pipeline stages';
  end if;

  for v_stage in select * from jsonb_to_recordset(p_stages) as x(key text, label text) loop
    if v_stage.key is null or v_stage.key !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'stage key "%" must be lowercase letters/digits/underscores', coalesce(v_stage.key, '(null)');
    end if;
    if v_stage.key in ('won', 'lost') then
      raise exception '"won" and "lost" are fixed terminal stages and cannot be redefined';
    end if;
    if coalesce(btrim(v_stage.label), '') = '' then
      raise exception 'stage "%" needs a label', v_stage.key;
    end if;
    if v_stage.key = any(v_keys) then
      raise exception 'duplicate stage key "%"', v_stage.key;
    end if;
    v_keys := array_append(v_keys, v_stage.key);
  end loop;

  -- No open opportunity may be left in a stage that no longer exists.
  select o.stage, count(*) as n into v_orphan
  from opportunities o
  where o.tenant_id = v_tenant
    and o.stage not in ('won', 'lost')
    and not (o.stage = any(v_keys))
  group by o.stage limit 1;
  if found then
    raise exception 'cannot remove stage "%" — % open opportunity(ies) still in it; move them first',
      v_orphan.stage, v_orphan.n;
  end if;

  delete from tenant_pipeline_stages where tenant_id = v_tenant;
  for v_stage in select * from jsonb_to_recordset(p_stages) as x(key text, label text) loop
    v_pos := v_pos + 1;
    insert into tenant_pipeline_stages (tenant_id, stage_key, label, position)
    values (v_tenant, v_stage.key, btrim(v_stage.label), v_pos);
  end loop;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Pipeline stages updated — %s', array_to_string(v_keys, ' → ')),
    'config_change',
    jsonb_build_object('kind', 'pipeline_stages', 'stages', p_stages));

  return query select * from tenant_pipeline_stages where tenant_id = v_tenant order by position;
end;
$function$;

revoke all on function public.set_pipeline_stages(jsonb) from public, anon;
grant execute on function public.set_pipeline_stages(jsonb) to authenticated, service_role;

-- ── 3) Stage validation moves from the frozen CHECK to the guard ──
alter table opportunities drop constraint if exists opportunities_stage_check;

-- opportunities_stage_guard recreated from its LIVE body with ONE
-- addition at the top of each path: the stage must be 'won'/'lost'
-- or a stage this tenant has configured (default four when the
-- tenant has no custom rows). Everything else is byte-identical.
create or replace function public.opportunities_stage_guard()
returns trigger
language plpgsql
as $function$
declare
  v_via_rpc boolean := coalesce(current_setting('dreamteam.opp_close', true), '') = 'on';
  v_stage_ok boolean;
begin
  -- Wave 4: data-driven stage validation (replaces the dropped CHECK).
  if new.stage not in ('won', 'lost') then
    select case
      when exists (select 1 from tenant_pipeline_stages t where t.tenant_id = new.tenant_id)
        then exists (select 1 from tenant_pipeline_stages t
                     where t.tenant_id = new.tenant_id and t.stage_key = new.stage)
      else new.stage in ('prospect', 'qualified', 'proposal', 'negotiation')
    end into v_stage_ok;
    if not v_stage_ok then
      raise exception 'unknown pipeline stage "%" — configure stages under Sales settings', new.stage;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.stage in ('won', 'lost') then
      raise exception 'opportunities cannot be created already closed';
    end if;
    new.stage_history := jsonb_build_array(jsonb_build_object(
      'stage', new.stage, 'at', now(), 'by', coalesce(auth.uid()::text, 'system')));
    return new;
  end if;

  if new.stage <> old.stage then
    if old.stage in ('won', 'lost') then
      raise exception 'closed opportunities cannot change stage';
    end if;
    if new.stage in ('won', 'lost') and not v_via_rpc then
      raise exception 'won/lost only via close_opportunity_won / close_opportunity_lost';
    end if;
    if new.stage = 'lost' and coalesce(trim(new.lost_reason), '') = '' then
      raise exception 'lost requires a reason';
    end if;
    new.stage_history := coalesce(old.stage_history, '[]'::jsonb)
      || jsonb_build_object('stage', new.stage, 'at', now(), 'by', coalesce(auth.uid()::text, 'system'));
    if new.stage in ('won', 'lost') then
      new.closed_at := now();
      perform append_audit_event_internal(
        new.tenant_id, 'You', 'human',
        format('Opportunity %s — %s%s', case new.stage when 'won' then 'WON' else 'lost' end,
               new.name,
               case when new.stage = 'lost' then format(' (reason: %s)', new.lost_reason)
                    when new.amount_cents is not null then format(' ($%s)', round(new.amount_cents / 100.0)) else '' end),
        'config_change',
        jsonb_build_object('kind', 'opportunity_closed', 'opportunity_id', new.id,
                           'stage', new.stage, 'amount_cents', new.amount_cents,
                           'lost_reason', new.lost_reason, 'account_id', new.account_id));
    end if;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (new.tenant_id, new.account_id, 'You', 'human',
            case when new.stage = 'lost' then 'escalated' else 'config_change' end,
            format('Opportunity %s → %s', new.name, new.stage));
  end if;
  return new;
end;
$function$;

-- ── 4) Custom fields on the served-party record ────────────────
alter table customer_accounts
  add column if not exists attributes jsonb not null default '{}'::jsonb;

-- Field definitions (what the extra fields ARE) — tenant-editable,
-- industry-template-seedable. Values live in customer_accounts.attributes
-- keyed by field_key.
create table if not exists tenant_entity_fields (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  field_key  text not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date')),
  position   integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, field_key)
);

create index if not exists tenant_entity_fields_tenant_idx
  on tenant_entity_fields(tenant_id, position);

alter table tenant_entity_fields enable row level security;

-- Same tenant-isolation write pattern as guardrail_rules (015).
drop policy if exists tenant_entity_fields_isolation on tenant_entity_fields;
create policy tenant_entity_fields_isolation on tenant_entity_fields
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
