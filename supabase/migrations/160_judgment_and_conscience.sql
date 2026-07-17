-- ═══════════════════════════════════════════════════════════════
-- 160 — Wave 3: judgment & conscience (#12-16)
--
-- #12 EXCEPTIONS: a human employee recognizes an edge case, proposes a
--   deviation WITH justification, gets it approved, and learns the
--   resolution. de_exceptions captures that loop inside guardrails.
-- #13 DECISION TRACE: an inspectable "why did it do that" — required
--   before any finance/medical role earns trust. de_decision_trace.
-- #14 COMPLIANCE PACKS: HIPAA / TCPA-DNC / financial-controls as
--   UN-TOGGLEABLE guardrail bundles. Attaching a pack materializes real
--   guardrail_rules tagged with the pack; a tamper-guard trigger blocks
--   disabling or deleting them except through a proper pack detach. This
--   is the North-Star "un-toggleable guardrail" made literal.
-- #15 ESCALATION QUALITY: SLA + routing + handoff summary on human_tasks.
-- #16 MULTI-HOP CONSULT: bound DE-to-DE consultation by depth + cycle,
--   on top of the existing single-hop allow-list (de_consultation_grants).
-- ═══════════════════════════════════════════════════════════════

-- ── #12 exceptions ─────────────────────────────────────────────
create table if not exists de_exceptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  de_id         uuid not null references digital_employees(id) on delete cascade,
  objective_id  uuid references de_objectives(id) on delete set null,
  work_item_id  uuid references de_work_items(id) on delete set null,
  situation     text not null,
  proposed_action text not null default '',
  justification text not null default '',
  status        text not null default 'proposed'
                  check (status in ('proposed', 'approved', 'denied', 'auto_resolved')),
  decided_by    uuid,
  decided_at    timestamptz,
  learned       boolean not null default false,
  outcome       text,
  created_at    timestamptz not null default now()
);
create index if not exists de_exceptions_tenant_idx on de_exceptions(tenant_id, de_id, status);

