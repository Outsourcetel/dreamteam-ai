-- 225_commercial_continuity_domain.sql
-- ============================================================================
-- EXEC-2c — Commercial Continuity: the renewal EMPLOYEE grows a real world.
--
-- The renewal_manager (mig 218) works ONE date field: customer_accounts.renewal_date.
-- That is fine for a SaaS renewal, but the job is really "commercial continuity":
-- renewals, extensions, reorders, replacements, warranties, and buy-side vendor
-- contracts — each with its OWN dates (a notice deadline is NOT the end date) and
-- its OWN motion (renew vs reorder vs replace vs switch_supplier).
--
-- This migration adds the thin, typed SPINE that lets the SAME employee reason
-- over that world, WITHOUT duplicating anything:
--   • It does NOT create a new case container. The case stays a de_objectives row
--     (the proven work spine). continuity_cases is a typed FACET keyed 1:1 to an
--     objective — motion, stage, agreement, baseline, forecast, risk — so the
--     work loop is unchanged and nothing forks.
--   • It does NOT create a new employee. mig 226 upgrades renewal_manager in place.
--   • Dates are stored INDEPENDENTLY. We never infer notice_deadline from end_date.
--
-- Scope here is deliberately the irreducible spine (agreements, lines, catalog,
-- case facet, configurable stages, stage history). The rest of the commercial
-- model (quotes, stakeholders, obligations, forecasts-as-rows) is additive on top
-- of this later. Pure additive DDL + a global default-stage seed — GLOBAL, every
-- tenant, dormant until an agreement exists.
-- ============================================================================

-- 1. Shared catalog — one item model, type-specific detail in typed attributes -
-- A subscription, a licence, a service, a SKU, an asset and a warranty are all
-- catalog items with a KIND; genuinely type-specific extras live in attributes,
-- but price/interval/unit — the fields the DE reasons over — stay typed columns.
CREATE TABLE IF NOT EXISTS commercial_catalog_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('subscription','license','service','sku','asset','warranty','maintenance','usage','other')),
  name             text NOT NULL,
  sku_code         text,
  unit             text,                    -- seat | device | location | unit | hour | GB …
  unit_price_cents bigint,
  billing_interval text NOT NULL DEFAULT 'one_time'
                     CHECK (billing_interval IN ('one_time','monthly','quarterly','annual','usage','custom')),
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant ON commercial_catalog_items(tenant_id) WHERE active;
ALTER TABLE commercial_catalog_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_items_tenant_read ON commercial_catalog_items;
CREATE POLICY catalog_items_tenant_read ON commercial_catalog_items
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS catalog_items_admin_write ON commercial_catalog_items;
CREATE POLICY catalog_items_admin_write ON commercial_catalog_items
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']));

-- 2. Commercial agreement — the thing that continues. Sell-side OR buy-side. ---
-- EVERY date is its own column: the anti-inference guarantee. A DE watching a
-- notice_deadline never confuses it with end_date.
CREATE TABLE IF NOT EXISTS commercial_agreements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id            uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,  -- sell-side link (nullable: buy-side/vendor)
  party_side            text NOT NULL DEFAULT 'sell' CHECK (party_side IN ('sell','buy')),
  counterparty_name     text NOT NULL,       -- customer (sell) or vendor (buy)
  agreement_type        text NOT NULL DEFAULT 'subscription'
                          CHECK (agreement_type IN ('subscription','maintenance','managed_service','retainer','staff_aug',
                                                    'sow','purchase','lease','rental','license','warranty','supplier_contract','other')),
  title                 text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('draft','active','pending','expired','terminated','superseded')),
  currency              text NOT NULL DEFAULT 'USD',
  auto_renew            boolean NOT NULL DEFAULT false,
  notice_period_days    integer,
  baseline_value_cents  bigint,              -- current annualized/total value (the continuity baseline)
  -- ── Independent dates (never inferred from one another) ──
  start_date            date,
  end_date              date,
  renewal_date          date,
  notice_deadline       date,
  cancellation_deadline date,
  pricing_notice_deadline date,
  warranty_expiry       date,
  next_reorder_date     date,
  replacement_date      date,
  expected_decision_date  date,
  expected_signature_date date,
  service_activation_date date,
  billing_start_date    date,
  -- ── Evidence + extension ──
  source_document       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {url, extracted_at, confidence, citations:[...]}
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreements_tenant ON commercial_agreements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agreements_account ON commercial_agreements(account_id) WHERE account_id IS NOT NULL;
-- Horizon-scan indexes (the Book of Work reads these on every tick).
CREATE INDEX IF NOT EXISTS idx_agreements_notice ON commercial_agreements(tenant_id, notice_deadline) WHERE notice_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreements_renewal ON commercial_agreements(tenant_id, renewal_date) WHERE renewal_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreements_warranty ON commercial_agreements(tenant_id, warranty_expiry) WHERE warranty_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreements_reorder ON commercial_agreements(tenant_id, next_reorder_date) WHERE next_reorder_date IS NOT NULL;
ALTER TABLE commercial_agreements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agreements_tenant_read ON commercial_agreements;
CREATE POLICY agreements_tenant_read ON commercial_agreements
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS agreements_admin_write ON commercial_agreements;
CREATE POLICY agreements_admin_write ON commercial_agreements
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']));

