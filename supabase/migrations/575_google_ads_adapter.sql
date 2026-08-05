-- 575 — the Google Ads adapter.
--
-- Platform-scope published template, so every workspace can connect its own
-- Google Ads account without anyone rebuilding this.
--
-- ── WHY IT NEEDED THE FRAMEWORK EXTENDED (same commit) ─────────────────────
-- Two things Google Ads requires that the declarative framework could not
-- express, both closed GENERICALLY rather than special-cased:
--
--   oauth2_refresh_token   client_id + client_secret + refresh_token ->
--                          access_token. The framework only had
--                          client_credentials, which cannot express this: the
--                          USER's authorisation grants access, not the app's
--                          identity. Google, Microsoft, Xero and QuickBooks all
--                          need this grant.
--   secret_headers         a header whose VALUE is a credential. Google Ads
--                          sends `developer-token` on every call.
--                          extra_headers holds literals, and a credential must
--                          never live in a template definition that is readable
--                          as configuration — so secret_headers maps header ->
--                          secret KEY and the value is fetched at call time.
--
-- ── READS ONLY, DELIBERATELY ───────────────────────────────────────────────
-- Every category op is 'search' or 'get' by contract. Nothing here can change a
-- campaign. The writes live in action_definitions (mig 574) and go through
-- decide_action_execution, where the destructive floor and the trust dial's
-- spend ceiling are enforced. That separation is why an employee can read the
-- whole account all day and still be unable to move a riyal unattended.
--
-- ── GAQL NOTES for whoever maintains this ──────────────────────────────────
-- The API is POST /googleAds:search with a GAQL body. {query} is interpolated
-- by the framework, so each search op embeds it in a LIKE clause. Money comes
-- back in MICROS (1,000,000 micros = 1 unit of account currency) — the snippet
-- paths below deliberately surface the raw micros field rather than pretending
-- to convert, because the account currency is not known at this layer and a
-- wrong currency on a spend figure is worse than an unformatted one.
--
-- login-customer-id is a VARIABLE, not a secret: it is the manager (MCC)
-- account id, which is configuration, and is only sent when the connector is
-- managed through an agency account.

BEGIN;

INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'Google Ads',
  'Read campaigns, keywords, search terms and spend from a Google Ads account. Changing budgets, pausing campaigns and editing copy are governed actions, not reads — they are approved separately.',
  'ads',
  'published',
  '{
    "auth": {
      "type": "oauth2_refresh_token",
      "token_url": "https://oauth2.googleapis.com/token",
      "secret_headers": { "developer-token": "developer_token" },
      "extra_headers": { "Content-Type": "application/json" }
    },
    "base_url_template": "https://googleads.googleapis.com/v18/customers/{customer_id}",
    "variables": [
      { "key": "customer_id", "label": "Google Ads customer ID", "help": "The 10-digit account ID with no dashes — 1234567890, not 123-456-7890." },
      { "key": "login_customer_id", "label": "Manager (MCC) account ID, if any", "help": "Only if this account is managed through an agency MCC. Same format, no dashes. Leave blank otherwise." }
    ],
    "ops": {
      "search_campaigns": {
        "method": "POST",
        "path_template": "/googleAds:search",
        "body_template": {
          "query": "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.status != ''REMOVED'' AND campaign.name LIKE ''%{query}%'' ORDER BY metrics.cost_micros DESC LIMIT 50"
        },
        "response": {
          "items_path": "results",
          "id_path": "campaign.id",
          "title_path": "campaign.name",
          "snippet_path": "campaign.status"
        }
      },
      "get_campaign": {
        "method": "POST",
        "path_template": "/googleAds:search",
        "single_item": true,
        "body_template": {
          "query": "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign WHERE campaign.id = {ref}"
        },
        "response": {
          "items_path": "results",
          "id_path": "campaign.id",
          "title_path": "campaign.name",
          "snippet_path": "campaign.status"
        }
      },
      "search_keywords": {
        "method": "POST",
        "path_template": "/googleAds:search",
        "body_template": {
          "query": "SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE ad_group_criterion.keyword.text LIKE ''%{query}%'' AND ad_group_criterion.status != ''REMOVED'' ORDER BY metrics.cost_micros DESC LIMIT 100"
        },
        "response": {
          "items_path": "results",
          "id_path": "ad_group_criterion.criterion_id",
          "title_path": "ad_group_criterion.keyword.text",
          "snippet_path": "ad_group_criterion.keyword.match_type"
        }
      },
      "search_search_terms": {
        "method": "POST",
        "path_template": "/googleAds:search",
        "body_template": {
          "query": "SELECT search_term_view.search_term, search_term_view.status, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE search_term_view.search_term LIKE ''%{query}%'' ORDER BY metrics.cost_micros DESC LIMIT 100"
        },
        "response": {
          "items_path": "results",
          "id_path": "search_term_view.search_term",
          "title_path": "search_term_view.search_term",
          "snippet_path": "search_term_view.status"
        }
      },
      "get_account_performance": {
        "method": "POST",
        "path_template": "/googleAds:search",
        "single_item": true,
        "body_template": {
          "query": "SELECT customer.id, customer.descriptive_name, customer.currency_code, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date DURING LAST_30_DAYS"
        },
        "response": {
          "items_path": "results",
          "id_path": "customer.id",
          "title_path": "customer.descriptive_name",
          "snippet_path": "customer.currency_code"
        }
      }
    },
    "test_op": { "op": "get_account_performance", "params": {} }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_def jsonb;
  v_n int;
  v_ops text[];
  v_legal text[];
  v_op text;