create or replace function public.resolve_de_exception(
  p_id uuid, p_status text, p_outcome text default null, p_learned boolean default false
) returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null and not exists (
      select 1 from de_exceptions e join profiles p on p.user_id = auth.uid()
      where e.id = p_id and (p.tenant_id = e.tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized';
  end if;
  update de_exceptions
     set status = p_status, outcome = p_outcome, learned = coalesce(p_learned, false),
         decided_by = auth.uid(), decided_at = now()
   where id = p_id;
end;
$function$;

-- ── #13 decision trace ─────────────────────────────────────────
create table if not exists de_decision_trace (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  de_id      uuid references digital_employees(id) on delete set null,
  run_kind   text not null default 'agentic' check (run_kind in ('agentic', 'work_item', 'answer', 'consult')),
  run_ref    text,
  seq        integer not null default 0,
  thought    text,
  tool       text,
  inputs     jsonb,
  outputs    jsonb,
  rationale  text,
  created_at timestamptz not null default now()
);
create index if not exists de_decision_trace_run_idx on de_decision_trace(tenant_id, run_kind, run_ref, seq);

-- ── #14 compliance packs ───────────────────────────────────────
alter table guardrail_rules add column if not exists compliance_pack_key text;

create table if not exists compliance_packs (
  key         text primary key,
  name        text not null,
  domain      text not null,
  description text not null default '',
  mandatory   boolean not null default true,   -- un-toggleable once attached
  created_at  timestamptz not null default now()
);
create table if not exists compliance_pack_rules (
  id        uuid primary key default gen_random_uuid(),
  pack_key  text not null references compliance_packs(key) on delete cascade,
  rule_type text not null,
  rule      text not null,
  pattern   text,
  severity  text not null default 'blocking'
);
create table if not exists tenant_compliance_packs (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  pack_key    text not null references compliance_packs(key) on delete cascade,
  attached_by uuid,
  attached_at timestamptz not null default now(),
  primary key (tenant_id, pack_key)
);

-- Tamper guard: a compliance-tagged guardrail cannot be disabled or
-- deleted directly. Only the detach RPC (which sets a txn-local flag)
-- may remove them — so "un-toggleable" is actually enforced in the DB,
-- not just UI convention.
create or replace function public.guard_compliance_guardrails() returns trigger
language plpgsql as $function$
begin
  if (TG_OP = 'DELETE' and OLD.compliance_pack_key is not null)
     or (TG_OP = 'UPDATE' and OLD.compliance_pack_key is not null and NEW.active = false) then
    if coalesce(current_setting('app.allow_compliance_change', true), '') <> 'on' then
      raise exception 'compliance guardrail (%): cannot be disabled or deleted — detach the pack instead', OLD.compliance_pack_key;
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$function$;
drop trigger if exists trg_guard_compliance_guardrails on guardrail_rules;
create trigger trg_guard_compliance_guardrails
  before update or delete on guardrail_rules
  for each row execute function public.guard_compliance_guardrails();

create or replace function public.attach_compliance_pack(p_tenant_id uuid, p_pack_key text)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_count int := 0;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin')))) then
    raise exception 'only an owner/admin (or platform) can attach a compliance pack';
  end if;
  insert into tenant_compliance_packs(tenant_id, pack_key, attached_by)
    values (p_tenant_id, p_pack_key, auth.uid()) on conflict do nothing;
  -- Materialize the pack's rules as real guardrail_rules (skip ones
  -- already materialized for this tenant+pack).
  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active, compliance_pack_key)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, 'all', r.severity, true, r.pack_key
  from compliance_pack_rules r
  where r.pack_key = p_pack_key
    and not exists (select 1 from guardrail_rules g
                    where g.tenant_id = p_tenant_id and g.compliance_pack_key = r.pack_key and g.rule = r.rule);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function public.detach_compliance_pack(p_tenant_id uuid, p_pack_key text)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = p_tenant_id and p.role in ('tenant_owner','tenant_admin')))) then
    raise exception 'only an owner/admin (or platform) can detach a compliance pack';
  end if;
  perform set_config('app.allow_compliance_change', 'on', true);  -- txn-local; lets the trigger permit these deletes
  delete from guardrail_rules where tenant_id = p_tenant_id and compliance_pack_key = p_pack_key;
  delete from tenant_compliance_packs where tenant_id = p_tenant_id and pack_key = p_pack_key;
end;
$function$;

-- Seed starter packs (illustrative rules — real packs get fleshed out
-- with counsel; these prove the mechanism and give sane defaults).
insert into compliance_packs(key, name, domain, description) values
  ('hipaa', 'HIPAA (US Health)', 'healthcare', 'Protects PHI; blocks unauthorized disclosure and non-minimum-necessary sharing.'),
  ('tcpa_dnc', 'TCPA / Do-Not-Call', 'outbound_comms', 'US outbound calling/texting: consent, DNC registry, permitted hours.'),
  ('financial_controls', 'Financial Controls', 'finance', 'Segregation of duties: no fund movement or payment approval without authorization.')
on conflict (key) do nothing;

insert into compliance_pack_rules(pack_key, rule_type, rule, pattern, severity) values
  ('hipaa', 'blocked_topic', 'Do not disclose protected health information (PHI) without verified authorization', 'disclose phi|share medical record|patient record without', 'blocking'),
  ('hipaa', 'blocked_topic', 'Do not share more health information than the minimum necessary', 'full medical history|entire chart', 'blocking'),
  ('tcpa_dnc', 'blocked_topic', 'Do not contact numbers on the Do-Not-Call registry or without consent', 'ignore do-not-call|call anyway|no consent needed', 'blocking'),
  ('tcpa_dnc', 'blocked_topic', 'Do not place outbound calls outside legally permitted hours', 'call after hours|call at night|before 8am|after 9pm', 'blocking'),
  ('financial_controls', 'blocked_topic', 'Do not approve a payment or move funds without required authorization', 'approve payment without|move funds without approval|skip approval', 'blocking'),
  ('financial_controls', 'blocked_topic', 'Do not bypass segregation of duties on financial transactions', 'both approve and pay|single-person approval', 'blocking')
