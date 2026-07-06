-- Found live while verifying platform-console access for the founder's
-- own platform account: the `tenants` table's only RLS policy
-- (`id = auth_tenant_id()`) has zero platform-admin bypass. A platform
-- admin's own profile has tenant_id = NULL by design (they operate above
-- every tenant, not inside one), so `auth_tenant_id()` returns NULL and
-- `id = NULL` never matches any row in SQL -- meaning Platform Console's
-- "Tenant Management" screen always received zero rows and silently fell
-- back to hardcoded mock data ("Acme Corp", "Globex Inc") instead of the
-- real tenant tree. Same is_platform_admin() bypass pattern already used
-- consistently elsewhere in this codebase (detect_exceptions,
-- ingest_document, etc.) -- ordinary tenant users are completely
-- unaffected; they still only ever see their own tenant.

drop policy if exists tn_sel on tenants;
create policy tn_sel on tenants
  for select
  using (id = auth_tenant_id() or is_platform_admin());
