-- 296_knowledge_conflict_rpcs.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 (3/3): the conflict-detection RPCs, with EVERY isolation
-- fix from the adversarial audit baked in. Still INERT: nothing calls the probe /
-- record fns yet (the edge worker + trigger + cron are deferred behind the
-- 1-tenant validation gate). get_knowledge_conflicts can back the UI now, returning
-- an honest empty state.
--
-- The 6th planned RPC (invoke_conflict_probe_drain, the cron dispatcher) is
-- deliberately NOT here — it belongs with the automation that spends LLM tokens,
-- which is gated behind the validation gate.
--
-- Isolation posture (audit fixes):
--  • probe_chunk_neighbors / record_knowledge_conflict — service_role ONLY (REVOKE
--    authenticated) + internal auth.uid() guard; these trust p_tenant_id, so the
--    REVOKE is their only boundary. SET LOCAL hnsw.iterative_scan='relaxed_order'
--    (pgvector 0.8 verified live) so the tenant/doc post-filter can't recall-collapse.
--  • get_knowledge_conflicts — explicit caller-membership tenant filter (never trusts
--    a tenant arg).
--  • resolve_knowledge_conflict — tenant+admin-role guarded; authoritative doc
--    constrained to the conflicting pair; authority nudge CLAMPED one tier and scoped
--    to exactly the two docs (can't pump an arbitrary doc's live-ranking weight).
--  • enqueue_conflict_backlog — service_role OR tenant-admin only; keyset pagination
--    (constant cost per call, no O(corpus) anti-join tail).
-- GLOBAL, additive.
-- ============================================================================

-- ── Index-bounded neighbour probe (service-role only) ──
CREATE OR REPLACE FUNCTION public.probe_chunk_neighbors(
  p_tenant_id uuid, p_chunk_id uuid, p_doc_id uuid, p_embedding vector,
  p_k int DEFAULT 5)
RETURNS TABLE(neighbor_chunk_id uuid, neighbor_doc_id uuid, neighbor_content text, distance real)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Only the drain worker (service role / dispatch) may probe — it trusts p_tenant_id.
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'probe_chunk_neighbors: service role only'; END IF;
  -- Keep walking the HNSW index until k tenant/doc-matched rows are found (pgvector
  -- >= 0.8) so a small tenant's true neighbours aren't dropped by the post-filter.
  SET LOCAL hnsw.iterative_scan = 'relaxed_order';
  RETURN QUERY
  SELECT c.id, c.doc_id, c.content, (c.embedding <=> p_embedding)::real AS distance
  FROM knowledge_doc_chunks c
  JOIN knowledge_docs d ON d.id = c.doc_id AND d.is_current
  WHERE c.tenant_id = p_tenant_id
    AND c.id <> p_chunk_id
    AND c.doc_id <> p_doc_id            -- ignore intra-doc chunk overlap
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_embedding
  LIMIT greatest(1, least(p_k, 20));
