-- 580 — the write bindings. Publishing actually publishes.
--
-- 574/577 seeded 17 governed actions and bound NONE of them. Each was
-- classified, gated, guardrail-scanned and routed to a human — and approving one
-- would have found nothing to execute. Asking a person to make a decision and
-- then doing nothing with it is worse than not offering the action.
--
-- ── HOW A WRITE ACTUALLY REACHES A VENDOR ──────────────────────────────────
-- renderRegisteredAction uses a template binding ONLY when the action row has
-- provider='template' AND template_id set; it then looks up
-- definition.actions[action_key]. Our rows had provider='meta'/'google_ads' and
-- an empty execution object, so they fell through to the NATIVE branch and
-- returned execution_not_implemented. Fixed by pointing them at their template.
--
-- ── TWO GOVERNANCE HOLES FOUND WHILE WIRING THIS ───────────────────────────
--
-- 1. THE SPEND CEILING WAS NEVER ARMED. execute_action resolves the transaction
--    amount from a param named EXACTLY 'amount_cents' — the registry's money
--    convention. Its own comment says: "Passing null here is what silently
--    disabled all three (audit critical)." Our params were daily_budget_cents
--    and budget_cents, so the approval threshold, the per-DE spend cap and the
--    trust dollar-ceiling ALL sat inert on the two actions that move money.
--    574 claimed the dial "becomes a real spend ceiling" on set_campaign_budget.
--    It did not. Both renamed here, and asserted so it cannot recur.
--
-- 2. AN OPTIONAL PARAM INSIDE A BODY TEMPLATE BREAKS THE WHOLE ACTION.
--    renderAction collects every unresolved placeholder and fails the request
--    with var_missing — there is no "leave it out if absent". So a body
--    referencing an optional param fails 100% of the time it is omitted, which
--    is the common case. publish_post declared image_url and link_url optional;
--    any binding using them would have been dead on arrival. Asserted below:
--    every placeholder in a binding must be a REQUIRED param or a template var.
--
-- ── WHAT IS DELIBERATELY NOT BOUND, AND WHY ────────────────────────────────
-- Five actions are DISABLED rather than left active-and-broken. A disabled row
-- states its reason; an active unbound row lies.
--
--   request_indexing      Google's Indexing API is restricted BY POLICY to
--                         JobPosting and BroadcastEvent pages. A pest-control
--                         site is neither. There is no compliant API to ask
--                         Google to crawl an ordinary page — submitting a
--                         sitemap is the supported route, and that is bound.
--   set_campaign_budget   Google Ads takes MICROS; the gate takes CENTS
--                         (1 cent = 10,000 micros). A declarative template
--                         cannot multiply, and the alternatives are worse:
--                         two params can disagree, so the human approves one
--                         number while another is sent, and string-concatenating
--                         four zeros silently corrupts any non-integer. Money is
--                         the last place to be clever. Needs a typed unit
--                         conversion in the framework.
--   create_ad_draft       Responsive search ads take ARRAYS of headlines and
--   update_ad_copy        descriptions. renderBody substitutes into strings; it
--                         cannot split one into a list. Needs array params.
--   boost_post            Not one call. Meta's Marketing API needs campaign ->
--                         ad set -> creative -> ad, four dependent requests with
--                         ids threaded between them. A single binding cannot
--                         express it, and ads_management is not a permission we
--                         are even requesting yet (docs/43).
--
-- ── FACEBOOK PAGE ONLY, SAID OUT LOUD ──────────────────────────────────────
-- The post actions dropped their `channel` param. It was required, it accepted
-- "facebook or instagram", and the binding is Facebook-only — Instagram
-- publishing is a two-step container-then-publish flow needing a permission we
-- have not requested. A required parameter the executor ignores misleads the
-- person approving. Instagram gets its own actions when its permission lands.

BEGIN;

-- ── 1. Params: the money convention, and no optionals in bodies ────────────
UPDATE action_definitions SET param_schema = '[
  {"name":"budget_ref","type":"string","required":true,"help":"The campaign BUDGET id (not the campaign id) — search_campaigns returns it"},
  {"name":"amount_cents","type":"integer","required":true,"help":"New daily budget in cents. Named amount_cents so the approval threshold, spend cap and trust ceiling all engage."},
  {"name":"reason","type":"string","required":true,"help":"Why it is changing"}]'::jsonb
 WHERE scope = 'platform' AND category = 'ads' AND action_key = 'set_campaign_budget';

