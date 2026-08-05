-- 577 — close the SEO and Social gaps.
--
-- Same bug class as ads (574): role_archetypes.required_connector_categories is
-- checked against system_categories, and TWO more roles demanded categories
-- that do not exist —
--
--     seo        -> {seo}         SEO Specialist, unhireable-in-practice
--     marketing  -> {marketing}   Marketing Specialist, same
--
-- ── WHY NO 'seo' AND NO 'marketing' CATEGORY ───────────────────────────────
-- Categories name SYSTEM TYPES, not job functions. That is why bdr, sdr,
-- cs_manager, onboarding and renewal_manager — five different jobs — all point
-- at {crm}: there is no {sales} category, because "sales" is not a system you
-- can connect to. "SEO" and "marketing" are the same kind of word.
--
-- The roles say so themselves. The SEO Specialist's own setup question asks
-- "What search/analytics data can it use?" and offers "Google Search Console,
-- GA4, Ahrefs" — that is web_analytics, which already exists and already
-- declares exactly the right ops (search_queries, get_page_metrics). Inventing
-- an {seo} category would create a second home for the same system.
--
--     seo        -> {web_analytics}
--     marketing  -> {social}
--
-- If an email platform (Mailchimp, Klaviyo) turns up later it gets an
-- {email_marketing} category — named for the system it IS, not the department
-- that uses it.
--
-- ── THE DEEPER HALF: NOBODY OWNED SOCIAL ───────────────────────────────────
-- 574 added the social category. No role demanded it, and the Marketing
-- Specialist cannot fill the hole: its persona says it "coordinates with SEO
-- and Ads rather than duplicating their work" and it "hands structured briefs"
-- onward — it plans and drafts, it does not publish or reply. So a social
-- category plus a social adapter would have been machinery no employee used.
-- This adds the Social Media Manager that owns the work.
--
-- ── WHY A CREDENTIAL CLAIM IS A WARNING, NOT A BLOCK ───────────────────────
-- The first draft of this role blocked "certified|accredited|ISO |licensed".
-- Our first real client sells pest control AND ISO consultancy in Jeddah —
-- ISO expertise IS their content. A blocking rule there would have stopped the
-- employee from drafting the very thing it was hired to write, on day one.
--
-- Severity means something exact here: blocking STOPS the employee, warning
-- FLAGS it for review. A credential claim is not false, it is CHECKABLE — and
-- this role publishes nothing, so a person reads every post before it goes out
-- either way. The warning puts "this names a credential, verify it" in front of
-- that person. Promises of a RESULT stay blocking, because no evidence makes
-- "guaranteed" safe.
--
-- ── THE RISK RULE, the parallel to the ads one ─────────────────────────────
-- ads (574) was:  PROTECT THE BUDGET ALONE. NEVER SPEND ALONE.
-- social is:
--
--        THE EMPLOYEE MAY LISTEN ALONE. IT MAY NEVER SPEAK IN PUBLIC ALONE.
--
--   draft_post        safe   — writes a draft; nothing is visible to anyone
--   publish_post      gated  — public speech under the client's brand
--   schedule_post     gated  — scheduling IS committing to publish, only later.
--                              Treating it as safe would be the whole rule with
--                              a timer bolted on.
--   reply_to_comment  gated  — public speech, and the replies that matter most
--                              are the ones answering an angry customer
--   hide_comment      gated  — hiding criticism is a reputational act
--   delete_post       gated  — public and irreversible
--   boost_post        gated  — publishes AND spends; amount-bearing, so the
--                              trust dial's ceiling applies as it does to ads
--
-- Only Meta actions are seeded. LinkedIn and TikTok have no adapter yet, and
-- action_definitions.provider is NOT NULL — seeding actions nothing can execute
-- is the hollow shape 574 refused for exactly this reason. They land with their
-- adapters.
--
-- ── SEO WRITES ARE DELIBERATELY TINY ───────────────────────────────────────
-- The SEO role's SOP says, in its own words: "Never edit, publish, redirect or
-- deploy anything yourself." Real SEO changes happen in the CMS, not in Search
-- Console, and there is no CMS connector. So the two actions here are the only
-- ones Search Console actually offers, and both are safe: they ask Google to
-- look at something. Neither can change the site.

BEGIN;

