-- 458_trust_ladder_as_data.sql
-- ============================================================================
-- TRUST PROGRAM mig 1 of N (docs/31 Q7, Architecture B — founder-approved).
-- "Unfreeze the key axis + make level rewards data" — ZERO behavior change.
--
-- Three moves, none of which alters what any of the 116 DEs may do today:
--
--   (a) The two 4-value CHECK constraints that froze the trust vocabulary
--       (de_autonomy.action_type, trust_policies.action_category) become a
--       format check: lowercase key text, <= 120 chars. The legacy four stay
--       valid; 'action:<category>' (a whole action_definitions category) and
--       raw action keys (one specific registered action) become representable.
--       The unique indexes on both tables are expression indexes over TEXT
--       columns (verified live: de_autonomy_tenant_action_category_de_uq,
--       trust_policies_tenant_category_action_de_uq) — they support any key
--       value with no change.
--
--   (b) trust_policies grows: ladder jsonb (per-policy level definitions),
--       display_name text, max_level int (1..3, default 3 = today's cap).
--       Ladder shape: array of
--         { level int (REQUIRED, 1..max_level, unique), name text,
--           mode text in (draft, act_with_approval, act_within_limits, act),
--           settings { max_amount_cents bigint|null, min_confidence int|null } }
--       'enabled' is NEVER stored: it is DERIVED from the entry's mode
--       (draft / act_with_approval -> false; act_within_limits / act -> true).
--       This vocabulary is shared verbatim with validate_trust_ladder in the
--       surface-backend migration (M3), which forbids any settings key except
--       min_confidence / max_amount_cents — M3 cross-asserts against this
--       function's compiled body at apply time.
--       Level 0 is implicit and always human-gated — never stored.
--       ladder NULL (all 38 live policies on day one) = EXACTLY today's
--       hardcoded rewards.
--
--   (c) trust_ladder_settings(policy, level): the single lookup the engine
--       reads level rewards through from now on. NULL ladder -> delegates to
--       the untouched immutable trust_level_settings, byte-identical.
--
--   (d) trust_apply_level and apply_trust_promotion are spliced (441-style,
--       from their LIVE bodies) to route through (c). trust_demote inlines no
--       settings lookup (verified live 2026-07-27) — untouched.
--
-- ORDER OF AUTHORITY IS UNCHANGED: guardrails, destructive-always-gates and
-- spend caps sit ABOVE the dial in every enforcement path
-- (decide_action_execution steps 0/1/1.5/1.6 run before the dial is ever
-- consulted). Nothing in this file touches that composition.
--
-- Auth contexts of the two edited functions (all verified live):
--   * apply_trust_promotion — user JWT (src/lib/trustApi.ts rpc), and
--     service_role (its own auth.role() branch). Direct-DB: none (no trigger,
--     no cron, no pg fn calls it). The splice adds no auth reads.
--   * trust_apply_level — called only by apply_trust_promotion (above) and by
--     trust_demote, which fires from triggers trust_eval_regression
--     (eval_runs) and trust_guardrail_block (audit_events) — DIRECT-DB
--     context: role NULL, uid NULL, including inserts made by pg_cron paths
--     (eval-run-driver, de-governance-sweep). The new policy lookup reads
--     only its parameters; no auth function is consulted, so all three
--     contexts pass through exactly as before. When no policy row exists at
--     the exact scope it falls back to the legacy immutable defaults — it can
--     never return empty and never raises where it did not before.
-- ============================================================================

-- ── (a) Unfreeze the key axis ───────────────────────────────────────────────
-- Note on the key format: written with '-' last inside the bracket. Proven
-- live equivalent to the design doc's escaped form under Postgres ARE
-- semantics (chr(92) is rejected by both spellings).

DO $keys$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.de_autonomy'::regclass AND conname = 'de_autonomy_action_type_check';
  IF v_def LIKE '%^[a-z0-9\_:.-]+$%' THEN
    RAISE NOTICE 'trust-mig-1: de_autonomy.action_type already unfrozen';
  ELSIF v_def LIKE '%ANY (ARRAY%' THEN
    ALTER TABLE public.de_autonomy DROP CONSTRAINT de_autonomy_action_type_check;
    ALTER TABLE public.de_autonomy ADD CONSTRAINT de_autonomy_action_type_check
      CHECK (action_type ~ '^[a-z0-9_:.-]+$' AND length(action_type) <= 120);
  ELSE
    RAISE EXCEPTION 'trust-mig-1: de_autonomy_action_type_check has drifted from the verified live shape: %', coalesce(v_def, '(missing)');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.trust_policies'::regclass AND conname = 'trust_policies_action_category_check';
  IF v_def LIKE '%^[a-z0-9\_:.-]+$%' THEN
    RAISE NOTICE 'trust-mig-1: trust_policies.action_category already unfrozen';
  ELSIF v_def LIKE '%ANY (ARRAY%' THEN
    ALTER TABLE public.trust_policies DROP CONSTRAINT trust_policies_action_category_check;
    ALTER TABLE public.trust_policies ADD CONSTRAINT trust_policies_action_category_check
      CHECK (action_category ~ '^[a-z0-9_:.-]+$' AND length(action_category) <= 120);
  ELSE
    RAISE EXCEPTION 'trust-mig-1: trust_policies_action_category_check has drifted from the verified live shape: %', coalesce(v_def, '(missing)');
  END IF;
END $keys$;

-- ── (b) Ladder-as-data columns ──────────────────────────────────────────────

ALTER TABLE public.trust_policies
  ADD COLUMN IF NOT EXISTS ladder jsonb,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS max_level integer NOT NULL DEFAULT 3;

DO $cols$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trust_policies'::regclass
                    AND conname = 'trust_policies_max_level_check') THEN
    ALTER TABLE public.trust_policies ADD CONSTRAINT trust_policies_max_level_check
      CHECK (max_level BETWEEN 1 AND 3);
  END IF;
  -- Shape floor only: a ladder, when present, is a json ARRAY. Entry-level
  -- validation (level int, mode vocabulary, settings types) belongs to the
  -- writer RPC in a later migration of this program — a CHECK cannot express
  -- it without an immutable helper, and no writer exists yet.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trust_policies'::regclass
                    AND conname = 'trust_policies_ladder_is_array') THEN
    ALTER TABLE public.trust_policies ADD CONSTRAINT trust_policies_ladder_is_array
      CHECK (ladder IS NULL OR jsonb_typeof(ladder) = 'array');
  END IF;
