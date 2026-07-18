-- ═══════════════════════════════════════════════════════════════
-- 187 — Playbook 3.0 Wave 1: the Deep Study record
--
-- When the Playbook Copilot compiles a plain-language SOP into an
-- executable draft, it also STUDIES the business first — cross-examining
-- the SOP against the tenant's real knowledge base, guardrails, and
-- history. This table keeps that study with the playbook: the original
-- SOP text (source of truth for judgment steps at runtime), the findings
-- (contradictions, clarifying questions, proposed test scenarios,
-- knowledge bindings, per-step risk grades), and what it cost.
-- One study per definition (latest wins on re-draft).
-- ═══════════════════════════════════════════════════════════════

create table if not exists playbook_studies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  definition_id uuid not null references playbook_definitions(id) on delete cascade,
  sop_text      text not null,
  -- { contradictions:[{sop_says,kb_says,source_title}], questions:[text],
  --   scenarios:[{question,expected_fragments,category}],
  --   bindings:[{step_index,doc_id,title}], risk:[{step_index,grade,why}] }
  report        jsonb not null default '{}'::jsonb,
  model_id      text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (definition_id)
);

create index if not exists playbook_studies_tenant_idx on playbook_studies(tenant_id);

alter table playbook_studies enable row level security;

drop policy if exists "playbook_studies_tenant_isolation" on playbook_studies;
create policy "playbook_studies_tenant_isolation" on playbook_studies
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_studies_updated_at on playbook_studies;
create trigger playbook_studies_updated_at
  before update on playbook_studies
  for each row execute function update_updated_at();
