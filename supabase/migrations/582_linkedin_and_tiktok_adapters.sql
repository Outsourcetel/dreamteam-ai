-- 582 — the LinkedIn and TikTok adapters.
--
-- Built to order. I had argued against these twice on the grounds that a
-- template which cannot post reads as capability it does not have. That concern
-- turned out to be right about ONE of them and wrong about the other, which is
-- the useful outcome of actually reading both APIs instead of reasoning about
-- them:
--
--   LINKEDIN  publishes properly. POST /rest/posts is ONE call, text-only posts
--             are first-class, and delete is one call. Full capability.
--   TIKTOK    cannot publish, and not because of the approval gate. Posting is
--             /v2/post/publish/video/init/ which returns an upload_url, then a
--             CHUNKED FILE UPLOAD, then a status poll. It needs a video file we
--             do not have — the employee writes text — and TikTok's own docs
--             say "all content posted by unaudited clients will be restricted
--             to private viewing mode". Three independent blockers, only one of
--             which an approval would clear. Reads only, and the template says
--             so in its description.
--
-- ── THREE FRAMEWORK GAPS THESE EXPOSED (all closed generically, same commit) ─
--
-- 1. A 'list' OP KIND. The contract had search (must carry {query}) and get
--    (must carry {ref}). NONE of Meta, LinkedIn or TikTok will text-search an
--    account's OWN posts — you read the most recent N. The shipped Meta
--    template papered over this by passing q={query} to an edge that has no q
--    parameter: it renders, returns 200, and silently ignores what was asked
--    for. That is the fake-capability shape, and it was mine. list_posts says
--    what it is, and the validator now REJECTS a list op that takes {query}.
--
-- 2. PER-OPERATION HEADERS. LinkedIn's X-RestLi-Method changes with the
--    operation — FINDER to search, DELETE to delete. extra_headers is
--    per-template and cannot express that. Merged before auth, so a binding can
--    never overwrite Authorization.
--
-- 3. THE BINDING NOW COMES FROM THE CONNECTOR'S TEMPLATE. This is the one that
--    mattered. action_definitions is UNIQUE on
--    (scope, tenant_id, category, action_key), so "publish a post" is ONE row
--    for the whole social category — it cannot be duplicated per vendor. Until
--    now renderRegisteredAction read def.template_id, which hardwired
--    publish_post to Meta. A LinkedIn connector would have rendered Meta's URL
--    and posted to graph.facebook.com. Which system a governed capability acts
--    on is a property of the CONNECTOR the caller chose, not of the action
--    definition.
--
-- ── WHAT EACH NEEDS BEFORE IT CAN RUN (docs/43) ────────────────────────────
-- LinkedIn: w_organization_social to post, r_organization_social to read, both
-- via the Community Management API — a review LinkedIn documents as 2-4 weeks.
-- The authenticated person must hold ADMINISTRATOR, CONTENT_ADMIN or
-- DIRECT_SPONSORED_CONTENT_POSTER on the Page.
-- TikTok: video.list for reads. Publishing would additionally need video.publish
-- AND the audit — but we are not requesting it, because we cannot build it.
--
-- Linkedin-Version is a literal (YYYYMM) rather than a connector variable: it is
-- OUR contract with LinkedIn's API, not the tenant's configuration, and asking a
-- non-technical user to type a version string invites a wrong answer. LinkedIn
-- sunsets versions on a rolling basis, so this needs a periodic bump in a
-- migration — the assert below pins the format so a malformed one cannot ship.

BEGIN;

