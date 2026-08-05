-- 584 — Instagram.
--
-- ── WHY IT IS A SEPARATE TEMPLATE FROM META ────────────────────────────────
-- Same host, same auth, same Business Manager — but its own ops. list_posts on
-- the Meta template reads the Facebook Page's feed; Instagram's reads
-- /{ig_user_id}/media. One op key per template, so they cannot share one. A
-- tenant connects both and gets two connectors in the social category, which is
-- also how the employee tells the two audiences apart.
--
-- ── INSTAGRAM CANNOT POST TEXT. AT ALL. ────────────────────────────────────
-- Every Instagram post requires image_url or video_url; there is no text-only
-- form. That is not a permission or an approval — it is what Instagram is. So
-- the caption-writing employee cannot post here alone in a way it can on
-- Facebook and LinkedIn: someone has to supply the picture. Said plainly in the
-- action description, because "the AI runs your Instagram" quietly means "and
-- you still choose every image".
--
-- ── THE TWO-STEP FLOW IS THE APPROVAL FLOW ─────────────────────────────────
-- Publishing is two calls: POST /{ig_user_id}/media builds a CONTAINER and
-- returns its id, then POST /{ig_user_id}/media_publish publishes that id.
-- Nothing is visible between the two, and containers expire in 24 hours.
--
-- That maps onto the approval model exactly, so the two calls are two actions:
--
--   create_media_draft  SAFE     builds the container. Invisible to everyone,
--                                expires by itself. The employee may prepare a
--                                post alone — that is the whole job.
--   publish_media       GATED    publishes a prepared container. The public act.
--
-- They are NOT publish_post. publish_post takes text; this takes a container id
-- that must already exist. Same rule, different shape, so a different action —
-- forcing them together would need an optional param, and an optional param
-- inside a binding breaks it every time it is omitted (581 V4).
--
-- ── THE FIELD THIS NEEDED, WHICH HAD NEVER BEEN READ ───────────────────────
-- Step two takes the id step one returned. AdapterActionBinding.response.id_path
-- has been declared since migration 035 — "where to find a confirming id/status
-- in the response, for the receipt" — and was only ever read for OPS. So the
-- body of a write response was discarded, execute_action returned
-- {receipt, ok, status, error}, and the container id had nowhere to go. Two-step
-- flows were impossible and nobody had noticed, because nothing had needed one.
--
-- Implemented in the same commit. It also fixes something quieter: until now a
-- successful publish could only say "HTTP 200". The approval, the audit row and
-- the post that actually appeared were three facts and only two were recorded.
--
-- ── PERMISSIONS (docs/43) ──────────────────────────────────────────────────
-- Facebook Login path: instagram_basic, instagram_content_publish,
-- pages_read_engagement. All need App Review and Business Verification, and the
-- account must be an Instagram BUSINESS account linked to the Facebook Page.
-- Rate limit: 100 published posts per rolling 24 hours.

BEGIN;

INSERT INTO adapter_templates (scope, tenant_id, name, description, category, status, definition, created_by)
VALUES (
  'platform', NULL,
  'Instagram (Business)',
  'Reads an Instagram business account''s posts and the comments on them, and prepares posts for approval. Instagram requires a picture or video on every post — it has no text-only form — so a person supplies the image and the employee writes the caption. Requires an Instagram Business account linked to a Facebook Page, plus Meta App Review.',
  'social',
  'published',
  '{
    "auth": {
      "type": "bearer",
      "extra_headers": { "Content-Type": "application/json" }
    },
    "base_url_template": "https://graph.facebook.com/v21.0",
    "variables": [
      { "key": "ig_user_id", "label": "Instagram business account ID", "help": "The numeric IG user id — not the @handle. It appears in Business Manager against the linked Facebook Page." }
    ],
    "ops": {
      "list_posts": {
        "method": "GET",
        "path_template": "/{ig_user_id}/media",
        "query_params": {
          "fields": "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
          "limit": "25"
        },
        "response": {
          "items_path": "data",
          "id_path": "id",
          "title_path": "caption",
          "snippet_path": "media_type",
          "url_path": "permalink"
        }
      },
      "get_post": {
        "method": "GET",
        "path_template": "/{ref}",
        "single_item": true,
        "query_params": {
          "fields": "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count"
        },
        "response": {
          "items_path": "",
          "id_path": "id",
          "title_path": "caption",
          "snippet_path": "media_type",
          "url_path": "permalink"
        }
      },
      "list_comments": {
        "method": "GET",
        "path_template": "/{ig_user_id}/media",
        "query_params": {
          "fields": "id,caption,permalink,timestamp,comments{id,text,username,timestamp,like_count}",
          "limit": "25"
        },
        "response": {
          "items_path": "data",
          "id_path": "id",
          "title_path": "caption",
          "snippet_path": "timestamp",
          "url_path": "permalink"
        }
      }
    },
    "actions": {
      "create_media_draft": {
        "method": "POST",
        "path_template": "/{ig_user_id}/media",
        "body_template": {
          "image_url": "{image_url}",
          "caption": "{caption}",
          "media_type": "IMAGE"
        },
        "response": { "id_path": "id" }
      },
      "publish_media": {
        "method": "POST",
        "path_template": "/{ig_user_id}/media_publish",
        "body_template": { "creation_id": "{creation_id}" },
        "response": { "id_path": "id" }
      },
      "reply_to_comment": {
        "method": "POST",
        "path_template": "/{comment_ref}/replies",
        "body_template": { "message": "{body}" },
        "response": { "id_path": "id" }
      }
    },
    "test_op": { "op": "list_posts", "params": {} }
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ── The two new governed actions ───────────────────────────────────────────
INSERT INTO action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, template_id,
   param_schema, risk, execution, status, reversible)
