-- 333_knowledge_isolation_prework.sql
-- ============================================================================
-- TWO LIVE CROSS-TENANT DEFECTS. Found while designing the platform knowledge
-- shelf (docs/26); neither has anything to do with the shelf. They are bugs
-- TODAY. The shelf would have amplified both from one-tenant to all-tenants,
-- so they are fixed FIRST and shipped on their own.
--
-- ── DEFECT 1 — the NULL-tenant guard bypass (live cross-tenant READ) ────────
-- Six functions guard themselves like this:
--
--     if auth.uid() is not null and p_tenant_id not in
--        (select tenant_id from profiles where user_id = auth.uid()) then
--       raise exception 'tenant access denied';
--     end if;
--
-- If the caller's profile has tenant_id NULL, the subquery yields one NULL row.
-- In SQL three-valued logic `X NOT IN (NULL)` is NULL — NOT true — so the IF
-- does not fire and the function proceeds against whatever p_tenant_id the
-- caller supplied. VERIFIED IN-ENGINE, not reasoned about:
--     select ('1111...'::uuid not in (select null::uuid)) is null;  -- true
--
-- And NULL-tenant profiles are not hypothetical: 3 exist right now (one
-- orphaned tenant_owner, two platform_super_admins). hybrid_match_knowledge is
-- granted to `authenticated` and is already called from the browser
-- (src/lib/api.ts), and with a null embedding its lexical branch returns FULL
-- document bodies. So a logged-in account with no tenant could read any
-- workspace's knowledge by passing its UUID.
--
-- Note this is the SECOND bypass in match_cached_answer. Mig 330 closed the
-- `anon` hole in that same function and left this one, because 330 was looking
-- for unauthenticated callers and this one is authenticated.
--
-- FIX: replace the hand-rolled guard with the repo's own helper,
-- _assert_caller_tenant (330:53-71), which is NULL-safe in both directions
-- (auth_tenant_id() IS DISTINCT FROM p_tenant_id), rejects an explicit `anon`
-- request role, and returns early on a NULL auth.uid() so every service-role
-- edge-function caller and pg_cron job is completely unaffected.
--
-- SAFETY CHECKED BEFORE APPLYING: the old guard tested membership across ALL of
-- a user's profiles; auth_tenant_id() resolves ONE. Verified that ZERO users
-- have more than one profile, so no legitimate access is lost. The two platform
-- admins keep access through auth_tenant_id()'s remote-access-session fallback.
--
-- ── DEFECT 2 — unscoped destructive write (live cross-tenant WRITE) ─────────
-- apply_knowledge_revision (253:90) retires a document with NO tenant
-- predicate:
--     update knowledge_docs set is_current = false where id = v_req.source_doc_id;
-- The two reads either side of it are tenant-scoped; the write is not. Any
-- source_doc_id that reaches a revision request can retire that document in ANY
-- workspace. Scoped here, along with the two sibling reads.
--
-- Both fixes are applied by reproducing each function's LIVE definition and
-- changing ONLY the guard/predicate — never by retyping a body from memory.
-- ============================================================================

-- ── 1. Swap the defective guard in every function that carries it ───────────
DO $guards$
DECLARE
  r record;
  v_src text;
  v_new text;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~* 'p_tenant_id not in'
  LOOP
    v_src := pg_get_functiondef(r.oid);

    -- The guard exists in TWO shapes. Handle each explicitly rather than
    -- widening one regex until it swallows something it should not.
    --
    -- Shape B (count_pending_knowledge_gaps, visible_knowledge_docs,
    -- search_knowledge) — nested, with an elsif that demands service_role when
    -- auth.uid() is null. Matched FIRST because it is the more specific shape,
    -- and non-greedy only AFTER the elsif so it spans both END IFs, not the
    -- inner one. Replacing its elsif is not a weakening: mig 330 already
    -- revoked anon EXECUTE on these, and _assert_caller_tenant additionally
    -- rejects an explicit anon request role.
    v_new := regexp_replace(
      v_src,
      'if auth\.uid\(\) is not null then.*?elsif.*?end if;',
      'perform public._assert_caller_tenant(p_tenant_id);',
      'gi');

    -- Shape A (match_doc_chunks, hybrid_match_knowledge, match_cached_answer)
    -- — flat, single END IF.
    v_new := regexp_replace(
      v_new,
      'if auth\.uid\(\) is not null and p_tenant_id not in.*?end if;',
      'perform public._assert_caller_tenant(p_tenant_id);',
      'gi');

    IF v_new = v_src THEN
      RAISE EXCEPTION '333: could not rewrite the guard in % — refusing to guess', r.proname;
    END IF;
    IF v_new ~* 'p_tenant_id not in' THEN
      RAISE EXCEPTION '333: % still contains a hand-rolled guard after rewrite', r.proname;
    END IF;

    EXECUTE v_new;
    RAISE NOTICE '333: hardened %', r.proname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '333: rewrote % function(s)', n;
END $guards$;

-- ── 2. Scope the destructive write in apply_knowledge_revision ──────────────
DO $retire$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_knowledge_revision' AND p.prokind = 'f'
   LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION '333: apply_knowledge_revision not found'; END IF;

  -- The retire, and the two metadata reads that flank it, all keyed on a
  -- caller-influenced source_doc_id with no tenant predicate.
  v_new := replace(v_src,
    'set is_current = false where id = v_req.source_doc_id;',
    'set is_current = false where id = v_req.source_doc_id and tenant_id = v_req.tenant_id;');
  v_new := replace(v_new,
    'from knowledge_docs where id = v_req.source_doc_id)',
    'from knowledge_docs where id = v_req.source_doc_id and tenant_id = v_req.tenant_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '333: apply_knowledge_revision anchors not found — refusing to guess';
  END IF;
  EXECUTE v_new;
END $retire$;

-- ── 3. Prove both, or fail the migration ────────────────────────────────────
DO $assert$
DECLARE v_left int; v_unscoped boolean;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND pg_get_functiondef(p.oid) ~* 'p_tenant_id not in';
  IF v_left > 0 THEN
    RAISE EXCEPTION '333: % function(s) still carry the NULL-bypassable guard', v_left;
  END IF;

  SELECT pg_get_functiondef(p.oid) ~* 'set is_current = false where id = v_req\.source_doc_id;'
    INTO v_unscoped
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_knowledge_revision' AND p.prokind = 'f' LIMIT 1;
  IF coalesce(v_unscoped, true) THEN
    RAISE EXCEPTION '333: apply_knowledge_revision still retires documents without a tenant predicate';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