UPDATE action_definitions SET param_schema = '[
  {"name":"post_ref","type":"string","required":true,"help":"Which post"},
  {"name":"amount_cents","type":"integer","required":true,"help":"Total spend in cents. Named amount_cents so the money gates engage."},
  {"name":"duration_days","type":"integer","required":true,"help":"How many days to run"},
  {"name":"audience","type":"string","required":false,"help":"Who to target"}]'::jsonb
 WHERE scope = 'platform' AND category = 'social' AND action_key = 'boost_post';

UPDATE action_definitions SET
  label = 'Publish a post to the Facebook Page',
  param_schema = '[{"name":"body","type":"string","required":true,"help":"The post text. A URL in the text gets a link preview automatically."}]'::jsonb
 WHERE scope = 'platform' AND category = 'social' AND action_key = 'publish_post';

UPDATE action_definitions SET
  label = 'Draft a post on the Facebook Page (unpublished)',
  description = 'Creates an UNPUBLISHED post on the Page. Only Page admins can see it, nothing reaches the public, and it gives the client a way to review wording inside Facebook itself. A trusted employee may draft alone.',
  param_schema = '[{"name":"body","type":"string","required":true,"help":"The post text"}]'::jsonb
 WHERE scope = 'platform' AND category = 'social' AND action_key = 'draft_post';

UPDATE action_definitions SET
  label = 'Schedule a post on the Facebook Page',
  description = 'Publishes a post at a chosen time. Scheduling is publishing with the person out of the room, so it needs the same approval — and the approver sees the exact timestamp before releasing it.',
  param_schema = '[
    {"name":"body","type":"string","required":true,"help":"The post text"},
    {"name":"publish_at","type":"integer","required":true,"help":"Unix timestamp in SECONDS. Meta requires between 10 minutes and 6 months ahead. The approver sees this value before releasing it."}]'::jsonb
 WHERE scope = 'platform' AND category = 'social' AND action_key = 'schedule_post';

UPDATE action_definitions SET param_schema = '[
  {"name":"campaign_ref","type":"string","required":true,"help":"Which campaign"},
  {"name":"keyword","type":"string","required":true,"help":"The search term to exclude"},
  {"name":"match_type","type":"string","required":true,"help":"EXACT, PHRASE or BROAD"}]'::jsonb
 WHERE scope = 'platform' AND category = 'ads' AND action_key = 'add_negative_keyword';

-- ── 2. Disable what cannot be honestly bound, with the reason recorded ─────
UPDATE action_definitions SET status = 'disabled',
  description = description || ' — NOT AVAILABLE: Google restricts the Indexing API to job-posting and live-event pages by policy, so there is no compliant way to ask Google to re-crawl an ordinary page. Submit a sitemap instead.'
 WHERE scope = 'platform' AND category = 'web_analytics' AND action_key = 'request_indexing';

UPDATE action_definitions SET status = 'disabled',
  description = description || ' — NOT AVAILABLE YET: Google Ads takes budgets in micros and the approval gates work in cents. Converting money inside a declarative template cannot be done safely, so this waits for a typed unit conversion.'
 WHERE scope = 'platform' AND category = 'ads' AND action_key = 'set_campaign_budget';

UPDATE action_definitions SET status = 'disabled',
  description = description || ' — NOT AVAILABLE YET: responsive search ads take lists of headlines and descriptions, and the template engine substitutes text rather than building lists.'
 WHERE scope = 'platform' AND category = 'ads' AND action_key IN ('create_ad_draft','update_ad_copy');

UPDATE action_definitions SET status = 'disabled',
  description = description || ' — NOT AVAILABLE YET: boosting is four dependent calls to Meta''s Marketing API (campaign, ad set, creative, ad), which one binding cannot express, and it needs the ads_management permission we have not requested.'
 WHERE scope = 'platform' AND category = 'social' AND action_key = 'boost_post';

-- ── 3. The bindings ────────────────────────────────────────────────────────
UPDATE adapter_templates SET
  definition = definition || jsonb_build_object('actions', '{
    "publish_post": {
      "method": "POST", "path_template": "/{page_id}/feed",
      "body_template": { "message": "{body}" },
      "response": { "id_path": "id" }
    },
    "draft_post": {
      "method": "POST", "path_template": "/{page_id}/feed",
      "body_template": { "message": "{body}", "published": false },
      "response": { "id_path": "id" }
    },
    "schedule_post": {
      "method": "POST", "path_template": "/{page_id}/feed",
      "body_template": { "message": "{body}", "published": false, "scheduled_publish_time": "{publish_at}" },
      "response": { "id_path": "id" }
    },
    "reply_to_comment": {
      "method": "POST", "path_template": "/{comment_ref}/comments",
      "body_template": { "message": "{body}" },
      "response": { "id_path": "id" }
    },
    "hide_comment": {
      "method": "POST", "path_template": "/{comment_ref}",
      "body_template": { "is_hidden": true },
      "response": { "status_path": "success" }
    },
    "delete_post": {
      "method": "DELETE", "path_template": "/{post_ref}",
      "response": { "status_path": "success" }
    }
  }'::jsonb),
  updated_at = now()