-- ── 1. Repoint the two roles at real system categories ─────────────────────
UPDATE role_archetypes SET required_connector_categories = '{web_analytics}'
 WHERE key = 'seo' AND required_connector_categories = '{seo}';

UPDATE role_archetypes SET required_connector_categories = '{social}'
 WHERE key = 'marketing' AND required_connector_categories = '{marketing}';

-- system_templates carries the same category string for the connector binding
-- the role suggests at hire time; leaving it stale would offer a connector of a
-- type that cannot exist.
-- google_ads was MISSED BY 574. That migration fixed the category the FK
-- checks (required_connector_categories) and left the one nothing checks: the
-- role still suggested a connector of category "google_ads", which is a
-- PROVIDER name, not a category, and can never exist. Found by S1b below —
-- written to generalise the ads bug, it caught an instance in the ads fix
-- itself. Of the four roles that suggest a connector, three named a category
-- that could not exist; the only correct one was support_agent -> helpdesk,
-- which is also the only employee that ever certified and now auto-sends.
UPDATE role_archetypes SET system_templates = '[{
    "label": "Ads platform", "system_key": "ads",
    "binding_kind": "connector", "can_read": true, "can_write": false, "can_verify": true
  }]'::jsonb
 WHERE key = 'google_ads';

UPDATE role_archetypes SET system_templates = '[{
    "label": "Search analytics", "system_key": "web_analytics",
    "binding_kind": "connector", "can_read": true, "can_write": false, "can_verify": true
  }]'::jsonb
 WHERE key = 'seo';

UPDATE role_archetypes SET system_templates = '[{
    "label": "Social platform", "system_key": "social",
    "binding_kind": "connector", "can_read": true, "can_write": false, "can_verify": true
  }]'::jsonb
 WHERE key = 'marketing';

-- ── 2. The Social Media Manager ────────────────────────────────────────────
INSERT INTO role_archetypes (
  key, name, domain, description, persona_preamble, responsibilities,
  required_capabilities, required_connector_categories, recommended_model,
  compliance_pack_keys, knowledge_scaffold, eval_category, pass_threshold_pct,
  status, sop_playbook, watcher_templates, guardrail_templates,
  system_templates, setup_questions, autonomy_templates, performance_contract,
  worklist_templates, claim_order
) VALUES (
  'social_media', 'Social Media Manager', 'Marketing',
  'Runs day-to-day social: plans and drafts posts on brand, monitors comments and mentions, drafts replies, and reports on engagement. Everything that would appear in public — a post, a reply, a boost — is prepared as a draft and published only by a person.',
  'You are a social media manager. You plan and draft posts, watch comments and mentions, and draft replies in the brand''s voice. You never publish, reply, hide, delete or boost anything yourself — you prepare it and a person releases it. You are honest about engagement numbers, including bad ones, and you never claim a certification, result or credential the business has not evidenced to you.',
  ARRAY[
    'Plan and draft posts on brand for approval',
    'Monitor comments and mentions daily',
    'Draft replies grounded in what the customer actually said',
    'Report engagement honestly, including declines',
    'Escalate complaints, safety claims and press immediately'
  ],
  ARRAY['communication', 'write_back'],
  ARRAY['social'],
  'claude-sonnet-5',
  ARRAY[]::text[],
  '{"topics": ["Your brand voice, tone and visual rules", "What you may and may not claim publicly", "Who approves posts and replies, and how fast", "Which channels and accounts you run"]}'::jsonb,
  'procedure', 80, 'active',
  '{
    "name": "Social Media SOP",
    "description": "Standard operating procedure for planning, drafting and monitoring social content.",
    "steps": [
      {"key": "instruction", "label": "Know the brand and the limits",
       "params": {"body_md": "Learn the brand voice, the channels you run, and — most important — what the business is allowed to claim. Never state a certification, accreditation, result or guarantee you have not been shown evidence for."}},
      {"key": "instruction", "label": "Listen before you speak",
       "params": {"body_md": "Read comments and mentions first. Ground every reply in what the customer actually said and what the business actually offers."}},
      {"key": "checklist", "label": "Draft, never publish",
       "params": {"items": [
         "Prepare posts and replies as drafts for approval",
         "Never publish, schedule, reply, hide, delete or boost anything yourself",
         "Flag anything angry, legal, safety-related or press-related to a person immediately",
         "Never invent a credential, result, review or testimonial"
       ]}},
      {"key": "instruction", "label": "Report honestly",
       "params": {"body_md": "Report engagement as it is, including declines and posts that failed. Do not present reach as revenue or engagement as leads."}}
    ]
  }'::jsonb,
  '[{"kind": "schedule", "label": "Daily comment and mention sweep",
     "description": "Wake daily to read new comments and mentions and draft replies for approval.",
     "config": {"interval_minutes": 1440, "response_window": {"unit": "hours", "amount": 8}}}]'::jsonb,
  '[
    {"rule": "No publishing or replying in public without approval", "rule_type": "blocked_phrase",
     "pattern": "publish this|post it now|go live|schedule the post|reply to them directly|boost this", "severity": "blocking"},
    {"rule": "Never promise a result", "rule_type": "blocked_phrase",
     "pattern": "guaranteed|100% |risk-free|proven to|best in class|#1 ", "severity": "blocking"},
    {"rule": "Credential claims must be checked before they go out", "rule_type": "blocked_phrase",
     "pattern": "certified|accredited|ISO |licensed|award-winning", "severity": "warning"},
    {"rule": "Social spend over $1,000 requires human approval", "rule_type": "require_approval_over_cents", "threshold": "100000"}
  ]'::jsonb,
  '[{"label": "Social platform", "system_key": "social", "binding_kind": "connector",
     "can_read": true, "can_write": false, "can_verify": true}]'::jsonb,
  '[
    {"key": "channels", "kind": "text", "question": "Which social accounts should this employee run?", "help": "e.g. the Facebook Page and Instagram business account"},
    {"key": "voice", "kind": "text", "question": "How should it sound, and what must it never say?", "help": "e.g. plain and practical; never claim a certification we cannot show"},
    {"key": "claims", "kind": "text", "question": "What claims are you actually able to evidence?", "help": "e.g. ISO 9001 certified since 2021 — certificate on file"},
    {"key": "approver", "kind": "text", "question": "Who approves posts and replies before they go out?"},
    {"key": "escalate", "kind": "text", "question": "What should it never handle alone?", "help": "e.g. complaints, safety claims, anything from press"}
  ]'::jsonb,
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'urgency'
)
ON CONFLICT (key) DO NOTHING;

