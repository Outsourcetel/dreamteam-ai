-- 585 — TikTok can publish after all. I was wrong twice.
--
-- 582 shipped TikTok read-only and I gave three reasons it could not post. Two
-- of them do not survive contact with the documentation, and the founder was
-- right to push back:
--
--   "It is a chunked file upload."   TRUE ONLY OF source=FILE_UPLOAD. There is
--                                    a second mode, PULL_FROM_URL, where TikTok
--                                    FETCHES the video from a URL we give it —
--                                    ONE call, no upload, no chunking. Exactly
--                                    the shape as Instagram fetching image_url.
--
--   "It needs a video we do not      Instagram needs a picture we do not
--    produce."                       produce, and 584 shipped it an hour
--                                    earlier with a human supplying image_url.
--                                    The same fact was a parameter there and a
--                                    disqualification here. That was not a
--                                    judgement, it was an inconsistency.
--
--   "Unaudited apps post privately."  TRUE, and the only real one — but it is an
--                                    APPROVAL gate, the same class as Meta's App
--                                    Review, which did not stop us building
--                                    Meta. privacy_level is a parameter.
--
-- ── TWO PATHS, AND THE SAFER ONE IS THE ONE WE ACTUALLY WANT ───────────────
--   /post/publish/inbox/video/init/   scope video.upload   -> the creator's
--                                     DRAFTS. Nothing public. They finish the
--                                     caption and post it in the TikTok app.
--                                     Does NOT need the full audit.
--   /post/publish/video/init/         scope video.publish  -> posts directly.
--                                     Needs the full audit for public reach.
--
-- The upload path is widely described as crippling — it "puts the creator in
-- the loop for every post, which defeats most automation use cases". That is a
-- defect for a scheduler. It is OUR ARCHITECTURE. Draft, human, publish is the
-- product, so the constraint that makes TikTok useless for everyone else costs
-- us nothing, and it works WITHOUT the audit.
--
--   upload_video_draft  SAFE   lands in the creator's drafts. A trusted
--                              employee may prepare alone; a person still
--                              finishes and posts it inside TikTok.
--   publish_video       GATED  posts straight to the profile. Needs the audit
--                              AND a person, and the approver sees which
--                              audience because privacy_level is on the form.
--
-- ── A WRITE THAT FAILS INSIDE AN HTTP 200 ──────────────────────────────────
-- Every TikTok Content Posting response is 200; the real outcome is in
-- error.code — "ok", or "spam_risk_too_many_posts", or a rejected video URL. Our
-- executor keys off the HTTP status, so a refused post would have been recorded
-- as a successful one: approval closed, audit row green, nothing posted. The
-- worst shape a write can have, and the exact silent-success family this whole
-- adapter series keeps turning up.
--
-- Closed generically in the same commit: a binding may declare
-- response.success_when = {path, equals}, and the vendor's own verdict is
-- checked BEFORE the id is read. Zoho, Salesforce composite and most
-- SOAP-descended JSON APIs do the same thing.
--
-- ── SETUP THE FOUNDER MUST DO (docs/43) ────────────────────────────────────
-- PULL_FROM_URL only accepts URLs on a domain VERIFIED with TikTok — a
-- signature file or DNS record on the host serving the video. Videos on an
-- unverified domain are rejected, and that rejection arrives as a 200.

BEGIN;

UPDATE adapter_templates SET
  name = 'TikTok',
  description = 'Reads an account''s videos and their view, like and comment counts, and prepares videos for posting. Two routes: preparing a video puts it in the creator''s TikTok drafts to finish in the app, and needs no TikTok audit; posting directly to the profile does. Either way a person supplies the video — the employee writes the caption. Videos must be hosted on a domain verified with TikTok.',
  definition = definition || jsonb_build_object('actions', '{
    "upload_video_draft": {
      "method": "POST",
      "path_template": "/post/publish/inbox/video/init/",
      "body_template": {
        "source_info": { "source": "PULL_FROM_URL", "video_url": "{video_url}" }
      },
      "response": {
        "id_path": "data.publish_id",
        "success_when": { "path": "error.code", "equals": "ok" }
      }
    },
    "publish_video": {
      "method": "POST",
      "path_template": "/post/publish/video/init/",
      "body_template": {
        "post_info": {
          "title": "{title}",
          "privacy_level": "{privacy_level}",
          "disable_comment": false,
          "disable_duet": false,
          "disable_stitch": false
        },
        "source_info": { "source": "PULL_FROM_URL", "video_url": "{video_url}" }
      },
      "response": {
        "id_path": "data.publish_id",
        "success_when": { "path": "error.code", "equals": "ok" }
      }
    }
  }'::jsonb),
  updated_at = now()
WHERE name = 'TikTok (read-only)' AND scope = 'platform';

INSERT INTO action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, template_id,
   param_schema, risk, execution, status, reversible)
SELECT
  'platform', NULL, 'social', v.action_key, v.label, v.description, 'template', t.id,
  v.param_schema, v.risk, '{}'::jsonb, 'active', v.reversible
