-- 367_guard_ui_called_writers.sql
-- ============================================================================
-- Close the cross-tenant holes in the SECURITY DEFINER writers that migration
-- 365 could not simply revoke, because the UI genuinely calls them.
--
-- ── FIRST, A CORRECTION TO 365 ─────────────────────────────────────────────
-- 365 recorded TWELVE unguarded UI-called writers. The real number is EIGHT.
-- The guard-detection vocabulary used to produce that list omitted
-- `can_admin_tenant_internal`, so four functions were listed as unguarded when
-- they are in fact correctly guarded:
--   set_de_operate_login, upsert_de_operate_binding,
--   clear_de_operate_login, delete_de_operate_binding
-- set_de_operate_login in particular was called out as "stores a credential
-- without a tenant check". That was WRONG. It resolves the tenant from
-- p_system_id and calls can_admin_tenant_internal on it — the correct pattern.
-- The rows are removed from unguarded_secdef_writers below.
--
-- ── OF THE REAL EIGHT, TWO ARE CORRECT BY DESIGN ───────────────────────────
-- verify_embed_token(p_token, p_tenant_id, p_de_id)
--   An authentication primitive. The caller must present a token whose sha256
--   matches a live row for that tenant+DE. The token IS the credential; the only
--   write is stamping used_at. Adding a session guard would break the embedded
--   widget, which is anonymous by design.
-- submit_csat(p_conversation_id, p_tenant_id, p_score)
--   Also called from the anonymous widget. It matches on BOTH conversation id
--   AND tenant_id, so it cannot cross tenants without already knowing a valid
--   conversation UUID. Worst case is rating manipulation on a conversation you
--   already have the id for. Requiring a session would break the widget.
-- Both stay as they are, and stay tracked, with the reason recorded.
--
-- ── THE SIX THAT ARE GENUINELY EXPLOITABLE ─────────────────────────────────
-- Each looks its target up by a caller-supplied UUID and writes, without ever
-- checking that the CALLER belongs to the tenant that owns the row. Any signed-up
-- user who learns or guesses a UUID can act on another tenant's data:
--   apply_playbook_amendment      changes how another tenant's DEs operate
--   reject_playbook_amendment     the worst: a bare `update ... where id = p_id`
--                                 with no tenant lookup at all
--   install_role_systems          provisions connected systems into another tenant
--   resolve_account_writeback     approves a write-back INTO A CUSTOMER'S CRM
--   resolve_continuity_writeback  same
--   resolve_opportunity_writeback same
--
-- ── WHY THIS GUARD, AND WHY IT BREAKS NOTHING ──────────────────────────────
-- can_admin_tenant_internal(t) is already the established pattern in this
-- codebase. It allows service_role (so edge functions and cron keep working)
-- OR a caller whose own tenant matches AND who holds tenant_owner/tenant_admin.
-- Verified before writing: all 19 active profiles are tenant_admin (11),
-- tenant_owner (6) or platform_super_admin (2), so no current user loses access.
--
-- The guard is inserted immediately after the function's BEGIN and resolves the
-- tenant with its own subquery, rather than depending on a local variable. That
-- is deliberate: these six have six different internal shapes, and a rewrite
-- keyed to each shape is exactly the kind of edit that silently reverts an
-- amendment made since the function was last written.
--
-- coalesce(..., false) means an unknown UUID is DENIED rather than falling
-- through to the function's own not-found branch. That is intentional: it stops
-- the function being used to probe which UUIDs exist in other tenants.
-- ============================================================================

-- ── 1. Correct the 365 bookkeeping ──────────────────────────────────────────
DELETE FROM public.unguarded_secdef_writers
 WHERE function_name IN ('set_de_operate_login', 'upsert_de_operate_binding',
                         'clear_de_operate_login', 'delete_de_operate_binding');

UPDATE public.unguarded_secdef_writers
   SET reason = 'BY DESIGN: authentication primitive for the anonymous embed widget; the token hash is the credential and the only write is used_at',
       severity = 'low'
 WHERE function_name = 'verify_embed_token';

UPDATE public.unguarded_secdef_writers
   SET reason = 'BY DESIGN: anonymous embed widget; matches on conversation id AND tenant_id, so it cannot cross tenants',
       severity = 'low'
 WHERE function_name = 'submit_csat';

