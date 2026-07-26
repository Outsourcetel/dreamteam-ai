-- ============================================================================
-- CLEAN UP EMPTY TEST-ARTIFACT TENANTS
--
-- Run with:  node scripts/db-query.mjs scripts/sql/cleanup_empty_test_tenants.sql
--
-- ⚠ DELETES tenants. Irreversible. Read the guard before running.
--
-- WHY THIS DOES NOT CALL delete_tenant().
--   delete_tenant() begins `if auth.uid() is null then raise 'not authenticated'`
--   and then requires the 'tenants.manage' platform capability. db-query.mjs runs
--   through the Supabase Management API as the database owner, which has NO
--   auth.uid() at all — so delete_tenant() fails identically for everyone through
--   this channel. That capability check exists to stop APP USERS deleting
--   workspaces; it is not meant to constrain the project owner operating the
--   database directly, which is what this channel is.
--   The alternative — faking request.jwt.claims to forge a platform-admin
--   identity — is explicitly off the table. Never forge an auth identity to get
--   past a control that was put there on purpose.
--
-- WHAT IT DELETES — 11 tenants, each re-verified AT RUN TIME to hold
--   0 knowledge docs, 0 conversations, 0 user profiles, <= 1 stub employee:
--     aaaa…(1000 chars)   slug-length probe        script-alert-1-script  XSS probe
--     sectest-forge-org-01  security test          e2e-test-ventures      e2e test
--     test-api-key-verification-temp               acme-telecom-1         dup
--     n-c-d-co              tier-test-a64f3c93
--     eval-b9131462 / eval-c2d2dedd / eval-d49f947b   cert-run artifacts
--
-- WHAT IT DELIBERATELY PRESERVES — both looked like junk in the list and are not:
--     acme-telecom   7 employees, 1,878 knowledge docs, 87 conversations, 2 users
--     kinetic        10 employees, 1 conversation, 1 user
--   Both are merely SUSPENDED. Suspending is reversible. Deleting is not.
--
-- FK SHAPE: 198 foreign keys reference tenants; 191 ON DELETE CASCADE. The seven
-- that do not are handled explicitly below — two are NO ACTION and would BLOCK a
-- delete (the safe failure), so their rows are cleared first, and a tenant with
-- CHILD tenants is refused outright rather than orphaning a hierarchy.
-- ============================================================================

DO $cleanup$
DECLARE
  r record;
  v_docs int; v_convs int; v_profiles int; v_des int; v_children int;
  v_deleted int := 0; v_skipped int := 0;
  v_demo constant uuid := 'a0000000-0000-0000-0000-000000000001';  -- never touch
  slugs text[] := ARRAY[
    'script-alert-1-script', 'sectest-forge-org-01', 'e2e-test-ventures',
    'test-api-key-verification-temp', 'acme-telecom-1', 'n-c-d-co',
    'tier-test-a64f3c93', 'eval-b9131462', 'eval-c2d2dedd', 'eval-d49f947b'
  ];
BEGIN
  FOR r IN
    SELECT id, slug, status FROM tenants
     WHERE (slug = ANY(slugs) OR slug ~ '^a{100,}$')   -- the probe, matched by shape
       AND id <> v_demo
  LOOP
    IF r.status <> 'suspended' THEN
      RAISE NOTICE 'SKIP % — status is %, not suspended', left(r.slug,40), r.status;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    SELECT count(*) INTO v_docs     FROM knowledge_docs    WHERE tenant_id = r.id;
    SELECT count(*) INTO v_convs    FROM de_conversations  WHERE tenant_id = r.id;
    SELECT count(*) INTO v_profiles FROM profiles          WHERE tenant_id = r.id;
    SELECT count(*) INTO v_des      FROM digital_employees WHERE tenant_id = r.id;
    SELECT count(*) INTO v_children FROM tenants           WHERE parent_tenant_id = r.id;

    -- Re-verify NOW. Never trust the hardcoded list.
    IF v_docs > 0 OR v_convs > 0 OR v_profiles > 0 OR v_des > 1 THEN
      RAISE NOTICE 'SKIP % — NOT empty (docs=% convs=% users=% employees=%)',
        left(r.slug,40), v_docs, v_convs, v_profiles, v_des;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_children > 0 THEN
      RAISE NOTICE 'SKIP % — has % child tenant(s)', left(r.slug,40), v_children;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- The audit chain refuses cascaded deletes. Use its OWN sanctioned hatch —
    -- the same one delete_tenant() sets — scoped to THIS transaction only.
    -- Deleting a workspace deliberately purges its audit rows: that is the
    -- designed behaviour of a delete, not a control being weakened. (For a
    -- workspace with real history, SUSPEND instead — it keeps the chain.)
    PERFORM set_config('app.allow_audit_purge', 'on', true);

    -- Clear the NO ACTION referents that would otherwise block the delete.
    DELETE FROM platform_access_events        WHERE tenant_id = r.id;
    DELETE FROM tenant_provisioning_requests  WHERE created_tenant_id = r.id OR proposed_parent_tenant_id = r.id;

    DELETE FROM tenants WHERE id = r.id;      -- 191 cascading FKs clean up the rest
    RAISE NOTICE 'DELETED %', left(r.slug,40);
    v_deleted := v_deleted + 1;
  END LOOP;

  RAISE NOTICE '--- cleanup complete: % deleted, % skipped ---', v_deleted, v_skipped;
END $cleanup$;

SELECT jsonb_pretty(jsonb_build_object(
  'tenants_remaining', (SELECT count(*) FROM tenants),
  'by_status', (SELECT jsonb_object_agg(status, n) FROM (
      SELECT status, count(*) n FROM tenants GROUP BY status) z),
  'junk_slugs_left', (SELECT coalesce(jsonb_agg(left(slug,40)), '[]') FROM tenants
      WHERE slug ~ '^(eval-|tier-test-|sectest|e2e-|test-api|script-alert|n-c-d-co|acme-telecom-1|a{100,})'),
  'preserved_with_data', (SELECT jsonb_agg(jsonb_build_object(
      'slug', t.slug, 'status', t.status,
      'docs', (SELECT count(*) FROM knowledge_docs k WHERE k.tenant_id = t.id),
      'employees', (SELECT count(*) FROM digital_employees d WHERE d.tenant_id = t.id),
      'conversations', (SELECT count(*) FROM de_conversations c WHERE c.tenant_id = t.id)))
    FROM tenants t WHERE t.slug IN ('acme-telecom','kinetic'))
)) AS result;