-- ── 3. Actions ─────────────────────────────────────────────────────────────
INSERT INTO action_definitions
  (scope, tenant_id, category, action_key, label, description, provider,
   param_schema, risk, execution, status, reversible)
VALUES
  -- SEO / Search Console. Both are requests to GOOGLE, not changes to the site.
  ('platform', NULL, 'web_analytics', 'submit_sitemap',
   'Submit a sitemap to Google',
   'Tells Google where the site''s sitemap is so it can find pages. Changes nothing on the website itself and can be undone by removing the sitemap, so a trusted employee may do this alone.',
   'google_search_console',
   '[{"name":"sitemap_url","type":"string","required":true,"help":"Full URL of the sitemap, e.g. https://example.com/sitemap.xml"}]'::jsonb,
   '{"destructive": false, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'web_analytics', 'request_indexing',
   'Ask Google to re-crawl a page',
   'Asks Google to look at a page again after it changed. It cannot alter the page or the site — only Google decides what to do — so a trusted employee may do this alone.',
   'google_search_console',
   '[{"name":"page_url","type":"string","required":true,"help":"The page to re-crawl"},
     {"name":"reason","type":"string","required":false,"help":"Why it changed"}]'::jsonb,
   '{"destructive": false, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  -- Social. Drafting is unattended; every act of PUBLIC SPEECH is gated.
  ('platform', NULL, 'social', 'draft_post',
   'Draft a post (not published)',
   'Writes a post and saves it as a draft. Nobody outside the business can see it and nothing is scheduled, so a trusted employee may draft alone.',
   'meta',
   '[{"name":"channel","type":"string","required":true,"help":"facebook or instagram"},
     {"name":"body","type":"string","required":true,"help":"The post text"},
     {"name":"image_url","type":"string","required":false,"help":"Image to attach"},
     {"name":"link_url","type":"string","required":false,"help":"Link to include"}]'::jsonb,
   '{"destructive": false, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'social', 'publish_post',
   'Publish a post',
   'Puts a post in front of the public under the business''s name. Destructive because it cannot be unsaid — people see it, and screenshots outlive deletion. Always needs a person.',
   'meta',
   '[{"name":"channel","type":"string","required":true,"help":"facebook or instagram"},
     {"name":"body","type":"string","required":true,"help":"The post text"},
     {"name":"image_url","type":"string","required":false,"help":"Image to attach"},
     {"name":"link_url","type":"string","required":false,"help":"Link to include"}]'::jsonb,
   '{"destructive": true, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'social', 'schedule_post',
   'Schedule a post',
   'Publishes a post at a chosen time. Scheduling is publishing with a delay — the person is simply not in the room when it happens — so it needs the same approval.',
   'meta',
   '[{"name":"channel","type":"string","required":true,"help":"facebook or instagram"},
     {"name":"body","type":"string","required":true,"help":"The post text"},
     {"name":"publish_at","type":"string","required":true,"help":"When to publish (ISO timestamp)"},
     {"name":"image_url","type":"string","required":false,"help":"Image to attach"}]'::jsonb,
   '{"destructive": true, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'social', 'reply_to_comment',
   'Reply to a comment in public',
   'Answers a customer where everyone can read it. The replies that matter most are the ones answering someone unhappy, which is exactly when a person should decide the words. Always needs a person.',
   'meta',
   '[{"name":"comment_ref","type":"string","required":true,"help":"Which comment"},
     {"name":"body","type":"string","required":true,"help":"The reply text"}]'::jsonb,
   '{"destructive": true, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'social', 'hide_comment',
   'Hide a comment',
   'Hides a comment from public view. Hiding criticism is a reputational decision and reads as censorship when it is wrong, so it always needs a person.',
   'meta',
   '[{"name":"comment_ref","type":"string","required":true,"help":"Which comment"},
     {"name":"reason","type":"string","required":true,"help":"Why it is being hidden"}]'::jsonb,
   '{"destructive": true, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', true),

  ('platform', NULL, 'social', 'delete_post',
   'Delete a published post',
   'Removes a live post permanently. Public and irreversible — always needs a person.',
   'meta',
   '[{"name":"post_ref","type":"string","required":true,"help":"Which post"},
     {"name":"reason","type":"string","required":true,"help":"Why it is being deleted"}]'::jsonb,
   '{"destructive": true, "idempotent": true}'::jsonb, '{}'::jsonb, 'active', false),

  ('platform', NULL, 'social', 'boost_post',
   'Boost a post (paid promotion)',
   'Pays to put a post in front of more people. It publishes AND it spends, so it is gated twice — the approval, and the trust dial''s spending ceiling.',
   'meta',
   '[{"name":"post_ref","type":"string","required":true,"help":"Which post"},
     {"name":"budget_cents","type":"integer","required":true,"help":"Total spend in cents"},
     {"name":"duration_days","type":"integer","required":true,"help":"How many days to run"},
     {"name":"audience","type":"string","required":false,"help":"Who to target"}]'::jsonb,
   '{"destructive": true, "idempotent": false}'::jsonb, '{}'::jsonb, 'active', false)
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_n int;
  v_bad text;
  v_tenant uuid;
  v_conn uuid;
  v_dec jsonb;
  v_destructive boolean;
