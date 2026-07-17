-- ═══════════════════════════════════════════════════════════════
-- 175 — Outcome-priced metering rails (Frontier-20 #15)
--
-- The 2026 pricing bar is per-RESOLUTION ($0.50–$2.00, Fin at $0.99):
-- customers pay when the AI actually resolves something, and escalations
-- to humans are FREE. These are the rails + honest consumption
-- visibility — NOT billing execution (no invoicing/payments; PCI is
-- founder-deferred). Every number shown is derivable from raw rows.
--
--   • billable_outcomes — one row per metered outcome. Idempotent by
--     construction: at most ONE resolution and ONE escalation per
--     conversation (partial unique indexes), so retries/replays can
--     never double-charge.
--   • tenant_outcome_pricing — per-tenant price; default 99¢ if unset.
--   • record_billable_outcome — the ONLY write path (service role, called
--     by the answer fabric). Escalations always price at 0.
--   • get_outcome_metering — the dashboard read: totals, per-DE, per-day.
-- ═══════════════════════════════════════════════════════════════

create table if not exists tenant_outcome_pricing (
  tenant_id                  uuid primary key references tenants(id) on delete cascade,
  price_per_resolution_cents integer not null default 99 check (price_per_resolution_cents between 0 and 100000),
  currency                   text not null default 'usd',
  updated_at                 timestamptz not null default now()
);
alter table tenant_outcome_pricing enable row level security;
drop policy if exists outcome_pricing_read on tenant_outcome_pricing;
create policy outcome_pricing_read on tenant_outcome_pricing for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

create table if not exists billable_outcomes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  de_id            uuid references digital_employees(id) on delete set null,
  conversation_id  uuid not null,
  kind             text not null check (kind in ('resolution', 'escalation')),
  source           text not null default 'chat' check (source in ('chat', 'widget', 'a2a', 'orchestrate')),
  billable         boolean not null,
  unit_price_cents integer not null default 0,
  occurred_at      timestamptz not null default now()
);
-- Idempotency: one resolution + one escalation max per conversation.
create unique index if not exists billable_outcomes_res_uniq
  on billable_outcomes (conversation_id) where kind = 'resolution';
create unique index if not exists billable_outcomes_esc_uniq
  on billable_outcomes (conversation_id) where kind = 'escalation';
create index if not exists billable_outcomes_tenant_idx
  on billable_outcomes (tenant_id, occurred_at desc);

alter table billable_outcomes enable row level security;
drop policy if exists billable_outcomes_read on billable_outcomes;
create policy billable_outcomes_read on billable_outcomes for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── the ONLY write path ──
create or replace function public.record_billable_outcome(
  p_tenant_id uuid, p_de_id uuid, p_conversation_id uuid, p_kind text, p_source text default 'chat'
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_price integer := 0; v_billable boolean := false; v_id uuid;
begin
  if p_kind not in ('resolution', 'escalation') then raise exception 'kind must be resolution|escalation'; end if;
  if p_conversation_id is null then return jsonb_build_object('recorded', false, 'reason', 'no_conversation'); end if;

  if p_kind = 'resolution' then
    select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
      into v_price;
    v_billable := true;
  end if;  -- escalations: billable=false, price 0 — humans are free.

  insert into billable_outcomes (tenant_id, de_id, conversation_id, kind, source, billable, unit_price_cents)
  values (p_tenant_id, p_de_id, p_conversation_id, p_kind,
          case when p_source in ('chat','widget','a2a','orchestrate') then p_source else 'chat' end,
          v_billable, v_price)
  on conflict do nothing
  returning id into v_id;

  return jsonb_build_object('recorded', v_id is not null, 'billable', v_billable, 'unit_price_cents', v_price);
end;
$function$;
revoke all on function public.record_billable_outcome(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_billable_outcome(uuid, uuid, uuid, text, text) to service_role;

-- ── the dashboard read ──
create or replace function public.get_outcome_metering(
  p_tenant_id uuid, p_from timestamptz default now() - interval '30 days', p_to timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path to 'public' stable as $function$
declare v_totals jsonb; v_by_de jsonb; v_by_day jsonb; v_price integer;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
    into v_price;

  select jsonb_build_object(
    'resolutions', count(*) filter (where kind = 'resolution'),
    'escalations', count(*) filter (where kind = 'escalation'),
    'billable_amount_cents', coalesce(sum(unit_price_cents) filter (where billable), 0))
    into v_totals
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at between p_from and p_to;

  select coalesce(jsonb_agg(row_de order by (row_de->>'amount_cents')::bigint desc), '[]'::jsonb) into v_by_de
  from (
    select jsonb_build_object(
      'de_id', b.de_id,
      'name', coalesce(max(d.persona_name), max(d.name), 'Unknown'),
      'resolutions', count(*) filter (where b.kind = 'resolution'),
      'escalations', count(*) filter (where b.kind = 'escalation'),
      'amount_cents', coalesce(sum(b.unit_price_cents) filter (where b.billable), 0)) as row_de
    from billable_outcomes b
    left join digital_employees d on d.id = b.de_id
    where b.tenant_id = p_tenant_id and b.occurred_at between p_from and p_to
    group by b.de_id
  ) s;

  select coalesce(jsonb_agg(row_day order by row_day->>'day'), '[]'::jsonb) into v_by_day
  from (
    select jsonb_build_object(
      'day', day_key,
      'resolutions', count(*) filter (where kind = 'resolution'),
      'escalations', count(*) filter (where kind = 'escalation')) as row_day
    from (
      select to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day_key, kind
      from billable_outcomes
      where tenant_id = p_tenant_id and occurred_at between p_from and p_to
    ) raw
    group by day_key
  ) s;

  return jsonb_build_object('totals', v_totals, 'by_de', v_by_de, 'by_day', v_by_day,
                            'price_per_resolution_cents', v_price);
end;
$function$;
revoke all on function public.get_outcome_metering(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_outcome_metering(uuid, timestamptz, timestamptz) to authenticated, service_role;
