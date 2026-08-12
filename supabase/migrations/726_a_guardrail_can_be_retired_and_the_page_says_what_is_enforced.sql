-- 726_a_guardrail_can_be_retired_and_the_page_says_what_is_enforced.sql
-- ============================================================================
-- Two founder complaints about Governance › Compliance, and they are the same
-- complaint twice: the screen shows a control the person cannot operate, and a
-- word that is not derived from anything.
--
--   item 6  — a preset guardrail cannot be removed.
--   item 7  — the page says Enforcement: Live while most of it is off.
--
-- ── Item 6. Why "remove" is RETIRE, not DELETE ───────────────────────────
-- Measured before writing a line (prod, 2026-08-12): `authenticated` holds
-- SELECT + INSERT + UPDATE on guardrail_rules and NOT DELETE — DELETE is
-- postgres/service_role only. So a hand-rolled `.delete()` from the client
-- fails 42501, at the TABLE GRANT, and never reaches RLS at all. (RLS
-- `guardrail_rules_tenant_write` is FOR ALL and WOULD have permitted it. Two
-- gates, one of them silent; the silent one is the one that was blocking.)
--
-- The founder decision is not to open that grant. A guardrail that blocked
-- something last month is the only surviving explanation of why that block
-- happened — audit_events.detail carries `rule_id` and nothing else, so a
-- deleted row turns 30 recorded blocks into 30 unexplainable ones. The rule
-- stops applying and leaves the working list; the ROW stays. This is the same
-- move mig 611 made for the Specialist role, and it is reversible.
--
-- ⚠ WHY THIS IS A COLUMN PLUS A CHECK AND NOT A STATUS ENUM. A new status
-- would be a second source of truth about "is this enforced", and every one of
-- the fourteen readers below already asks `active`. So retirement is expressed
-- in the vocabulary they already speak: retiring SETS active=false, and
--
--     CHECK (retired_at IS NULL OR active = false)
--
-- makes that implication structural rather than a habit of one RPC. No writer
-- can resurrect a retired rule by flipping `active` — not the UI toggle, not
-- the governance assistant's `resume` proposal, not service_role. The failure
-- class this repo keeps hitting is a marker nobody reads; a CHECK cannot be
-- unread.
--
-- ── The readers, enumerated (this is the part that matters) ──────────────
-- Everything that resolves rules for enforcement already filters `active`:
--   guardrail_rules_for_de        — `and g.active`, and now `retired_at is null`
--   decide_action_execution       — via the resolver; spend caps `where active`
--   decide_inquiry_triage         — via the resolver
--   decide_work_item_triage       — via the resolver
--   score_frustration_internal    — `where ... and active`
--   get_de_briefing / _for_objective — resolver + a second `where r.active`
--   compute_de_lifecycle_readiness, de_config_fingerprint_row — `and active`
--   _shared/answerGuardrails.ts, _shared/guardrailJudge.ts — the resolver RPC
--   voice-turn, playbook-execute ×2, playbook-draft, entity-draft — `.eq('active', true)`
-- So retire ⇒ active=false ⇒ excluded, everywhere, with no reader edited. The
-- resolver gets the redundant `retired_at is null` anyway: it is the single
-- door the three hot paths walk through, and belt-and-braces at one door is
-- cheaper than trusting a CHECK to never be dropped.
--
-- ── What retire deliberately REFUSES ─────────────────────────────────────
--   * A COMPLIANCE-PACK RULE. trg_guard_compliance_guardrails already refuses
--     to switch one off; retiring is switching one off. Detaching the pack is
--     the operation, and the RPC says so in those words instead of letting the
--     trigger's message surface half-translated.
--   * RESTORE DOES NOT RE-ARM. A restored rule returns to the list SWITCHED
--     OFF. Un-retiring is undoing a filing decision; re-enforcing is a separate
--     decision, and a screen that quietly starts blocking again because someone
--     clicked "restore" is the same lie in the other direction.
--
-- ── Item 7. The tile ─────────────────────────────────────────────────────
-- `CompliancePage.tsx:206` hardcoded { label: 'Enforcement', value: 'Live' } —
-- a string literal derived from no config at all. Measured, the truth is three
-- different answers:
--   1. deterministic pattern matching IS live (30 guardrail_block events);
--   2. the semantic/meaning judge is OFF platform-wide — platform_config has NO
--      `semantic_guardrail.enabled` row, so guardrailJudge.semanticGate()
--      returns {enabled:false} before it ever reads the per-tenant flag (the
--      feature_registry row says default_enabled=true, which is exactly why
--      reading the registry alone would have produced a confident wrong answer);
--   3. adjudication is on but `guardrail_adjudication.mode='shadow'` — it logs
--      would_clear and applies nothing (0 rows with mode='enforce').
-- None of that is readable from the browser: platform_config carries no grant
-- to `authenticated` at all, and it holds vault `secret_id`s. So the page gets
-- a purpose-built read-only RPC that MIRRORS the two edge-function gates line
-- for line and returns three booleans and two mode words — never a config
-- value, and with NO key parameter, so it cannot become a config oracle.
--
-- ⚠ This half changes no enforcement behaviour whatsoever. It is a reporting
-- fix, and the point of it is that the next person to read the tile is not lied
-- to — the way a phone screen said "Approved and sent." while nothing had been
-- sent (F-6, mig 721).
-- ============================================================================