BEGIN
  -- S1: NO role anywhere demands a category that does not exist. The general
  -- form of the ads bug — this is the assert that should have existed in 574.
  SELECT string_agg(DISTINCT a.key || ' -> {' || c || '}', ', ') INTO v_bad
    FROM role_archetypes a, LATERAL unnest(a.required_connector_categories) c
   WHERE c NOT IN (SELECT key FROM system_categories);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S1 FAILED: role(s) demand a category the FK rejects: %', v_bad;
  END IF;

  -- S1b: and no role's suggested connector binding points at one either — a
  -- stale system_templates offers a connector type that cannot be created.
  SELECT string_agg(DISTINCT a.key || ' -> ' || (s->>'system_key'), ', ') INTO v_bad
    FROM role_archetypes a, LATERAL jsonb_array_elements(COALESCE(a.system_templates,'[]'::jsonb)) s
   WHERE s->>'binding_kind' = 'connector'
     AND s->>'system_key' NOT IN (SELECT key FROM system_categories);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S1b FAILED: system_templates point at a non-existent category: %', v_bad;
  END IF;

  -- S2: the Social Media Manager exists and is hireable.
  SELECT count(*) INTO v_n FROM role_archetypes
   WHERE key = 'social_media' AND status = 'active' AND required_connector_categories = '{social}';
  IF v_n <> 1 THEN RAISE EXCEPTION 'S2 FAILED: social_media role missing or misconfigured'; END IF;

  -- S3: THE RULE. Every act of public speech is destructive; drafting is not.
  -- Written as data, so adding a social action forces a decision about it.
  SELECT string_agg(action_key, ', ') INTO v_bad FROM action_definitions
   WHERE category = 'social' AND status = 'active'
     AND action_key IN ('publish_post','schedule_post','reply_to_comment','hide_comment','delete_post','boost_post')
     AND (risk->>'destructive')::boolean IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S3 FAILED: these speak in public but are not gated: %', v_bad;
  END IF;

  SELECT string_agg(action_key, ', ') INTO v_bad FROM action_definitions
   WHERE category = 'social' AND status = 'active' AND action_key = 'draft_post'
     AND (risk->>'destructive')::boolean IS TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S3 FAILED: drafting is gated, so the employee can do nothing alone: %', v_bad;
  END IF;

  -- S4: the SEO actions can NOT be gated — an SEO employee that needs approval
  -- to ask Google to re-crawl a page is an employee that does nothing.
  SELECT string_agg(action_key, ', ') INTO v_bad FROM action_definitions
   WHERE category = 'web_analytics' AND status = 'active'
     AND (risk->>'destructive')::boolean IS TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S4 FAILED: SEO actions are gated but neither can change the site: %', v_bad;
  END IF;

  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NOT NULL THEN
    -- S5: a social connector can actually be created. This is the gate that
    -- made the ads roles unhireable, and it is worth proving per category
    -- rather than assuming the category row is enough.
    -- provider 'template' because that is what connectFromTemplate writes, and
    -- connectors.provider carries a CHECK allowlist with no 'meta' in it. A
    -- probe that inserts differently from the product proves nothing about it.
    INSERT INTO connectors (tenant_id, display_name, category, provider, base_url, status, config)
    VALUES (v_tenant, 'probe social 577', 'social', 'template', 'https://graph.facebook.com', 'connected', '{}'::jsonb)
    RETURNING id INTO v_conn;
    DELETE FROM connectors WHERE id = v_conn;

    -- S6: BEHAVIOURAL. Feed the SEEDED classification to the decider and prove
    -- publishing cannot come back auto_executed. The flag is READ FROM THE ROW,
    -- not passed as a literal true — otherwise this would pass even if the seed
    -- had marked publishing safe, which is the whole thing being tested.
    SELECT (risk->>'destructive')::boolean INTO v_destructive
      FROM action_definitions
     WHERE scope = 'platform' AND category = 'social' AND action_key = 'publish_post';

    v_dec := decide_action_execution(v_tenant, 'Publish a post', 'social', v_destructive,
             NULL, NULL, 'action_execute', 'ISO 9001 certified pest control across Jeddah');
    IF v_dec->>'decision' = 'auto_executed' THEN
      RAISE EXCEPTION 'S6 FAILED: publish_post resolved to auto_executed — the employee can speak in public alone';
    END IF;
    RAISE NOTICE 'S6: publish_post resolved to "%" — not auto_executed.', v_dec->>'decision';

    -- S7: and drafting must NOT hit the destructive floor. An employee that
    -- needs approval to write a draft is an employee that does nothing — the
    -- mirror failure, and the one that looks safe so nobody checks it.
    SELECT (risk->>'destructive')::boolean INTO v_destructive
      FROM action_definitions
     WHERE scope = 'platform' AND category = 'social' AND action_key = 'draft_post';

    v_dec := decide_action_execution(v_tenant, 'Draft a post', 'social', v_destructive,
             NULL, NULL, 'action_execute', 'draft: seasonal ant treatment tips');
    IF v_dec->>'decision' = 'human_gated_destructive' THEN
      RAISE EXCEPTION 'S7 FAILED: drafting hit the destructive floor — it can never be delegated';
    END IF;
    RAISE NOTICE 'S7: draft_post resolved to "%" — not floored.', v_dec->>'decision';
  END IF;

  RAISE NOTICE '577 asserts passed: no role demands a missing category, social_media hireable, public speech gated, SEO reads free.';
END
$probe$;

COMMIT;
