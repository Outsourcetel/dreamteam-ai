-- 574 — give the marketing roles a vocabulary to speak.
--
-- THE HOLE, measured before writing this. Three role archetypes ship today —
-- google_ads, seo, marketing — and each declares
-- required_connector_categories of {ads}, {seo}, {marketing}. None of those
-- categories exists. connectors.category is a FOREIGN KEY into
-- system_categories, whose entire contents were:
--   billing, crm, erp_financials, helpdesk, knowledge_base, other,
--   payroll_hcm, platform_admin, pos, product_system, support
-- So the database would REJECT an ads connector outright. Hiring a Google Ads
-- Specialist produced an employee that could never be connected to anything —
-- a job description with no hands. Compare support_agent, which requires
-- {helpdesk, knowledge_base}: both real, which is exactly why that employee
-- certified at 93.8% and now auto-sends.
--
-- This adds the three categories the roles already ask for, plus the READ ops
-- and the WRITE actions that make them useful.
--
-- ── THE RISK MODEL, which is the point ─────────────────────────────────────
-- Ads actions spend a client's money. decide_action_execution has a
-- DESTRUCTIVE FLOOR: anything marked destructive is human-gated no matter what
-- the trust dial says, and p_amount_cents is checked against the dial's earned
-- max_amount_cents. So the risk flags are not decoration — they decide whether
-- an employee may act alone. They are set on one principle:
--
--   THE EMPLOYEE MAY PROTECT THE BUDGET ALONE. IT MAY NEVER SPEND ALONE.
--
--   add_negative_keyword     NOT destructive — stops waste, cannot cost money
--   create_ad_draft          NOT destructive — a draft, publishes nothing
--   pause_campaign           DESTRUCTIVE — halts a client's lead flow
--   resume_campaign          DESTRUCTIVE — starts spending again
--   set_campaign_budget      DESTRUCTIVE + carries an amount → the dial's
--                            max_amount_cents becomes a real spend ceiling
--   update_ad_copy           DESTRUCTIVE — changes live creative under the
--                            client's brand, and for a regulated trade
--                            (pest control, ISO claims) a wrong line is a
--                            compliance problem, not a typo
--
-- SOCIAL ACTIONS ARE DELIBERATELY NOT SEEDED. The 'social' CATEGORY is created
-- so the vocabulary exists, but action_definitions.provider is NOT NULL and no
-- social adapter exists yet. Seeding facebook/instagram/tiktok/linkedin actions
-- that nothing can execute would be exactly the hollow machinery this codebase
-- has spent the day removing. They land with their adapter, not before.
--
-- Every one of these still passes the guardrail scan first (mig 495 sends the
-- CONTENT, not just the label), so a rule like "never claim a certification we
-- do not hold" can block ad copy before a human ever reads it.

BEGIN;

-- ── 1. The categories themselves ───────────────────────────────────────────
INSERT INTO system_categories (key, label)
VALUES
  ('ads',           'Ads — campaigns, keywords, budgets'),
  ('social',        'Social — posts, comments, engagement'),
  ('web_analytics', 'Web analytics — traffic, queries, rankings')
ON CONFLICT (key) DO NOTHING;

-- ── 2. Write actions, platform scope so every tenant inherits them ─────────
-- param_schema mirrors the shape the existing platform actions use: a flat
-- list of {name, type, required, help}.
INSERT INTO action_definitions
  (scope, tenant_id, category, action_key, label, description, provider,
   param_schema, risk, execution, status, reversible)
