-- 809_what_was_never_called_is_not_a_feature.sql
-- ==========================================================================
-- WHY: FOUR SECURITY DEFINER functions from the 2026-07-20 tenant-management
-- build are reachable by `authenticated` — the internet with a session — and
-- are called by NOTHING. They are the superseded half of a surface migration
-- 200 replaced on the same day, and they read two tables that hold zero rows
-- platform-wide and that no line of this repository reads.
--
--     public.get_all_tenants_with_summary()
--     public.get_tenant_details(p_tenant_id uuid)
--     public.update_tenant_features(p_tenant_id uuid, p_features jsonb)
--     public.update_tenant_billing(p_tenant_id uuid, p_billing_config jsonb)
--
-- Each is dropped here. Nothing else is.
--
-- ==========================================================================
-- ⚠⚠⚠ THIS FILE IS THE SECOND ATTEMPT. THE FIRST RETIREMENT LIST WAS MOSTLY
-- WRONG, AND EVERY WAY IT WAS WRONG IS NOW A RULE IN
-- scripts/retirement-candidates.mjs RATHER THAN A JUDGEMENT IN A HEAD.
--
-- The list that preceded this one marked a cluster ABANDONED while one of its
-- members was executing: `heartbeat_computer_use_runtime` advanced
-- `computer_use_runtimes.last_seen` across three reads ninety seconds apart.
-- Its caller is a containerised client at runtime/browser-operator/ —
-- Dockerfile, docker-compose, four TypeScript modules — that no scan looked at
-- because nobody knew the directory was there. The scanner now ENUMERATES every
-- top-level entry in the repository and REFUSES TO RUN when it meets one it has
-- not been told about, so the next unknown directory turns a checker red instead
-- of silently shrinking its own denominator.
--
-- Three more shapes no grep can see, each now mechanical:
--
--   · THE GRANTEE IS THE CALLER. supabase_auth_admin holds EXECUTE on two
--     functions here; the Supabase Auth service invokes them from project
--     config on every sign-in and sign-up and no file in this repo names them.
--     DROPPING THEM WOULD BREAK LOGIN FOR EVERY USER. approval_brief_writer (7)
--     and trust_pattern_proposer (6) are the same shape. Rule R4 excludes any
--     grantee outside {postgres, PUBLIC, anon, authenticated, service_role}.
--   · A GENERATED FILE IS NOT A CALLER. src/types/database.types.ts names 229
--     of these functions and rescued 15 that nothing calls; so do
--     supabase/baseline/full_schema.sql and review/*.json. Excluded by surface.
--   · A NAME IN A COMMENT IS NOT A CALLER. Sixteen were rescued by a comment,
--     one of which reads "its frontend wrapper is gone". Every source file and
--     every function body is comment-stripped before matching.
--
-- And two more this round found for itself, both of which had to be measured
-- rather than assumed:
--
--   · THE POST-SPLIT WRAPPER (R8). Migrations 748 and 749 fixed a fail-open
--     authority prefix by splitting each carrier: `X_internal` holds the body,
--     and X becomes a wrapper that refuses a caller with no identity. Every
--     call site was repointed, so X has zero callers BY DESIGN — 749 says of
--     three of them "reachable by NOBODY, and that is DELIBERATE", with a
--     stated revival path. Dropping a wrapper deletes the gate and leaves the
--     UNGATED half on the only name that remains. Seven were caught this way:
--     claim_ingestion_items, complete_ingestion_item, fail_ingestion_item,
--     de_memory_search, is_feature_enabled, mcp_host_allowed,
--     run_analytics_query.
--   · THE MIGRATION-BODY CALLER (R9). `install_role_watchers` is invoked from
--     migration bodies and provisioning and by nothing else; migration 636 says
--     so in as many words. No grep of src/ can see that caller.
--
-- ⚠ AND THE TWO TRAPS INSIDE R9 ITSELF, because the first version of it
-- excluded `certify_de_from_sim` and `resolve_de_exception` — the two
-- functions migration 749's own header calls "none, anywhere":
--     ('public.certify_de_from_sim(uuid,text,uuid,integer)', true, true)
-- is a name inside a STRING LITERAL, and 749's probe blocks PERFORM the very
-- functions 749 declares dead. A migration talking to itself is not a caller
-- and a literal is not a call. Both are stripped now, and both are pinned in
-- --selftest in the direction that would fail if the strip stopped working.
--
-- ==========================================================================
-- THE DENOMINATORS, measured 2026-08-20 against the LIVE catalogue.
--
--   R0  non-extension functions in public                       877
--   R1  a database object depends on it                    -101  776
--         (pg_depend: triggers, RLS policies, views, defaults,
--          constraints, casts, operators, event triggers)
--   R2  another function body names it, comments stripped  -235  541
--   R3  a cron.job command names it                         -50  491
--   R4  granted to a role outside the ambient set            -3  488
--   R5  named in live repo code                            -421   67
--         438 caller-surface files across src/, supabase/functions/,
--         runtime/, scripts/, public/, .github/ and the root scripts.
--         147 generated files excluded and named in the report.
--   R6  introduced inside the in-flight window               -1   66
--         cutoff: migration number >= 764, i.e. the last 60 numbers
--         below the highest applied (823). set_authority_rule (783),
--         forget_end_user (779) and revive_unit (687) are the reason
--         the window exists: built-ahead looks exactly like abandoned.
--   R8  a fail-closed wrapper from an authority split        -7   59
--   R9  a migration body invokes it                          -1   58
--
--   58 functions have no caller this repository can see. FOUR are dropped.
--
-- ⚠ 51 of R5's 421 rescues rest on a MENTION-shaped hit alone, and that is
-- deliberately allowed to rescue. calculate_tenant_monthly_cost — a sibling
-- from this very migration, and otherwise a clean candidate — appears in
-- scripts/anon-probe.mjs only as a bare string in an array, and it IS a
-- caller: the probe iterates that array and .rpc()s every entry to prove anon
-- is refused. A data-driven dispatch table is indistinguishable from a
-- hand-list until you read what iterates it, so over-rescuing there is the
-- safe error. THAT IS WHY calculate_tenant_monthly_cost SURVIVES THIS FILE
-- while its four siblings do not.
--
-- ==========================================================================
-- WHY THESE FOUR AND NOT THE OTHER FIFTY-FOUR.
--
-- Passing the caller census is necessary and is not sufficient. Fifty-four of
-- the fifty-eight are left alone, and the report names each with its reason:
-- a migration still maintains it (certify_de_from_sim in 171/181/462,
-- list_kpi_metrics "v2" in 263, set_knowledge_lifecycle in 349/355), a
-- document states a contract for it (propose_computer_use_task is the DE half
-- of docs/computer-use-runtime-contract.md — the runtime client claims and
-- executes, nothing proposes yet), it is money or authority or the audit trail
-- (propose_invoice_from_agreement, record_payment_promise,
-- propose_system_writeback, audit_chain_head, issue_de_delegation_token), or
-- it is deliberately inert and recent (revive_unit, 687).
--
-- These four clear a higher bar: an INDEPENDENT WRITTEN RECORD says the
-- surface is finished, and the live database agrees.
--
--   1. SUPERSEDED, IN WRITING. Migration 200 (2026-07-20), header:
--        "The 20260720_tenant_management migration's get_all_tenants_with_summary
--         used `RETURN json_agg(...) FROM ...` — invalid plpgsql — so it (and
--         possibly that whole migration) never applied, which is why the
--         separate "Tenant Management" tab showed nothing. This replaces it
--         with ONE correct, honest overview RPC feeding the merged "Tenants &
--         Remote Access" tab"
--      ⚠ 200's parenthetical is WRONG on the facts and it is quoted anyway:
--      the migration DID apply and all five of its functions are live in
--      pg_proc today. What survives the correction is the part that matters —
--      the tab those functions fed was replaced by one that does not call
--      them. THE REPLACEMENT IS LIVE AND CALLED: get_platform_tenant_overview()
--      from src/lib/api.ts:1075. That is the only one of the six with a caller.
--
--   2. READING A FLAG NOTHING HONOURS, IN WRITING. Migration 624 (2026-08-06),
--      header:
--        "`tenant_feature_toggles` carries a `trust_adaptive_execution` flag
--         that looks like this, but it is read ONLY by get_tenant_details and
--         update_tenant_features — no enforcement path consults it — and the
--         table holds ZERO rows. Another flag nothing honours."
--      624 went and built its pause elsewhere rather than on this surface.
--
--   3. THE LIVE DATABASE AGREES, MEASURED TODAY, NOT INFERRED:
--        tenant_feature_toggles   0 rows
--        tenant_billing_config    0 rows
--      and `tenant_feature_toggles` has ZERO occurrences anywhere in src/,
--      supabase/functions/, scripts/ or tests/.
--
--   4. NOTHING DEPENDS ON THEM AND NOTHING IS ORPHANED BY THEIR GOING. No
--      pg_depend row references any of the four. No function body names any of
--      the four (comments stripped). Between them they call exactly one thing —
--      is_platform_admin() — which has many other callers and is untouched.
--
--   5. DROPPING THEM CANNOT REMOVE A GATE. All four open with
--      `IF NOT is_platform_admin() THEN RAISE EXCEPTION 'Unauthorized'`. They
--      are a gated surface with no door in front of it, not a gate.
--
-- ⚠ AND THE ONE THING THAT ARGUES FOR DOING THIS RATHER THAN LEAVING IT: all
-- four are SECURITY DEFINER, all four hold EXECUTE for `authenticated`, and
-- NONE of them sets `search_path`. Every SECURITY DEFINER function written in
-- this repository since migration ~059 sets it; these predate that discipline
-- and were never revisited, which is itself evidence of what they are. An
-- unreachable, unmaintained, search-path-less definer on the authenticated
-- perimeter is a liability with no offsetting use.
--
-- ==========================================================================
-- ⚠⚠ WHAT BREAKS IF THIS IS APPLIED AND THE FOLLOW-UPS ARE NOT DONE. Said
-- here because a red `certify` with no explanation is how a correct change
-- gets reverted by the next person.
--
--   1. supabase/baseline/execute-allowlist.json PINS ALL FOUR, and certify
--      fails on ANY diff to that file's surface. After this applies, the four
--      entries must be pruned BY HAND — `certify.mjs --pin-allowlist` rewrites
--      from LIVE STATE and would bless any unrelated breach that landed in the
--      same window, which is the near-miss that file's own note records.
--      DO IT AFTER THE APPLY, NOT BEFORE: pruning first makes the allowlist
--      wrong in the other direction while the functions are still live.
--   2. src/types/database.types.ts is generated and still declares all four.
--      Re-run `npm run gen:types`. It is a generated artifact, so it is not a
--      caller and nothing breaks at runtime — but a stale one will rescue these
--      names from the NEXT audit, which is exactly failure mode number two.
--   3. supabase/baseline/full_schema.sql still contains their definitions.
--      Re-run `npm run backup:schema`.
--
-- No edge function, no page, no script and no test calls any of the four, so
-- there is no deploy ordering to get right. That was measured, not assumed:
-- zero hits across 438 caller-surface files.
--
-- ==========================================================================
-- HOW TO DRY-RUN THIS FILE. It carries its own always-aborting arm, so nobody
-- has to hand-edit it into one:
--
--   node scripts/db-query.mjs --sql "set m809.dry_run='on';"   -- same session
--
-- or, as it was actually driven before being offered for apply, by prepending
-- that SET to a scratch copy. With the flag on, section 3 raises its own
-- report — probes attempted, probes completed, assertions run, findings — and
-- the transaction rolls back. With the flag absent (the real apply) the same
-- block is silent unless it finds something.
-- ==========================================================================

begin;

-- ── 0. WHAT THE CATALOGUE LOOKS LIKE BEFORE THE DROP ──────────────────────
-- Recorded inside this transaction so section 3 can prove the drop removed
-- EXACTLY its targets and nothing else. A delta is environment-independent in
-- a way an absolute count never is: on a database that never had these four,
-- the expected delta is zero and the assertion still holds.
create temporary table _m809_before on commit drop as
select
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public')                                as n_public_functions,
  (select count(*) from (values
      ('public.get_all_tenants_with_summary()'),
      ('public.get_tenant_details(uuid)'),
      ('public.update_tenant_features(uuid, jsonb)'),
      ('public.update_tenant_billing(uuid, jsonb)')
    ) as v(sig) where to_regprocedure(v.sig) is not null)       as n_targets_present;

-- ── 1. NOTHING MAY DEPEND ON THEM ─────────────────────────────────────────
-- ⚠ A drop that silently breaks a caller is far worse than a dead function
-- left alone, so the two shapes of dependency are asserted BEFORE the drop,
-- not after. Both are violation-shaped — "if a dependent exists, refuse" —
-- and therefore vacuously true on a database that does not have these
-- functions at all, which is what makes this file replayable.
--
--   (a) pg_depend, which records triggers, RLS policies, views, column
--       defaults, check constraints, casts, operators and event triggers.
--   (b) the text of every other function body WITH COMMENTS STRIPPED, because
--       PL/pgSQL bodies are opaque to the dependency system: a body that
--       calls one of these creates NO pg_depend row at all. This is the check
--       that migration 749's own header had to run by hand, and the comment
--       strip is why it is not fooled by the sixteen rescues-by-comment.
do $$
declare
  r  record;
  f  oid;
  v_dep text;
  v_by  text;
begin
  for r in
    select * from (values
      ('public.get_all_tenants_with_summary()'),
      ('public.get_tenant_details(uuid)'),
      ('public.update_tenant_features(uuid, jsonb)'),
      ('public.update_tenant_billing(uuid, jsonb)')
    ) as v(sig)
  loop
    -- Skip a signature this database does not have rather than demanding
    -- production's shape in order to pass.
    continue when to_regprocedure(r.sig) is null;
    f := to_regprocedure(r.sig)::oid;

    select string_agg(distinct d.classid::regclass::text, ', ')
      into v_dep
      from pg_depend d
     where d.refobjid   = f
       and d.refclassid = 'pg_proc'::regclass
       and d.deptype   <> 'i'
       and not (d.classid = 'pg_proc'::regclass and d.objid = f);

    if v_dep is not null then
      raise exception
        '809: REFUSING TO DROP % — % still depend(s) on it. The retirement census was wrong; re-run scripts/retirement-candidates.mjs before touching this file.',
        r.sig, v_dep;
    end if;

    select string_agg(p.proname, ', ')
      into v_by
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.oid <> f
       and regexp_replace(
             regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g')
           ~ ('(^|[^a-zA-Z0-9_])' || split_part(r.sig, '(', 1) || '[^a-zA-Z0-9_]');

    if v_by is not null then
      raise exception
        '809: REFUSING TO DROP % — its name still appears in the body of: %. Comments were stripped, so this is a real reference.',
        r.sig, v_by;
    end if;
  end loop;
end $$;

-- ── 2. THE DROP ───────────────────────────────────────────────────────────
-- ⚠ THE FULL SIGNATURE FROM pg_get_function_arguments, NOT
-- pg_get_function_identity_arguments. Two migrations have already been broken
-- by the identity form (743, and the first draft of 799): it omits DEFAULT
-- clauses, and a signature reconstructed without them does not match what the
-- author was looking at. None of these four carries a default — measured, both
-- forms are byte-identical here — so the choice costs nothing today and keeps
-- the habit right for the file that does.
--
-- `if exists` and no `cascade`. Section 1 has already proved there is nothing
-- to cascade TO; using it anyway would turn a refusal into a silent widening.
drop function if exists public.get_all_tenants_with_summary();
drop function if exists public.get_tenant_details(p_tenant_id uuid);
drop function if exists public.update_tenant_features(p_tenant_id uuid, p_features jsonb);
drop function if exists public.update_tenant_billing(p_tenant_id uuid, p_billing_config jsonb);

-- ── 3. VERIFY, AND SAY HOW MUCH VERIFYING WAS DONE ────────────────────────
-- ⚠ A CHECKER THAT CANNOT FAIL IS THEATRE, so this block counts its own
-- comparisons and refuses to report a clean result it did not earn. Zero
-- findings from zero assertions looks exactly like zero findings from twelve.
do $$
declare
  r                 record;
  v_name            text;
  v_attempted       int  := 0;
  v_completed       int  := 0;
  v_assertions      int  := 0;
  v_findings        text[] := '{}';
  v_before_fns      bigint;
  v_before_targets  bigint;
  v_after_fns       bigint;
  v_delta           bigint;
  v_report          text;
  ASSERTION_FLOOR   constant int := 14;
begin
  select n_public_functions, n_targets_present
    into v_before_fns, v_before_targets
    from _m809_before;

  for r in
    select * from (values
      ('public.get_all_tenants_with_summary()'),
      ('public.get_tenant_details(uuid)'),
      ('public.update_tenant_features(uuid, jsonb)'),
      ('public.update_tenant_billing(uuid, jsonb)')
    ) as v(sig)
  loop
    v_attempted := v_attempted + 1;
    v_name := split_part(r.sig, '(', 1);

    -- A1 — the signature is gone.
    v_assertions := v_assertions + 1;
    if to_regprocedure(r.sig) is not null then
      v_findings := array_append(v_findings, format('%s STILL EXISTS after the drop', r.sig));
    end if;

    -- A2 — and so is every OTHER overload of the same name. A drop that names
    -- one signature and leaves a second on the same name is the shape that
    -- makes a perimeter report lie.
    v_assertions := v_assertions + 1;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = split_part(v_name, '.', 2)
    ) then
      v_findings := array_append(v_findings,
        format('%s: an overload of this name survives in public', r.sig));
    end if;

    -- A3 — no grant row may reference it any more. Vacuous once the row is
    -- gone, which is the point: it fires only if A1 also fired, and it is
    -- here so that "dropped" and "unreachable" are asserted separately rather
    -- than one standing in for the other.
    v_assertions := v_assertions + 1;
    if exists (
      select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace,
             lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
       where n.nspname = 'public'
         and p.proname = split_part(v_name, '.', 2)
         and x.privilege_type = 'EXECUTE'
    ) then
      v_findings := array_append(v_findings,
        format('%s: EXECUTE is still granted to somebody', r.sig));
    end if;

    v_completed := v_completed + 1;
  end loop;

  -- A4 — EXACTLY the targets went. Guards against a cascade nobody asked for
  -- and against a hand-edit that adds a fifth drop above without adding it to
  -- the list this block checks.
  v_assertions := v_assertions + 1;
  select count(*) into v_after_fns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public';
  v_delta := v_before_fns - v_after_fns;
  if v_delta <> v_before_targets then
    v_findings := array_append(v_findings,
      format('the drop removed %s function(s) from public but only %s target(s) were present — something else went with them',
             v_delta, v_before_targets));
  end if;

  -- A5 — the replacement surface must survive. This migration's entire case
  -- rests on get_platform_tenant_overview() being the live successor, so if it
  -- is not there afterwards the drop has taken the wrong half.
  -- Violation-shaped and guarded: a database that has neither the successor
  -- nor the targets is a fresh replay and has nothing to contradict.
  v_assertions := v_assertions + 1;
  if v_before_targets > 0
     and to_regprocedure('public.get_platform_tenant_overview()') is null then
    v_findings := array_append(v_findings,
      'get_platform_tenant_overview() is absent — the successor this migration justifies itself with is not there');
  end if;

  -- ── THE ASSERTION FLOOR ────────────────────────────────────────────────
  -- Four probes x three assertions, plus A4 and A5, is fourteen. If the loop
  -- ever runs short — a values list edited down, an early `continue` added —
  -- this block would otherwise print a clean result having compared almost
  -- nothing. It refuses to.
  v_assertions := v_assertions;
  if v_assertions < ASSERTION_FLOOR then
    raise exception
      '809: ASSERTION FLOOR NOT MET — % assertion(s) ran across % probe(s), expected at least %. A clean result from too few comparisons is not a clean result.',
      v_assertions, v_attempted, ASSERTION_FLOOR;
  end if;

  v_report := format(
    'probes_attempted=%s probes_completed=%s assertions=%s findings=%s%s',
    v_attempted, v_completed, v_assertions,
    coalesce(array_length(v_findings, 1), 0),
    case when array_length(v_findings, 1) is null
         then '' else ' :: ' || array_to_string(v_findings, ' | ') end);

  if array_length(v_findings, 1) is not null then
    raise exception '809: %', v_report;
  end if;

  -- ── THE ALWAYS-ABORTING ARM ────────────────────────────────────────────
  -- Present so that this file can be dry-run without being hand-edited into a
  -- different file. Silent on a real apply.
  if coalesce(current_setting('m809.dry_run', true), '') = 'on' then
    raise exception '809 DRY RUN (deliberate abort) — %', v_report;
  end if;

  raise notice '809 VERIFY — %', v_report;
end $$;

commit;
