-- 460_trust_surface_backend.sql  (TRUST PROGRAM · MIGRATION 3 — the RPCs the new Trust tab calls)
-- ============================================================================
-- docs/31 Q7, Architecture B ("generalize the dial in place"), founder-approved.
-- DRAFT — placeholder number 460; the main session assigns the real number
-- (458-464 reserved for this program) and applies.
--
-- WHAT THIS FILE ADDS (three UI-facing RPCs + two internal helpers):
--   1. de_trust_surface_candidates(tenant, de)  — INTERNAL. Derives, from live
--      config only, every capability this employee actually has.
--   2. validate_trust_ladder(ladder, uses_conf, uses_amt, max_level) —
--      INTERNAL. Pure
--      shape/monotonicity validator, factored out so this migration can
--      behaviourally test the validation as postgres (no auth context needed).
--   3. list_de_trust_surface(p_de_id) returns jsonb — the Trust tab reader.
--   4. seed_de_trust_policy(p_de_id, p_capability_key, p_display_name) —
--      idempotent lazy per-surface-item seeding (replaces the broken
--      empty-panel seeding: the UI seeds on demand per missing surface item).
--   5. set_trust_ladder(p_policy_id, p_ladder, p_display_name, p_criteria,
--      p_clear_ladder) — the manager's customization write, validated in the
--      function; reset is the explicit p_clear_ladder flag (PostgREST maps a
--      JSON null jsonb argument to SQL NULL, so an in-band sentinel cannot
--      express "clear" from the UI).
--
-- WHAT THIS FILE DOES **NOT** TOUCH (founder-locked ordering):
--   guardrails / destructive gates / spend caps sit ABOVE the trust dial in
--   every enforcement path (decide_action_execution steps 0→1→1.5→1.6→2,
--   verified live 2026-07-27). No enforcement function is created, replaced
--   or amended here. can_access_de (90 dependents) is CALLED, never AMENDED.
--   resolve_de_autonomy, trust_apply_level, apply_trust_promotion and
--   trust_demote are reused as-is (trust_apply_level is invoked by
--   set_trust_ladder to re-sync an already-earned level; its compile is M1/M2's
--   concern, not changed here).
--
-- DEPENDS ON M1 (asserted below, this file refuses to apply first):
--   - trust_policies.ladder   jsonb   (per-policy custom ladder; NULL = the
--     engine's built-in level rewards — exactly today's behaviour)
--   - trust_policies.display_name text
--   - the two 4-value CHECK constraints on trust_policies.action_category and
--     de_autonomy.action_type must be GONE (trust keys are free text:
--     'answer_dock' / 'answer_widget' / 'invoice_auto_send' /
--     'action:<category>' / a raw action key for one action).
--
-- LADDER SHAPE — the contract shared VERBATIM with the M1 draft
-- (trust_ladder_settings is the reader; the preflight below cross-asserts
-- against its compiled body so the two files cannot drift apart):
--   ladder := jsonb ARRAY of 1..max_level entries. Level 0 is IMPLICIT and
--   always human-gated — never stored (M1's lookup returns the disabled
--   floor for level <= 0 and for any level below the lowest stored entry).
--   Each entry:
--     { "level":    REQUIRED int, 1..max_level, unique within the ladder,
--       "name":     manager-chosen text, 1..80 chars,
--       "mode":     'draft' | 'act_with_approval' | 'act_within_limits' | 'act',
--       "settings": object, only fields the capability's enforcement reads:
--                     min_confidence   int 0..100  (answer capabilities)
--                     max_amount_cents int  > 0    (amount-gated capabilities) }
--   'enabled' is NEVER a settings key: M1's trust_ladder_settings DERIVES it
--   from the entry's mode (draft -> false; the three acting modes -> true).
--   Validation enforced in set_trust_ladder (via validate_trust_ladder):
--     - level REQUIRED, integer, unique, 1..max_level — reject otherwise;
--     - mode rank never narrows as levels rise (draft < act_with_approval <
--       act_within_limits < act; the implicit level-0 floor ranks as draft);
--     - settings monotonically WIDEN with level: min_confidence non-increasing,
--       max_amount_cents non-decreasing (across the entries where present);
--     - 'draft' / 'act_with_approval' entries carry no settings (nothing
--       executes without a human at those modes);
--     - 'act_within_limits' requires at least one limit;
--     - unknown fields anywhere → error.
--
-- ENFORCEMENT FLAGS (measured against live enforcement, 2026-07-27):
--   answer_dock / answer_widget  → uses_confidence  (de-answer line ~652 and
--     widget-ask read min_confidence as the confidence floor; enabled=false
--     means every answer drafts to a human).
--   invoice_auto_send            → uses_amount      (playbook-execute + the
--     dial's max_amount_cents; min_confidence is never read on this path).
--   action:<category> / raw action keys / action_execute → uses_amount
--     (decide_action_execution reads enabled + max_amount_cents; it NEVER
--     reads min_confidence — proven from the live body).
--
-- SURFACE DERIVATION (all joins verified against live schema + live code):
--   answer_dock       — always (every employee answers in the dock).
--   answer_widget     — the employee actually serves the public widget:
--                       it is widget-eligible (lifecycle_status not in
--                       paused/retired/archived/designed — widget-ask's own
--                       filter) AND (an active widget_keys row binds it
--                       (widget_keys.de_id, mig 323) OR an active key exists
--                       with no eligible bound employee and this employee is
--                       the front-DE heuristic winner: oldest 'auto'
--                       external_reply_mode DE, else oldest eligible).
--   action:<category> — one entry per DISTINCT action_definitions.category
--                       reachable through the tenant's CONNECTED connectors.
--                       Reachability mirrors connector-hub's
--                       resolveActionDefinition: an active definition row
--                       (scope='platform', or scope='tenant' for this tenant)
--                       whose category matches a connectors row with
--                       status='connected'; provider='internal' rows are
--                       excluded (connector-hub hard-refuses them: "executed
--                       by the playbook engine, not through a connector").
--                       Provider match is deliberately NOT required beyond
--                       that: resolveActionDefinition falls back to the first
--                       platform row of the category, so every active row in a
--                       connected category is genuinely executable.
--   <action_key>      — child entries (kind='action') per reachable
--                       (category, action_key), destructive := bool_or of the
--                       risk->destructive flags (missing flag = destructive,
--                       matching decide_action_execution's coalesce(p,true)).
--                       Destructive entries: dialable=false, dial=null —
--                       visible, never dial-able (the destructive gate sits
--                       above the dial and always wins).
--   invoice_auto_send — only if this employee runs the renewal playbook:
--                       a PUBLISHED playbook_definitions row with de_id =
--                       this employee containing a 'generate_invoice' step
--                       (the live DE↔playbook link is playbook_definitions
--                       .de_id via resolveRunDeId; digital_employees.charter
--                       carries no playbook link — checked live). The legacy
--                       renewal_v1 built-in run resolves the WORKSPACE tier
--                       with de_id NULL, so it belongs to the workspace trust
--                       defaults surface, not any single employee's file.
--
-- AUTH CONTEXTS for every function in this file (rule: enumerate all three):
--   These are NEW functions. Callers enumerated by grep over supabase/functions,
--   src, pg_proc prosrc and cron.job — ZERO existing callers in any context
--   (the Trust tab UI, drafted separately, will be the only caller: user-JWT
--   context, by design).
--   - user JWT (role=authenticated, uid set): the intended caller. Guards pass
--     for managers/assignees per function.
--   - service-role JWT (role=service_role, uid NULL): no callers exist.
--     list_de_trust_surface would WORK (service_role branch passes the guard
--     and the tenant is derived from the employee row, never from
--     auth_tenant_id() — so no silent-empty, per the Clean Service-Role Rule).
--     seed_de_trust_policy / set_trust_ladder RAISE 'not_authenticated'
--     LOUDLY (auth_tenant_id() is NULL): these are manager-UX writes; a
--     worker should never call them, and if one ever does it gets an error,
--     never an empty success.
--   - direct DB / pg_cron / triggers (role NULL, uid NULL): no callers exist,
--     and every function RAISES (can_access_de=false → exception; or
--     'not_authenticated') — never returns empty. No cron job references any
--     trust function (cron.job checked live 2026-07-27).
--
-- AUDIT CATEGORY: 'config_change' — verified IN the live
-- audit_events_category_check constraint 2026-07-27 (and re-asserted below).
-- The category that nearly broke mig 429 is NOT legal and is not used here.
--
-- KNOWN DOCS-SHAPE CONSEQUENCE (reported, not silently "fixed"): docs/31 keys
-- a single action's trust by its RAW action key. Live data has the same
-- action_key in two categories (create_test_record: crm + product_system), so
-- one raw-key policy governs both; the surface emits one entry per
-- (category, action_key) for correct UI nesting, and colliding keys share one
-- policy/dial. Flagged for the main session to cross-check with the M1/M2
-- drafts.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 0) PRE-FLIGHT: refuse to apply before M1 (this is Migration 3).
-- ─────────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trust_policies'
                    AND column_name = 'ladder') THEN
    RAISE EXCEPTION '460: trust_policies.ladder is missing — apply the M1 unfreeze migration first';
  END IF;
  -- Vocabulary cross-check with M1 (the two files must agree or a stored
  -- ladder silently disables autonomy): the reader trust_ladder_settings must
  -- exist, must DERIVE 'enabled' from the entry mode, and must NOT read a
  -- settings-level 'enabled' key — because validate_trust_ladder below
  -- forbids any settings key except min_confidence / max_amount_cents.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'trust_ladder_settings';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '460: trust_ladder_settings is missing — apply the M1 unfreeze migration first';
  END IF;
  IF v_def LIKE '%->''settings''->>''enabled''%' THEN
    RAISE EXCEPTION '460: trust_ladder_settings reads settings.enabled but this file''s validator forbids that key — the M1/M3 vocabulary has drifted; reconcile before applying';
  END IF;
  -- The shared compile contract: ONLY act_within_limits / act open the dial.
  -- act_with_approval and draft compile CLOSED (the dial has no "requires
  -- approval" bit — a label promising a human confirms first must gate).
  IF v_def NOT LIKE '%in (''act_within_limits'', ''act'')%' THEN
    RAISE EXCEPTION '460: trust_ladder_settings does not compile enabled from exactly (act_within_limits, act) — the M1/M3 fail-closed contract has drifted; reconcile before applying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trust_policies'
                    AND column_name = 'display_name') THEN
    RAISE EXCEPTION '460: trust_policies.display_name is missing — apply the M1 unfreeze migration first';
  END IF;
  -- The two key constraints must be the 458 FORMAT guards, not the frozen
  -- 4-value lists. 458 recreates them under the SAME names, so testing
  -- existence-by-name reports the fix as missing — test the DEFINITION.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.trust_policies'::regclass
                AND conname = 'trust_policies_action_category_check'
                AND pg_get_constraintdef(oid) ILIKE '%ARRAY[%') THEN
    RAISE EXCEPTION '460: trust_policies still carries the 4-value key constraint — apply M1 first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.de_autonomy'::regclass
                AND conname = 'de_autonomy_action_type_check'
                AND pg_get_constraintdef(oid) ILIKE '%ARRAY[%') THEN
    RAISE EXCEPTION '460: de_autonomy still carries the 4-value key constraint — apply M1 first';
  END IF;
  -- The audit category this file writes must be legal in the LIVE constraint.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.audit_events'::regclass
         AND conname = 'audit_events_category_check') NOT LIKE '%config_change%' THEN
    RAISE EXCEPTION '460: audit_events no longer accepts config_change — every write in this file would abort its caller';
  END IF;
  -- Engine pieces this file reuses must exist at the expected arity.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'can_access_de') <> 1 THEN
    RAISE EXCEPTION '460: expected exactly one can_access_de';
  END IF;
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'resolve_de_autonomy') <> 1 THEN
    RAISE EXCEPTION '460: expected exactly one resolve_de_autonomy';
  END IF;
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'trust_apply_level') <> 1 THEN
    RAISE EXCEPTION '460: expected exactly one trust_apply_level';
  END IF;