-- 3. Agreement lines — multiple lines, each with its OWN dates/interval/eligibility
CREATE TABLE IF NOT EXISTS agreement_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agreement_id      uuid NOT NULL REFERENCES commercial_agreements(id) ON DELETE CASCADE,
  catalog_item_id   uuid REFERENCES commercial_catalog_items(id) ON DELETE SET NULL,
  description       text NOT NULL,
  quantity          numeric NOT NULL DEFAULT 1,
  unit_price_cents  bigint,
  billing_interval  text NOT NULL DEFAULT 'annual'
                      CHECK (billing_interval IN ('one_time','monthly','quarterly','annual','usage','custom')),
  line_start_date   date,
  line_end_date     date,
  renewal_eligible  boolean NOT NULL DEFAULT true,
  motion_hint       text,                    -- optional per-line default motion (renew|reorder|replace…)
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_lines_agr ON agreement_lines(agreement_id);
ALTER TABLE agreement_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agreement_lines_tenant_read ON agreement_lines;
CREATE POLICY agreement_lines_tenant_read ON agreement_lines
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS agreement_lines_admin_write ON agreement_lines;
CREATE POLICY agreement_lines_admin_write ON agreement_lines
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']));

-- 4. Configurable stages — tenant-owned, NOT hardcoded in the engine ----------
CREATE TABLE IF NOT EXISTS continuity_stage_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stage_key    text NOT NULL,
  label        text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  category     text NOT NULL DEFAULT 'open' CHECK (category IN ('open','won','lost','terminated','expired')),
  is_terminal  boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stage_key)
);
ALTER TABLE continuity_stage_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS continuity_stage_config_tenant_read ON continuity_stage_config;
CREATE POLICY continuity_stage_config_tenant_read ON continuity_stage_config
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS continuity_stage_config_admin_write ON continuity_stage_config;
CREATE POLICY continuity_stage_config_admin_write ON continuity_stage_config
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));

