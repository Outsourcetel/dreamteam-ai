-- 459+1_trust_unbrick_registered_actions.sql
-- ============================================================================
-- TRUST PROGRAM mig 2 of N (docs/31 Q7, Architecture B — founder-approved).
-- "Un-brick registered actions" — makes per-action trust REPRESENTABLE without
-- opening anything.
--
-- The wound (docs/31, proven live): connector-hub passes the registered
-- action's own key as p_action_type into decide_action_execution, whose single
-- resolve_de_autonomy call then looks for a per-action dial row the (now
-- lifted, mig 459) 4-value constraint made unrepresentable — so every
-- registered action has been permanently human-gated since July 7.
--
-- The fix: a fallback chain over the UNTOUCHED resolver. decide_action_execution
-- now asks, in order:
--     1. the action's own key            (p_action_type, e.g. a raw action key)
--     2. the action's whole category     ('action:' || p_category)
--     3. the generic gate                ('action_execute')
-- The FIRST key that has ANY dial row for the tenant decides; no key with a
-- row -> deny, exactly the resolver's own default shape.
--
-- NOTHING OPENS BY ITSELF: every action_execute dial row in production is
-- enabled=false (asserted below, hard-fails the migration if that ever
-- changes before apply), so the 14 gated connector actions REMAIN gated —
-- the chain only makes it possible for a manager to open trust per action
-- or per category later, through the ladder machinery of mig 459.
--
-- ORDER OF AUTHORITY IS UNCHANGED: the destructive floor (step 0), guardrail
-- rules (step 1), the amount threshold (step 1.5) and spend caps (step 1.6)
-- all return before the dial is consulted — the splice touches only step 2,
-- and the assert below proves the ordering survived.
--
-- Auth contexts (all enumerated live 2026-07-27):
--   * decide_action_execution — (i) service_role via admin.rpc in
--     connector-hub (execute_action) and playbook-execute (renewal invoice):
--     uid NULL, role service_role; no auth read exists in the function and
--     the splice adds none. (ii) user JWT indirectly through the four
--     SECURITY DEFINER writeback proposers (propose_account/-continuity/
--     -invoice/-opportunity_writeback, reached from src/lib/writeBackApi.ts
--     and continuityApi.ts and from de-work): they call with 5 args, so
--     p_action_type defaults to 'action_execute' — the chain's first key is
--     then 'action_execute' itself, which resolves through the identical
--     lookup as today (equivalence asserted below per live tenant/category).
--     (iii) direct-DB: no trigger and no cron.job invokes it (verified
--     against pg_trigger and the full cron.job list).
--   * resolve_de_autonomy — UNTOUCHED, asserted byte-identical below. Its
--     callers (service_role: de-answer answer_dock, widget-ask answer_widget,
--     playbook-execute invoice_auto_send; in-DB: decide_inquiry_triage,
--     decide_work_item_triage, resolve_my_de_autonomy, decide_action_execution)
--     therefore keep their exact behavior in every context.
--   * resolve_de_autonomy_chain — NEW; callable only by its definer-context
--     caller and service_role (PUBLIC/anon/authenticated revoked below,
--     matching resolve_de_autonomy's live ACL). It reads no auth context, so
--     user / service-role / direct-DB callers of its callers all pass. It can
--     never return zero rows (asserted): deny is an explicit
--     (false, null, null) row, never an empty set.
-- ============================================================================

-- Snapshot the resolver BEFORE any change in this file (compared at the end;
-- the whole file runs in one session/transaction).
CREATE TEMP TABLE _trust_mig2_resolver_snapshot AS
SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'resolve_de_autonomy';

DO $pre$
BEGIN
  IF (SELECT count(*) FROM _trust_mig2_resolver_snapshot) <> 1 THEN
    RAISE EXCEPTION 'trust-mig-2: expected exactly 1 resolve_de_autonomy before patching';
  END IF;
  -- Mig 459 (ladder-as-data) must already have lifted the key constraint,
  -- otherwise 'action:<category>' dial rows written later would be rejected.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.de_autonomy'::regclass
                AND conname = 'de_autonomy_action_type_check'
                AND pg_get_constraintdef(oid) LIKE '%ANY (ARRAY%') THEN
    RAISE EXCEPTION 'trust-mig-2: de_autonomy.action_type is still frozen — apply the ladder-as-data migration first';
  END IF;
END $pre$;