-- ── LinkedIn ───────────────────────────────────────────────────────────────
INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'LinkedIn (Company Page)',
  'Reads a company Page''s recent posts and publishes text posts to it. Publishing and deleting are governed actions approved by a person. Requires LinkedIn Community Management API access (w_organization_social / r_organization_social), which LinkedIn reviews in about 2-4 weeks.',
  'social',
  'published',
  '{
    "auth": {
      "type": "oauth2_refresh_token",
      "token_url": "https://www.linkedin.com/oauth/v2/accessToken",
      "extra_headers": {
        "X-Restli-Protocol-Version": "2.0.0",
        "Linkedin-Version": "202607",
        "Content-Type": "application/json"
      }
    },
    "base_url_template": "https://api.linkedin.com/rest",
    "variables": [
      { "key": "organization_id", "label": "LinkedIn organisation ID", "help": "The numeric id from your Company Page admin URL — 5515715, not the vanity name." }
    ],
    "ops": {
      "list_posts": {
        "method": "GET",
        "path_template": "/posts",
        "headers": { "X-RestLi-Method": "FINDER" },
        "query_params": {
          "author": "urn:li:organization:{organization_id}",
          "q": "author",
          "count": "25",
          "sortBy": "LAST_MODIFIED"
        },
        "response": {
          "items_path": "elements",
          "id_path": "id",
          "title_path": "commentary",
          "snippet_path": "lifecycleState"
        }
      },
      "get_post": {
        "method": "GET",
        "path_template": "/posts/{ref}",
        "single_item": true,
        "response": {
          "items_path": "",
          "id_path": "id",
          "title_path": "commentary",
          "snippet_path": "lifecycleState"
        }
      }
    },
    "actions": {
      "publish_post": {
        "method": "POST",
        "path_template": "/posts",
        "body_template": {
          "author": "urn:li:organization:{organization_id}",
          "commentary": "{body}",
          "visibility": "PUBLIC",
          "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": []
          },
          "lifecycleState": "PUBLISHED",
          "isReshareDisabledByAuthor": false
        }
      },
      "delete_post": {
        "method": "DELETE",
        "path_template": "/posts/{post_ref}",
        "headers": { "X-RestLi-Method": "DELETE" }
      }
    },
    "test_op": { "op": "list_posts", "params": {} }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── TikTok ─────────────────────────────────────────────────────────────────
INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'TikTok (read-only)',
  'Reads an account''s own videos and their view, like and comment counts, so the employee can report on what worked. It CANNOT post: TikTok publishing is a chunked video-file upload, it needs a video we do not produce, and unaudited apps can only post privately. Requires the video.list scope.',
  'social',
  'published',
  '{
    "auth": {
      "type": "oauth2_refresh_token",
      "token_url": "https://open.tiktokapis.com/v2/oauth/token/",
      "extra_headers": { "Content-Type": "application/json; charset=UTF-8" }
    },
    "base_url_template": "https://open.tiktokapis.com/v2",
    "variables": [],
    "ops": {
      "list_posts": {
        "method": "POST",
        "path_template": "/video/list/",
        "query_params": { "fields": "id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count" },
        "body_template": { "max_count": 20 },
        "response": {
          "items_path": "data.videos",
          "id_path": "id",
          "title_path": "title",
          "snippet_path": "video_description",
          "url_path": "share_url"
        }
      },
      "get_post": {
        "method": "POST",
        "path_template": "/video/query/",
        "query_params": { "fields": "id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count" },
        "body_template": { "filters": { "video_ids": ["{ref}"] } },
        "response": {
          "items_path": "data.videos",
          "id_path": "id",
          "title_path": "title",
          "snippet_path": "video_description",
          "url_path": "share_url"
        }
      }
    },
    "test_op": { "op": "list_posts", "params": {} }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── Retire the fake search on Meta ─────────────────────────────────────────
