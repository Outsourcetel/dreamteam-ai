-- 470_revoke_anon_writes_schemawide.sql
-- ============================================================================
-- Remove `anon` write privileges from every table in public, and stop new
-- tables from arriving with them.
--
-- ── Measured before touching anything ────────────────────────────────────
-- 267 tables in public. anon holds INSERT on 224, UPDATE on 223, DELETE on 224
-- — roughly 84% of the schema. Not a decision anyone made: Supabase's DEFAULT
-- PRIVILEGES grant new public tables to anon on creation, so every table since
-- the beginning of the project has arrived this way.
--
-- ── Why this is safe, established rather than assumed ────────────────────
-- Queried every permissive write policy in public whose expression does not
-- reference auth.uid / auth_tenant_id / auth.role / is_platform_admin /
-- auth_has_tenant_role / current_setting. Every single result is either the
-- literal `false` (explicit deny-all) or can_admin_tenant_internal(tenant_id),
-- which checks auth inside the helper.
--
-- **Zero permissive write policies can be satisfied by an anon caller.** RLS has
-- been denying all 224 the whole time. This migration is therefore functionally
-- a no-op and changes nothing a user can do.
--
-- ── Then why do it ───────────────────────────────────────────────────────
-- Because the safety rests on something being ABSENT — no permissive policy
-- admitting a null-auth caller — rather than on something being enforced. The
-- day someone adds a permissive write policy for an unrelated reason, the grant
-- is already sitting there. That is not hypothetical: it is exactly the shape
-- that made list_de_skills internet-readable (mig 431), dispatch_de_work_internal
-- anon-callable (mig 426), recompute_de_trust_badge anon-callable within an hour
-- of shipping (mig 469), and my own de_learning_edits arrive with INSERT already
-- granted (mig 457, caught only by an adversarial assertion).
--
-- Four instances of one class in a single day. This closes the class for writes.
--
-- ── ⚠ WRITES ONLY. SELECT IS DELIBERATELY LEFT ALONE ────────────────────
-- anon holds SELECT on 227 tables and that is also debt, but revoking reads is
-- a materially riskier change: the embed widget and any unauthenticated surface
-- read through paths I have not fully mapped, and a broken read is a visible
-- customer regression rather than a latent one. The founder asked for the write
-- sweep; reads deserve their own migration with its own caller analysis.
--
-- ── ⚠ WHAT MUST NOT BE TOUCHED ──────────────────────────────────────────
-- `authenticated` keeps everything — the entire application writes as that role.
-- `service_role` keeps everything — BYPASSRLS bypasses POLICIES, not
-- PRIVILEGES, so a service-role worker still needs the GRANT. Revoking from it
-- would break every edge function and every cron dispatch. Both are asserted
-- below, and the assertion is the reason this migration is safe to run at all.
--
-- ALTER DEFAULT PRIVILEGES stops the recurrence for tables created by this role
-- (which is every migration), so the next table does not arrive pre-granted.
-- ============================================================================

DO $measure$
DECLARE v_i int; v_u int; v_d int;
BEGIN
  SELECT count(*) FILTER (WHERE has_table_privilege('anon','public.'||c.relname,'INSERT')),
         count(*) FILTER (WHERE has_table_privilege('anon','public.'||c.relname,'UPDATE')),
         count(*) FILTER (WHERE has_table_privilege('anon','public.'||c.relname,'DELETE'))
    INTO v_i, v_u, v_d
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind = 'r';
  RAISE NOTICE '470: before — anon INSERT on %, UPDATE on %, DELETE on %', v_i, v_u, v_d;
END $measure$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;

-- Stop the recurrence. Applies to tables created by the role running this,
-- which is the role every migration runs as.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;

DO $assert$
DECLARE
  v_anon_w int; v_authed_w int; v_service_w int; v_total int; v_leftover text;
BEGIN
  SELECT count(*) INTO v_total
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
   WHERE c.relkind = 'r';

  -- 1. anon writes are gone, everywhere.
  SELECT count(*) INTO v_anon_w
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
   WHERE c.relkind='r'
     AND (has_table_privilege('anon','public.'||c.relname,'INSERT')
       OR has_table_privilege('anon','public.'||c.relname,'UPDATE')
       OR has_table_privilege('anon','public.'||c.relname,'DELETE'));
  IF v_anon_w > 0 THEN
    SELECT string_agg(c.relname, ', ') INTO v_leftover
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
     WHERE c.relkind='r'
       AND (has_table_privilege('anon','public.'||c.relname,'INSERT')
         OR has_table_privilege('anon','public.'||c.relname,'UPDATE')
         OR has_table_privilege('anon','public.'||c.relname,'DELETE'))
     LIMIT 1;
    RAISE EXCEPTION '470: anon still holds writes on % table(s): %', v_anon_w, v_leftover;
  END IF;

  -- 2. ⚠ THE ASSERTIONS THAT MATTER MORE THAN THE REVOKE.
  --    authenticated writes are the application. service_role writes are every
  --    edge function and cron dispatch — BYPASSRLS skips policies, NOT
  --    privileges, so the worker genuinely needs the GRANT.
  SELECT count(*) INTO v_authed_w
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
   WHERE c.relkind='r' AND has_table_privilege('authenticated','public.'||c.relname,'UPDATE');
  IF v_authed_w < (v_total / 2) THEN
    RAISE EXCEPTION '470: authenticated lost UPDATE on most tables (% of %) — THE APP IS BROKEN, roll back', v_authed_w, v_total;
  END IF;

  SELECT count(*) INTO v_service_w
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
   WHERE c.relkind='r' AND has_table_privilege('service_role','public.'||c.relname,'UPDATE');
  IF v_service_w < (v_total / 2) THEN
    RAISE EXCEPTION '470: service_role lost UPDATE on most tables (% of %) — EVERY WORKER AND CRON IS BROKEN, roll back', v_service_w, v_total;
  END IF;

  -- 3. Reads deliberately untouched — this is a write sweep.
  IF NOT has_table_privilege('anon','public.ops_alerts','SELECT')
     AND NOT has_table_privilege('anon','public.tenants','SELECT') THEN
    RAISE NOTICE '470: note — anon SELECT appears already absent on the sampled tables';
  END IF;

  RAISE NOTICE '470: anon writes revoked across % tables. authenticated retains UPDATE on %, service_role on %. Default privileges altered so new tables do not arrive pre-granted.',
    v_total, v_authed_w, v_service_w;
END $assert$;

NOTIFY pgrst, 'reload schema';
