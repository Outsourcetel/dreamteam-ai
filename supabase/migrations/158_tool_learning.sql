-- ═══════════════════════════════════════════════════════════════
-- 158 — Generalized tool learning (roadmap muscle #2, HIGHEST LEVERAGE)
--
-- A human learns any software from its docs. Today a DE can only use
-- hand-built connectors. This lets a DE LEARN a tool from its API spec:
-- feed an OpenAPI document → the tool-learn edge function generates
-- action_definitions rows (the exact format the executor already runs,
-- via the connector-hub 'template' provider). "Integrated 60 tools"
-- becomes "can learn ANY tool."
--
-- learned_tool_specs records each learned tool; action_definitions gains
-- learned_from_spec_id so generated actions are traceable and a re-learn
-- can replace cleanly. Generated actions are STRUCTURAL — they only
-- actually call out once a connector with a base_url + credentials
-- exists, and connector-hub still enforces isSafeExternalUrl + the
-- destructive/trust/guardrail gates. Learning a tool grants no new reach
-- by itself; it just makes the surface authorable.
--
-- source_kind 'ui_recording' is reserved for the browser/computer-use
-- path (UI-only tools with no API) — that executor is a separate,
-- larger build and is NOT included here (honest scope boundary).
-- ═══════════════════════════════════════════════════════════════

create table if not exists learned_tool_specs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  name            text not null,
  slug            text not null,
  source_kind     text not null default 'openapi'
                    check (source_kind in ('openapi', 'manual', 'ui_recording')),
  base_url        text,
  raw_spec        jsonb,
  operation_count integer not null default 0,
  status          text not null default 'parsed' check (status in ('parsed', 'error')),
  error           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, slug)
);

alter table action_definitions
  add column if not exists learned_from_spec_id uuid references learned_tool_specs(id) on delete set null;

alter table learned_tool_specs enable row level security;
drop policy if exists learned_tool_specs_tenant_read on learned_tool_specs;
create policy learned_tool_specs_tenant_read on learned_tool_specs
  for select using (
    tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform')
  );
