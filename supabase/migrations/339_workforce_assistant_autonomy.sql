-- 339_workforce_assistant_autonomy.sql
-- ============================================================================
-- Make the Workforce Assistant actually ANSWER.
--
-- Mig 332 put a Workforce Assistant in all 16 workspaces and wired the trigger
-- so future ones get one too. It provisioned the EMPLOYEE and not its ANSWERING
-- PERMISSION, which is a different table — so all 16 shipped mute.
--
-- The failure is silent and total. de-answer resolves the per-employee dial and
-- does this (de-answer/index.ts:432):
--
--     if (dial?.enabled === false) confidenceFloor = 101;   // every answer goes to a human
--
-- With no de_autonomy row, resolve_de_autonomy returns enabled = false, the
-- floor becomes 101, and 101 is unreachable — so EVERY message escalates,
-- however confident and well-grounded the answer was. Verified against the live
-- database before writing this: 16 assistants, 0 autonomy rows, and
-- resolve_de_autonomy returning {enabled: false} for every one.
--
-- This is the SAME defect the founder hit live on the Technical Support DE
-- ("it always asks for human approval"). That was fixed by inserting the two
-- missing rows for that ONE employee; making the Assistant global then
-- reproduced the original broken state in every workspace. Fixing the
-- provisioner is what stops it recurring on the next tenant.
--
-- ── Choices, and why ────────────────────────────────────────────────────────
-- * Floor 70. Confident, well-grounded answers reach the admin; weak ones still
--   route to a human. Same bar the founder chose for Technical Support.
-- * answer_dock ONLY, not answer_widget. The Assistant is an internal advisor
--   for workspace admins — it knows how DreamTeam works and can change this
--   workspace's settings. It has no business on a public customer widget, and
--   granting only what it needs keeps that true by configuration rather than by
--   everyone remembering. (This is also why GI-10 adjudication excluded the
--   widget: an anonymous asker must not be able to steer an internal advisor.)
-- * enabled = true, but trust_level stays 'supervised' and external_reply_mode
--   stays 'draft'. This grants the right to ANSWER, not the right to ACT: every
--   action still goes through decide_action_execution, the trust dial and the
--   guardrails, untouched.
-- ============================================================================

-- ── 1. Backfill every existing Workforce Assistant ──────────────────────────
INSERT INTO de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence, max_amount_cents)
SELECT d.tenant_id, 'answer_dock', NULL, d.id, true, 70, NULL
  FROM digital_employees d
 WHERE d.is_workforce_assistant
ON CONFLICT (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, ''))
DO UPDATE SET enabled = true, min_confidence = 70;

-- ── 2. Stop it recurring: the provisioner grants the permission too ─────────
-- Reproduced from the live definition (mig 332); the ONLY change is the
-- de_autonomy insert before the RETURN.
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

  SELECT id INTO v_existing FROM digital_employees
   WHERE tenant_id = p_tenant_id AND is_workforce_assistant = true LIMIT 1;
  IF v_existing IS NOT NULL THEN
    -- Idempotent, and self-healing: an employee provisioned before this
    -- migration gets its missing permission the next time this runs.
    INSERT INTO de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence, max_amount_cents)
    VALUES (p_tenant_id, 'answer_dock', NULL, v_existing, true, 70, NULL)
    ON CONFLICT (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, ''))
    DO NOTHING;
    RETURN v_existing;
  END IF;

  INSERT INTO digital_employees (
    tenant_id, name, icon, category, task_type, status, lifecycle_status,
    trust_level, model_provider, model_id, escalation_model_id,
    confidence_threshold, escalation_threshold, external_reply_mode,
    availability, is_workforce_assistant, is_product_expert, charter
  ) VALUES (
    p_tenant_id, 'Workforce Assistant', 'D', 'Customer', 'chat', 'active',
    'designed',
    'supervised',
    'anthropic', 'claude-haiku-4-5-20251001', 'claude-sonnet-5',
    75, 60,
    'draft',
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

  -- THE PART MIG 332 MISSED. Without this the employee exists and is mute:
  -- resolve_de_autonomy returns enabled=false, de-answer sets the confidence
  -- floor to 101, and every single message escalates to a human.
  -- answer_dock only — this is an internal advisor, never a public widget.
  INSERT INTO de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence, max_amount_cents)
  VALUES (p_tenant_id, 'answer_dock', NULL, v_id, true, 70, NULL)
  ON CONFLICT (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, ''))
  DO NOTHING;

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public.provision_workforce_assistant_internal(uuid) FROM public, anon, authenticated;

-- ── 3. Prove every assistant can now answer ─────────────────────────────────
DO $assert$
DECLARE r record; v_mute int := 0; v_total int := 0;
BEGIN
  FOR r IN SELECT d.id, d.tenant_id, t.slug
             FROM digital_employees d JOIN tenants t ON t.id = d.tenant_id
            WHERE d.is_workforce_assistant
  LOOP
    v_total := v_total + 1;
    IF NOT coalesce((SELECT enabled FROM public.resolve_de_autonomy(r.tenant_id, 'answer_dock', r.id, NULL)), false)
    THEN
      RAISE WARNING '339: assistant in % still resolves to enabled=false', r.slug;
      v_mute := v_mute + 1;
    END IF;
  END LOOP;

  IF v_mute > 0 THEN
    RAISE EXCEPTION '339: % of % assistants would still escalate every message', v_mute, v_total;
  END IF;
  RAISE NOTICE '339: % assistant(s) can answer', v_total;

  -- And the provisioner must grant it, or the next tenant repeats the bug.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'provision_workforce_assistant_internal'
         AND p.prokind = 'f' LIMIT 1) !~* 'de_autonomy'
  THEN RAISE EXCEPTION '339: the provisioner still does not grant answering permission'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
