-- 332_workforce_assistant_global.sql
-- ============================================================================
-- Make the Workforce Assistant a PLATFORM-PROVIDED employee: present in every
-- workspace that exists, and in every workspace created from now on.
--
-- Plan of record: docs/26-workforce-assistant-global-and-self-maintaining-kb.md
-- (This is the employee half. The platform knowledge shelf it reads from is a
-- separate migration — deliberately, so each can be verified on its own.)
--
-- ── What was actually wrong ─────────────────────────────────────────────────
-- The machinery already half-existed, which is why this looked done and was not:
--   * create_workforce_assistant_de() exists — but requires auth_tenant_id() and
--     a tenant admin, so it is a UI ACTION someone has to remember to click.
--   * auto_provision_new_tenant() — the trigger on tenants — does NOT call it.
--     Verified: pg_get_functiondef ~* 'create_workforce_assistant_de' = false.
-- Net effect: 12 of 16 workspaces have an Assistant and 4 do not (acme-telecom,
-- acs, harbor-peak-consulting, kinetic), purely according to whether someone
-- clicked a button. That is the "provisioning step to forget" this migration
-- removes — the same lesson as mig 331, where the fix was to move the decision
-- into the baseline instead of repeating it per tenant.
--
-- ── Design ──────────────────────────────────────────────────────────────────
-- 1. An INTERNAL provisioner with no auth check, for use by the trigger and the
--    backfill. The existing admin-facing RPC is left completely untouched, so
--    the UI path keeps working exactly as before.
-- 2. Wired into auto_provision_new_tenant, so every future workspace gets one.
-- 3. Backfills the 4 that are missing.
-- Idempotent throughout: is_workforce_assistant is the marker, and every path
-- returns early if one already exists. Re-running this migration is a no-op.
--
-- The charter is reproduced from the LIVE reference copy in outsourcetel-hq
-- (verified identical across all 12 existing copies) rather than reinvented, so
-- every workspace gets the same employee rather than a drifting variant.
-- ============================================================================

-- ── 1. Internal provisioner (no auth; callers are the trigger + backfill) ───
CREATE OR REPLACE FUNCTION public.provision_workforce_assistant_internal(p_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN RETURN NULL; END IF;

  -- Idempotent: is_workforce_assistant is the marker, one per workspace.
  SELECT id INTO v_existing FROM digital_employees
   WHERE tenant_id = p_tenant_id AND is_workforce_assistant = true LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  INSERT INTO digital_employees (
    tenant_id, name, icon, category, task_type, status, lifecycle_status,
    trust_level, model_provider, model_id, escalation_model_id,
    confidence_threshold, escalation_threshold, external_reply_mode,
    availability, is_workforce_assistant, is_product_expert, charter
  ) VALUES (
    p_tenant_id, 'Workforce Assistant', 'D', 'Customer', 'chat', 'active',
    'designed',                    -- same lifecycle stage as every existing copy
    'supervised',                  -- never starts trusted
    'anthropic', 'claude-haiku-4-5-20251001', 'claude-sonnet-5',
    75, 60,
    'draft',                       -- drafts for a human; never auto-sends on day one
    jsonb_build_object('mode', 'always_on'),
    true, true,
    jsonb_build_object(
      'name', 'Workforce Assistant',
      'persona', 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform.',
      'responsibilities', jsonb_build_array(
        'Help hire new DEs by understanding role requirements',
        'Suggest improvements to underperforming DEs based on metrics',
        'Monitor team performance and provide insights',
        'Help retire DEs and transition knowledge',
        'Train new tenants on DreamTeamAI features'),
      'guardrails', jsonb_build_array(
        'Never auto-approve DE changes without explicit user consent',
        'Always show evidence for recommendations',
        'Prioritize user success over automation',
        'Escalate ambiguous decisions to the tenant admin'))
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public.provision_workforce_assistant_internal(uuid) FROM public, anon, authenticated;

COMMENT ON FUNCTION public.provision_workforce_assistant_internal(uuid) IS
  'Baseline provisioner for the platform-provided Workforce Assistant. Internal only — the admin-facing create_workforce_assistant_de() is unchanged. Idempotent on is_workforce_assistant.';

-- ── 2. Every FUTURE workspace gets one ──────────────────────────────────────
-- Reproduced from the live definition; the ONLY change is the added call. The
-- call is wrapped so that a failure here can never block tenant creation — a
-- workspace without an Assistant is recoverable, a workspace that failed to be
-- created is not.
DO $wire$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auto_provision_new_tenant' AND p.prokind = 'f'
   LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION '332: auto_provision_new_tenant not found'; END IF;

  IF v_src ~* 'provision_workforce_assistant_internal' THEN
    RAISE NOTICE '332: auto_provision_new_tenant already wired';
    RETURN;
  END IF;

  -- Insert the call immediately before the trigger's final RETURN NEW.
  v_new := regexp_replace(
    v_src,
    '(\n\s*)(return new;)(\s*end;?\s*)\$function\$',
    E'\\1-- 332: every workspace gets the platform-provided Workforce Assistant.'
    || E'\\1-- Never let this block tenant creation: a missing Assistant is'
    || E'\\1-- recoverable, a failed workspace creation is not.'
    || E'\\1begin perform public.provision_workforce_assistant_internal(new.id);'
    || E'\\1exception when others then'
    || E'\\1  raise warning ''workforce assistant provisioning failed for %: %'', new.id, sqlerrm;'
    || E'\\1end;'
    || E'\\1\\2\\3$function$',
    'i');

  IF v_new = v_src THEN
    RAISE EXCEPTION '332: could not locate the RETURN NEW anchor in auto_provision_new_tenant — refusing to guess';
  END IF;
  EXECUTE v_new;
END $wire$;

-- ── 3. Backfill every workspace that is missing one ─────────────────────────
DO $backfill$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT t.id, t.slug FROM tenants t
     WHERE NOT EXISTS (SELECT 1 FROM digital_employees d
                        WHERE d.tenant_id = t.id AND d.is_workforce_assistant)
  LOOP
    PERFORM public.provision_workforce_assistant_internal(r.id);
    RAISE NOTICE '332: provisioned Workforce Assistant for %', r.slug;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '332: backfilled % workspace(s)', n;
END $backfill$;

-- ── 4. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_missing int; v_dupes int; v_wired boolean;
BEGIN
  SELECT count(*) INTO v_missing FROM tenants t
   WHERE NOT EXISTS (SELECT 1 FROM digital_employees d
                      WHERE d.tenant_id = t.id AND d.is_workforce_assistant);
  IF v_missing > 0 THEN RAISE EXCEPTION '332: % workspace(s) still without an Assistant', v_missing; END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT tenant_id FROM digital_employees WHERE is_workforce_assistant
     GROUP BY tenant_id HAVING count(*) > 1) z;
  IF v_dupes > 0 THEN RAISE EXCEPTION '332: % workspace(s) have more than one Assistant', v_dupes; END IF;

  SELECT pg_get_functiondef(p.oid) ~* 'provision_workforce_assistant_internal' INTO v_wired
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auto_provision_new_tenant' AND p.prokind = 'f' LIMIT 1;
  IF NOT coalesce(v_wired, false) THEN
    RAISE EXCEPTION '332: auto_provision_new_tenant is not wired — future workspaces would still miss it';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
