-- 446_scope_group_b_memory_and_metrics.sql            (main session assigns 446)
-- ============================================================================
-- GROUP B of the docs/32 permission-matrix remediation (P1-11 + P2-12).
-- Six per-DE readers that were TENANT-ONLY: any workspace member saw every
-- employee's private material. This adds the row-filter / lookup-gate pattern
-- proven in get_de_csat_metrics (mig 388) and get_de_performance_metrics
-- (mig 435), re-verified against LIVE pg_get_functiondef on 2026-07-27:
--
--   1. list_de_memory_grouped(p_de_id, p_limit)      — an employee's MEMORY
--      CONTENTS. Single-lookup gate on p_de_id. ALSO: holds PUBLIC + anon
--      EXECUTE (proacl `=X/postgres, anon=X/postgres`) — revoked here with
--      ON ROUTINE ... FROM PUBLIC, anon per the mig-365 lesson. It failed
--      closed for anon (auth_tenant_id() is null -> 0 rows) but the grant is
--      the mig-330 class and goes.
--   2. get_de_action_metrics(p_tenant_id, p_days)    — row filter on subject_id
--   3. get_de_cost_metrics_ranged(p_tenant_id, p_days) — row filter on u.de_id
--   4. get_de_inquiry_metrics(p_tenant_id, p_days)   — row filter on er.de_id
--   5. get_outcome_metering(p_tenant_id, p_from, p_to) — THREE queries read
--      billable_outcomes (totals / by_de / by_day); all three get the guard.
--      billable_outcomes.de_id is NULLABLE (0 of 398 rows null today), so the
--      null-tolerant form `(de_id is null or ...)` is used, matching the
--      mig-386 policy shape and the Wave-2 per-column convention.
--   6. list_de_health(p_tenant_id)                   — iterates ALL
--      digital_employees and LEFT JOINs metrics onto them; guard goes on the
--      outer employee filter (same reasoning as mig 435: filtering the row
--      set filters everything hanging off it). Its inner composed calls
--      (get_de_performance_metrics — already scoped by 435 —,
--      get_de_guardrail_activity, get_de_cost_metrics) gate on tenant
--      membership only, so a scoped tenant_user still passes them; their
--      unscoped rows are dropped by the outer filter and never surface.
--
-- OR-precedence: verified from the live bodies — every WHERE clause touched
-- here is a pure conjunction (no top-level OR), so appending `and <guard>`
-- guards the whole predicate. The only ORs introduced are the null-tolerant
-- guards themselves, which are self-bracketed.
--
-- Signatures are unchanged — no DROP of an old arity is needed; each patch
-- asserts exactly one pg_proc row per name instead.
--
-- Callers (all verified 2026-07-27; none breaks):
--   list_de_memory_grouped     src/lib/deWorkbenchApi.ts:151 (user context)
--   get_de_action_metrics      src/lib/api.ts:1122           (user context)
--   get_de_inquiry_metrics     src/lib/api.ts:1134           (user context)
--   get_outcome_metering       src/lib/api.ts:1149           (user context)
--   get_de_cost_metrics_ranged src/lib/api.ts:1173           (user context)
--   list_de_health             src/lib/deHealthApi.ts:117 (EmployeeFilePage:704,
--                              LiveWorkforceDEs:265/656), LiveOutcomesPage:160
--   supabase/functions/: ZERO matches. pg_cron: ZERO. Other db functions
--   (pg_proc.prosrc sweep): ZERO. So no service-role/admin-client path exists;
--   and can_access_de names service_role explicitly anyway, so a future
--   service-role caller passes.
--
-- UX consequence for a scoped (sub-manager, assigned) user — deliberate:
--   readers FILTER, they do not raise. Memory panel shows [] for an employee
--   they are not responsible for; Performance/Insights and Outcomes show only
--   their employees' rows; the health/workforce board (list_de_health) lists
--   ONLY their assigned employees — other DEs show "no health data" wherever
--   a stale roster row still renders. Owner/admin/manager see everything,
--   unchanged (they pass the guard on role before the assignment lookup).
-- ============================================================================

-- ─── 1. list_de_memory_grouped ──────────────────────────────────────────────
DO $patch1$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  a1 text := '      AND m.tenant_id = auth_tenant_id()';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_memory_grouped';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/memory: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_memory_grouped';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/memory: already scoped — skipping body patch';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/memory: anchor found % times, refusing to guess', v_hits; END IF;

  v_new := replace(v_src, a1, array_to_string(ARRAY[
    a1,
    '      -- DE scoping (wave2 grpB): memory is readable by the people responsible',
    '      -- for this employee; owner, admin, manager and service_role see all.',
    '      AND public.can_access_de(p_de_id)'], v_eol));
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/memory: edit did not land'; END IF;
  EXECUTE v_new;