-- ── 2. Guard the six ────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_targets jsonb := jsonb_build_array(
    jsonb_build_object('fn','apply_playbook_amendment',      'tbl','playbook_amendments',            'key','id',      'arg','p_id'),
    jsonb_build_object('fn','reject_playbook_amendment',     'tbl','playbook_amendments',            'key','id',      'arg','p_id'),
    jsonb_build_object('fn','install_role_systems',          'tbl','digital_employees',              'key','id',      'arg','p_de_id'),
    jsonb_build_object('fn','resolve_account_writeback',     'tbl','account_writeback_requests',     'key','task_id', 'arg','p_task_id'),
    jsonb_build_object('fn','resolve_continuity_writeback',  'tbl','continuity_writeback_requests',  'key','task_id', 'arg','p_task_id'),
    jsonb_build_object('fn','resolve_opportunity_writeback', 'tbl','opportunity_writeback_requests', 'key','task_id', 'arg','p_task_id')
  );
  t jsonb;
  r record;
  v_src text;
  v_new text;
  v_guard text;
  v_done int := 0;
BEGIN
  FOR t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    -- The guard is only sound if the lookup table actually carries a tenant_id.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t->>'tbl' AND column_name = 'tenant_id')
    THEN
      RAISE EXCEPTION '367: %.tenant_id does not exist — the guard for % would be meaningless',
        t->>'tbl', t->>'fn';
    END IF;

    v_guard := format(
      ' IF NOT coalesce(public.can_admin_tenant_internal((SELECT tenant_id FROM public.%I WHERE %I = %s)), false) THEN RAISE EXCEPTION ''not permitted''; END IF;',
      t->>'tbl', t->>'key', t->>'arg');

    FOR r IN
      SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = t->>'fn'
    LOOP
      v_src := pg_get_functiondef(r.oid);
      CONTINUE WHEN v_src ILIKE '%can_admin_tenant_internal%';

      -- Insert immediately after the body's opening BEGIN. Non-greedy up to the
      -- first BEGIN following the $function$ marker, so a DECLARE block in
      -- between is preserved untouched.
      v_new := regexp_replace(v_src, '(AS \$function\$.*?\mBEGIN\M)', '\1' || v_guard, 'is');

      IF v_new = v_src THEN
        RAISE EXCEPTION '367: could not find the body BEGIN in % — refusing to leave it unguarded', r.proname;
      END IF;

      EXECUTE v_new;
      v_done := v_done + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE '367: guarded % function(s)', v_done;
END $guard$;

-- ── 2b. A guarded function is no longer debt ────────────────────────────────
-- The table's contract (mig 365) is "adding a guard should DELETE the row".
-- Leaving them would turn a debt register into a list nobody trusts.
DELETE FROM public.unguarded_secdef_writers
 WHERE function_name IN ('apply_playbook_amendment', 'reject_playbook_amendment',
                         'install_role_systems', 'resolve_account_writeback',
                         'resolve_continuity_writeback', 'resolve_opportunity_writeback');

-- ── 3. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_ungurded text;
  v_tracked  int;
BEGIN
  -- Every one of the six must now carry the guard.
  SELECT string_agg(p.proname, ', ') INTO v_ungurded
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('apply_playbook_amendment','reject_playbook_amendment',
                       'install_role_systems','resolve_account_writeback',
                       'resolve_continuity_writeback','resolve_opportunity_writeback')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%can_admin_tenant_internal%';

  IF v_ungurded IS NOT NULL THEN
    RAISE EXCEPTION '367: still unguarded: %', v_ungurded;
  END IF;

  -- The whole point is that the tracked-debt list shrinks. 12 -> 2.
  SELECT count(*) INTO v_tracked FROM public.unguarded_secdef_writers;
  IF v_tracked <> 2 THEN
    RAISE EXCEPTION '367: expected exactly 2 tracked (both by-design widget fns), found %', v_tracked;
  END IF;

  RAISE NOTICE '367: six cross-tenant holes closed; 2 by-design widget functions remain tracked';
END $assert$;

NOTIFY pgrst, 'reload schema';
