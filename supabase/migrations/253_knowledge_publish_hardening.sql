-- 253_knowledge_publish_hardening.sql
-- ============================================================================
-- Ledger-2 (docs/16, Knowledge audit gaps #2 + #3):
--  A. The eval gate becomes SERVER-SIDE. It was client-only and fail-open —
--     the Ingestion quick-add and any direct insert published ungated. A
--     BEFORE INSERT trigger now blocks HUMAN inserts while the tenant's
--     latest finished eval run is failed, unless the insert carries the
--     'eval-gate-override' tag (the client's audited override path).
--     Exempt by design: service-role writers (connector sync, edge
--     pipelines — they have their own controls) and revision applications
--     (previous_version_id set — an approved fix must land even mid-red).
--  B. An approved gap-fix revision finally SEEDS the golden exam: the gap
--     cluster's representative question becomes a golden_qa row — INACTIVE,
--     so the founder reviews/activates it (no fabricated expectations).
--     Closes the demo-only "added to the eval suite" narrative honestly.
-- ============================================================================

-- ── A. Server-side publish gate ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gate_knowledge_publish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gate record;
BEGIN
  -- Humans only: service-role pipelines and unauthenticated internals pass.
  IF coalesce(auth.role(), '') <> 'authenticated' THEN RETURN NEW; END IF;
  -- Revisions are the FIX path — never gate them.
  IF NEW.previous_version_id IS NOT NULL THEN RETURN NEW; END IF;
  -- The audited override tag from the client dialog passes.
  IF NEW.tags IS NOT NULL AND 'eval-gate-override' = ANY(NEW.tags) THEN RETURN NEW; END IF;

  SELECT status, passed, failed INTO v_gate
  FROM eval_gate WHERE tenant_id = NEW.tenant_id;
  IF v_gate.status = 'failed' THEN
    RAISE EXCEPTION 'eval_gate_failed: your latest evaluation run failed (% passed, % failed). Fix the failing answers in the Proving Ground, or use the override in the Library editor — overrides are recorded on the audit trail.',
      coalesce(v_gate.passed, 0), coalesce(v_gate.failed, 0)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_gate_knowledge_publish ON knowledge_docs;
CREATE TRIGGER trg_gate_knowledge_publish BEFORE INSERT ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION public.gate_knowledge_publish();

-- ── B. apply_knowledge_revision — faithful reproduction + golden seeding ────
CREATE OR REPLACE FUNCTION public.apply_knowledge_revision(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_req           record;
  v_new_doc_id    uuid;
  v_actor_name    text;
  v_rep_inquiry   text;
  v_cluster       record;
begin
  select * into v_req from knowledge_revision_requests where id = p_request_id;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_req.status);
  end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select coalesce(full_name, 'A reviewer') into v_actor_name from profiles where user_id = v_user;
  v_actor_name := coalesce(v_actor_name, 'A reviewer');

  insert into knowledge_docs (
    tenant_id, title, content, source, tags, previous_version_id, is_current, visibility
  )
  select
    v_req.tenant_id, v_req.proposed_title, v_req.proposed_body_md, 'paste',
    coalesce((select tags from knowledge_docs where id = v_req.source_doc_id), '{}'),
    v_req.source_doc_id, true,
    coalesce((select visibility from knowledge_docs where id = v_req.source_doc_id), 'tenant')
  returning id into v_new_doc_id;

  if v_req.source_doc_id is not null then
    update knowledge_docs set is_current = false where id = v_req.source_doc_id;
  end if;

  update knowledge_revision_requests
    set status = 'applied', decided_by = v_user, decided_at = now(), applied_doc_id = v_new_doc_id
    where id = p_request_id;

  perform append_audit_event(
    v_req.tenant_id, v_actor_name, case when v_user is null then 'system' else 'human' end,
    v_actor_name || ' approved and applied a knowledge revision — "' || v_req.proposed_title || '"',
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_applied', 'revision_request_id', p_request_id,
      'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id)
  );

  update knowledge_gap_clusters
  set status = 'resolved', fix_applied_at = now(), updated_at = now()
  where revision_request_id = p_request_id and status = 'revision_requested';

  -- Ledger-2B: seed the golden exam from the resolved gap — the cluster's
  -- representative question becomes an INACTIVE golden_qa row (founder
  -- reviews expected fragments and activates it). Dedup on exact question.
  select c.*, er.inquiry into v_cluster
  from knowledge_gap_clusters c
  left join evidence_runs er on er.id = c.representative_run_id
  where c.revision_request_id = p_request_id
  limit 1;
  v_rep_inquiry := v_cluster.inquiry;
  if v_rep_inquiry is not null and length(btrim(v_rep_inquiry)) >= 8 then
    insert into golden_qa (tenant_id, question, expected_fragments, min_confidence, category, active)
    select v_req.tenant_id, btrim(v_rep_inquiry), ARRAY[v_req.proposed_title], 60,
           coalesce(v_cluster.category, 'support'), false
    where not exists (
      select 1 from golden_qa g
      where g.tenant_id = v_req.tenant_id and g.question = btrim(v_rep_inquiry)
    );
  end if;

  return jsonb_build_object('ok', true, 'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id);
end $$;

NOTIFY pgrst, 'reload schema';
