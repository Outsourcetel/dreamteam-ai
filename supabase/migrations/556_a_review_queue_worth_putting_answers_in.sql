-- 556 — make draft_responses safe to actually put answers in, and give the
-- review queue something to read.
--
-- 555 made drafts possible. Before a single real customer answer waits in this
-- table, three things about it have to change.
--
-- 1. ANY SIGNED-IN USER COULD WIPE IT.
--      has_table_privilege('authenticated','draft_responses','TRUNCATE') = true
--    TRUNCATE IS NOT SUBJECT TO RLS. No policy, however correct, restrains it.
--    So every person who could sign up held the ability to destroy every
--    tenant's pending answers in one statement. authenticated also held
--    DELETE/INSERT/UPDATE, and `anon` — the unauthenticated internet — held
--    SELECT. Nothing in the app reads or writes this table directly (verified:
--    the only mentions in the tree are comments), so every one of those grants
--    was surface with no purpose.
--
-- 2. ITS RLS POLICIES READ THE PHANTOM GUC.
--    Two of the five policies filter on
--      tenant_id = current_setting('app.current_tenant_id')::uuid
--    the same GUC 555 removed from the functions, and nothing sets it. Un-guarded
--    current_setting RAISES, and a raising policy fails the whole statement — so
--    these did not merely fail to isolate, they made the table unreadable. They
--    are replaced with auth_tenant_id(), which returns NULL for the service role
--    and therefore matches nothing rather than erroring.
--
-- 3. THE UI COULD NOT REJECT ANYTHING.
--    reject_draft had EXECUTE for postgres and service_role only — never
--    authenticated. Consistent with it having zero callers for its whole life:
--    a reject button would have returned 403 the first time it was clicked.
--
-- Plus list_pending_drafts(), because the queue needs a tenant-wide reader and
-- get_pending_drafts_for_de() answers only "for this one employee".

BEGIN;

-- ── 1. Least privilege on the table ─────────────────────────────────────────
-- All legitimate access is through SECURITY DEFINER functions that run as owner
-- and already establish the caller's tenant, so the table itself needs to grant
-- almost nothing. SELECT is kept for authenticated so the (now correct) RLS
-- policies remain meaningful and a future read-only view is possible; every
-- write path stays behind a function that checks who is asking.
REVOKE ALL ON draft_responses FROM PUBLIC;
REVOKE ALL ON draft_responses FROM anon;
REVOKE ALL ON draft_responses FROM authenticated;
GRANT SELECT ON draft_responses TO authenticated;

-- ── 2. Policies that isolate instead of raising ─────────────────────────────
DROP POLICY IF EXISTS "Users see draft_responses in their tenant"   ON draft_responses;
DROP POLICY IF EXISTS "Users can update draft_responses in their tenant" ON draft_responses;
DROP POLICY IF EXISTS "Users can insert draft_responses in their tenant" ON draft_responses;

-- One SELECT policy, and it must be ANDed with the reporting-line scope that
-- already exists (draft_responses_de_scope). Two permissive policies are ORed,
-- which would have let either one alone admit a row — so the tenant test goes
-- INSIDE this policy together with the DE test rather than beside it.
CREATE POLICY draft_responses_tenant_read ON draft_responses
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND (de_id IS NULL OR public.can_access_de(de_id))
  );

-- The pre-existing permissive `draft_responses_de_scope` SELECT policy would OR
-- with the above and admit rows from OTHER tenants to anyone whose reporting
-- line happens to reach that employee. It is superseded by the policy above,
-- which tests both conditions together.
DROP POLICY IF EXISTS draft_responses_de_scope ON draft_responses;

-- Writes: no direct INSERT/UPDATE/DELETE policy for authenticated at all. The
-- functions do it. `draft_responses_de_scope_write` (FOR ALL) is dropped for the
-- same OR-widening reason — with no table grants it was already inert, but an
-- inert policy that reads as protection is worse than none.
DROP POLICY IF EXISTS draft_responses_de_scope_write ON draft_responses;

-- ── 3. Let the UI reject ────────────────────────────────────────────────────
-- reject_draft already establishes the caller (auth.uid() + auth_tenant_id())
-- and, since 555, refuses when it updates nothing.
GRANT EXECUTE ON FUNCTION public.reject_draft(uuid, text) TO authenticated;