-- ── The fallback chain over the untouched resolver ──────────────────────────
-- First key with ANY dial row for this tenant wins; the scope cascade, the
-- records gate and the deny default all stay inside resolve_de_autonomy,
-- which is consulted exactly once, for the winning key. Deliberately
-- conservative: if a key has rows only at scopes this call cannot reach
-- (another employee's override, another source category), the key still
-- wins and the resolver's own default DENIES — the chain never falls
-- through past a key a manager has expressed an opinion about.

CREATE OR REPLACE FUNCTION public.resolve_de_autonomy_chain(
  p_tenant_id uuid,
  p_keys text[],
  p_de_id uuid DEFAULT NULL::uuid,
  p_source_category text DEFAULT NULL::text)
RETURNS TABLE(enabled boolean, max_amount_cents bigint, min_confidence integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_key text;
begin
  foreach v_key in array coalesce(p_keys, array[]::text[]) loop
    if v_key is null or v_key = '' then continue; end if;
    if exists (
      select 1 from de_autonomy a
      where a.tenant_id = p_tenant_id
        and a.action_type = v_key
    ) then
      return query select * from resolve_de_autonomy(p_tenant_id, v_key, p_de_id, p_source_category);
      return;
    end if;
  end loop;
  -- No key has a reachable dial row: deny, one explicit row — never empty.
  return query select false, null::bigint, null::integer;
end;
$function$;

REVOKE ALL ON FUNCTION public.resolve_de_autonomy_chain(uuid, text[], uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_de_autonomy_chain(uuid, text[], uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_de_autonomy_chain(uuid, text[], uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_de_autonomy_chain(uuid, text[], uuid, text) TO service_role;

-- ── Splice decide_action_execution's step 2 onto the chain ──────────────────
-- 441-style patch of the LIVE body (read 2026-07-27; this function was NOT in
-- the Wave-2 sweep — verified against migs 387-457): everything except the
-- single dial lookup stays byte-identical, guardrail fix comments included.

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text; a_anchor text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'decide_action_execution';
  IF v_src IS NULL THEN RAISE EXCEPTION 'trust-mig-2: decide_action_execution not found'; END IF;
  IF v_src ILIKE '%resolve_de_autonomy_chain%' THEN
    RAISE NOTICE 'trust-mig-2: decide_action_execution already resolves through the chain'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  a_anchor := array_to_string(ARRAY[
    '  -- 2) Trust dial (per-employee cascade).',
    '  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, p_action_type, p_de_id, p_category);'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'trust-mig-2: expected 1 trust-dial anchor in decide_action_execution, found %', v_hits; END IF;

  v_new := replace(v_src, a_anchor, array_to_string(ARRAY[
    '  -- 2) Trust dial (per-employee cascade), resolved through the fallback',
    '  --    chain: the registered action''s own key first, then its whole',
    '  --    category, then the generic gate. Every generic-gate seed sits at',
    '  --    enabled=false, so nothing opens by itself — this makes per-action',
    '  --    trust representable, and that is all it does. The destructive',
    '  --    floor, guardrails, the amount threshold and spend caps all',
    '  --    returned above before this line is ever reached.',
    '  select * into v_autonomy from resolve_de_autonomy_chain(',
    '    p_tenant_id,',
    '    array[',
    '      nullif(p_action_type, ''''),',
    '      case when nullif(p_category, '''') is not null then ''action:'' || p_category end,',
    '      ''action_execute''',
    '    ],',
    '    p_de_id, p_category);'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION 'trust-mig-2: decide_action_execution edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

-- ── Asserts: landed, gated stays gated, resolver untouched ──────────────────

DO $assert$
DECLARE
  v_def text; v_now text; v_n int;
  v_key text; v_cat text;
  v_r record; v_chain record; v_old record; v_generic record;
BEGIN
  -- Chain exists exactly once and is locked down like its sibling resolver.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'resolve_de_autonomy_chain';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-2: expected exactly 1 resolve_de_autonomy_chain, found %', v_n; END IF;
  IF has_function_privilege('anon', 'public.resolve_de_autonomy_chain(uuid,text[],uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trust-mig-2: anon can execute resolve_de_autonomy_chain';
  END IF;
  IF has_function_privilege('authenticated', 'public.resolve_de_autonomy_chain(uuid,text[],uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trust-mig-2: authenticated can execute resolve_de_autonomy_chain';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.resolve_de_autonomy_chain(uuid,text[],uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trust-mig-2: service_role lost EXECUTE on resolve_de_autonomy_chain';
  END IF;

  -- The splice landed; the founder-locked order of authority survived:
  -- destructive floor, then guardrails, then amount threshold, then spend
  -- caps, and only then the dial.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'decide_action_execution';
  IF v_def NOT ILIKE '%resolve_de_autonomy_chain%' THEN
    RAISE EXCEPTION 'trust-mig-2: decide_action_execution does not resolve through the chain';
  END IF;
  IF NOT (position('0) DESTRUCTIVE ALWAYS GATES' in v_def) > 0
      AND position('0) DESTRUCTIVE ALWAYS GATES' in v_def) < position('1) Guardrail check' in v_def)
      AND position('1) Guardrail check' in v_def)          < position('1.5) Amount guardrail' in v_def)
      AND position('1.5) Amount guardrail' in v_def)       < position('1.6) SPEND CAPS' in v_def)
      AND position('1.6) SPEND CAPS' in v_def)             < position('resolve_de_autonomy_chain' in v_def)) THEN
    RAISE EXCEPTION 'trust-mig-2: the order of authority (destructive -> guardrail -> amount -> spend caps -> dial) was disturbed';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'decide_action_execution';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-2: expected exactly 1 decide_action_execution, found %', v_n; END IF;
  IF NOT has_function_privilege('service_role', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trust-mig-2: service_role lost EXECUTE on decide_action_execution (connector-hub and playbook-execute call it)';
  END IF;

  -- SAFETY: every action_execute dial row in production is enabled=false.
  -- If a tenant deliberately enables one between draft and apply, this
  -- migration must be re-reviewed, not force-applied.
  SELECT count(*) INTO v_n FROM public.de_autonomy
   WHERE action_type = 'action_execute' AND enabled;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'trust-mig-2: % action_execute dial rows are enabled=true — the gated-stays-gated precondition no longer holds; re-verify before applying', v_n;
  END IF;

  -- Functional proof, per live tenant/category that carries generic-gate
  -- seeds: a real registered action key resolved through the chain STILL
  -- comes back disabled (the 14 gated actions remain gated), and the chain
  -- is row-identical to the untouched resolver for the 'action_execute'
  -- first-key shape the four writeback proposers produce.
  SELECT d.action_key, d.category INTO v_key, v_cat
    FROM public.action_definitions d
   WHERE coalesce((d.risk->>'destructive')::boolean, true) = false
   ORDER BY d.created_at
   LIMIT 1;
  IF v_key IS NULL THEN v_key := 'registered_action_probe'; v_cat := 'crm'; END IF;

  FOR v_r IN
    SELECT DISTINCT a.tenant_id, a.source_category
      FROM public.de_autonomy a
     WHERE a.action_type = 'action_execute'
  LOOP
    SELECT * INTO v_chain FROM public.resolve_de_autonomy_chain(
      v_r.tenant_id,
      ARRAY[v_key, 'action:' || coalesce(v_r.source_category, v_cat), 'action_execute'],
      NULL, v_r.source_category);
    IF v_chain IS NULL THEN
      RAISE EXCEPTION 'trust-mig-2: the chain returned EMPTY for tenant % — deny must be an explicit row', v_r.tenant_id;
    END IF;
    IF coalesce(v_chain.enabled, false) THEN
      RAISE EXCEPTION 'trust-mig-2: chain resolution for key % (tenant %, category %) came back ENABLED — a gated action would open',
        v_key, v_r.tenant_id, v_r.source_category;
    END IF;

    SELECT * INTO v_old FROM public.resolve_de_autonomy(
      v_r.tenant_id, 'action_execute', NULL, v_r.source_category);
    SELECT * INTO v_generic FROM public.resolve_de_autonomy_chain(
      v_r.tenant_id,
      ARRAY['action_execute', 'action:' || coalesce(v_r.source_category, v_cat), 'action_execute'],
      NULL, v_r.source_category);
    IF (v_old.enabled, v_old.max_amount_cents, v_old.min_confidence)
       IS DISTINCT FROM (v_generic.enabled, v_generic.max_amount_cents, v_generic.min_confidence) THEN
      RAISE EXCEPTION 'trust-mig-2: chain diverges from the resolver for the writeback-proposer shape (tenant %, category %)',
        v_r.tenant_id, v_r.source_category;
    END IF;
  END LOOP;

  -- Deny-not-empty also for a key nobody has ever written.
  SELECT count(*) INTO v_n FROM public.resolve_de_autonomy_chain(
    gen_random_uuid(), ARRAY['no_such_key_ever'], NULL, NULL);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'trust-mig-2: chain must return exactly 1 deny row for an unknown key, got % rows', v_n;
  END IF;

  -- The four single-key callers (de-answer answer_dock, widget-ask
  -- answer_widget, invoice playbook invoice_auto_send, and the triage
  -- deciders) are untouched because their target is untouched:
  -- resolve_de_autonomy must be BYTE-IDENTICAL to the pre-migration snapshot.
  SELECT def INTO v_def FROM _trust_mig2_resolver_snapshot;
  SELECT pg_get_functiondef(p.oid) INTO v_now
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'resolve_de_autonomy';
  IF v_now IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'trust-mig-2: resolve_de_autonomy changed during this migration — it must remain byte-identical';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'resolve_de_autonomy';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-2: expected exactly 1 resolve_de_autonomy, found %', v_n; END IF;

  RAISE NOTICE 'trust-mig-2: registered actions un-bricked (chain live, everything still gated; % generic-gate rows verified disabled).',
    (SELECT count(*) FROM public.de_autonomy WHERE action_type = 'action_execute');
END $assert$;

DROP TABLE _trust_mig2_resolver_snapshot;

NOTIFY pgrst, 'reload schema';