on conflict do nothing;

-- ── #15 escalation quality ─────────────────────────────────────
alter table human_tasks
  add column if not exists sla_due_at      timestamptz,
  add column if not exists assigned_role    text,
  add column if not exists assigned_user_id uuid,
  add column if not exists priority         text not null default 'normal',
  add column if not exists handoff_summary  text;

-- ── #16 multi-hop consultation bound ───────────────────────────
alter table spec_consultations
  add column if not exists depth integer not null default 0,
  add column if not exists path  uuid[] not null default '{}'::uuid[];

-- Guard: on top of the single-hop allow-list, bound the chain by depth
-- and forbid cycles. Returns a decision + the path to carry forward.
create or replace function public.can_consult_multihop(
  p_tenant_id uuid, p_requester_de uuid, p_target_de uuid,
  p_path uuid[] default '{}'::uuid[], p_max_depth int default 2
) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if p_target_de = any(p_path) or p_target_de = p_requester_de then
    return jsonb_build_object('allowed', false, 'reason', 'cycle');
  end if;
  if coalesce(array_length(p_path, 1), 0) >= p_max_depth then
    return jsonb_build_object('allowed', false, 'reason', 'max_depth');
  end if;
  if not exists (
      select 1 from de_consultation_grants g
      where g.tenant_id = p_tenant_id and g.requester_de_id = p_requester_de
        and g.target_de_id = p_target_de and g.active) then
    return jsonb_build_object('allowed', false, 'reason', 'no_grant');
  end if;
  return jsonb_build_object('allowed', true, 'next_path', (p_path || p_requester_de));
end;
$function$;

-- ── RLS + grants ───────────────────────────────────────────────
alter table de_exceptions       enable row level security;
alter table de_decision_trace   enable row level security;
alter table compliance_packs    enable row level security;
alter table compliance_pack_rules enable row level security;
alter table tenant_compliance_packs enable row level security;

drop policy if exists de_exceptions_read on de_exceptions;
create policy de_exceptions_read on de_exceptions for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists de_decision_trace_read on de_decision_trace;
create policy de_decision_trace_read on de_decision_trace for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
-- compliance packs + their rules are a public catalog (read-only to all
-- signed-in users); the tenant-attachment table is tenant-scoped.
drop policy if exists compliance_packs_read on compliance_packs;
create policy compliance_packs_read on compliance_packs for select using (auth.uid() is not null);
drop policy if exists compliance_pack_rules_read on compliance_pack_rules;
create policy compliance_pack_rules_read on compliance_pack_rules for select using (auth.uid() is not null);
drop policy if exists tenant_compliance_packs_read on tenant_compliance_packs;
create policy tenant_compliance_packs_read on tenant_compliance_packs for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

revoke all on function public.resolve_de_exception(uuid, text, text, boolean) from public, anon;
grant execute on function public.resolve_de_exception(uuid, text, text, boolean) to authenticated, service_role;
revoke all on function public.attach_compliance_pack(uuid, text) from public, anon;
grant execute on function public.attach_compliance_pack(uuid, text) to authenticated, service_role;
revoke all on function public.detach_compliance_pack(uuid, text) from public, anon;
grant execute on function public.detach_compliance_pack(uuid, text) to authenticated, service_role;
revoke all on function public.can_consult_multihop(uuid, uuid, uuid, uuid[], int) from public, anon;
grant execute on function public.can_consult_multihop(uuid, uuid, uuid, uuid[], int) to authenticated, service_role;
