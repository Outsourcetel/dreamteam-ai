-- 465_de_scope_charter_and_widget_keys.sql
-- ============================================================================
-- Output of the direct-write census (docs/35). Two tables carry a de_id, are
-- writable by any workspace member, and had NO scoping on the write — the same
-- class migration 452 closed for human_tasks / de_conversations /
-- draft_responses, found by sweeping the paths that bypass functions entirely.
--
--   de_playbook_charter   35 rows, de_id NOT NULL
--     Binds a playbook to a digital employee, with an `active` flag. Writable
--     by any member: a scoped user could bind, unbind or deactivate the
--     charter of an employee they are not responsible for — changing what that
--     employee is instructed to do. check_de_retirement_readiness counts
--     active charter bindings as a RETIREMENT BLOCKER, so this also moves
--     another employee's lifecycle.
--
--   widget_keys           8 rows, de_id NULLABLE
--     Routes an embedded customer-facing widget to a digital employee, with an
--     `active` flag. Writable by any member: a scoped user could repoint a live
--     widget at a different employee, or switch it off. This is the surface a
--     customer actually talks to.
--
-- Neither is exploitable today — every live user is owner or admin, both of
-- whom pass can_access_de unconditionally. This is the same "ships dark,
-- becomes real on the first assignment" position as the rest of the wave.
--
-- ── Not the whole census, deliberately ─────────────────────────────────
-- 23 tables are client-writable on a tenant-only policy. That is mostly the
-- DESIGN — a member editing their own workspace's data — not a defect, and
-- narrowing it is a product decision rather than a bug fix. Only these two
-- combine "has a de_id" with "no scoping on the write", which is the precise
-- shape 452 established as wrong. docs/35 records the rest.
--
-- Same shape as 452: restrictive FOR ALL, USING + WITH CHECK, null-tolerant to
-- match mig 386. WITH CHECK matters as much as USING — without it a member
-- could take a row they may touch and REASSIGN its de_id to an employee they
-- may not, moving a charter or a live widget out of everyone's view.
--
-- Cannot break the workforce: service_role carries rolbypassrls (measured), so
-- RLS is never evaluated for any worker or edge function.
--
-- ⚠ Assertions are SHAPE only. postgres also carries rolbypassrls, so a
-- migration cannot observe a policy — a behavioural assert here would pass
-- whether the policy were correct, inverted or absent.
-- ============================================================================

DO $policies$
DECLARE
  t text;
  v_tables text[] := ARRAY['de_playbook_charter', 'widget_keys'];
  v_pred text := '((de_id IS NULL) OR public.can_access_de(de_id))';
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '465: table public.% does not exist', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='de_id') THEN
      RAISE EXCEPTION '465: public.% has no de_id — the predicate would not compile', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.'||t)::regclass) THEN
      RAISE EXCEPTION '465: RLS is not enabled on public.% — a policy would never be consulted', t;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_de_scope', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL USING %s WITH CHECK %s',
      t || '_de_scope', t, v_pred, v_pred);
  END LOOP;
END $policies$;

DO $assert$
DECLARE t text; v_tables text[] := ARRAY['de_playbook_charter','widget_keys']; r record;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    SELECT p.polpermissive, p.polcmd,
           pg_get_expr(p.polqual,p.polrelid) q, pg_get_expr(p.polwithcheck,p.polrelid) wc
      INTO r
      FROM pg_policy p
     WHERE p.polrelid = ('public.'||t)::regclass AND p.polname = t || '_de_scope';

    IF r IS NULL THEN RAISE EXCEPTION '465: the scope policy is missing on %', t; END IF;
    -- PERMISSIVE would WIDEN: permissive policies are OR-ed, so a permissive
    -- copy of this predicate grants rather than narrows.
    IF r.polpermissive THEN
      RAISE EXCEPTION '465: % policy is PERMISSIVE — it would widen access, not narrow it', t;
    END IF;
    IF r.polcmd <> '*' THEN
      RAISE EXCEPTION '465: % policy does not cover ALL commands (polcmd=%)', t, r.polcmd;
    END IF;
    IF r.q IS NULL OR r.q NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '465: % has no USING predicate', t;
    END IF;
    IF r.wc IS NULL OR r.wc NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '465: % has no WITH CHECK — a row could be REASSIGNED to an inaccessible employee', t;
    END IF;
    IF r.q NOT LIKE '%de_id IS NULL%' OR r.wc NOT LIKE '%de_id IS NULL%' THEN
      RAISE EXCEPTION '465: % is not null-tolerant — it would be stricter than the mig-386 shape', t;
    END IF;
    -- RLS without a GRANT is a table nobody can read (mig 379).
    IF NOT has_table_privilege('authenticated', 'public.'||t, 'SELECT') THEN
      RAISE EXCEPTION '465: authenticated cannot SELECT % — the policy will never be reached', t;
    END IF;
  END LOOP;

  RAISE NOTICE '465: charter bindings and widget routing are now DE-scoped on read AND write. Shape asserted only — behaviour needs a signed-in scoped user.';
END $assert$;

NOTIFY pgrst, 'reload schema';