END $preflight$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) INTERNAL: the surface derivation. Pure config read, no auth of its own —
--    EXECUTE is revoked from every client role below; only the SECURITY
--    DEFINER RPCs in this file (owner-executed) reach it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.de_trust_surface_candidates(p_tenant_id uuid, p_de_id uuid)
RETURNS TABLE(
  capability_key  text,
  kind            text,     -- answer | action_category | action | playbook
  label           text,
  category        text,     -- the connector category an action entry nests under
  dialable        boolean,  -- destructive actions: false — visible, never dial-able
  destructive     boolean,
  uses_confidence boolean,
  uses_amount     boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
WITH me AS (
  SELECT d.id FROM digital_employees d
   WHERE d.id = p_de_id AND d.tenant_id = p_tenant_id
),
-- widget-ask's own eligibility filter, mirrored exactly.
eligible AS (
  SELECT d.id, d.external_reply_mode, d.created_at
    FROM digital_employees d
   WHERE d.tenant_id = p_tenant_id
     AND coalesce(d.lifecycle_status, '') NOT IN ('paused', 'retired', 'archived', 'designed')
),
front AS (  -- the front-DE heuristic: oldest auto-reply DE, else oldest eligible
  SELECT e.id FROM eligible e
   ORDER BY (CASE WHEN e.external_reply_mode = 'auto' THEN 0 ELSE 1 END), e.created_at ASC
   LIMIT 1
),
serves_widget AS (
  SELECT (
    EXISTS (SELECT 1 FROM eligible e WHERE e.id = p_de_id)
    AND (
      EXISTS (SELECT 1 FROM widget_keys wk           -- mig 323: explicit binding wins
               WHERE wk.tenant_id = p_tenant_id AND wk.active AND wk.de_id = p_de_id)
      OR (
        EXISTS (SELECT 1 FROM widget_keys wk         -- a key that falls back to the heuristic
                 WHERE wk.tenant_id = p_tenant_id AND wk.active
                   AND (wk.de_id IS NULL
                        OR NOT EXISTS (SELECT 1 FROM eligible e2 WHERE e2.id = wk.de_id)))
        AND (SELECT f.id FROM front f) = p_de_id
      )
    )
  ) AS yes
),
-- Reachable registered actions: connector-hub's resolveActionDefinition,
-- mirrored (see header for why provider match is not additionally required).
reachable AS (
  SELECT ad.category   AS category,
         ad.action_key AS action_key,
         min(ad.label) AS label,
         bool_or(coalesce((ad.risk ->> 'destructive')::boolean, true)) AS destructive
    FROM action_definitions ad
   WHERE ad.status = 'active'
     AND ad.provider <> 'internal'
     AND (ad.scope = 'platform' OR (ad.scope = 'tenant' AND ad.tenant_id = p_tenant_id))
     AND EXISTS (SELECT 1 FROM connectors c
                  WHERE c.tenant_id = p_tenant_id
                    AND c.status = 'connected'
                    AND c.category = ad.category)
   GROUP BY ad.category, ad.action_key
),
runs_invoice_playbook AS (
  SELECT EXISTS (
    SELECT 1 FROM playbook_definitions pd
     WHERE pd.tenant_id = p_tenant_id
       AND pd.de_id = p_de_id
       AND pd.status = 'published'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(pd.steps) s
                    WHERE s ->> 'key' = 'generate_invoice')
  ) AS yes
)
SELECT 'answer_dock', 'answer', 'Answers in the dock (internal chat)',
       NULL::text, true, false, true, false
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT 'answer_widget', 'answer', 'Answers customers on the public widget & help centre',
       NULL::text, true, false, true, false
 WHERE (SELECT yes FROM serves_widget)
