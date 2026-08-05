-- 576 — fix the Google Ads adapter's response paths, and the dead MCC variable.
--
-- 575 shipped a template that a test then proved could not read a single
-- keyword, search term or account total. Three defects, none visible by
-- inspection, none discoverable without a developer token:
--
-- ── 1. TWO NAMING CONVENTIONS IN ONE REQUEST ───────────────────────────────
-- Google Ads speaks snake_case in the QUERY and camelCase in the RESPONSE:
--
--     GAQL      SELECT ad_group_criterion.keyword.text FROM keyword_view
--     JSON      { "adGroupCriterion": { "keyword": { "text": "…" } } }
--
-- (The REST surface follows the proto3 JSON mapping, which lowerCamelCases
-- every field.) 575 wrote the queries correctly and then read the responses
-- back with the QUERY's field names. The API would have returned HTTP 200, the
-- items_path would have resolved, and every row would have produced an empty
-- ref and an empty title: ok, zero usable results, no error anywhere. A
-- connector that looks connected and silently knows nothing.
--
-- The fix is not six corrected strings — it is the INVARIANT in A2 below.
-- Google Ads JSON contains no underscores in field names, ever. So any response
-- path with an underscore is, categorically, a query name that leaked into the
-- response mapping. That assert would have caught all six, and will catch the
-- seventh when someone adds an op.
--
-- ── 2. single_item ON AN ARRAY ─────────────────────────────────────────────
-- get_campaign and get_account_performance set single_item over
-- items_path 'results'. runTemplateOp reads single_item as "walked.value IS the
-- record" and wraps it: list = [ [ {...} ] ]. Every field path then walks an
-- ARRAY and finds nothing. Google Ads always returns {results:[…]} — never a
-- bare object — so single_item is simply wrong here; the array branch already
-- yields exactly the one row a get returns.
--
-- ── 3. A VARIABLE THE EXECUTOR NEVER SENT ──────────────────────────────────
-- login_customer_id was collected by the wizard and used nowhere: it is not in
-- the base URL, and extra_headers was spread as literals with no rendering. It
-- is the MANAGER (MCC) account id, required on EVERY call when an agency runs
-- the account — which is our own deployment shape, so this would have failed on
-- the first real client, with a PERMISSION_DENIED that names neither the cause
-- nor the fix.
--
-- Fixed generically in connector-hub (same commit): extra_headers values are
-- now rendered against the connector's variables, and a header that renders
-- EMPTY is dropped rather than sent blank — which is exactly the semantics an
-- optional header needs, and avoids widening AdapterVar with an `optional`
-- flag that every other template would then have to think about. Google accepts
-- an absent login-customer-id and rejects a blank one.

BEGIN;

