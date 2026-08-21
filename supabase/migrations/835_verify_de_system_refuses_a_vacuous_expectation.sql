-- 835_verify_de_system_refuses_a_vacuous_expectation.sql
-- ==========================================================================
-- WHY: verify_de_system recorded matched = true for a check that compared
--      NOTHING, so a digital employee could manufacture its own evidence of
--      having "come back and confirmed the write landed".
-- ==========================================================================
--
-- ── THE MECHANISM ─────────────────────────────────────────────────────────
-- mig 221:128-135 compares each expectation key like this:
--
--     v_exp := p_expectation->>k;      -- a JSON null   -> SQL NULL
--     v_act := v_actual->>k;           -- an absent key -> SQL NULL
--     IF v_exp IS DISTINCT FROM v_act THEN ... record a difference
--
-- NULL IS DISTINCT FROM NULL is FALSE. So an expectation of {"anything": null}
-- against a record that does not carry that key records no difference, leaves
-- v_matched at its initial true, and INSERTs a row reading "verified, matched"
-- for a comparison that never happened. The same holds for {} (the loop body
-- never runs) and for a SQL NULL expectation (jsonb_object_keys yields no rows).
--
-- Reproduced on production before this migration was written, by replaying
-- that exact loop rather than reasoning about it:
--
--   {"reference": null}  vs {"status":"settled"} -> matched TRUE   the bug
--   {"status": "paid"}   vs {"status":"settled"} -> matched FALSE  (control)
--   {"status":"settled"} vs {"status":"settled"} -> matched TRUE   (control)
--
-- The two controls are the point. Without them, "matched came back true" is
-- equally consistent with a replay that says true no matter what it is given.
--
-- ── WHY IT IS REACHABLE, NOT THEORETICAL ──────────────────────────────────
-- de-work offers verify_in_system to the model with `expectation` declared as
-- { type: 'object' } and NO property schema (de-work/index.ts:2020), and
-- passes it through untouched as `input.expectation ?? {}` (:975). entity_ref
-- is model-controlled whenever it is a uuid (:105-106). An employee could
-- therefore name real records and bank one "verified" row per record having
-- checked none of them.
--
-- ── RELATIONSHIP TO 832 ───────────────────────────────────────────────────
-- 832 already declines to COUNT such rows as promotion evidence, and said in
-- terms that the underlying data was still wrong and that fixing the writer
-- was a separate change (832:401-407). This is that change. Both now use the
-- SAME predicate -- "at least one expectation value that is not JSON null" --
-- so the writer and the counter cannot drift into two different ideas of what
-- a verification is. 832's D3c control (a MIXED expectation, one null value
-- beside one real one, DID put a genuine field to the system of record and
-- must still count) is mirrored below as an ALLOW arm, so this migration
-- cannot over-correct into refusing genuine work.
--
-- ── WHAT THIS DOES NOT DO, STATED PLAINLY ─────────────────────────────────
-- 1. NO BACKFILL, because there is nothing to backfill. Counted on production
--    immediately before writing this: 2 rows in de_system_verifications, both
--    matched = true, both carrying genuinely populated expectations; 0 vacuous,
--    0 non-object. That zero is load-bearing, so the predicate behind it was
--    inverted first against 9 synthetic expectations of known classification
--    -- including the falsy traps {"n": 0} and {"paid": false}, which must NOT
--    read as vacuous -- and agreed on all 9. A zero from a predicate proven to
--    fire in both directions; not a zero from a predicate that never fires.
--
-- 2. JSON-null keys are still COMPARED when the expectation also carries a
--    real key. Deliberate: such a key can only ever ADD a difference (the loop
--    only ever flips v_matched true -> false, never back), so it cannot
--    manufacture a match. Skipping them would make `matched` strictly more
--    permissive, which is the wrong direction for a gate.
--
-- 3. A refusal writes NO audit row, matching the refusal contract the function
--    already had -- 'unsupported_source_table' and 'record_not_found' return
--    without inserting either. The guard sits ABOVE the digital_employees
--    lookup so it cannot be reached around by a read that fails first, and so
--    it is provable with no fixture at all (see the probes below).
--
-- 4. service_role still holds direct INSERT/UPDATE/DELETE/TRUNCATE on
--    de_system_verifications. Confirmed live via pg_class.relacl
--    (service_role=arwdDxtm/postgres) and has_table_privilege -- NOT via
--    information_schema.role_table_grants, which returned an EMPTY list
--    because the querying role could not see grants it was not party to. That
--    empty list was a false all-clear and is exactly the shape of mistake this
--    file exists to fix. Any edge function that ever writes the table directly
--    bypasses this guard entirely; nothing does today (de_system_verifications
--    appears in no TypeScript or JavaScript file in the repository). It is
--    left in place ON PURPOSE and raised separately rather than carved out
--    here: mig 716 revoked exactly this class of grant from `authenticated`
--    across ~200 tables while ASSERTING that service_role's grant count came
--    out unchanged (716:335). Narrowing one table alone would contradict a
--    standing, actively-asserted repo-wide posture, and would read as a closed
--    door while the identical door stands open on every sibling audit table.