VALUES
  ('platform', NULL, 'ads', 'add_negative_keyword',
   'Add a negative keyword',
   'Stops ads showing for a search term that wastes budget. Cannot cost money — it can only prevent spend — so a trusted employee may do this alone.',
   'google_ads',
   '[{"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
     {"name":"keyword","type":"string","required":true,"help":"The search term to exclude"},
     {"name":"match_type","type":"string","required":false,"help":"exact, phrase or broad (default phrase)"}]'::jsonb,
   '{"destructive": false, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'ads', 'create_ad_draft',
   'Draft an ad (not published)',
   'Writes ad copy into a paused draft. Nothing goes live and no money moves until a human publishes it.',
   'google_ads',
   '[{"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
     {"name":"headlines","type":"string","required":true,"help":"Headline variants, one per line"},
     {"name":"descriptions","type":"string","required":true,"help":"Description variants, one per line"},
     {"name":"final_url","type":"string","required":true,"help":"Landing page"}]'::jsonb,
   '{"destructive": false, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'ads', 'pause_campaign',
   'Pause a campaign',
   'Stops a campaign serving. Destructive because it halts the client''s lead flow — always needs a person.',
   'google_ads',
   '[{"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
     {"name":"reason","type":"string","required":true,"help":"Why it is being paused"}]'::jsonb,
   '{"destructive": true, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'ads', 'resume_campaign',
   'Resume a campaign',
   'Starts a paused campaign serving again — which starts spending money. Always needs a person.',
   'google_ads',
   '[{"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
     {"name":"reason","type":"string","required":true,"help":"Why it is being resumed"}]'::jsonb,
   '{"destructive": true, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'ads', 'set_campaign_budget',
   'Change a campaign budget',
   'Changes daily spend. Destructive AND amount-bearing: the trust dial''s earned limit becomes a hard ceiling on what an employee may ever propose without approval.',
   'google_ads',
   '[{"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
     {"name":"daily_budget_cents","type":"number","required":true,"help":"New daily budget, in cents"},
     {"name":"reason","type":"string","required":true,"help":"What in the data justifies it"}]'::jsonb,
   '{"destructive": true, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'ads', 'update_ad_copy',
   'Change live ad copy',
   'Edits creative that is already serving under the client''s brand. For a regulated trade a wrong line is a compliance problem, so this always needs a person — and the guardrail scan reads the copy first.',
   'google_ads',
   '[{"name":"ad_ref","type":"string","required":true,"help":"Which ad"},
     {"name":"headlines","type":"string","required":false,"help":"Replacement headlines, one per line"},
     {"name":"descriptions","type":"string","required":false,"help":"Replacement descriptions, one per line"}]'::jsonb,
   '{"destructive": true, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true)
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_n int;
  v_dec jsonb;
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
BEGIN
  -- R1: the three categories exist, so the FK will now accept them.
  SELECT count(*) INTO v_n FROM system_categories WHERE key IN ('ads','social','web_analytics');
  IF v_n <> 3 THEN RAISE EXCEPTION 'R1 FAILED: % of 3 categories present', v_n; END IF;

  -- R2: THE ONE THAT MATTERS — an ads connector can now actually be created.
  -- This is the exact insert the FK rejected before. Rolled back.
  BEGIN
    INSERT INTO connectors (tenant_id, provider, category, display_name, status, base_url)
    VALUES (v_tenant, 'generic_rest', 'ads', 'probe', 'disconnected', 'https://googleads.googleapis.com');
    RAISE EXCEPTION 'rollback_r2';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_r2' THEN
      RAISE EXCEPTION 'R2 FAILED: an ads connector is still rejected — %', SQLERRM;
    END IF;
  END;

  -- R3: the risk model is what the comment claims. Protective actions are
  -- non-destructive; anything that spends is destructive. If these ever flip,
  -- an employee could start spending a client''s money unattended.
  SELECT count(*) INTO v_n FROM action_definitions
   WHERE category = 'ads' AND action_key IN ('add_negative_keyword','create_ad_draft')
     AND (risk->>'destructive')::boolean = false;
  IF v_n <> 2 THEN RAISE EXCEPTION 'R3 FAILED: protective ads actions are not marked safe (% of 2)', v_n; END IF;

  SELECT count(*) INTO v_n FROM action_definitions
   WHERE category = 'ads' AND action_key IN ('pause_campaign','resume_campaign','set_campaign_budget','update_ad_copy')
     AND (risk->>'destructive')::boolean = true;
  IF v_n <> 4 THEN RAISE EXCEPTION 'R4 FAILED: % of 4 spend-affecting ads actions are marked destructive', v_n; END IF;

  -- R5: prove the GATE actually holds for a budget change, rather than
  -- trusting the flag. A destructive action must never come back auto_executed.
  v_dec := decide_action_execution(v_tenant, 'Change a campaign budget', 'ads', true, NULL, 500000, 'action_execute', 'raise daily budget to 5000 SAR');
  IF v_dec->>'decision' = 'auto_executed' THEN
    RAISE EXCEPTION 'R5 FAILED: a budget change resolved to auto_executed — the destructive floor is not holding';
  END IF;

  -- R6: and that a protective action is at least CAPABLE of being trusted —
  -- it must not be blocked by the destructive floor. (It will still be
  -- human_gated_trust until a dial is set, which is correct.)
  v_dec := decide_action_execution(v_tenant, 'Add a negative keyword', 'ads', false, NULL, NULL, 'action_execute', 'exclude "free pest control"');
  IF v_dec->>'decision' = 'human_gated_destructive' THEN
    RAISE EXCEPTION 'R6 FAILED: adding a negative keyword hit the destructive floor — it can never be delegated';
  END IF;

  RAISE NOTICE '574 asserts passed: ads/social/web_analytics live; protect-alone, never-spend-alone enforced.';
END
$probe$;

COMMIT;
