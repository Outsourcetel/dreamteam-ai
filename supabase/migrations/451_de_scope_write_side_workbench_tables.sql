-- 451_de_scope_write_side_workbench_tables.sql
-- ============================================================================
-- Companion to mig 452 (the Wave-1 write-side closure), applying the same
-- FOR ALL + WITH CHECK shape to the seven workbench tables mig 449 scoped
-- SELECT-only hours earlier.
--
-- ── Why, when writes are already blocked ─────────────────────────────────
-- Measured 2026-07-27 (peer finding from the Wave-2 stream, verified
-- independently before acting): all seven tables have ZERO permissive write
-- policies, so client writes are denied today — but by DEFAULT-DENY, not by
-- scoping. Meanwhile `authenticated` holds INSERT and UPDATE PRIVILEGE on all
-- seven. That is a safety that depends on something staying ABSENT rather
-- than on something being ENFORCED: the day anyone adds a permissive write
-- policy for an unrelated reason, writes open AND the de-scoping will not
-- cover them, because mig 449's `_de_scope` policies are FOR SELECT. Whoever
-- adds that policy will have no reason to suspect it.
--
-- Restrictive FOR ALL policies survive that future: they AND onto whatever
-- permissive policy appears later. Chosen over revoking the write privileges
-- because it protects the failure mode that actually occurs (someone adds a
-- policy) rather than the one that does not (someone re-grants).
--
-- Behaviour today is provably unchanged: reads keep the identical predicate
-- (P AND P = P), and no client write path exists to be affected (verified:
-- zero permissive write policies; every write to these tables goes through
-- SECURITY DEFINER functions or service_role, both untouched by RLS).
--
-- Null-tolerant predicate matching migs 386/449/452 exactly — diverging is
-- what migs 400-402 had to undo. WITH CHECK included: USING bounds which rows
-- may be touched, WITH CHECK bounds what they may become (without it a row
-- could be REASSIGNED to an inaccessible employee).
--
-- ⚠ Assertions are SHAPE ONLY — postgres carries rolbypassrls, so a
-- behavioural assert here would measure the runner, not the policy. Behaviour
-- is provable only by a signed-in scoped user (two exist as of today).
-- ============================================================================

DO $policies$
DECLARE
  t text;
  v_tables text[] := ARRAY['de_decision_trace', 'de_exceptions', 'de_memory',
                           'de_objectives', 'de_training_progress',
                           'eval_judgments', 'role_certifications'];
  v_pred text := '((de_id IS NULL) OR public.can_access_de(de_id))';
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '451: table public.% does not exist', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='de_id') THEN
      RAISE EXCEPTION '451: public.% has no de_id — the predicate would not compile', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '451: RLS is not enabled on public.% — a policy would never be consulted', t;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_de_scope_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL USING %s WITH CHECK %s',
      t || '_de_scope_write', t, v_pred, v_pred);
  END LOOP;
END $policies$;

DO $assert$
DECLARE
  t text;
  v_tables text[] := ARRAY['de_decision_trace', 'de_exceptions', 'de_memory',
                           'de_objectives', 'de_training_progress',
                           'eval_judgments', 'role_certifications'];
  r record;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    SELECT p.polpermissive, p.polcmd,
           pg_get_expr(p.polqual, p.polrelid) AS q,
           pg_get_expr(p.polwithcheck, p.polrelid) AS wc
      INTO r
      FROM pg_policy p
     WHERE p.polrelid = ('public.' || t)::regclass
       AND p.polname = t || '_de_scope_write';

    IF r IS NULL THEN
      RAISE EXCEPTION '451: the write policy is missing on %', t;
    END IF;
    IF r.polpermissive THEN
      RAISE EXCEPTION '451: % write policy is PERMISSIVE — it would widen access, not narrow it', t;
    END IF;
    IF r.polcmd <> '*' THEN
      RAISE EXCEPTION '451: % write policy does not cover ALL commands (polcmd=%)', t, r.polcmd;
    END IF;
    IF r.q IS NULL OR r.q NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '451: % write policy has no USING predicate', t;
    END IF;
    IF r.wc IS NULL OR r.wc NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '451: % write policy has no WITH CHECK — a row could be REASSIGNED to an inaccessible employee', t;
    END IF;
    IF r.q NOT LIKE '%de_id IS NULL%' OR r.wc NOT LIKE '%de_id IS NULL%' THEN
      RAISE EXCEPTION '451: % write policy is not null-tolerant — it would be stricter than its own SELECT policy', t;
    END IF;
    -- The mig-449 SELECT policy must survive untouched.
    IF NOT EXISTS (SELECT 1 FROM pg_policy
                    WHERE polrelid = ('public.' || t)::regclass
                      AND polname = t || '_de_scope' AND polpermissive = false) THEN
      RAISE EXCEPTION '451: the mig-449 SELECT policy on % is missing — did this migration replace it?', t;
    END IF;
    -- Privilege precedes policy (mig-379 lesson): reads must still be possible.
    IF NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '451: authenticated cannot SELECT % — the policies will never be reached', t;
    END IF;
  END LOOP;
END $assert$;

NOTIFY pgrst, 'reload schema';
