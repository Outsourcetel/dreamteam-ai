-- ============================================================
-- Migration 071: knowledge_gap_detection needs one more thing
-- feature_registry rows don't provide on their own — a real
-- knowledge_gap_policies row to actually run against. Without one,
-- cluster_gap_candidates() loops over zero policies and does nothing,
-- even with the flag on. This wires provisioning into
-- reconcile_tenant_feature (068) exactly like account_de/finance_de
-- already do, so complete_signup provisions it for new tenants and a
-- platform-admin toggle provisions it live for existing ones — same
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
      -- Seed one tenant-wide (category=null) default policy row if this
      -- tenant has none yet. Turning the feature off leaves any existing
      -- policy rows in place — soft-disable via the flag gate inside
      -- cluster_gap_candidates(), never destroy tenant config.
      insert into knowledge_gap_policies (tenant_id, category, enabled)
      select p_tenant_id, null, true
      where not exists (select 1 from knowledge_gap_policies where tenant_id = p_tenant_id);
    end if;
  end if;
end;
$function$;

-- Backfill: reconcile every existing, non-suspended tenant (except
-- the demo tenant) against its effective (override-aware) state for
-- knowledge_gap_detection specifically — the exact same idempotent
-- pattern migration 068 used for the original 7 flags, re-run here
-- now that reconcile_tenant_feature has a branch for the 8th.
do $$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t record;
begin
  for v_t in select id from tenants where id <> v_demo_tenant_id and status <> 'suspended' loop
    perform reconcile_tenant_feature(v_t.id, 'knowledge_gap_detection', is_feature_enabled_internal(v_t.id, 'knowledge_gap_detection'));
  end loop;
end $$;
