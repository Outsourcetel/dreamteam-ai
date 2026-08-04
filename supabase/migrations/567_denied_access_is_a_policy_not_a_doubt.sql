-- 567 — stop pricing denied access as doubt.
--
-- compute_inquiry_confidence subtracted 15 per system the employee was DENIED
-- access to, exactly as it does for a system that FAILED. Those are different
-- kinds of fact:
--
--   systems_failed            we were supposed to read it and could not.
--                             The answer may contradict whatever is in the
--                             unreachable system; a retry might have found it.
--                             GENUINE uncertainty — the penalty stays.
--
--   systems_denied_no_access  the operator DECIDED this employee does not read
--                             that system. Under the founder-locked
--                             deny-by-default model (docs/29) this is the NORM,
--                             not an anomaly — most employees are denied most
--                             systems by design.
--
-- The formula already prices what a denied system withholds: no CRM grant means
-- the +12 account-context bonus can never be earned, no helpdesk grant means up
-- to +24 in corroborations can never be earned. Subtracting 15 on top counted
-- the same absence twice — once as a bonus never granted, once as a penalty —
-- and produced the measured 18/33 cluster: a KB-only employee answering a KB
-- question PERFECTLY scored 40 + 8 − 30 = 18. The better a workspace's
-- least-privilege discipline, the less confident its workforce looked.
--
-- WHAT DOES NOT CHANGE:
--   • systems_denied_no_access stays RECORDED in confidence_inputs and the
--     evidence steps — visible in every trail, just not priced as error.
--   • No delivery gate opens: the KB-only shape moves 18 → 48, still below the
--     60 default floor and far below any dial floor. Measurement moves toward
--     truth; autonomy moves not at all.
--   • HISTORY IS NOT REWRITTEN. Stored confidences on past evidence runs were
--     the numbers shown when those decisions were made; they stay.
--
-- The TS twin (_shared/confidence.ts) changes in the same commit, and a new
-- parity test runs both over the same inputs — the protection the content-hash
-- twins got after drifting, applied here BEFORE these two get the chance.

BEGIN;

CREATE OR REPLACE FUNCTION public.compute_inquiry_confidence(p_inputs jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$
  select greatest(0, least(97,
    40
    + least(24, 8 * coalesce((p_inputs->>'knowledge_hits')::int, 0))
    + least(24, 8 * coalesce((p_inputs->>'history_corroborations')::int, 0))
    + case when coalesce((p_inputs->>'account_context_found')::boolean, false) then 12 else 0 end
    - 15 * coalesce((p_inputs->>'systems_failed')::int, 0)
  ))::integer;
$function$;

-- ── Asserts ────────────────────────────────────────────────────────────────
-- K2 and K3 are the ones that keep this honest: FAILED must still hurt, and
-- shapes with no denial must be bit-identical to before.
DO $probe$
DECLARE v int;
BEGIN
  -- K1: the measured cluster, repriced. KB-only DE, two denied categories:
  -- was 40 + 8 − 30 = 18; must now be 48.
  v := compute_inquiry_confidence('{"knowledge_hits":1,"systems_denied_no_access":2}'::jsonb);
  IF v <> 48 THEN RAISE EXCEPTION 'K1 FAILED: denied×2 shape = %, expected 48', v; END IF;

  -- K2: a FAILED system still subtracts. If this passes at 48 the migration
  -- deleted the wrong term and real uncertainty went unpriced.
  v := compute_inquiry_confidence('{"knowledge_hits":1,"systems_failed":1}'::jsonb);
  IF v <> 33 THEN RAISE EXCEPTION 'K2 FAILED: failed×1 shape = %, expected 33 (penalty must survive)', v; END IF;

  -- K3: shapes untouched by the change are bit-identical.
  v := compute_inquiry_confidence('{"knowledge_hits":3,"history_corroborations":1,"account_context_found":true}'::jsonb);
  IF v <> 84 THEN RAISE EXCEPTION 'K3 FAILED: unaffected shape = %, expected 84', v; END IF;
  v := compute_inquiry_confidence('{}'::jsonb);
  IF v <> 40 THEN RAISE EXCEPTION 'K3 FAILED: empty inputs = %, expected 40', v; END IF;

  -- K4: caps still hold at both ends.
  v := compute_inquiry_confidence('{"knowledge_hits":9,"history_corroborations":9,"account_context_found":true}'::jsonb);
  IF v <> 97 THEN RAISE EXCEPTION 'K4 FAILED: ceiling = %, expected 97', v; END IF;
  v := compute_inquiry_confidence('{"systems_failed":9}'::jsonb);
  IF v <> 0 THEN RAISE EXCEPTION 'K4 FAILED: floor = %, expected 0', v; END IF;

  -- K5: exactly one signature (the 562 lesson — a replaced function must not
  -- have quietly become two).
  SELECT count(*) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'compute_inquiry_confidence';
  IF v <> 1 THEN RAISE EXCEPTION 'K5 FAILED: % overloads', v; END IF;

  RAISE NOTICE '567 asserts passed: denied no longer priced, failed still is, all other shapes identical.';
END
$probe$;

COMMIT;
