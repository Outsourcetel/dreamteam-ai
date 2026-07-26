-- 376_tenant_deletion_requests.sql
-- ============================================================================
-- "Delete my workspace" — the request, not the deletion.
--
-- The frontend (src/lib/dataRightsApi.ts:52) calls request_tenant_deletion and
-- it does not exist anywhere: `grep -rn request_tenant_deletion supabase/ src/`
-- returned exactly one hit, the constant itself. So the delete panel's only
-- possible outcome today is its "service unavailable" banner.
--
-- ── WHY THIS IS A REQUEST AND NOT A SELF-SERVE DELETE ──────────────────────
-- delete_tenant (mig 194, re-issued by mig 371) is PLATFORM-ADMIN ONLY and
-- deliberately so. It requires resolve_platform_capability('tenants.manage'),
-- refuses unless the tenant is ALREADY suspended, demands the slug as
-- confirmation, refuses a tenant with sub-tenants, and refuses to let you delete
-- the tenant you belong to. Those guards are correct and this migration does not
-- weaken any of them.
--
-- A customer therefore cannot delete their own workspace, and pretending
-- otherwise in the UI would be the exact dishonesty this codebase keeps finding.
-- What a customer CAN have is a first-class, auditable, acknowledged request —
-- which is also what a DPA actually commits you to: act on an erasure request
-- within a stated window, not offer a self-service button.
--
-- The grace window is the other reason. An irreversible action with no pause is
-- how a fat-fingered admin loses a company's data — and this database has no
-- automated backups (org is on the Supabase free plan; the backups endpoint
-- returns an empty list). A withdrawable request is the safety the product owes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_deletion_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: if the workspace is deleted, the request to delete it has served
  -- its purpose. tenant_deletion_receipts is the record that must survive.
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  -- The customer's stated reason. Free text, optional, never required — making
  -- someone justify an erasure request is a dark pattern.
  reason        text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'withdrawn', 'completed', 'declined')),
  -- Nothing is actioned before this. Withdrawable by the customer up to here.
  eligible_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  resolved_at   timestamptz,
  resolved_by   uuid,
  resolution_note text
);

COMMENT ON TABLE public.tenant_deletion_requests IS
  'A customer request to erase a workspace. NOT the deletion itself — delete_tenant remains platform-admin only and requires the tenant to be suspended first. Carries a grace window during which the customer may withdraw.';

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_requests_open
  ON public.tenant_deletion_requests (status, eligible_at)
  WHERE status = 'pending';

-- One open request per workspace. A customer clicking twice has not asked twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_deletion_requests_one_open
  ON public.tenant_deletion_requests (tenant_id)
  WHERE status = 'pending';

ALTER TABLE public.tenant_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Members may SEE their own workspace's request — knowing an erasure is pending
-- is part of the point. Writes go through the RPCs below, which is where the
-- confirmation and role checks live.
DROP POLICY IF EXISTS tenant_deletion_requests_select ON public.tenant_deletion_requests;
CREATE POLICY tenant_deletion_requests_select ON public.tenant_deletion_requests
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id() OR public.is_platform_admin());

-- ── Filing a request ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_tenant_deletion(
  p_tenant_id uuid, p_confirm_slug text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_tenant uuid;
  v_t      tenants;
  v_name   text;
  v_id     uuid;
BEGIN
  -- ⚠ p_tenant_id is a HINT TO CHECK, never a selector. The caller's tenant is
  -- resolved server-side; a supplied id that disagrees is rejected outright
  -- rather than quietly ignored, so a confused client cannot file a request
  -- against a workspace it merely named.
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'not a member of any workspace';
  END IF;
  IF p_tenant_id IS NOT NULL AND p_tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'you can only request deletion of the workspace you belong to';
  END IF;

  -- Owner/admin only. Erasing a company's workspace is not a member action.
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RAISE EXCEPTION 'only a workspace owner or admin may request deletion';
  END IF;

  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found'; END IF;

  -- Same confirmation delete_tenant demands, asked at the same moment the human
  -- is actually deciding — not later, by an operator who did not make the choice.
  IF coalesce(p_confirm_slug, '') <> v_t.slug THEN
    RAISE EXCEPTION 'confirmation text must exactly match the workspace id (%)', v_t.slug;
  END IF;

  SELECT full_name INTO v_name FROM profiles WHERE user_id = auth.uid();

  INSERT INTO tenant_deletion_requests (tenant_id, requested_by, requested_by_name, reason)
  VALUES (v_tenant, auth.uid(), v_name, nullif(btrim(coalesce(p_reason, '')), ''))
  ON CONFLICT (tenant_id) WHERE status = 'pending' DO NOTHING
  RETURNING id, eligible_at INTO v_id, v_t.trial_ends_at;

  IF v_id IS NULL THEN
    -- Already pending. Idempotent and honest rather than a duplicate-key error.
    SELECT id INTO v_id FROM tenant_deletion_requests
     WHERE tenant_id = v_tenant AND status = 'pending';
    RETURN jsonb_build_object('ok', true, 'already_pending', true, 'request_id', v_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already_pending', false, 'request_id', v_id,
    'eligible_at', (SELECT eligible_at FROM tenant_deletion_requests WHERE id = v_id),
    'note', 'Filed. Nothing is deleted yet — you can withdraw this during the grace window.');
END $fn$;
REVOKE ALL ON ROUTINE public.request_tenant_deletion(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.request_tenant_deletion(uuid, text, text) TO authenticated;

-- ── Withdrawing one ─────────────────────────────────────────────────────────
-- The grace window is worthless without this.
CREATE OR REPLACE FUNCTION public.withdraw_tenant_deletion_request()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not a member of any workspace'; END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RAISE EXCEPTION 'only a workspace owner or admin may withdraw a deletion request';
  END IF;

  UPDATE tenant_deletion_requests
     SET status = 'withdrawn', resolved_at = now(), resolved_by = auth.uid(),
         resolution_note = 'Withdrawn by the workspace'
   WHERE tenant_id = v_tenant AND status = 'pending'
   RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', v_id IS NOT NULL, 'request_id', v_id);
END $fn$;
REVOKE ALL ON ROUTINE public.withdraw_tenant_deletion_request() FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.withdraw_tenant_deletion_request() TO authenticated;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_cnt int;
BEGIN
  -- Anonymous callers must not reach either function. Signup is open, so
  -- 'authenticated' is the internet — but anon must not even get that far.
  IF has_function_privilege('anon', 'public.request_tenant_deletion(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.withdraw_tenant_deletion_request()', 'EXECUTE') THEN
    RAISE EXCEPTION '376: deletion request functions are anon-callable';
  END IF;

  -- The one-open-request rule must live in the SCHEMA, not in the RPC — an
  -- application-level uniqueness rule is one bug away from two open requests.
  SELECT count(*) INTO v_cnt FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'uq_tenant_deletion_requests_one_open';
  IF v_cnt <> 1 THEN RAISE EXCEPTION '376: the one-open-request index is missing'; END IF;

  -- delete_tenant must NOT have been weakened by this migration.
  IF (SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'delete_tenant')
     !~ 'tenants\.manage'
  THEN RAISE EXCEPTION '376: delete_tenant lost its platform-capability guard'; END IF;

  RAISE NOTICE '376: deletion requests live — request, withdraw, one open per workspace';
END $assert$;

NOTIFY pgrst, 'reload schema';
