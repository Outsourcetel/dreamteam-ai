-- 251_agreement_entry_path.sql
-- ============================================================================
-- W4-B (docs/16 gap #1 for the Customers module): commercial_agreements had
-- NO creation path in the product — only the mig-228 seed — so Commercial
-- Continuity was permanently empty for every non-seeded tenant. This adds the
-- guarded entry RPC the UI calls. Table CHECKs stay the source of truth for
-- enums; the RPC validates tenancy + role and passes through.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.upsert_commercial_agreement(
  p_id                uuid DEFAULT NULL,          -- null = create
  p_title             text DEFAULT NULL,
  p_counterparty_name text DEFAULT NULL,
  p_account_id        uuid DEFAULT NULL,
  p_party_side        text DEFAULT 'sell',
  p_agreement_type    text DEFAULT 'subscription',
  p_status            text DEFAULT 'active',
  p_baseline_value_cents bigint DEFAULT NULL,
  p_auto_renew        boolean DEFAULT false,
  p_notice_period_days integer DEFAULT NULL,
  p_start_date        date DEFAULT NULL,
  p_end_date          date DEFAULT NULL,
  p_renewal_date      date DEFAULT NULL,
  p_notice_deadline   date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(
       ARRAY['tenant_owner','tenant_admin','tenant_manager']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF p_id IS NULL AND (length(btrim(coalesce(p_title,''))) < 2
       OR length(btrim(coalesce(p_counterparty_name,''))) < 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'title_and_counterparty_required');
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM customer_accounts WHERE id = p_account_id AND tenant_id = v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_account');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO commercial_agreements (
      tenant_id, title, counterparty_name, account_id, party_side, agreement_type,
      status, baseline_value_cents, auto_renew, notice_period_days,
      start_date, end_date, renewal_date, notice_deadline, created_by)
    VALUES (
      v_tenant, btrim(p_title), btrim(p_counterparty_name), p_account_id, p_party_side,
      p_agreement_type, p_status, p_baseline_value_cents, coalesce(p_auto_renew,false),
      p_notice_period_days, p_start_date, p_end_date, p_renewal_date, p_notice_deadline,
      auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE commercial_agreements SET
      title = coalesce(btrim(p_title), title),
      counterparty_name = coalesce(btrim(p_counterparty_name), counterparty_name),
      account_id = coalesce(p_account_id, account_id),
      party_side = coalesce(p_party_side, party_side),
      agreement_type = coalesce(p_agreement_type, agreement_type),
      status = coalesce(p_status, status),
      baseline_value_cents = coalesce(p_baseline_value_cents, baseline_value_cents),
      auto_renew = coalesce(p_auto_renew, auto_renew),
      notice_period_days = coalesce(p_notice_period_days, notice_period_days),
      start_date = coalesce(p_start_date, start_date),
      end_date = coalesce(p_end_date, end_date),
      renewal_date = coalesce(p_renewal_date, renewal_date),
      notice_deadline = coalesce(p_notice_deadline, notice_deadline),
      updated_at = now()
    WHERE id = p_id AND tenant_id = v_tenant
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  END IF;

  BEGIN
    PERFORM public.append_audit_event(
      p_tenant_id => v_tenant, p_actor => 'You', p_actor_type => 'human',
      p_action => CASE WHEN p_id IS NULL THEN 'Agreement created — "' || btrim(p_title) || '"'
                       ELSE 'Agreement updated — ' || v_id::text END,
      p_category => 'config_change',
      p_detail => jsonb_build_object('kind','commercial_agreement','agreement_id', v_id));
  EXCEPTION WHEN OTHERS THEN NULL; -- audit best-effort; the write itself stands
  END;
  RETURN jsonb_build_object('ok', true, 'agreement_id', v_id);
EXCEPTION WHEN check_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', 'invalid_value: ' || SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.upsert_commercial_agreement(uuid,text,text,uuid,text,text,text,bigint,boolean,integer,date,date,date,date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_commercial_agreement(uuid,text,text,uuid,text,text,text,bigint,boolean,integer,date,date,date,date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
