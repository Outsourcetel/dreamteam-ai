-- 452_de_scope_the_write_side.sql
-- ============================================================================
-- Wave 1 (mig 386) scoped READS and only reads. Every one of its seven
-- `_de_scope` policies is `FOR SELECT`. This closes the write side on the three
-- tables where a client can actually write.
--
-- ── How this surfaced ────────────────────────────────────────────────────
-- Not from an audit — from being asked to make the nav relation-aware so a
-- digital employee's reporting-line manager can reach its approvals queue. That
-- change puts a scoped user in front of the approvals page for the first time,
-- and the page's primary action is `decideHumanTask`, which is a DIRECT UPDATE
-- on human_tasks. No SECURITY DEFINER function is involved, so NONE of the 48
-- guards from waves A/B apply to it. It was bounded by `tenant_id` alone.
--
-- A scoped user could not SEE another employee's task, but holding its id could
-- DECIDE one. Not trivially exploitable — the id is a uuid they cannot read —
-- but it is the same "actor unscoped" class group B spent 22 migrations closing
-- at the function layer, sitting unnoticed at the RLS layer. Opening the nav
-- first would have shipped a page whose buttons were bounded only by tenant,
-- and it would have looked like it worked.
--
-- ── The three tables, and the one deliberately left alone ────────────────
--   human_tasks        tenant_isolation is FOR ALL, tenant-only  → gap
--   de_conversations   tenant_isolation is FOR ALL, tenant-only  → gap
--   draft_responses    INSERT/UPDATE keyed on app.current_tenant_id, no DE     → gap
--
--   workforce_conversations is NOT touched: its own policies already demand
--   auth_has_tenant_role(owner/admin/manager) on SELECT, INSERT and UPDATE, so
--   a tenant_user cannot reach it at all. Adding a restrictive policy there
--   would be redundant armour that implies the table was exposed. It was not.
--
--   de_missions, de_work_items and outbound_drafts have SELECT-only permissive
--   policies — no client write path exists, so nothing to close.
--
-- ── Shape: FOR ALL, restrictive, USING + WITH CHECK ─────────────────────
-- One policy per table rather than three. Restrictive policies are AND-ed, and
-- the predicate is identical to the existing SELECT policy, so read behaviour
-- is provably unchanged (P AND P = P) while UPDATE, INSERT and DELETE gain the
-- bound they never had.
--
-- WITH CHECK is not decoration. Without it a scoped user could take a row they
-- legitimately access and REASSIGN it — set de_id to an employee they do not
-- own — moving work out of their scope and out of everyone else's view. USING
-- controls which rows you may touch; WITH CHECK controls what they may become.
-- Both are needed and both are asserted.
--
-- Null-tolerant, matching mig 386 exactly: `(de_id IS NULL) OR can_access_de(de_id)`.
-- An unattributed row stays workspace-writable, exactly as it stays
-- workspace-readable. Diverging here would recreate the split that migs 400-402
-- had to undo in group A — and human_tasks is 82% null de_id platform-wide.
--
-- ── Why this cannot break the workforce ─────────────────────────────────
-- Measured, not assumed: `service_role` has rolbypassrls = true, so RLS is not
-- evaluated for it at all. Every edge function and worker path uses the
-- service-role key and is therefore untouched by any policy added here. Owner,
-- admin and manager pass can_access_de unconditionally. The only callers whose
-- behaviour changes are scoped users — today exactly two people, both assigned
-- to one employee.
--
-- ⚠ ASSERTIONS ARE SHAPE ONLY, AND THAT IS A LIMIT NOT AN OVERSIGHT. `postgres`
-- also carries rolbypassrls, so a migration cannot observe a policy at all: a
-- behavioural assert here would pass whether the policy were correct, inverted,
-- or absent. It would measure the runner. So this file asserts the policy
-- EXISTS, is RESTRICTIVE, covers ALL commands, and carries both USING and
-- WITH CHECK with the null-tolerant predicate — and stops there. The behaviour
-- can only be proven by a signed-in scoped user, which is now possible.
-- ============================================================================

DO $policies$
DECLARE
  t text;
  v_tables text[] := ARRAY['human_tasks', 'de_conversations', 'draft_responses'];
  v_pred text := '((de_id IS NULL) OR public.can_access_de(de_id))';
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    -- Refuse on a table that does not exist or has no de_id: a typo would
    -- otherwise create nothing and report success.
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '452: table public.% does not exist', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='de_id') THEN
      RAISE EXCEPTION '452: public.% has no de_id — the predicate would not compile', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '452: RLS is not enabled on public.% — a policy would never be consulted', t;
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
  v_tables text[] := ARRAY['human_tasks', 'de_conversations', 'draft_responses'];
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
      RAISE EXCEPTION '452: the write policy is missing on %', t;
    END IF;
    -- PERMISSIVE would WIDEN access — permissive policies are OR-ed, so a
    -- permissive copy of this predicate would grant write to anyone it matches
    -- rather than narrowing. Same trap mig 385 asserted against.
    IF r.polpermissive THEN
      RAISE EXCEPTION '452: % write policy is PERMISSIVE — it would widen access, not narrow it', t;
    END IF;
    IF r.polcmd <> '*' THEN
      RAISE EXCEPTION '452: % write policy does not cover ALL commands (polcmd=%)', t, r.polcmd;
    END IF;
    -- USING bounds which rows may be touched; WITH CHECK bounds what they may
    -- become. Missing WITH CHECK lets a scoped user reassign a row out of scope.
    IF r.q IS NULL OR r.q NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '452: % write policy has no USING predicate', t;
    END IF;
    IF r.wc IS NULL OR r.wc NOT LIKE '%can_access_de%' THEN
      RAISE EXCEPTION '452: % write policy has no WITH CHECK — a row could be REASSIGNED to an inaccessible employee', t;
    END IF;
    -- Null-tolerance must match the mig-386 SELECT side exactly, or reads and
    -- writes disagree about unattributed rows (82% of human_tasks).
    IF r.q NOT LIKE '%de_id IS NULL%' OR r.wc NOT LIKE '%de_id IS NULL%' THEN
      RAISE EXCEPTION '452: % write policy is not null-tolerant — it would be stricter than its own SELECT policy', t;
    END IF;
    -- The original read policy must survive untouched.
    IF NOT EXISTS (SELECT 1 FROM pg_policy
                    WHERE polrelid = ('public.' || t)::regclass
                      AND polname = t || '_de_scope' AND polpermissive = false) THEN
      RAISE EXCEPTION '452: the mig-386 SELECT policy on % is missing — did this migration replace it?', t;
    END IF;
    -- RLS without a GRANT is a table nobody can use: the privilege is checked
    -- BEFORE the policy (mig 379's lesson). Reads must still be possible.
    IF NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '452: authenticated cannot SELECT % — the policies will never be reached', t;
    END IF;
  END LOOP;

  -- workforce_conversations is deliberately NOT in the list. If someone adds a
  -- write policy there later believing it was missed, this records why.
  IF EXISTS (SELECT 1 FROM pg_policy
              WHERE polrelid = 'public.workforce_conversations'::regclass
                AND polname = 'workforce_conversations_de_scope_write') THEN
    RAISE NOTICE '452: a write policy was added to workforce_conversations — its own policies already require manager+, so verify that is intended rather than redundant.';
  END IF;

  RAISE NOTICE '452: write side scoped on human_tasks, de_conversations, draft_responses. SHAPE asserted only — postgres carries rolbypassrls, so a migration cannot observe a policy. Behaviour needs a signed-in scoped user.';
END $assert$;

NOTIFY pgrst, 'reload schema';