UNION ALL
SELECT 'invoice_auto_send', 'playbook', 'Auto-sends renewal invoices (renewal playbook)',
       NULL::text, true, false, false, true
 WHERE EXISTS (SELECT 1 FROM me) AND (SELECT yes FROM runs_invoice_playbook)
UNION ALL
-- A category is dial-able only while it holds at least one non-destructive
-- action: destructive actions gate above the dial unconditionally, so a dial
-- over an all-destructive category could never do anything — showing it
-- dial-able would oversell. The moment a non-destructive action is registered
-- in the category, this recomputes and the dial appears (measured live:
-- the self-management category is all-destructive by design).
SELECT 'action:' || rc.category, 'action_category',
       initcap(replace(rc.category, '_', ' ')) || ' actions',
       rc.category, rc.has_dialable, false, false, true
  FROM (SELECT r.category, bool_or(NOT r.destructive) AS has_dialable
          FROM reachable r GROUP BY r.category) rc
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT r.action_key, 'action', r.label, r.category,
       NOT r.destructive, r.destructive, false, true
  FROM reachable r
 WHERE EXISTS (SELECT 1 FROM me);
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) INTERNAL: ladder validation. Pure — raises on any violation, returns the
--    number of entries when valid. Factored out so the asserts below can prove
--    the validation BEHAVES, not merely that its text landed.
--    Level vocabulary = M1's trust_ladder_settings: level 0 is the IMPLICIT
--    human-gated floor (never stored); every stored entry carries a REQUIRED
--    integer level, unique within the ladder, 1..p_max_level. Monotonicity is
--    checked in LEVEL order (array order is not significant to the reader).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_trust_ladder(
  p_ladder jsonb, p_uses_confidence boolean, p_uses_amount boolean,
  p_max_level integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_n int; v_e jsonb; v_settings jsonb;
  v_name text; v_mode text;
  v_lvl numeric; v_level int;
  v_seen int[] := '{}';
  v_rank int; v_prev_rank int := 0;  -- the implicit level-0 floor ranks as draft
  v_conf numeric; v_prev_conf numeric := NULL;
  v_amt numeric; v_prev_amt numeric := NULL;
BEGIN
  IF p_max_level IS NULL OR p_max_level < 1 OR p_max_level > 3 THEN
    RAISE EXCEPTION 'max_level must be between 1 and 3, got %', p_max_level;
  END IF;
  IF jsonb_typeof(p_ladder) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ladder must be a JSON array of levels';
  END IF;
  v_n := jsonb_array_length(p_ladder);
  IF v_n < 1 OR v_n > p_max_level THEN
    RAISE EXCEPTION 'a ladder has 1 to % stored levels (level 0 is implicit and always human-gated), got %', p_max_level, v_n;
  END IF;

  -- Pass 1 (array order): shape + the level key. REQUIRED, integer, unique,
  -- 1..p_max_level — reject otherwise. Level 0 is never stored.
  FOR i IN 0 .. v_n - 1 LOOP
    v_e := p_ladder -> i;
    IF jsonb_typeof(v_e) <> 'object' THEN
      RAISE EXCEPTION 'ladder entry %: each level must be an object', i;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_e) k
                WHERE k NOT IN ('level', 'name', 'mode', 'settings')) THEN
      RAISE EXCEPTION 'ladder entry %: unknown field — allowed: level, name, mode, settings', i;
    END IF;
    IF NOT (v_e ? 'level') OR jsonb_typeof(v_e -> 'level') <> 'number' THEN
      RAISE EXCEPTION 'ladder entry %: an explicit integer "level" is required', i;
    END IF;
    v_lvl := (v_e ->> 'level')::numeric;
    IF v_lvl <> trunc(v_lvl) THEN
      RAISE EXCEPTION 'ladder entry %: "level" must be a whole number', i;
    END IF;
    v_level := v_lvl::int;
    IF v_level < 1 OR v_level > p_max_level THEN
      RAISE EXCEPTION 'ladder entry %: "level" must be between 1 and % (level 0 is implicit and always human-gated)', i, p_max_level;
    END IF;
    IF v_level = ANY (v_seen) THEN
      RAISE EXCEPTION 'ladder entry %: duplicate level % — each level may be defined once', i, v_level;
    END IF;
    v_seen := v_seen || v_level;
  END LOOP;

  -- Pass 2 (LEVEL order): names, modes and monotonicity — modes never narrow
  -- and limits only widen as levels rise.
  FOR v_e IN
    SELECT e.entry FROM jsonb_array_elements(p_ladder) e(entry)
    ORDER BY (e.entry ->> 'level')::integer
  LOOP
    v_level := (v_e ->> 'level')::integer;

    v_name := trim(coalesce(v_e ->> 'name', ''));
    IF v_name = '' OR length(v_name) > 80 THEN
      RAISE EXCEPTION 'ladder level %: a name of 1-80 characters is required', v_level;
    END IF;

    v_mode := v_e ->> 'mode';
    IF v_mode IS NULL
       OR v_mode NOT IN ('draft', 'act_with_approval', 'act_within_limits', 'act') THEN
      RAISE EXCEPTION 'ladder level %: mode must be draft, act_with_approval, act_within_limits or act', v_level;
    END IF;
    v_rank := CASE v_mode WHEN 'draft' THEN 0 WHEN 'act_with_approval' THEN 1
                          WHEN 'act_within_limits' THEN 2 ELSE 3 END;
    IF v_rank < v_prev_rank THEN
      RAISE EXCEPTION 'ladder level %: modes must not narrow as levels rise', v_level;
    END IF;
    v_prev_rank := v_rank;

    v_settings := coalesce(v_e -> 'settings', '{}'::jsonb);
    IF jsonb_typeof(v_settings) <> 'object' THEN
      RAISE EXCEPTION 'ladder level %: settings must be an object', v_level;
    END IF;
    -- Only fields this capability's enforcement actually reads may be set.
    -- ('enabled' is never a settings key — it is derived from the mode by
    -- trust_ladder_settings, the M1 reader.)
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_settings) k
                WHERE NOT (k = 'min_confidence'   AND p_uses_confidence)
                  AND NOT (k = 'max_amount_cents' AND p_uses_amount)) THEN
      RAISE EXCEPTION 'ladder level %: settings may only carry the field(s) this capability enforces (%)',
        v_level, concat_ws(', ',
              CASE WHEN p_uses_confidence THEN 'min_confidence' END,
              CASE WHEN p_uses_amount     THEN 'max_amount_cents' END);
    END IF;
    IF v_mode IN ('draft', 'act_with_approval') AND v_settings <> '{}'::jsonb THEN
      RAISE EXCEPTION 'ladder level %: % levels take no settings — nothing executes without a human there', v_level, v_mode;
    END IF;
    IF v_mode = 'act_within_limits' AND v_settings = '{}'::jsonb THEN
      RAISE EXCEPTION 'ladder level %: act_within_limits requires at least one limit', v_level;
    END IF;

    IF v_settings ? 'min_confidence' THEN
      IF jsonb_typeof(v_settings -> 'min_confidence') <> 'number' THEN
        RAISE EXCEPTION 'ladder level %: min_confidence must be a number', v_level;
      END IF;
      v_conf := (v_settings ->> 'min_confidence')::numeric;
      IF v_conf <> trunc(v_conf) OR v_conf < 0 OR v_conf > 100 THEN
        RAISE EXCEPTION 'ladder level %: min_confidence must be a whole number between 0 and 100', v_level;
      END IF;
      IF v_prev_conf IS NOT NULL AND v_conf > v_prev_conf THEN
        RAISE EXCEPTION 'ladder level %: confidence floors must not RISE with level — higher trust means a lower floor', v_level;
      END IF;
      v_prev_conf := v_conf;
    END IF;

    IF v_settings ? 'max_amount_cents' THEN
      IF jsonb_typeof(v_settings -> 'max_amount_cents') <> 'number' THEN
        RAISE EXCEPTION 'ladder level %: max_amount_cents must be a number', v_level;
      END IF;
      v_amt := (v_settings ->> 'max_amount_cents')::numeric;
      IF v_amt <> trunc(v_amt) OR v_amt <= 0 THEN
        RAISE EXCEPTION 'ladder level %: max_amount_cents must be a whole number above zero', v_level;
      END IF;
      IF v_prev_amt IS NOT NULL AND v_amt < v_prev_amt THEN
        RAISE EXCEPTION 'ladder level %: amount caps must not SHRINK with level — higher trust means a higher cap', v_level;
      END IF;
      v_prev_amt := v_amt;
    END IF;
  END LOOP;

  RETURN v_n;
