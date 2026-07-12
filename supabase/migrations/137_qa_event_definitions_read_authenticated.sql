-- ============================================================
-- QA pass (2026-07-12): tighten event_definitions read policy.
--
-- 134's event_definitions_read policy omitted `to authenticated`
-- (unlike its siblings de_kpis / workforce_baselines), so the
-- default SELECT grant left the 4 seeded platform event definitions
-- readable by `anon`. Data is non-sensitive (generic event labels)
-- so this is a Low hygiene fix, but it removes the inconsistency and
-- the anon-readable branch. Platform-scope events stay readable by
-- every authenticated tenant member (they're the built-in events any
-- tenant can bind a rule to); tenant events stay tenant-isolated.
-- ============================================================
drop policy if exists event_definitions_read on event_definitions;
create policy event_definitions_read on event_definitions
  for select to authenticated
  using (scope = 'platform' or tenant_id = auth_tenant_id());