WHERE name = 'Meta (Facebook & Instagram)' AND scope = 'platform';

-- Google Ads writes are :mutate endpoints. The literal ":" survives rendering —
-- renderTemplate URL-encodes substituted VALUES, never the template text.
-- updateMask is snake_case (it names API fields) while the body is camelCase:
-- the same split that broke the read paths in 576, here on purpose.
UPDATE adapter_templates SET
  definition = definition || jsonb_build_object('actions', '{
    "pause_campaign": {
      "method": "POST", "path_template": "/campaigns:mutate",
      "body_template": { "operations": [ { "update": { "resourceName": "customers/{customer_id}/campaigns/{campaign_ref}", "status": "PAUSED" }, "updateMask": "status" } ] },
      "response": { "id_path": "results.0.resourceName" }
    },
    "resume_campaign": {
      "method": "POST", "path_template": "/campaigns:mutate",
      "body_template": { "operations": [ { "update": { "resourceName": "customers/{customer_id}/campaigns/{campaign_ref}", "status": "ENABLED" }, "updateMask": "status" } ] },
      "response": { "id_path": "results.0.resourceName" }
    },
    "add_negative_keyword": {
      "method": "POST", "path_template": "/campaignCriteria:mutate",
      "body_template": { "operations": [ { "create": { "campaign": "customers/{customer_id}/campaigns/{campaign_ref}", "negative": true, "keyword": { "text": "{keyword}", "matchType": "{match_type}" } } } ] },
      "response": { "id_path": "results.0.resourceName" }
    }
  }'::jsonb),
  updated_at = now()
WHERE name = 'Google Ads' AND scope = 'platform';

UPDATE adapter_templates SET
  definition = definition || jsonb_build_object('actions', '{
    "submit_sitemap": {
      "method": "PUT", "path_template": "/sitemaps/{sitemap_url}"
    }
  }'::jsonb),
  updated_at = now()
WHERE name = 'Google Search Console' AND scope = 'platform';

-- ── 4. Point the action rows at their template ─────────────────────────────
UPDATE action_definitions a SET provider = 'template', template_id = t.id, updated_at = now()
  FROM adapter_templates t
 WHERE a.scope = 'platform' AND a.status = 'active'
   AND t.scope = 'platform' AND t.category = a.category
   AND t.definition->'actions' ? a.action_key
   AND a.category IN ('ads','social','web_analytics');

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_bad text;
  v_n int;
  v_tenant uuid;
  v_dec jsonb;
