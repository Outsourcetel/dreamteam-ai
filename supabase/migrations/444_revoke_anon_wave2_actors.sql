-- 444_revoke_anon_wave2_actors.sql
-- ============================================================================
-- Removes `anon` (and the PUBLIC grant behind it) from the 13 wave-2 functions
-- that still carried it. Eleven of the thirteen MUTATE.
--
-- ── This is debt, not a hole — and the reason to do it anyway ────────────
-- Every one of these already fails closed for `anon`: each has either a null-uid
-- check on its first line or a tenant comparison `anon` cannot satisfy. That is
-- machine-checked, not asserted by me — `knowledge-acl-invariants` has a test
-- that no function is both anon-executable AND fail-open on a null uid, and it
-- has stayed green through 40+ body rewrites today.
--
-- So nothing here is exploitable today. The reason to revoke is narrower and
-- stronger than "it might be": **the check that makes them safe lives INSIDE
-- the function body, and the grant is the only layer that does not depend on
-- anyone remembering.** Any future CREATE OR REPLACE that restructures a body
-- can drop that line — and this codebase has already had exactly that failure.
-- `set_improvement_publish_scope` had the same "safe because of an in-body
-- check" story; the check turned out to be `if auth.uid() is not null and ...`,
-- which anon skips entirely, and it was callable with no account at all. A
-- 13-agent audit found it (mig 369) after a text-matching scan scored it as
-- guarded. Revoking makes the safety independent of the body.
--
-- ── The widget question, resolved before touching anything ──────────────
-- The blocker on doing this earlier was not knowing whether the customer-facing
-- embed widget reached any of these as `anon`. It does not, and the path is now
-- mapped rather than assumed:
--
--   public/widget.js calls exactly ONE thing — functions/v1/widget-ask. It
--   makes no direct RPC calls at all.
--   widget-ask/index.ts:215 builds its client with SUPABASE_SERVICE_ROLE_KEY,
--   which bypasses GRANTs entirely, and it calls NONE of the 13.
--   EmbedPage.tsx / EmbedWidget.tsx use verify_embed_token and
--   de_answer_headless — also none of the 13.
--
-- So no anonymous customer path touches this list. (Separately: `submit_csat`
-- is tracked debt whose rationale still says "anonymous embed widget" while
-- holding no anon grant — stale wording, not in this list, deliberately not
-- touched here.)
--
-- ── Every one has a live authenticated caller, so the GRANT matters ─────
-- Verified per function against src/ (the mig-365 criterion — a revoke can only
-- break browser code, since edge functions use the service-role key):
--   supportInboxApi.ts  approve_draft_reply, claim_support_conversation,
--                       send_human_reply, set_support_conversation_state
--   missionApi.ts       create_de_mission, create_de_team_mission,
--                       set_de_mission_state
--   continuityApi.ts    propose_continuity_writeback
--   (no src caller)     approve_draft, get_pending_draft,
--                       get_pending_drafts_for_de, propose_account_writeback,
--                       propose_opportunity_writeback
-- All are signed-in agent/admin surfaces. None is anonymous.
--
-- ⚠ THE TRAP THIS MIGRATION IS BUILT AROUND. `authenticated` is a member of
-- PUBLIC, so `REVOKE ALL ... FROM PUBLIC` can strip a function's only route to
-- EXECUTE for signed-in users and take the support inbox down with it. Measured
-- first: all 13 hold an EXPLICIT authenticated grant, so the revoke is safe —
-- and the GRANT is re-issued anyway, and asserted per function. Belt and
-- braces, because "the inbox stopped working" is a worse outcome than the debt.
--
-- Conversely `REVOKE ... FROM anon` ALONE would be a silent no-op while PUBLIC
-- still holds the privilege — the exact mistake migration 361 shipped. Both are
-- named in every statement below.
-- ============================================================================

DO $sweep$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'public.approve_draft(uuid,text,text)',
    'public.approve_draft_reply(uuid,text)',
    'public.claim_support_conversation(uuid)',
    'public.create_de_mission(uuid,text)',
    'public.create_de_team_mission(jsonb,text)',
    'public.get_pending_draft(uuid)',
    'public.get_pending_drafts_for_de(uuid)',
    'public.propose_account_writeback(uuid,uuid,uuid,text,jsonb)',
    'public.propose_continuity_writeback(uuid,uuid,text,jsonb)',
    'public.propose_opportunity_writeback(uuid,uuid,uuid,text,jsonb)',
    'public.send_human_reply(uuid,text)',
    'public.set_de_mission_state(uuid,text)',
    'public.set_support_conversation_state(uuid,text,text)'
  ];
  v_n int := 0;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    -- Refuse to operate on a signature that does not exist: a typo here would
    -- otherwise revoke nothing and report success.
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '444: % does not exist — refusing to claim a revoke that cannot have happened', v_sig;
    END IF;

    -- ON ROUTINE, not ON FUNCTION (42809 on procedures). PUBLIC named
    -- explicitly, or anon keeps the privilege through it.
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO authenticated', v_sig);
    v_n := v_n + 1;
  END LOOP;

  IF v_n <> 13 THEN
    RAISE EXCEPTION '444: expected 13 functions, processed %', v_n;
  END IF;
  RAISE NOTICE '444: swept % functions', v_n;
END $sweep$;

DO $assert$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'public.approve_draft(uuid,text,text)',
    'public.approve_draft_reply(uuid,text)',
    'public.claim_support_conversation(uuid)',
    'public.create_de_mission(uuid,text)',
    'public.create_de_team_mission(jsonb,text)',
    'public.get_pending_draft(uuid)',
    'public.get_pending_drafts_for_de(uuid)',
    'public.propose_account_writeback(uuid,uuid,uuid,text,jsonb)',
    'public.propose_continuity_writeback(uuid,uuid,text,jsonb)',
    'public.propose_opportunity_writeback(uuid,uuid,uuid,text,jsonb)',
    'public.send_human_reply(uuid,text)',
    'public.set_de_mission_state(uuid,text)',
    'public.set_support_conversation_state(uuid,text,text)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '444: anon still holds EXECUTE on %', v_sig;
    END IF;
    -- The no-op check: revoking anon while PUBLIC still holds it changes nothing.
    IF has_function_privilege('public', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '444: PUBLIC still holds EXECUTE on % — the revoke did not strip PUBLIC and is a no-op', v_sig;
    END IF;
    -- ⚠ THE ONE THAT MATTERS MORE THAN THE REVOKE. If this fails, the support
    -- inbox, the mission console or the continuity desk just stopped working.
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '444: authenticated LOST EXECUTE on % — a signed-in surface is now broken, roll back', v_sig;
    END IF;
  END LOOP;

  -- The bodies must be untouched: this migration changes grants only. If a
  -- guard from waves A/B went missing here, something else edited them.
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('send_human_reply','claim_support_conversation',
                           'set_support_conversation_state','approve_draft_reply',
                           'approve_draft','create_de_mission','create_de_team_mission',
                           'set_de_mission_state','propose_account_writeback',
                           'propose_continuity_writeback','propose_opportunity_writeback')
         AND pg_get_functiondef(p.oid) NOT LIKE '%can_access_de%') > 0 THEN
    RAISE EXCEPTION '444: an actor lost its wave-2 scope guard — grants were changed but a body regressed';
  END IF;

  RAISE NOTICE '444: 13 functions revoked from PUBLIC and anon, authenticated preserved on all. Safety no longer depends on an in-body check surviving future edits.';
END $assert$;

NOTIFY pgrst, 'reload schema';
