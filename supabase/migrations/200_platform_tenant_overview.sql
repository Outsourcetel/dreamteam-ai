-- ════════════════════════════════════════════════════════════════
-- 200: PLATFORM TENANT OVERVIEW — one tenant-management surface
-- ════════════════════════════════════════════════════════════════
-- The 20260720_tenant_management migration's get_all_tenants_with_summary
-- used `RETURN json_agg(...) FROM ...` — invalid plpgsql — so it (and
-- possibly that whole migration) never applied, which is why the separate
-- "Tenant Management" tab showed nothing. This replaces it with ONE
-- correct, honest overview RPC feeding the merged "Tenants & Remote
-- Access" tab: per-tenant admin identity (computed LIVE from the earliest
-- owner/admin profile + auth.users — no stored column to go stale),
-- real DE/user counts, and last activity. No invented billing numbers.

CREATE OR REPLACE FUNCTION public.get_platform_tenant_overview()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN (
    SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)
    FROM (
      SELECT
        t.id::text AS tenant_id,
        adm.full_name AS admin_name,
        adm.email AS admin_email,
        coalesce(de_cnt.n, 0) AS de_count,
        coalesce(usr_cnt.n, 0) AS user_count,
        act.last_activity::text AS last_activity
      FROM tenants t
      LEFT JOIN LATERAL (
        -- Most senior member: owner > admin > manager > anyone. Tenants
        -- operated purely via platform Remote Access have no members at
        -- all — those honestly show "no admin user".
        SELECT p.full_name, u.email::text AS email
        FROM profiles p
        JOIN auth.users u ON u.id = p.user_id
        WHERE p.tenant_id = t.id
        ORDER BY CASE p.role
          WHEN 'tenant_owner' THEN 0
          WHEN 'tenant_admin' THEN 1
          WHEN 'tenant_manager' THEN 2
          ELSE 3 END
        LIMIT 1
      ) adm ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM digital_employees d WHERE d.tenant_id = t.id
      ) de_cnt ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM profiles p WHERE p.tenant_id = t.id
      ) usr_cnt ON true
      LEFT JOIN LATERAL (
        SELECT max(m.created_at) AS last_activity FROM de_messages m WHERE m.tenant_id = t.id
      ) act ON true
    ) x
  );
END$$;

REVOKE ALL ON FUNCTION public.get_platform_tenant_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_platform_tenant_overview() TO authenticated, service_role;
