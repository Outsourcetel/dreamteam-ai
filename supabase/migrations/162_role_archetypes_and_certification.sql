-- ═══════════════════════════════════════════════════════════════
-- 162 — Wave 4: role archetypes (#17) + competency certification (#18)
--
-- #17 ROLE ARCHETYPES: a "ready-to-go DE" is a PACKAGE — persona +
-- responsibilities + required capabilities/connectors + recommended
-- model + compliance packs + which eval suite certifies it. role_archetypes
-- is that catalog; instantiate_role_archetype "hires" a DE from one.
--
-- #18 CERTIFICATION (the credibility firewall): a DE must PASS its role's
-- golden-task eval before it can go customer-facing. role_certifications
-- records the pass/fail (read from a real eval_runs result); a trigger
-- BLOCKS the transition into a customer-facing lifecycle stage
-- (certified/published/assigned/active) unless a passing certification
-- exists. Enforced in Postgres — not UI convention. The gate fires only
-- on the TRANSITION in, so existing active DEs are never retroactively
-- broken.
-- ═══════════════════════════════════════════════════════════════

create table if not exists role_archetypes (
  key                           text primary key,
  name                          text not null,
  domain                        text not null,
  description                   text not null default '',
  persona_preamble              text not null default '',
  responsibilities              text[] not null default '{}',
  required_capabilities         text[] not null default '{}',
  required_connector_categories text[] not null default '{}',
  recommended_model             text not null default 'claude-sonnet-5',
  compliance_pack_keys          text[] not null default '{}',   -- auto-attached on instantiate
  knowledge_scaffold            jsonb not null default '[]'::jsonb,  -- suggested doc topics
  eval_category                 text,                            -- golden_qa.category that certifies it
  pass_threshold_pct            integer not null default 80,
  status                        text not null default 'active' check (status in ('active', 'draft')),
  created_at                    timestamptz not null default now()
);

create table if not exists role_certifications (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  de_id          uuid not null references digital_employees(id) on delete cascade,
  archetype_key  text references role_archetypes(key) on delete set null,
  eval_run_id    uuid references eval_runs(id) on delete set null,
  score_pct      numeric not null default 0,
  threshold_pct  integer not null default 80,
  status         text not null default 'pending' check (status in ('pending', 'passed', 'failed')),
  evaluated_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists role_certifications_de_idx on role_certifications(de_id, status);

alter table role_archetypes     enable row level security;
alter table role_certifications enable row level security;
drop policy if exists role_archetypes_read on role_archetypes;
create policy role_archetypes_read on role_archetypes for select using (auth.uid() is not null);
drop policy if exists role_certifications_read on role_certifications;
create policy role_certifications_read on role_certifications for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── instantiate: hire a DE from an archetype ──
create or replace function public.instantiate_role_archetype(
  p_tenant_id uuid, p_archetype_key text, p_de_name text, p_persona_name text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare a role_archetypes; v_de uuid; v_pack text;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to hire a DE for this tenant';
  end if;
  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  insert into digital_employees (tenant_id, name, persona_name, description, category, department,
    lifecycle_status, trust_level, status, capabilities, responsibilities, model_provider, model_id, catalog_id)
  values (p_tenant_id, p_de_name, p_persona_name, a.description, 'Customer', a.domain,
    'designed', 'supervised', 'idle', a.required_capabilities, a.responsibilities, 'anthropic', a.recommended_model, a.key)
  returning id into v_de;

  -- Auto-attach the archetype's mandatory compliance packs.
  foreach v_pack in array a.compliance_pack_keys loop
    perform public.attach_compliance_pack(p_tenant_id, v_pack);
  end loop;

  return v_de;
end;
$function$;

-- ── certify from a real eval run ──
create or replace function public.certify_de_from_eval(
  p_de_id uuid, p_archetype_key text, p_eval_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select total, passed into v_total, v_passed from eval_runs where id = p_eval_run_id and tenant_id = v_tenant;
  if v_total is null or v_total = 0 then raise exception 'eval run has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= p_threshold_pct then 'passed' else 'failed' end;

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at)
  values (v_tenant, p_de_id, p_archetype_key, p_eval_run_id, v_pct, p_threshold_pct, v_status, now());

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', p_threshold_pct, 'passed', v_passed, 'total', v_total);
end;
$function$;

-- ── the gate: block going customer-facing without a passing cert ──
create or replace function public.gate_de_certification() returns trigger
language plpgsql as $function$
declare v_gated text[] := array['certified','published','assigned','active'];
begin
  -- Only fire on the TRANSITION into a gated stage (so existing active
  -- DEs and no-op updates are unaffected).
  if NEW.lifecycle_status = any(v_gated) and OLD.lifecycle_status is distinct from NEW.lifecycle_status
     and OLD.lifecycle_status <> all(v_gated) then
    if not exists (select 1 from role_certifications c where c.de_id = NEW.id and c.status = 'passed') then
      raise exception 'DE % cannot advance to "%": it has not passed role certification. Run its eval suite and certify it first.', NEW.id, NEW.lifecycle_status;
    end if;
  end if;
  return NEW;
end;
$function$;
drop trigger if exists trg_gate_de_certification on digital_employees;
create trigger trg_gate_de_certification
  before update of lifecycle_status on digital_employees
  for each row execute function public.gate_de_certification();

-- ── seed: Support Agent archetype (the near-term role to prove first) ──
insert into role_archetypes (key, name, domain, description, persona_preamble, responsibilities,
  required_capabilities, required_connector_categories, recommended_model, compliance_pack_keys,
  knowledge_scaffold, eval_category, pass_threshold_pct)
values (
  'support_agent', 'Support Agent', 'customer_support',
  'Answers customer questions grounded in the knowledge base, escalates what it cannot resolve, and logs every interaction.',
  'You are a customer support specialist. Answer only from the knowledge base, cite your sources, be warm and concise, and escalate anything you are unsure about.',
  array['Answer customer questions from the knowledge base','Escalate issues beyond policy or knowledge','Log and summarize every interaction','Detect and flag frustrated customers'],
  array['knowledge_retrieval','ticketing','escalation'],
  array['helpdesk','knowledge_base'],
  'claude-sonnet-5', array[]::text[],
  '["Product FAQ","Troubleshooting guides","Refund & returns policy","Escalation matrix","Account & billing basics"]'::jsonb,
  'support', 80
) on conflict (key) do nothing;

revoke all on function public.instantiate_role_archetype(uuid, text, text, text) from public, anon;
grant execute on function public.instantiate_role_archetype(uuid, text, text, text) to authenticated, service_role;
revoke all on function public.certify_de_from_eval(uuid, text, uuid, integer) from public, anon;
grant execute on function public.certify_de_from_eval(uuid, text, uuid, integer) to authenticated, service_role;