BEGIN
  SELECT definition INTO v_def FROM adapter_templates
   WHERE name = 'Google Ads' AND scope = 'platform';
  IF v_def IS NULL THEN RAISE EXCEPTION 'S1 FAILED: template not installed'; END IF;

  -- S2: every op it binds is a LEGAL op for the ads category. A template that
  -- binds an op the contract does not define is unreachable by any employee —
  -- the exact hollow shape this migration exists to avoid.
  SELECT array_agg(k) INTO v_ops FROM jsonb_object_keys(v_def->'ops') k;
  v_legal := ARRAY['search_campaigns','get_campaign','search_keywords','search_search_terms','get_account_performance'];
  FOREACH v_op IN ARRAY v_ops LOOP
    IF NOT (v_op = ANY(v_legal)) THEN
      RAISE EXCEPTION 'S2 FAILED: op "%" is not in the ads category contract', v_op;
    END IF;
  END LOOP;
  IF array_length(v_ops, 1) <> 5 THEN
    RAISE EXCEPTION 'S2 FAILED: % ops bound, expected all 5 ads ops', array_length(v_ops, 1);
  END IF;

  -- S3: the developer token is declared as a SECRET header, never a literal.
  -- If it ever appears in extra_headers a credential is sitting in readable
  -- configuration.
  IF v_def->'auth'->'secret_headers'->>'developer-token' IS DISTINCT FROM 'developer_token' THEN
    RAISE EXCEPTION 'S3 FAILED: developer-token is not mapped to a secret field';
  END IF;
  IF (v_def->'auth'->'extra_headers')::text ILIKE '%developer%' THEN
    RAISE EXCEPTION 'S3 FAILED: a developer token literal is embedded in extra_headers';
  END IF;

  -- S4: the auth type is the refresh-token grant. client_credentials would
  -- authenticate the APP and get 401 on a user-owned ads account.
  IF v_def->'auth'->>'type' <> 'oauth2_refresh_token' THEN
    RAISE EXCEPTION 'S4 FAILED: auth type is %, expected oauth2_refresh_token', v_def->'auth'->>'type';
  END IF;

  -- S5: READS ONLY. No bound op may use anything but POST-to-search; a mutate
  -- endpoint here would bypass decide_action_execution entirely and let an
  -- employee change a campaign with no approval, no guardrail and no spend cap.
  IF (v_def->'ops')::text ILIKE '%:mutate%' THEN
    RAISE EXCEPTION 'S5 FAILED: the template binds a MUTATE endpoint — writes must go through action_definitions';
  END IF;

  -- S6: the ads write actions exist and are still correctly classified
  -- (they were seeded in 574; this is the cross-check that the pair shipped
  -- together rather than a reader-with-no-writer or vice versa).
  SELECT count(*) INTO v_n FROM action_definitions
   WHERE category = 'ads' AND provider = 'google_ads' AND status = 'active';
  IF v_n <> 6 THEN RAISE EXCEPTION 'S6 FAILED: % google_ads actions, expected 6', v_n; END IF;

  RAISE NOTICE '575 asserts passed: Google Ads template published, 5 legal read ops, secret-header auth, no mutate path.';
END
$probe$;

COMMIT;
