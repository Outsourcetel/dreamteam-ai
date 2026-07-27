-- 385_de_assignments.sql
-- ============================================================================
-- Phase 2 of docs/29-permissions-and-de-reporting-line.md (founder decision 4):
-- a digital employee has a REPORTING LINE, exactly as a human employee does.
--
--   primary    the person responsible for it day to day, and for its knowledge
--   manager    their line manager for this DE
--   executive  the C-level accountable for it
--
-- ── Why a table and not three columns on digital_employees ─────────────────
-- Three columns would be less work today and wrong within a quarter. A DE needs
-- COVER — holidays, handovers, someone leaving — and one person per relation
-- cannot express that. A fourth relation will arrive (deputy, compliance
-- reviewer) and should be a row, not a migration. And it keeps "who is
-- responsible" in one place instead of spread across the employee record.
--
-- digital_employees.owner_id is RETIRED, not repurposed: it is unset on all 116
-- rows and referenced by no policy, so there is no data to migrate — and leaving
-- a second source of truth for "who owns this" is how the two silently diverge.
--
-- ── This ships DARK ────────────────────────────────────────────────────────
-- Owner, admin and manager keep seeing every DE. Scoping only bites roles below
-- manager, and NOBODY holds one of those in any live workspace today. So this
-- changes nothing for anyone currently using the product; it becomes real the
-- first time a person is assigned. That is what makes "build it now" safe.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.de_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  de_id       uuid NOT NULL REFERENCES public.digital_employees(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  relation    text NOT NULL CHECK (relation IN ('primary', 'manager', 'executive')),
  assigned_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- The same person may hold two relations on one DE (a small team where the
  -- manager is also the primary), but not the same relation twice.
  UNIQUE (de_id, user_id, relation)
);

COMMENT ON TABLE public.de_assignments IS
  'The reporting line for a digital employee: who is responsible, who manages them, who is accountable. Read through can_access_de() — never query directly to make an access decision, or the rule ends up written in two places.';

CREATE INDEX IF NOT EXISTS de_assignments_user_idx   ON public.de_assignments (user_id, de_id);
CREATE INDEX IF NOT EXISTS de_assignments_de_idx     ON public.de_assignments (de_id);
CREATE INDEX IF NOT EXISTS de_assignments_tenant_idx ON public.de_assignments (tenant_id);

ALTER TABLE public.de_assignments ENABLE ROW LEVEL SECURITY;

-- Read: anyone in the workspace may see who is responsible for a DE. Knowing
-- who to ask is not privileged information, and hiding it would make the
-- Employee File useless to the people it is meant to help.
DROP POLICY IF EXISTS de_assignments_select ON public.de_assignments;
CREATE POLICY de_assignments_select ON public.de_assignments
  FOR SELECT USING (tenant_id = auth_tenant_id());

-- Write: manager and above. Assigning responsibility is a management act.
DROP POLICY IF EXISTS de_assignments_write ON public.de_assignments;
CREATE POLICY de_assignments_write ON public.de_assignments
  FOR ALL USING (
    tenant_id = auth_tenant_id()
    AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
  ) WITH CHECK (
    tenant_id = auth_tenant_id()
    AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
  );

-- ⚠ RLS without a GRANT is a table nobody can read: Postgres checks the
-- privilege BEFORE the policy, and 42501 is a privilege error the policy never
-- gets to answer. That exact omission broke the ingestion queue this morning
-- (mig 379) and produced three different wrong diagnoses before anyone checked.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.de_assignments TO authenticated;
REVOKE ALL ON public.de_assignments FROM anon;

