-- 578 — the Google Search Console and Meta adapters, and a validator fix to
-- the Google Ads one.
--
-- ── FIRST, THE ADS BUG ─────────────────────────────────────────────────────
-- get_account_performance is a 'get' op, and the framework requires every get
-- to carry {ref} — a get fetches ONE record, so it must say which. The shipped
-- template had no {ref}, so validateAdapterDefinition rejected it: the row sat
-- in the database looking installed while the builder would refuse to save it.
--
-- Storage is not usability. The test now runs the SAME validator the wizard
-- runs, which is how this surfaced.
--
-- {ref} here is the customer id. That is not a formality to satisfy the
-- contract — under a manager (MCC) account one connector legitimately reaches
-- several customer accounts, and this is how you say which one.
--
-- ── GOOGLE SEARCH CONSOLE ──────────────────────────────────────────────────
-- The important thing about this adapter, commercially: it needs NO developer
-- token. Google Ads gates on a token that takes weeks; Search Console gates on
-- nothing but OAuth for a property you already own. It is the fastest thing
-- here to a real, live, working connection.
--
-- It also forced the relative-date placeholders added in the same commit.
-- searchAnalytics/query REQUIRES literal startDate and endDate — there is no
-- DURING LAST_30_DAYS keyword like GAQL has. Hard-coded dates would go stale
-- the day the template was saved, and a date typed into connector settings
-- would freeze just as hard. So {today} and {days_ago_N} are filled by the
-- framework, generically, because GA4/Bing/Matomo all want the same.
--
-- Response shape is {rows:[{keys:["…"], clicks, impressions, ctr, position}]},
-- so id_path is "keys.0" — walkPath takes a numeric segment on an array.
--
-- ── META (FACEBOOK PAGES + INSTAGRAM) ──────────────────────────────────────
-- Covers two of the four channels asked for. LinkedIn and TikTok are NOT here:
-- both gate publishing behind approval programmes, and shipping a template that
-- cannot post is worse than shipping none, because it reads as capability.
--
-- Meta's own gate is real too and is stated plainly in the description so
-- nobody discovers it during a client demo: reading a Page and publishing to it
-- need App Review and Business Verification. The template is correct and
-- unusable until that clears — which is exactly why the paths are proven
-- against fixture responses rather than assumed.
--
-- Meta returns {data:[...]} for collections and paginates with cursors; the
-- framework takes the first page, which is right for "what happened lately".

BEGIN;

-- ── 1. Google Ads: give the get op its {ref} ───────────────────────────────
UPDATE adapter_templates SET
  definition = jsonb_set(
    definition, '{ops,get_account_performance,body_template,query}',
    to_jsonb('SELECT customer.id, customer.descriptive_name, customer.currency_code, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE customer.id = {ref} AND segments.date DURING LAST_30_DAYS'::text)),
  updated_at = now()
WHERE name = 'Google Ads' AND scope = 'platform';

-- ── 2. Google Search Console ───────────────────────────────────────────────
INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'Google Search Console',
  'Reads what people actually search to find a site: queries, impressions, clicks and average position, plus per-page performance. Needs only a Google sign-in for a property you already own — no developer token and no review.',
  'web_analytics',
  'published',
  '{
    "auth": {
      "type": "oauth2_refresh_token",
      "token_url": "https://oauth2.googleapis.com/token",
      "extra_headers": { "Content-Type": "application/json" }
    },
    "base_url_template": "https://searchconsole.googleapis.com/webmasters/v3/sites/{site_url}",
    "variables": [
      { "key": "site_url", "label": "Property URL, URL-encoded", "help": "Exactly as Search Console shows it, URL-encoded: https%3A%2F%2Fwww.example.com%2F for a URL-prefix property, or sc-domain%3Aexample.com for a domain property." }
    ],
    "ops": {
      "search_queries": {
        "method": "POST",
        "path_template": "/searchAnalytics/query",
        "body_template": {
          "startDate": "{days_ago_28}",
          "endDate": "{today}",
          "dimensions": ["query"],
          "rowLimit": 100,
          "dimensionFilterGroups": [
            { "filters": [ { "dimension": "query", "operator": "contains", "expression": "{query}" } ] }
          ]
        },
        "response": {
          "items_path": "rows",
          "id_path": "keys.0",
          "title_path": "keys.0",
          "snippet_path": "position"
        }
      },
      "get_page_metrics": {
        "method": "POST",
        "path_template": "/searchAnalytics/query",
        "body_template": {
          "startDate": "{days_ago_28}",
          "endDate": "{today}",
          "dimensions": ["page"],
          "rowLimit": 25,
          "dimensionFilterGroups": [
            { "filters": [ { "dimension": "page", "operator": "contains", "expression": "{ref}" } ] }
          ]
        },
        "response": {
          "items_path": "rows",
          "id_path": "keys.0",
          "title_path": "keys.0",
          "snippet_path": "position"
        }
      }
    },
    "test_op": { "op": "search_queries", "params": { "query": "" } }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── 3. Meta (Facebook Pages + Instagram) ───────────────────────────────────
INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'Meta (Facebook & Instagram)',
  'Reads posts, their engagement, and comments from a Facebook Page and its linked Instagram business account. Publishing, replying and boosting are governed actions approved separately. Requires Meta App Review and Business Verification before it can read a live Page.',
  'social',
  'published',
  '{
    "auth": {
      "type": "bearer",
      "extra_headers": { "Content-Type": "application/json" }
    },
    "base_url_template": "https://graph.facebook.com/v21.0",
    "variables": [
      { "key": "page_id", "label": "Facebook Page ID", "help": "The numeric ID of the Page this employee looks after." }
    ],
    "ops": {
      "search_posts": {
        "method": "GET",
        "path_template": "/{page_id}/posts",
        "query_params": {
          "fields": "id,message,created_time,permalink_url,shares,likes.summary(true),comments.summary(true)",
          "limit": "25",
          "q": "{query}"
        },
        "response": {
          "items_path": "data",
          "id_path": "id",
          "title_path": "message",
          "snippet_path": "created_time",
          "url_path": "permalink_url"
        }
      },
      "get_post": {
        "method": "GET",
        "path_template": "/{ref}",
        "query_params": {
          "fields": "id,message,created_time,permalink_url,shares,likes.summary(true),comments.summary(true)"
        },
        "single_item": true,
        "response": {
          "items_path": "",
          "id_path": "id",
          "title_path": "message",
          "snippet_path": "created_time",
          "url_path": "permalink_url"
        }
      },
      "search_comments": {
        "method": "GET",
        "path_template": "/{page_id}/feed",
        "query_params": {
          "fields": "id,message,comments{id,message,from,created_time,like_count}",
          "limit": "25",
          "q": "{query}"
        },
        "response": {
          "items_path": "data",
          "id_path": "id",
          "title_path": "message",
          "snippet_path": "created_time"
        }
      }
    },
    "test_op": { "op": "search_posts", "params": { "query": "" } }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_def jsonb;
  v_n int;
  v_op text;
  v_binding jsonb;
BEGIN
  -- T1: every published platform template binds ONLY ops its category defines.
  -- An op outside the contract is unreachable by any employee.
  SELECT count(*) INTO v_n
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
   WHERE t.scope = 'platform' AND t.status = 'published'
     AND t.category IN ('ads','social','web_analytics')
     AND NOT (
       (t.category = 'ads' AND k IN ('search_campaigns','get_campaign','search_keywords','search_search_terms','get_account_performance')) OR
       (t.category = 'social' AND k IN ('search_posts','get_post','search_comments')) OR
       (t.category = 'web_analytics' AND k IN ('search_queries','get_page_metrics'))
     );
  IF v_n > 0 THEN RAISE EXCEPTION 'T1 FAILED: % bound op(s) are outside their category contract', v_n; END IF;

  -- T2: THE CONTRACT THE VALIDATOR ENFORCES, checked here too — every 'get'
  -- carries {ref} and every 'search' carries {query}, anywhere in the request.
  -- This is what the Google Ads template silently failed.
  FOR v_op, v_binding IN
    SELECT k, t.definition->'ops'->k
      FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
     WHERE t.scope = 'platform' AND t.status = 'published'
       AND t.category IN ('ads','social','web_analytics')
  LOOP
    IF v_op LIKE 'get\_%' AND v_binding::text NOT LIKE '%{ref}%' THEN
      RAISE EXCEPTION 'T2 FAILED: get op "%" carries no {ref} — the validator rejects it', v_op;
    END IF;
    IF v_op LIKE 'search\_%' AND v_binding::text NOT LIKE '%{query}%' THEN
      RAISE EXCEPTION 'T2 FAILED: search op "%" carries no {query} — the search words never reach the API', v_op;
    END IF;
  END LOOP;

  -- T3: Search Console must use the framework's moving window, never a literal
  -- date. A hard-coded date is correct on the day it ships and wrong forever
  -- after, and nothing would ever report it as broken.
  SELECT definition INTO v_def FROM adapter_templates WHERE name = 'Google Search Console';
  IF v_def IS NULL THEN RAISE EXCEPTION 'T3 FAILED: Search Console template missing'; END IF;
  IF (v_def->'ops')::text ~ '"(startDate|endDate)": *"[0-9]{4}-' THEN
    RAISE EXCEPTION 'T3 FAILED: a literal date is baked into the Search Console template';
  END IF;
  IF (v_def->'ops')::text NOT LIKE '%{days_ago_%' OR (v_def->'ops')::text NOT LIKE '%{today}%' THEN
    RAISE EXCEPTION 'T3 FAILED: Search Console does not use the relative-date placeholders';
  END IF;

  -- T4: Search Console needs no developer token. If a secret_headers mapping
  -- ever appears here someone has copied the Google Ads auth block wholesale,
  -- and the connector will demand a credential that does not exist for it.
  IF v_def->'auth' ? 'secret_headers' THEN
    RAISE EXCEPTION 'T4 FAILED: Search Console declares a secret header — it needs no developer token';
  END IF;

  -- T5: no social template may bind a WRITE. Publishing, replying, hiding,
  -- deleting and boosting are action_definitions under decide_action_execution;
  -- a read template that could post would route around every approval.
  SELECT count(*) INTO v_n
    FROM adapter_templates t, LATERAL jsonb_each(t.definition->'ops') o
   WHERE t.category = 'social' AND t.scope = 'platform'
     AND COALESCE(o.value->>'method','GET') NOT IN ('GET','POST');
  IF v_n > 0 THEN RAISE EXCEPTION 'T5 FAILED: a social template binds a mutating method'; END IF;

  IF (SELECT (definition->'ops')::text FROM adapter_templates WHERE name = 'Meta (Facebook & Instagram)') ILIKE '%"method": *"POST"%' THEN
    RAISE EXCEPTION 'T5 FAILED: the Meta template POSTs — reads only, writes go through actions';
  END IF;

  RAISE NOTICE '578 asserts passed: ads get fixed, Search Console (no dev token, moving window) and Meta (reads only) published.';
END
$probe$;

COMMIT;
