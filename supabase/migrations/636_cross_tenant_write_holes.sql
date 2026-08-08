-- 636 — six SECURITY DEFINER writers were reachable by ANY authenticated user,
-- with the target tenant passed as a PARAMETER. That is a cross-tenant WRITE.
--
-- Found by the certification review's Ring-0 pass (the knowledge-acl invariant
-- test), not by reading — the functions look ordinary. Each is SECURITY
-- DEFINER, grants EXECUTE to `authenticated`, and takes p_tenant_id as its
-- first argument, writing into THAT tenant. So any signed-up user of any
-- workspace could call, against a tenant that is not theirs:
--
--     upsert_external_ticket      inject a support ticket
--     upsert_external_contact     inject / overwrite a contact (incl. email)
--     upsert_external_opportunity inject a pipeline opportunity
--     upsert_external_ar_record   inject an invoice / AR balance
--     resolve_external_account    create a customer account
--     install_role_watchers       install scheduled watchers
--
-- This is the SAME class migration 610 closed for other functions ("the default
-- grant nobody revoked"): Supabase's default privileges hand EXECUTE to anon
-- and authenticated as NAMED roles, so a function created without an explicit
-- REVOKE is open to the internet. 610 fixed the ones it knew about; these six
-- were created in 607/608 and slipped the net.
--
-- WHY REVOKE IS THE WHOLE FIX (not a tenant guard):
-- The ONLY legitimate caller is connector-hub's ingest/sync path, which calls
-- every one of these on the SERVICE-ROLE client (admin.rpc(...), verified at
-- connector-hub/index.ts lines ~6456-6551). The service role bypasses EXECUTE
-- grants entirely, so revoking public/anon/authenticated changes nothing for
-- the real caller and removes the function from every user's reach.
-- install_role_watchers is called only from migrations and provisioning, both
-- of which run as a privileged role — same reasoning.
--
-- These take a p_tenant_id BY DESIGN: ingest runs headless, with no
-- auth_tenant_id() to derive from, and legitimately writes into whichever
-- tenant owns the connector. That design is correct FOR THE SERVICE ROLE and
-- catastrophic for `authenticated`. The perimeter is the boundary, not the body.

BEGIN;

REVOKE ALL ON FUNCTION
  public.upsert_external_ticket(uuid, text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.upsert_external_contact(uuid, text, text, text, text, text, text, text, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.upsert_external_opportunity(uuid, text, text, text, text, text, bigint, date, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.upsert_external_ar_record(uuid, text, text, text, text, bigint, date, text, text, bigint, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.resolve_external_account(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.install_role_watchers(uuid)
  FROM PUBLIC, anon, authenticated;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_bad text;
BEGIN
  -- S1: none of the six is reachable by anon or authenticated any more. Checked
  -- by the same privilege function the review probe uses, so the migration and
  -- the standing gate agree by construction.
  SELECT string_agg(p.proname || ' (' ||
           case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated ' else '' end ||
           case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' else '' end || ')', ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('upsert_external_ticket','upsert_external_contact','upsert_external_opportunity',
                       'upsert_external_ar_record','resolve_external_account','install_role_watchers')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S1 FAILED: still reachable by a client role: %', v_bad;
  END IF;

  -- S2: all six still EXIST and are still SECURITY DEFINER — a REVOKE that
  -- accidentally dropped or altered them would break ingest. This proves we
  -- closed the door, not the building.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND p.proname IN ('upsert_external_ticket','upsert_external_contact','upsert_external_opportunity',
                           'upsert_external_ar_record','resolve_external_account','install_role_watchers')) <> 6 THEN
    RAISE EXCEPTION 'S2 FAILED: expected 6 SECURITY DEFINER functions to survive the revoke';
  END IF;

  RAISE NOTICE '636 asserts passed: 6 cross-tenant writers removed from anon/authenticated reach; service-role ingest unaffected.';
END
$probe$;

COMMIT;
