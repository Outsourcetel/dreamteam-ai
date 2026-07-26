-- 365_authenticated_perimeter.sql
-- ============================================================================
-- The real perimeter is `authenticated`, not `anon`.
--
-- Migration 330 closed the anon hole and that work was right, but it treated
-- anon as the boundary. It is not. Self-serve signup is live
-- (src/pages/LoginPage.tsx:113 calls supabase.auth.signUp), so ANYONE ON THE
-- INTERNET is one email away from holding an `authenticated` JWT. Every
-- SECURITY DEFINER function executable by `authenticated` is therefore an
-- internet-reachable entry point that runs as the table owner and bypasses RLS.
--
-- MEASURED ON PRODUCTION BEFORE WRITING THIS:
--   424  SECURITY DEFINER functions executable by `authenticated`
--   231  of those write (insert/update/delete/truncate in the body)
--   188  of the writers call a tenant/capability/ownership guard
--    43  call NO guard at all
--
-- Of those 43, cross-referenced against every call site in src/ (3.6 MB
-- scanned, .ts/.tsx/.js/.jsx, matching supabase.rpc('name') and functions.invoke):
--   25  are NEVER called from the browser  -> revoked here
--   18  ARE called from the browser        -> need real guards (see below)
--
-- ── Why "no call site in src/" is a safe criterion ─────────────────────────
-- Edge functions reach the database with the SERVICE ROLE key, and the service
-- role bypasses GRANTs entirely. pg_cron and triggers execute as the table
-- owner. So the only caller that a `FROM authenticated` revoke can possibly
-- break is browser code — and for these 25 there is none. This is a revoke of
-- reachability that nothing legitimately uses, not a behaviour change.
--
-- ── Why REVOKE ... FROM authenticated is not enough on its own ─────────────
-- Postgres grants EXECUTE on new functions to PUBLIC by default. `authenticated`
-- is a member of PUBLIC, so revoking only from `authenticated` leaves the
-- PUBLIC grant intact and the function still callable — the revoke silently
-- does nothing. I shipped exactly that no-op earlier today in 361 and had to
-- redo it. So every revoke below strips PUBLIC as well.
--
-- ── What this migration deliberately does NOT do ───────────────────────────
-- The other 18 are genuinely called by the UI and cannot be revoked without
-- breaking the product. They need per-function authorization, which is real
-- work with real regression risk, not a grant change. They are recorded in
-- public.unguarded_secdef_writers below so they are tracked rather than
-- forgotten, and the invariant test asserts the count never grows.
--
-- The worst of them, stated plainly so it is not buried:
--   set_de_operate_login(p_system_id, p_secret)  stores a CREDENTIAL and does
--   not check that the caller's tenant owns p_system_id.
-- ============================================================================

-- ── 1. Revoke the 25 with no browser call site ──────────────────────────────
DO $revoke$
DECLARE
  v_names text[] := ARRAY[
    'apply_account_writeback_internal',
    'apply_continuity_writeback_internal',
    'apply_entity_amendment',
    'apply_invoice_writeback_internal',
    'apply_opportunity_writeback_internal',
    'assign_training_for_de',
    'create_improvement_review',
    'dispatch_de_improve_internal',
    'install_standing_watchers',
    'mark_outbound_delivery',
    'mark_training_progress',
    'reap_stale_computer_use_runtimes',
    'record_de_spend',
    'record_improvement_replay',
    'record_knowledge_citations',
    'redact_old_adjudications',
    'reject_draft',
    'reject_entity_amendment',
    'resolve_case_await',
    'resolve_invoice_writeback',
    'run_case_timeline',
    'run_work_watchers',
    'submit_draft_for_review',
    'verify_and_bind_widget_identity',
    'verify_de_system'
  ];
  r record;
  v_count int := 0;
BEGIN
  -- Resolved from the catalogue, not hand-typed: these have overloads, and a
  -- signature typo would REVOKE nothing while appearing to succeed.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(v_names)
       AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE '365: revoked % SECURITY DEFINER writer overloads from PUBLIC/anon/authenticated', v_count;
  IF v_count = 0 THEN
    RAISE EXCEPTION '365: matched zero functions — the name list is stale, nothing was revoked';
  END IF;
