-- ═══════════════════════════════════════════════════════════════
-- 163 — Wave 4: DE school / training (#19) + per-role economics &
-- model routing (#20)
--
-- #19 THE SCHOOL: a structured curriculum a customer uses to TEACH a DE
-- its SOPs, tools, policies, and exception drills — and to groom it over
-- time. de_training_modules (curriculum, per-archetype) +
-- de_training_progress (per-DE completion). Content itself rides the
-- existing knowledge ingestion; this is the syllabus + tracking.
--
-- #20 ECONOMICS: the founder pays ~$600/mo per human rep; a DE must beat
-- that, not eat margin on tokens. Two levers:
--   • MODEL ROUTING — use a cheap model for simple work, a strong one for
--     hard work. de_model_routes + resolve_de_model_for_task().
--   • PER-DE BUDGET — a monthly cost ceiling per DE (on top of the
--     tenant-wide check_tenant_ai_budget). check_de_budget().
-- ═══════════════════════════════════════════════════════════════

-- ── #19 training ──────────────────────────────────────────────
create table if not exists de_training_modules (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null default 'platform' check (scope in ('platform', 'tenant')),
  tenant_id     uuid references tenants(id) on delete cascade,
  archetype_key text references role_archetypes(key) on delete cascade,
  module_key    text not null,
  name          text not null,
  kind          text not null default 'knowledge'
                  check (kind in ('sop', 'knowledge', 'tool', 'exception_drill', 'policy', 'org')),
  content       text not null default '',
  required      boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now()
);
-- Uniqueness must tolerate a null tenant_id (platform modules), so it is
-- an expression index (a table UNIQUE constraint can't use coalesce).
create unique index if not exists de_training_modules_uniq
  on de_training_modules (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), archetype_key, module_key);

create table if not exists de_training_progress (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  de_id        uuid not null references digital_employees(id) on delete cascade,
  module_key   text not null,
  status       text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed')),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  unique (de_id, module_key)
);
create index if not exists de_training_progress_de_idx on de_training_progress(de_id, status);

-- Assign the required curriculum for a DE's archetype.
create or replace function public.assign_training_for_de(p_de_id uuid)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_arch text; v_n int;
begin
  select tenant_id, catalog_id into v_tenant, v_arch from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  insert into de_training_progress (tenant_id, de_id, module_key, status)
  select v_tenant, p_de_id, m.module_key, 'assigned'
  from de_training_modules m
  where m.archetype_key = v_arch and m.required
    and (m.scope = 'platform' or m.tenant_id = v_tenant)
  on conflict (de_id, module_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

create or replace function public.mark_training_progress(p_de_id uuid, p_module_key text, p_status text)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into de_training_progress (tenant_id, de_id, module_key, status, completed_at, updated_at)
  select tenant_id, p_de_id, p_module_key, p_status,
         case when p_status = 'completed' then now() end, now()
  from digital_employees where id = p_de_id
  on conflict (de_id, module_key) do update
    set status = excluded.status, completed_at = excluded.completed_at, updated_at = now();
end;
$function$;

-- ── #20 model routing ─────────────────────────────────────────
create table if not exists de_model_routes (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null default 'archetype' check (scope in ('archetype', 'de')),
  archetype_key text references role_archetypes(key) on delete cascade,
  de_id         uuid references digital_employees(id) on delete cascade,
  tenant_id     uuid references tenants(id) on delete cascade,
  task_class    text not null check (task_class in ('simple', 'standard', 'complex', 'escalation')),
  model_id      text not null,
  created_at    timestamptz not null default now()
);
create index if not exists de_model_routes_lookup on de_model_routes(scope, de_id, archetype_key, task_class);

-- Resolve the model for a DE + task class: per-DE route > archetype route
-- > the DE's own model_id > sonnet default. This is the cost lever —
-- simple work can run on Haiku, hard work on Sonnet.
create or replace function public.resolve_de_model_for_task(p_de_id uuid, p_task_class text default 'standard')
returns text language plpgsql stable security definer set search_path to 'public' as $function$
declare v_arch text; v_model text;
begin
  select catalog_id into v_arch from digital_employees where id = p_de_id;
  select model_id into v_model from de_model_routes
    where scope = 'de' and de_id = p_de_id and task_class = p_task_class limit 1;
  if v_model is not null then return v_model; end if;
  select model_id into v_model from de_model_routes
    where scope = 'archetype' and archetype_key = v_arch and task_class = p_task_class limit 1;
  if v_model is not null then return v_model; end if;
  select coalesce(model_id, 'claude-sonnet-5') into v_model from digital_employees where id = p_de_id;
  return coalesce(v_model, 'claude-sonnet-5');
end;
$function$;

-- ── #20 per-DE budget ceiling ─────────────────────────────────
create table if not exists de_budget_policies (
  de_id                 uuid primary key references digital_employees(id) on delete cascade,
  tenant_id             uuid not null references tenants(id) on delete cascade,
  monthly_ceiling_cents bigint not null default 0,   -- 0 = no per-DE ceiling
  updated_at            timestamptz not null default now()
);

create or replace function public.check_de_budget(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_ceiling bigint; v_used numeric;
begin
  select monthly_ceiling_cents into v_ceiling from de_budget_policies where de_id = p_de_id;
  if v_ceiling is null or v_ceiling = 0 then
    return jsonb_build_object('allowed', true, 'ceiling_cents', 0, 'used_cents', 0);
  end if;
  -- Cost this month = tokens x model price (ai_model_pricing is $/1M tok),
  -- converted to cents. Unknown model -> priced at 0 (no false block).
  select coalesce(sum(
           (u.input_tokens::numeric / 1000000) * coalesce(p.input_price_per_million, 0) * 100
         + (u.output_tokens::numeric / 1000000) * coalesce(p.output_price_per_million, 0) * 100
         ), 0)
    into v_used
  from de_token_usage u
  left join ai_model_pricing p on p.model_id = u.model_id
  where u.de_id = p_de_id and u.created_at >= date_trunc('month', now());
  return jsonb_build_object('allowed', v_used < v_ceiling, 'ceiling_cents', v_ceiling, 'used_cents', round(v_used));
end;
$function$;

-- ── seed: Support Agent curriculum + cost-optimized routing ────
insert into de_training_modules (scope, archetype_key, module_key, name, kind, required, sort) values
  ('platform','support_agent','product_kb','Product knowledge base','knowledge',true,1),
  ('platform','support_agent','tone_policy','Tone & escalation policy','policy',true,2),
  ('platform','support_agent','refund_sop','Refund & returns SOP','sop',true,3),
  ('platform','support_agent','frustration_drill','Handling frustrated customers','exception_drill',true,4),
  ('platform','support_agent','org_map','Who to escalate to','org',true,5)
on conflict do nothing;

insert into de_model_routes (scope, archetype_key, task_class, model_id) values
  ('archetype','support_agent','simple','claude-haiku-4-5'),
  ('archetype','support_agent','standard','claude-sonnet-5'),
  ('archetype','support_agent','complex','claude-sonnet-5'),
  ('archetype','support_agent','escalation','claude-sonnet-5')
on conflict do nothing;

-- ── RLS + grants ───────────────────────────────────────────────
alter table de_training_modules  enable row level security;
alter table de_training_progress enable row level security;
alter table de_model_routes      enable row level security;
alter table de_budget_policies   enable row level security;
drop policy if exists de_training_modules_read on de_training_modules;
create policy de_training_modules_read on de_training_modules for select using (
  scope = 'platform' or tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists de_training_progress_read on de_training_progress;
create policy de_training_progress_read on de_training_progress for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists de_model_routes_read on de_model_routes;
create policy de_model_routes_read on de_model_routes for select using (
  scope = 'archetype' or tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists de_budget_policies_read on de_budget_policies;
create policy de_budget_policies_read on de_budget_policies for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

revoke all on function public.assign_training_for_de(uuid) from public, anon;
grant execute on function public.assign_training_for_de(uuid) to authenticated, service_role;
revoke all on function public.mark_training_progress(uuid, text, text) from public, anon;
grant execute on function public.mark_training_progress(uuid, text, text) to authenticated, service_role;
revoke all on function public.resolve_de_model_for_task(uuid, text) from public, anon;
grant execute on function public.resolve_de_model_for_task(uuid, text) to authenticated, service_role;
revoke all on function public.check_de_budget(uuid) from public, anon;
grant execute on function public.check_de_budget(uuid) to authenticated, service_role;
