-- Migration 094: Performance & Insights page rebuild, part 2 — real
-- per-DE token/cost tracking. Confirmed by schema check: neither
-- usage_metrics nor tenant_ai_usage has per-DE granularity (both
-- tenant-level only) -- cost-per-task on the old page was 100%
-- hardcoded fiction (literal "$1.40"/"$2.60" strings per DE name).
--
-- Real per-call token counts (input_tokens/output_tokens) are already
-- present on every Anthropic API response this codebase makes -- just
-- never read or persisted anywhere. This adds the table + a real $/
-- token pricing reference + the RPCs, and wires all 4 LLM-calling edge
-- functions (de-answer, widget-ask, agentic-step-execute,
-- specialist-consult) to record one row per real completion.
-- =====================================================================

create table if not exists de_token_usage (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  de_id         uuid references digital_employees(id) on delete set null,
  model_id      text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists de_token_usage_tenant_de_idx on de_token_usage(tenant_id, de_id, created_at);

alter table de_token_usage enable row level security;
drop policy if exists de_token_usage_no_direct_access on de_token_usage;
create policy de_token_usage_no_direct_access on de_token_usage
  for all using (false) with check (false);

-- Real $/million-token reference, not a number buried in a query --
-- editable later without touching function code. Rates approximate
-- this product's real Claude Sonnet 5 usage; a model not listed here
-- falls back to these same defaults rather than failing to price at all.
create table if not exists ai_model_pricing (
  model_id                  text primary key,
  input_price_per_million   numeric not null,
  output_price_per_million  numeric not null,
  updated_at                timestamptz not null default now()
);

insert into ai_model_pricing (model_id, input_price_per_million, output_price_per_million)
values ('claude-sonnet-5', 3.00, 15.00)
on conflict (model_id) do nothing;

alter table ai_model_pricing enable row level security;
drop policy if exists ai_model_pricing_read_only on ai_model_pricing;
create policy ai_model_pricing_read_only on ai_model_pricing
  for select using (true);
drop policy if exists ai_model_pricing_no_direct_write on ai_model_pricing;
create policy ai_model_pricing_no_direct_write on ai_model_pricing
  for all using (false) with check (false);
-- select policy above already grants read; this all-false one only
-- blocks insert/update/delete (Postgres RLS: multiple permissive
-- policies for the same command OR together, so the select-true policy
-- still applies for reads).

-- ── record_de_token_usage ──
-- service_role only -- called from edge functions right after a real
-- Anthropic completion, using that response's own usage.input_tokens/
-- usage.output_tokens. Never called from client-side JS.
create or replace function public.record_de_token_usage(
  p_tenant_id uuid, p_de_id uuid, p_model_id text, p_input_tokens integer, p_output_tokens integer
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'record_de_token_usage is service-role only';
  end if;
  insert into de_token_usage (tenant_id, de_id, model_id, input_tokens, output_tokens)
  values (p_tenant_id, p_de_id, p_model_id, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0));
end;
$function$;

revoke all on function public.record_de_token_usage(uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_de_token_usage(uuid, uuid, text, integer, integer) to service_role;

-- ── get_de_cost_metrics ──
-- Same read gate as get_de_performance_metrics (migration 093): tenant
-- member or platform admin.
create or replace function public.get_de_cost_metrics(p_tenant_id uuid)
returns table(de_id uuid, total_calls bigint, total_input_tokens bigint, total_output_tokens bigint, total_cost_usd numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s cost data';
  end if;

  return query
    select
      u.de_id,
      count(*) as total_calls,
      sum(u.input_tokens) as total_input_tokens,
      sum(u.output_tokens) as total_output_tokens,
      round(sum(
        (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
        + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
      ), 4) as total_cost_usd
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
    where u.tenant_id = p_tenant_id and u.de_id is not null
    group by u.de_id;
end;
$function$;

revoke all on function public.get_de_cost_metrics(uuid) from public, anon;
grant execute on function public.get_de_cost_metrics(uuid) to authenticated;