END $cols$;

-- ── (c) The one lookup for level rewards ────────────────────────────────────
-- Pure over its inputs (no table reads, no auth reads) — provable in-migration
-- against the legacy function. Callers must pass a real trust_policies row;
-- a NULL row degrades to the legacy category defaults, same as before this
-- program existed.
--
-- Ladder semantics: level <= 0 is the implicit human-gated floor. Otherwise
-- the highest defined entry at or below least(level, max_level) wins —
-- mirroring the legacy arrays' least(level, 3) clamp. A ladder with no entry
-- at or below the requested level yields the disabled floor: an undefined
-- level never grants anything.
--
-- 'enabled' is DERIVED from the winning entry's MODE (never read from
-- settings — the M3 validator forbids an 'enabled' settings key, so reading
-- it here would silently disable every custom ladder):
--   draft / act_with_approval                 -> false (a human approves first)
--   act_within_limits / act                   -> true
-- An unknown or missing mode fails CLOSED (false).
-- act_with_approval compiles CLOSED deliberately: the dial vocabulary has no
-- "requires approval" bit — enabled=true IS acting. A mode whose label
-- promises a person confirms first must gate, or the label lies. The dial
-- distinction between draft and act_with_approval is presentational (what the
-- employee prepares), not an autonomy grant; both route through a human.

CREATE OR REPLACE FUNCTION public.trust_ladder_settings(p_policy public.trust_policies, p_level integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  select case
    when p_level <= 0 then jsonb_build_object('enabled', false, 'max_amount_cents', null, 'min_confidence', null)
    when p_policy.ladder is null then public.trust_level_settings(p_policy.action_category, p_level)
    else coalesce(
      (
        select jsonb_build_object(
          'enabled',          coalesce((e.entry->>'mode') in ('act_within_limits', 'act'), false),
          'max_amount_cents', nullif(e.entry->'settings'->>'max_amount_cents', '')::bigint,
          'min_confidence',   nullif(e.entry->'settings'->>'min_confidence', '')::integer)
        from jsonb_array_elements(p_policy.ladder) e(entry)
        where (e.entry->>'level')::integer <= least(p_level, coalesce(p_policy.max_level, 3))
        order by (e.entry->>'level')::integer desc
        limit 1
      ),
      jsonb_build_object('enabled', false, 'max_amount_cents', null, 'min_confidence', null))
  end;
$function$;

-- Mirrors trust_level_settings' ACL (pure function, PUBLIC-executable; it can
-- read nothing a caller does not already hold in hand).