FROM adapter_templates t,
  (VALUES
    ('upload_video_draft',
     'Send a video to the TikTok drafts',
     'Puts a video into the creator''s own TikTok drafts, where a person writes the final caption and posts it from the app. Nothing reaches the public and TikTok requires no audit for this route, so a trusted employee may prepare videos alone.',
     '[{"name":"video_url","type":"string","required":true,"help":"Public URL of the video, on a domain verified with TikTok. TikTok fetches it — a private or internal link is rejected."}]'::jsonb,
     '{"destructive": false, "idempotent": false}'::jsonb, true),
    ('publish_video',
     'Post a video to TikTok',
     'Posts straight to the profile. Destructive because it cannot be unsaid, and it needs TikTok''s app audit before anything can be seen publicly — without it TikTok forces the post private whatever privacy_level says. Always needs a person, who should watch the video, not just read the caption.',
     '[{"name":"video_url","type":"string","required":true,"help":"Public URL of the video, on a domain verified with TikTok"},
       {"name":"title","type":"string","required":true,"help":"The caption, hashtags included (max 2200 characters)"},
       {"name":"privacy_level","type":"string","required":true,"help":"PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS or SELF_ONLY. Must be one this account allows — and an unaudited app only gets SELF_ONLY."}]'::jsonb,
     '{"destructive": true, "idempotent": false}'::jsonb, false)
  ) AS v(action_key, label, description, param_schema, risk, reversible)
WHERE t.name = 'TikTok' AND t.scope = 'platform'
ON CONFLICT DO NOTHING;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_def jsonb;
  v_bad text;
  v_n int;
BEGIN
  SELECT definition INTO v_def FROM adapter_templates WHERE name = 'TikTok' AND scope = 'platform';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Z1 FAILED: TikTok template missing or not renamed'; END IF;

  -- Z2: NEITHER path may use FILE_UPLOAD. That is the chunked flow a single
  -- binding genuinely cannot express — it would render, TikTok would return an
  -- upload_url, and nothing would ever be uploaded to it. Success, no video.
  IF (v_def->'actions')::text LIKE '%FILE_UPLOAD%' THEN
    RAISE EXCEPTION 'Z2 FAILED: a binding uses FILE_UPLOAD — that needs a chunked upload no single call can do';
  END IF;
  IF (v_def->'actions'->'upload_video_draft'->'body_template'->'source_info'->>'source') <> 'PULL_FROM_URL'
     OR (v_def->'actions'->'publish_video'->'body_template'->'source_info'->>'source') <> 'PULL_FROM_URL' THEN
    RAISE EXCEPTION 'Z3 FAILED: a posting path is not PULL_FROM_URL';
  END IF;

  -- Z4: BOTH paths must judge the vendor''s own verdict. TikTok answers 200 to
  -- a refusal; without this a rejected post is recorded as a published one.
  SELECT string_agg(k, ', ') INTO v_bad
    FROM jsonb_object_keys(v_def->'actions') k
   WHERE (v_def->'actions'->k->'response'->'success_when'->>'path') IS DISTINCT FROM 'error.code'
      OR (v_def->'actions'->k->'response'->'success_when'->>'equals') IS DISTINCT FROM 'ok';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Z4 FAILED: these trust the HTTP status on an API that reports failure inside a 200: %', v_bad;
  END IF;

  -- Z5: THE TWO PATHS ARE DIFFERENT ENDPOINTS AND CLASSIFIED OPPOSITELY. The
  -- draft route is safe only because it lands somewhere private; if it ever
  -- pointed at the direct-post path, an ungated action would post in public.
  IF (v_def->'actions'->'upload_video_draft'->>'path_template') NOT LIKE '%/inbox/%' THEN
    RAISE EXCEPTION 'Z5 FAILED: the SAFE draft action does not target the inbox — it would post publicly';
  END IF;
  IF (v_def->'actions'->'upload_video_draft'->>'path_template')
     = (v_def->'actions'->'publish_video'->>'path_template') THEN
    RAISE EXCEPTION 'Z5 FAILED: draft and publish resolved to the same endpoint';
  END IF;

  SELECT string_agg(action_key || '=' || (risk->>'destructive'), ', ') INTO v_bad
    FROM action_definitions
   WHERE scope='platform' AND category='social'
     AND ((action_key = 'upload_video_draft' AND (risk->>'destructive')::boolean IS TRUE)
       OR (action_key = 'publish_video' AND (risk->>'destructive')::boolean IS NOT TRUE));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Z5 FAILED: draft/publish classified the wrong way round: %', v_bad;
  END IF;

  -- Z6: both bound, no optional param in either binding (581 V1 and V4).
  SELECT string_agg(a.action_key, ', ') INTO v_bad FROM action_definitions a
   WHERE a.scope='platform' AND a.status='active'
     AND a.action_key IN ('upload_video_draft','publish_video')
     AND NOT EXISTS (SELECT 1 FROM adapter_templates t
                      WHERE t.id = a.template_id AND t.definition->'actions' ? a.action_key);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Z6 FAILED: active but unbound: %', v_bad; END IF;

  SELECT string_agg(a.action_key || ' {' || (p->>'name') || '}', ', ') INTO v_bad
    FROM action_definitions a, LATERAL jsonb_array_elements(a.param_schema) p
   WHERE a.scope='platform' AND a.action_key IN ('upload_video_draft','publish_video')
     AND COALESCE((p->>'required')::boolean,false) = false
     AND (v_def->'actions'->a.action_key)::text LIKE '%{' || (p->>'name') || '}%';
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Z6 FAILED: binding uses an optional param: %', v_bad; END IF;

  -- Z7: nothing forked. publish_post is still one row; TikTok took its own keys
  -- because posting a VIDEO is a different shape, not a different vendor.
  SELECT count(*) INTO v_n FROM action_definitions
   WHERE scope='platform' AND category='social' AND action_key='publish_post';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Z7 FAILED: publish_post forked into % rows', v_n; END IF;

  RAISE NOTICE '585 asserts passed: TikTok drafts without an audit, posts only with one, and a 200 no longer means success.';
END
$probe$;

COMMIT;