END $$;

-- Rule 5: this file changes the drafted validator's signature (a 4th
-- p_max_level parameter). Drop the 3-arg arity if any earlier draft of this
-- migration left it behind; the assert block proves exactly one remains.
DROP FUNCTION IF EXISTS public.validate_trust_ladder(jsonb, boolean, boolean);

-- ─────────────────────────────────────────────────────────────────────────
-- 3) list_de_trust_surface — the Trust tab reader.
--    Guard: mig-431 idiom — service_role passes; otherwise the employee must
--    belong to the caller's workspace AND can_access_de must grant it.
--    Refuses with an ERROR, never an empty list (a guard that silently
--    empties a context is the house's nastiest failure shape).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_de_trust_surface(p_de_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_out jsonb;
BEGIN
  -- Tenant comes from the employee row, never from auth_tenant_id(): a
  -- service-role caller has no tenant claim and must not get a silent empty.
  SELECT d.tenant_id INTO v_tenant FROM digital_employees d WHERE d.id = p_de_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'digital employee not found';
  END IF;

  IF NOT (
       coalesce(auth.role(), '') = 'service_role'
    OR is_platform_admin()
    OR (v_tenant = auth_tenant_id() AND can_access_de(p_de_id))
  ) THEN
    RAISE EXCEPTION 'insufficient_permission: you are not assigned to this digital employee';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'capability_key', c.capability_key,
             'label',          c.label,
             'kind',           c.kind,
             'category',       c.category,
             'dialable',       c.dialable,
             'destructive',    c.destructive,
             'enforcement',    jsonb_build_object(
                                 'uses_confidence', c.uses_confidence,
                                 'uses_amount',     c.uses_amount),
             -- The most specific policy: this employee's own row first, else
             -- the workspace-wide row (both with no category qualifier —
             -- matching the seeded shapes).
             'policy', (SELECT to_jsonb(tp) FROM trust_policies tp
                         WHERE tp.tenant_id = v_tenant
                           AND tp.action_category = c.capability_key
                           AND tp.source_category IS NULL
                           AND (tp.de_id = p_de_id OR tp.de_id IS NULL)
                         ORDER BY (tp.de_id = p_de_id) DESC NULLS LAST
                         LIMIT 1),
             -- The enforcement truth for this employee, from the one resolver
             -- every gate uses. NULL for destructive entries: the destructive
             -- gate sits above the dial, so showing a dial there would lie.
             'dial', CASE WHEN c.dialable THEN
                       (SELECT to_jsonb(r)
                          FROM resolve_de_autonomy(v_tenant, c.capability_key, p_de_id, NULL) r)
                     ELSE NULL END
           )
           ORDER BY CASE c.kind WHEN 'answer' THEN 0 WHEN 'playbook' THEN 1
                                WHEN 'action_category' THEN 2 ELSE 3 END,
                    c.category NULLS FIRST,
                    c.capability_key
         ), '[]'::jsonb)
    INTO v_out
    FROM de_trust_surface_candidates(v_tenant, p_de_id) c;

  RETURN v_out;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) seed_de_trust_policy — idempotent, level-0, on-demand (the UI seeds
--    lazily per missing surface item; this replaces the broken empty-panel
--    seeding). Gate: manager+ (set_de_assignment's idiom — one step below
--    the owner/admin gate mig 441 put on the WORKSPACE-wide seeder, because
--    this row governs one employee the caller manages, not the whole
--    workspace) AND can_access_de — both axes (docs/29): role tier plus the
--    DE reporting line, exactly matching set_trust_ladder's per-employee
--    branch. Refuses capabilities that are not on this employee's
--    surface, and destructive actions (never dial-able → never a policy).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.seed_de_trust_policy(
  p_de_id uuid, p_capability_key text, p_display_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_cand record;
  v_id uuid;
  v_row trust_policies;
  v_new boolean;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT (is_platform_admin()
          OR auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
    RAISE EXCEPTION 'insufficient_permission: seeding a trust policy requires a manager';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees d
                  WHERE d.id = p_de_id AND d.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'that digital employee does not belong to this workspace';
  END IF;
  -- Second axis (docs/29): the role tier alone is not enough — the caller
  -- must also sit on this employee's reporting line. Identical to
  -- set_trust_ladder's per-employee branch.
  IF NOT can_access_de(p_de_id) THEN
    RAISE EXCEPTION 'insufficient_permission: you are not assigned to this digital employee';
  END IF;

  SELECT * INTO v_cand
    FROM de_trust_surface_candidates(v_tenant, p_de_id) c
   WHERE c.capability_key = p_capability_key
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability "%" is not on this employee''s trust surface', p_capability_key;
  END IF;
  IF NOT v_cand.dialable THEN
    RAISE EXCEPTION 'capability "%" always requires human approval — it cannot carry a trust policy', p_capability_key;
  END IF;

  INSERT INTO trust_policies (tenant_id, de_id, action_category, display_name)
  VALUES (v_tenant, p_de_id, p_capability_key, nullif(trim(coalesce(p_display_name, '')), ''))
  ON CONFLICT (tenant_id, action_category, coalesce(source_category, ''), coalesce(de_id::text, ''))
  DO UPDATE SET
    -- Idempotent: an existing policy keeps everything; a missing display name
    -- may be filled in, never overwritten.
    display_name = coalesce(trust_policies.display_name, excluded.display_name),
    updated_at   = now()
  -- Scalar targets only (the set_de_assignment idiom): RETURNING a composite
  -- plus a scalar into mixed targets is not a supported plpgsql shape.
  RETURNING id, (xmax = 0) INTO v_id, v_new;
  SELECT * INTO v_row FROM trust_policies WHERE id = v_id;

  -- Record only genuine creation (idempotent re-calls stay silent). AFTER the
  -- write: an event claiming a change that then failed is worse than no event.
  IF v_new THEN
    PERFORM append_audit_event(
      v_tenant,
      coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'A manager'),
      'human',
      format('Created a level-0 trust policy for "%s" on a digital employee', p_capability_key),
      'config_change',
      jsonb_build_object('kind', 'trust_policy_seeded', 'policy_id', v_row.id,
                         'de_id', p_de_id, 'capability_key', p_capability_key,
                         'seeded_by', auth.uid()));
  END IF;

  RETURN to_jsonb(v_row);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5) set_trust_ladder — the manager's customization write.
