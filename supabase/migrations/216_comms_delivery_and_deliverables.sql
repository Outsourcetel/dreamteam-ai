-- 216_comms_delivery_and_deliverables.sql
-- ============================================================================
-- EXEC Phase 0.4 (part 1) — the employee's voice + its deliverables.
--
-- A DE could already DRAFT an outbound message (outbound_drafts, DE-A4) — but a
-- human then had to copy it and send it by hand. This closes that: when a human
-- approves an email draft, the platform actually SENDS it (via Resend), so the
-- employee's voice reaches the customer. Email stays draft-for-approval by the
-- founder's standing rule — nothing sends without a person approving.
--
-- Also adds DELIVERABLES: a report/document a DE produces for human review
-- (a renewal account review, an FP&A variance summary). Producing a document
-- isn't destructive — it's the "prepare it for a human" half of the job.
--
-- Dormant-honest: with no RESEND_API_KEY or no verified from-address, an approved
-- email records 'blocked_no_provider' and says so — never a silent failure.
-- GLOBAL — every tenant.
-- ============================================================================

-- ── 1. Real delivery state on the existing draft ────────────────────────────
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'not_sent'
  CHECK (delivery_status IN ('not_sent','sending','sent','failed','blocked_no_provider'));
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS delivery_error text;

-- ── 2. Per-tenant sending identity (the verified from-address) ──────────────
CREATE TABLE IF NOT EXISTS tenant_comms_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  from_email  text,
  from_name   text,
  updated_by  uuid REFERENCES auth.users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_comms_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_comms_read ON tenant_comms_settings;
CREATE POLICY tenant_comms_read ON tenant_comms_settings
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS tenant_comms_admin_write ON tenant_comms_settings;
CREATE POLICY tenant_comms_admin_write ON tenant_comms_settings
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));

CREATE OR REPLACE FUNCTION public.set_tenant_comms_settings(p_from_email text, p_from_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF NOT public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_role_required');
  END IF;
  IF coalesce(p_from_email,'') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_email');
  END IF;
  INSERT INTO tenant_comms_settings (tenant_id, from_email, from_name, updated_by, updated_at)
  VALUES (v_tenant, lower(trim(p_from_email)), nullif(trim(coalesce(p_from_name,'')),''), auth.uid(), now())
  ON CONFLICT (tenant_id) DO UPDATE SET from_email = excluded.from_email, from_name = excluded.from_name, updated_by = excluded.updated_by, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'from_email', lower(trim(p_from_email)));
END; $$;
REVOKE ALL ON FUNCTION public.set_tenant_comms_settings(text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_tenant_comms_settings(text,text) TO authenticated;

-- ── 3. Record a delivery outcome (called by the send-outbound edge fn) ──────
CREATE OR REPLACE FUNCTION public.mark_outbound_delivery(
  p_draft_id uuid, p_status text, p_provider_message_id text DEFAULT NULL, p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de uuid;
BEGIN
  IF p_status NOT IN ('sent','failed','blocked_no_provider','sending') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_status');
  END IF;
  SELECT tenant_id, de_id INTO v_tenant, v_de FROM outbound_drafts WHERE id = p_draft_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  UPDATE outbound_drafts
     SET delivery_status = p_status,
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         delivery_error = p_error,
         status = CASE WHEN p_status = 'sent' THEN 'sent' ELSE status END,
         updated_at = now()
   WHERE id = p_draft_id;
  BEGIN PERFORM append_audit_event_internal(v_tenant,
    (SELECT coalesce(persona_name, name) FROM digital_employees WHERE id = v_de), 'de',
    CASE p_status
      WHEN 'sent' THEN 'Outbound email SENT (human-approved) — draft ' || p_draft_id
      WHEN 'blocked_no_provider' THEN 'Outbound email approved but NOT sent — email provider not configured (add RESEND_API_KEY + a verified from-address)'
      ELSE 'Outbound email delivery ' || p_status || ' — ' || coalesce(p_error,'') END,
    'connector_action',
    jsonb_build_object('kind','outbound_email_delivery','draft_id',p_draft_id,'status',p_status,'provider_message_id',p_provider_message_id));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END; $$;
REVOKE ALL ON FUNCTION public.mark_outbound_delivery(uuid,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_outbound_delivery(uuid,text,text,text) TO service_role;

-- ── 4. Deliverables — a document a DE produces for human review ─────────────
CREATE TABLE IF NOT EXISTS de_deliverables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id         uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id  uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'report' CHECK (kind IN ('report','summary','memo','analysis','review')),
  format        text NOT NULL DEFAULT 'markdown',
  content       text NOT NULL,
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','archived')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_de_deliverables_de ON de_deliverables(tenant_id, de_id, created_at DESC);
ALTER TABLE de_deliverables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_deliverables_tenant_read ON de_deliverables;
CREATE POLICY de_deliverables_tenant_read ON de_deliverables
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

CREATE OR REPLACE FUNCTION public.record_deliverable(
  p_de_id uuid, p_objective_id uuid, p_title text, p_kind text, p_content text, p_format text DEFAULT 'markdown'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de_name text; v_id uuid; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  IF coalesce(p_title,'') = '' OR coalesce(p_content,'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'title_and_content_required');
  END IF;
  INSERT INTO de_deliverables (tenant_id, de_id, objective_id, title, kind, content, format)
  VALUES (v_tenant, p_de_id, p_objective_id, left(p_title,200),
          CASE WHEN p_kind IN ('report','summary','memo','analysis','review') THEN p_kind ELSE 'report' END,
          p_content, coalesce(nullif(p_format,''),'markdown'))
  RETURNING id INTO v_id;
  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
    v_de_name || ' produced a ' || p_kind || ' for review — "' || left(p_title,120) || '"', 'playbook_step',
    jsonb_build_object('kind','deliverable_produced','deliverable_id',v_id,'objective_id',p_objective_id,'title',p_title));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('ok', true, 'deliverable_id', v_id);
END; $$;
REVOKE ALL ON FUNCTION public.record_deliverable(uuid,uuid,text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.record_deliverable(uuid,uuid,text,text,text,text) TO authenticated, service_role;