-- 5. Continuity case — a TYPED FACET of de_objectives, not a second case table -
-- objective_id is BOTH the PK and the FK: exactly one facet per case, and the
-- facet dies with the case. The de-work loop keeps driving de_objectives; this
-- only carries the commercial specifics that don't belong in a generic objective.
CREATE TABLE IF NOT EXISTS continuity_cases (
  objective_id            uuid PRIMARY KEY REFERENCES de_objectives(id) ON DELETE CASCADE,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id                   uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  agreement_id            uuid REFERENCES commercial_agreements(id) ON DELETE SET NULL,
  account_id              uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  motion                  text NOT NULL DEFAULT 'renew'
                            CHECK (motion IN ('renew','extend','early_renew','reorder','replenish','replace','upgrade',
                                              'downgrade','expand','contract','consolidate','split','renegotiate',
                                              'pause','terminate','allow_expiry','switch_supplier')),
  stage_key               text,               -- references a continuity_stage_config.stage_key (soft ref: stays valid if config changes)
  party_side              text NOT NULL DEFAULT 'sell' CHECK (party_side IN ('sell','buy')),
  baseline_cents          bigint,
  forecast_cents          bigint,
  probability_pct         integer CHECK (probability_pct IS NULL OR (probability_pct BETWEEN 0 AND 100)),
  expected_uplift_cents   bigint,
  expected_contraction_cents bigint,
  forecast_category       text CHECK (forecast_category IS NULL OR forecast_category IN ('pipeline','best_case','commit','closed','at_risk','excluded')),
  risk_level              text CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','critical')),
  readiness_score         integer CHECK (readiness_score IS NULL OR (readiness_score BETWEEN 0 AND 100)),
  outcome                 text,               -- won | lost | terminated | expired | …
  loss_reason             text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_continuity_cases_tenant ON continuity_cases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_continuity_cases_agreement ON continuity_cases(agreement_id) WHERE agreement_id IS NOT NULL;
ALTER TABLE continuity_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS continuity_cases_tenant_read ON continuity_cases;
CREATE POLICY continuity_cases_tenant_read ON continuity_cases
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No tenant write policy: the facet is written by the engine (service context) and
-- by gated write-back RPCs in mig 226, never by free-form client writes.

-- 6. Stage history — the audit spine for motion/stage transitions -------------
CREATE TABLE IF NOT EXISTS continuity_case_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  objective_id  uuid NOT NULL REFERENCES de_objectives(id) ON DELETE CASCADE,
  from_stage    text,
  to_stage      text,
  motion        text,
  actor_kind    text NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('de','human','system')),
  summary       text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_continuity_case_events_obj ON continuity_case_events(objective_id, created_at DESC);
ALTER TABLE continuity_case_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS continuity_case_events_tenant_read ON continuity_case_events;
CREATE POLICY continuity_case_events_tenant_read ON continuity_case_events
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- 7. Seed the DEFAULT stage set for every existing tenant ---------------------
-- Tenants may edit/extend these freely; the engine never hardcodes a stage.
-- (New-tenant provisioning gets this seed wired in a follow-up; existing tenants
-- are covered here, ON CONFLICT DO NOTHING so re-runs are safe.)
INSERT INTO continuity_stage_config (tenant_id, stage_key, label, sort_order, category, is_terminal)
SELECT t.id, s.stage_key, s.label, s.sort_order, s.category, s.is_terminal
FROM tenants t
CROSS JOIN (VALUES
  ('discovered',            'Discovered',            10,  'open',       false),
  ('data_validation',       'Data validation',       20,  'open',       false),
  ('not_ready',             'Not ready',             30,  'open',       false),
  ('ready',                 'Ready',                 40,  'open',       false),
  ('outreach_planned',      'Outreach planned',      50,  'open',       false),
  ('outreach_started',      'Outreach started',      60,  'open',       false),
  ('discovery',             'Discovery',             70,  'open',       false),
  ('strategy_defined',      'Strategy defined',      80,  'open',       false),
  ('proposal_preparation',  'Proposal preparation',  90,  'open',       false),
  ('proposal_sent',         'Proposal sent',         100, 'open',       false),
  ('negotiation',           'Negotiation',           110, 'open',       false),
  ('internal_approval',     'Internal approval',     120, 'open',       false),
  ('customer_procurement',  'Customer / procurement',130, 'open',       false),
  ('legal_review',          'Legal review',          140, 'open',       false),
  ('verbal_commit',         'Verbal commit',         150, 'open',       false),
  ('signature_pending',     'Signature pending',     160, 'open',       false),
  ('purchase_order_pending','Purchase order pending',170, 'open',       false),
  ('invoicing',             'Invoicing',             180, 'open',       false),
  ('payment_pending',       'Payment pending',       190, 'open',       false),
  ('activation_pending',    'Activation pending',    200, 'open',       false),
  ('completed',             'Completed',             210, 'won',        true),
  ('lost',                  'Lost',                  220, 'lost',       true),
  ('terminated',            'Terminated',            230, 'terminated', true),
  ('expired',               'Expired',               240, 'expired',    true)
) AS s(stage_key, label, sort_order, category, is_terminal)
ON CONFLICT (tenant_id, stage_key) DO NOTHING;