--    Clearing is an EXPLICIT flag, never an in-band jsonb sentinel:
--    PostgREST maps a JSON null argument to SQL NULL for jsonb parameters,
--    so "p_ladder: null from the UI" is indistinguishable from "omitted" —
--    a jsonb-'null'-means-clear contract would make Reset a silent no-op.
--    p_clear_ladder := true  → ladder := NULL (back to the engine's built-in
--                              level rewards); p_ladder is IGNORED;
--                              display_name still follows p_display_name.
--    p_clear_ladder := false → p_ladder SQL NULL   → ladder left unchanged
--                              p_ladder jsonb array → validated and stored
--                              (a direct-SQL jsonb 'null' also clears, kept
--                               as a belt for non-PostgREST callers).
--    Gates: workspace-wide policy (de_id NULL) → owner/admin (mig 441
--    parity: that ladder governs every employee). Per-employee policy →
--    manager+ AND can_access_de. Audit: 'config_change' (verified legal).
-- ─────────────────────────────────────────────────────────────────────────
-- Rule 5: the drafted signature grew p_clear_ladder. Drop the 4-arg arity if
-- any earlier draft of this migration left it behind; the assert block
-- proves exactly one definition remains.
DROP FUNCTION IF EXISTS public.set_trust_ladder(uuid, jsonb, text, jsonb);