begin;

-- ── PRE-STATE, captured BEFORE the replace ────────────────────────────────
-- The perimeter arms below ask whether CREATE OR REPLACE preserved the owner
-- and grants. That question can only be asked as a DIFFERENCE, never as an
-- absolute: the grants belong to migrations 221 and 365, not to this file, so
-- "service_role can EXECUTE" is an assertion about the environment's HISTORY
-- and is false on any database whose history differs. The first version of
-- this migration asserted it absolutely and audit:replayable rejected it --
-- correctly, and before it could be applied. Comparing before to after asks
-- only what THIS migration did, and is therefore true wherever it runs.
CREATE TEMPORARY TABLE zz_835_pre ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM pg_roles rr
    WHERE rr.rolname IN ('anon', 'authenticated')
      AND has_function_privilege(rr.rolname, p.oid, 'EXECUTE'))          AS client_execute,
  (SELECT count(*) FROM pg_roles rr
    WHERE rr.rolname = 'service_role'
      AND has_function_privilege(rr.rolname, p.oid, 'EXECUTE'))          AS service_execute,
  pg_get_userbyid(p.proowner)                                            AS owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'verify_de_system';

-- CREATE OR REPLACE, never DROP + CREATE: the function is SECURITY DEFINER
-- owned by postgres, and its INSERT into de_system_verifications works only
-- because the OWNER bypasses that table's RLS (the table does not FORCE row
-- security). DROP + CREATE would reset owner and grants and quietly break both
-- that INSERT and de-work's EXECUTE. The signature below is byte-identical to
-- mig 221's, read from the live catalogue with pg_get_function_arguments.
CREATE OR REPLACE FUNCTION public.verify_de_system(
  p_de_id uuid, p_system_key text, p_entity_ref text, p_expectation jsonb, p_objective_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_read jsonb; v_actual jsonb; v_matched boolean := true; v_diffs jsonb := '[]'::jsonb;
  k text; v_exp text; v_act text; v_tenant uuid;
BEGIN
  -- ── THE GUARD (new in 835) ───────────────────────────────────────────────
  -- Refuse to record a match for a check that compared nothing. This runs
  -- FIRST -- before the employee lookup and before the read of the system of
  -- record -- so that no failure further down can decide whether it applies.
  --
  -- The shape test comes first and is separate: jsonb_object_keys RAISES on a
  -- non-object, and p_expectation is not NOT NULL, so both a scalar/array and
  -- a SQL NULL are reachable from a direct RPC call. jsonb_typeof(NULL) is
  -- NULL, and NULL <> 'object' is NULL rather than true, so the IS NULL test
  -- has to be spelled out -- it does not fall out of the type check.
  IF p_expectation IS NULL OR jsonb_typeof(p_expectation) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expectation_not_object');
  END IF;

  -- "At least one value that is not JSON null" -- NOT merely "not empty".
  -- {"reference": null} is a non-empty object that compares nothing, which is
  -- the whole defect. jsonb_typeof(value) <> 'null' is deliberate over any
  -- truthiness test: 0 and false are genuine assertions about the record and
  -- must pass. This is the same predicate mig 832 counts by.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_each(p_expectation) e WHERE jsonb_typeof(e.value) <> 'null'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vacuous_expectation');
  END IF;
  -- ── end guard; everything below is mig 221 unchanged ─────────────────────

  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  v_read := public.read_de_system(p_de_id, p_system_key, p_entity_ref);
  IF (v_read->>'ok') <> 'true' THEN RETURN v_read; END IF;
  v_actual := v_read->'record';

  FOR k IN SELECT jsonb_object_keys(p_expectation) LOOP
    v_exp := p_expectation->>k;
    v_act := v_actual->>k;
    IF v_exp IS DISTINCT FROM v_act THEN
      v_matched := false;
      v_diffs := v_diffs || jsonb_build_object('field', k, 'expected', v_exp, 'actual', v_act);
    END IF;
  END LOOP;

  INSERT INTO de_system_verifications (tenant_id, de_id, objective_id, system_key, entity_ref, expectation, actual, matched)
  VALUES (v_tenant, p_de_id, p_objective_id, p_system_key, p_entity_ref, p_expectation, v_actual, v_matched);

  RETURN jsonb_build_object('ok', true, 'matched', v_matched, 'diffs', v_diffs, 'actual', v_actual);
END; $$;

-- ══════════════════════════════════════════════════════════════════════════
-- VERIFICATION. A gate that cannot fail is theatre, so this exercises the new
-- guard in BOTH directions: 6 shapes that compare nothing must be refused,
-- and 4 shapes that do compare something must be let through. Delete the
-- guard and all 6 refuse arms fail; write it as "expectation <> '{}'" and the
-- json-null arms fail; write it as "every value must be non-null" and the
-- mixed allow arm fails. Every arm runs against a digital employee id that
-- exists NOWHERE, so this needs no fixture, writes nothing, and is valid on an
-- empty database. It asserts the absence of a violation, never the presence of
-- a production row.
-- ══════════════════════════════════════════════════════════════════════════
DO $verify$
DECLARE
  v_bad     text[] := '{}';
  v_checks  int    := 0;
  v_fake    uuid   := '00000000-0000-0000-0000-0000000008df'::uuid;
  v_before  bigint;
  v_after   bigint;
  v_fn      oid;
  v_n_fn    int;
  v_res     jsonb;
  v_pre     zz_835_pre%ROWTYPE;
  r         record;
BEGIN
  -- Exactly one verify_de_system, resolved from the catalogue rather than
  -- hand-typed. A signature change would silently create an OVERLOAD, leaving
  -- the vulnerable original in place beside the fixed one; this catches that.
  SELECT count(*) INTO v_n_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'verify_de_system';
  IF v_n_fn <> 1 THEN
    RAISE EXCEPTION '835: expected exactly 1 public.verify_de_system, found % -- a signature change left an overload of the UNFIXED function in place', v_n_fn;
  END IF;
  SELECT p.oid INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'verify_de_system';

  IF EXISTS (SELECT 1 FROM public.digital_employees WHERE id = v_fake) THEN
    RAISE EXCEPTION '835: probe id % unexpectedly names a real digital employee', v_fake;
  END IF;
  SELECT count(*) INTO v_before FROM public.de_system_verifications;

  -- ── ARM 1: every expectation that compares NOTHING must be refused ───────
  FOR r IN
    SELECT * FROM (VALUES
      ('a json-null value',   '{"reference": null}'::jsonb,     'vacuous_expectation'),
      ('every value null',    '{"a": null, "b": null}'::jsonb,  'vacuous_expectation'),
      ('an empty object',     '{}'::jsonb,                      'vacuous_expectation'),
      ('a SQL NULL',          NULL::jsonb,                      'expectation_not_object'),
      ('a non-object array',  '[1,2]'::jsonb,                   'expectation_not_object'),
      ('a non-object scalar', '"hi"'::jsonb,                    'expectation_not_object')
    ) t(label, expectation, want_error)
  LOOP
    v_res := public.verify_de_system(v_fake, 'zz_probe_835', 'zz_probe_835_entity', r.expectation, NULL);
    v_checks := v_checks + 1;
    IF coalesce(v_res->>'error', '') IS DISTINCT FROM r.want_error THEN
      v_bad := array_append(v_bad, format(
        'REFUSE ARM (%s): expected error %L, got %s -- a verification that compared NOTHING was not refused, so an employee can still bank evidence for records it never checked',
        r.label, r.want_error, coalesce(v_res::text, '<null>')));
    END IF;
  END LOOP;

  -- ── ARM 2: every expectation that DOES compare something must pass ───────
  -- Passing the guard is proven positively: the call must reach the read and
  -- come back 'de_not_found' (the probe employee does not exist). "No guard
  -- error" alone would also be satisfied by the function crashing.
  FOR r IN
    SELECT * FROM (VALUES
      ('a genuine single field',      '{"status": "settled"}'::jsonb),
      ('the falsy trap 0',            '{"n": 0}'::jsonb),
      ('the falsy trap false',        '{"paid": false}'::jsonb),
      ('832 D3c: mixed null + real',  '{"a": null, "status": "settled"}'::jsonb)
    ) t(label, expectation)
  LOOP
    v_res := public.verify_de_system(v_fake, 'zz_probe_835', 'zz_probe_835_entity', r.expectation, NULL);
    v_checks := v_checks + 1;
    IF coalesce(v_res->>'error', '') IN ('vacuous_expectation', 'expectation_not_object') THEN
      v_bad := array_append(v_bad, format(
        'ALLOW ARM (%s): the guard REFUSED a genuine expectation with %L -- 835 over-corrected and now blocks real verifications',
        r.label, v_res->>'error'));
    ELSIF coalesce(v_res->>'error', '') IS DISTINCT FROM 'de_not_found' THEN
      v_bad := array_append(v_bad, format(
        'ALLOW ARM (%s): expected the guard to pass and the read to answer de_not_found, got %s',
        r.label, coalesce(v_res::text, '<null>')));
    END IF;
  END LOOP;

  -- ── ARM 3: not one of those 10 calls may leave an audit row behind ───────
  SELECT count(*) INTO v_after FROM public.de_system_verifications;
  v_checks := v_checks + 1;
  IF v_after <> v_before THEN
    v_bad := array_append(v_bad, format(
      'ROW ARM: de_system_verifications went from %s to %s rows across 10 refused/failed probe calls -- a verification that never happened is still writing an audit row',
      v_before, v_after));
  END IF;

  -- ── ARM 4: the replace must not have DRIFTED the perimeter ──────────────
  -- Stated as before-vs-after, never as an absolute. What these arms defend
  -- is the claim in the header -- "CREATE OR REPLACE preserves owner and
  -- grants; DROP + CREATE does not" -- so that anyone who later rewrites this
  -- as DROP + CREATE is told, rather than silently handing de-work a function
  -- it can no longer execute or an owner that can no longer write the audit
  -- table. A database that never had the grant in the first place is not this
  -- migration's business and is not asserted about.
  SELECT * INTO v_pre FROM zz_835_pre;
  IF v_pre IS NULL THEN
    -- verify_de_system did not exist before this file ran. Nothing to preserve,
    -- so the drift arms are SKIPPED rather than quietly passing: three fewer
    -- comparisons, and the count below says so.
    RAISE NOTICE '835: no pre-existing verify_de_system, so the 3 perimeter-drift arms were NOT exercised here.';
  ELSE
    v_checks := v_checks + 1;
    IF (SELECT count(*) FROM pg_roles rr WHERE rr.rolname IN ('anon', 'authenticated')
             AND has_function_privilege(rr.rolname, v_fn, 'EXECUTE')) > v_pre.client_execute THEN
      v_bad := array_append(v_bad,
        'GRANT DRIFT: anon or authenticated GAINED EXECUTE on verify_de_system across the replace -- mig 365 perimeter was widened');
    END IF;

    v_checks := v_checks + 1;
    IF (SELECT count(*) FROM pg_roles rr WHERE rr.rolname = 'service_role'
             AND has_function_privilege(rr.rolname, v_fn, 'EXECUTE')) < v_pre.service_execute THEN
      v_bad := array_append(v_bad,
        'GRANT DRIFT: service_role LOST EXECUTE on verify_de_system across the replace -- de-work verify_in_system tool is now dead');
    END IF;

    v_checks := v_checks + 1;
    IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM v_pre.owner THEN
      v_bad := array_append(v_bad, format(
        'OWNER DRIFT: verify_de_system changed owner from %L across the replace -- its INSERT into the audit table depends on the owner bypassing that table RLS',
        v_pre.owner));
    END IF;
  END IF;

  -- Absolute, and legitimately so: SECURITY DEFINER is spelled out in the
  -- CREATE OR REPLACE above, so this describes what THIS migration installed
  -- and is true on every database it is applied to.
  v_checks := v_checks + 1;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    v_bad := array_append(v_bad,
      'DEFINER ARM: verify_de_system is no longer SECURITY DEFINER -- the caller own rights now decide what it can read and write');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '835 VERIFICATION FAILED (% finding(s) from % comparison(s)): %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  END IF;

  RAISE NOTICE '835: % comparisons, 0 findings -- 6 vacuous shapes refused (json-null, all-null, empty, SQL NULL, array, scalar), 4 genuine shapes passed through to the read (incl. the falsy 0/false traps and 832 D3c mixed null+real), 0 audit rows written by any of the 10, no perimeter/owner drift across the replace, still SECURITY DEFINER. 15 is the full count; 12 means the 3 drift arms were skipped because the function did not exist beforehand. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.', v_checks;
END
$verify$;

commit;
