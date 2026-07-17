-- ═══════════════════════════════════════════════════════════════
-- 159 — Wave 2 senses: perception (#8), safe structured query (#9),
-- channels (#10, #11)
--
-- #8 PERCEPTION: extract-document already turns a PDF/image into text.
-- This adds the STRUCTURED layer a Data-Entry / invoice / medical-coding
-- DE needs: named field templates, extraction results, and a VERIFIED
-- gate — a DE must not act on an extracted number until it is verified
-- (mirrors the compute-receipt principle: never trust an un-checked
-- value). The extraction execution (OCR text -> fields) is the
-- reasoning layer, dormant until ANTHROPIC_API_KEY; the store + gate are
-- real.
--
-- #9 STRUCTURED QUERY: a Business/Data Analyst DE must answer questions
-- from tenant data. We deliberately DO NOT give a model raw SQL. Instead
-- a REGISTRY of vetted, read-only, tenant-scoped analytics FUNCTIONS
-- (no dynamic SQL anywhere) that the DE calls by key. New analytics are
-- added as reviewed functions, not model-authored queries. The NL layer
-- (question -> key + params) is dormant; the safe substrate is real.
--
-- #10/#11 CHANNELS: a per-DE channel registry. chat is active today;
-- email/sms/voice/video are dormant until a provider credential exists
-- (honest — same posture as voice-relay). Video-as-knowledge (#11) is a
-- 'video' channel whose ingestion needs a transcription provider.
-- ═══════════════════════════════════════════════════════════════

-- ── #8 perception ──────────────────────────────────────────────
create table if not exists extraction_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  description text not null default '',
  -- fields: [{ key, label, type, required, hint }]
  fields      jsonb not null default '[]'::jsonb,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists extraction_results (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  template_id  uuid references extraction_templates(id) on delete set null,
  source_kind  text not null default 'document',   -- 'document' | 'media_asset' | 'text'
  source_ref   text,
  extracted    jsonb not null default '{}'::jsonb,  -- field key -> value
  confidence   jsonb not null default '{}'::jsonb,  -- field key -> 0..1
  verified     boolean not null default false,      -- GATE: DE must not act until true
  verified_by  uuid,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists extraction_results_tenant_idx on extraction_results(tenant_id, created_at desc);

-- Verify (or correct) an extraction — the human/high-confidence gate.
create or replace function public.verify_extraction_result(
  p_id uuid, p_corrections jsonb default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null then
    if not exists (select 1 from extraction_results r join profiles p on p.user_id = auth.uid()
                    where r.id = p_id and (p.tenant_id = r.tenant_id or p.layer = 'platform')) then
      raise exception 'not authorized';
    end if;
  end if;
  update extraction_results
     set extracted = coalesce(p_corrections, extracted),
         verified = true, verified_by = auth.uid(), verified_at = now()
   where id = p_id;
end;
$function$;

-- ── #9 safe structured query registry ─────────────────────────
create table if not exists analytics_query_defs (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null default 'platform' check (scope in ('platform', 'tenant')),
  tenant_id    uuid references tenants(id) on delete cascade,
  key          text not null,
  name         text not null,
  description  text not null default '',
  param_schema jsonb not null default '[]'::jsonb,   -- [{name,type,required}]
  builtin      boolean not null default true,         -- maps to a vetted function below
  status       text not null default 'active' check (status in ('active', 'disabled')),
  created_at   timestamptz not null default now(),
  unique (scope, tenant_id, key)
);

-- Two vetted analytics functions — plain SQL, tenant-scoped, NO dynamic
-- SQL, so there is no injection surface at all.
create or replace function public.analytics_de_workload(p_tenant_id uuid, p_de_id uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'objectives_by_status', coalesce((select jsonb_object_agg(status, c) from
       (select status, count(*) c from de_objectives where tenant_id = p_tenant_id and de_id = p_de_id group by status) s), '{}'::jsonb),
    'work_items_by_status', coalesce((select jsonb_object_agg(status, c) from
       (select status, count(*) c from de_work_items where tenant_id = p_tenant_id and de_id = p_de_id group by status) w), '{}'::jsonb)
  );
$function$;

create or replace function public.analytics_action_volume(p_tenant_id uuid, p_days int)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'window_days', p_days,
    'total', (select count(*) from action_executions where tenant_id = p_tenant_id
                and created_at >= now() - make_interval(days => greatest(1, p_days))),
    'by_decision', coalesce((select jsonb_object_agg(decision, c) from
       (select decision, count(*) c from action_executions where tenant_id = p_tenant_id
          and created_at >= now() - make_interval(days => greatest(1, p_days)) group by decision) d), '{}'::jsonb)
  );
$function$;

-- Dispatcher — the ONLY entry point a DE uses. Maps a vetted key to its
-- function; membership-guarded; rejects any unknown key. No SQL is ever
-- built from input.
create or replace function public.run_analytics_query(
  p_tenant_id uuid, p_key text, p_params jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized for this tenant';
  end if;
  return case p_key
    when 'de_workload'   then public.analytics_de_workload(p_tenant_id, (p_params->>'de_id')::uuid)
    when 'action_volume' then public.analytics_action_volume(p_tenant_id, coalesce((p_params->>'days')::int, 30))
    else jsonb_build_object('error', 'unknown_query_key', 'key', p_key)
  end;
end;
$function$;

insert into analytics_query_defs (scope, tenant_id, key, name, description, param_schema) values
  ('platform', null, 'de_workload', 'DE workload',
   'Objective and work-item counts by status for a DE',
   '[{"name":"de_id","type":"uuid","required":true}]'::jsonb),
  ('platform', null, 'action_volume', 'Action volume',
   'Action executions in the last N days, bucketed by decision',
   '[{"name":"days","type":"int","required":false}]'::jsonb)
on conflict (scope, tenant_id, key) do nothing;

-- ── #10/#11 channel registry ───────────────────────────────────
create table if not exists de_channels (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  de_id      uuid not null references digital_employees(id) on delete cascade,
  kind       text not null check (kind in ('chat', 'email', 'sms', 'voice', 'video')),
  status     text not null default 'dormant' check (status in ('active', 'dormant')),
  provider   text,
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, de_id, kind)
);
create index if not exists de_channels_tenant_idx on de_channels(tenant_id, de_id);

-- ── RLS (tenant read; writes via RPC / service role) ───────────
alter table extraction_templates enable row level security;
alter table extraction_results   enable row level security;
alter table analytics_query_defs enable row level security;
alter table de_channels          enable row level security;

drop policy if exists extraction_templates_read on extraction_templates;
create policy extraction_templates_read on extraction_templates for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists extraction_results_read on extraction_results;
create policy extraction_results_read on extraction_results for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
-- analytics_query_defs: platform rows are readable by all signed-in users
-- (a catalog), tenant rows only by that tenant.
drop policy if exists analytics_query_defs_read on analytics_query_defs;
create policy analytics_query_defs_read on analytics_query_defs for select using (
  scope = 'platform'
  or tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists de_channels_read on de_channels;
create policy de_channels_read on de_channels for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

revoke all on function public.verify_extraction_result(uuid, jsonb) from public, anon;
grant execute on function public.verify_extraction_result(uuid, jsonb) to authenticated, service_role;
revoke all on function public.run_analytics_query(uuid, text, jsonb) from public, anon;
grant execute on function public.run_analytics_query(uuid, text, jsonb) to authenticated, service_role;
revoke all on function public.analytics_de_workload(uuid, uuid) from public, anon;
grant execute on function public.analytics_de_workload(uuid, uuid) to authenticated, service_role;
revoke all on function public.analytics_action_volume(uuid, int) from public, anon;
grant execute on function public.analytics_action_volume(uuid, int) to authenticated, service_role;