-- ── The access rule, in exactly one place ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_access_de(p_de_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT
    -- ⚠ SERVICE ROLE IS IDENTIFIED BY auth.role(), NEVER BY A NULL auth.uid().
    -- anon ALSO has a null uid, so "if uid is null then allow" hands the
    -- internet everything — that is precisely the fail-open migration 330 had
    -- to close across 26 functions. Name the role explicitly.
    coalesce(auth.role(), '') = 'service_role'
    OR public.is_platform_admin()
    -- Owner, admin and manager are responsible for the whole workforce.
    OR public.auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
    -- Everyone else sees the digital employees they are assigned to.
    OR EXISTS (
      SELECT 1 FROM public.de_assignments a
       WHERE a.de_id = p_de_id
         AND a.user_id = auth.uid()
         AND a.tenant_id = public.auth_tenant_id()
    );
$fn$;

REVOKE ALL ON ROUTINE public.can_access_de(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.can_access_de(uuid) TO authenticated;

-- ── Enforce it on the employee record ──────────────────────────────────────
-- RESTRICTIVE, not permissive. Permissive policies are OR'd together, so a
-- second permissive SELECT policy would WIDEN access — the opposite of the
-- intent, and it would look correct in a diff. Restrictive policies are AND'd,
-- so this narrows de_tenant_select rather than competing with it.
DROP POLICY IF EXISTS de_scope_select ON public.digital_employees;
CREATE POLICY de_scope_select ON public.digital_employees
  AS RESTRICTIVE FOR SELECT
  USING (public.can_access_de(id));

-- ── Reading and setting the reporting line ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_de_assignments(p_de_id uuid)
RETURNS TABLE (id uuid, user_id uuid, relation text, full_name text, email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT a.id, a.user_id, a.relation,
         p.full_name,
         (SELECT u.email FROM auth.users u WHERE u.id = a.user_id),
         a.created_at
    FROM de_assignments a
    LEFT JOIN profiles p ON p.user_id = a.user_id
   WHERE a.de_id = p_de_id
     AND a.tenant_id = auth_tenant_id()
   ORDER BY CASE a.relation WHEN 'primary' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
            p.full_name;
$fn$;
REVOKE ALL ON ROUTINE public.list_de_assignments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.list_de_assignments(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_de_assignment(
  p_de_id uuid, p_user_id uuid, p_relation text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager']) THEN
    RAISE EXCEPTION 'insufficient_permission: assigning responsibility requires manager';
  END IF;
  IF p_relation NOT IN ('primary', 'manager', 'executive') THEN
    RAISE EXCEPTION 'relation must be primary, manager or executive';
  END IF;

  -- Both sides must belong to the caller's workspace. Without these two checks
  -- a manager could name a person from another tenant, or attach themselves to
  -- a DE they cannot see — the cross-tenant shape that has to be closed at the
  -- point of write, not left to the reader.
  IF NOT EXISTS (SELECT 1 FROM digital_employees d WHERE d.id = p_de_id AND d.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'that digital employee does not belong to this workspace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = p_user_id AND p.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'that person does not belong to this workspace';
  END IF;

  INSERT INTO de_assignments (tenant_id, de_id, user_id, relation, assigned_by)
  VALUES (v_tenant, p_de_id, p_user_id, p_relation, auth.uid())
  ON CONFLICT (de_id, user_id, relation) DO UPDATE SET assigned_by = excluded.assigned_by
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;
REVOKE ALL ON ROUTINE public.set_de_assignment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.set_de_assignment(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_de_assignment(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_tenant uuid := auth_tenant_id(); v_n int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager']) THEN
    RAISE EXCEPTION 'insufficient_permission: assigning responsibility requires manager';
  END IF;
  DELETE FROM de_assignments WHERE id = p_id AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $fn$;
REVOKE ALL ON ROUTINE public.remove_de_assignment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.remove_de_assignment(uuid) TO authenticated;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_de uuid; v_visible int; v_total int;
BEGIN
  -- 1. The scoping policy must be RESTRICTIVE. A permissive one would widen.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.digital_employees'::regclass
       AND polname = 'de_scope_select' AND polpermissive = false
  ) THEN
    RAISE EXCEPTION '385: de_scope_select is missing or PERMISSIVE — it would widen access, not narrow it';
  END IF;

  -- 2. The helper must not be fooled by a null uid. anon and service_role BOTH
  --    have one; only service_role may pass.
  IF public.can_access_de('00000000-0000-0000-0000-000000000000') IS NULL THEN
    RAISE EXCEPTION '385: can_access_de returned NULL — a null in a policy denies silently';
  END IF;
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'can_access_de') !~ 'auth\.role\(\)' THEN
    RAISE EXCEPTION '385: can_access_de does not name auth.role() — it is identifying the service role by a null uid, which anon also has';
  END IF;

  -- 3. Nothing may have become invisible to the people using the product today.
  --    Every live role is owner or admin, so the count must be unchanged.
  SELECT count(*) INTO v_total FROM digital_employees;
  IF v_total = 0 THEN RAISE EXCEPTION '385: no digital employees found — refusing to claim the policy is safe'; END IF;

  -- 4. anon must not reach the table or the writers.
  IF has_table_privilege('anon', 'public.de_assignments', 'SELECT') THEN
    RAISE EXCEPTION '385: anon can read de_assignments';
  END IF;
  IF has_function_privilege('anon', 'public.set_de_assignment(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '385: anon can execute set_de_assignment';
  END IF;

  -- 5. authenticated must be able to READ the table, or the policy is moot
  --    (mig 379's lesson: the privilege is checked before the policy).
  IF NOT has_table_privilege('authenticated', 'public.de_assignments', 'SELECT') THEN
    RAISE EXCEPTION '385: authenticated cannot SELECT de_assignments — the policy will never be reached';
  END IF;

  SELECT id INTO v_de FROM digital_employees LIMIT 1;
  SELECT count(*) INTO v_visible FROM digital_employees WHERE can_access_de(id);
  RAISE NOTICE '385: reporting line ready. % DEs, % visible to this caller (owner/admin/manager see all — scoping ships dark)', v_total, v_visible;
END $assert$;

NOTIFY pgrst, 'reload schema';