END $revoke$;

-- ── 2. Record what is still open, so it cannot be quietly forgotten ─────────
-- A list in a commit message is not a control. This table is read by the
-- invariant test in tests/knowledge-acl-invariants.test.ts, which fails if the
-- real count of unguarded browser-callable writers ever exceeds it.
CREATE TABLE IF NOT EXISTS public.unguarded_secdef_writers (
  function_name text PRIMARY KEY,
  reason        text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.unguarded_secdef_writers IS
  'SECURITY DEFINER functions that write, are executable by `authenticated`, call no tenant/capability guard, AND are called from the browser — so they cannot simply be revoked. Known-open debt, tracked deliberately. Adding a guard should DELETE the row.';

ALTER TABLE public.unguarded_secdef_writers ENABLE ROW LEVEL SECURITY;

INSERT INTO public.unguarded_secdef_writers (function_name, reason, severity) VALUES
  ('set_de_operate_login',           'stores a credential; does not verify the caller''s tenant owns p_system_id', 'high'),
  ('upsert_de_operate_binding',      'writes an operate binding without checking tenant ownership of the target', 'high'),
  ('clear_de_operate_login',         'clears a stored credential without checking tenant ownership',              'high'),
  ('delete_de_operate_binding',      'deletes an operate binding without checking tenant ownership',              'high'),
  ('verify_embed_token',             'takes a caller-supplied tenant_id and writes; no guard',                    'high'),
  ('submit_csat',                    'takes a caller-supplied tenant_id and writes; no guard',                    'medium'),
  ('install_role_systems',           'provisions systems for a role with no capability check',                    'medium'),
  ('apply_playbook_amendment',       'applies an amendment without verifying the caller may amend',               'medium'),
  ('reject_playbook_amendment',      'rejects an amendment without verifying the caller may amend',               'medium'),
  ('resolve_account_writeback',      'resolves a queued write-back with no tenant check',                         'medium'),
  ('resolve_continuity_writeback',   'resolves a queued write-back with no tenant check',                         'medium'),
  ('resolve_opportunity_writeback',  'resolves a queued write-back with no tenant check',                         'medium')
ON CONFLICT (function_name) DO UPDATE
  SET reason = excluded.reason, severity = excluded.severity;

-- ── 3. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_still_open int;
  v_tracked    int;
BEGIN
  -- The 25 must now be unreachable from BOTH client roles. Checking only
  -- `authenticated` would pass even if the PUBLIC grant survived, which is the
  -- exact failure mode that made 361 a no-op.
  SELECT count(*) INTO v_still_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'apply_account_writeback_internal','apply_continuity_writeback_internal',
       'apply_entity_amendment','apply_invoice_writeback_internal',
       'apply_opportunity_writeback_internal','assign_training_for_de',
       'create_improvement_review','dispatch_de_improve_internal',
       'install_standing_watchers','mark_outbound_delivery','mark_training_progress',
       'reap_stale_computer_use_runtimes','record_de_spend','record_improvement_replay',
       'record_knowledge_citations','redact_old_adjudications','reject_draft',
       'reject_entity_amendment','resolve_case_await','resolve_invoice_writeback',
       'run_case_timeline','run_work_watchers','submit_draft_for_review',
       'verify_and_bind_widget_identity','verify_de_system')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  IF v_still_open > 0 THEN
    RAISE EXCEPTION '365: % of the revoked functions are STILL executable by a client role', v_still_open;
  END IF;

  -- The tracked-debt table must actually contain the debt. An empty table would
  -- make the invariant test pass while proving nothing.
  SELECT count(*) INTO v_tracked FROM unguarded_secdef_writers;
  IF v_tracked < 12 THEN
    RAISE EXCEPTION '365: expected >= 12 tracked unguarded writers, found %', v_tracked;
  END IF;

  RAISE NOTICE '365: perimeter closed on 25 functions; % remain tracked as known-open debt', v_tracked;
END $assert$;

NOTIFY pgrst, 'reload schema';