-- ── 1. The two columns ────────────────────────────────────────────────────
ALTER TABLE public.guardrail_rules
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid;

COMMENT ON COLUMN public.guardrail_rules.retired_at IS
  'When a person took this rule out of the working list. The row survives so a block recorded months ago can still be explained. The CHECK below makes retired imply inactive — that is what actually stops it being enforced.';
COMMENT ON COLUMN public.guardrail_rules.retired_by IS
  'auth.uid() of whoever retired it. Never a display name — the audit row carries the name.';

-- ── 2. The constraint that does the work ─────────────────────────────────
-- Guarded because ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS.
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guardrail_rules_retired_is_inactive'
       AND conrelid = 'public.guardrail_rules'::regclass
  ) THEN
    ALTER TABLE public.guardrail_rules
      ADD CONSTRAINT guardrail_rules_retired_is_inactive
      CHECK (retired_at IS NULL OR active = false);
  END IF;
END $constraint$;

-- The working list is "everything not retired", on every page load.
CREATE INDEX IF NOT EXISTS guardrail_rules_live_idx
  ON public.guardrail_rules (tenant_id) WHERE retired_at IS NULL;

-- ── 3. The resolver — the one door the hot paths walk through ────────────
-- Signature and behaviour otherwise IDENTICAL to what is live today; the only
-- change is the retired_at clause. CREATE OR REPLACE preserves the ACL, and the
-- REVOKEs below re-state it anyway because mig 610/630 exist for a reason.
CREATE OR REPLACE FUNCTION public.guardrail_rules_for_de(
  p_tenant_id uuid, p_de_id uuid, p_rule_types text[], p_playbook_def_id uuid DEFAULT NULL::uuid)
RETURNS SETOF guardrail_rules
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
  select g.*
  from guardrail_rules g
  where g.tenant_id = p_tenant_id
    and g.active
    -- Redundant while the CHECK stands, and deliberately so: this is the
    -- resolver behind the answer path, the action gate and both triage
    -- decisions, and it should not need a constraint elsewhere to be correct.
    and g.retired_at is null
    and g.rule_type = any(p_rule_types)
    and (
          g.scope = 'workspace'
      or (g.scope = 'employee'   and p_de_id is not null
            and g.scope_ref = p_de_id::text)
      or (g.scope = 'department' and p_de_id is not null
            and g.scope_ref = (select de.department
                                 from digital_employees de
                                where de.id = p_de_id))
      or (g.scope = 'playbook'   and p_playbook_def_id is not null
            and g.scope_ref = p_playbook_def_id::text)
    );
$function$;