-- ── (d1) trust_apply_level routes through the ladder ────────────────────────
-- 441-style splice of the LIVE body (read 2026-07-27): only the settings
-- lookup changes; the upsert into de_autonomy stays byte-identical.

DO $patch_apply$
DECLARE
  v_src text; v_new text; v_eol text; a_anchor text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'trust_apply_level';
  IF v_src IS NULL THEN RAISE EXCEPTION 'trust-mig-1: trust_apply_level not found'; END IF;
  IF v_src ILIKE '%trust_ladder_settings%' THEN
    RAISE NOTICE 'trust-mig-1: trust_apply_level already routes through the ladder'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  a_anchor := array_to_string(ARRAY[
    'declare',
    '  v_s jsonb := trust_level_settings(p_category, p_level);',
    'begin'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected 1 settings-lookup anchor in trust_apply_level, found %', v_hits; END IF;

  v_new := replace(v_src, a_anchor, array_to_string(ARRAY[
    'declare',
    '  v_policy trust_policies;',
    '  v_s jsonb;',
    'begin',
    '  -- Ladder-as-data (trust program mig 1): when the exact-scope policy',
    '  -- carries a configured ladder its per-level settings drive the dial;',
    '  -- a policy without one — and a scope with no policy row at all — takes',
    '  -- the same immutable defaults as always. No auth context is read here:',
    '  -- promotion (user/service) and demotion (trigger, no auth) pass',
    '  -- through unchanged.',
    '  select * into v_policy from trust_policies',
    '  where tenant_id = p_tenant_id and action_category = p_category',
    '    and source_category is not distinct from p_source_category',
    '    and de_id is not distinct from p_de_id',
    '  limit 1;',
    '  if found then',
    '    v_s := trust_ladder_settings(v_policy, p_level);',
    '  else',
    '    v_s := trust_level_settings(p_category, p_level);',
    '  end if;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION 'trust-mig-1: trust_apply_level edit did not land'; END IF;
  EXECUTE v_new;
END $patch_apply$;

-- ── (d2) apply_trust_promotion: ladder-aware audit payload + max_level cap ──
-- Two one-line splices of the LIVE body (read 2026-07-27):
--   * the promotion ceiling becomes the policy's max_level (default 3 on
--     every row = today's literal 3 — zero behavior change, and the new
--     column has a reader from birth);
--   * the audit event's dial_settings snapshot reads through the ladder
--     (NULL ladder = byte-identical payload).

DO $patch_promo$
DECLARE
  v_src text; v_new text; a1 text; a2 text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'apply_trust_promotion';
  IF v_src IS NULL THEN RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion not found'; END IF;
  IF v_src ILIKE '%trust_ladder_settings%' THEN
    RAISE NOTICE 'trust-mig-1: apply_trust_promotion already ladder-aware'; RETURN;
  END IF;

  a1 := 'v_new := least(v_policy.current_level + 1, 3);';
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected 1 promotion-ceiling anchor, found %', v_hits; END IF;
  v_new := replace(v_src, a1, 'v_new := least(v_policy.current_level + 1, v_policy.max_level);');

  a2 := '''dial_settings'', trust_level_settings(v_policy.action_category, v_new),';
  v_hits := (length(v_new) - length(replace(v_new, a2, ''))) / length(a2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected 1 dial_settings anchor, found %', v_hits; END IF;
  v_new := replace(v_new, a2, '''dial_settings'', trust_ladder_settings(v_policy, v_new),');

  IF v_new = v_src THEN RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion edit did not land'; END IF;
  EXECUTE v_new;
END $patch_promo$;

-- ── Asserts: the change landed, and day one is byte-identical ───────────────

DO $assert$
DECLARE
  v_def text; v_n int; v_p public.trust_policies; v_lvl int;
  v_a jsonb; v_b jsonb;
BEGIN
  -- (a) landed: both key constraints are the format check, on both tables.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.de_autonomy'::regclass AND conname = 'de_autonomy_action_type_check';
  IF v_def IS NULL OR v_def LIKE '%ANY (ARRAY%' OR v_def NOT LIKE '%length(action_type) <= 120%' THEN
    RAISE EXCEPTION 'trust-mig-1: de_autonomy.action_type is still frozen: %', coalesce(v_def, '(missing)');
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.trust_policies'::regclass AND conname = 'trust_policies_action_category_check';
  IF v_def IS NULL OR v_def LIKE '%ANY (ARRAY%' OR v_def NOT LIKE '%length(action_category) <= 120%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_policies.action_category is still frozen: %', coalesce(v_def, '(missing)');
  END IF;

  -- The key grammar itself: legacy keys, category keys and raw action keys
  -- pass; junk does not (pure expressions — no table writes needed).
  IF NOT ('action_execute'        ~ '^[a-z0-9_:.-]+$'
      AND 'action:crm'            ~ '^[a-z0-9_:.-]+$'
      AND 'send_payment_reminder' ~ '^[a-z0-9_:.-]+$') THEN
    RAISE EXCEPTION 'trust-mig-1: the key grammar rejects a required key shape';
  END IF;
  IF 'Bad Key!' ~ '^[a-z0-9_:.-]+$' OR chr(92) ~ '^[a-z0-9_:.-]+$' THEN
    RAISE EXCEPTION 'trust-mig-1: the key grammar admits junk';
  END IF;

  -- The unique index that de-duplicates dial rows must still exist — it is
  -- expression-based over text and needs no change for the new keys.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                    AND indexname = 'de_autonomy_tenant_action_category_de_uq') THEN
    RAISE EXCEPTION 'trust-mig-1: de_autonomy unique dial index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                    AND indexname = 'trust_policies_tenant_category_action_de_uq') THEN
    RAISE EXCEPTION 'trust-mig-1: trust_policies unique policy index is missing';
  END IF;

  -- (b) landed: columns exist; EVERY existing policy has ladder NULL and
  -- max_level 3 — i.e. all live policies still resolve through the legacy
  -- defaults and cap at level 3 exactly as before.
  SELECT count(*) INTO v_n FROM public.trust_policies WHERE ladder IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'trust-mig-1: % policies unexpectedly carry a ladder on day one', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.trust_policies WHERE max_level <> 3;
  IF v_n <> 0 THEN RAISE EXCEPTION 'trust-mig-1: % policies have a non-default max_level on day one', v_n; END IF;

  -- (c) landed, exactly once, and provably byte-identical to the legacy
  -- lookup for EVERY live policy × every level (both functions are pure).
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'trust_ladder_settings';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected exactly 1 trust_ladder_settings, found %', v_n; END IF;

  FOR v_p IN SELECT * FROM public.trust_policies LOOP
    FOR v_lvl IN 0..3 LOOP
      v_a := public.trust_ladder_settings(v_p, v_lvl);
      v_b := public.trust_level_settings(v_p.action_category, v_lvl);
      IF v_a IS DISTINCT FROM v_b THEN
        RAISE EXCEPTION 'trust-mig-1: ladder/legacy settings diverge for policy % (% level %): % vs %',
          v_p.id, v_p.action_category, v_lvl, v_a, v_b;
      END IF;
    END LOOP;
  END LOOP;

  -- (c') Mode-derived 'enabled' (the vocabulary shared with M3's validator):
  -- an entry acts iff its MODE says so — settings carry ONLY
  -- min_confidence / max_amount_cents. Proven behaviourally on synthetic
  -- ladders over a real policy row's scaffold (the lookup is pure).
  SELECT * INTO v_p FROM public.trust_policies LIMIT 1;
  IF FOUND THEN
    v_p.max_level := 3;
    v_p.ladder := '[{"level":1,"name":"Assisted","mode":"act_with_approval"},
                    {"level":2,"name":"Bounded","mode":"act_within_limits","settings":{"max_amount_cents":100000}},
                    {"level":3,"name":"Solo","mode":"act","settings":{"max_amount_cents":500000}}]'::jsonb;
    v_a := public.trust_ladder_settings(v_p, 1);
    -- act_with_approval must compile CLOSED: the dial has no "requires
    -- approval" bit, so enabled=true would mean acting with NO cap under a
    -- label promising a human confirms first — the fail-open that looks like
    -- the feature working.
    IF (v_a->>'enabled')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'trust-mig-1: act_with_approval entry must derive enabled=false (a person confirms first), got %', v_a;
    END IF;
    v_a := public.trust_ladder_settings(v_p, 2);
    IF (v_a->>'enabled')::boolean IS DISTINCT FROM true OR (v_a->>'max_amount_cents')::bigint IS DISTINCT FROM 100000 THEN
      RAISE EXCEPTION 'trust-mig-1: act_within_limits entry must derive enabled=true with its cap, got %', v_a;
    END IF;
    v_p.ladder := '[{"level":1,"name":"Learning","mode":"draft"}]'::jsonb;
    IF (public.trust_ladder_settings(v_p, 3)->>'enabled')::boolean THEN
      RAISE EXCEPTION 'trust-mig-1: a draft-mode entry derived enabled=true';
    END IF;
    IF (public.trust_ladder_settings(v_p, 0)->>'enabled')::boolean THEN
      RAISE EXCEPTION 'trust-mig-1: the implicit level-0 floor derived enabled=true';
    END IF;
    v_p.ladder := '[{"level":1,"name":"X","mode":"gibberish"}]'::jsonb;
    IF (public.trust_ladder_settings(v_p, 1)->>'enabled')::boolean THEN
      RAISE EXCEPTION 'trust-mig-1: an unknown mode failed OPEN — it must derive enabled=false';
    END IF;
  END IF;

  -- The compiled body must never read a settings-level 'enabled' key (the M3
  -- validator forbids that key, so a lookup reading it would silently disable
  -- every custom ladder) and must carry the shared mode vocabulary.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'trust_ladder_settings';
  IF v_def LIKE '%->''settings''->>''enabled''%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_ladder_settings still reads settings.enabled — vocabulary conflict with the M3 validator';
  END IF;
  -- The compile list is exactly (act_within_limits, act): draft AND
  -- act_with_approval both gate — the fail-closed contract M3 cross-asserts.
  IF v_def NOT LIKE '%in (''act_within_limits'', ''act'')%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_ladder_settings does not compile enabled from exactly (act_within_limits, act)';
  END IF;

  -- (d) landed: both engine functions read through the ladder; arity is
  -- unchanged (no overloads appeared); the UI's execute grant on
  -- apply_trust_promotion survived the replace.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'trust_apply_level';
  IF v_def NOT ILIKE '%trust_ladder_settings%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_apply_level does not route through the ladder';
  END IF;
  IF v_def NOT ILIKE '%on conflict (tenant_id, action_type, coalesce(source_category%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_apply_level lost its dial upsert';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'trust_apply_level';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected exactly 1 trust_apply_level, found %', v_n; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'apply_trust_promotion';
  IF v_def NOT ILIKE '%trust_ladder_settings(v_policy, v_new)%' THEN
    RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion audit payload is not ladder-aware';
  END IF;
  IF v_def NOT ILIKE '%least(v_policy.current_level + 1, v_policy.max_level)%' THEN
    RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion does not honor max_level';
  END IF;
  IF v_def NOT ILIKE '%requester cannot approve their own promotion%' THEN
    RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion lost the self-approval block';
  END IF;
  IF v_def NOT ILIKE '%evidence regressed since the request%' THEN
    RAISE EXCEPTION 'trust-mig-1: apply_trust_promotion lost the stale-evidence check';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'apply_trust_promotion';
  IF v_n <> 1 THEN RAISE EXCEPTION 'trust-mig-1: expected exactly 1 apply_trust_promotion, found %', v_n; END IF;
  IF NOT has_function_privilege('authenticated', 'public.apply_trust_promotion(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trust-mig-1: authenticated lost EXECUTE on apply_trust_promotion (the approvals UI calls it)';
  END IF;

  -- The legacy lookup itself must be untouched — it is the NULL-ladder truth.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'trust_level_settings';
  IF v_def NOT ILIKE '%array[100000, 500000, 1000000]%' OR v_def NOT ILIKE '%array[90, 75, 60]%' THEN
    RAISE EXCEPTION 'trust-mig-1: trust_level_settings no longer carries the legacy reward tables';
  END IF;

  RAISE NOTICE 'trust-mig-1: keys unfrozen, ladder-as-data live, all % policies on legacy defaults (ladder NULL).',
    (SELECT count(*) FROM public.trust_policies);
END $assert$;

NOTIFY pgrst, 'reload schema';
