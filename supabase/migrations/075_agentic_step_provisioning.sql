-- ============================================================
-- Migration 075: agentic_playbook_steps needs a real
-- agentic_step_policies row to run against — without one, the loop
-- falls back to hardcoded defaults in the edge function rather than a
-- tenant-owned, tenant-editable row. Same wiring as 071 did for
-- knowledge_gap_detection: reconcile_tenant_feature (068) gets a 3rd
-- branch, so complete_signup provisions new tenants and a
-- platform-admin toggle provisions existing ones live — same
-- mechanism, not a new one.
-- ============================================================
create or replace function public.reconcile_tenant_feature(p_tenant_id uuid, p_feature_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_feature_key in ('account_de', 'finance_de') then
    if p_enabled then
      perform provision_starter_de_internal(p_tenant_id, p_feature_key);
    else
      perform deprovision_starter_de_internal(p_tenant_id, p_feature_key);
    end if;
  elsif p_feature_key = 'knowledge_gap_detection' then
    if p_enabled then
      insert into knowledge_gap_policies (tenant_id, category, enabled)
      select p_tenant_id, null, true
      where not exists (select 1 from knowledge_gap_policies where tenant_id = p_tenant_id);
    end if;
  elsif p_feature_key = 'agentic_playbook_steps' then
    if p_enabled then
      -- Tenant-default budget envelope (column defaults: 15 iterations,
      -- 100k tokens, $5, 3 no-progress strikes) — soft-disable via
      -- policy.enabled or the flag gate, never destroy tenant config.
      insert into agentic_step_policies (tenant_id)
      select p_tenant_id
      where not exists (select 1 from agentic_step_policies where tenant_id = p_tenant_id);
    end if;
  end if;
end;
$function$;

-- Backfill: reconcile every existing, non-suspended tenant (except the
-- demo tenant) against its effective (override-aware) state for
-- agentic_playbook_steps specifically — same idempotent pattern as 071.
do $$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t record;
begin
  for v_t in select id from tenants where id <> v_demo_tenant_id and status <> 'suspended' loop
    perform reconcile_tenant_feature(v_t.id, 'agentic_playbook_steps', is_feature_enabled_internal(v_t.id, 'agentic_playbook_steps'));
  end loop;
end $$;
