-- 579 — Meta search_comments asked for fields it then failed to read.
--
-- On a fields-based API (Meta, Salesforce, Zoho) the response contains ONLY the
-- fields you name. search_comments requested "id,message,comments{…}" and then
-- read snippet_path "created_time" — a field it never asked for. Result: HTTP
-- 200, rows returned, every snippet empty. The same silent-success shape as the
-- Google Ads camelCase bug, from a different cause.
--
-- The general invariant, now asserted: EVERY response path's first segment must
-- appear in the fields parameter. It is checked for all three marketing
-- templates, not just the one that had the bug.
--
-- ── WHAT search_comments ACTUALLY RETURNS, stated plainly ──────────────────
-- Meta has no page-wide comments edge. There is no /{page_id}/comments. The
-- only way to see what people are saying across a Page is /{page_id}/feed with
-- comments nested inside each post, and the framework's items_path walks to ONE
-- list — it cannot flatten data[].comments.data[] into a list of comments.
--
-- So each item IS A POST, and the comments live in its raw payload, which the
-- executor passes through whole (raw: o). The employee monitoring comments gets
-- what it needs — the post, and everything said under it, including each
-- comment's own id, which is what reply_to_comment takes. The title and snippet
-- describe the post because that is honestly what the item is. Renaming the op
-- would break the category contract; pretending the item is a comment would be
-- worse than the truth.

BEGIN;

UPDATE adapter_templates SET
  definition = jsonb_set(
    definition, '{ops,search_comments,query_params,fields}',
    to_jsonb('id,message,created_time,permalink_url,comments{id,message,from,created_time,like_count}'::text)),
  updated_at = now()
WHERE name = 'Meta (Facebook & Instagram)' AND scope = 'platform';

DO $probe$
DECLARE
  v_t record;
  v_op text;
  v_binding jsonb;
  v_fields text;
  v_path text;
  v_key text;
  v_root text;
BEGIN
  -- U1: THE INVARIANT. On a fields-based API every response path must be
  -- requested, or it silently reads empty. Only applies where the op actually
  -- declares a fields parameter — templates without one return everything.
  FOR v_t IN
    SELECT name, definition FROM adapter_templates
     WHERE scope = 'platform' AND status = 'published'
       AND category IN ('ads','social','web_analytics')
  LOOP
    FOR v_op, v_binding IN SELECT * FROM jsonb_each(v_t.definition->'ops') LOOP
      v_fields := v_binding->'query_params'->>'fields';
      CONTINUE WHEN v_fields IS NULL;

      FOREACH v_key IN ARRAY ARRAY['id_path','title_path','snippet_path','url_path'] LOOP
        v_path := v_binding->'response'->>v_key;
        CONTINUE WHEN v_path IS NULL OR v_path = '';
        v_root := split_part(v_path, '.', 1);
        IF position(v_root in v_fields) = 0 THEN
          RAISE EXCEPTION 'U1 FAILED: %/% reads % ("%") but never requests "%" in fields — it would read empty with no error',
            v_t.name, v_op, v_key, v_path, v_root;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'U1 passed: every response path is present in its op''s fields parameter.';
END
$probe$;

COMMIT;
