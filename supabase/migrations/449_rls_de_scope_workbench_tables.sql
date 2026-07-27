-- 449_groupE_rls_de_scope_workbench_tables.sql
-- ============================================================================
-- GROUP E — RLS de-scope policies on seven tables that are tenant-gated but
-- not employee-scoped (docs/32 pre-start report 02, finding P2-15; §5).
--
--   de_decision_trace     reasoning traces       (780 rows, 8 with null de_id)
--   de_exceptions         exception queue        (18 rows,  de_id NOT NULL)
--   de_memory             memory contents        (130 rows, de_id NOT NULL)
--   de_objectives         objectives / cases     (24 rows,  de_id NOT NULL)
--   de_training_progress  training progress      (0 rows,   de_id NOT NULL)
--   eval_judgments        eval verdicts          (180 rows, de_id NULLABLE, 0 null today)
--   role_certifications   certification runs     (17 rows,  de_id NOT NULL)
--
-- Verified live 2026-07-27 before drafting:
--   * every one of the seven has a `de_id` column (none uses
--     digital_employee_id — checked information_schema, including
--     eval_judgments and role_certifications which were flagged as possibly
--     naming the DE differently; they do not);
--   * every one has RLS enabled and carries EXACTLY ONE policy: a PERMISSIVE
--     FOR SELECT tenant-membership-or-platform-layer policy applying to all
--     roles. No write policies exist — writes reach these tables only via
--     SECURITY DEFINER functions and service-role clients, which RLS does not
--     touch. So a RESTRICTIVE FOR SELECT policy is the complete fix for the
--     direct-read path;
--   * no `%_de_scope` policy exists on any of the seven (no Wave-2 overlap);
--   * service_role has rolbypassrls = true, and can_access_de() additionally
--     names service_role explicitly — edge functions are unaffected twice over;
--   * is_platform_admin() = (profiles.layer = 'platform' AND active), the same
--     population the existing permissive policies admit via p.layer =
--     'platform', so platform users keep their read (the restrictive policy is
--     stricter only for a DEACTIVATED platform profile, which is the right
--     direction).
--
-- ── Pattern: MIRROR migration 386 exactly ──────────────────────────────────
-- RESTRICTIVE (AND-combines with the permissive tenant policy; a permissive
-- policy here would WIDEN access), predicate:
--
--     de_id IS NULL OR public.can_access_de(de_id)
--
-- The null-tolerant shape is used on ALL seven even though only two columns
-- are nullable: (a) it is the shape migrations 386 and 400-402 standardised,
-- and 386's own global assertion scans every `%_de_scope` policy for an
-- `IS NULL` branch — a plain-form policy here would make a re-run of 386
-- FAIL; (b) on a NOT NULL column the IS NULL branch is dead but harmless.
-- de_decision_trace has 8 genuinely unattributed rows live; they stay
-- workspace-visible, per the Wave-1 decision.
--
-- ── Caller analysis (rule 2), summarised — full detail in the group report ──
--   src/ direct reads (user JWT, RLS applies — the narrowing is the intent):
--     deWorkbenchApi.ts reads all seven; EmployeeFileStrip.tsx reads
--     de_objectives; missionApi.ts reads de_objectives; caseTimelineApi.ts +
--     continuityApi.ts embed de_objectives (PostgREST embeds render null for
--     a filtered embed rather than dropping the parent row).
--   Edge functions (13 read these tables): every DB client is
--     service-role-keyed (verified per function) → BYPASSRLS → unaffected.
--     The SUPABASE_ANON_KEY refs in de-improve/eval-run are gateway apikeys
--     for HTTP fan-out, not DB clients.
--   SECURITY DEFINER db functions: RLS does not apply inside them → unchanged
--     (that is Wave 2's separate, already-worked RPC axis).
--   The ONE non-SECDEF db function reading these tables is
--     gate_de_certification() — a trigger fn on digital_employees reading
--     role_certifications. Every principal able to fire that trigger either
--     bypasses RLS (service_role / SECDEF-owner postgres) or is owner/admin
--     (digital_employees' own UPDATE policy), and owner/admin pass
--     can_access_de unconditionally. Survives with zero behaviour change.
--
-- Ships dark today: live census is 2 platform_super_admin / 6 tenant_owner /
-- 11 tenant_admin / 2 tenant_user; only the tenant_user pair would ever see a
-- narrowed read, and scoping them is the point.
-- ============================================================================

-- ── Premise checks: fail loudly if the live state moved since drafting ──────
DO $premise$
DECLARE
  v_n   int;
  v_bad text;
BEGIN
  -- can_access_de must exist exactly once (uuid arg). Not changing it; the
  -- policies below depend on it.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'can_access_de';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'groupE: expected exactly 1 public.can_access_de, found %', v_n;
  END IF;

  -- service_role must bypass RLS, or these policies would hit edge functions.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'groupE: service_role no longer has BYPASSRLS — do not apply';
  END IF;

  -- Every target must have RLS enabled AND at least one PERMISSIVE SELECT
  -- policy: a RESTRICTIVE policy only narrows an existing grant path; if the
  -- permissive policy is gone, something else changed and this file must not
  -- guess.
  SELECT string_agg(t, ', ') INTO v_bad
    FROM unnest(ARRAY['de_decision_trace','de_exceptions','de_memory','de_objectives',
                      'de_training_progress','eval_judgments','role_certifications']) AS t
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity)
      OR NOT EXISTS (
           SELECT 1 FROM pg_policy p
            WHERE p.polrelid = ('public.' || t)::regclass
              AND p.polpermissive
              AND p.polcmd IN ('r', '*'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'groupE: RLS off or no permissive SELECT policy on: %', v_bad;
  END IF;
END $premise$;

-- ── Apply ───────────────────────────────────────────────────────────────────
DO $apply$
DECLARE
  r      record;
  v_tab  text;
  v_done int := 0;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY[
    'de_decision_trace','de_exceptions','de_memory','de_objectives',
    'de_training_progress','eval_judgments','role_certifications'] LOOP

    -- Resolve the DE column live rather than assuming (mirrors 386). All
    -- seven resolved to de_id when drafted; if a rename lands first, raise.
    SELECT column_name INTO r
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_tab
       AND column_name IN ('de_id', 'digital_employee_id')
     LIMIT 1;
    IF r IS NULL THEN
      RAISE EXCEPTION 'groupE: % has no de_id or digital_employee_id column', v_tab;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_tab || '_de_scope', v_tab);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT USING (%I IS NULL OR public.can_access_de(%I))',
      v_tab || '_de_scope', v_tab, r.column_name, r.column_name);

    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 7 THEN
    RAISE EXCEPTION 'groupE: applied % of 7 policies', v_done;
  END IF;
  RAISE NOTICE 'groupE: DE scoping applied to % workbench tables', v_done;
END $apply$;

-- ── Prove it landed ────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_bad text;
BEGIN
  -- 1. Each table now carries its _de_scope policy: RESTRICTIVE, FOR SELECT,
  --    null-tolerant, gated on can_access_de. A permissive policy here would
  --    WIDEN access and read as correct in a diff — that is the assert that
  --    matters most.
  SELECT string_agg(t, ', ') INTO v_bad
    FROM unnest(ARRAY['de_decision_trace','de_exceptions','de_memory','de_objectives',
                      'de_training_progress','eval_judgments','role_certifications']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy p
      WHERE p.polrelid = ('public.' || t)::regclass
        AND p.polname = t || '_de_scope'
        AND p.polpermissive = false
        AND p.polcmd = 'r'
        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%IS NULL%'
        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%can_access_de%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'groupE: scope policy missing/permissive/malformed on: %', v_bad;
  END IF;

  -- 2. Policy count per table must be exactly 2: the pre-existing permissive
  --    tenant read + this restrictive scope. Verified 1 policy per table when
  --    drafted (2026-07-27); if a third appears, the landscape moved and the
  --    count check should force a human look rather than pass silently.
  SELECT string_agg(t.t || '=' || t.n, ', ') INTO v_bad
    FROM (SELECT u.t, count(p.oid) AS n
            FROM unnest(ARRAY['de_decision_trace','de_exceptions','de_memory','de_objectives',
                              'de_training_progress','eval_judgments','role_certifications']) AS u(t)
            LEFT JOIN pg_policy p ON p.polrelid = ('public.' || u.t)::regclass
           GROUP BY u.t) t
   WHERE t.n <> 2;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'groupE: unexpected policy count (want 2 per table): %', v_bad;
  END IF;

  -- 3. Exactly one RESTRICTIVE policy per table — the one just created.
  SELECT string_agg(t.t, ', ') INTO v_bad
    FROM (SELECT u.t, count(*) FILTER (WHERE NOT p.polpermissive) AS nr
            FROM unnest(ARRAY['de_decision_trace','de_exceptions','de_memory','de_objectives',
                              'de_training_progress','eval_judgments','role_certifications']) AS u(t)
            LEFT JOIN pg_policy p ON p.polrelid = ('public.' || u.t)::regclass
           GROUP BY u.t) t
   WHERE t.nr <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'groupE: restrictive-policy count wrong on: %', v_bad;
  END IF;

  RAISE NOTICE 'groupE: 7 workbench tables now carry a restrictive de-scope read policy. Rows with a null de_id stay workspace-visible (8 live rows, all in de_decision_trace).';
END $assert$;

NOTIFY pgrst, 'reload schema';
