-- 228_continuity_scenarios_seed.sql
-- ============================================================================
-- EXEC-2c (part 4) — complete the role's date coverage + seed the three proof
-- scenarios so a case opens end-to-end on the real machine.
--
--   A. Adds two more agreement watchers to the renewal_manager kit (GLOBAL):
--      warranty_expiry → replace, next_reorder_date → reorder. With the mig-226
--      notice_deadline watcher, the role now watches every independent date.
--      Existing renewal DEs are re-stamped idempotently.
--
--   B. Seeds SaaS / managed-service / equipment agreements (+ lines + catalog)
--      for tenant outsourcetel-hq, with dates set RELATIVE to current_date so
--      each falls inside a horizon — the next 5-min Book-of-Work tick opens a
--      renew / renew / replace case automatically. Idempotent (guarded inserts).
--
-- Seed data is tenant-scoped proof data (like the mig-218 golden set); the
-- capability it exercises is global.
-- ============================================================================

-- A. Full agreement-date coverage on the role (additive; preserves mig-226 set)
UPDATE role_archetypes SET watcher_templates = jsonb_build_array(
  jsonb_build_object('kind','date_horizon','label','Renewal approaching (90/60/30 day)','description','Open a renewal case as each notice window is reached.','config',jsonb_build_object('horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active','at_risk'))),
  jsonb_build_object('kind','state_condition','label','Account health dropped below 50','description','Open a save case when an account turns at-risk by health.','config',jsonb_build_object('field','health_score','op','lt','value',50)),
  jsonb_build_object('kind','date_horizon','label','Contract notice window approaching (90/60/30 day)','description','Open a renewal case off an agreement''s notice deadline — before the window closes.','config',jsonb_build_object('source','commercial_agreements','date_field','notice_deadline','motion','renew','horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active','pending'))),
  jsonb_build_object('kind','date_horizon','label','Warranty expiring (90/60/30 day)','description','Open a replacement/warranty-extension case as an asset warranty nears expiry.','config',jsonb_build_object('source','commercial_agreements','date_field','warranty_expiry','motion','replace','horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active'))),
  jsonb_build_object('kind','date_horizon','label','Reorder due (90/60/30 day)','description','Open a reorder case as a consumable/replenishment date approaches.','config',jsonb_build_object('source','commercial_agreements','date_field','next_reorder_date','motion','reorder','horizons_days', jsonb_build_array(90,60,30),'status_filter', jsonb_build_array('active')))
) WHERE key = 'renewal_manager';

-- Re-stamp live renewal DEs (idempotent: install_role_kit skips watchers already
-- present by kind+label and inserts only the two new ones).
DO $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT de.id FROM digital_employees de
    WHERE EXISTS (SELECT 1 FROM work_watchers ww WHERE ww.de_id = de.id AND ww.label = 'Renewal approaching (90/60/30 day)')
  LOOP
    BEGIN PERFORM public.install_role_kit(d.id, 'renewal_manager');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'install_role_kit skipped for DE %: %', d.id, SQLERRM; END;
  END LOOP;
END $$;