CREATE OR REPLACE FUNCTION public.set_trust_ladder(
  p_policy_id uuid, p_ladder jsonb,
  p_display_name text DEFAULT NULL, p_criteria jsonb DEFAULT NULL,
  p_clear_ladder boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_pol trust_policies;
  v_uses_conf boolean;
  v_uses_amt boolean;
  v_levels int := NULL;
  v_clear boolean := false;
  v_k text; v_v jsonb; v_num numeric;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_pol FROM trust_policies WHERE id = p_policy_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trust policy not found'; END IF;
  -- Same message as not-found: never confirm a foreign policy id exists.
  IF v_pol.tenant_id <> v_tenant AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'trust policy not found';
  END IF;

  IF v_pol.de_id IS NULL THEN
    IF NOT (is_platform_admin()
            OR auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin'])) THEN
      RAISE EXCEPTION 'insufficient_permission: the workspace-wide ladder requires an owner or admin';
    END IF;
  ELSE
    IF NOT (is_platform_admin()
            OR auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])) THEN
      RAISE EXCEPTION 'insufficient_permission: customizing a trust ladder requires a manager';
    END IF;
    IF NOT can_access_de(v_pol.de_id) THEN
      RAISE EXCEPTION 'insufficient_permission: you are not assigned to this digital employee';
    END IF;
  END IF;

  -- Enforcement flags follow the capability key (see header: measured live).
  v_uses_conf := v_pol.action_category IN ('answer_dock', 'answer_widget');
  v_uses_amt  := NOT v_uses_conf;

  IF coalesce(p_clear_ladder, false) THEN
    -- Explicit reset: p_ladder is ignored entirely (see header — PostgREST
    -- cannot deliver an in-band jsonb 'null', so the flag is the only
    -- reliable clear path from the UI).
    v_clear := true;
  ELSIF p_ladder IS NOT NULL THEN
    IF jsonb_typeof(p_ladder) = 'null' THEN
      v_clear := true;  -- direct-SQL belt; unreachable via PostgREST
    ELSE
      v_levels := validate_trust_ladder(p_ladder, v_uses_conf, v_uses_amt,
                                        coalesce(v_pol.max_level, 3));
    END IF;
  END IF;

  IF p_criteria IS NOT NULL THEN
    IF jsonb_typeof(p_criteria) <> 'object' THEN
      RAISE EXCEPTION 'criteria must be an object';
    END IF;
    FOR v_k, v_v IN SELECT key, value FROM jsonb_each(p_criteria) LOOP
      IF v_k NOT IN ('window_days', 'min_eval_samples', 'min_human_samples',
                     'min_eval_pass_rate', 'max_guardrail_blocks', 'min_human_approval_rate') THEN
        RAISE EXCEPTION 'criteria field "%" is not part of the evidence contract', v_k;
      END IF;
      IF jsonb_typeof(v_v) <> 'number' THEN
        RAISE EXCEPTION 'criteria field "%" must be a number', v_k;
      END IF;
      v_num := (p_criteria ->> v_k)::numeric;
      IF v_k = 'window_days' AND (v_num <> trunc(v_num) OR v_num < 1 OR v_num > 365) THEN
        RAISE EXCEPTION 'window_days must be a whole number of days between 1 and 365';
      ELSIF v_k IN ('min_eval_samples', 'min_human_samples', 'max_guardrail_blocks')
            AND (v_num <> trunc(v_num) OR v_num < 0 OR v_num > 100000) THEN
        RAISE EXCEPTION '% must be a whole number of at least 0', v_k;
      ELSIF v_k IN ('min_eval_pass_rate', 'min_human_approval_rate')
            AND (v_num < 0 OR v_num > 1) THEN
        RAISE EXCEPTION '% is a fraction between 0 and 1', v_k;
      END IF;
    END LOOP;
  END IF;

  UPDATE trust_policies SET
    ladder       = CASE WHEN v_clear THEN NULL
                        WHEN p_ladder IS NULL THEN ladder
                        ELSE p_ladder END,
    display_name = coalesce(nullif(trim(coalesce(p_display_name, '')), ''), display_name),
    criteria     = coalesce(p_criteria, criteria),
    updated_at   = now()
  WHERE id = p_policy_id
  RETURNING * INTO v_pol;

  -- An already-EARNED level must keep meaning what the (new) ladder says:
  -- re-apply through the engine's own writer so the enforced dial row stays
  -- in step. Level 0 is never re-applied — writing an explicit disabled row
  -- where none exists would SHADOW a wider workspace row in the resolver's
  -- cascade and silently narrow behaviour.
  IF v_pol.current_level > 0 AND (v_clear OR v_levels IS NOT NULL) THEN
    PERFORM trust_apply_level(v_pol.tenant_id, v_pol.action_category,
                              v_pol.current_level, auth.uid(),
                              v_pol.source_category, v_pol.de_id);
  END IF;

  PERFORM append_audit_event(
    v_pol.tenant_id,
    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'A manager'),
    'human',
    format('Customized the trust ladder for "%s"%s',
           coalesce(v_pol.display_name, v_pol.action_category),
           CASE WHEN v_clear THEN ' — reset to the built-in levels'
                WHEN v_levels IS NOT NULL THEN format(' — %s custom level(s)', v_levels)
                ELSE ' — settings only' END),
    'config_change',
    jsonb_build_object('kind', 'trust_ladder_set', 'policy_id', v_pol.id,
                       'de_id', v_pol.de_id, 'capability_key', v_pol.action_category,
                       'levels', v_levels, 'ladder_reset', v_clear,
                       'criteria_changed', p_criteria IS NOT NULL,
                       'display_name_changed', p_display_name IS NOT NULL,
                       'current_level', v_pol.current_level,
                       'changed_by', auth.uid()));

  RETURN to_jsonb(v_pol);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6) GRANTS. Supabase default privileges pre-grant EXECUTE broadly on new
