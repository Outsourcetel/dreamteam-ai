-- 583 — Meta's test_op still named the op that 582 renamed.
--
-- test_op is what the connect wizard calls to prove a new connection works. It
-- pointed at search_posts, which 582 replaced with list_posts, so the very first
-- thing a user does after entering their credentials would have failed — with an
-- error about an unbound operation rather than anything about their Page.
--
-- Found by the framework validator, which the test now runs against every
-- template. A rename is never just a rename: it is a rename plus every place the
-- old name was written down.

BEGIN;

UPDATE adapter_templates SET
  definition = jsonb_set(definition, '{test_op,op}', to_jsonb('list_posts'::text)),
  updated_at = now()
WHERE name = 'Meta (Facebook & Instagram)' AND scope = 'platform';

DO $probe$
DECLARE v_bad text;
BEGIN
  -- X1: EVERY template's test_op names an op it actually binds. The wizard's
  -- first call after a credential is entered; if it is wrong, a correct
  -- connection looks broken and the message points at the wrong thing.
  SELECT string_agg(t.name || ' -> ' || (t.definition->'test_op'->>'op'), ', ') INTO v_bad
    FROM adapter_templates t
   WHERE t.scope = 'platform' AND t.status = 'published'
     AND t.definition ? 'test_op'
     AND NOT (t.definition->'ops' ? (t.definition->'test_op'->>'op'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'X1 FAILED: test_op names an unbound operation: %', v_bad;
  END IF;

  RAISE NOTICE 'X1 passed: every published template tests an op it binds.';
END
$probe$;

COMMIT;
