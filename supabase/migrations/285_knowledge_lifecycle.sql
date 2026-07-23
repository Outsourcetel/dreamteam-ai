-- 285_knowledge_lifecycle.sql
-- ============================================================================
-- KNOWLEDGE PHASE 3 — WS6: document lifecycle governance. knowledge_docs had no
-- owner, no review cadence, no expiry — freshness was only an age counter. This
-- adds ownership + a review cadence + an expiry, and RPCs to set them and to
-- record a re-verification (stamping last_verified_at, mig 101). Surfaces the
-- EXISTING authority column (mig 236, no UI today) so retrieval weight is
-- tunable. GLOBAL, additive; tenant-verified writes.
-- ============================================================================

ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS owner_user_id       uuid;
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS review_interval_days int;
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS expires_at          timestamptz;

-- Record a re-verification: "confirmed still accurate today". Distinct from an
-- edit (updated_at) — this is the lifecycle signal the Hub's stale tile reads.
CREATE OR REPLACE FUNCTION public.mark_doc_verified(p_doc_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  UPDATE knowledge_docs SET last_verified_at = now(), updated_at = updated_at
   WHERE id = p_doc_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'verified_at', now());
END $$;
REVOKE ALL ON FUNCTION public.mark_doc_verified(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_doc_verified(uuid) TO authenticated, service_role;

-- Set lifecycle fields in one call (any NULL clears that field via the flags).
-- authority is clamped 0..100. owner/review/expiry are set as given.
CREATE OR REPLACE FUNCTION public.set_doc_lifecycle(
  p_doc_id uuid,
  p_owner_user_id uuid DEFAULT NULL,
  p_review_interval_days int DEFAULT NULL,
  p_authority int DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  UPDATE knowledge_docs SET
    owner_user_id        = p_owner_user_id,
    review_interval_days = CASE WHEN p_review_interval_days IS NULL THEN NULL
                                ELSE greatest(1, p_review_interval_days) END,
    authority            = CASE WHEN p_authority IS NULL THEN authority
                                ELSE greatest(0, least(100, p_authority)) END,
    expires_at           = p_expires_at,
    updated_at           = now()
   WHERE id = p_doc_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_doc_lifecycle(uuid, uuid, int, int, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_doc_lifecycle(uuid, uuid, int, int, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