-- search_posts passed q={query} to an edge with no q parameter: it rendered,
-- returned 200, and ignored the query. Replaced with the honest list op. The
-- comment reader keeps its q for the same reason it always should not have had
-- one, so it goes too.
-- search_comments went the same way and for the same reason: /{page_id}/feed
-- has no q either. Caught by W2 below when the q was stripped and the op was
-- left calling itself a search — the assert refusing to let a half-fix through.
UPDATE adapter_templates SET
  definition = jsonb_set(
    jsonb_set(
      (definition #- '{ops,search_posts}') #- '{ops,search_comments}',
      '{ops,list_posts}', (definition->'ops'->'search_posts') #- '{query_params,q}'),
    '{ops,list_comments}', (definition->'ops'->'search_comments') #- '{query_params,q}'),
  updated_at = now()
WHERE name = 'Meta (Facebook & Instagram)' AND scope = 'platform';

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_t record;
  v_op text;
  v_b jsonb;
  v_bad text;
  v_n int;
BEGIN
  -- W1: NO op may pretend to search when it cannot. A list op that carries
  -- {query} is the exact fake-capability this migration removes.
  SELECT string_agg(t.name || '.' || k, ', ') INTO v_bad
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
   WHERE t.scope = 'platform' AND t.category IN ('ads','social','web_analytics')
     AND k LIKE 'list\_%' AND (t.definition->'ops'->k)::text LIKE '%{query}%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'W1 FAILED: a list op takes {query} — it either searches or it does not: %', v_bad;
  END IF;

  -- W2: and no search op survives that does not actually reach the API with it.
  SELECT string_agg(t.name || '.' || k, ', ') INTO v_bad
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
   WHERE t.scope = 'platform' AND t.category IN ('ads','social','web_analytics')
     AND k LIKE 'search\_%' AND (t.definition->'ops'->k)::text NOT LIKE '%{query}%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'W2 FAILED: search op never sends {query}: %', v_bad;
  END IF;

  -- W3: TikTok binds NO actions. Its description promises it cannot post, and a
  -- promise in prose beside a binding that posts is worse than either alone.
  IF (SELECT definition ? 'actions' FROM adapter_templates WHERE name = 'TikTok (read-only)') THEN
    RAISE EXCEPTION 'W3 FAILED: the read-only TikTok template binds a write';
  END IF;

  -- W4: LinkedIn's version header is present and well formed. A malformed or
  -- missing Linkedin-Version is rejected by every LinkedIn endpoint, and the
  -- error does not say which header is at fault.
  SELECT definition->'auth'->'extra_headers'->>'Linkedin-Version' INTO v_bad
    FROM adapter_templates WHERE name = 'LinkedIn (Company Page)';
  IF v_bad IS NULL OR v_bad !~ '^20[0-9]{2}(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'W4 FAILED: Linkedin-Version is "%", expected YYYYMM', COALESCE(v_bad, '(absent)');
  END IF;

  -- W5: every social template that binds publish_post renders the SAME
  -- governed action. That only works because the binding now resolves through
  -- the connector's template; if a second one appeared under a different
  -- action_key the approval and its risk classification would fork.
  SELECT count(*) INTO v_n FROM adapter_templates
   WHERE scope = 'platform' AND category = 'social' AND definition->'actions' ? 'publish_post';
  IF v_n < 2 THEN
    RAISE EXCEPTION 'W5 FAILED: expected Meta AND LinkedIn to bind publish_post, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM action_definitions
   WHERE scope = 'platform' AND category = 'social' AND action_key = 'publish_post';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'W5 FAILED: publish_post has % definitions — the capability has forked', v_n;
  END IF;

  -- W6: still gated. Two more systems can now speak in public; the rule holds.
  IF (SELECT (risk->>'destructive')::boolean FROM action_definitions
       WHERE scope='platform' AND category='social' AND action_key='publish_post') IS NOT TRUE THEN
    RAISE EXCEPTION 'W6 FAILED: publish_post is no longer gated';
  END IF;

  -- W7: every bound op is legal for its category (list_posts is new).
  FOR v_t IN SELECT name, category, definition FROM adapter_templates
              WHERE scope='platform' AND status='published' AND category IN ('ads','social','web_analytics') LOOP
    FOR v_op, v_b IN SELECT * FROM jsonb_each(v_t.definition->'ops') LOOP
      IF NOT (
        (v_t.category = 'social' AND v_op IN ('list_posts','search_posts','get_post','list_comments','search_comments')) OR
        (v_t.category = 'ads' AND v_op IN ('search_campaigns','get_campaign','search_keywords','search_search_terms','get_account_performance')) OR
        (v_t.category = 'web_analytics' AND v_op IN ('search_queries','get_page_metrics'))
      ) THEN
        RAISE EXCEPTION 'W7 FAILED: %/% is not in the % contract', v_t.name, v_op, v_t.category;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '582 asserts passed: LinkedIn publishes, TikTok reads only, Meta''s fake search retired.';
END
$probe$;

COMMIT;