SELECT
  'platform', NULL, 'social', v.action_key, v.label, v.description, 'template', t.id,
  v.param_schema, v.risk, '{}'::jsonb, 'active', v.reversible
FROM adapter_templates t,
  (VALUES
    ('create_media_draft',
     'Prepare an Instagram post (not published)',
     'Builds the post — picture plus caption — and holds it. Nobody can see it, and Instagram discards it by itself after 24 hours if it is never published. The picture must already be somewhere public on the web; Instagram fetches it. A trusted employee may prepare posts alone.',
     '[{"name":"image_url","type":"string","required":true,"help":"Public URL of the picture. Instagram fetches it, so it cannot be a private or internal link."},
       {"name":"caption","type":"string","required":true,"help":"The caption text, hashtags included"}]'::jsonb,
     '{"destructive": false, "idempotent": false}'::jsonb, true),
    ('publish_media',
     'Publish a prepared Instagram post',
     'Publishes a post that was already prepared, putting it in front of the public under the business''s name. Destructive because it cannot be unsaid. Always needs a person — who should look at the picture, not only the caption.',
     '[{"name":"creation_id","type":"string","required":true,"help":"The id returned when the post was prepared"}]'::jsonb,
     '{"destructive": true, "idempotent": false}'::jsonb, false)
  ) AS v(action_key, label, description, param_schema, risk, reversible)
WHERE t.name = 'Instagram (Business)' AND t.scope = 'platform'
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_def jsonb;
  v_bad text;
  v_n int;
BEGIN
  SELECT definition INTO v_def FROM adapter_templates WHERE name = 'Instagram (Business)';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Y1 FAILED: template not installed'; END IF;

  -- Y2: THE TWO-STEP CHAIN. create must declare where its id comes from, and
  -- publish must consume one. Without id_path on the create, step two has no
  -- step one and the whole flow is dead — which is exactly the state this
  -- migration found the framework in.
  IF v_def->'actions'->'create_media_draft'->'response'->>'id_path' IS DISTINCT FROM 'id' THEN
    RAISE EXCEPTION 'Y2 FAILED: create_media_draft does not say where its container id is — publish_media can never be fed';
  END IF;
  IF (v_def->'actions'->'publish_media'->'body_template')::text NOT LIKE '%{creation_id}%' THEN
    RAISE EXCEPTION 'Y2 FAILED: publish_media does not consume a container id';
  END IF;

  -- Y3: preparing is free, publishing is gated. The rule, on the shape that
  -- most tempts you to break it: a container is genuinely invisible, so the
  -- pressure is to gate nothing — and then the publish step gates nothing too.
  SELECT string_agg(action_key || '=' || (risk->>'destructive'), ', ') INTO v_bad
    FROM action_definitions
   WHERE scope='platform' AND category='social'
     AND ((action_key = 'create_media_draft' AND (risk->>'destructive')::boolean IS TRUE)
       OR (action_key = 'publish_media' AND (risk->>'destructive')::boolean IS NOT TRUE));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Y3 FAILED: prepare/publish are classified the wrong way round: %', v_bad;
  END IF;

  -- Y4: both are BOUND. An active action with no binding asks a person to
  -- approve something that then does nothing (581 V1).
  SELECT string_agg(a.action_key, ', ') INTO v_bad
    FROM action_definitions a
   WHERE a.scope='platform' AND a.status='active'
     AND a.action_key IN ('create_media_draft','publish_media')
     AND NOT EXISTS (SELECT 1 FROM adapter_templates t
                      WHERE t.id = a.template_id AND t.definition->'actions' ? a.action_key);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Y4 FAILED: active but unbound: %', v_bad; END IF;

  -- Y5: no OPTIONAL param appears in any Instagram binding. renderAction fails
  -- the whole request on an unresolved placeholder, so an optional param in a
  -- body is broken every time it is left out (581 V4).
  SELECT string_agg(a.action_key || ' {' || (p->>'name') || '}', ', ') INTO v_bad
    FROM action_definitions a, LATERAL jsonb_array_elements(a.param_schema) p
   WHERE a.scope='platform' AND a.action_key IN ('create_media_draft','publish_media')
     AND COALESCE((p->>'required')::boolean,false) = false
     AND (v_def->'actions'->a.action_key)::text LIKE '%{' || (p->>'name') || '}%';
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Y5 FAILED: binding uses an optional param: %', v_bad; END IF;

  -- Y6: the ops are legal for the social category, and test_op names one.
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(v_def->'ops') k
   WHERE k NOT IN ('list_posts','search_posts','get_post','list_comments','search_comments');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Y6 FAILED: op outside the social contract: %', v_bad; END IF;
  IF NOT (v_def->'ops' ? (v_def->'test_op'->>'op')) THEN
    RAISE EXCEPTION 'Y6 FAILED: test_op names an unbound op — the wizard would fail on a good connection';
  END IF;

  -- Y7: publish_post is STILL one row. Instagram deliberately did not fork it.
  SELECT count(*) INTO v_n FROM action_definitions
   WHERE scope='platform' AND category='social' AND action_key='publish_post';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Y7 FAILED: publish_post forked into % rows', v_n; END IF;

  RAISE NOTICE '584 asserts passed: Instagram prepares freely, publishes only with a person, and the container id now has somewhere to go.';
END
$probe$;

COMMIT;