END $patch1$;

-- The mig-365 form: strip PUBLIC too, or the revoke accomplishes nothing.
REVOKE ALL ON ROUTINE public.list_de_memory_grouped(uuid, integer) FROM PUBLIC, anon;

-- ─── 2. get_de_action_metrics ───────────────────────────────────────────────
DO $patch2$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  a1 text := '        and ae.subject_id is not null';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_action_metrics';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/action: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_action_metrics';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/action: already scoped — skipping'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/action: anchor found % times, refusing to guess', v_hits; END IF;

  v_new := replace(v_src, a1, array_to_string(ARRAY[
    a1,
    '        -- DE scoping (wave2 grpB): rows narrow to the employees this caller',
    '        -- is responsible for; owner/admin/manager see the whole workspace.',
    '        and public.can_access_de(ae.subject_id)'], v_eol));
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/action: edit did not land'; END IF;
  EXECUTE v_new;
END $patch2$;

-- ─── 3. get_de_cost_metrics_ranged ──────────────────────────────────────────
DO $patch3$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  a1 text := '    where u.tenant_id = p_tenant_id and u.de_id is not null';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_cost_metrics_ranged';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/cost: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_cost_metrics_ranged';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/cost: already scoped — skipping'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/cost: anchor found % times, refusing to guess', v_hits; END IF;

  v_new := replace(v_src, a1, array_to_string(ARRAY[
    a1,
    '      -- DE scoping (wave2 grpB): per-employee spend narrows to the',
    '      -- employees this caller is responsible for.',
    '      and public.can_access_de(u.de_id)'], v_eol));
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/cost: edit did not land'; END IF;
  EXECUTE v_new;
END $patch3$;

-- ─── 4. get_de_inquiry_metrics ──────────────────────────────────────────────
DO $patch4$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  a1 text := '      where er.tenant_id = p_tenant_id and er.de_id is not null';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_inquiry_metrics';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/inquiry: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_de_inquiry_metrics';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/inquiry: already scoped — skipping'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/inquiry: anchor found % times, refusing to guess', v_hits; END IF;

  v_new := replace(v_src, a1, array_to_string(ARRAY[
    a1,
    '        -- DE scoping (wave2 grpB): decisions narrow to the employees',
    '        -- this caller is responsible for.',
    '        and public.can_access_de(er.de_id)'], v_eol));
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/inquiry: edit did not land'; END IF;
  EXECUTE v_new;
END $patch4$;

