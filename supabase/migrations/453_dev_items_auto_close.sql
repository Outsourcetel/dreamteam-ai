-- 453_dev_items_auto_close.sql
-- ============================================================================
-- docs/31 Q10 rec 1 — the daily development-needs detector opens items and
-- refreshes them forever, but has no path that ever closes one.
--
-- ── The defect ───────────────────────────────────────────────────────────
-- detect_de_development_needs_internal opens a DETECTED de_development_items
-- row for four evidence signals (confidence_gap, escalation_spike, error_rate,
-- guardrail_pattern) and refreshes it via ON CONFLICT while the signal holds.
-- When the signal recedes, the candidate row simply stops matching
-- `where c.triggered` — the item is never touched again and sits open
-- (proposed/in_progress) indefinitely. Because sync_de_lifecycle_from_development
-- flips a DE back from 'improving' to 'active' only when its LAST open item
-- closes, a DE that ever tripped a detector signal stays "Improving" forever.
-- The two demo DEs (…201, …401, tenant a1b2c3d4-…0001) have carried open
-- detected items since 2026-07-11 — 16+ days.
--
-- ── The fix: a recovery pass, mirroring mig 127's proven idiom ───────────
-- assess_de_skills_internal (mig 127, read from LIVE prosrc 2026-07-27) closes
-- its detected skill_gap item the moment the opening condition no longer
-- holds: a bare `update … set status = 'completed', updated_at = now()` scoped
-- to source='detected' and status in ('proposed','in_progress'). We mirror
-- that shape per metric row, with two deliberate additions taken from the
-- OTHER two live completion idioms:
--   * completed_at = now()  — the human RPC (update_de_development_item_status)
--     and the PIP sweep (de_governance_sweep_internal, mig 129) both stamp it;
--     mig 127's branch omitting it leaves status='completed' rows with a NULL
--     completion time. We follow the fuller idiom.
--   * perform sync_de_lifecycle_from_development(de_id) — REQUIRED here. There
--     is NO trigger on de_development_items (verified live: zero non-internal
--     triggers), so the lifecycle flip-back fires only if the closer calls the
--     sync explicitly, as the human RPC does and as this detector already does
--     after every open/refresh. (Mig 127's close branch does NOT call it — a
--     latent gap in the skills sweep, NOT fixed here, flagged to the caller.)
-- The close conditions are the EXACT INVERSES of the four opening bars
-- (esc>50, conf<50, err>15, blocked/runs>0.1) — same-threshold symmetry is the
-- mig 127 idiom (weak at prof<=2, closed when none weak). The guardrail
-- inverse is written multiplication-side (blocked <= 0.1*runs) so a zero-run
-- row cannot divide by zero regardless of evaluation order.
-- Because each close condition is the strict complement of its open condition,
-- an item opened/refreshed in this run can never be closed by the same run —
-- no order dependence between the two passes.
--
-- ── What the new branch must NOT touch ───────────────────────────────────
-- skill_gap (mig 127 owns its close), pip (mig 129's overdue sweep re-measures
-- and completes/fails it), and anything human-created (source <> 'detected').
-- The branch filters source='detected' AND an explicit four-type list, and the
-- asserts below prove those literals never appear in this function.
--
-- ── Callers, verified live 2026-07-27 ────────────────────────────────────
--   * cron job 11 `de-development-needs-daily` (0 6 * * *):
--       select count(*) from detect_de_development_needs_internal()
--     Counts the RETURNED set. The recovery pass RETURNs nothing, so the
--     count's meaning (items opened/refreshed) is unchanged.
--   * public.detect_de_development_needs(p_tenant_id) — owner/admin wrapper,
--     called from src/lib/deHealthApi.ts (detectDeDevelopmentNeeds); returns
--     the opened/refreshed set to the UI. Also unchanged: closes are silent.
--   * pg_proc prosrc sweep: no other DB function references the internal fn.
--
-- ⚠ SEPARATE FINDING (not fixed here, do not lose it): since DE scoping landed
-- inside get_de_performance_metrics (migs 385/435, `and public.can_access_de(de.id)`),
-- the CRON run of this detector iterates ZERO metric rows — under pg_cron
-- auth.role() is NULL, so can_access_de() is false for every DE (it only
-- passes for service_role / platform admin / tenant roles / assignees).
-- Verified live: get_de_performance_metrics('a1b2c3d4-…0001', 8) returns []
-- on a NULL-auth connection while the underlying evidence tables show 26 and
-- 15 decisions for the two DEs. Today BOTH the open pass and this new close
-- pass only do real work when an owner/admin runs the scan from the UI
-- wrapper. The cron job silently returns count=0. That needs its own
-- migration (service-context bypass inside get_de_performance_metrics or a
-- cron-side jwt claim), with its own asserts — out of scope for 453.
--
-- Honest expectation for the two stuck demo DEs: their metrics have NOT
-- recovered (all-time escalation 96–100%, confidence 18–31 — verified live),
-- so this migration will NOT close their escalation_spike/confidence_gap
-- items on apply. It adds the missing follow-through for when any metric
-- genuinely recovers; the demo DEs are legitimately still "Improving".
--
-- ── Discipline ───────────────────────────────────────────────────────────
-- The function is patched by splicing LIVE pg_get_functiondef at apply time —
-- never from mig 125's file text (amended since). Exact-anchor splice: the
-- unique `return next v_row; / end loop;` tail of the candidate loop
-- (verified: exactly 1 occurrence, LF line endings, live 2026-07-27).
-- Pre-counts verified live: 'escalation_spike' x1, 'confidence_gap' x1,
-- 'error_rate' x2 (item_type + target_metric), 'guardrail_pattern' x1,
-- sync(m.de_id) x1, open-status token x1, no 'completed_at', no CR.
-- ============================================================================

