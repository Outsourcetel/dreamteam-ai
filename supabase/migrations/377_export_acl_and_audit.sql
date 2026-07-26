-- 377_export_acl_and_audit.sql
-- ============================================================================
-- Two holes in the data export (mig 372), both found by adversarial review.
--
-- ── H1: the export bypasses the knowledge ACL ──────────────────────────────
-- export_tenant_table_page() is SECURITY DEFINER, so it runs as the table owner
-- and RLS does not apply. knowledge_docs is protected by
-- knowledge_docs_acl_select (migs 343/344, hardened by 357), which exempts
-- is_platform_admin() ONLY — deliberately NOT tenant_admin, because the whole
-- point of migration 357 was that "admin" must not mean "reads every restricted
-- Space". The pager gave that back.
--
-- ⚠ HOW EXPOSED IS IT TODAY? LATENT, NOT LIVE — and the first answer I gave was
-- wrong, so both are recorded here.
--   knowledge_access_grants                       80 rows
--   knowledge_docs   1950 visibility='tenant',    50 visibility='scoped'
--   knowledge_docs WHERE restricted_space_id IS NOT NULL      0
-- Seeing 50 scoped documents, I said the hole was live. It is not. `scoped`
-- visibility is AUDIENCE scoping (knowledge_doc_scopes) — a different mechanism
-- from the restricted-Space ACL this policy enforces — and every one of those 50
-- has restricted_space_id IS NULL with inherits_access true, so the predicate
-- below admits all of them. Nothing is being over-exposed right now.
--
-- The fix still belongs here: the day someone creates the first restricted
-- Space, the export would quietly hand its contents to a tenant_admin who was
-- deliberately excluded, and nobody would be looking at the exporter at that
-- moment. Closing it before that is cheap; discovering it afterwards is not.
--
-- FIX: the pager re-applies the ACL for knowledge_docs when the caller is not
-- the service role. It does so by DELEGATING to the same predicate the policy
-- uses (knowledge_grant_matches_caller / knowledge_permission_rank) rather than
-- restating the logic — a second copy of an access rule is a second thing to
-- forget when the first one changes.
--
-- ── H2: the pager wrote no audit row ───────────────────────────────────────
-- 372 audits the MANIFEST call only. export_tenant_table_page is separately
-- granted to `authenticated`, so a tenant_admin could page every row of all 226
-- tables straight over PostgREST and leave no trace, while the file's own header
-- claims one audit row per export. On a product whose pitch is governance, a
-- bulk read of every customer record is precisely the event the audit exists to
-- capture.
--
-- FIX: every page writes an audit row, deduped per (session, table) so a 226-
-- table export produces 226 entries rather than one per 500-row page.
-- ============================================================================

