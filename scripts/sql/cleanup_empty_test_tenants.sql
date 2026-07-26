-- ============================================================================
-- CLEAN UP EMPTY TEST-ARTIFACT TENANTS
--
-- Run with:  node scripts/db-query.mjs scripts/sql/cleanup_empty_test_tenants.sql
--
-- ⚠ This DELETES tenants. It is irreversible. Read the guard below first.
--
-- WHAT IT DELETES — 11 tenants, each verified to hold:
--     0 knowledge docs, 0 conversations, 0 user profiles, <= 1 stub employee.
--   aaaa…(1000 chars)             a slug-length probe
--   script-alert-1-script         an XSS probe
--   sectest-forge-org-01          a security test
--   e2e-test-ventures             an end-to-end test
--   test-api-key-verification-temp
--   acme-telecom-1                an accidental duplicate
--   n-c-d-co
--   tier-test-a64f3c93
--   eval-b9131462 / eval-c2d2dedd / eval-d49f947b   certification-run artifacts
--
-- WHAT IT DELIBERATELY DOES NOT DELETE — both looked like junk in the tenant
-- list and are NOT:
--   acme-telecom   7 employees, 1,878 knowledge docs, 87 conversations, 2 users
--   kinetic        10 employees, 1 conversation, 1 user
--   Both are merely SUSPENDED. Suspending is reversible; deleting is not.
--
-- THE GUARD BELOW IS THE POINT. It re-verifies emptiness AT RUN TIME rather
-- than trusting the slug list — so if anything has been added to one of these
-- workspaces since this script was written, that tenant is skipped, loudly.
--
-- delete_tenant() requires a platform team member with 'tenants.manage'
-- capability, which is why this is a script for you to run rather than
-- something applied by the service role.
-- ============================================================================

DO $cleanup$
DECLARE
  r record;
  v_docs int; v_convs int; v_profiles int; v_des int;
  v_deleted int := 0; v_skipped int := 0;
  slugs text[] := ARRAY[
    'script-alert-1-script',
    'sectest-forge-org-01',
    'e2e-test-ventures',
    'test-api-key-verification-temp',
    'acme-telecom-1',
    'n-c-d-co',
    'tier-test-a64f3c93',
    'eval-b9131462',
    'eval-c2d2dedd',
    'eval-d49f947b'
  ];
BEGIN
  FOR r IN
    SELECT id, slug, status FROM tenants
     WHERE slug = ANY(slugs)
        OR slug ~ '^a{100,}$'          -- the slug-length probe, matched by shape
  LOOP
    -- Never delete anything that is not suspended.
    IF r.status <> 'suspended' THEN
      RAISE NOTICE 'SKIP % — status is %, not suspended', left(r.slug, 40), r.status;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    SELECT count(*) INTO v_docs     FROM knowledge_docs     WHERE tenant_id = r.id;
    SELECT count(*) INTO v_convs    FROM de_conversations   WHERE tenant_id = r.id;
    SELECT count(*) INTO v_profiles FROM profiles           WHERE tenant_id = r.id;
    SELECT count(*) INTO v_des      FROM digital_employees  WHERE tenant_id = r.id;

    -- Re-verify emptiness NOW. Do not trust the list.
    IF v_docs > 0 OR v_convs > 0 OR v_profiles > 0 OR v_des > 1 THEN
      RAISE NOTICE 'SKIP % — NOT empty (docs=% convs=% users=% employees=%)',
        left(r.slug, 40), v_docs, v_convs, v_profiles, v_des;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    PERFORM delete_tenant(r.id, r.slug);
    RAISE NOTICE 'DELETED %', left(r.slug, 40);
    v_deleted := v_deleted + 1;
  END LOOP;

  RAISE NOTICE '--- cleanup complete: % deleted, % skipped ---', v_deleted, v_skipped;
END $cleanup$;

SELECT jsonb_pretty(jsonb_build_object(
  'tenants_remaining', (SELECT count(*) FROM tenants),
  'by_status', (SELECT jsonb_object_agg(status, n) FROM (
      SELECT status, count(*) n FROM tenants GROUP BY status) z),
  'preserved_with_data', (SELECT jsonb_agg(jsonb_build_object(
      'slug', t.slug, 'status', t.status,
      'docs', (SELECT count(*) FROM knowledge_docs k WHERE k.tenant_id = t.id),
      'employees', (SELECT count(*) FROM digital_employees d WHERE d.tenant_id = t.id)))
    FROM tenants t WHERE t.slug IN ('acme-telecom', 'kinetic'))
)) AS result;