DO $patch$
DECLARE
  v_src  text;
  v_new  text;
  v_eol  text;
  v_hits int;
  v_cnt  int;
  a_anchor text;
  a_insert text;
BEGIN
  -- No overload may exist before or after (signature must not change).
  SELECT count(*) INTO v_cnt
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'detect_de_development_needs_internal';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION '453: expected exactly 1 detect_de_development_needs_internal, found %', v_cnt;
  END IF;

  -- LIVE source, never migration-file text (mig 125 has been amended).
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'detect_de_development_needs_internal';

  -- Idempotency: the live function has no completion timestamp anywhere;
  -- if one is present the recovery pass already landed.
  IF v_src LIKE '%completed_at%' THEN
    RAISE NOTICE '453: recovery pass already present — skipping patch';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0
                THEN chr(13)||chr(10) ELSE chr(10) END;

  -- Exact anchor: the unique tail of the candidate (insert/refresh) loop.
  a_anchor := '        return next v_row;' || v_eol || '      end loop;';
  v_hits := (length(v_src) - length(replace(v_src, a_anchor, ''))) / length(a_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '453: expected the splice anchor exactly once, found % — live source drifted, re-derive the patch', v_hits;
  END IF;

  -- The recovery pass. Sits inside the per-DE metrics loop, AFTER the
  -- insert/refresh loop, so it sees the same metric row the opener saw.
  -- NOTE the in-body comment deliberately names none of the literals the
  -- asserts below count.
  a_insert := array_to_string(ARRAY[
    '',
    '      -- Recovery pass (docs/31 Q10, mig 453): each opening bar above, inverted,',
    '      -- releases the entry it opened once the measure is back inside the line;',
    '      -- the employee lifecycle is then re-derived so the flip back to active',
    '      -- fires when the last open entry goes. The two filters keep this',
    '      -- statement away from human-created entries and from the kinds the',
    '      -- other two sweeps own — each of those closes its own.',
    '      update de_development_items i',
    '         set status = ''completed'', completed_at = now(), updated_at = now()',
    '       where i.tenant_id = t.id and i.de_id = m.de_id',
    '         and i.source = ''detected''',
    '         and i.status in (''proposed'', ''in_progress'')',
    '         and ((i.item_type = ''escalation_spike''  and m.escalation_rate <= 50)',
    '           or (i.item_type = ''confidence_gap''    and m.avg_confidence >= 50)',
    '           or (i.item_type = ''error_rate''        and m.error_rate <= 15)',
    '           or (i.item_type = ''guardrail_pattern'' and m.blocked_guardrail_count::numeric <= 0.1 * m.total_runs));',
    '      if found then',
    '        perform sync_de_lifecycle_from_development(m.de_id);',
    '      end if;'
  ], v_eol);

  v_new := replace(v_src, a_anchor, a_anchor || a_insert);
  IF v_new = v_src THEN
    RAISE EXCEPTION '453: edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

-- ============================================================================
-- Asserts — the close branch landed, the open branch survived, nothing else
-- moved. All counts use the length/replace idiom on the REDEPLOYED live def.
-- ============================================================================
DO $assert$
DECLARE
  v_def  text;
  v_args text;
  v_n    int;
BEGIN
  -- (1) Still exactly one function of this name — no overload, no drop.
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'detect_de_development_needs_internal';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '453: expected 1 detect_de_development_needs_internal after patch, found %', v_n;
  END IF;

  SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    INTO v_def, v_args
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'detect_de_development_needs_internal';

  -- (2) Signature and return type untouched.
  IF v_args <> 'p_tenant_id uuid' THEN
    RAISE EXCEPTION '453: identity arguments changed: %', v_args;
  END IF;
  IF v_def NOT ILIKE '%RETURNS SETOF de_development_items%' THEN
    RAISE EXCEPTION '453: return type changed';
  END IF;

  -- (3) The close branch landed (token counts).
  v_n := (length(v_def) - length(replace(v_def, 'status = ''completed''', ''))) / length('status = ''completed''');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: expected 1 close-status assignment, found %', v_n; END IF;

  v_n := (length(v_def) - length(replace(v_def, 'completed_at = now()', ''))) / length('completed_at = now()');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: expected 1 completion timestamp, found %', v_n; END IF;

  v_n := (length(v_def) - length(replace(v_def, 'if found then', ''))) / length('if found then');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: expected 1 conditional sync guard, found %', v_n; END IF;

  -- (4) Lifecycle sync now fires from BOTH passes: the original open/refresh
  --     call plus the new close call. Both target m.de_id.
  v_n := (length(v_def) - length(replace(v_def, 'sync_de_lifecycle_from_development(m.de_id)', ''))) / length('sync_de_lifecycle_from_development(m.de_id)');
  IF v_n <> 2 THEN RAISE EXCEPTION '453: expected 2 lifecycle sync calls, found %', v_n; END IF;

  -- (5) The type filter is present and covers exactly the four detector
  --     kinds: each quoted literal appears once in the opener's VALUES list
  --     and once in the close filter ('error_rate' also names a target
  --     metric in the opener, hence 3).
  v_n := (length(v_def) - length(replace(v_def, '''escalation_spike''', ''))) / length('''escalation_spike''');
  IF v_n <> 2 THEN RAISE EXCEPTION '453: escalation kind count % (want 2)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, '''confidence_gap''', ''))) / length('''confidence_gap''');
  IF v_n <> 2 THEN RAISE EXCEPTION '453: confidence kind count % (want 2)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, '''error_rate''', ''))) / length('''error_rate''');
  IF v_n <> 3 THEN RAISE EXCEPTION '453: error kind count % (want 3)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, '''guardrail_pattern''', ''))) / length('''guardrail_pattern''');
  IF v_n <> 2 THEN RAISE EXCEPTION '453: guardrail kind count % (want 2)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, 'i.item_type = ', ''))) / length('i.item_type = ');
  IF v_n <> 4 THEN RAISE EXCEPTION '453: close branch type-filter arms % (want 4)', v_n; END IF;

  -- (6) The close branch is fenced to detector-owned open items…
  v_n := (length(v_def) - length(replace(v_def, 'i.source = ''detected''', ''))) / length('i.source = ''detected''');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: close-branch source fence count % (want 1)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, 'i.status in (''proposed'', ''in_progress'')', ''))) / length('i.status in (''proposed'', ''in_progress'')');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: close-branch status fence count % (want 1)', v_n; END IF;

  -- (7) …and can never reach the kinds owned elsewhere or human-created rows:
  --     those literals must not exist anywhere in this function.
  IF v_def LIKE '%skill_gap%' THEN RAISE EXCEPTION '453: function must not name the skills sweep''s kind'; END IF;
  IF v_def LIKE '%''pip''%' THEN RAISE EXCEPTION '453: function must not name the improvement-plan kind'; END IF;
  IF v_def LIKE '%''manual''%' THEN RAISE EXCEPTION '453: function must not name a human source'; END IF;

  -- (8) The opener's insert/refresh logic survived intact.
  v_n := (length(v_def) - length(replace(v_def, 'on conflict (tenant_id, de_id, item_type) where source = ''detected'' and status in (''proposed'', ''in_progress'')', ''))) / length('on conflict (tenant_id, de_id, item_type) where source = ''detected'' and status in (''proposed'', ''in_progress'')');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: opener conflict clause count % (want 1)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, 'do update set description = excluded.description, baseline_value = excluded.baseline_value, updated_at = now()', ''))) / length('do update set description = excluded.description, baseline_value = excluded.baseline_value, updated_at = now()');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: opener refresh clause count % (want 1)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, 'where c.triggered', ''))) / length('where c.triggered');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: opener trigger filter count % (want 1)', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, 'return next v_row', ''))) / length('return next v_row');
  IF v_n <> 1 THEN RAISE EXCEPTION '453: opener return count % (want 1)', v_n; END IF;

  RAISE NOTICE '453: recovery pass live — detector-opened items of the four core kinds now close when their metric re-enters bounds, with the lifecycle flip-back on last close. Opener logic, signature and return set unchanged. Reminder: the 6:00 cron run currently sees zero metric rows (can_access_de under NULL auth) — separate defect, not addressed here.';
END $assert$;

-- ============================================================================
-- Post-apply verification (read-only, for the applying session):
--
--   -- close branch present exactly once, opener intact:
--   select pg_get_functiondef(p.oid) from pg_proc p
--    where p.pronamespace='public'::regnamespace
--      and p.proname='detect_de_development_needs_internal';
--
--   -- behavioural spot-check (run as an owner/admin of the demo tenant, or
--   -- any context where can_access_de passes):
--   select * from detect_de_development_needs('a1b2c3d4-0000-0000-0000-000000000001');
--   select item_type, status, completed_at from de_development_items
--    where de_id in ('de000000-0000-0000-0000-000000000201',
--                    'de000000-0000-0000-0000-000000000401')
--    order by de_id, item_type;
--   -- Expected TODAY: escalation_spike/confidence_gap items remain OPEN —
--   -- verified live that both DEs still fail those bars (esc 96–100%,
--   -- conf 18–31). skill_gap and pip rows must be untouched by this path.
-- ============================================================================
