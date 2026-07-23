-- 305_audit_chain_insider_write_lock.sql
-- ============================================================================
-- GI-2 (Governance Integrity) — close the audit-chain INSIDER-WRITE hole.
--
-- THE HOLE (mig 015): audit_events had an INSERT RLS policy
-- ("audit_events_tenant_insert") allowing ANY tenant member (a browser JWT) to
-- INSERT rows directly — choosing actor / actor_type / action / detail AND
-- prev_hash / hash by hand. The hash algorithm is public (it lives in this
-- repo), so an insider could forge a row that PASSES verify_audit_chain, or
-- simply append an out-of-band row that never went through append_audit_event.
-- That defeats the tamper-evidence the whole governance story rests on.
--
-- Every real writer already uses the SECURITY DEFINER path:
--   • append_audit_event          (user-JWT + service-role edge fns; server-
--                                   attested actor, server-computed hash)
--   • append_audit_event_internal (cron/compute functions)
-- Both run as the table owner and bypass RLS, so removing the caller-facing
-- INSERT capability does NOT touch any legitimate write. Verified: no direct
-- INSERT into audit_events exists in src/ or supabase/functions/ — all writes
-- route through the RPC. The app's own Trust & Architecture page already CLAIMS
-- "audit_events is INSERT-only ... every write goes through append_audit_event";
-- this migration makes that claim actually enforced rather than aspirational.
--
-- After this migration the ONLY append path is the RPC. A tenant admin can no
-- longer forge or inject audit rows. (Platform-operator / direct-DB writes
-- remain outside the tenant threat model; external anchoring of the chain head
-- — audit_chain_head() below exposes it — is the follow-on for that tier.)
-- GLOBAL — applies to every tenant.
-- ============================================================================

-- 1. Remove the insider INSERT path -------------------------------------------
DROP POLICY IF EXISTS "audit_events_tenant_insert" ON audit_events;

-- RLS stays ON with ONLY the tenant SELECT policy. With RLS enabled and no
-- INSERT policy, a non-owner role (anon/authenticated) cannot INSERT at all.
-- SECURITY DEFINER writers run as the owner, which bypasses RLS — unaffected.
-- (We deliberately do NOT enable FORCE ROW LEVEL SECURITY: that would subject
-- the owner-run definer INSERTs to RLS too and break the only write path.)

-- 2. Revoke the base-table write grants (defense in depth) ---------------------
-- Belt-and-suspenders: even if a future migration re-added a permissive INSERT
-- policy, the missing table privilege still blocks direct writes. UPDATE/DELETE
-- were already blocked by the immutability trigger; revoke the grants too so the
-- privilege surface matches the intent. SELECT is retained (RLS-filtered reads).
--
-- TRUNCATE is the sharp one: it is NOT subject to RLS and NOT caught by the
-- UPDATE/DELETE immutability trigger (that trigger is BEFORE UPDATE OR DELETE),
-- so a role holding TRUNCATE could wipe the ENTIRE cross-tenant chain in one
-- statement — a strictly worse hole than the INSERT path. Supabase's default
-- GRANT ALL leaves TRUNCATE/TRIGGER/REFERENCES on anon+authenticated, so revoke
-- the full non-SELECT surface. (TRIGGER would let a non-owner attach a trigger
-- to the table; REFERENCES is benign but revoked for tidiness.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_events FROM anon, authenticated, public;

-- 3. Chain-head reader — the primitive external anchoring publishes ------------
-- Returns the current head hash + row count for a tenant so an operator (or a
-- future scheduled job) can anchor it to an external immutable store and later
-- prove no rows were rewritten. Membership-guarded like verify_audit_chain.
CREATE OR REPLACE FUNCTION public.audit_chain_head(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_head    text;
  v_at      timestamptz;
  v_count   bigint;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'not a member of this tenant';
  END IF;

  SELECT hash, created_at INTO v_head, v_at
  FROM audit_events
  WHERE tenant_id = p_tenant_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT count(*) INTO v_count FROM audit_events WHERE tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'head_hash', coalesce(v_head, ''),
    'head_at',   v_at,
    'count',     coalesce(v_count, 0)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.audit_chain_head(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.audit_chain_head(uuid) TO authenticated, service_role;