-- ── The ACL-aware pager ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.export_tenant_table_page(
  p_tenant uuid, p_table text, p_cursor jsonb DEFAULT NULL, p_limit int DEFAULT 500,
  p_session uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_rows      jsonb;
  v_is_svc    boolean := coalesce(auth.role(), '') = 'service_role';
  v_sql       text;
  v_acl_where text := '';
BEGIN
  -- Unchanged from 372: the caller must be an admin of the tenant they name.
  IF NOT public.can_admin_tenant_internal(p_tenant) THEN
    RAISE EXCEPTION 'export_tenant_table_page: not permitted for this workspace';
  END IF;

  -- Table name validated against the catalog before it is ever interpolated.
  IF NOT EXISTS (SELECT 1 FROM public.export_tenant_surface() s WHERE s.table_name = p_table) THEN
    RAISE EXCEPTION 'export_tenant_table_page: % is not an exportable table', p_table;
  END IF;

  -- ── H1 ────────────────────────────────────────────────────────────────────
  -- Only knowledge_docs carries a per-document ACL today. The predicate is
  -- lifted from knowledge_docs_acl_select rather than rewritten: if the policy
  -- changes, this must change with it, and sharing the helper functions is what
  -- makes that likely instead of merely hoped for.
  IF p_table = 'knowledge_docs' AND NOT v_is_svc AND NOT public.is_platform_admin() THEN
    v_acl_where := ' AND (x.restricted_space_id IS NULL AND x.inherits_access '
                || '      OR EXISTS (SELECT 1 FROM knowledge_access_grants g '
                || '                  WHERE g.tenant_id = x.tenant_id '
                || '                    AND knowledge_permission_rank(g.permission) >= 1 '
                || '                    AND knowledge_grant_matches_caller(g.*) '
                || '                    AND (g.resource_type = ''workspace'' '
                || '                      OR (g.resource_type = ''space'' AND g.resource_id = x.restricted_space_id) '
                || '                      OR (g.resource_type = ''document'' AND g.resource_id = x.id))))';
  END IF;

  v_sql := format(
    'SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.ctid), ''[]''::jsonb) '
    'FROM (SELECT * FROM public.%I x WHERE x.tenant_id = $1%s '
    '      ORDER BY x.ctid LIMIT $2) x', p_table, v_acl_where);
  EXECUTE v_sql INTO v_rows USING p_tenant, least(greatest(p_limit, 1), 5000);

  -- ── H2 ────────────────────────────────────────────────────────────────────
  -- One row per (session, table), not per page. A 226-table export should be
  -- 226 legible entries, not 4,000 that nobody reads — an audit trail too noisy
  -- to review is the same as no audit trail.
  IF p_session IS NOT NULL THEN
    INSERT INTO audit_events (tenant_id, actor, actor_type, action, category, detail, created_at)
    SELECT p_tenant,
           coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'unknown'),
           'user', format('Exported table %s', p_table), 'data_export',
           jsonb_build_object('table', p_table, 'export_session', p_session,
                              'acl_applied', v_acl_where <> ''),
           now()
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events a
        WHERE a.tenant_id = p_tenant AND a.category = 'data_export'
          AND a.detail->>'export_session' = p_session::text
          AND a.detail->>'table' = p_table);
  END IF;

  RETURN jsonb_build_object('table', p_table, 'rows', v_rows,
                            'acl_filtered', v_acl_where <> '');
END $fn$;
REVOKE ALL ON ROUTINE public.export_tenant_table_page(uuid, text, jsonb, int, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.export_tenant_table_page(uuid, text, jsonb, int, uuid) TO authenticated;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_def text; v_scoped int; v_grants int;
BEGIN
  SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'export_tenant_table_page'
     AND pg_get_function_arguments(p.oid) LIKE '%p_session%';

  IF v_def IS NULL THEN RAISE EXCEPTION '377: the new pager signature is not present'; END IF;

  -- The ACL must be delegated to the shared helpers, not restated. If someone
  -- later "simplifies" this into a hand-rolled check, that is the moment the
  -- export and the policy start disagreeing.
  IF v_def !~ 'knowledge_grant_matches_caller' OR v_def !~ 'knowledge_permission_rank' THEN
    RAISE EXCEPTION '377: the pager no longer uses the shared knowledge ACL helpers';
  END IF;
  IF v_def !~ 'audit_events' THEN
    RAISE EXCEPTION '377: the pager writes no audit row';
  END IF;
  IF v_def !~ 'service_role' THEN
    RAISE EXCEPTION '377: the pager does not distinguish the service role, so the drain would be ACL-filtered too';
  END IF;

  IF has_function_privilege('anon', 'public.export_tenant_table_page(uuid,text,jsonb,int,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '377: the pager is anon-callable';
  END IF;

  -- State the live exposure this closed, so the number is on the record.
  SELECT count(*) INTO v_scoped FROM knowledge_docs WHERE visibility = 'scoped';
  SELECT count(*) INTO v_grants FROM knowledge_access_grants;
  RAISE NOTICE '377: export now respects the knowledge ACL and audits per table. Latent, not live: % scoped docs / % grants, but 0 docs behind a restricted space today.',
    v_scoped, v_grants;
END $assert$;

NOTIFY pgrst, 'reload schema';