-- ─── 5. get_outcome_metering — three reads of billable_outcomes ─────────────
DO $patch5$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  -- totals (3-space indent, terminated by the statement semicolon)
  a1 text := '   where tenant_id = p_tenant_id and occurred_at between p_from and p_to;';
  -- by_de (aliased b.)
  a2 text := '    where b.tenant_id = p_tenant_id and b.occurred_at between p_from and p_to';
  -- by_day inner raw subquery (6-space indent, no semicolon)
  a3 text := '      where tenant_id = p_tenant_id and occurred_at between p_from and p_to';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_outcome_metering';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/metering: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_outcome_metering';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/metering: already scoped — skipping'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  -- All three anchors must be present exactly once BEFORE any edit.
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/metering: totals anchor found % times', v_hits; END IF;
  v_hits := (length(v_src) - length(replace(v_src, a2, ''))) / length(a2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/metering: by_de anchor found % times', v_hits; END IF;
  v_hits := (length(v_src) - length(replace(v_src, a3, ''))) / length(a3);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/metering: by_day anchor found % times', v_hits; END IF;

  -- by_day first (its anchor is the most easily shadowed), then by_de, then totals.
  v_new := replace(v_src, a3, a3 || v_eol ||
    '        and (de_id is null or public.can_access_de(de_id))');
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/metering: by_day edit did not land'; END IF;
  v_src := v_new;

  v_new := replace(v_src, a2, a2 || v_eol ||
    '      and (b.de_id is null or public.can_access_de(b.de_id))');
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/metering: by_de edit did not land'; END IF;
  v_src := v_new;

  v_new := replace(v_src, a1,
    '   where tenant_id = p_tenant_id and occurred_at between p_from and p_to' || v_eol ||
    '     and (de_id is null or public.can_access_de(de_id));');
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/metering: totals edit did not land'; END IF;

  EXECUTE v_new;
END $patch5$;

-- ─── 6. list_de_health — guard the outer employee list ──────────────────────
DO $patch6$
DECLARE
  v_src text; v_new text; v_eol text; v_hits int; v_cnt int;
  a1 text := '  where d.tenant_id = p_tenant_id;';
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_health';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'grpB/health: expected 1 arity, found %', v_cnt; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'list_de_health';
  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE 'grpB/health: already scoped — skipping'; RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;
  v_hits := (length(v_src) - length(replace(v_src, a1, ''))) / length(a1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'grpB/health: anchor found % times, refusing to guess', v_hits; END IF;

  v_new := replace(v_src, a1, array_to_string(ARRAY[
    '  where d.tenant_id = p_tenant_id',
    '    -- DE scoping (wave2 grpB): the health board lists the employees this',
    '    -- caller is responsible for. The composed metrics CTEs LEFT JOIN onto',
    '    -- this row set, so filtering it filters everything hanging off it.',
    '    and public.can_access_de(d.id);'], v_eol));
  IF v_new = v_src THEN RAISE EXCEPTION 'grpB/health: edit did not land'; END IF;
  EXECUTE v_new;
END $patch6$;

-- ─── Asserts: the changes LANDED and nothing was lost ───────────────────────
DO $assert$
DECLARE
  v_def text; v_tok int; v_call int; v_n int;
  v_tenant uuid; v_t_out uuid; v_res jsonb; v_expect int; v_json json;
  r record;
BEGIN
  -- Guard counts. v_tok counts every occurrence of the bare token (comments
  -- included — the mig-428/442 lesson); v_call counts schema-qualified calls.
  -- They must be EQUAL and match the expected number, or a comment is
  -- contaminating the census.
  FOR r IN
    SELECT * FROM (VALUES
      ('list_de_memory_grouped',     1),
      ('get_de_action_metrics',      1),
      ('get_de_cost_metrics_ranged', 1),
      ('get_de_inquiry_metrics',     1),
      ('get_outcome_metering',       3),
      ('list_de_health',             1)
    ) AS t(fn, expected)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn;
    IF v_def IS NULL THEN RAISE EXCEPTION 'grpB assert: % missing', r.fn; END IF;
    v_tok  := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
    v_call := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
    IF v_call <> r.expected THEN
      RAISE EXCEPTION 'grpB assert: % has % guard calls, expected %', r.fn, v_call, r.expected;
    END IF;
    IF v_tok <> v_call THEN
      RAISE EXCEPTION 'grpB assert: % token/call mismatch (% vs %) — a comment names the token', r.fn, v_tok, v_call;
    END IF;
  END LOOP;

  -- Pre-existing gates and load-bearing content survived each rewrite.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='list_de_memory_grouped';
  IF v_def NOT LIKE '%auth_tenant_id()%' OR v_def NOT LIKE '%subject_ref%' OR v_def NOT LIKE '%expires_at%' THEN
    RAISE EXCEPTION 'grpB assert: memory body lost content';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_action_metrics';
  IF v_def NOT LIKE '%not authenticated%' OR v_def NOT LIKE '%p.tenant_id = p_tenant_id%'
     OR v_def NOT LIKE '%previewed%' OR v_def NOT LIKE '%executed_after_approval%' THEN
    RAISE EXCEPTION 'grpB assert: action body lost its gate or content';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_cost_metrics_ranged';
  IF v_def NOT LIKE '%not authenticated%' OR v_def NOT LIKE '%p.tenant_id = p_tenant_id%'
     OR v_def NOT LIKE '%ai_model_pricing%' OR v_def NOT LIKE '%make_interval%' THEN
    RAISE EXCEPTION 'grpB assert: cost body lost its gate or content';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_inquiry_metrics';
  IF v_def NOT LIKE '%not authenticated%' OR v_def NOT LIKE '%p.tenant_id = p_tenant_id%'
     OR v_def NOT LIKE '%evidence_run_decisions%' THEN
    RAISE EXCEPTION 'grpB assert: inquiry body lost its gate or content';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='get_outcome_metering';
  IF v_def NOT LIKE '%not authorized%' OR v_def NOT LIKE '%auth.uid() is not null%'
     OR v_def NOT LIKE '%tenant_outcome_pricing%' OR v_def NOT LIKE '%price_per_resolution_cents%' THEN
    RAISE EXCEPTION 'grpB assert: metering body lost its gate, its null-uid server path, or content';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='list_de_health';
  IF v_def NOT LIKE '%not a member of this workspace%' OR v_def NOT LIKE '%get_de_performance_metrics%'
     OR v_def NOT LIKE '%get_de_guardrail_activity%' OR v_def NOT LIKE '%get_de_cost_metrics(%'
     OR v_def NOT LIKE '%incident_active%' THEN
    RAISE EXCEPTION 'grpB assert: health body lost its gate or a composed metrics call';
  END IF;

  -- ACL: PUBLIC and anon are gone from list_de_memory_grouped; the legit
  -- grantees survived (REVOKE FROM PUBLIC must not eat explicit grants).
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) e
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'list_de_memory_grouped' AND e.grantee = 0
  ) THEN
    RAISE EXCEPTION 'grpB assert: PUBLIC still holds EXECUTE on list_de_memory_grouped';
  END IF;
  IF has_function_privilege('anon', 'public.list_de_memory_grouped(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grpB assert: anon still holds EXECUTE on list_de_memory_grouped';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.list_de_memory_grouped(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.list_de_memory_grouped(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grpB assert: a legitimate grantee lost EXECUTE on list_de_memory_grouped';
  END IF;

  -- ── Behaviour, not just text. This migration runs as postgres: auth.uid()
  -- and auth.role() are both null, so postgres is in no workspace and fails
  -- the guard on every branch — the same probe mig 435 used.
  SELECT id INTO v_tenant FROM tenants LIMIT 1;

  -- memory: gate + guard both false for postgres -> the empty contract, [].
  SELECT public.list_de_memory_grouped(gen_random_uuid(), 5) INTO v_json;
  IF v_json::text <> '[]' THEN
    RAISE EXCEPTION 'grpB assert: memory returned % for an identity-less caller', v_json::text;
  END IF;

  -- The three raise-gated metrics must still refuse an identity-less caller.
  IF v_tenant IS NOT NULL THEN
    BEGIN
      PERFORM * FROM public.get_de_action_metrics(v_tenant, 7);
      RAISE EXCEPTION 'grpB assert: get_de_action_metrics no longer refuses a null uid';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%not authenticated%' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM * FROM public.get_de_cost_metrics_ranged(v_tenant, 7);
      RAISE EXCEPTION 'grpB assert: get_de_cost_metrics_ranged no longer refuses a null uid';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%not authenticated%' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM * FROM public.get_de_inquiry_metrics(v_tenant, 7);
      RAISE EXCEPTION 'grpB assert: get_de_inquiry_metrics no longer refuses a null uid';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%not authenticated%' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM * FROM public.list_de_health(v_tenant);
      RAISE EXCEPTION 'grpB assert: list_de_health no longer refuses a non-member';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%not a member of this workspace%' THEN RAISE; END IF;
    END;
  END IF;

  -- metering is the one function whose gate deliberately passes a null uid
  -- (server path), so here the new guard is the ONLY thing standing between
  -- an identity-less caller and per-DE rows. Prove it holds.
  SELECT b.tenant_id INTO v_t_out FROM billable_outcomes b
   GROUP BY b.tenant_id ORDER BY count(*) DESC LIMIT 1;
  IF v_t_out IS NOT NULL THEN
    v_res := public.get_outcome_metering(v_t_out);
    IF v_res->'by_de' <> '[]'::jsonb THEN
      RAISE EXCEPTION 'grpB assert: metering still hands per-DE rows to an identity-less caller: %', v_res->'by_de';
    END IF;
    SELECT count(*) INTO v_expect FROM billable_outcomes b
     WHERE b.tenant_id = v_t_out AND b.kind = 'resolution' AND b.billable
       AND b.de_id IS NULL AND b.occurred_at BETWEEN now() - interval '30 days' AND now();
    IF (v_res->'totals'->>'resolutions')::int <> v_expect THEN
      RAISE EXCEPTION 'grpB assert: metering totals leak guarded rows (% vs expected %)',
        v_res->'totals'->>'resolutions', v_expect;
    END IF;
  ELSE
    RAISE NOTICE 'grpB assert: no billable_outcomes rows — metering behaviour probe skipped';
  END IF;

  RAISE NOTICE 'grpB: 6 functions scoped (8 guard calls), memory RPC revoked from PUBLIC/anon.';
END $assert$;

NOTIFY pgrst, 'reload schema';