BEGIN
  -- V1: NO ACTIVE ACTION IS UNBOUND. An active action with nowhere to go asks a
  -- person to approve something that then does nothing — the exact state 574
  -- and 577 shipped, and the reason this migration exists.
  SELECT string_agg(a.category || '.' || a.action_key, ', ') INTO v_bad
    FROM action_definitions a
   WHERE a.scope = 'platform' AND a.status = 'active'
     AND a.category IN ('ads','social','web_analytics')
     AND NOT EXISTS (
       SELECT 1 FROM adapter_templates t
        WHERE t.id = a.template_id AND t.definition->'actions' ? a.action_key);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V1 FAILED: active but unbound — approving these would do nothing: %', v_bad;
  END IF;

  -- V2: and the reverse — nothing is bound that is not wired to run it.
  SELECT string_agg(a.category || '.' || a.action_key, ', ') INTO v_bad
    FROM action_definitions a
   WHERE a.scope = 'platform' AND a.status = 'active'
     AND a.category IN ('ads','social','web_analytics')
     AND (a.provider <> 'template' OR a.template_id IS NULL);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V2 FAILED: active actions not routed to a template: %', v_bad;
  END IF;

  -- V3: THE MONEY CONVENTION. execute_action reads the amount from a param
  -- named exactly 'amount_cents'. Any other name and the approval threshold,
  -- the spend cap and the trust ceiling all silently do nothing. Checked for
  -- disabled rows too, so re-enabling one cannot quietly reopen the hole.
  SELECT string_agg(a.category || '.' || a.action_key || ' (' || (p->>'name') || ')', ', ') INTO v_bad
    FROM action_definitions a, LATERAL jsonb_array_elements(a.param_schema) p
   WHERE a.scope = 'platform' AND a.category IN ('ads','social','web_analytics')
     AND (p->>'name') <> 'amount_cents'
     -- NUMERIC money params only. budget_ref is a resource id that happens to
     -- contain "budget" — matching on the word alone flags identifiers as money.
     AND (p->>'type') IN ('integer','number')
     AND ((p->>'name') ILIKE '%budget%' OR (p->>'name') ILIKE '%amount%'
          OR (p->>'name') ILIKE '%cents%' OR (p->>'name') ILIKE '%price%'
          OR (p->>'name') ILIKE '%spend%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V3 FAILED: money param not named amount_cents, so every money gate is inert: %', v_bad;
  END IF;

  -- V4: NO OPTIONAL PARAM MAY APPEAR IN A BINDING. renderAction fails the whole
  -- request with var_missing on ANY unresolved placeholder — there is no
  -- "omit if absent" — so a body referencing an optional param is broken every
  -- time that param is left out, which is the normal case.
  SELECT string_agg(t.name || '.' || k || ' {' || (p->>'name') || '}', ', ') INTO v_bad
    FROM adapter_templates t,
         LATERAL jsonb_object_keys(t.definition->'actions') k,
         action_definitions a,
         LATERAL jsonb_array_elements(a.param_schema) p
   WHERE t.scope = 'platform' AND t.category IN ('ads','social','web_analytics')
     AND a.action_key = k AND a.category = t.category AND a.scope = 'platform'
     AND COALESCE((p->>'required')::boolean, false) = false
     AND (t.definition->'actions'->k)::text LIKE '%{' || (p->>'name') || '}%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V4 FAILED: binding uses an OPTIONAL param — it fails whenever that param is omitted: %', v_bad;
  END IF;

  -- V5: every placeholder in a binding resolves to a required param or a
  -- declared template variable. The other half of V4 — a typo'd placeholder
  -- name fails identically and is far easier to make.
  SELECT string_agg(t.name || '.' || k || ' {' || ph || '}', ', ') INTO v_bad
    FROM adapter_templates t,
         LATERAL jsonb_object_keys(t.definition->'actions') k,
         LATERAL regexp_matches((t.definition->'actions'->k)::text, '\{([a-zA-Z0-9_]+)\}', 'g') m,
         LATERAL (SELECT m[1]) AS x(ph)
   WHERE t.scope = 'platform' AND t.category IN ('ads','social','web_analytics')
     AND ph NOT IN (SELECT jsonb_array_elements(COALESCE(t.definition->'variables','[]'::jsonb))->>'key')
     AND ph NOT IN (
       SELECT p->>'name' FROM action_definitions a, LATERAL jsonb_array_elements(a.param_schema) p
        WHERE a.action_key = k AND a.category = t.category AND a.scope = 'platform'
          AND COALESCE((p->>'required')::boolean, false) = true);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V5 FAILED: placeholder is neither a required param nor a template variable: %', v_bad;
  END IF;

  -- V6: every disabled action SAYS WHY. A disabled row with no reason is
  -- indistinguishable from one someone switched off by accident.
  SELECT string_agg(action_key, ', ') INTO v_bad FROM action_definitions
   WHERE scope = 'platform' AND category IN ('ads','social','web_analytics')
     AND status = 'disabled' AND description NOT LIKE '%NOT AVAILABLE%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'V6 FAILED: disabled without a recorded reason: %', v_bad;
  END IF;

  -- V7: BEHAVIOURAL, and the point of the whole exercise — publishing is now
  -- executable AND still cannot execute itself.
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NOT NULL THEN
    SELECT decide_action_execution(v_tenant, 'Publish a post to the Facebook Page', 'social',
             (SELECT (risk->>'destructive')::boolean FROM action_definitions
               WHERE scope='platform' AND category='social' AND action_key='publish_post'),
             NULL, NULL, 'action_execute', 'Ant season is here — booking now')
      INTO v_dec;
    IF v_dec->>'decision' = 'auto_executed' THEN
      RAISE EXCEPTION 'V7 FAILED: publish_post is now bound AND auto-executing — it can speak in public alone';
    END IF;
    RAISE NOTICE 'V7: publish_post is bound and resolves to "%".', v_dec->>'decision';
  END IF;

  SELECT count(*) INTO v_n FROM action_definitions
   WHERE scope = 'platform' AND category IN ('ads','social','web_analytics') AND status = 'active';
  RAISE NOTICE '580 asserts passed: % actions active and bound, 5 disabled with reasons.', v_n;
END
$probe$;

COMMIT;