-- ── 4. The queue's reader ───────────────────────────────────────────────────
-- Returns what is WAITING and what has EXPIRED UNREVIEWED in one list. Expired
-- drafts are deliberately NOT hidden: an expired draft means a person asked
-- something and no answer was ever sent. That is the exact symptom of "review
-- was switched on and nobody was watching", and hiding it would reproduce the
-- silence this whole line of work exists to end.
CREATE OR REPLACE FUNCTION public.list_pending_drafts()
RETURNS TABLE(draft_id uuid, de_id uuid, de_name text, conversation_id uuid,
              user_question text, draft_content text, confidence numeric,
              sources jsonb, created_at timestamptz, expires_at timestamptz,
              is_expired boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := public.auth_tenant_id();
  -- Fail closed: no workspace, no rows. Never an exception — a queue that
  -- throws is a queue nobody can look at.
  IF v_tenant IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT d.draft_id, d.de_id,
         coalesce(e.persona_name, e.name, 'Unassigned')::text,
         d.conversation_id, d.user_question, d.draft_content, d.confidence,
         d.sources, d.created_at, d.expires_at,
         (d.expires_at <= now()) AS is_expired
    FROM draft_responses d
    LEFT JOIN digital_employees e ON e.id = d.de_id
   WHERE d.tenant_id = v_tenant
     AND d.status = 'pending'
     AND (d.de_id IS NULL OR public.can_access_de(d.de_id))
   ORDER BY (d.expires_at <= now()) DESC, d.created_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_pending_drafts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pending_drafts() TO authenticated;

-- ── 5. Asserts ──────────────────────────────────────────────────────────────
-- Would these pass if the change were a no-op? No: authenticated CAN truncate
-- today, anon CAN select today, reject_draft is NOT executable today, and
-- list_pending_drafts does not exist today.
DO $probe$
DECLARE
  v_n INT;
BEGIN
  -- C1: the destructive grants are gone. TRUNCATE first — it is the one RLS
  -- could never have contained.
  IF has_table_privilege('authenticated', 'draft_responses', 'TRUNCATE') THEN
    RAISE EXCEPTION 'C1 FAILED: authenticated can still TRUNCATE draft_responses';
  END IF;
  IF has_table_privilege('authenticated', 'draft_responses', 'DELETE') THEN
    RAISE EXCEPTION 'C1 FAILED: authenticated can still DELETE from draft_responses';
  END IF;
  IF has_table_privilege('authenticated', 'draft_responses', 'UPDATE') THEN
    RAISE EXCEPTION 'C1 FAILED: authenticated can still UPDATE draft_responses directly';
  END IF;
  IF has_table_privilege('anon', 'draft_responses', 'SELECT') THEN
    RAISE EXCEPTION 'C1 FAILED: anon can still SELECT draft_responses';
  END IF;

  -- C2: reading is still possible for the people who must review.
  IF NOT has_table_privilege('authenticated', 'draft_responses', 'SELECT') THEN
    RAISE EXCEPTION 'C2 FAILED: authenticated lost SELECT — the queue cannot be read';
  END IF;

  -- C3: no policy on this table reads the phantom GUC any more.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename = 'draft_responses'
     AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%app.current_tenant_id%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'C3 FAILED: % policy/policies still read app.current_tenant_id', v_n;
  END IF;

  -- C4: exactly one SELECT policy, so tenant and reporting-line are ANDed
  -- rather than ORed. Two permissive policies would widen, not narrow.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename = 'draft_responses' AND cmd IN ('SELECT', 'ALL');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C4 FAILED: % SELECT/ALL policies on draft_responses, expected exactly 1 (permissive policies OR together and would widen access)', v_n;
  END IF;

  -- C5: the UI can call what it needs, and cannot be called by the internet.
  IF NOT has_function_privilege('authenticated', 'public.reject_draft(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAILED: authenticated still cannot execute reject_draft — the reject button would 403';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.list_pending_drafts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAILED: authenticated cannot execute list_pending_drafts';
  END IF;
  IF has_function_privilege('anon', 'public.list_pending_drafts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAILED: anon can execute list_pending_drafts';
  END IF;

  -- C6: the reader fails closed rather than raising for a caller with no
  -- workspace (this migration's caller has none).
  SELECT count(*) INTO v_n FROM list_pending_drafts();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'C6 FAILED: list_pending_drafts returned % rows to a caller with no workspace', v_n;
  END IF;

  RAISE NOTICE '556 asserts passed: table locked down, policies AND rather than OR, queue readable.';
END
$probe$;

COMMIT;
