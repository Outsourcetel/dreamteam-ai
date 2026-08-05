-- 586 — three loose ends from today, all of them mine.
--
-- 1. THE META TEMPLATE IS MISNAMED. It is called "Meta (Facebook & Instagram)"
--    and, since 584 gave Instagram its own template, it does Facebook only.
--    Someone choosing it for a client's Instagram would connect a Page, watch
--    the test pass, and find no Instagram anywhere — the worst kind of naming
--    error, because everything works and the wrong thing is connected. Renamed
--    to "Facebook Page".
--
-- 2. TIKTOK'S READ OPS TRUSTED THE HTTP STATUS. 585 taught ACTIONS to check
--    error.code because TikTok answers 200 on failure, and left ops trusting the
--    status. An expired token or a rate limit returns
--    {data:{videos:[]}, error:{code:"..."}}, which reads as "this account has no
--    videos". A wrong answer wearing the costume of a right one, and the sort
--    that gets reported months later as "the numbers look low". success_when now
--    guards ops too (same commit).
--
-- 3. search_posts AND search_comments WERE ORPHANED BY 582. It replaced both
--    with list_* because no social platform text-searches an account's own
--    posts. They stayed declared in the category contract, which is UI-facing —
--    the onboarding step picks from it and uses CATEGORY_OPS[cat][0] as a
--    default — so the product was offering two operations nothing could run.
--    Removed from the contract (same commit). Verified first that no connector,
--    binding or execution referenced them; social has zero connectors, so there
--    was nothing to break.

BEGIN;

UPDATE adapter_templates SET
  name = 'Facebook Page',
  description = 'Reads a Facebook Page''s recent posts, their engagement and the comments on them, and publishes posts and replies a person has approved. Instagram is a separate connector — connect "Instagram (Business)" as well if the client runs both.',
  updated_at = now()
WHERE name = 'Meta (Facebook & Instagram)' AND scope = 'platform';

UPDATE adapter_templates SET
  definition = jsonb_set(definition, '{ops,list_posts,response,success_when}',
                         '{"path": "error.code", "equals": "ok"}'::jsonb),
  updated_at = now()
WHERE name = 'TikTok' AND scope = 'platform';

UPDATE adapter_templates SET
  definition = jsonb_set(definition, '{ops,get_post,response,success_when}',
                         '{"path": "error.code", "equals": "ok"}'::jsonb),
  updated_at = now()
WHERE name = 'TikTok' AND scope = 'platform';

DO $probe$
DECLARE
  v_bad text;
  v_n int;
BEGIN
  -- AA1: no template name promises a system it does not reach. Checked as a
  -- rule rather than a spot-fix: a name is the only thing the person choosing a
  -- connector actually reads.
  SELECT string_agg(t.name, ', ') INTO v_bad
    FROM adapter_templates t
   WHERE t.scope = 'platform' AND t.status = 'published'
     AND t.name ILIKE '%instagram%' AND t.name NOT ILIKE 'Instagram%'
     AND NOT ((t.definition->>'base_url_template') ILIKE '%instagram%'
              OR (t.definition::text) ILIKE '%ig_user_id%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AA1 FAILED: template names Instagram but cannot reach it: %', v_bad;
  END IF;

  -- AA2: every TikTok op AND action judges the vendor's verdict. TikTok never
  -- signals failure any other way, so an unguarded binding there is a binding
  -- that cannot tell success from failure at all.
  SELECT string_agg(k, ', ') INTO v_bad
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
   WHERE t.name = 'TikTok'
     AND (t.definition->'ops'->k->'response'->'success_when'->>'equals') IS DISTINCT FROM 'ok';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AA2 FAILED: TikTok read op trusts the HTTP status: %', v_bad;
  END IF;

  SELECT string_agg(k, ', ') INTO v_bad
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'actions') k
   WHERE t.name = 'TikTok'
     AND (t.definition->'actions'->k->'response'->'success_when'->>'equals') IS DISTINCT FROM 'ok';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AA2 FAILED: TikTok write trusts the HTTP status: %', v_bad;
  END IF;

  -- AA3: the rename did not orphan anything. Actions resolve through the
  -- connector's template now, but the action rows still carry a template_id, and
  -- a rename must not have broken that link.
  SELECT count(*) INTO v_n FROM action_definitions a
   WHERE a.scope='platform' AND a.status='active' AND a.category='social'
     AND NOT EXISTS (SELECT 1 FROM adapter_templates t WHERE t.id = a.template_id);
  IF v_n > 0 THEN RAISE EXCEPTION 'AA3 FAILED: % social action(s) point at a template that no longer exists', v_n; END IF;

  -- AA4: every social template still binds only ops the contract declares —
  -- and the contract just lost search_posts and search_comments.
  SELECT string_agg(t.name || '.' || k, ', ') INTO v_bad
    FROM adapter_templates t, LATERAL jsonb_object_keys(t.definition->'ops') k
   WHERE t.scope='platform' AND t.category='social'
     AND k NOT IN ('list_posts','get_post','list_comments');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AA4 FAILED: social op outside the pruned contract: %', v_bad;
  END IF;

  RAISE NOTICE '586 asserts passed: Facebook Page named for what it is, TikTok judges its own verdict everywhere, contract has no dead ops.';
END
$probe$;

COMMIT;