UPDATE adapter_templates SET
  definition = jsonb_strip_nulls(definition
    || jsonb_build_object(
      'auth', (definition->'auth') || '{"extra_headers": {
          "Content-Type": "application/json",
          "login-customer-id": "{login_customer_id}"
        }}'::jsonb,
      'ops', (definition->'ops')
        -- get_campaign: array response, so no single_item.
        || jsonb_build_object('get_campaign',
             ((definition->'ops'->'get_campaign') - 'single_item'))
        -- keywords: every response field was a GAQL name.
        || jsonb_build_object('search_keywords',
             jsonb_set(definition->'ops'->'search_keywords', '{response}', '{
               "items_path": "results",
               "id_path": "adGroupCriterion.criterionId",
               "title_path": "adGroupCriterion.keyword.text",
               "snippet_path": "adGroupCriterion.keyword.matchType"
             }'::jsonb))
        || jsonb_build_object('search_search_terms',
             jsonb_set(definition->'ops'->'search_search_terms', '{response}', '{
               "items_path": "results",
               "id_path": "searchTermView.searchTerm",
               "title_path": "searchTermView.searchTerm",
               "snippet_path": "searchTermView.status"
             }'::jsonb))
        || jsonb_build_object('get_account_performance',
             jsonb_set((definition->'ops'->'get_account_performance') - 'single_item', '{response}', '{
               "items_path": "results",
               "id_path": "customer.id",
               "title_path": "customer.descriptiveName",
               "snippet_path": "customer.currencyCode"
             }'::jsonb))
    )),
  updated_at = now()
WHERE name = 'Google Ads' AND scope = 'platform';

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_def jsonb;
  v_op text;
  v_binding jsonb;
  v_path text;
  v_key text;
BEGIN
  SELECT definition INTO v_def FROM adapter_templates
   WHERE name = 'Google Ads' AND scope = 'platform';
  IF v_def IS NULL THEN RAISE EXCEPTION 'A0 FAILED: template missing'; END IF;

  FOR v_op, v_binding IN SELECT * FROM jsonb_each(v_def->'ops') LOOP
    -- A1: single_item over an ARRAY items_path wraps the list in a list, and
    -- every field path then walks an array and finds nothing.
    IF (v_binding->>'single_item')::boolean IS TRUE AND COALESCE(v_binding->'response'->>'items_path','') = 'results' THEN
      RAISE EXCEPTION 'A1 FAILED: op "%" sets single_item over the results ARRAY — it would select a list of lists', v_op;
    END IF;

    -- A2: THE INVARIANT. Google Ads JSON field names never contain an
    -- underscore, so an underscore in a RESPONSE path is a GAQL query name that
    -- leaked into the response mapping. This is the general form of the bug 575
    -- shipped six times; it fails the next one too.
    FOREACH v_key IN ARRAY ARRAY['id_path','title_path','snippet_path','url_path'] LOOP
      v_path := v_binding->'response'->>v_key;
      IF v_path IS NOT NULL AND v_path LIKE '%\_%' THEN
        RAISE EXCEPTION 'A2 FAILED: op "%" has % = "%" — underscores are GAQL query names; the JSON response is camelCase', v_op, v_key, v_path;
      END IF;
    END LOOP;

    -- A3: the QUERY side must stay snake_case — the mirror mistake. Rewriting
    -- the GAQL to camelCase to "match" would make every query invalid.
    IF v_binding->'body_template'->>'query' IS NOT NULL
       AND v_binding->'body_template'->>'query' NOT LIKE '%\_%' THEN
      RAISE EXCEPTION 'A3 FAILED: op "%" has a GAQL query with no snake_case field — the query language is NOT camelCase', v_op;
    END IF;
  END LOOP;

  -- A4: the manager-account id is actually sent. A variable the wizard collects
  -- and the executor never transmits is dead configuration.
  IF v_def->'auth'->'extra_headers'->>'login-customer-id' IS DISTINCT FROM '{login_customer_id}' THEN
    RAISE EXCEPTION 'A4 FAILED: login_customer_id is declared as a variable but no header carries it';
  END IF;

  -- A5: 575's guarantees still hold (a definition-wide rewrite is exactly where
  -- an earlier control gets clobbered).
  IF v_def->'auth'->'secret_headers'->>'developer-token' IS DISTINCT FROM 'developer_token' THEN
    RAISE EXCEPTION 'A5 FAILED: the developer-token secret mapping was lost';
  END IF;
  IF (v_def->'auth'->'extra_headers')::text ILIKE '%developer%' THEN
    RAISE EXCEPTION 'A5 FAILED: a developer token literal landed in extra_headers';
  END IF;
  IF (v_def->'ops')::text ILIKE '%:mutate%' THEN
    RAISE EXCEPTION 'A5 FAILED: a mutate endpoint appeared — writes must stay under decide_action_execution';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_def->'ops')) <> 5 THEN
    RAISE EXCEPTION 'A5 FAILED: op count changed';
  END IF;

  RAISE NOTICE '576 asserts passed: response paths camelCase, GAQL still snake_case, no single_item over an array, MCC header wired.';
END
$probe$;

COMMIT;