REVOKE ALL ON FUNCTION public.guardrail_rules_for_de(uuid, uuid, text[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardrail_rules_for_de(uuid, uuid, text[], uuid) FROM anon;
REVOKE ALL ON FUNCTION public.guardrail_rules_for_de(uuid, uuid, text[], uuid) FROM authenticated;

-- ── 4. Retire ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.retire_guardrail_rule(p_rule_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_rule guardrail_rules;
  v_next guardrail_rules;
begin
  select * into v_rule from guardrail_rules where id = p_rule_id;
  if v_rule.id is null then
    raise exception 'guardrail rule not found';
  end if;

  -- Same authority as set_rule_adjudicable: owner/admin of THAT rule's tenant,
  -- or platform. Reading the tenant off the ROW, never off a parameter — a
  -- tenant id supplied by the caller is not authorisation (mig 662-664).
  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and (p.layer = 'platform'
            or (p.tenant_id = v_rule.tenant_id and p.role in ('tenant_owner', 'tenant_admin')))
  ) then
    raise exception 'only workspace owners and admins can retire a guardrail';
  end if;

  -- A pack rule is a materialised copy of a shared catalogue entry, and
  -- trg_guard_compliance_guardrails refuses to switch one off. Retiring IS
  -- switching one off, so say what the operation actually is.
  if v_rule.compliance_pack_key is not null then
    raise exception 'compliance guardrail (%): it belongs to a pack — detach the pack instead of retiring one of its rules', v_rule.compliance_pack_key;
  end if;

  if v_rule.retired_at is not null then
    return jsonb_build_object('ok', true, 'already_retired', true,
      'rule_id', v_rule.id, 'retired_at', v_rule.retired_at, 'version', v_rule.version);
  end if;

  update guardrail_rules
     set retired_at = now(),
         retired_by = auth.uid(),
         -- ⚠ THIS LINE is what stops enforcement. retired_at is the filing
         -- decision; active=false is the effect, and every reader asks it.
         active     = false,
         version    = version + 1
   where id = p_rule_id
  returning * into v_next;

  -- Same transaction, and the return value is discarded but the EXCEPTION is
  -- not: append_audit_event raises on failure, so no audit row means no
  -- retirement. The full rule is frozen into detail because the row can later
  -- be edited and there is no version history anywhere else.
  perform append_audit_event(
    v_rule.tenant_id, 'You', 'human',
    format('Guardrail retired — "%s" (%s). It no longer applies; the record of what it blocked is kept.',
           v_rule.rule, v_rule.rule_type),
    'config_change',
    jsonb_build_object(
      'event', 'guardrail_retired',
      'rule_id', v_rule.id, 'rule', v_rule.rule, 'rule_type', v_rule.rule_type,
      'pattern', v_rule.pattern, 'threshold', v_rule.threshold,
      'severity', v_rule.severity, 'scope', v_rule.scope, 'scope_ref', v_rule.scope_ref,
      'was_active', v_rule.active, 'version', v_next.version,
      'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('ok', true, 'rule_id', v_next.id,
    'retired_at', v_next.retired_at, 'version', v_next.version);
end;
$function$;

-- ── 5. Restore — reversible, and NOT re-armed ────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_guardrail_rule(p_rule_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_rule guardrail_rules;
  v_next guardrail_rules;
begin
  select * into v_rule from guardrail_rules where id = p_rule_id;
  if v_rule.id is null then
    raise exception 'guardrail rule not found';
  end if;

  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and (p.layer = 'platform'
            or (p.tenant_id = v_rule.tenant_id and p.role in ('tenant_owner', 'tenant_admin')))
  ) then
    raise exception 'only workspace owners and admins can restore a guardrail';
  end if;

  if v_rule.retired_at is null then
    return jsonb_build_object('ok', true, 'already_live', true,
      'rule_id', v_rule.id, 'active', v_rule.active, 'version', v_rule.version);
  end if;

  update guardrail_rules
     set retired_at = null,
         retired_by = null,
         -- ⚠ STAYS OFF. Un-retiring restores the row to the list; deciding to
         -- enforce it again is a separate, visible act on the Active toggle.
         active     = false,
         version    = version + 1
   where id = p_rule_id
  returning * into v_next;

  perform append_audit_event(
    v_rule.tenant_id, 'You', 'human',
    format('Guardrail restored — "%s" (%s). It is back in the list, still switched off.',
           v_rule.rule, v_rule.rule_type),
    'config_change',
    jsonb_build_object(
      'event', 'guardrail_restored',
      'rule_id', v_rule.id, 'rule', v_rule.rule, 'rule_type', v_rule.rule_type,
      'retired_at_was', v_rule.retired_at, 'version', v_next.version));

  return jsonb_build_object('ok', true, 'rule_id', v_next.id, 'active', false,
    'version', v_next.version);
end;
$function$;

-- ── 6. What is actually enforced, for the tile ───────────────────────────
-- ⚠ NO KEY PARAMETER, BY DESIGN. Four platform_config keys are read, and they
-- are literals in this body. platform_config also holds vault secret_ids; a
-- function that took a key and returned its value would be a config oracle
-- behind a SECURITY DEFINER. Nothing here returns a stored value — only
-- booleans and the two mode words.
CREATE OR REPLACE FUNCTION public.guardrail_enforcement_status(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_blocking    integer;
  v_sem_master  text;
  v_sem_mode    text;
  v_sem_on      boolean := false;
  v_adj_master  text;
  v_adj_kill    text;
  v_adj_mode    text;
  v_adj_default boolean;
  v_adj_reg     boolean := false;
  v_adj_ovr     boolean;
  v_adj_ovr_set boolean := false;
  v_adj_on      boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (
       select 1 from profiles p
        where p.user_id = auth.uid()
          and (p.layer = 'platform' or p.tenant_id = p_tenant_id))
  then
    raise exception 'not a member of this workspace';
  end if;

  -- LAYER 1 — deterministic pattern matching. This one is not a flag: the
  -- check is unconditional code in de-answer/widget-ask and in the three
  -- in-Postgres decision functions. What varies is whether the workspace has
  -- given it anything to enforce, so that is what is reported.
  select count(*) into v_blocking
    from guardrail_rules
   where tenant_id = p_tenant_id
     and active and retired_at is null
     and severity = 'blocking'
     and rule_type in ('blocked_phrase', 'blocked_topic');

  -- LAYER 2 — the meaning judge. Mirrors _shared/guardrailJudge.ts
  -- semanticGate(): master first, and master-off is inert REGARDLESS of the
  -- per-tenant flag. Reading feature_registry first would report "on" for a
  -- feature that is globally dark.
  select value into v_sem_master from platform_config where key = 'semantic_guardrail.enabled';
  if coalesce(v_sem_master, '') = 'true' then
    v_sem_on := coalesce(is_feature_enabled_internal(p_tenant_id, 'semantic_guardrail'), false);
    if v_sem_on then
      select value into v_sem_mode from platform_config where key = 'semantic_guardrail.mode';
      v_sem_mode := case when coalesce(v_sem_mode, '') = 'enforce' then 'enforce' else 'shadow' end;
    end if;
  end if;

  -- LAYER 3 — the adjudicator (the only thing that can UN-block). Mirrors
  -- _shared/guardrailAdjudicator.ts adjudicationGate(), including the two
  -- details that matter: the kill switch, and that a MISSING feature_registry
  -- row means DISABLED here rather than is_feature_enabled_internal's fail-open.
  select value into v_adj_master from platform_config where key = 'guardrail_adjudication.enabled';
  select value into v_adj_kill   from platform_config where key = 'guardrail_adjudication.kill';
  select default_enabled into v_adj_default from feature_registry where key = 'guardrail_adjudication';
  v_adj_reg := found;
  select enabled into v_adj_ovr from tenant_feature_overrides
   where tenant_id = p_tenant_id and feature_key = 'guardrail_adjudication';
  v_adj_ovr_set := found;

  v_adj_on := coalesce(v_adj_master, '') = 'true'
          and coalesce(v_adj_kill, '') <> 'true'
          and v_adj_reg
          and (case when v_adj_ovr_set then coalesce(v_adj_ovr, false) else coalesce(v_adj_default, false) end);
  if v_adj_on then
    select value into v_adj_mode from platform_config where key = 'guardrail_adjudication.mode';
    v_adj_mode := case when coalesce(v_adj_mode, '') = 'enforce' then 'enforce' else 'shadow' end;
  end if;

  return jsonb_build_object(
    'patterns',     jsonb_build_object('live', true, 'blocking_rules', v_blocking),
    'semantic',     jsonb_build_object('enabled', v_sem_on, 'mode', v_sem_mode),
    'adjudication', jsonb_build_object('enabled', v_adj_on, 'mode', v_adj_mode));
end;
$function$;

-- ── 7. Perimeter (security_default_execute_grant) ────────────────────────
-- ⚠ NO DELETE GRANT IS ADDED TO guardrail_rules, HERE OR ANYWHERE. Retirement
-- exists precisely so that grant stays closed; the assertions below prove it
-- is still closed after this migration ran.
REVOKE ALL ON FUNCTION public.retire_guardrail_rule(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retire_guardrail_rule(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.retire_guardrail_rule(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.restore_guardrail_rule(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_guardrail_rule(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.restore_guardrail_rule(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.guardrail_enforcement_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardrail_enforcement_status(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.guardrail_enforcement_status(uuid) TO authenticated;

-- ── Assertions. Each one can fail, and each fails for a DIFFERENT reason ──
DO $assert$
DECLARE
  v_def    text;
  v_probe  uuid;
  v_bit    boolean;
  v_checks integer := 0;
BEGIN
  -- 1. The columns.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'guardrail_rules'
                    AND column_name = 'retired_at') THEN
    RAISE EXCEPTION '726: guardrail_rules.retired_at was not added';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'guardrail_rules'
                    AND column_name = 'retired_by') THEN
    RAISE EXCEPTION '726: guardrail_rules.retired_by was not added';
  END IF;
  v_checks := v_checks + 2;

  -- 2. The constraint exists, and says what we think it says.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'guardrail_rules_retired_is_inactive'
     AND conrelid = 'public.guardrail_rules'::regclass;
  IF v_def IS NULL THEN
    RAISE EXCEPTION '726: the retired-implies-inactive CHECK does not exist';
  END IF;
  IF v_def !~* 'retired_at IS NULL' OR v_def !~* 'active = false' THEN
    RAISE EXCEPTION '726: the CHECK is not the retired-implies-inactive predicate: %', v_def;
  END IF;
  v_checks := v_checks + 2;

  -- 3. THE CONSTRAINT MUST BITE. Proving it EXISTS only proves the DDL parsed.
  --    A control that has never refused anything is indistinguishable from a
  --    comment, so try to break it. The probe runs in a subtransaction: the
  --    expected check_violation rolls the UPDATE back, and if the violation
  --    does NOT happen the RAISE below aborts the whole migration.
  SELECT id INTO v_probe FROM public.guardrail_rules
   WHERE compliance_pack_key IS NULL AND active AND retired_at IS NULL LIMIT 1;
  IF v_probe IS NULL THEN
    RAISE NOTICE '726: no live non-pack rule exists to probe — the CHECK was asserted structurally only (1 of 2 constraint checks ran)';
  ELSE
    v_bit := false;
    BEGIN
      UPDATE public.guardrail_rules SET retired_at = now() WHERE id = v_probe;  -- active still true
    EXCEPTION WHEN check_violation THEN
      v_bit := true;
    END;
    IF NOT v_bit THEN
      RAISE EXCEPTION '726: a rule can be marked retired while still ACTIVE — retiring one would not stop it being enforced';
    END IF;
    v_checks := v_checks + 1;
  END IF;

  -- 4. The resolver excludes retired rules AND still excludes inactive ones.
  --    Losing `g.active` while gaining `retired_at` would be a straight
  --    downgrade, so both are asserted.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guardrail_rules_for_de';
  IF v_def IS NULL THEN RAISE EXCEPTION '726: guardrail_rules_for_de is missing'; END IF;
  IF v_def !~* 'g\.retired_at is null' THEN
    RAISE EXCEPTION '726: the resolver does not exclude retired rules — retirement would not reach the answer, action or triage paths';
  END IF;
  IF v_def !~* 'and g\.active' THEN
    RAISE EXCEPTION '726: the resolver no longer filters on active';
  END IF;
  v_checks := v_checks + 3;

  -- 5. The resolver perimeter survived CREATE OR REPLACE — in BOTH directions.
  --    Too open is the mig 610/630 hazard: a replaced function silently
  --    regaining PUBLIC EXECUTE.
  IF has_function_privilege('authenticated', 'public.guardrail_rules_for_de(uuid,uuid,text[],uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guardrail_rules_for_de(uuid,uuid,text[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '726: guardrail_rules_for_de became callable from the internet';
  END IF;
  --    Too CLOSED is worse and much quieter. _shared/answerGuardrails.ts calls
  --    this RPC with the service key and treats ANY failure as "screening did
  --    not run" — which fails CLOSED, so a lost grant would not error visibly:
  --    it would silently withhold and escalate every single DE answer on the
  --    platform. That has to break the migration, not the product.
  IF NOT has_function_privilege('service_role', 'public.guardrail_rules_for_de(uuid,uuid,text[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '726: service_role lost EXECUTE on guardrail_rules_for_de — every answer would fail closed';
  END IF;
  v_checks := v_checks + 2;

  -- 6. retire_guardrail_rule: exists, definer, pinned, and does the three
  --    things the whole design rests on.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'retire_guardrail_rule';
  IF v_def IS NULL THEN RAISE EXCEPTION '726: retire_guardrail_rule was not created'; END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'retire_guardrail_rule') THEN
    RAISE EXCEPTION '726: retire_guardrail_rule is not SECURITY DEFINER';
  END IF;
  IF v_def NOT LIKE '%SET search_path TO ''public''%' THEN
    RAISE EXCEPTION '726: retire_guardrail_rule has no pinned search_path';
  END IF;
  IF v_def !~* 'active\s*=\s*false' THEN
    RAISE EXCEPTION '726: retiring does not switch the rule off — every reader filters on active, so it would keep enforcing';
  END IF;
  IF v_def NOT LIKE '%append_audit_event%' THEN
    RAISE EXCEPTION '726: retiring writes no audit row — the whole point is that the record survives';
  END IF;
  IF v_def NOT LIKE '%compliance_pack_key is not null%' THEN
    RAISE EXCEPTION '726: retiring does not refuse compliance-pack rules';
  END IF;
  IF v_def NOT LIKE '%tenant_owner%' OR v_def NOT LIKE '%tenant_admin%' THEN
    RAISE EXCEPTION '726: retiring is not restricted to owners/admins';
  END IF;
  v_checks := v_checks + 7;

  -- 7. restore exists, is equally locked down, and comes back SWITCHED OFF.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'restore_guardrail_rule';
  IF v_def IS NULL THEN RAISE EXCEPTION '726: restore_guardrail_rule was not created'; END IF;
  IF v_def NOT LIKE '%SET search_path TO ''public''%' THEN
    RAISE EXCEPTION '726: restore_guardrail_rule has no pinned search_path';
  END IF;
  IF v_def NOT LIKE '%tenant_owner%' OR v_def NOT LIKE '%tenant_admin%' THEN
    RAISE EXCEPTION '726: restoring is not restricted to owners/admins';
  END IF;
  IF v_def !~* 'retired_at\s*=\s*null' THEN
    RAISE EXCEPTION '726: restore does not clear retired_at';
  END IF;
  IF v_def !~* 'active\s*=\s*false' THEN
    RAISE EXCEPTION '726: restore re-arms the rule — un-retiring must not silently start blocking again';
  END IF;
  v_checks := v_checks + 5;

  -- 8. The status RPC: guarded, keyless, and reading all four config keys it
  --    claims to mirror. A typo in any key name would silently report "off"
  --    forever, which is how a reporting fix becomes a new lie.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guardrail_enforcement_status';
  IF v_def IS NULL THEN RAISE EXCEPTION '726: guardrail_enforcement_status was not created'; END IF;
  IF v_def NOT LIKE '%SET search_path TO ''public''%' THEN
    RAISE EXCEPTION '726: guardrail_enforcement_status has no pinned search_path';
  END IF;
  IF (SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guardrail_enforcement_status') <> 'p_tenant_id uuid' THEN
    RAISE EXCEPTION '726: guardrail_enforcement_status takes something other than a tenant id — it must never accept a config key';
  END IF;
  IF v_def NOT LIKE '%not a member of this workspace%' THEN
    RAISE EXCEPTION '726: guardrail_enforcement_status has no membership guard';
  END IF;
  IF v_def NOT LIKE '%semantic_guardrail.enabled%'
     OR v_def NOT LIKE '%guardrail_adjudication.enabled%'
     OR v_def NOT LIKE '%guardrail_adjudication.kill%'
     OR v_def NOT LIKE '%guardrail_adjudication.mode%' THEN
    RAISE EXCEPTION '726: guardrail_enforcement_status does not read the gates it claims to mirror';
  END IF;
  v_checks := v_checks + 5;

  -- 9. THE TRAP. Retirement exists so DELETE stays shut. Prove it stayed shut.
  IF has_table_privilege('authenticated', 'public.guardrail_rules', 'DELETE')
     OR has_table_privilege('anon', 'public.guardrail_rules', 'DELETE') THEN
    RAISE EXCEPTION '726: DELETE on guardrail_rules is now granted to the internet — retirement was supposed to make that unnecessary';
  END IF;
  v_checks := v_checks + 1;

  -- 10. The new RPCs are callable by a signed-in owner/admin and by nobody else.
  IF NOT has_function_privilege('authenticated', 'public.retire_guardrail_rule(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.restore_guardrail_rule(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.guardrail_enforcement_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '726: the page cannot call its own RPCs';
  END IF;
  IF has_function_privilege('anon', 'public.retire_guardrail_rule(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.restore_guardrail_rule(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guardrail_enforcement_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '726: anon holds EXECUTE on one of the new RPCs';
  END IF;
  v_checks := v_checks + 2;

  RAISE NOTICE '726: % assertions passed — a guardrail can be retired without being deleted, and the Compliance tile reads its answer out of config.', v_checks;
END $assert$;

NOTIFY pgrst, 'reload schema';
