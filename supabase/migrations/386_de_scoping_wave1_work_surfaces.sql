-- 386_de_scoping_wave1_work_surfaces.sql
-- ============================================================================
-- Phase 3, Wave 1 of docs/29-permissions-and-de-reporting-line.md §7.
--
-- 385 gave digital employees a reporting line and scoped the employee RECORD.
-- This scopes the first wave of what those employees DO — the surfaces where a
-- person assigned to two DEs would otherwise read the whole workspace's work:
--
--   human_tasks             the approvals and drafts queue (917 rows in prod)
--   de_conversations        every conversation a DE has had (513)
--   de_work_items           the work queue (114)
--   draft_responses         replies awaiting a human
--   outbound_drafts         outbound mail awaiting a human
--   workforce_conversations internal workforce threads
--   de_missions             standing and one-off missions
--
-- Census taken before writing: all 73 DE-scoped tables have RLS enabled, and
-- NONE had a restrictive policy — so no table was DE-scoped before this file.
-- Wave 1 is 7 of them, chosen by exposure rather than by how easy they were.
--
-- ── NULL de_id MUST STAY VISIBLE ───────────────────────────────────────────
-- Most of these tables hold rows that belong to no digital employee — a human
-- task raised by a person, a conversation before routing. Scoping those away
-- would not be "more secure", it would delete work from people's queues and
-- look exactly like data loss. So the predicate is:
--
--     de_id IS NULL OR can_access_de(de_id)
--
-- A row attached to a DE follows that DE. A row attached to nothing keeps
-- whatever visibility its existing tenant policy already gave it.
--
-- ── RESTRICTIVE, and why that word matters ─────────────────────────────────
-- Permissive policies are OR'd. Adding a permissive policy here would WIDEN
-- access to every row — the exact opposite of the intent, and it would read as
-- correct in a diff. Restrictive policies are AND'd with the existing tenant
-- policy, so this can only ever narrow.
--
-- ── Still ships dark ───────────────────────────────────────────────────────
-- can_access_de returns true for owner, admin and manager, and no live
-- workspace has anybody below manager. So every count below is unchanged today.
-- This becomes real the first time somebody is assigned a scoped role.
--
-- ⚠ WHAT THIS DOES NOT COVER. RLS is bypassed inside SECURITY DEFINER
-- functions. 175 functions touch digital employees, and any of them that reads
-- these tables still returns unscoped rows. That is Wave 2's work and it is the
-- larger half — this migration closes the direct-read path, not every path.
-- ============================================================================

DO $wave1$
DECLARE
  r        record;
  v_col    text;
  v_done   int := 0;
  v_tables text[] := ARRAY[
    'human_tasks', 'de_conversations', 'de_work_items', 'draft_responses',
    'outbound_drafts', 'workforce_conversations', 'de_missions'
  ];
BEGIN
  FOREACH v_col IN ARRAY v_tables LOOP
    -- Resolve the DE column per table rather than assuming: this schema uses
    -- both de_id and digital_employee_id, and guessing wrong would silently
    -- create a policy on a column that does not exist.
    SELECT column_name INTO r
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_col
       AND column_name IN ('de_id', 'digital_employee_id')
     LIMIT 1;

    IF r IS NULL THEN
      RAISE EXCEPTION '386: % has no de_id or digital_employee_id column', v_col;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_col || '_de_scope', v_col);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT USING (%I IS NULL OR public.can_access_de(%I))',
      v_col || '_de_scope', v_col, r.column_name, r.column_name);

    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE '386: DE scoping applied to % work-surface tables', v_done;
END $wave1$;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_bad   text;
  v_tasks int;
BEGIN
  -- 1. Every Wave 1 table must now carry a RESTRICTIVE policy. A permissive one
  --    would widen rather than narrow, which is the failure that looks correct.
  SELECT string_agg(t, ', ') INTO v_bad
    FROM unnest(ARRAY['human_tasks','de_conversations','de_work_items','draft_responses',
                      'outbound_drafts','workforce_conversations','de_missions']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy p
      WHERE p.polrelid = ('public.' || t)::regclass
        AND p.polname = t || '_de_scope'
        AND p.polpermissive = false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '386: missing or permissive scope policy on: %', v_bad;
  END IF;

  -- 2. Rows belonging to no digital employee must remain visible. If this
  --    predicate were wrong, human tasks raised by people would vanish from
  --    every queue — indistinguishable from data loss.
  SELECT string_agg(p.polname, ', ') INTO v_bad
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE p.polname LIKE '%\_de\_scope'
     AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%IS NULL%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '386: these policies would hide rows with no digital employee: %', v_bad;
  END IF;

  -- 3. Report the blast radius rather than assert on it.
  --
  -- ⚠ THE FIRST VERSION OF THIS CHECK WAS WRONG AND FAILED ON PRODUCTION.
  -- It compared count(*) against count(*) WHERE can_access_de(de_id), expecting
  -- them to match "because every live role is owner or admin". But a MIGRATION
  -- RUNS AS postgres, which has no profile row and therefore no tenant identity:
  -- auth.uid() is null, auth_has_tenant_role is false, and can_access_de
  -- correctly returns false. The assertion was measuring the migration runner,
  -- not a real caller, and would have failed on any database with DE-attached
  -- rows — which is to say, on every real one.
  --
  -- It is left as a NOTICE because the number is genuinely worth seeing: it is
  -- exactly how many rows change visibility the day somebody is given a scoped
  -- role. Rows with a null de_id are unaffected by design.
  --
  -- The real guarantees are assertions 1 and 2 above — the policy is restrictive
  -- (so it can only narrow) and it exempts null de_id (so unattached work stays
  -- visible). Those are properties of the policy, and a migration CAN check
  -- them. Whether a manager still sees their queue is a question only a real
  -- signed-in manager can answer, and this file should not pretend otherwise.
  SELECT count(*) INTO v_tasks FROM human_tasks WHERE de_id IS NOT NULL;
  RAISE NOTICE '386: 7 work surfaces scoped. % human task(s) carry a de_id and will follow their employee once anyone holds a scoped role; rows with no de_id are untouched.', v_tasks;
END $assert$;

NOTIFY pgrst, 'reload schema';