--    functions — strip PUBLIC explicitly (anon/authenticated are members of
--    PUBLIC; revoking anon alone is a silent no-op, the mig-361 lesson).
--    The two internal helpers are reachable by NO client role at all — only
--    the SECURITY DEFINER RPCs above (executing as the function owner) call
--    them.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON ROUTINE public.de_trust_surface_candidates(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ROUTINE public.validate_trust_ladder(jsonb, boolean, boolean, integer) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON ROUTINE public.list_de_trust_surface(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.list_de_trust_surface(uuid) TO authenticated, service_role;

REVOKE ALL ON ROUTINE public.seed_de_trust_policy(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.seed_de_trust_policy(uuid, text, text) TO authenticated;

REVOKE ALL ON ROUTINE public.set_trust_ladder(uuid, jsonb, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.set_trust_ladder(uuid, jsonb, text, jsonb, boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 7) ASSERTS — the change LANDED, behaves, and nothing is double-defined.
-- ─────────────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_def text; v_n int; v_de uuid; v_tenant uuid; v_msg text;
BEGIN
  -- Exactly one definition per name (no accidental overloads: rule 5).
  FOREACH v_msg IN ARRAY ARRAY['de_trust_surface_candidates', 'validate_trust_ladder',
                               'list_de_trust_surface', 'seed_de_trust_policy', 'set_trust_ladder'] LOOP
    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = v_msg;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '460: expected exactly 1 definition of %, found %', v_msg, v_n;
    END IF;
  END LOOP;

  -- The reader carries the guard and derives tenant from the employee row.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_trust_surface';
  v_n := (length(v_def) - length(replace(v_def, 'can_access_de(', ''))) / length('can_access_de(');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '460: list_de_trust_surface must call can_access_de exactly once, found %', v_n;
  END IF;
  IF v_def NOT LIKE '%= ''service_role''%' THEN
    RAISE EXCEPTION '460: list_de_trust_surface lost the service-role passthrough';
  END IF;
  IF v_def NOT LIKE '%auth_tenant_id()%' THEN
    RAISE EXCEPTION '460: list_de_trust_surface lost the tenant gate';
  END IF;
  IF v_def NOT LIKE '%de_trust_surface_candidates%' THEN
    RAISE EXCEPTION '460: list_de_trust_surface no longer derives from the surface helper';
  END IF;
  IF v_def NOT LIKE '%resolve_de_autonomy%' THEN
    RAISE EXCEPTION '460: list_de_trust_surface no longer reports the enforcement truth (the resolver)';
  END IF;

  -- The writer validates, audits with the verified-legal category, and
  -- re-syncs earned levels through the engine's own writer.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_trust_ladder';
  IF v_def NOT LIKE '%validate_trust_ladder%' THEN
    RAISE EXCEPTION '460: set_trust_ladder does not validate the ladder';
  END IF;
  IF v_def NOT LIKE '%''config_change''%' THEN
    RAISE EXCEPTION '460: set_trust_ladder lost its audit event (category config_change)';
  END IF;
  IF v_def NOT LIKE '%trust_apply_level%' THEN
    RAISE EXCEPTION '460: set_trust_ladder no longer re-syncs an earned level through the engine';
  END IF;
  IF v_def NOT LIKE '%p_clear_ladder%' THEN
    RAISE EXCEPTION '460: set_trust_ladder lost the explicit clear flag — Reset from the UI would be a silent no-op';
  END IF;

  -- The seeder is idempotent on the live unique index and gated on BOTH axes
  -- (role tier + the DE reporting line, docs/29).
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'seed_de_trust_policy';
  IF v_def NOT LIKE '%ON CONFLICT%' THEN
    RAISE EXCEPTION '460: seed_de_trust_policy is not idempotent';
  END IF;
  IF v_def NOT LIKE '%tenant_manager%' THEN
    RAISE EXCEPTION '460: seed_de_trust_policy lost the manager gate';
  END IF;
  IF v_def NOT LIKE '%can_access_de(p_de_id)%' THEN
    RAISE EXCEPTION '460: seed_de_trust_policy lost the reporting-line axis (can_access_de)';
  END IF;

  -- Grants: internet-facing roles hold nothing they should not.
  IF has_function_privilege('anon', 'public.list_de_trust_surface(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.seed_de_trust_policy(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_trust_ladder(uuid, jsonb, text, jsonb, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.de_trust_surface_candidates(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.validate_trust_ladder(jsonb, boolean, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '460: anon holds EXECUTE on a trust RPC';
  END IF;
  IF has_function_privilege('authenticated', 'public.de_trust_surface_candidates(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_trust_ladder(jsonb, boolean, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '460: authenticated can call an internal trust helper directly';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.list_de_trust_surface(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.seed_de_trust_policy(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_trust_ladder(uuid, jsonb, text, jsonb, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '460: authenticated lost EXECUTE on a trust RPC the UI needs';
  END IF;

  -- ── BEHAVIOUR: the ladder validator actually validates (level vocabulary
  --    = M1's reader: stored entries are levels 1..max_level, level REQUIRED,
  --    unique; level 0 is implicit and never stored). ──
  IF validate_trust_ladder(
       '[{"level":1,"name":"Assisted","mode":"act_with_approval"},
         {"level":2,"name":"Bounded","mode":"act_within_limits","settings":{"max_amount_cents":100000}},
         {"level":3,"name":"Trusted","mode":"act","settings":{"max_amount_cents":500000}}]'::jsonb,
       false, true, 3) <> 3 THEN
    RAISE EXCEPTION '460: a well-formed amount ladder was rejected';
  END IF;
  -- Array order is NOT significant — monotonicity is checked in LEVEL order.
  IF validate_trust_ladder(
       '[{"level":3,"name":"Wide","mode":"act_within_limits","settings":{"max_amount_cents":500000}},
         {"level":1,"name":"Narrow","mode":"act_within_limits","settings":{"max_amount_cents":100000}}]'::jsonb,
       false, true, 3) <> 2 THEN
    RAISE EXCEPTION '460: a valid out-of-array-order ladder was rejected';
  END IF;
  BEGIN
    PERFORM validate_trust_ladder('[{"level":0,"name":"Floor","mode":"draft"}]'::jsonb, false, true, 3);
    RAISE EXCEPTION '460: a stored level-0 entry was ACCEPTED (level 0 is implicit, never stored)';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;  -- our own assert falling through
  END;
  BEGIN
    PERFORM validate_trust_ladder('[{"name":"NoLevel","mode":"draft"}]'::jsonb, false, true, 3);
    RAISE EXCEPTION '460: an entry with NO level key was ACCEPTED (level is required)';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM validate_trust_ladder(
      '[{"level":1,"name":"A","mode":"draft"},
        {"level":1,"name":"B","mode":"act_with_approval"}]'::jsonb, false, true, 3);
    RAISE EXCEPTION '460: a duplicate level was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM validate_trust_ladder(
      '[{"level":1,"name":"A","mode":"draft"},
        {"level":3,"name":"B","mode":"act_with_approval"}]'::jsonb, false, true, 2);
    RAISE EXCEPTION '460: a level above max_level was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM validate_trust_ladder(
      '[{"level":1,"name":"A","mode":"act_within_limits","settings":{"max_amount_cents":500000}},
        {"level":2,"name":"B","mode":"act_within_limits","settings":{"max_amount_cents":100000}}]'::jsonb,
      false, true, 3);
    RAISE EXCEPTION '460: a ladder whose amount cap SHRINKS with level was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM validate_trust_ladder(
      '[{"level":1,"name":"A","mode":"act_within_limits","settings":{"min_confidence":90}}]'::jsonb,
      false, true, 3);  -- amount capability: a confidence floor is not enforced there
    RAISE EXCEPTION '460: a setting the capability does not enforce was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM validate_trust_ladder(
      '[{"level":1,"name":"A","mode":"act_within_limits","settings":{"min_confidence":60}},
        {"level":2,"name":"B","mode":"act_within_limits","settings":{"min_confidence":90}}]'::jsonb,
      true, false, 3);
    RAISE EXCEPTION '460: a ladder whose confidence floor RISES with level was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;

  -- ── BEHAVIOUR: the guards refuse this migration runner (postgres has no
  --    JWT, is not service_role, sits in no workspace) with an ERROR — never
  --    an empty result. Uses a real employee when one exists. ──
  SELECT d.id, d.tenant_id INTO v_de, v_tenant
    FROM digital_employees d LIMIT 1;
  IF v_de IS NOT NULL THEN
    BEGIN
      PERFORM list_de_trust_surface(v_de);
      RAISE EXCEPTION '460: an unauthenticated caller read a trust surface (guard did not fire)';
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM seed_de_trust_policy(v_de, 'answer_dock', NULL);
      RAISE EXCEPTION '460: an unauthenticated caller seeded a trust policy (guard did not fire)';
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
    END;
    -- The derivation itself works and every employee has the always-on entry.
    SELECT count(*) INTO v_n
      FROM de_trust_surface_candidates(v_tenant, v_de) c
     WHERE c.capability_key = 'answer_dock';
    IF v_n <> 1 THEN
      RAISE EXCEPTION '460: surface derivation lost the always-present dock entry (got %)', v_n;
    END IF;
  END IF;
  BEGIN
    PERFORM set_trust_ladder('00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL);
    RAISE EXCEPTION '460: an unauthenticated caller reached set_trust_ladder (guard did not fire)';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '460:%' THEN RAISE; END IF;
  END;

  RAISE NOTICE '460: trust surface backend landed — reader, lazy seeder and ladder writer live; enforcement order untouched.';
END $assert$;

NOTIFY pgrst, 'reload schema';