-- B. Seed the three proof scenarios for outsourcetel-hq --------------------
DO $$
DECLARE
  v_tenant uuid;
  v_agr uuid;
  v_cat_saas_a uuid; v_cat_saas_b uuid; v_cat_ms uuid; v_cat_equip uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NULL THEN RAISE NOTICE 'outsourcetel-hq not present; skipping continuity seed'; RETURN; END IF;

  -- ── Catalog items (idempotent by tenant+name) ──
  INSERT INTO commercial_catalog_items (tenant_id, kind, name, unit, unit_price_cents, billing_interval)
  SELECT v_tenant, 'subscription', 'Platform — Growth plan', 'seat', 12000, 'annual'
  WHERE NOT EXISTS (SELECT 1 FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Platform — Growth plan');
  INSERT INTO commercial_catalog_items (tenant_id, kind, name, unit, unit_price_cents, billing_interval)
  SELECT v_tenant, 'subscription', 'Analytics add-on', 'seat', 4000, 'annual'
  WHERE NOT EXISTS (SELECT 1 FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Analytics add-on');
  INSERT INTO commercial_catalog_items (tenant_id, kind, name, unit, unit_price_cents, billing_interval)
  SELECT v_tenant, 'service', 'Managed NOC — monthly retainer', 'month', 700000, 'monthly'
  WHERE NOT EXISTS (SELECT 1 FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Managed NOC — monthly retainer');
  INSERT INTO commercial_catalog_items (tenant_id, kind, name, unit, unit_price_cents, billing_interval)
  SELECT v_tenant, 'asset', 'Rack server unit', 'unit', 900000, 'one_time'
  WHERE NOT EXISTS (SELECT 1 FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Rack server unit');

  SELECT id INTO v_cat_saas_a FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Platform — Growth plan';
  SELECT id INTO v_cat_saas_b FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Analytics add-on';
  SELECT id INTO v_cat_ms   FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Managed NOC — monthly retainer';
  SELECT id INTO v_cat_equip FROM commercial_catalog_items WHERE tenant_id = v_tenant AND name = 'Rack server unit';

  -- ── Scenario 1: SaaS subscription (sell-side, renew) ──
  IF NOT EXISTS (SELECT 1 FROM commercial_agreements WHERE tenant_id = v_tenant AND counterparty_name = 'Lakeshore Analytics' AND agreement_type = 'subscription') THEN
    INSERT INTO commercial_agreements (tenant_id, party_side, counterparty_name, agreement_type, title, status, currency,
      auto_renew, notice_period_days, baseline_value_cents,
      start_date, end_date, renewal_date, notice_deadline, pricing_notice_deadline, billing_start_date, attributes)
    VALUES (v_tenant, 'sell', 'Lakeshore Analytics', 'subscription', 'Lakeshore Analytics — Platform subscription', 'active', 'USD',
      true, 30, 12000000,
      current_date - 335, current_date + 30, current_date + 55, current_date + 25, current_date + 15, current_date - 335,
      jsonb_build_object('seed','exec2c','scenario','saas','contractual_increase_pct',7))
    RETURNING id INTO v_agr;
    INSERT INTO agreement_lines (tenant_id, agreement_id, catalog_item_id, description, quantity, unit_price_cents, billing_interval, renewal_eligible)
    VALUES
      (v_tenant, v_agr, v_cat_saas_a, 'Platform — Growth plan (seats)', 800, 12000, 'annual', true),
      (v_tenant, v_agr, v_cat_saas_b, 'Analytics add-on (seats)', 600, 4000, 'annual', true);
  END IF;

  -- ── Scenario 2: Managed service agreement (sell-side, renew/extend + margin) ──
  IF NOT EXISTS (SELECT 1 FROM commercial_agreements WHERE tenant_id = v_tenant AND counterparty_name = 'Meridian Group' AND agreement_type = 'managed_service') THEN
    INSERT INTO commercial_agreements (tenant_id, party_side, counterparty_name, agreement_type, title, status, currency,
      auto_renew, notice_period_days, baseline_value_cents,
      start_date, end_date, renewal_date, notice_deadline, service_activation_date, billing_start_date, attributes)
    VALUES (v_tenant, 'sell', 'Meridian Group', 'managed_service', 'Meridian Group — Managed NOC agreement', 'active', 'USD',
      false, 60, 8400000,
      current_date - 305, current_date + 60, current_date + 80, current_date + 50, current_date - 305, current_date - 305,
      jsonb_build_object('seed','exec2c','scenario','managed_service','sla','99.9','target_margin_pct',35))
    RETURNING id INTO v_agr;
    INSERT INTO agreement_lines (tenant_id, agreement_id, catalog_item_id, description, quantity, unit_price_cents, billing_interval, renewal_eligible)
    VALUES (v_tenant, v_agr, v_cat_ms, 'Managed NOC — monthly retainer', 12, 700000, 'monthly', true);
  END IF;

  -- ── Scenario 3: Equipment purchase + warranty (replace lifecycle) ──
  IF NOT EXISTS (SELECT 1 FROM commercial_agreements WHERE tenant_id = v_tenant AND counterparty_name = 'Harbor Tech' AND agreement_type = 'purchase') THEN
    INSERT INTO commercial_agreements (tenant_id, party_side, counterparty_name, agreement_type, title, status, currency,
      auto_renew, baseline_value_cents,
      start_date, warranty_expiry, replacement_date, service_activation_date, attributes)
    VALUES (v_tenant, 'sell', 'Harbor Tech', 'purchase', 'Harbor Tech — Rack server purchase + warranty', 'active', 'USD',
      false, 4500000,
      current_date - 320, current_date + 40, current_date + 40, current_date - 315,
      jsonb_build_object('seed','exec2c','scenario','equipment','maintenance_plan',true,'eol_months',36))
    RETURNING id INTO v_agr;
    INSERT INTO agreement_lines (tenant_id, agreement_id, catalog_item_id, description, quantity, unit_price_cents, billing_interval, renewal_eligible, motion_hint)
    VALUES (v_tenant, v_agr, v_cat_equip, 'Rack server unit (installed asset) + 12-mo warranty', 5, 900000, 'one_time', false, 'replace');
  END IF;
END $$;
