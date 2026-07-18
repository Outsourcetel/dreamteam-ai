-- ═══════════════════════════════════════════════════════════════
-- 177 — OTel GenAI trace spans (Frontier-20 #13)
--
-- The 2026 observability bar: agent/LLM activity emitted as OpenTelemetry
-- spans following the GenAI semantic conventions (gen_ai.* attributes),
-- so a customer can pipe DE activity into Datadog/Grafana/Honeycomb next
-- to the rest of their stack.
--
-- Architecture: EMIT now, EXPORT when configured.
--   • otel_spans — the local span store. _shared/otel.ts writes one row
--     per instrumented operation (best-effort: telemetry never breaks the
--     operation it observes). Tenant-readable under RLS — the raw spans
--     double as an honest activity ledger even before any collector.
--   • Export is DORMANT until the founder sets platform_config key
--     'otel_collector_endpoint' (an OTLP/HTTP collector URL). The
--     otel-export fn then ships unexported spans in OTLP JSON and marks
--     them exported. No endpoint → the fn reports itself dormant.
-- ═══════════════════════════════════════════════════════════════

create table if not exists otel_spans (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  trace_id       text not null,   -- 32 lowercase hex chars (OTLP)
  span_id        text not null,   -- 16 lowercase hex chars (OTLP)
  parent_span_id text,
  name           text not null,
  kind           text not null default 'agent' check (kind in ('agent', 'llm', 'tool')),
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  -- gen_ai.* semantic-convention attributes + platform extras
  attributes     jsonb not null default '{}'::jsonb,
  exported       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists otel_spans_tenant_idx on otel_spans (tenant_id, created_at desc);
create index if not exists otel_spans_unexported_idx on otel_spans (created_at) where exported = false;

alter table otel_spans enable row level security;
drop policy if exists otel_spans_read on otel_spans;
create policy otel_spans_read on otel_spans for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- Retention guard: spans are operational telemetry, not records of
-- decision (de_decision_trace and the audit trail own that). Keep 30 days.
create or replace function public.prune_otel_spans()
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_n integer;
begin
  delete from otel_spans where created_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.prune_otel_spans() from public, anon, authenticated;
grant execute on function public.prune_otel_spans() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'otel-spans-prune') then
    perform cron.unschedule('otel-spans-prune');
  end if;
  perform cron.schedule('otel-spans-prune', '23 3 * * *', 'select public.prune_otel_spans()');
end $$;