END $$;
REVOKE ALL ON FUNCTION public.probe_chunk_neighbors(uuid, uuid, uuid, vector, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.probe_chunk_neighbors(uuid, uuid, uuid, vector, int) TO service_role;

-- ── Persist a finding (service-role only, canonical pair, never resurrects) ──
CREATE OR REPLACE FUNCTION public.record_knowledge_conflict(
  p_tenant_id uuid, p_chunk_a uuid, p_doc_a uuid, p_chunk_b uuid, p_doc_b uuid,
  p_relation text, p_distance real, p_signal jsonb DEFAULT '{}', p_confidence real DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lo_chunk uuid; v_lo_doc uuid; v_hi_chunk uuid; v_hi_doc uuid; v_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'record_knowledge_conflict: service role only'; END IF;
  IF p_relation NOT IN ('near_duplicate', 'potential_conflict') THEN RAISE EXCEPTION 'bad relation'; END IF;
  -- Canonical ordering so a pair is stored once regardless of probe direction.
  IF p_chunk_a <= p_chunk_b THEN
    v_lo_chunk := p_chunk_a; v_lo_doc := p_doc_a; v_hi_chunk := p_chunk_b; v_hi_doc := p_doc_b;
  ELSE
    v_lo_chunk := p_chunk_b; v_lo_doc := p_doc_b; v_hi_chunk := p_chunk_a; v_hi_doc := p_doc_a;
  END IF;
  INSERT INTO knowledge_conflicts (tenant_id, chunk_a_id, doc_a_id, chunk_b_id, doc_b_id,
                                   relation, cosine_distance, signal, confidence)
  VALUES (p_tenant_id, v_lo_chunk, v_lo_doc, v_hi_chunk, v_hi_doc,
          p_relation, p_distance, coalesce(p_signal, '{}'), p_confidence)
  ON CONFLICT (tenant_id, chunk_a_id, chunk_b_id, relation) DO UPDATE
    SET cosine_distance = excluded.cosine_distance, signal = excluded.signal,
        confidence = excluded.confidence, updated_at = now()
    WHERE knowledge_conflicts.status = 'open'   -- never resurrect a resolved/dismissed pair
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.record_knowledge_conflict(uuid, uuid, uuid, uuid, uuid, text, real, jsonb, real) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_knowledge_conflict(uuid, uuid, uuid, uuid, uuid, text, real, jsonb, real) TO service_role;

-- ── Review read (caller-membership tenant filter) ──
CREATE OR REPLACE FUNCTION public.get_knowledge_conflicts(
  p_status text DEFAULT 'open', p_relation text DEFAULT NULL, p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE(id uuid, relation text, status text, cosine_distance real, confidence real, signal jsonb,
              doc_a_id uuid, doc_a_title text, doc_b_id uuid, doc_b_title text,
              authoritative_doc_id uuid, detected_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT kc.id, kc.relation, kc.status, kc.cosine_distance, kc.confidence, kc.signal,
         kc.doc_a_id, da.title, kc.doc_b_id, db.title,
         kc.authoritative_doc_id, kc.detected_at
  FROM knowledge_conflicts kc
  JOIN knowledge_docs da ON da.id = kc.doc_a_id
  JOIN knowledge_docs db ON db.id = kc.doc_b_id
  WHERE kc.tenant_id IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid())
    AND kc.status = p_status
    AND (p_relation IS NULL OR kc.relation = p_relation)
  ORDER BY kc.detected_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100) OFFSET greatest(coalesce(p_offset, 0), 0);
$$;
REVOKE ALL ON FUNCTION public.get_knowledge_conflicts(text, text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_knowledge_conflicts(text, text, int, int) TO authenticated, service_role;

-- ── Human resolution (tenant+admin guarded; constrained + clamped authority nudge) ──
CREATE OR REPLACE FUNCTION public.resolve_knowledge_conflict(
  p_conflict_id uuid, p_resolution text, p_authoritative_doc_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c knowledge_conflicts%ROWTYPE; v_winner uuid; v_loser uuid;
BEGIN
  -- FOR UPDATE serializes concurrent resolves so the nudge applies exactly once
  -- (the second caller re-reads the committed status and returns already_resolved).
  SELECT * INTO v_c FROM knowledge_conflicts WHERE id = p_conflict_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  -- Must be an admin/owner of the conflict's OWN tenant. Canonical NULL-safe idiom
  -- (mig 105): positive equality fails CLOSED on a NULL tenant, and ties the role
  -- check to this conflict's tenant (closes the remote-access NOT-IN-NULL path).
  IF NOT (v_c.tenant_id = auth_tenant_id()
          AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_c.status <> 'open' THEN RETURN jsonb_build_object('ok', false, 'error', 'already_resolved'); END IF;
  IF p_resolution NOT IN ('resolved_pick_a', 'resolved_pick_b', 'merged', 'dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_resolution'); END IF;
  -- Authoritative doc, if given, MUST be one of the two in the pair.
  IF p_authoritative_doc_id IS NOT NULL AND p_authoritative_doc_id NOT IN (v_c.doc_a_id, v_c.doc_b_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'authoritative_not_in_pair'); END IF;

  UPDATE knowledge_conflicts
     SET status = p_resolution, authoritative_doc_id = p_authoritative_doc_id,
         decided_by = auth.uid(), decided_at = now(),
         signal = signal || jsonb_build_object('note', p_note)
   WHERE id = p_conflict_id;

  -- One-tier, clamped authority nudge — winner up, loser down — scoped to exactly
  -- the two docs in this pair AND the tenant. Only when a side is picked.
  IF p_resolution IN ('resolved_pick_a', 'resolved_pick_b') THEN
    v_winner := CASE p_resolution WHEN 'resolved_pick_a' THEN v_c.doc_a_id ELSE v_c.doc_b_id END;
    v_loser  := CASE p_resolution WHEN 'resolved_pick_a' THEN v_c.doc_b_id ELSE v_c.doc_a_id END;
    UPDATE knowledge_docs SET authority = least(100, authority + 1)
      WHERE id = v_winner AND tenant_id = v_c.tenant_id;
    UPDATE knowledge_docs SET authority = greatest(0, authority - 1)
      WHERE id = v_loser AND tenant_id = v_c.tenant_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', p_resolution);
END $$;
REVOKE ALL ON FUNCTION public.resolve_knowledge_conflict(uuid, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_knowledge_conflict(uuid, text, uuid, text) TO authenticated, service_role;

-- ── One-time backlog seed for a tenant opting in with an existing corpus ──
-- (keyset pagination: constant cost per call). service_role OR tenant-admin only.
CREATE OR REPLACE FUNCTION public.enqueue_conflict_backlog(
  p_tenant_id uuid, p_limit int DEFAULT 500, p_after_chunk_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int; v_last uuid;
BEGIN
  -- Canonical NULL-safe tenant+role guard (service role bypasses to seed any tenant).
  IF auth.uid() IS NOT NULL
     AND NOT (p_tenant_id = auth_tenant_id()
              AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF NOT is_feature_enabled_internal(p_tenant_id, 'knowledge_conflict_detection') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'detection_disabled');
  END IF;
  WITH batch AS (
    SELECT c.id, c.doc_id, c.tenant_id, c.content_hash
    FROM knowledge_doc_chunks c
    WHERE c.tenant_id = p_tenant_id AND c.embedding IS NOT NULL
      AND (p_after_chunk_id IS NULL OR c.id > p_after_chunk_id)
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
  ), ins AS (
    INSERT INTO knowledge_conflict_probe_queue (tenant_id, chunk_id, doc_id, content_hash)
    SELECT b.tenant_id, b.id, b.doc_id, b.content_hash FROM batch b
    ON CONFLICT (tenant_id, chunk_id) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins), (SELECT max(id) FROM batch) INTO v_n, v_last;
  RETURN jsonb_build_object('ok', true, 'seeded', coalesce(v_n, 0), 'last_chunk_id', v_last);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_conflict_backlog(uuid, int, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_conflict_backlog(uuid, int, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
