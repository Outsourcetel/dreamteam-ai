-- 749_a_tenant_id_parameter_is_not_a_password.sql
-- ==========================================================================
-- WHY: TWENTY-NINE SECURITY DEFINER functions in `public` gate their authority
-- check on `auth.uid() is not null` —
--
--     if auth.uid() is not null and not exists (...) then raise exception ...
--
-- The identity test makes the check SKIP rather than FAIL when auth.uid() is
-- null. Migrations 747 and 748 fixed four siblings by hand
-- (attach_compliance_pack, detach_compliance_pack, instantiate_role_archetype,
-- install_role_kit) and named more they did not reach. This is the full sweep
-- of what was left, measured on 2026-08-16 against the LIVE catalogue, not
-- against files:
--
--   select p.proname, pg_get_functiondef(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prosecdef
--      and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
--          ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and';
--
-- ==========================================================================
-- ⚠⚠⚠ TWENTY-NINE, AND THE FIRST DRAFT OF THIS FILE SAID TWENTY-ONE. THE
-- ERROR WAS IN THE PREDICATE, NOT IN THE READING.
--
-- The enumeration above was originally run as a LITERAL SUBSTRING:
-- `ilike '%auth.uid() is not null and%'`. A literal cannot see a defect that
-- spans a line break, and real bodies break the line. MEASURED on the same 750
-- SECURITY DEFINER functions, the same day:
--
--     ilike '%auth.uid() is not null and%'        ->  21
--     ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'  ->  27
--
-- Six live carriers were invisible to the literal. enqueue_conflict_backlog is
-- the clearest — it writes
--
--     IF auth.uid() IS NOT NULL
--        AND NOT (p_tenant_id = auth_tenant_id() ...
--
-- which is the identical defect with a newline in it. A reviewer proved the
-- blindness by injecting a synthetic body of exactly that shape into the
-- scanner's population: 750 -> 751 functions examined, 21 -> 21 violations.
-- NOT DETECTED. The same blind substring was in this migration's own PROBE 6
-- and in scripts/secdef-authority-prefix.mjs, so the ratchet would have printed
-- clean while ten live carriers kept running. Both are now the regex, and the
-- scanner carries `--selftest`, which re-runs that exact mutation and asserts
-- the CARRIER count rises. Measured after the repair: carriers 21 -> 21 under
-- the old predicate, 29 -> 30 under the new one.
--
-- AND A SECOND SHAPE THE FLAT REGEX STILL MISSES — an OUTER `if` instead of a
-- conjunct, same fail-open behaviour:
--
--     if auth.uid() is not null then
--       if not exists (<caller is a member>) then raise exception 'not authorized';
--       end if;
--     end if;
--
-- Two live examples, both WRITERS: set_de_objective_status (3 call sites in
-- de-work) and verify_extraction_result. That brings the population to 29.
--
-- ⚠ AND THE SHAPE THAT LOOKS IDENTICAL AND IS THE EXACT OPPOSITE — NAMED HERE
-- BECAUSE THE BRIEF THAT COMMISSIONED THIS EXTENSION ASKED FOR IT TO BE
-- DELETED, AND DELETING IT WOULD HAVE WIDENED A PERIMETER INSIDE A MIGRATION
-- WHOSE SUBJECT IS NARROWING ONE.
--
--     IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'service role only'; END IF;
--
-- That is FAIL-CLOSED. It refuses every caller who HAS an identity, which is
-- the opposite of the defect. probe_chunk_neighbors and record_knowledge_conflict
-- both carry it and BOTH ARE LEFT EXACTLY AS THEY ARE. They were on the list
-- handed to this migration as "service-role-only, so removing the prefix costs
-- nothing"; the bodies say otherwise, and the bodies win. A third body,
-- hybrid_match_knowledge, matches on `case when auth.uid() is not null then
-- auth.uid() else p_acting_user end` — an ACTOR RESOLUTION with no authority
-- test attached. All three are recorded in the scanner's
-- CLASSIFIED_NON_DEFECTS with the argument, not silently excluded by a regex
-- that happens not to reach them, and that pin is symmetric in BOTH
-- directions: it goes red if one of them stops mentioning the pattern (a pin
-- aimed at nothing) and it goes red if one of them BECOMES a carrier (a
-- classification that has expired while still granting cover).
--
-- WHICH LEAVES THE GAP A REGEX ALWAYS LEAVES: shape number four, that nobody
-- has written yet. The scanner answers it with an arm rather than a hope —
-- any body mentioning `auth.uid() is not null` in a form NEITHER arm claims,
-- and which is not one of the three classified above, is reported as "a human
-- must classify this". Measured today: 3 such bodies, all three classified,
-- so the arm is at zero and any fourth goes red on arrival. That is the
-- difference between a checker with a blind spot and a checker that says when
-- it has been handed something it cannot judge.
--
-- ⚠ THE EIGHT ADDED HERE, and the enumeration that chose each treatment. Call
-- sites were grepped as `.rpc('name'` across src/, supabase/functions/,
-- scripts/ and tests/, and SQL callers re-measured from pg_proc WITH COMMENTS
-- STRIPPED (the trap this file opens with):
--
--   de_memory_write        SPLIT. 5 edge call sites, all on the service-role
--                          admin client: de-answer:1259, de-memory:89,
--                          de-orchestrate:193, de-work:829,
--                          _shared/identityMemory.ts:72 (-> widget-ask).
--                          SQL callers handoff_back_to_de and
--                          decide_de_exception are BROWSER-only
--                          (src/lib/supportInboxApi.ts:149,
--                          src/lib/deWorkbenchApi.ts:207), so they always
--                          carry a real auth.uid() and are unaffected: with a
--                          non-null uid the membership check fired before this
--                          migration and fires after it.
--   de_memory_search       SPLIT. 4 edge call sites, all admin: de-answer:891,
--                          de-memory:103, de-work:811,
--                          _shared/identityMemory.ts:47. No SQL callers.
--   run_analytics_query    SPLIT. de-work/index.ts:824, admin client. This is
--                          the one whose fail-open behaviour was PROVEN LIVE
--                          rather than reasoned — see the paragraph below.
--   set_de_objective_status SPLIT. de-work/index.ts:265, :328, :2147, admin.
--                          WRAPPING form.
--   assess_definition_of_done SPLIT. connector-hub:7438 and
--                          _shared/defOfDone.ts:39 (-> de-work,
--                          agentic-step-execute), all admin. `authenticated`
--                          holds NO EXECUTE, so — exactly like the three drain
--                          wrappers above — its wrapper is reachable by nobody
--                          and is a retirement candidate, not a live gate. Its
--                          one SQL caller, conclude_objective_verified, has NO
--                          caller anywhere in the repo; it is left pointing at
--                          the CHECKED name, so if it is ever revived from a
--                          service-role path it will refuse loudly instead of
--                          reading another workspace quietly.
--   enqueue_conflict_backlog PREFIX DELETED. No caller anywhere — not TS, not
--                          SQL. WRITER taking a tenant id as a parameter.
--   resolve_action_execution_for_task PREFIX DELETED. Browser only:
--                          src/lib/connectorApi.ts:1591.
--   verify_extraction_result PREFIX DELETED (WRAPPING form). No caller
--                          anywhere — not TS, not SQL.
--
-- ⚠⚠ AND THE THREE-VALUED-LOGIC TRAP IN "JUST DELETE THE PREFIX", WHICH IS
-- WHY TWO OF THOSE THREE DELETIONS WERE MEASURED BEFORE THEY WERE WRITTEN.
-- Deleting the identity test only fails CLOSED if what remains evaluates to
-- TRUE — not to NULL — for a caller with no identity, because `if NULL then`
-- does not fire. Both survivors depend on a helper, so both were asked, live,
-- with a null uid:
--
--     auth.uid()                                             -> NULL
--     auth_tenant_id()                                       -> NULL
--     auth_has_tenant_role(...)                              -> false  (not NULL)
--     resolve_platform_capability(auth.uid(), 'support...')  -> false  (not NULL)
--     not (p_tenant_id = auth_tenant_id()
--          and auth_has_tenant_role(...))                    -> TRUE   (refuses)
--     not resolve_platform_capability(auth.uid(), ...)       -> TRUE   (refuses)
--
-- So enqueue_conflict_backlog returns `forbidden` and
-- resolve_action_execution_for_task raises `tenant access denied`. Had either
-- helper returned NULL instead of false, deleting the prefix would have left
-- the function fail-open with the guard LOOKING fixed — which is this
-- migration's own subject, one level down.
--
-- ⚠ THE FAIL-OPEN BEHAVIOUR IS PROVEN LIVE, NOT INFERRED. On
-- run_analytics_query, read-only and rolled back:
--     signed-in member of workspace A asking for workspace B
--                                          -> ERROR P0001 not authorized for this tenant
--     the same call, role=authenticated, NO identity at all
--                                          -> ANSWERED
-- The caller with a session is refused; the caller with none is served.
--
-- ⚠ AND THE HONEST BOUND ON THAT, WHICH MUST NOT BE SOFTENED OR INFLATED:
-- this proves the GUARD is fail-open. It does NOT prove an internet caller
-- reaches it. de-work derives tenantId server-side rather than from request
-- input, so a confused deputy is not demonstrated on the live path. This is
-- the removal of the last tenant-scoping backstop, not an open door.
--
-- ⚠ THE COMMENT STRIP IS LOAD-BEARING, TWICE OVER. prosrc and
-- pg_get_functiondef both return `--` comments, so a naive ilike also matches
-- every comment that NAMES the pattern — including the ones 747 and 748 added
-- explaining the fix. Migration 747's own first apply failed on exactly that.
-- The same trap caught the enumeration handed to this migration one level up:
-- see "WHAT THE ENUMERATION GOT WRONG" below.
--
-- ⚠ NO BODY HERE WAS RECONSTRUCTED FROM A MIGRATION FILE. Migrations 715 and
-- 717 are in the production ledger and ABSENT from HEAD, and the baseline
-- carries older bodies, so a file is not evidence of what is live. Every body
-- below was taken from pg_get_functiondef on 2026-08-16 and is reproduced
-- verbatim apart from the change this migration is for.
--
-- ==========================================================================
-- HOW BIG THE HOLE ACTUALLY IS — stated precisely, because overstating it is
-- its own kind of dishonesty.
--
-- auth.uid() is null for exactly three callers: `anon`, `service_role`, and an
-- `authenticated` JWT carrying no `sub`. MEASURED: `anon` holds EXECUTE on
-- NONE of these twenty-one. So this is not an open door to the internet.
--
-- What it is: the removal of the last tenant-scoping backstop from every
-- service-role path. Fourteen of the twenty-one take a tenant id — or an id
-- that resolves to one — AS A PARAMETER, and an edge function that relays a
-- user-supplied tenant_id into one of them is a confused deputy: a signed-in
-- member of workspace X reaches workspace Y's data or writes. That is the
-- shape migrations 662-664 exist to prevent, and the reason the rule is
-- absolute rather than case-by-case is that whether any given edge function
-- launders user input today is not a property anyone re-checks tomorrow.
--
-- ==========================================================================
-- WHAT THE ENUMERATION GOT WRONG, CHECKED RATHER THAN INHERITED
--
-- The sweep finds a STRING. Three of the twenty-one hits are not fail-open
-- authority checks at all, and calling them holes would be five confident
-- findings that were all wrong, again:
--
--  · search_knowledge — ALREADY FAILS CLOSED, and explicitly. Its predicate is
--    `(auth.uid() is not null and <member of p_tenant_id>) or (auth.uid() is
--    null and auth.role() = 'service_role')`. A caller who is neither gets
--    ZERO ROWS. Removing the prefix is a provable no-op (with a null uid the
--    membership subquery is empty, so `p_tenant_id in (…)` is false either
--    way). It is removed only so the ratchet's expected set is EMPTY rather
--    than "empty except two we decided were fine", which is how a pin becomes
--    cover. Probe 2 asserts the ZERO-ROWS refusal rather than an exception,
--    because a refusal of a different SHAPE is still a refusal and pretending
--    otherwise would be theatre.
--
--  · apply_trust_promotion — the hit is on the SELF-APPROVAL guard
--    (`auth.uid() is not null and v_policy.requested_by is not null and
--    auth.uid() = v_policy.requested_by`), not on an authority check. Its real
--    authority check is the block above it, which names service_role by role
--    and is deliberately permissive to it. Removing the prefix is a no-op:
--    `null = <uuid>` is NULL, and `if NULL then` does not fire. Probe 2 pins
--    that no-op — it asserts the function still answers `no_pending_policy`
--    instead of a new refusal — rather than claiming a fix.
--
--  · assign_doc_collection / unassign_doc_collection — the hit sits BELOW
--    `v_tenant := public.auth_tenant_id(); if v_tenant is null then return
--    'no_tenant'`. auth_tenant_id() is null whenever auth.uid() is, so the
--    guarded block is unreachable with a null identity and the function has
--    always refused. Removing the prefix is defence in depth, not a fix, and
--    probe 2 pins the `no_tenant` answer it has always given.
--
-- And two SQL-caller claims in the enumeration were comment-only mentions —
-- the very trap this file opens with. Re-measured with comments stripped:
--   apply_trust_promotion   claimed 2 SQL callers → 0 (detect_trust_widening_
--                           patterns and raise_trust_widening_proposals only
--                           NAME it in comments)
--   get_workforce_economics claimed 1              → 0 (named in a comment
--                           inside get_playbook_economics)
--   apply_improvement       claimed 1              → 1, real:
--                           sync_improvement_decision
--   reject_improvement      claimed 1              → 1, real: same
--
-- ==========================================================================
-- SECTION 1 — GROUP A: SIX WITH A REAL SERVICE-ROLE CALLER. THEY SPLIT.
--
-- Enumerated by grepping CALL SITES (`.rpc('name'`), not definitions, across
-- src/, supabase/functions/, scripts/ and tests/:
--
--   certify_de_from_eval    supabase/functions/eval-run/index.ts:437
--   claim_ingestion_items   supabase/functions/knowledge-ingest-drain:249
--   complete_ingestion_item supabase/functions/knowledge-ingest-drain:290,315
--   fail_ingestion_item     supabase/functions/knowledge-ingest-drain:323
--   enqueue_de_work_item    supabase/functions/de-work/index.ts:228,310,428
--                           + scripts/golden-path.mjs:174 (a SIGNED-UP OWNER
--                             over the anon key — the wrapper path, and
--                             certify's golden-path section depends on it
--                             still working; probe 7 fires exactly that)
--   mcp_host_allowed        supabase/functions/mcp-client/index.ts:341
--
-- All five edge functions use the service-role admin client, so auth.uid() is
-- null on those paths and deleting the prefix outright would have BROKEN THE
-- FEATURE — a refusal reported as a fix. 748's shape is used instead:
-- `<name>_internal` carries the body with no user check, and the ORIGINAL NAME
-- becomes a wrapper that refuses a null identity in words and then applies the
-- authority predicate exactly as it stood after the prefix came off.
--
-- ⚠⚠ DEPLOY ORDERING, SAID OUT LOUD RATHER THAN DISCOVERED. This migration
-- REVOKES service_role on all six original names. Between applying it and
-- deploying the five edge functions, every one of those calls returns
--     permission denied for function <name>
-- and eval-run's certification, the knowledge ingest drain, the DE autonomy
-- loop and the MCP host allowlist are all broken. The allowlist one FAILS
-- CLOSED by design (mcp-client treats an unreadable allowlist as a refusal,
-- index.ts:342-350), so that outage is a 503 rather than an unvetted call —
-- but the other four simply stop. DEPLOY eval-run, knowledge-ingest-drain,
-- de-work AND mcp-client WITH THIS MIGRATION. They are edited in this same
-- change and are repointed at the _internal names.
--
-- ⚠⚠ AND SECTION 3c ADDS SIX MORE, SO THE COMPLETE DEPLOY LIST IS TEN. Written
-- out in one place because a missed repoint is a silent runtime break, and
-- because two of them are not obvious from any grep for an RPC name — they
-- import a SHARED module that was edited, and a shared module is compiled into
-- every importer:
--     1. eval-run                 certify_de_from_eval_internal
--     2. knowledge-ingest-drain   claim_/complete_/fail_ingestion_item_internal
--     3. mcp-client               mcp_host_allowed_internal
--     4. de-work                  enqueue_de_work_item_internal, de_memory_
--                                 write/search_internal, run_analytics_query_
--                                 internal, set_de_objective_status_internal
--                                 (×3), + imports _shared/defOfDone.ts
--     5. de-answer                de_memory_write/search_internal
--     6. de-memory                de_memory_write/search_internal
--     7. de-orchestrate           de_memory_write_internal
--     8. connector-hub            assess_definition_of_done_internal
--     9. agentic-step-execute     ⚠ NO RPC NAME CHANGED IN THIS FILE — it
--                                 imports _shared/defOfDone.ts, which did
--    10. widget-ask               ⚠ same: imports _shared/identityMemory.ts,
--                                 which now calls de_memory_*_internal
-- 15 call sites in 7 files. Re-grepped after editing: zero remaining calls to
-- the old names anywhere in supabase/functions, src, scripts or tests.
--
-- ⚠ ONE SERVICE PATH IS TIGHTENED RATHER THAN PRESERVED, AND IT IS NAMED HERE
-- BECAUSE IT IS THE ONLY ONE. enqueue_de_work_item carried the prefix TWICE —
-- once on the membership check and once on the DE-scoping check
-- (`can_access_de`). The internal variant drops the first (there is no member
-- to check) and KEEPS the second, which under service_role used to be skipped.
-- can_access_de admits service_role by role name, so the live caller still
-- passes; probe 3 fires it with the PostgREST service-role JWT shape rather
-- than assuming. Every other internal variant is the live body verbatim minus
-- the membership check.
--
-- ⚠ WHY THE GATE GOES ON THE OLD NAME (748's decision, restated because it is
-- the load-bearing one): the alternative — leave the unchecked function on the
-- name everything already points at, and give the browser a new one — puts the
-- ungated function on the name the next author will reach for. The gate
-- belongs on the obvious name.
--
-- ⚠ THREE OF THE SIX WRAPPERS BECOME REACHABLE BY NOBODY, AND THAT IS
-- DELIBERATE. claim_ingestion_items, complete_ingestion_item and
-- fail_ingestion_item do NOT hold EXECUTE for `authenticated` today (measured:
-- anon=n authenticated=n public=n service_role=Y), and
-- tests/knowledge-acl-invariants.test.ts pins the platform-shelf siblings the
-- same way. Their `is_platform_admin()` bar has therefore NEVER been able to
-- fire — a checker that cannot fail. Granting the wrapper to `authenticated`
-- would make it fire, and was rejected: `authenticated` is the internet with a
-- session, and adding EXECUTE for it inside a migration whose subject is
-- CLOSING an authority hole is a widening smuggled in beside a narrowing. So
-- today's grant matrix is preserved exactly, minus service_role on the old
-- name. The three names survive as the fail-closed public identity of the
-- operation, are listed as retirement candidates in the report, and one
-- `grant execute … to authenticated` makes any of them a platform-admin entry
-- point the day a UI wants one.
--
-- ⚠ mcp_host_allowed, ARGUED RATHER THAN ASSUMED. It is STABLE, writes
-- nothing, and returns one boolean about the calling workspace's own
-- allowlist, so the split buys little security in itself: service_role can
-- read mcp_server_allowlist directly, and an authenticated user of another
-- workspace is ALREADY refused (their auth.uid() is not null, so the check
-- fires today). Leaving it alone was the honest alternative and was rejected
-- for one reason: it would leave the ratchet with a pinned exception, and an
-- exception keyed to "we looked at this one and it seemed fine" is exactly the
-- artefact the next reviewer cannot re-derive. The split costs one function
-- and one repoint, and the STABLE/read shape is preserved on both halves.
--
-- ==========================================================================
-- SECTION 2 — GROUP B: EIGHT BROWSER-ONLY. PREFIX DELETED, NOTHING ELSE.
-- SECTION 3 — GROUP C: SEVEN WITH NO TYPESCRIPT CALLER. SAME TREATMENT.
--
-- For both sections the change is exactly one clause per occurrence. No
-- behaviour is altered beside it. Fifteen functions in one migration is
-- already a lot to hold in the head, and a behaviour change parked next to a
-- security fix is how the next reviewer loses the thread.
--
-- GROUP C's callers, re-measured here rather than inherited (pg_proc with
-- comments stripped, plus a repo grep for `.rpc('name'`):
--   apply_improvement          SQL: sync_improvement_decision (trigger
--                              trg_sync_improvement on human_tasks, AFTER
--                              UPDATE OF status, ENABLED).
--                              ⚠⚠ THIS COMMENT PREVIOUSLY CLAIMED: "grepped
--                              supabase/functions/ for a direct admin update
--                              of human_tasks: ZERO". THAT WAS FALSE. There
--                              are two — de-work/index.ts:512 and :524 — and
--                              the grep that missed them missed them for the
--                              same reason the sweep at the top of this file
--                              missed six functions: `.update(` sits on the
--                              NEXT LINE from `human_tasks`, so a line-oriented
--                              search cannot see it. A right answer resting on
--                              a false proof, in the one place this migration
--                              admits it could degrade silently, is exactly the
--                              artefact that gets inherited as fact.
--                              THE CONCLUSION SURVIVES, and now on evidence
--                              that was actually checked:
--                                · :512-514 sets only related_id, :524-527 sets
--                                  only detail/updated_at. Neither touches
--                                  status, and `.eq('status','pending')` is a
--                                  WHERE, not a SET.
--                                · trg_sync_improvement is AFTER UPDATE **OF
--                                  STATUS**, so neither write fires it at all.
--                                · AND THE STRONGER GUARD THE OLD COMMENT DID
--                                  NOT KNOW ABOUT: trg_guard_human_task_decision
--                                  is BEFORE DELETE OR UPDATE on human_tasks and
--                                  RAISES on any change to status/decided_by/
--                                  decided_at unless `app.allow_task_decision`
--                                  is 'on'. So a direct admin status write is
--                                  refused BY THE DATABASE, not merely absent
--                                  from today's code — which is a property that
--                                  survives the next author, and a grep is not.
--                              The trigger therefore fires only from
--                              decide_human_task / decide_de_escalation /
--                              decide_de_exception, all with a real auth.uid(),
--                              and the tightened check passes. If that ever
--                              stops being true the failure is SILENT: the
--                              trigger wraps the call in `exception when others
--                              then raise warning`, so the human's decision
--                              would land and the improvement would sit in
--                              review_pending. Still named here, because that
--                              silence is the risk even though the guard above
--                              makes the trip unlikely.
--   reject_improvement         SQL: same trigger, same reasoning.
--   certify_de_from_sim        none, anywhere.
--   resolve_de_exception       none, anywhere.
--   publish_platform_shelf_doc none. authenticated holds no EXECUTE, so after
--   dismiss_platform_kb_change this migration BOTH are callable by nobody:
--                              their bar is is_platform_admin(), which is
--                              false for service_role by construction
--                              (auth.uid() is null → no profile row). That is
--                              the correct end state for an unreachable
--                              platform-shelf writer and it is reported as a
--                              retirement candidate, not hidden.
--   search_knowledge           none. The three `search_knowledge` hits in
--                              supabase/functions/ are LLM TOOL NAMES, not
--                              RPCs: de-work:809 and agentic-step-execute:215
--                              call hybrid_match_knowledge, ai-session:427
--                              selects knowledge_docs directly. Its table
--                              `knowledge_articles` holds 3 rows platform-wide.
--
-- ==========================================================================
-- WHAT IS NAMED AND LEFT (scope discipline — not fixed here, not hidden)
--
--  · apply_trust_promotion admits service_role wholesale
--    (`coalesce(auth.role(),'') <> 'service_role'` skips the membership bar).
--    That is a deliberate arm, not a fail-open prefix, and narrowing it is a
--    behaviour decision about who may apply a trust promotion. Left.
--  · de_certification_status, get_benchmark_report, get_outcome_metering,
--    get_playbook_economics, get_workforce_economics and certify_de_from_eval
--    all still carry a `p.layer = 'platform'` disjunct, which 746/747/748
--    removed from the WRITE paths they touched. These are readers; removing it
--    would take platform support's ability to read a customer's numbers, which
--    is a product decision. Left, and named.
--  · none of the fifteen checks `coalesce(p.is_active, true)` on the caller's
--    profile. A deactivated member still passes. Same finding 748 recorded.
-- ==========================================================================

begin;

-- ==========================================================================
-- SECTION 1 — GROUP A
-- ==========================================================================

-- ── 1.1 certify_de_from_eval ──────────────────────────────────────────────
create or replace function public.certify_de_from_eval_internal(
  p_de_id uuid,
  p_archetype_key text,
  p_eval_run_id uuid,
  p_threshold_pct integer default 80
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text; v_threshold integer;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  -- NO USER CHECK, ON PURPOSE. eval-run certifies with the service-role admin
  -- client and has no signed-in person to check. EXECUTE is service_role only.
  select coalesce((select pass_threshold_pct from role_archetypes where key = p_archetype_key), 80)
    into v_threshold;
  select total, passed into v_total, v_passed from eval_runs where id = p_eval_run_id and tenant_id = v_tenant;
  if v_total is null or v_total = 0 then raise exception 'eval run has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= v_threshold then 'passed' else 'failed' end;
  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, p_eval_run_id, v_pct, v_threshold, v_status, now(), public.de_config_fingerprint(p_de_id));
  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', v_threshold, 'passed', v_passed, 'total', v_total);
end;
$fn$;

revoke all on function public.certify_de_from_eval_internal(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.certify_de_from_eval_internal(uuid, text, uuid, integer)
  to service_role;

create or replace function public.certify_de_from_eval(
  p_de_id uuid,
  p_archetype_key text,
  p_eval_run_id uuid,
  p_threshold_pct integer default 80
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_tenant uuid;
begin
  -- The identity bar on its own line, in words about identity. The `auth.uid()
  -- is not null and` prefix that used to sit in front of the check below made
  -- it SKIP for a caller with no identity instead of refusing one.
  if auth.uid() is null then
    raise exception 'not authenticated: a certification is recorded against a workspace, so the caller has to be a member of one';
  end if;
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  -- The authority predicate, unchanged from the live body apart from the
  -- deleted prefix.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  return public.certify_de_from_eval_internal(p_de_id, p_archetype_key, p_eval_run_id, p_threshold_pct);
end;
$fn$;

-- ⚠ RESTATED, NOT ASSUMED. CREATE OR REPLACE keeps the ACL on THIS database,
-- but on a fresh one it CREATES the function, and a new function is born with
-- PUBLIC EXECUTE (migs 610/630).
revoke all on function public.certify_de_from_eval(uuid, text, uuid, integer)
  from public, anon, service_role;
grant execute on function public.certify_de_from_eval(uuid, text, uuid, integer)
  to authenticated;

-- ── 1.2 claim_ingestion_items ─────────────────────────────────────────────
create or replace function public.claim_ingestion_items_internal(
  p_limit integer default 10,
  p_tenant_id uuid default null::uuid
) returns setof knowledge_ingestion_items
language plpgsql
security definer
set search_path to 'public'
as $fn$
BEGIN
  -- NO USER CHECK. The drain runs on a schedule with the service-role client.
  RETURN QUERY
  WITH picked AS (
    SELECT i.id FROM knowledge_ingestion_items i
     WHERE i.status = 'queued'
       AND i.next_attempt_at <= now()
       AND (p_tenant_id IS NULL OR i.tenant_id = p_tenant_id)
     ORDER BY i.next_attempt_at
     LIMIT greatest(1, p_limit)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE knowledge_ingestion_items i
     SET status = 'running', attempts = i.attempts + 1, updated_at = now()
    FROM picked p WHERE i.id = p.id
  RETURNING i.*;
END $fn$;

revoke all on function public.claim_ingestion_items_internal(integer, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_ingestion_items_internal(integer, uuid)
  to service_role;

create or replace function public.claim_ingestion_items(
  p_limit integer default 10,
  p_tenant_id uuid default null::uuid
) returns setof knowledge_ingestion_items
language plpgsql
security definer
set search_path to 'public'
as $fn$
BEGIN
  -- ⚠ REACHABLE BY NOBODY AFTER THIS MIGRATION, and see the header for why
  -- that is the deliberate answer rather than an oversight: `authenticated`
  -- has never held EXECUTE here, so the platform-admin bar below has never
  -- been able to fire. The body now refuses an unidentified caller instead of
  -- waving it through, which is what makes granting this name to a platform
  -- UI a one-line decision later rather than a re-audit.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated: claiming ingestion work is a platform operation, not an anonymous one';
  END IF;
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'claim_ingestion_items is not callable by tenant users';
  END IF;
  RETURN QUERY SELECT * FROM public.claim_ingestion_items_internal(p_limit, p_tenant_id);
END $fn$;

revoke all on function public.claim_ingestion_items(integer, uuid)
  from public, anon, authenticated, service_role;

-- ── 1.3 complete_ingestion_item ───────────────────────────────────────────
create or replace function public.complete_ingestion_item_internal(
  p_item_id uuid,
  p_doc_id uuid,
  p_duplicate boolean default false
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
DECLARE v_item knowledge_ingestion_items; v_job knowledge_ingestion_jobs;
BEGIN
  -- NO USER CHECK. Called by the drain with the service-role client.
  SELECT * INTO v_item FROM knowledge_ingestion_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'ingestion item not found'; END IF;

  UPDATE knowledge_ingestion_items
     SET status = CASE WHEN p_duplicate THEN 'skipped_duplicate' ELSE 'succeeded' END,
         doc_id = p_doc_id, last_error = NULL, error_kind = NULL, updated_at = now()
   WHERE id = p_item_id;

  -- File the result into the job's target Space, if it had one. This is what
  -- turns an import into an organised library rather than a flat pile.
  SELECT * INTO v_job FROM knowledge_ingestion_jobs WHERE id = v_item.job_id;
  IF v_job.target_collection_id IS NOT NULL AND p_doc_id IS NOT NULL AND NOT p_duplicate THEN
    INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
    VALUES (v_job.tenant_id, p_doc_id, v_job.target_collection_id)
    ON CONFLICT DO NOTHING;
  END IF;
END $fn$;

revoke all on function public.complete_ingestion_item_internal(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_ingestion_item_internal(uuid, uuid, boolean)
  to service_role;

create or replace function public.complete_ingestion_item(
  p_item_id uuid,
  p_doc_id uuid,
  p_duplicate boolean default false
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated: recording an ingestion result is a platform operation, not an anonymous one';
  END IF;
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not callable by tenant users';
  END IF;
  PERFORM public.complete_ingestion_item_internal(p_item_id, p_doc_id, p_duplicate);
END $fn$;

revoke all on function public.complete_ingestion_item(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

-- ── 1.4 fail_ingestion_item ───────────────────────────────────────────────
create or replace function public.fail_ingestion_item_internal(
  p_item_id uuid,
  p_error text,
  p_kind text default 'retryable'::text
) returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
DECLARE v_item knowledge_ingestion_items; v_final boolean; v_backoff interval;
BEGIN
  -- NO USER CHECK. Called by the drain with the service-role client.
  IF p_kind NOT IN ('retryable','terminal') THEN
    RAISE EXCEPTION 'error kind must be retryable or terminal, got %', p_kind;
  END IF;

  SELECT * INTO v_item FROM knowledge_ingestion_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'ingestion item not found'; END IF;

  -- Terminal failures do not get their remaining attempts. Retrying an
  -- unreadable file three times just delays telling the human it is unreadable.
  v_final := (p_kind = 'terminal') OR (v_item.attempts >= v_item.max_attempts);

  IF v_final THEN
    UPDATE knowledge_ingestion_items
       SET status='failed', last_error=left(p_error, 2000), error_kind=p_kind, updated_at=now()
     WHERE id = p_item_id;
    RETURN 'failed';
  END IF;

  -- Exponential backoff, capped: 1m, 4m, 9m... never more than an hour.
  v_backoff := make_interval(secs => least(3600, 60 * power(greatest(v_item.attempts,1), 2)::int));
  UPDATE knowledge_ingestion_items
     SET status='queued', last_error=left(p_error, 2000), error_kind=p_kind,
         next_attempt_at = now() + v_backoff, updated_at=now()
   WHERE id = p_item_id;
  RETURN 'retry_scheduled';
END $fn$;

revoke all on function public.fail_ingestion_item_internal(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_ingestion_item_internal(uuid, text, text)
  to service_role;

create or replace function public.fail_ingestion_item(
  p_item_id uuid,
  p_error text,
  p_kind text default 'retryable'::text
) returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated: recording an ingestion failure is a platform operation, not an anonymous one';
  END IF;
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'not callable by tenant users';
  END IF;
  RETURN public.fail_ingestion_item_internal(p_item_id, p_error, p_kind);
END $fn$;

revoke all on function public.fail_ingestion_item(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ── 1.5 enqueue_de_work_item ──────────────────────────────────────────────
-- ⚠ THIS IS THE ONE THAT MOST DESERVES THE HEADLINE. It takes p_tenant_id AND
-- p_de_id as parameters and INSERTS into the tenant it is handed. Its own live
-- comment argued the prefix was safe because anon holds no EXECUTE — true, and
-- beside the point: the exposure was never anon, it was any service-role path
-- that relays a caller-supplied tenant id.
create or replace function public.enqueue_de_work_item_internal(
  p_tenant_id uuid,
  p_de_id uuid,
  p_title text,
  p_kind text default 'act'::text,
  p_scheduled_for timestamp with time zone default now(),
  p_objective_id uuid default null::uuid,
  p_seq integer default 0,
  p_depends_on uuid default null::uuid,
  p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null::text,
  p_max_attempts integer default 3
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
begin
  -- NO MEMBERSHIP CHECK. de-work drives the autonomy loop with the
  -- service-role client and has no signed-in person.
  --
  -- ⚠ THE DE-SCOPING TEST IS KEPT, AND THAT IS THE ONE PLACE THIS MIGRATION
  -- TIGHTENS THE SERVICE PATH RATHER THAN LEAVING IT ALONE. In the live body
  -- this line also carried the prefix, so under service_role it was SKIPPED;
  -- here it runs. It is kept rather than dropped because can_access_de names
  -- service_role EXPLICITLY (`coalesce(auth.role(),'') = 'service_role'`,
  -- with its own comment saying a null uid must never stand in for the role),
  -- so a real service-role caller still passes — probe 3 fires it with the
  -- PostgREST service-role JWT shape rather than assuming. What it would now
  -- refuse is a caller with no identity AND no service_role claim, which is
  -- exactly the class this migration exists to refuse. If some future caller
  -- reaches this with neither, it gets `not_responsible_for_de` — a refusal
  -- with a misleading noun, and that is the honest cost of keeping the line.
  if not public.can_access_de(p_de_id) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;

  insert into de_work_items (tenant_id, de_id, objective_id, title, kind,
                             scheduled_for, seq, depends_on, payload,
                             idempotency_key, max_attempts)
  values (p_tenant_id, p_de_id, p_objective_id, p_title, p_kind,
          coalesce(p_scheduled_for, now()), p_seq, p_depends_on, coalesce(p_payload, '{}'::jsonb),
          p_idempotency_key, greatest(1, p_max_attempts))
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
    do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row; fetch the existing one so the
  -- caller always gets a stable id for the same idempotency key.
  if v_id is null and p_idempotency_key is not null then
    select id into v_id from de_work_items
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$fn$;

revoke all on function public.enqueue_de_work_item_internal(
  uuid, uuid, text, text, timestamp with time zone, uuid, integer, uuid, jsonb, text, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_de_work_item_internal(
  uuid, uuid, text, text, timestamp with time zone, uuid, integer, uuid, jsonb, text, integer)
  to service_role;

create or replace function public.enqueue_de_work_item(
  p_tenant_id uuid,
  p_de_id uuid,
  p_title text,
  p_kind text default 'act'::text,
  p_scheduled_for timestamp with time zone default now(),
  p_objective_id uuid default null::uuid,
  p_seq integer default 0,
  p_depends_on uuid default null::uuid,
  p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null::text,
  p_max_attempts integer default 3
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated: queueing work puts a task in front of an employee in a named workspace, so the caller has to be a member of it';
  end if;

  -- ⚠ THE TENANT ID IS A PARAMETER, SO IT IS NOT AUTHORISATION (migs 662-664).
  -- Matched against the caller's OWN profile row. Predicate otherwise verbatim
  -- from the live body, prefix deleted.
  if not exists (select 1 from profiles p where p.user_id = auth.uid()
                   and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to enqueue work for this tenant';
  end if;

  -- DE scoping (mig 385/420). The `auth.uid() is not null and` prefix that
  -- used to sit in front of this one is gone too: with the bar above, a null
  -- identity never reaches this line.
  if not public.can_access_de(p_de_id) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;

  return public.enqueue_de_work_item_internal(
           p_tenant_id, p_de_id, p_title, p_kind, p_scheduled_for, p_objective_id,
           p_seq, p_depends_on, p_payload, p_idempotency_key, p_max_attempts);
end;
$fn$;

revoke all on function public.enqueue_de_work_item(
  uuid, uuid, text, text, timestamp with time zone, uuid, integer, uuid, jsonb, text, integer)
  from public, anon, service_role;
grant execute on function public.enqueue_de_work_item(
  uuid, uuid, text, text, timestamp with time zone, uuid, integer, uuid, jsonb, text, integer)
  to authenticated;

-- ── 1.6 mcp_host_allowed ──────────────────────────────────────────────────
-- STABLE on both halves — see the header for why this one was split at all.
create or replace function public.mcp_host_allowed_internal(
  p_tenant_id uuid,
  p_host text
) returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- NO USER CHECK. mcp-client asks this with the service-role client before
  -- every outbound MCP call, and treats an error as a refusal (fail closed).
  return case
    when not exists (select 1 from mcp_server_allowlist where tenant_id = p_tenant_id) then true
    else exists (select 1 from mcp_server_allowlist
                  where tenant_id = p_tenant_id and lower(host) = lower(p_host))
  end;
end;
$fn$;

revoke all on function public.mcp_host_allowed_internal(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mcp_host_allowed_internal(uuid, text)
  to service_role;

create or replace function public.mcp_host_allowed(
  p_tenant_id uuid,
  p_host text
) returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated: the MCP allowlist is workspace configuration, so the caller has to be a member of a workspace';
  end if;
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;
  return public.mcp_host_allowed_internal(p_tenant_id, p_host);
end;
$fn$;

revoke all on function public.mcp_host_allowed(uuid, text)
  from public, anon, service_role;
grant execute on function public.mcp_host_allowed(uuid, text)
  to authenticated;

-- ==========================================================================
-- SECTION 2 — GROUP B: browser-only. One clause deleted per function.
-- ==========================================================================

-- ── 2.1 apply_trust_promotion ─────────────────────────────────────────────
-- ⚠ NOT A FAIL-OPEN FIX. The hit was on the SELF-APPROVAL guard, whose
-- `auth.uid() is not null and` prefix is a null-guard on a comparison, not an
-- authority check: `null = <uuid>` is NULL and `if NULL then` does not fire, so
-- deleting it is a provable no-op. The real authority arm is the
-- `auth.role() <> 'service_role'` block above and it is untouched. This is
-- here so the ratchet's expected set is EMPTY.
create or replace function public.apply_trust_promotion(p_task_id uuid, p_decision text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $fn$
declare
  v_policy    trust_policies;
  v_evidence  jsonb;
  v_new       integer;
  v_label     text;
  v_is_active boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');

  if p_decision = 'rejected' then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'You', 'human',
      format('Trust promotion rejected — %s stays at level %s', v_label, v_policy.current_level),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_rejected', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'level', v_policy.current_level,
        'task_id', p_task_id, 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'reason', 'rejected');
  end if;

  -- Self-approval block: the requester cannot approve their own promotion.
  if v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — requester cannot approve their own request (%s)', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_self_approval', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id, 'user_id', auth.uid())
    );
    raise exception 'the requester cannot approve their own promotion — a different teammate must approve';
  end if;

  -- Stale-check: evidence could have regressed since the request.
  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion rejected as stale — %s evidence regressed since the request', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_stale', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id,
        'evidence_at_request', v_policy.pending_evidence, 'evidence_at_apply', v_evidence)
    );
    raise exception 'evidence regressed since the request — promotion rejected as stale';
  end if;

  v_new := least(v_policy.current_level + 1, v_policy.max_level);
  -- GI-3: scope the dial write to THIS employee (v_policy.de_id) — a NULL de_id
  -- keeps the historical tenant-wide behavior for tenant-scoped policies.
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid(), v_policy.source_category, v_policy.de_id);

  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'You', 'human',
    format('Trust promoted — %s level %s → %s (evidence re-verified at apply time; still capped by guardrails)',
      v_label, v_policy.current_level, v_new),
    'config_change',
    jsonb_build_object('kind', 'trust_promoted', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'de_id', v_policy.de_id,
      'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_ladder_settings(v_policy, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$fn$;

-- ── 2.2 assign_doc_collection ─────────────────────────────────────────────
-- ⚠ ALSO NOT A FAIL-OPEN FIX. auth_tenant_id() is null whenever auth.uid() is,
-- so the early `no_tenant` return already refused an unidentified caller and
-- the guarded block was unreachable. Deleting the `auth.uid() is not null and`
-- prefix is defence in depth plus an empty ratchet set.
create or replace function public.assign_doc_collection(p_doc_id uuid, p_collection_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE id = p_collection_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'collection_not_found'); END IF;

  -- 359: filing a document you cannot edit, into a space you do not administer,
  -- is how a member moves a document somewhere they CAN read it.
  IF NOT public.is_platform_admin() THEN
    IF public.knowledge_effective_level(p_doc_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need edit access to that document');
    END IF;
    IF public.knowledge_my_admin_level(p_collection_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need access to the space you are filing it into');
    END IF;
  END IF;

  INSERT INTO knowledge_doc_collections (tenant_id, doc_id, collection_id)
  VALUES (v_tenant, p_doc_id, p_collection_id)
  ON CONFLICT (doc_id, collection_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $fn$;

-- ── 2.3 unassign_doc_collection ───────────────────────────────────────────
create or replace function public.unassign_doc_collection(p_doc_id uuid, p_collection_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
DECLARE v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_tenant'); END IF;
  -- The original did not even check the document existed.
  IF NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE id = p_doc_id AND tenant_id = v_tenant)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'doc_not_found'); END IF;

  -- 359: THE BYPASS THIS CLOSES. Un-filing rebuilds the ancestry closure, which
  -- nulls restricted_space_id, which lets the workspace-wide grant reach a
  -- document that was in a locked room. Unrestricted by any policy, because
  -- this function is SECURITY DEFINER.
  IF NOT public.is_platform_admin() THEN
    IF public.knowledge_effective_level(p_doc_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need edit access to that document');
    END IF;
    IF public.knowledge_my_admin_level(p_collection_id) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_permission',
                                'detail', 'you need access to the space you are removing it from');
    END IF;
  END IF;

  DELETE FROM knowledge_doc_collections
   WHERE tenant_id = v_tenant AND doc_id = p_doc_id AND collection_id = p_collection_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;

-- ── 2.4 de_certification_status ───────────────────────────────────────────
create or replace function public.de_certification_status(p_de_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_tenant uuid;
  v_current text;
  v_fresh boolean;
  v_has_pass boolean;
  v_disp role_certifications;   -- the cert to DISPLAY (prefer a fresh one)
  v_any  role_certifications;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return jsonb_build_object('state', 'unknown'); end if;
  -- Prefix `auth.uid() is not null and` deleted. Browser-only caller
  -- (src/lib/deWorkbenchApi.ts:308); no service-role path exists.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  if not public.can_access_de(p_de_id) then
    return jsonb_build_object('state', 'unknown');
  end if;

  v_current := public.de_config_fingerprint(p_de_id);

  -- Freshness is decided the SAME way the go-live gate decides it: does ANY
  -- passing cert match the current config fingerprint? (Not "is the newest
  -- passing cert fresh" — two passing certs can share a timestamp.)
  v_fresh := exists (
    select 1 from role_certifications
     where de_id = p_de_id and status = 'passed'
       and config_fingerprint is not distinct from v_current);
  v_has_pass := exists (
    select 1 from role_certifications where de_id = p_de_id and status = 'passed');

  -- Display cert: the matching fresh one if present, else the newest passing.
  select * into v_disp from role_certifications
    where de_id = p_de_id and status = 'passed'
    order by (config_fingerprint is not distinct from v_current) desc,
             evaluated_at desc nulls last, created_at desc limit 1;
  select * into v_any from role_certifications
    where de_id = p_de_id
    order by evaluated_at desc nulls last, created_at desc limit 1;

  return jsonb_build_object(
    'state', case
      when not v_has_pass and v_any.id is null then 'uncertified'
      when not v_has_pass then 'failed'
      when v_fresh then 'certified'
      else 'stale'
    end,
    'fresh', v_fresh,
    'latest_passed', case when v_disp.id is null then null else jsonb_build_object(
      'id', v_disp.id, 'score_pct', v_disp.score_pct, 'threshold_pct', v_disp.threshold_pct,
      'evaluated_at', v_disp.evaluated_at, 'archetype_key', v_disp.archetype_key,
      'certified_fingerprint', v_disp.config_fingerprint) end,
    'current_fingerprint', v_current,
    'latest_status', v_any.status
  );
end;
$fn$;

-- ── 2.5 get_benchmark_report ──────────────────────────────────────────────
create or replace function public.get_benchmark_report(p_tenant_id uuid, p_de_id uuid default null::uuid, p_days integer default 30)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(365, p_days)));
  v_outcomes jsonb; v_quality jsonb; v_csat jsonb; v_cost jsonb; v_sim jsonb; v_review jsonb;
  v_res bigint; v_esc bigint; v_cost_cents numeric;
begin
  -- ⚠ p_tenant_id IS A PARAMETER, SO IT IS NOT AUTHORISATION. The
  -- `auth.uid() is not null and` prefix is deleted: with it, a caller with no
  -- identity read ANY workspace's outcome, quality, CSAT and cost numbers.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  -- Billable resolutions only (a human-handled conversation is not an AI
  -- resolution); escalations and blocks all stay in the denominator.
  select count(*) filter (where kind = 'resolution' and billable),
         count(*) filter (where kind = 'escalation')
    into v_res, v_esc
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at >= v_from
     and evidence_is_production(origin)   -- 682
     and (p_de_id is null or de_id = p_de_id);
  v_outcomes := jsonb_build_object(
    'resolutions', v_res, 'escalations', v_esc,
    'resolution_rate_pct', case when v_res + v_esc > 0 then round(100.0 * v_res / (v_res + v_esc), 1) end);

  -- mig 706: judged_quality counts PROVABLY-production online judgments only.
  -- 682 excluded golden/simulation at this reader; the remaining leak was
  -- upstream — the online sampler graded exam answers and they arrived here
  -- labeled 'online'. The proof standard is now positive: the judgment's
  -- message still exists and its conversation is not on the exam channel.
  select jsonb_build_object(
      'graded', count(*),
      'pass_rate_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where j.verdict = 'pass') / count(*), 1) end,
      'avg_score', case when count(*) > 0 then round(avg(j.score), 1) end)
    into v_quality
    from eval_judgments j
    join de_messages m on m.id = j.message_id
    join de_conversations c on c.id = m.conversation_id
   where j.tenant_id = p_tenant_id and j.created_at >= v_from
     and j.source = 'online'
     and c.channel is distinct from 'exam'
     and (p_de_id is null or j.de_id = p_de_id);

  -- CSAT is a ±1 thumbs field: % positive is the honest statistic (an
  -- "average of 0.33" is meaningless to a reader).
  select jsonb_build_object(
      'ratings', count(*),
      'positive_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where csat_score = 1) / count(*), 1) end)
    into v_csat
    from de_conversations
   where tenant_id = p_tenant_id and csat_submitted_at is not null and csat_submitted_at >= v_from
     and channel is distinct from 'exam'   -- 682
     and (p_de_id is null or de_id = p_de_id);

  select coalesce(sum(
      u.input_tokens  / 1000000.0 * coalesce(pr.input_price_per_million, 0) * 100
    + u.output_tokens / 1000000.0 * coalesce(pr.output_price_per_million, 0) * 100), 0)
    into v_cost_cents
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
   where u.tenant_id = p_tenant_id and u.created_at >= v_from
     and evidence_is_production(u.origin)   -- 682
     and (p_de_id is null or u.de_id = p_de_id);
  v_cost := jsonb_build_object(
    'ai_spend_cents', round(v_cost_cents),
    'cost_per_resolution_cents', case when v_res > 0 then round(v_cost_cents / v_res) end);

  select jsonb_build_object('mode', mode, 'passed', passed, 'total', total,
                            'avg_score', avg_score, 'status', status, 'ran_at', started_at)
    into v_sim
    from sim_runs
   where tenant_id = p_tenant_id and candidate = false and status in ('passed', 'failed')
     and (p_de_id is null or de_id = p_de_id)
   order by started_at desc limit 1;

  -- 691 (G-D): the human side of the COGS, beside the AI side. Tenant-wide
  -- (the modeled minutes attribute per-DE inside the block itself).
  v_review := public.get_review_cost_internal(p_tenant_id, greatest(1, least(365, p_days)));

  return jsonb_build_object(
    'window_days', greatest(1, least(365, p_days)),
    'de_id', p_de_id,
    'generated_at', now(),
    'outcomes', v_outcomes,
    'judged_quality', v_quality,
    'csat', v_csat,
    'cost', v_cost,
    'human_review', v_review,
    'capability', coalesce(v_sim, jsonb_build_object('status', 'no_simulation_yet')),
    'definitions', jsonb_build_object(
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers that were NOT later handed to a human, as a share of ALL metered outcomes in the window — every escalation, hand-off, and guardrail block counts in the denominator. Certification-exam traffic is excluded from numerator and denominator alike (mig 682).',
      'judged_quality', 'Share of graded LIVE answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone. Counts only judgments provably tied to a delivered production message; certification, simulation, and exam-channel grades are excluded — they measure the exam, not the work (migs 682/706).',
      'csat', 'Percent of customer-submitted thumbs ratings that were positive. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend on production traffic in the window divided by billable resolutions delivered.',
      'human_review', 'MODELED, not measured: decided review tasks × founder-editable standard minutes per decision type (exam-origin decisions excluded), divided by landed outputs. Dollars appear only when the workspace baseline (G-A) is on file.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$fn$;

-- ── 2.6 get_outcome_metering ──────────────────────────────────────────────
create or replace function public.get_outcome_metering(p_tenant_id uuid, p_from timestamp with time zone default (now() - '30 days'::interval), p_to timestamp with time zone default now())
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare v_totals jsonb; v_by_de jsonb; v_by_day jsonb; v_price integer;
begin
  -- Prefix deleted: p_tenant_id is a parameter, so it is not authorisation.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
    into v_price;

  select jsonb_build_object(
    'resolutions', count(*) filter (where kind = 'resolution' and billable),
    'escalations', count(*) filter (where kind = 'escalation'),
    'billable_amount_cents', coalesce(sum(unit_price_cents) filter (where billable), 0))
    into v_totals
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at between p_from and p_to
     and evidence_is_production(origin);   -- 682

  select coalesce(jsonb_agg(row_de order by (row_de->>'amount_cents')::bigint desc), '[]'::jsonb) into v_by_de
  from (
    select jsonb_build_object(
      'de_id', b.de_id,
      'name', coalesce(max(d.persona_name), max(d.name), 'Unknown'),
      'resolutions', count(*) filter (where b.kind = 'resolution' and b.billable),
      'escalations', count(*) filter (where b.kind = 'escalation'),
      'amount_cents', coalesce(sum(b.unit_price_cents) filter (where b.billable), 0)) as row_de
    from billable_outcomes b
    left join digital_employees d on d.id = b.de_id
    where b.tenant_id = p_tenant_id and b.occurred_at between p_from and p_to
      and evidence_is_production(b.origin)   -- 682
    group by b.de_id
  ) s;

  select coalesce(jsonb_agg(row_day order by row_day->>'day'), '[]'::jsonb) into v_by_day
  from (
    select jsonb_build_object(
      'day', day_key,
      'resolutions', count(*) filter (where kind = 'resolution' and billable),
      'escalations', count(*) filter (where kind = 'escalation')) as row_day
    from (
      select to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day_key, kind, billable
      from billable_outcomes
      where tenant_id = p_tenant_id and occurred_at between p_from and p_to
        and evidence_is_production(origin)   -- 682
    ) raw
    group by day_key
  ) s;

  return jsonb_build_object('totals', v_totals, 'by_de', v_by_de, 'by_day', v_by_day,
                            'price_per_resolution_cents', v_price);
end;
$fn$;

-- ── 2.7 get_playbook_economics ────────────────────────────────────────────
create or replace function public.get_playbook_economics(p_definition_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_tenant uuid; v_runs int; v_completed int; v_failed int;
  v_cost numeric; v_minutes numeric; v_value numeric;
  v_bl workforce_baselines;
begin
  select tenant_id into v_tenant from playbook_definitions where id = p_definition_id;
  if v_tenant is null then return jsonb_build_object('error', 'not_found'); end if;
  -- Prefix deleted.
  if not exists (
    select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select count(*), count(*) filter (where status = 'completed'), count(*) filter (where status = 'failed')
    into v_runs, v_completed, v_failed
  from playbook_runs where definition_id = p_definition_id;

  select coalesce(sum(a.cost_used_cents), 0) into v_cost
  from agentic_step_runs a
  join playbook_runs r on r.id = a.playbook_run_id
  where r.definition_id = p_definition_id;

  select * into v_bl from workforce_baselines where tenant_id = v_tenant;
  -- mig 708 (§12.3): same rule as get_workforce_economics — the header of the
  -- 191 original called the dollars honest while the minutes on screen came
  -- from coalesce(action_minutes, 15), a number no tenant ever typed. Minutes
  -- now exist only when the tenant's own baseline does.
  v_minutes := case when v_bl.action_minutes is not null then v_completed * v_bl.action_minutes end;
  -- hourly rate implied by the tenant's own monthly FTE cost (160 h/month)
  v_value := case when v_minutes is not null and v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd > 0
    then round((v_minutes / 60.0) * (v_bl.avg_fte_cost_monthly_usd / 160.0), 2) else null end;

  return jsonb_build_object(
    'runs', v_runs, 'completed', v_completed, 'failed', v_failed,
    'completion_pct', case when v_runs > 0 then round(100.0 * v_completed / v_runs, 1) else null end,
    'ai_cost_cents', round(v_cost, 1),
    'human_minutes_saved', case when v_minutes is not null then round(v_minutes, 0) end,
    'est_value_usd', v_value,
    'baseline_configured', v_bl.tenant_id is not null,
    'action_minutes_configured', v_bl.action_minutes is not null
  );
end; $fn$;

-- ── 2.8 get_workforce_economics ───────────────────────────────────────────
create or replace function public.get_workforce_economics(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare v_de_count int; v_pb_runs int; v_pb_done int; v_minutes numeric; v_ai numeric; v_value numeric; v_bl workforce_baselines;
begin
  -- Prefix deleted: p_tenant_id is a parameter, so it is not authorisation.
  if not exists (select 1 from profiles p where p.user_id=auth.uid() and (p.layer='platform' or p.tenant_id=p_tenant_id)) then raise exception 'not authorized'; end if;
  select count(*) into v_de_count from digital_employees where tenant_id=p_tenant_id and lifecycle_status not in ('retired','archived');
  select count(*), count(*) filter (where r.status='completed') into v_pb_runs, v_pb_done from playbook_runs r join playbook_definitions d on d.id=r.definition_id where d.tenant_id=p_tenant_id;
  select coalesce(sum(a.cost_used_cents),0) into v_ai from agentic_step_runs a where a.tenant_id=p_tenant_id;
  select * into v_bl from workforce_baselines where tenant_id=p_tenant_id;
  -- mig 708 (§12.3): minutes exist only as (runs × the tenant's OWN
  -- action_minutes). The old coalesce(action_minutes, 15) was a
  -- platform-invented number wearing the tenant's clothes — for every
  -- unconfigured tenant, i.e. every real one. Unknown renders as null.
  v_minutes := case when v_bl.action_minutes is not null then v_pb_done * v_bl.action_minutes end;
  v_value := case when v_minutes is not null and v_bl.avg_fte_cost_monthly_usd is not null and v_bl.avg_fte_cost_monthly_usd>0 then round((v_minutes/60.0)*(v_bl.avg_fte_cost_monthly_usd/160.0),2) else null end;
  return jsonb_build_object(
    'digital_employees',v_de_count,'playbook_runs',v_pb_runs,'playbook_completed',v_pb_done,
    'ai_cost_usd',round(v_ai/100.0,2),
    'human_minutes_saved',case when v_minutes is not null then round(v_minutes,0) end,
    'est_value_usd',v_value,
    'baseline_configured',v_bl.tenant_id is not null,
    'action_minutes_configured',v_bl.action_minutes is not null);
end; $fn$;

-- ==========================================================================
-- SECTION 3 — GROUP C: no TypeScript caller. Same one-clause deletion.
-- ==========================================================================

-- ── 3.1 apply_improvement ─────────────────────────────────────────────────
create or replace function public.apply_improvement(p_improvement_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare imp de_improvements; v_task_status text; v_doc uuid; v_arch text;
begin
  select * into imp from de_improvements where id = p_improvement_id for update;
  if imp.id is null then raise exception 'improvement not found'; end if;
  -- Prefix deleted. Reached only from trigger trg_sync_improvement on
  -- human_tasks, which fires under the deciding human's auth.uid().
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = imp.tenant_id)) then
    raise exception 'not authorized';
  end if;
  -- DE scoping (mig 385/418). Before the already-applied early return, so a
  -- refused caller is not handed applied_doc_id. de_improvements.de_id is
  -- NOT NULL, so no null case. service_role still passes, by role name.
  if not public.can_access_de(imp.de_id) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;
  if imp.status = 'applied' then return imp.applied_doc_id; end if;
  if imp.status = 'rejected' then raise exception 'improvement was rejected'; end if;

  if imp.human_task_id is null then
    raise exception 'improvement has no review task — call create_improvement_review first';
  end if;
  select status into v_task_status from human_tasks where id = imp.human_task_id;
  if v_task_status is distinct from 'approved' then
    raise exception 'improvement is not human-approved (review task status: %) — a proposed fix can only be published after explicit approval', coalesce(v_task_status, 'missing');
  end if;

  -- T2.2: publish at role scope when the human chose it AND the DE's archetype
  -- resolves; otherwise the unchanged de-scoped path (today's behavior).
  v_arch := case when imp.publish_scope = 'role' then resolve_de_archetype(imp.de_id) end;
  if imp.publish_scope = 'role' and v_arch is not null then
    insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags, share_archetype_key)
    values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'role', true,
            array['self-improvement','team-learning'], v_arch)
    returning id into v_doc;
  else
    insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags)
    values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'scoped', true,
            array['self-improvement'])
    returning id into v_doc;
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (imp.tenant_id, v_doc, 'de', imp.de_id);
  end if;

  -- Chunk the published doc NOW, server-side (mig 481): this path fires from
  -- a trigger with no client to compensate, and nothing in the platform hunts
  -- for docs with zero chunks — unchunked here means keyword-only retrieval
  -- forever. Embeddings stay NULL; embed-backfill drains them within minutes.
  perform public.chunk_knowledge_doc_internal(v_doc);

  update de_improvements set status = 'applied', applied_doc_id = v_doc, updated_at = now()
   where id = p_improvement_id;

  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  select imp.tenant_id, coalesce(d.persona_name, d.name, 'DE'), 'system', 'config_change',
    format('Approved self-improvement published: "%s" (%s). Proposed from a failed answer, verified by replay, human-approved.',
           imp.proposed_title, case when imp.publish_scope = 'role' and v_arch is not null then 'shared with all '||v_arch||' employees' else 'scoped to '||coalesce(d.persona_name, d.name, 'this employee') end),
    coalesce((imp.replay->'after'->>'score')::numeric, 0)
  from digital_employees d where d.id = imp.de_id;

  return v_doc;
end;
$fn$;

-- ── 3.2 reject_improvement ────────────────────────────────────────────────
create or replace function public.reject_improvement(p_improvement_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from de_improvements where id = p_improvement_id;
  if v_tenant is null then raise exception 'improvement not found'; end if;
  -- Prefix deleted. Same trigger caller as apply_improvement.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  update de_improvements set status = 'rejected', updated_at = now()
   where id = p_improvement_id and status in ('review_pending','replayed');
  if not found then raise exception 'improvement not in a rejectable state'; end if;
end;
$fn$;

-- ── 3.3 certify_de_from_sim ───────────────────────────────────────────────
create or replace function public.certify_de_from_sim(p_de_id uuid, p_archetype_key text, p_sim_run_id uuid, p_threshold_pct integer default 80)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_tenant uuid; v_run sim_runs; v_pct numeric; v_status text; v_threshold integer; v_fp text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  -- Prefix deleted. No caller anywhere — reported as a retirement candidate
  -- rather than left as a live SECDEF writer nothing calls.
  if not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  -- The archetype's bar governs; the caller's p_threshold_pct is IGNORED
  -- (kept only for signature compatibility) — a threshold of 0 could mint
  -- a passing cert from any finished run (C2).
  select coalesce((select pass_threshold_pct from role_archetypes where key = p_archetype_key), 80)
    into v_threshold;

  select * into v_run from sim_runs
    where id = p_sim_run_id and tenant_id = v_tenant and de_id = p_de_id
      and status in ('passed', 'failed') and candidate = false;
  if v_run.id is null or v_run.total = 0 then
    raise exception 'simulation has no results (or is a candidate dry-run, which cannot certify)';
  end if;
  v_pct := round(100.0 * v_run.passed / v_run.total, 1);
  v_status := case when v_pct >= v_threshold then 'passed' else 'failed' end;
  -- The cert vouches for the config the run actually TESTED (C3).
  v_fp := coalesce(v_run.config_fingerprint, public.de_config_fingerprint(p_de_id));

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, null, v_pct, v_threshold, v_status, now(), v_fp);

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', v_threshold,
                            'passed', v_run.passed, 'total', v_run.total, 'from', 'simulation');
end;
$fn$;

-- ── 3.4 resolve_de_exception ──────────────────────────────────────────────
create or replace function public.resolve_de_exception(p_id uuid, p_status text, p_outcome text default null::text, p_learned boolean default false)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
begin
  -- Prefix deleted. No caller anywhere; retirement candidate.
  if not exists (
      select 1 from de_exceptions e join profiles p on p.user_id = auth.uid()
      where e.id = p_id and (p.tenant_id = e.tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized';
  end if;
  update de_exceptions
     set status = p_status, outcome = p_outcome, learned = coalesce(p_learned, false),
         decided_by = auth.uid(), decided_at = now()
   where id = p_id;
end;
$fn$;

-- ── 3.5 publish_platform_shelf_doc ────────────────────────────────────────
-- ⚠ AFTER THIS, CALLABLE BY NOBODY, and that is the correct end state for an
-- unreachable platform-shelf writer: `authenticated` holds no EXECUTE (pinned
-- by tests/knowledge-acl-invariants.test.ts:244 and NOT to be granted), and
-- is_platform_admin() is false for service_role by construction. Reported as a
-- retirement candidate.
create or replace function public.publish_platform_shelf_doc(p_doc_id uuid, p_title text, p_content text, p_source_change_id uuid default null::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
DECLARE v_old platform_knowledge_docs; v_new uuid; v_mig text;
BEGIN
  -- 342: the shelf is global. A tenant user editing it would rewrite the
  -- product guide that every OTHER tenant is answered from. Prefix deleted.
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'only platform administrators can publish to the shared shelf';
  END IF;
  SELECT * INTO v_old FROM platform_knowledge_docs WHERE id = p_doc_id AND is_current;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'shelf document not found or not current'; END IF;
  IF p_content IS NULL OR length(btrim(p_content)) = 0 THEN
    RAISE EXCEPTION 'refusing to publish an empty article';
  END IF;

  SELECT source_ref INTO v_mig FROM platform_kb_changes WHERE id = p_source_change_id;

  UPDATE platform_knowledge_docs SET is_current = false, updated_at = now() WHERE id = p_doc_id;

  INSERT INTO platform_knowledge_docs (
    title, content, topic, tags, authority, is_current, version, previous_version_id,
    source_doc_path, source_migration, last_verified_at, published_at)
  VALUES (
    coalesce(nullif(btrim(p_title), ''), v_old.title), p_content, v_old.topic, v_old.tags,
    v_old.authority, true, v_old.version + 1, v_old.id,
    v_old.source_doc_path, coalesce(v_mig, v_old.source_migration), now(), now())
  RETURNING id INTO v_new;

  -- Carry the chunks forward, flagged for re-embedding. Retrieval keeps working
  -- on the old vectors until the drain catches up rather than going blind.
  INSERT INTO platform_knowledge_chunks (doc_id, chunk_index, content, embedding, reembed_pending)
  SELECT v_new, c.chunk_index, c.content, c.embedding, true
    FROM platform_knowledge_chunks c WHERE c.doc_id = p_doc_id;

  IF p_source_change_id IS NOT NULL THEN
    UPDATE platform_kb_changes
       SET status = 'reviewed', reviewed_at = now(), reviewed_by = auth.uid()
     WHERE id = p_source_change_id;
  END IF;

  RETURN v_new;
END $fn$;

-- ── 3.6 dismiss_platform_kb_change ────────────────────────────────────────
create or replace function public.dismiss_platform_kb_change(p_change_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
BEGIN
  -- Prefix deleted. Same reachability note as publish_platform_shelf_doc.
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'only platform administrators can manage the shelf review queue';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'say why this change needs no documentation update';
  END IF;
  UPDATE platform_kb_changes
     SET status = 'dismissed', dismiss_reason = btrim(p_reason),
         reviewed_at = now(), reviewed_by = auth.uid()
   WHERE id = p_change_id;
END $fn$;

-- ── 3.7 search_knowledge ──────────────────────────────────────────────────
-- ⚠ ALREADY FAILED CLOSED — see the header. The second disjunct names
-- service_role EXPLICITLY, which is the correct shape and is left exactly as
-- it stands. Deleting the `auth.uid() is not null and` prefix from the FIRST
-- disjunct is a provable no-op (a null uid makes the membership subquery
-- empty), done so the ratchet's expected set is empty rather than pinned.
create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_audience text default null::text, p_limit integer default 5)
 returns table(id uuid, title text, summary text, body text, audience text, category text, tags text[], rank real)
 language sql
 stable
 security definer
 set search_path to 'public'
as $fn$
  select ka.id, ka.title, ka.summary, ka.body, ka.audience, ka.category, ka.tags,
         ts_rank(ka.search_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.knowledge_articles ka
  where ka.tenant_id = p_tenant_id
    and (
      (p_tenant_id in (select tenant_id from public.profiles where user_id = auth.uid() and coalesce(is_active, true) = true))
      or (auth.uid() is null and coalesce(auth.role(), '') = 'service_role')
    )
    and ka.status = 'published'
    and (p_audience is null or ka.audience = p_audience or ka.audience = 'all')
    and ka.search_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit greatest(p_limit, 1);
$fn$;

-- ==========================================================================
-- SECTION 3c — THE EIGHT THE FIRST SWEEP'S PREDICATE COULD NOT SEE.
--
-- Six of these are invisible to `ilike '%auth.uid() is not null and%'` because
-- the defect spans a line break; two carry the WRAPPING form instead of the
-- flat one. See the header for the measurement (21 vs 27 vs 29) and for the
-- mutation that proved the old predicate blind.
--
-- Same three-way treatment as sections 1-3, and each choice is made from the
-- call sites enumerated in the header, not from the shape of the body:
--   · a real service-role caller  -> _internal split + the edge function repointed
--   · browser-only or caller-less -> the identity test deleted outright
--
-- ⚠⚠ DEPLOY ORDERING, AGAIN AND FOR MORE FUNCTIONS THAN SECTION 1. This
-- section REVOKES service_role on de_memory_write, de_memory_search,
-- run_analytics_query, set_de_objective_status and assess_definition_of_done.
-- Between applying it and deploying, every one of those calls returns
--     permission denied for function <name>
-- SEVEN MORE EDGE FUNCTIONS MUST SHIP WITH THIS MIGRATION, on top of the four
-- section 1 already named: de-answer, de-memory, de-orchestrate, connector-hub,
-- agentic-step-execute, widget-ask and de-work (already in the list). The last
-- three are there because of the two SHARED modules — _shared/identityMemory.ts
-- and _shared/defOfDone.ts — which are compiled INTO each importer, so editing
-- a shared file changes every function that imports it and none that are not
-- redeployed.
-- ==========================================================================

-- ── 3c.1 de_memory_write ──────────────────────────────────────────────────
-- WRITER, takes a tenant id as a parameter: the archetypal shape. FLAT form,
-- line-broken, invisible to the first sweep.
create or replace function public.de_memory_write_internal(
  p_tenant_id uuid,
  p_de_id uuid,
  p_content text,
  p_embedding vector default null::vector,
  p_subject_kind text default 'general'::text,
  p_subject_ref text default null::text,
  p_kind text default 'episodic'::text,
  p_salience numeric default 0.5,
  p_source text default 'de'::text,
  p_expires_at timestamp with time zone default null::timestamp with time zone
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
begin
  -- NO USER CHECK, ON PURPOSE. Five edge functions write DE memory with the
  -- service-role admin client and have no signed-in person to check.
  -- EXECUTE is service_role only.
  if p_content is null or btrim(p_content) = '' then
    raise exception 'memory content required';
  end if;

  insert into de_memory (tenant_id, de_id, subject_kind, subject_ref, kind,
                         content, embedding, salience, source, expires_at)
  values (p_tenant_id, p_de_id, p_subject_kind, p_subject_ref, p_kind,
          p_content, p_embedding, greatest(0, least(1, coalesce(p_salience, 0.5))),
          p_source, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.de_memory_write_internal(uuid, uuid, text, vector, text, text, text, numeric, text, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.de_memory_write_internal(uuid, uuid, text, vector, text, text, text, numeric, text, timestamp with time zone)
  to service_role;

create or replace function public.de_memory_write(
  p_tenant_id uuid,
  p_de_id uuid,
  p_content text,
  p_embedding vector default null::vector,
  p_subject_kind text default 'general'::text,
  p_subject_ref text default null::text,
  p_kind text default 'episodic'::text,
  p_salience numeric default 0.5,
  p_source text default 'de'::text,
  p_expires_at timestamp with time zone default null::timestamp with time zone
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- The body's old comment said the identity test was deliberate — "auth.uid()
  -- is null under service_role, so the membership check is skipped for it".
  -- That is a true description of a fail-open guard, written as if it were a
  -- design. The service path now has its own function; this name refuses.
  if auth.uid() is null then
    raise exception 'not authenticated: writing DE memory for a workspace named in a parameter is not an anonymous operation';
  end if;
  if not exists (select 1 from profiles p where p.user_id = auth.uid()
                   and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to write memory for this tenant';
  end if;
  return public.de_memory_write_internal(p_tenant_id, p_de_id, p_content, p_embedding,
                                         p_subject_kind, p_subject_ref, p_kind,
                                         p_salience, p_source, p_expires_at);
end;
$fn$;

-- ⚠ `authenticated` KEEPS its grant and service_role LOSES it. The browser
-- reaches this name only through handoff_back_to_de and decide_de_exception,
-- which are SECURITY DEFINER and therefore call it as the owner — but they
-- carry the browser's auth.uid(), so the membership check above is the one
-- that decides, exactly as it did before this migration for a non-null uid.
revoke all on function public.de_memory_write(uuid, uuid, text, vector, text, text, text, numeric, text, timestamp with time zone)
  from public, anon, service_role;
grant execute on function public.de_memory_write(uuid, uuid, text, vector, text, text, text, numeric, text, timestamp with time zone)
  to authenticated;

-- ── 3c.2 de_memory_search ─────────────────────────────────────────────────
create or replace function public.de_memory_search_internal(
  p_tenant_id uuid,
  p_de_id uuid,
  p_query_embedding vector default null::vector,
  p_subject_kind text default null::text,
  p_subject_ref text default null::text,
  p_kinds text[] default null::text[],
  p_match_count integer default 8
) returns table(id uuid, content text, kind text, subject_kind text, subject_ref text,
                salience numeric, distance double precision, created_at timestamp with time zone)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- NO USER CHECK. Four edge functions recall DE memory with the service-role
  -- admin client. EXECUTE is service_role only.
  return query
  select m.id, m.content, m.kind, m.subject_kind, m.subject_ref, m.salience,
         case when p_query_embedding is not null and m.embedding is not null
              then (m.embedding <=> p_query_embedding)::float else null end as distance,
         m.created_at
  from de_memory m
  where m.tenant_id = p_tenant_id
    and m.de_id = p_de_id
    and (m.expires_at is null or m.expires_at > now())
    and (p_subject_kind is null or m.subject_kind = p_subject_kind)
    and (p_subject_ref  is null or m.subject_ref  = p_subject_ref)
    and (p_kinds is null or m.kind = any(p_kinds))
  order by
    -- lower is better: semantic distance when available, else a recency+
    -- salience proxy (newer & more salient sort first).
    coalesce(case when p_query_embedding is not null and m.embedding is not null
                  then (m.embedding <=> p_query_embedding)::float end,
             1.0 - m.salience
               + least(0.5, extract(epoch from (now() - m.created_at)) / (86400.0 * 60)))
    asc
  limit greatest(1, least(50, p_match_count));
end;
$fn$;

revoke all on function public.de_memory_search_internal(uuid, uuid, vector, text, text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.de_memory_search_internal(uuid, uuid, vector, text, text, text[], integer)
  to service_role;

create or replace function public.de_memory_search(
  p_tenant_id uuid,
  p_de_id uuid,
  p_query_embedding vector default null::vector,
  p_subject_kind text default null::text,
  p_subject_ref text default null::text,
  p_kinds text[] default null::text[],
  p_match_count integer default 8
) returns table(id uuid, content text, kind text, subject_kind text, subject_ref text,
                salience numeric, distance double precision, created_at timestamp with time zone)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated: reading DE memory for a workspace named in a parameter is not an anonymous operation';
  end if;
  if not exists (select 1 from profiles p where p.user_id = auth.uid()
                   and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to read memory for this tenant';
  end if;
  return query select * from public.de_memory_search_internal(
    p_tenant_id, p_de_id, p_query_embedding, p_subject_kind, p_subject_ref,
    p_kinds, p_match_count);
end;
$fn$;

revoke all on function public.de_memory_search(uuid, uuid, vector, text, text, text[], integer)
  from public, anon, service_role;
grant execute on function public.de_memory_search(uuid, uuid, vector, text, text, text[], integer)
  to authenticated;

-- ── 3c.3 run_analytics_query ──────────────────────────────────────────────
-- ⚠ THE ONE PROVEN LIVE. See the header: with a session it refused, without
-- one it answered.
create or replace function public.run_analytics_query_internal(
  p_tenant_id uuid,
  p_key text,
  p_params jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- NO USER CHECK. de-work/index.ts:824 runs the DE's `run_analytics` tool on
  -- the service-role admin client. EXECUTE is service_role only.
  return case p_key
    when 'de_workload'   then public.analytics_de_workload(p_tenant_id, (p_params->>'de_id')::uuid)
    when 'action_volume' then public.analytics_action_volume(p_tenant_id, coalesce((p_params->>'days')::int, 30))
    else jsonb_build_object('error', 'unknown_query_key', 'key', p_key)
  end;
end;
$fn$;

revoke all on function public.run_analytics_query_internal(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.run_analytics_query_internal(uuid, text, jsonb)
  to service_role;

create or replace function public.run_analytics_query(
  p_tenant_id uuid,
  p_key text,
  p_params jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated: running an analytics query against a workspace named in a parameter is not an anonymous operation';
  end if;
  if not exists (select 1 from profiles p where p.user_id = auth.uid()
                   and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized for this tenant';
  end if;
  return public.run_analytics_query_internal(p_tenant_id, p_key, p_params);
end;
$fn$;

revoke all on function public.run_analytics_query(uuid, text, jsonb)
  from public, anon, service_role;
grant execute on function public.run_analytics_query(uuid, text, jsonb)
  to authenticated;

-- ── 3c.4 set_de_objective_status ──────────────────────────────────────────
-- WRAPPING form. A WRITER with three call sites in de-work.
create or replace function public.set_de_objective_status_internal(
  p_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- NO USER CHECK. de-work drives the objective lifecycle on the service-role
  -- admin client (index.ts:265, :328, :2147). EXECUTE is service_role only.
  update de_objectives set status = p_status, updated_at = now() where id = p_id;
end;
$fn$;

revoke all on function public.set_de_objective_status_internal(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_de_objective_status_internal(uuid, text)
  to service_role;

create or replace function public.set_de_objective_status(
  p_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated: setting an objective''s status is not an anonymous operation';
  end if;
  if not exists (select 1 from de_objectives o join profiles p on p.user_id = auth.uid()
                  where o.id = p_id and (p.tenant_id = o.tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized';
  end if;
  perform public.set_de_objective_status_internal(p_id, p_status);
end;
$fn$;

revoke all on function public.set_de_objective_status(uuid, text)
  from public, anon, service_role;
grant execute on function public.set_de_objective_status(uuid, text)
  to authenticated;

-- ── 3c.5 assess_definition_of_done ────────────────────────────────────────
-- ⚠ ITS OLD COMMENT ARGUED FOR THE DEFECT IN SO MANY WORDS: "The auth.uid()
-- prefix is deliberate and load-bearing: connector-hub and _shared/defOfDone.ts
-- call this with the SERVICE ROLE, whose JWT has no sub". The need was real;
-- the answer was a fail-open guard. The need is now met by a separate function
-- and the guard is allowed to refuse.
--
-- ⚠ AND THE PART THE BRIEF GOT WRONG, MEASURED: "service-role-only by grant, so
-- removing the prefix costs nothing" is FALSE HERE. Delete the prefix outright
-- and the remaining `not exists (… user_id = auth.uid() …)` is TRUE for a null
-- uid, so every one of its four service-role call sites would start raising
-- 'not authorized for this workspace'. That is a feature break reported as a
-- security fix — the exact failure this repo has a rule about. It splits.
create or replace function public.assess_definition_of_done_internal(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_objective_id uuid default null::uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_pending int := 0;
  v_unresolved boolean := false;
  v_gated_task uuid;
begin
  -- NO USER CHECK. connector-hub:7438 and _shared/defOfDone.ts:39 assess with
  -- the service-role admin client. EXECUTE is service_role only.

  -- (a) origin-scoped gated actions: pending = a gated row whose task is still
  --     'pending', OR 'approved' but with nothing that LANDED resolving it.
  --     ⚠ migs 678 + 679. The resolving test used to be a blacklist — anything
  --     not marked as a failure — which a row satisfies the instant the
  --     approval is CLAIMED, before the external call, and which a voided
  --     tombstone satisfies forever. It is now THE shared proof-of-landing.
  select count(*) into v_pending
    from action_executions ae
    join human_tasks ht on ht.id = ae.task_id
   where ae.tenant_id = p_tenant_id and ae.origin_kind = p_scope and ae.origin_id = p_scope_id
     and ae.decision in ('human_gated_destructive','human_gated_trust')
     and ( ht.status = 'pending'
        or ( ht.status = 'approved'
             and not exists (select 1 from action_executions ex
                              where ex.resolves_task_id = ae.task_id
                                and public.action_execution_landed(ex)) ) );

  -- (b) account / opportunity write-backs on this objective.
  if p_objective_id is not null then
    v_pending := v_pending
      + (select count(*) from account_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval')
      + (select count(*) from opportunity_writeback_requests w where w.tenant_id = p_tenant_id and w.objective_id = p_objective_id and w.status = 'pending_approval');
  end if;

  -- (c) outbound drafts scoped to this run/item.
  v_pending := v_pending
    + (select count(*) from outbound_drafts d where d.tenant_id = p_tenant_id and d.source_kind = p_scope and d.source_ref = p_scope_id and d.status = 'pending_approval');

  -- (d) fail-CLOSED anchor: an agentic run that flagged a gate whose task is not
  --     resolved by a LANDED execution is 'unresolved' even if origin wasn't
  --     threaded — so a missing correlation can never pass as "nothing pending".
  --     Same shared predicate as (a), and now identical BY CONSTRUCTION rather
  --     than by two copies happening to agree.
  if p_scope = 'agentic_run' then
    select last_gated_human_task_id into v_gated_task from agentic_step_runs where id = p_scope_id and tenant_id = p_tenant_id;
    if v_gated_task is not null
       and not exists (select 1 from action_executions ex
                        where ex.resolves_task_id = v_gated_task
                          and public.action_execution_landed(ex)) then
      v_unresolved := true;
    end if;
  end if;

  return jsonb_build_object(
    'verified', (coalesce(v_pending, 0) = 0) and not v_unresolved,
    'pending_count', coalesce(v_pending, 0),
    'unresolved', v_unresolved,
    'detail', jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'objective_id', p_objective_id)
  );
end $fn$;

revoke all on function public.assess_definition_of_done_internal(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assess_definition_of_done_internal(uuid, text, uuid, uuid)
  to service_role;

create or replace function public.assess_definition_of_done(
  p_tenant_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_objective_id uuid default null::uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- ⚠ REACHABLE BY NOBODY AFTER THIS MIGRATION, and deliberately so — the same
  -- answer, for the same reason, as the three ingestion wrappers in section 1.
  -- `authenticated` has never held EXECUTE here (mig 678 asserted it), so this
  -- membership bar has never been able to fire; granting it now would be a
  -- widening smuggled in beside a narrowing. The body refuses instead of waving
  -- through, which makes handing this name to a UI a one-line decision later
  -- rather than a re-audit. Retirement candidate, reported not hidden.
  --
  -- ⚠ ITS ONE SQL CALLER, conclude_objective_verified, IS LEFT POINTING HERE
  -- rather than at the _internal. It has no caller anywhere in the repo today;
  -- if it is ever revived on a service-role path it will refuse loudly, which
  -- is the failure everyone sees, instead of reading another workspace quietly,
  -- which is the failure nobody does.
  if auth.uid() is null then
    raise exception 'not authenticated: assessing definition-of-done for a workspace named in a parameter is not an anonymous operation';
  end if;
  if not exists (select 1 from profiles p where p.user_id = auth.uid()
                   and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized for this workspace';
  end if;
  return public.assess_definition_of_done_internal(p_tenant_id, p_scope, p_scope_id, p_objective_id);
end $fn$;

revoke all on function public.assess_definition_of_done(uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ── 3c.6 enqueue_conflict_backlog ─────────────────────────────────────────
-- THE CLEAREST LINE-BREAK CASE: `IF auth.uid() IS NOT NULL` and `AND NOT (...)`
-- on separate lines, which is why the literal sweep never saw it. No caller
-- anywhere — not TypeScript, not SQL — so there is no service path to preserve
-- and the identity test simply goes.
--
-- ⚠ THE DELETION IS ONLY FAIL-CLOSED BECAUSE THE HELPERS RETURN false, NOT
-- NULL, AND THAT WAS MEASURED RATHER THAN ASSUMED (header). With a null uid:
-- auth_tenant_id() -> NULL, auth_has_tenant_role(...) -> false, so
-- `NULL and false` -> false and `not false` -> TRUE. It returns 'forbidden'.
-- Had auth_has_tenant_role returned NULL instead, `not (NULL and NULL)` is NULL
-- and `IF NULL THEN` does not fire — the guard would have looked fixed and
-- stayed open.
create or replace function public.enqueue_conflict_backlog(
  p_tenant_id uuid,
  p_limit integer default 500,
  p_after_chunk_id uuid default null::uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
DECLARE v_n int; v_last uuid;
BEGIN
  IF NOT (p_tenant_id = auth_tenant_id()
          AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF NOT is_feature_enabled_internal(p_tenant_id, 'knowledge_conflict_detection') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'detection_disabled');
  END IF;
  WITH batch AS (
    SELECT c.id, c.doc_id, c.tenant_id, c.content_hash
    FROM knowledge_doc_chunks c
    WHERE c.tenant_id = p_tenant_id AND c.embedding IS NOT NULL
      AND (p_after_chunk_id IS NULL OR c.id > p_after_chunk_id)
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
  ), ins AS (
    INSERT INTO knowledge_conflict_probe_queue (tenant_id, chunk_id, doc_id, content_hash)
    SELECT b.tenant_id, b.id, b.doc_id, b.content_hash FROM batch b
    ON CONFLICT (tenant_id, chunk_id) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1)   -- keyset watermark (no max(uuid))
    INTO v_n, v_last;
  RETURN jsonb_build_object('ok', true, 'seeded', coalesce(v_n, 0), 'last_chunk_id', v_last);
END $fn$;

revoke all on function public.enqueue_conflict_backlog(uuid, integer, uuid) from public, anon;
grant execute on function public.enqueue_conflict_backlog(uuid, integer, uuid) to authenticated, service_role;

-- ── 3c.7 resolve_action_execution_for_task ────────────────────────────────
-- Browser only (src/lib/connectorApi.ts:1591). ⚠ THIS FUNCTION HAS BEEN HERE
-- BEFORE: docs/PROTOTYPE-PRODUCTION-BOUNDARY.md records it as one of three
-- proven anon-exploitable reads, fixed by revoking anon rather than by fixing
-- the guard — and its note says the extra `and not is_platform_admin()` clause
-- "looks like it has an extra safety clause, but the whole condition is still
-- false when auth.uid() IS NULL, so the extra clause never matters". The guard
-- is finally repaired rather than merely made unreachable.
--
-- ⚠ AGAIN THE 3VL QUESTION, MEASURED: with a null uid the membership subquery
-- is empty so `not in (empty)` is TRUE, and resolve_platform_capability(NULL,
-- 'support.cross_tenant') returns false — NOT null — so `not false` is TRUE.
-- TRUE and TRUE raises. Deleting the identity test genuinely closes it.
create or replace function public.resolve_action_execution_for_task(p_task_id uuid)
returns action_executions
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_task_tenant uuid;
  v_row action_executions;
begin
  select tenant_id into v_task_tenant from human_tasks where id = p_task_id;
  if v_task_tenant is null then
    return null;
  end if;
  if v_task_tenant not in (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true)
     and not resolve_platform_capability(auth.uid(), 'support.cross_tenant') then
    raise exception 'tenant access denied';
  end if;
  select ae.* into v_row from action_executions ae
    where ae.task_id = p_task_id and ae.tenant_id = v_task_tenant
    order by ae.created_at desc limit 1;
  -- DE scoping (mig 385/427). A READER, so it filters rather than raising:
  -- an action the caller may not see returns NULL, exactly as a task that
  -- does not exist already does. Scoped on the ACTION subject, not on
  -- human_tasks.de_id, which is NULL on 82% of rows.
  if v_row.id is not null and v_row.subject_kind = 'de'
     and v_row.subject_id is not null
     and not public.can_access_de(v_row.subject_id) then
    return null;
  end if;
  return v_row;
end;
$fn$;

revoke all on function public.resolve_action_execution_for_task(uuid) from public, anon;
grant execute on function public.resolve_action_execution_for_task(uuid) to authenticated, service_role;

-- ── 3c.8 verify_extraction_result ─────────────────────────────────────────
-- WRAPPING form, and a WRITER. No caller anywhere — not TypeScript, not SQL —
-- so the outer identity gate simply goes and the inner authority test becomes
-- the whole guard.
create or replace function public.verify_extraction_result(
  p_id uuid,
  p_corrections jsonb default null::jsonb
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if not exists (select 1 from extraction_results r join profiles p on p.user_id = auth.uid()
                  where r.id = p_id and (p.tenant_id = r.tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized';
  end if;
  update extraction_results
     set extracted = coalesce(p_corrections, extracted),
         verified = true, verified_by = auth.uid(), verified_at = now()
   where id = p_id;
end;
$fn$;

revoke all on function public.verify_extraction_result(uuid, jsonb) from public, anon;
grant execute on function public.verify_extraction_result(uuid, jsonb) to authenticated, service_role;

-- ── 3c.9 THE TWO THAT ARE LEFT ALONE, AND WHY THAT IS THE FINDING ─────────
-- probe_chunk_neighbors and record_knowledge_conflict were handed to this
-- migration as carriers to be fixed. They are NOT carriers. Both open with
--
--     IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION '<name>: service role only'; END IF;
--
-- which is FAIL-CLOSED: it refuses every caller that HAS an identity, and is
-- the correct guard for a function only conflict-probe-drain calls. Deleting it
-- because a pattern-matcher grouped it with the fail-open shape would have
-- opened both to every signed-in user, inside a migration whose subject is
-- closing an authority hole. They are recorded in
-- scripts/secdef-authority-prefix.mjs :: CLASSIFIED_NON_DEFECTS with that
-- argument — pinned symmetrically, so the day either one stops carrying the
-- shape, or starts carrying the real defect, the ratchet says so.
-- No DDL here on purpose. This block IS the change.

-- ==========================================================================
-- SECTION 3b — THE GROUP B AND C GRANTS, RESTATED RATHER THAN ASSUMED.
--
-- ⚠ ON THIS DATABASE EVERY LINE BELOW IS A NO-OP, and it is here for the OTHER
-- database. CREATE OR REPLACE preserves the ACL on a function that already
-- exists — measured, e.g. get_workforce_economics is
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} — but
-- on a FRESH one it CREATES the function, and a newly created function is born
-- with the default PUBLIC EXECUTE grant (migs 610/630). That is not
-- hypothetical here: migrations 715 and 717 are in the production ledger and
-- ABSENT from HEAD, so a rebuilt environment cannot be assumed to have run the
-- migration that granted these in the first place, and probe 4 would then
-- correctly refuse to apply this one. Restating the MEASURED matrix makes the
-- rebuild produce the same perimeter as production instead.
--
-- Nothing here widens anything: every line is today's live ACL, read off
-- pg_proc.proacl on 2026-08-16, written down.
-- ==========================================================================
revoke all on function public.apply_trust_promotion(uuid, text) from public, anon;
grant execute on function public.apply_trust_promotion(uuid, text) to authenticated, service_role;

revoke all on function public.assign_doc_collection(uuid, uuid) from public, anon;
grant execute on function public.assign_doc_collection(uuid, uuid) to authenticated, service_role;

revoke all on function public.unassign_doc_collection(uuid, uuid) from public, anon;
grant execute on function public.unassign_doc_collection(uuid, uuid) to authenticated, service_role;

revoke all on function public.de_certification_status(uuid) from public, anon;
grant execute on function public.de_certification_status(uuid) to authenticated, service_role;

revoke all on function public.get_benchmark_report(uuid, uuid, integer) from public, anon;
grant execute on function public.get_benchmark_report(uuid, uuid, integer) to authenticated, service_role;

revoke all on function public.get_outcome_metering(uuid, timestamp with time zone, timestamp with time zone) from public, anon;
grant execute on function public.get_outcome_metering(uuid, timestamp with time zone, timestamp with time zone) to authenticated, service_role;

revoke all on function public.get_playbook_economics(uuid) from public, anon;
grant execute on function public.get_playbook_economics(uuid) to authenticated, service_role;

revoke all on function public.get_workforce_economics(uuid) from public, anon;
grant execute on function public.get_workforce_economics(uuid) to authenticated, service_role;

revoke all on function public.apply_improvement(uuid) from public, anon;
grant execute on function public.apply_improvement(uuid) to authenticated, service_role;

revoke all on function public.reject_improvement(uuid) from public, anon;
grant execute on function public.reject_improvement(uuid) to authenticated, service_role;

revoke all on function public.certify_de_from_sim(uuid, text, uuid, integer) from public, anon;
grant execute on function public.certify_de_from_sim(uuid, text, uuid, integer) to authenticated, service_role;

revoke all on function public.resolve_de_exception(uuid, text, text, boolean) from public, anon;
grant execute on function public.resolve_de_exception(uuid, text, text, boolean) to authenticated, service_role;

revoke all on function public.search_knowledge(uuid, text, text, integer) from public, anon;
grant execute on function public.search_knowledge(uuid, text, text, integer) to authenticated, service_role;

-- ⚠ THE TWO PLATFORM-SHELF WRITERS: `authenticated` is REVOKED, not granted,
-- and that is pinned live by tests/knowledge-acl-invariants.test.ts:244 —
-- migration 338 had to fix exactly this after 334 wrote "public, anon" where it
-- meant "public, anon, authenticated", and one word let any logged-in user
-- rewrite the product guide every workspace is answered from.
revoke all on function public.publish_platform_shelf_doc(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.publish_platform_shelf_doc(uuid, text, text, uuid) to service_role;

revoke all on function public.dismiss_platform_kb_change(uuid, text) from public, anon, authenticated;
grant execute on function public.dismiss_platform_kb_change(uuid, text) to service_role;

-- ==========================================================================
-- SECTION 4 — VERIFICATION. Every pin inverted, every probe rolled back.
--
-- ⚠ `v_bad := v_bad || 'literal'` is BANNED here (22P02 the moment a branch
-- fires — mig 685/741, scripts/migration-append-check.mjs). array_append only.
-- ==========================================================================
do $verify$
declare
  v_bad     text[] := array[]::text[];
  v_checks  integer := 0;
  v_probes  integer := 0;
  v_caller  text;
  v_seen    text;

  -- fixtures
  v_tenant       uuid; v_owner_uid uuid;
  v_de           uuid;
  v_eval_tenant  uuid; v_eval_run uuid; v_eval_de uuid; v_arch text;
  v_exc          uuid; v_exc_tenant uuid; v_exc_uid uuid; v_exc_status text;
  v_imp          uuid;
  v_sim_de       uuid;
  -- SECTION 3c fixtures
  v_obj          uuid; v_obj_status text;
  v_task         uuid;
  -- ⚠ THE KNOWLEDGE CORPUS FIXTURE, and the reason it is a fixture at all:
  -- the search_knowledge arm used to run against v_tenant, which holds ZERO
  -- knowledge_articles. All 3 rows platform-wide sit in ONE workspace. The
  -- arm asserted "0 rows returned" against an empty table, so deleting
  -- search_knowledge's entire authority predicate left it passing. A probe
  -- that cannot distinguish a refusal from an empty shelf proves nothing.
  v_ka_tenant    uuid; v_ka_member uuid; v_ka_query text; v_ka_rows bigint;

  -- baselines
  v_wi_before   bigint; v_wi_after   bigint;
  v_cert_before bigint; v_cert_after bigint;
  v_exc_before  bigint; v_exc_after  bigint;
  v_doc_before  bigint; v_doc_after  bigint;

  -- probe scratch
  v_uid_now  uuid;
  v_ref      boolean; v_msg text;
  v_d        boolean;
  v_bool     boolean;
  v_jsonb    jsonb;
  v_uuid     uuid;
  v_n        bigint;
  v_txt      text;

  v_p1_created bigint;
  v_p3_ok      integer := 0;

  -- static sweep
  v_secdef_total    bigint;
  v_secdef_stripped bigint;
  v_secdef_naive    bigint;
  v_secdef_uidcode  bigint;
  v_offenders       text;
  v_secdef_unclassified bigint;
  v_unclassified_sigs   text;
  v_classified_bad      text;
  v_classified_live     bigint;
  v_mem_before  bigint; v_mem_after  bigint;
  v_obj_after   text;
begin
  v_caller := current_user::text;

  ------------------------------------------------------------------------
  -- CAN THIS BLOCK IMPERSONATE AT ALL? Asked by DOING it, both roles. Every
  -- refusal below is a claim about what a RUNTIME role can do; without the
  -- switch they would all be claims about postgres, which holds EXECUTE on
  -- everything.
  ------------------------------------------------------------------------
  begin
    set local role authenticated;
    v_seen := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    raise exception '749: cannot switch to role authenticated and back to % (%: %) — the refusals below would not be testing the role they claim to test',
      v_caller, sqlstate, sqlerrm;
  end;
  if v_seen is distinct from 'authenticated' then
    raise exception '749: role switch reported current_user=% rather than authenticated', coalesce(v_seen, 'NULL');
  end if;
  begin
    set local role service_role;
    v_seen := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    raise exception '749: cannot switch to role service_role and back to % (%: %) — probe 3 could not show the edge functions still work',
      v_caller, sqlstate, sqlerrm;
  end;
  if v_seen is distinct from 'service_role' then
    raise exception '749: role switch reported current_user=% rather than service_role', coalesce(v_seen, 'NULL');
  end if;

  ------------------------------------------------------------------------
  -- FIXTURES — from live data, never hardcoded, every one guarded for
  -- vacuity. A missing fixture is a FAILURE, not a quiet pass.
  -- ⚠ digital_employees rows with is_workforce_assistant = true are OUT OF
  -- BOUNDS by standing instruction and are excluded everywhere below.
  ------------------------------------------------------------------------
  select p.tenant_id, p.user_id
    into v_tenant, v_owner_uid
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
     and not exists (select 1 from public.profiles q where q.user_id = p.user_id and q.layer = 'platform')
     and exists (select 1 from public.digital_employees d
                  where d.tenant_id = p.tenant_id
                    and coalesce(d.is_workforce_assistant, false) = false)
   order by p.created_at
   limit 1;

  select d.id into v_de from public.digital_employees d
   where d.tenant_id = v_tenant and coalesce(d.is_workforce_assistant, false) = false
   order by d.created_at limit 1;

  -- An eval run with results, and a DE in the SAME workspace: the internal
  -- variant needs both or it raises for a reason that is not about identity.
  select er.tenant_id, er.id, d.id
    into v_eval_tenant, v_eval_run, v_eval_de
    from public.eval_runs er
    join public.digital_employees d on d.tenant_id = er.tenant_id
                                   and coalesce(d.is_workforce_assistant, false) = false
   where er.total > 0
   order by er.started_at desc nulls last
   limit 1;

  select ra.key into v_arch from public.role_archetypes ra order by ra.key limit 1;

  select e.id, e.tenant_id, e.status,
         (select p.user_id from public.profiles p
           where p.tenant_id = e.tenant_id and p.layer = 'tenant'
             and coalesce(p.is_active, true) limit 1)
    into v_exc, v_exc_tenant, v_exc_status, v_exc_uid
    from public.de_exceptions e
   where exists (select 1 from public.profiles p
                  where p.tenant_id = e.tenant_id and p.layer = 'tenant'
                    and coalesce(p.is_active, true))
   order by e.created_at limit 1;

  select i.id into v_imp from public.de_improvements i order by i.created_at limit 1;
  select d.id into v_sim_de from public.digital_employees d
   where coalesce(d.is_workforce_assistant, false) = false order by d.created_at limit 1;

  -- SECTION 3c fixtures.
  select o.id, o.status into v_obj, v_obj_status
    from public.de_objectives o order by o.created_at limit 1;
  select t.id into v_task from public.human_tasks t order by t.created_at limit 1;

  -- ⚠ THE CORPUS FIXTURE — the workspace that actually HAS published articles,
  -- a member of it, and a query string TAKEN FROM AN ARTICLE'S OWN TITLE.
  -- All three parts matter and each one was measured:
  --   · the old arm's tenant held 0 articles, so the tenant filter alone
  --     produced the 0 rows the assertion was reading as a refusal;
  --   · the old arm's query was 'probe', which matches NONE of the three
  --     articles even in the workspace that has them — so fixing the tenant
  --     alone would have left the arm just as vacuous;
  --   · the corpus workspace is `suspended`, which is exactly why the ordinary
  --     fixture query (t.status in ('active','trial')) can never pick it and
  --     why this has to be selected separately rather than reused.
  -- The POSITIVE CONTROL in probe 5 uses the same three, so the only difference
  -- between "0 rows" there and "0 rows" here is the authority predicate.
  select ka.tenant_id, ka.title
    into v_ka_tenant, v_ka_query
    from public.knowledge_articles ka
   where ka.status = 'published'
     and ka.search_tsv @@ websearch_to_tsquery('english', ka.title)
     and exists (select 1 from public.profiles p
                  where p.tenant_id = ka.tenant_id and p.layer = 'tenant'
                    and coalesce(p.is_active, true))
   order by ka.created_at
   limit 1;
  select p.user_id into v_ka_member from public.profiles p
   where p.tenant_id = v_ka_tenant and p.layer = 'tenant'
     and coalesce(p.is_active, true)
   order by p.created_at limit 1;

  if v_tenant is null or v_owner_uid is null or v_de is null or v_eval_run is null
     or v_eval_de is null or v_arch is null or v_exc is null or v_exc_uid is null
     or v_imp is null or v_sim_de is null or v_obj is null or v_task is null
     or v_ka_tenant is null or v_ka_member is null or v_ka_query is null then
    raise exception '749: VACUITY — fixtures could not be assembled (tenant=% owner=% de=% eval_run=% eval_de=% archetype=% exception=% exc_member=% improvement=% sim_de=% objective=% task=% ka_tenant=% ka_member=% ka_query=%). A missing fixture is not a pass: probes 1, 2, 3, 5, 6 and 7 would each report a refusal or a success they never fired.',
      coalesce(v_tenant::text,'NULL'), coalesce(v_owner_uid::text,'NULL'), coalesce(v_de::text,'NULL'),
      coalesce(v_eval_run::text,'NULL'), coalesce(v_eval_de::text,'NULL'), coalesce(v_arch,'NULL'),
      coalesce(v_exc::text,'NULL'), coalesce(v_exc_uid::text,'NULL'),
      coalesce(v_imp::text,'NULL'), coalesce(v_sim_de::text,'NULL'),
      coalesce(v_obj::text,'NULL'), coalesce(v_task::text,'NULL'),
      coalesce(v_ka_tenant::text,'NULL'), coalesce(v_ka_member::text,'NULL'),
      coalesce(v_ka_query,'NULL');
  end if;

  -- ⚠ AND THE CORPUS MUST NOT BE EMPTY, ASKED SEPARATELY. The fixture query
  -- above could in principle pick a row whose tenant then holds nothing
  -- readable; that would put the search_knowledge arms straight back into the
  -- vacuity they are being repaired out of.
  select count(*) into v_ka_rows from public.knowledge_articles ka
   where ka.tenant_id = v_ka_tenant and ka.status = 'published'
     and ka.search_tsv @@ websearch_to_tsquery('english', v_ka_query);
  if coalesce(v_ka_rows, 0) = 0 then
    raise exception '749: VACUITY — the knowledge corpus fixture (tenant %, query %L) matches 0 published articles, so both search_knowledge arms would compare nothing and the negative one would pass with its predicate deleted. That is the exact defect being repaired here.',
      v_ka_tenant, v_ka_query;
  end if;

  select count(*) into v_wi_before from public.de_work_items
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  select count(*) into v_cert_before from public.role_certifications
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  select count(*) into v_exc_before from public.de_exceptions
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant) and status = 'approved';
  select count(*) into v_doc_before from public.knowledge_docs
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  -- SECTION 3c writes: DE memory rows and the objective's status.
  select count(*) into v_mem_before from public.de_memory
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);

  ------------------------------------------------------------------------
  -- PROBE 1 — GROUP A WRAPPERS, NO IDENTITY AT ALL. THIS IS THE FIX, FIRED.
  --
  -- The three that hold EXECUTE for `authenticated` are called AS
  -- authenticated, so the refusal is the body's and not the grant's.
  --
  -- ⚠ BOTH JWT GUCs cleared: auth.uid() falls back from request.jwt.claim.sub
  -- to request.jwt.claims->>'sub', so clearing one leaves a fallback. The
  -- null-ness is then ASSERTED — a refusal for the wrong reason is no evidence.
  --
  -- REPRESENTATIVE SAMPLE, AND WHY THESE THREE: enqueue_de_work_item is the
  -- only GROUP A function that both WRITES and takes a tenant id as a
  -- parameter — the archetypal shape; certify_de_from_eval writes a governance
  -- artefact (a certification) and derives its tenant from a DE id, the other
  -- shape; mcp_host_allowed is the STABLE read, to show the split refuses on
  -- the predicate-shaped member too.
  --
  -- RED BEFORE THIS MIGRATION: all three SUCCEEDED here. enqueue inserted a
  -- work item into a workspace the caller could merely name.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    select auth.uid() into v_uid_now;

    set local role authenticated;

    v_ref := false; v_msg := null;
    begin
      perform public.enqueue_de_work_item(v_tenant, v_de, '749 probe anonymous work item');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY QUEUED WORK — the `auth.uid() is not null and` prefix is back in enqueue_de_work_item');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('enqueue_de_work_item refused the unidentified caller, but NOT by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin
      perform public.certify_de_from_eval(v_eval_de, v_arch, v_eval_run, 80);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY MINTED A CERTIFICATION — certify_de_from_eval is fail-open again');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('certify_de_from_eval refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin
      v_bool := public.mcp_host_allowed(v_tenant, 'probe.749.invalid');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY READ THE MCP ALLOWLIST — mcp_host_allowed is fail-open again');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('mcp_host_allowed refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    execute format('set local role %I', v_caller);

    -- ⚠ The three drain wrappers hold NO grant for `authenticated`, so calling
    -- them as authenticated would fail with "permission denied" — a refusal
    -- for the wrong reason, the classic false pass. They are called as % (the
    -- migration's own role, which HOLDS EXECUTE) so that any refusal can only
    -- come from the body's identity bar.
    v_ref := false; v_msg := null;
    begin
      perform * from public.claim_ingestion_items(1, null::uuid);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'claim_ingestion_items served a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('claim_ingestion_items refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin
      perform public.complete_ingestion_item(gen_random_uuid(), null::uuid, false);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'complete_ingestion_item served a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('complete_ingestion_item refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin
      perform public.fail_ingestion_item(gen_random_uuid(), '749 probe', 'retryable');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'fail_ingestion_item served a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('fail_ingestion_item refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    ------------------------------------------------------------------
    -- SECTION 3c's WRAPPERS, same frame, same bar. Four hold EXECUTE for
    -- `authenticated` and are called under that role above; the switch back
    -- to % happened just now, so re-adopt it for these four and call
    -- assess_definition_of_done as % (it has never held an `authenticated`
    -- grant — calling it as authenticated would fail with "permission
    -- denied", a refusal for the wrong reason).
    ------------------------------------------------------------------
    set local role authenticated;

    v_ref := false; v_msg := null;
    begin
      v_uuid := public.de_memory_write(v_tenant, v_de, '749 probe anonymous memory');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY WROTE DE MEMORY into a workspace it merely named — de_memory_write is fail-open again');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('de_memory_write refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin
      perform * from public.de_memory_search(v_tenant, v_de, null::vector, null::text, null::text, null::text[], 5);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY READ DE MEMORY — de_memory_search is fail-open again');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('de_memory_search refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin v_jsonb := public.run_analytics_query(v_tenant, 'de_workload', '{}'::jsonb);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      -- ⚠ THIS IS THE ARM WITH A LIVE PRE-FIX MEASUREMENT BEHIND IT. Before
      -- this migration, this exact call ANSWERED while the same call from a
      -- signed-in member of another workspace was refused.
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY RAN AN ANALYTICS QUERY against a workspace it merely named — run_analytics_query is fail-open again, and this is the arm that was PROVEN live before the fix');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('run_analytics_query refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin perform public.set_de_objective_status(v_obj, 'in_progress');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'A CALLER WITH NO IDENTITY SET AN OBJECTIVE''S STATUS — set_de_objective_status is fail-open again (the WRAPPING form of the defect)');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('set_de_objective_status refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    execute format('set local role %I', v_caller);

    v_ref := false; v_msg := null;
    begin v_jsonb := public.assess_definition_of_done(v_tenant, 'de_work_item', gen_random_uuid(), null::uuid);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'assess_definition_of_done answered a caller with NO identity for a workspace it merely named');
    elsif coalesce(v_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('assess_definition_of_done refused, but not by the identity bar: %L', coalesce(v_msg,'NULL')));
    end if;

    select count(*) into v_p1_created from public.de_work_items
     where title = '749 probe anonymous work item';

    v_d := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 1 ABORTED (%s: %s) — the null-identity refusal, the entire reason this migration exists, was NOT compared this run', sqlstate, sqlerrm));
      v_d := false;
    end if;
  end;

  if v_d then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_uid_now is not null then
      v_bad := array_append(v_bad, format('probe 1 could not clear the identity (auth.uid()=%L) — every refusal above would be a claim about some other bar', v_uid_now::text));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p1_created, 0) <> 0 then
      v_bad := array_append(v_bad, format('%s work item(s) were created by the unidentified caller despite the refusals — the refusal and the effect disagree', v_p1_created::text));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 2 — GROUP B and GROUP C, NO IDENTITY, as `authenticated`.
  --
  -- SAMPLE, AND WHY: get_workforce_economics and get_benchmark_report take
  -- p_tenant_id as a PARAMETER (the tenant-id-is-authorisation shape, and the
  -- larger of the two reads); de_certification_status derives its tenant from
  -- an object id instead, which is the other half of the population. From
  -- GROUP C: apply_improvement (writes a knowledge doc and is the only one
  -- with a real SQL caller), resolve_de_exception (writes, tenant derived from
  -- the row) and certify_de_from_sim (mints a certification). search_knowledge
  -- is asserted separately below because its refusal is ZERO ROWS, not an
  -- exception, and asserting the wrong shape would be theatre.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',    '', true);
    select auth.uid() into v_uid_now;
    set local role authenticated;

    v_ref := false; v_msg := null;
    begin v_jsonb := public.get_workforce_economics(v_tenant);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'get_workforce_economics answered a caller with NO identity for a workspace it merely named');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('get_workforce_economics refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin v_jsonb := public.get_benchmark_report(v_tenant, null::uuid, 30);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'get_benchmark_report answered a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('get_benchmark_report refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin v_jsonb := public.de_certification_status(v_de);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'de_certification_status answered a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('de_certification_status refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin v_uuid := public.apply_improvement(v_imp);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'apply_improvement PUBLISHED A KNOWLEDGE DOC for a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('apply_improvement refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin perform public.resolve_de_exception(v_exc, 'approved', '749 probe', false);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'resolve_de_exception DECIDED AN EXCEPTION for a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('resolve_de_exception refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin v_jsonb := public.certify_de_from_sim(v_sim_de, v_arch, gen_random_uuid(), 80);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'certify_de_from_sim answered a caller with NO identity');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('certify_de_from_sim refused, but NOT by the authority bar — if this says "simulation has no results" the authority check was skipped and the caller got past it: %L', coalesce(v_msg,'NULL')));
    end if;

    -- ⚠⚠ search_knowledge: refusal is ZERO ROWS, not an exception — AND THIS
    -- ARM USED TO BE VACUOUS. It ran against v_tenant, which holds ZERO
    -- knowledge_articles (all 3 platform-wide are in one other workspace), with
    -- the query string 'probe', which matches none of them anywhere. Both the
    -- tenant filter and the text filter produced the 0 rows on their own, so
    -- deleting search_knowledge's ENTIRE authority predicate left this
    -- assertion passing. It is now aimed at the workspace that HAS the corpus,
    -- with a query taken from an article's own title, and its POSITIVE CONTROL
    -- is in probe 5: the same tenant and the same query, called by a real
    -- member, MUST return more than zero. Without that pair, "0 rows" is not
    -- evidence of a refusal — it is evidence of an empty shelf.
    select count(*) into v_n from public.search_knowledge(v_ka_tenant, v_ka_query, null::text, 5);
    v_checks := v_checks + 1;
    if v_n <> 0 then
      v_bad := array_append(v_bad, format('search_knowledge returned %s row(s) from the CORPUS workspace to a caller with no identity and no service_role — its explicit two-arm predicate has been broken', v_n::text));
    end if;

    ------------------------------------------------------------------
    -- SECTION 3c's THREE PLAIN REMOVALS. Each refuses in its own SHAPE, and
    -- asserting the wrong shape would be theatre, so each is asserted in the
    -- shape it actually has.
    ------------------------------------------------------------------
    -- enqueue_conflict_backlog RETURNS a jsonb error; it does not raise.
    -- ⚠ This is the arm that would have caught the three-valued-logic trap: if
    -- auth_has_tenant_role had returned NULL rather than false, `not (NULL and
    -- NULL)` is NULL, `if NULL then` does not fire, and this call would have
    -- SUCCEEDED with the guard looking repaired.
    v_ref := false; v_msg := null; v_jsonb := null;
    begin v_jsonb := public.enqueue_conflict_backlog(v_tenant, 1, null::uuid);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if v_ref then
      v_bad := array_append(v_bad, format('enqueue_conflict_backlog raised %L — it answers with a jsonb error, so a raise means something other than the authority bar fired', coalesce(v_msg,'NULL')));
    elsif coalesce(v_jsonb ->> 'error', '') <> 'forbidden' then
      v_bad := array_append(v_bad, format('enqueue_conflict_backlog answered %L rather than forbidden — A CALLER WITH NO IDENTITY SEEDED A CONFLICT BACKLOG for a workspace it merely named', coalesce(v_jsonb::text,'NULL')));
    end if;

    v_ref := false; v_msg := null;
    begin perform public.resolve_action_execution_for_task(v_task);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'resolve_action_execution_for_task RETURNED AN ACTION ROW to a caller with no identity — the same function docs/PROTOTYPE-PRODUCTION-BOUNDARY.md records as proven anon-exploitable, fail-open again');
    elsif coalesce(v_msg,'') not like 'tenant access denied%' then
      v_bad := array_append(v_bad, format('resolve_action_execution_for_task refused, but not by the tenant bar: %L', coalesce(v_msg,'NULL')));
    end if;

    -- ⚠ A RANDOM ID IS SUFFICIENT HERE, and for a reason worth stating:
    -- verify_extraction_result's authority test precedes any lookup, so it
    -- refuses before the row would matter. That is NOT true of
    -- complete_ingestion_item in probe 3, where reaching the not-found raise is
    -- itself the assertion. extraction_results holds 0 rows today, so a real
    -- fixture is not available and would not add anything if it were.
    v_ref := false; v_msg := null;
    begin perform public.verify_extraction_result(gen_random_uuid(), null::jsonb);
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if not v_ref then
      v_bad := array_append(v_bad, 'verify_extraction_result VERIFIED AN EXTRACTION for a caller with no identity — the WRAPPING form of the defect is back');
    elsif coalesce(v_msg,'') not like 'not authorized%' then
      v_bad := array_append(v_bad, format('verify_extraction_result refused, but not by the authority bar: %L', coalesce(v_msg,'NULL')));
    end if;

    -- ⚠ THE TWO NO-OPS, PINNED AS NO-OPS. Claiming these were fixed would be
    -- the "five confident findings that were all wrong" failure again, so
    -- instead they assert the answer they have ALWAYS given: neither gained a
    -- refusal and neither lost one.
    v_ref := false; v_msg := null; v_jsonb := null;
    begin v_jsonb := public.apply_trust_promotion(gen_random_uuid(), 'approved');
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if v_ref then
      v_bad := array_append(v_bad, format('apply_trust_promotion gained a REFUSAL it did not have (%L) — the prefix removed there was a null-guard on the self-approval comparison, not an authority check, and this migration claimed the removal was a no-op', coalesce(v_msg,'NULL')));
    elsif coalesce(v_jsonb ->> 'reason', '') <> 'no_pending_policy' then
      v_bad := array_append(v_bad, format('apply_trust_promotion answered %L rather than no_pending_policy — its behaviour changed', coalesce(v_jsonb::text,'NULL')));
    end if;

    v_ref := false; v_msg := null; v_jsonb := null;
    begin v_jsonb := public.assign_doc_collection(gen_random_uuid(), gen_random_uuid());
    exception when others then v_ref := true; v_msg := sqlerrm; end;
    v_checks := v_checks + 1;
    if v_ref then
      v_bad := array_append(v_bad, format('assign_doc_collection gained a refusal it did not have (%L)', coalesce(v_msg,'NULL')));
    elsif coalesce(v_jsonb ->> 'error', '') <> 'no_tenant' then
      v_bad := array_append(v_bad, format('assign_doc_collection answered %L rather than no_tenant — auth_tenant_id() no longer refuses an unidentified caller and the claim in this migration''s header is wrong', coalesce(v_jsonb::text,'NULL')));
    end if;

    execute format('set local role %I', v_caller);
    v_d := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 2 ABORTED (%s: %s) — the GROUP B/C refusals were NOT compared this run', sqlstate, sqlerrm));
      v_d := false;
    end if;
  end;
  if v_d then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_uid_now is not null then
      v_bad := array_append(v_bad, format('probe 2 could not clear the identity (auth.uid()=%L)', v_uid_now::text));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 3 — EVERY GROUP A _internal STILL SUCCEEDS WITH NO auth.uid().
  -- If any of these refuses, its edge function is broken the moment this
  -- migration applies, and the fix would be a refusal reported as a success.
  -- ⚠ THE CLAIMS ARE SET TO {"role":"service_role"}, NOT CLEARED, and the
  -- first draft of this probe got it wrong. auth.role() reads the JWT, not the
  -- Postgres role, so clearing both GUCs makes auth.role() NULL —
  -- can_access_de names service_role BY JWT ROLE, so enqueue_de_work_item_
  -- internal would have raised not_responsible_for_de and this probe would
  -- have reported a broken autonomy loop that is not broken. PostgREST sets
  -- request.jwt.claims from the service-role key, with a `role` and no `sub`,
  -- so THAT is the edge shape: no identity, named role. auth.uid() is still
  -- asserted null below.
  --
  -- complete_/fail_ingestion_item_internal are driven with a random id: they
  -- must reach 'ingestion item not found', which is the assertion that they
  -- got PAST the point where the authority check used to be. A generic
  -- "no exception" would not distinguish that.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    select auth.uid() into v_uid_now;
    set local role service_role;

    v_checks := v_checks + 1;
    if coalesce(auth.role(), '') <> 'service_role' then
      v_bad := array_append(v_bad, format('probe 3 could not adopt the service-role JWT shape (auth.role()=%L) — every "still works" below would be a claim about some other caller', coalesce(auth.role(), 'NULL')));
    end if;

    v_checks := v_checks + 1;
    begin
      perform * from public.claim_ingestion_items_internal(1, null::uuid);
      v_p3_ok := v_p3_ok + 1;
    exception when others then
      v_bad := array_append(v_bad, format('claim_ingestion_items_internal REFUSED a service-role caller (%s) — knowledge-ingest-drain is broken', sqlerrm));
    end;

    v_checks := v_checks + 1;
    v_msg := null;
    begin perform public.complete_ingestion_item_internal(gen_random_uuid(), null::uuid, false);
    exception when others then v_msg := sqlerrm; end;
    if coalesce(v_msg,'') <> 'ingestion item not found' then
      v_bad := array_append(v_bad, format('complete_ingestion_item_internal did not reach its not-found raise for a service-role caller — got %L', coalesce(v_msg,'(no exception at all)')));
    else v_p3_ok := v_p3_ok + 1; end if;

    v_checks := v_checks + 1;
    v_msg := null;
    begin v_txt := public.fail_ingestion_item_internal(gen_random_uuid(), '749 probe', 'retryable');
    exception when others then v_msg := sqlerrm; end;
    if coalesce(v_msg,'') <> 'ingestion item not found' then
      v_bad := array_append(v_bad, format('fail_ingestion_item_internal did not reach its not-found raise for a service-role caller — got %L', coalesce(v_msg,'(no exception at all)')));
    else v_p3_ok := v_p3_ok + 1; end if;

    v_checks := v_checks + 1;
    begin
      v_bool := public.mcp_host_allowed_internal(v_tenant, 'probe.749.invalid');
      if v_bool is null then
        v_bad := array_append(v_bad, 'mcp_host_allowed_internal returned NULL to a service-role caller — mcp-client treats a bad answer as a refusal, so every MCP call would 503');
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('mcp_host_allowed_internal REFUSED a service-role caller (%s) — mcp-client fails closed and every MCP call 503s', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      v_uuid := public.enqueue_de_work_item_internal(v_tenant, v_de, '749 probe internal work item');
      if v_uuid is null then
        v_bad := array_append(v_bad, 'enqueue_de_work_item_internal returned NULL for a service-role caller — de-work stops chaining steps');
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('enqueue_de_work_item_internal REFUSED a service-role caller (%s) — the DE autonomy loop is broken', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      v_jsonb := public.certify_de_from_eval_internal(v_eval_de, v_arch, v_eval_run, 80);
      if v_jsonb is null or v_jsonb ->> 'status' is null then
        v_bad := array_append(v_bad, format('certify_de_from_eval_internal returned %L for a service-role caller — eval-run records no certification', coalesce(v_jsonb::text,'NULL')));
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('certify_de_from_eval_internal REFUSED a service-role caller (%s) — Proving Ground passes stop certifying', sqlerrm));
    end;

    ------------------------------------------------------------------
    -- SECTION 3c's FIVE INTERNALS, same frame. Each one that refuses here is
    -- an edge function that stops working the moment this migration applies.
    ------------------------------------------------------------------
    v_checks := v_checks + 1;
    begin
      v_uuid := public.de_memory_write_internal(v_tenant, v_de, '749 probe internal memory');
      if v_uuid is null then
        v_bad := array_append(v_bad, 'de_memory_write_internal returned NULL for a service-role caller — de-answer, de-memory, de-orchestrate, de-work and widget-ask all stop remembering');
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('de_memory_write_internal REFUSED a service-role caller (%s) — five edge functions stop writing DE memory', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      perform * from public.de_memory_search_internal(v_tenant, v_de, null::vector, null::text, null::text, null::text[], 5);
      v_p3_ok := v_p3_ok + 1;
    exception when others then
      v_bad := array_append(v_bad, format('de_memory_search_internal REFUSED a service-role caller (%s) — four edge functions stop recalling DE memory', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      v_jsonb := public.run_analytics_query_internal(v_tenant, 'de_workload', '{}'::jsonb);
      if v_jsonb is null then
        v_bad := array_append(v_bad, 'run_analytics_query_internal returned NULL for a service-role caller — de-work''s run_analytics tool stops answering');
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('run_analytics_query_internal REFUSED a service-role caller (%s) — de-work''s run_analytics tool is broken', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      perform public.set_de_objective_status_internal(v_obj, v_obj_status);
      v_p3_ok := v_p3_ok + 1;
    exception when others then
      v_bad := array_append(v_bad, format('set_de_objective_status_internal REFUSED a service-role caller (%s) — de-work cannot advance an objective (index.ts:265, :328, :2147)', sqlerrm));
    end;

    v_checks := v_checks + 1;
    begin
      v_jsonb := public.assess_definition_of_done_internal(v_tenant, 'de_work_item', gen_random_uuid(), null::uuid);
      if v_jsonb is null or v_jsonb ->> 'verified' is null then
        v_bad := array_append(v_bad, format('assess_definition_of_done_internal returned %L for a service-role caller — connector-hub and the shared defOfDone gate read no verdict', coalesce(v_jsonb::text,'NULL')));
      else v_p3_ok := v_p3_ok + 1; end if;
    exception when others then
      v_bad := array_append(v_bad, format('assess_definition_of_done_internal REFUSED a service-role caller (%s) — the definition-of-done gate in de-work, agentic-step-execute and connector-hub is broken', sqlerrm));
    end;

    execute format('set local role %I', v_caller);
    v_d := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 3 ABORTED (%s: %s) — nothing proved that the TEN edge functions still work', sqlstate, sqlerrm));
      v_d := false;
    end if;
  end;
  if v_d then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_uid_now is not null then
      v_bad := array_append(v_bad, format('probe 3 ran WITH an identity (auth.uid()=%L) — it proved nothing about the service path', v_uid_now::text));
    end if;
    v_checks := v_checks + 1;
    if v_p3_ok <> 11 then
      v_bad := array_append(v_bad, format('only %s of the 11 internal variants were proven to work with no identity', v_p3_ok::text));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 4 — THE WHOLE GRANT MATRIX, BOTH DIRECTIONS, FULL SIGNATURE.
  --
  -- Not just the internals: every one of the 29 functions this migration
  -- touches, with the EXACT pair of privileges it is supposed to end up with.
  -- certify's execute-allowlist compares the anon/authenticated surface against
  -- a pinned file on every run, so a grant this migration changes by accident
  -- turns into a red on someone else's branch hours later. Asserting the matrix
  -- here means the migration refuses to apply instead.
  --
  -- ⚠ has_function_privilege answers INCLUDING inheritance through PUBLIC, so
  -- these ask the privilege question rather than "was a revoke issued" — a
  -- REVOKE is not a description of the resulting privileges (docs/47 trap #4).
  --
  -- ⚠ EXISTENCE FIRST, via to_regprocedure. has_function_privilege RAISES on a
  -- name that does not resolve, which would turn the most important finding
  -- available here — "the function this migration claims to have created is not
  -- there, or its signature is not the one the callers use" — into an opaque
  -- migration abort. Same lesson as `applied_at` lying and to_regclass being
  -- the honest question.
  ------------------------------------------------------------------------
  v_probes := v_probes + 1;
  declare
    r record;
  begin
    for r in
      select * from (values
        -- ── the six internal variants: service_role ONLY ──────────────────
        ('public.certify_de_from_eval_internal(uuid,text,uuid,integer)', false, true),
        ('public.claim_ingestion_items_internal(integer,uuid)', false, true),
        ('public.complete_ingestion_item_internal(uuid,uuid,boolean)', false, true),
        ('public.fail_ingestion_item_internal(uuid,text,text)', false, true),
        ('public.enqueue_de_work_item_internal(uuid,uuid,text,text,timestamp with time zone,uuid,integer,uuid,jsonb,text,integer)', false, true),
        ('public.mcp_host_allowed_internal(uuid,text)', false, true),
        -- ── the three wrappers that keep their browser callers and LOSE
        --    service_role: the unchecked path must not be reachable under the
        --    checked name ───────────────────────────────────────────────────
        ('public.certify_de_from_eval(uuid,text,uuid,integer)', true, false),
        ('public.enqueue_de_work_item(uuid,uuid,text,text,timestamp with time zone,uuid,integer,uuid,jsonb,text,integer)', true, false),
        ('public.mcp_host_allowed(uuid,text)', true, false),
        -- ── the three drain wrappers: reachable by NOBODY, deliberately.
        --    `authenticated` has never held EXECUTE here and this migration
        --    does not hand it over (see the header) ─────────────────────────
        ('public.claim_ingestion_items(integer,uuid)', false, false),
        ('public.complete_ingestion_item(uuid,uuid,boolean)', false, false),
        ('public.fail_ingestion_item(uuid,text,text)', false, false),
        -- ── GROUP B: browser callers, grants UNCHANGED. Listed because the
        --    dangerous failure mode of a CREATE OR REPLACE on a FRESH database
        --    is a function born with PUBLIC EXECUTE (migs 610/630) ───────────
        ('public.apply_trust_promotion(uuid,text)', true, true),
        ('public.assign_doc_collection(uuid,uuid)', true, true),
        ('public.unassign_doc_collection(uuid,uuid)', true, true),
        ('public.de_certification_status(uuid)', true, true),
        ('public.get_benchmark_report(uuid,uuid,integer)', true, true),
        ('public.get_outcome_metering(uuid,timestamp with time zone,timestamp with time zone)', true, true),
        ('public.get_playbook_economics(uuid)', true, true),
        ('public.get_workforce_economics(uuid)', true, true),
        -- ── GROUP C: grants UNCHANGED, including the two platform-shelf
        --    writers `authenticated` must never hold (pinned live by
        --    tests/knowledge-acl-invariants.test.ts:244) ────────────────────
        ('public.apply_improvement(uuid)', true, true),
        ('public.reject_improvement(uuid)', true, true),
        ('public.certify_de_from_sim(uuid,text,uuid,integer)', true, true),
        ('public.resolve_de_exception(uuid,text,text,boolean)', true, true),
        ('public.publish_platform_shelf_doc(uuid,text,text,uuid)', false, true),
        ('public.dismiss_platform_kb_change(uuid,text)', false, true),
        ('public.search_knowledge(uuid,text,text,integer)', true, true),
        -- ── SECTION 3c: the five internal variants, service_role ONLY ──────
        ('public.de_memory_write_internal(uuid,uuid,text,vector,text,text,text,numeric,text,timestamp with time zone)', false, true),
        ('public.de_memory_search_internal(uuid,uuid,vector,text,text,text[],integer)', false, true),
        ('public.run_analytics_query_internal(uuid,text,jsonb)', false, true),
        ('public.set_de_objective_status_internal(uuid,text)', false, true),
        ('public.assess_definition_of_done_internal(uuid,text,uuid,uuid)', false, true),
        -- ── SECTION 3c: the four wrappers that keep `authenticated` and LOSE
        --    service_role — the unchecked path must not stay reachable under
        --    the checked name ────────────────────────────────────────────────
        ('public.de_memory_write(uuid,uuid,text,vector,text,text,text,numeric,text,timestamp with time zone)', true, false),
        ('public.de_memory_search(uuid,uuid,vector,text,text,text[],integer)', true, false),
        ('public.run_analytics_query(uuid,text,jsonb)', true, false),
        ('public.set_de_objective_status(uuid,text)', true, false),
        -- ── SECTION 3c: the wrapper reachable by NOBODY, deliberately.
        --    `authenticated` has never held EXECUTE here (mig 678) and this
        --    migration does not hand it over ─────────────────────────────────
        ('public.assess_definition_of_done(uuid,text,uuid,uuid)', false, false),
        -- ── SECTION 3c: the three plain removals, grants UNCHANGED ─────────
        ('public.enqueue_conflict_backlog(uuid,integer,uuid)', true, true),
        ('public.resolve_action_execution_for_task(uuid)', true, true),
        ('public.verify_extraction_result(uuid,jsonb)', true, true)
      ) as t(sig, want_authed, want_service)
    loop
      v_checks := v_checks + 1;
      if to_regprocedure(r.sig) is null then
        v_bad := array_append(v_bad, format('%s does not exist with that signature after this migration — every caller pointed at it is broken, and the privilege arms below could not even be asked', r.sig));
        continue;
      end if;

      v_checks := v_checks + 1;
      if has_function_privilege('anon', r.sig, 'EXECUTE') then
        v_bad := array_append(v_bad, format('%s: `anon` — the anonymous internet — holds EXECUTE', r.sig));
      end if;

      v_checks := v_checks + 1;
      if has_function_privilege('authenticated', r.sig, 'EXECUTE') <> r.want_authed then
        v_bad := array_append(v_bad, format(
          '%s: `authenticated` EXECUTE is %s, expected %s. %s',
          r.sig,
          case when r.want_authed then 'absent' else 'present' end,
          case when r.want_authed then 'present' else 'absent' end,
          case when r.want_authed
               then 'The browser path is gone and certify''s execute-allowlist will go red.'
               else 'This migration narrows a perimeter; it must not widen one on the way past — authenticated is the internet with a session.' end));
      end if;

      v_checks := v_checks + 1;
      if has_function_privilege('service_role', r.sig, 'EXECUTE') <> r.want_service then
        v_bad := array_append(v_bad, format(
          '%s: service_role EXECUTE is %s, expected %s. %s',
          r.sig,
          case when r.want_service then 'absent' else 'present' end,
          case when r.want_service then 'present' else 'absent' end,
          case when r.want_service
               then 'The edge function that needs this cannot call it.'
               else 'The unchecked path is reachable under the checked name — the hole renamed rather than closed.' end));
      end if;
    end loop;
  end;

  ------------------------------------------------------------------------
  -- PROBE 5 — A LEGITIMATE SIGNED-IN CALLER STILL SUCCEEDS. One per group.
  -- Without this the whole migration could be "refuse everything", which
  -- passes every arm above and breaks the product.
  ------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_owner_uid::text, true);
    select auth.uid() into v_uid_now;
    set local role authenticated;

    -- GROUP A: the wrapper, as the workspace's own owner. This is
    -- scripts/golden-path.mjs:174's exact path, which certify runs every time.
    v_checks := v_checks + 1;
    begin
      v_uuid := public.enqueue_de_work_item(v_tenant, v_de, '749 probe owner work item');
      if v_uuid is null then
        v_bad := array_append(v_bad, 'enqueue_de_work_item returned NULL for the workspace''s own owner — golden-path''s intake step will fail');
      end if;
    exception when others then
      v_bad := array_append(v_bad, format('THE OWNER OF THE WORKSPACE WAS REFUSED by enqueue_de_work_item (%s) — golden-path''s intake step is broken', sqlerrm));
    end;

    -- GROUP B.
    v_checks := v_checks + 1;
    begin
      v_jsonb := public.get_workforce_economics(v_tenant);
      if v_jsonb is null then
        v_bad := array_append(v_bad, 'get_workforce_economics returned NULL to the workspace''s own owner');
      end if;
    exception when others then
      v_bad := array_append(v_bad, format('the workspace''s own owner was refused by get_workforce_economics (%s)', sqlerrm));
    end;

    execute format('set local role %I', v_caller);

    -- GROUP C: resolve_de_exception, as a member of the exception's OWN
    -- workspace (a different fixture, because the exception fixture and the
    -- owner fixture need not be the same tenant).
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_exc_uid::text, true);
    set local role authenticated;
    v_checks := v_checks + 1;
    v_txt := null;
    begin
      -- ⚠ 'approved', not 'resolved': de_exceptions_status_check permits only
      -- proposed/approved/denied/auto_resolved (measured), and a CHECK violation
      -- here would read as "the member was refused".
      perform public.resolve_de_exception(v_exc, 'approved', '749 probe', false);
    exception when others then
      v_bad := array_append(v_bad, format('a member of the exception''s own workspace was REFUSED by resolve_de_exception (%s)', sqlerrm));
    end;

    -- ⚠ THE EFFECT IS READ AS % AND NOT AS `authenticated`. de_exceptions
    -- carries RLS; reading it under the impersonated role would turn an
    -- RLS-hidden row into "the write did not happen", which is the
    -- RLS-denied-write-looks-like-success trap pointing the other way.
    execute format('set local role %I', v_caller);
    select status into v_txt from public.de_exceptions where id = v_exc;
    v_checks := v_checks + 1;
    if coalesce(v_txt,'') <> 'approved' then
      v_bad := array_append(v_bad, format('resolve_de_exception did not refuse a member of the workspace, but the row still reads %L — the decision and the effect disagree', coalesce(v_txt,'NULL')));
    end if;

    ------------------------------------------------------------------
    -- ⚠⚠ THE POSITIVE CONTROL THAT MAKES PROBE 2's search_knowledge ARM MEAN
    -- ANYTHING. Same workspace, same query string; the ONLY difference from
    -- the zero-rows assertion in probe 2 is that this caller is a member. If
    -- this returns 0 too, then probe 2's 0 was the empty shelf and not the
    -- refusal, and BOTH arms are worthless — which is precisely the state this
    -- probe was in before, and why it is asserted rather than assumed.
    ------------------------------------------------------------------
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', v_ka_member::text, true);
    set local role authenticated;
    v_checks := v_checks + 1;
    begin
      select count(*) into v_n from public.search_knowledge(v_ka_tenant, v_ka_query, null::text, 5);
      if coalesce(v_n, 0) = 0 then
        v_bad := array_append(v_bad, format('search_knowledge returned ZERO rows to a MEMBER of the corpus workspace (tenant %s, query %L, %s published articles match that query when read directly) — so the zero-rows refusal asserted in probe 2 proves nothing: both arms would read zero whether the authority predicate is there or deleted',
          v_ka_tenant::text, v_ka_query, v_ka_rows::text));
      end if;
    exception when others then
      v_bad := array_append(v_bad, format('a member of the corpus workspace was REFUSED by search_knowledge (%s) — the positive control cannot fire, so probe 2''s arm is unanchored', sqlerrm));
    end;
    execute format('set local role %I', v_caller);

    v_d := true;
    raise exception using errcode = 'P0001', message = '__undo__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo__' then
      v_bad := array_append(v_bad, format('PROBE 5 ABORTED (%s: %s) — nothing proved a legitimate caller still gets through, so "refuse everything" would have passed', sqlstate, sqlerrm));
      v_d := false;
    end if;
  end;
  if v_d then
    v_probes := v_probes + 1;
    v_checks := v_checks + 1;
    if v_uid_now is distinct from v_owner_uid then
      v_bad := array_append(v_bad, format('probe 5 could not adopt the owner identity (auth.uid()=%L, wanted %L)', coalesce(v_uid_now::text,'NULL'), v_owner_uid::text));
    end if;
  end if;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  ------------------------------------------------------------------------
  -- PROBE 6 — THE STATIC SWEEP, IN THE MIGRATION, WITH ITS DENOMINATOR.
  -- The same query scripts/secdef-authority-prefix.mjs runs on every certify.
  -- Three arms, because a count of zero findings proves nothing on its own:
  --   a) no SECURITY DEFINER function carries the prefix, comments stripped
  --   b) the population examined is NOT ZERO
  --   c) the strip is not eating code — at least one stripped body still
  --      mentions auth.uid() — AND it is not a no-op: the naive count must
  --      EXCEED the stripped count, which it does because the bodies above
  --      deliberately NAME the pattern in their comments.
  ------------------------------------------------------------------------
  v_probes := v_probes + 1;
  select count(*),
         count(*) filter (where regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
                             or regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M'),
         count(*) filter (where p.prosrc ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
                             or p.prosrc ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M'),
         count(*) filter (where regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ilike '%auth.uid()%'),
         count(*) filter (where regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null'
                            and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') !~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
                            and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') !~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M'
                            and p.proname not in ('probe_chunk_neighbors', 'record_knowledge_conflict', 'hybrid_match_knowledge'))
    into v_secdef_total, v_secdef_stripped, v_secdef_naive, v_secdef_uidcode, v_secdef_unclassified
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef;

  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname)
    into v_offenders
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and (regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
       or regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M');

  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname)
    into v_unclassified_sigs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') !~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') !~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M'
     and p.proname not in ('probe_chunk_neighbors', 'record_knowledge_conflict', 'hybrid_match_knowledge');

  -- ⚠ THE CLASSIFICATION PIN, ASKED THE OTHER WAY ROUND. The three names
  -- excluded above are excluded on an ARGUMENT (fail-closed bar; actor
  -- resolution), not on a hope. If one of them ever carries the real defect,
  -- the exclusion would be granting it cover, so it is asked for explicitly.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_classified_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('probe_chunk_neighbors', 'record_knowledge_conflict', 'hybrid_match_knowledge')
     and (regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and'
       or regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+then\s+if\M');

  -- …and that they still mention it at all. A classification aimed at nothing
  -- is an exemption nobody has re-derived.
  select count(*) into v_classified_live
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('probe_chunk_neighbors', 'record_knowledge_conflict', 'hybrid_match_knowledge')
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~* 'auth\.uid\(\)\s+is\s+not\s+null';

  v_checks := v_checks + 1;
  if v_secdef_stripped <> 0 then
    v_bad := array_append(v_bad, format('%s SECURITY DEFINER function(s) STILL gate an authority check on `auth.uid() is not null` in CODE (flat or wrapping form): %s', v_secdef_stripped::text, coalesce(v_offenders,'(could not be named)')));
  end if;

  -- ⚠ ARM C — A SHAPE NEITHER REGEX CLAIMS. Without this, the sweep's clean
  -- result would mean "no body matches two patterns I chose", which is not the
  -- same statement as "no body is fail-open". This one says out loud when it
  -- has been handed something it cannot judge, instead of passing.
  v_checks := v_checks + 1;
  if coalesce(v_secdef_unclassified, 0) <> 0 then
    v_bad := array_append(v_bad, format('%s SECURITY DEFINER function(s) mention `auth.uid() is not null` in a shape NEITHER arm recognises and which is not one of the three classified non-defects: %s. Read each body: it is either a third fail-open form (fix it) or a fourth non-defect (classify it in scripts/secdef-authority-prefix.mjs with the argument). Do NOT widen the regexes to swallow it — `if auth.uid() is not null then raise` is a fail-CLOSED bar and deleting it would widen a perimeter.',
      v_secdef_unclassified::text, coalesce(v_unclassified_sigs,'(could not be named)')));
  end if;

  v_checks := v_checks + 1;
  if v_classified_bad is not null then
    v_bad := array_append(v_bad, format('%s is/are classified as NON-defects (fail-closed service-role bar, or actor resolution) but now carry the real defect in code — the classification has expired while still granting cover, which is worse than no classification at all', v_classified_bad));
  end if;

  v_checks := v_checks + 1;
  if coalesce(v_classified_live, 0) <> 3 then
    v_bad := array_append(v_bad, format('only %s of the 3 classified non-defects (probe_chunk_neighbors, record_knowledge_conflict, hybrid_match_knowledge) still mention `auth.uid() is not null` at all — a classification aimed at nothing quietly widens the exclusion, so drop the entry rather than leaving it pointed at a body that no longer exists in that shape', coalesce(v_classified_live,0)::text));
  end if;
  v_checks := v_checks + 1;
  if v_secdef_total = 0 then
    v_bad := array_append(v_bad, 'VACUOUS: zero SECURITY DEFINER functions were examined, so the sweep above compared nothing and its clean result means nothing');
  end if;
  v_checks := v_checks + 1;
  if v_secdef_uidcode = 0 then
    v_bad := array_append(v_bad, format('VACUOUS: not one of %s SECURITY DEFINER bodies still mentions auth.uid() after stripping — the comment strip is eating CODE, and a sweep that reads empty bodies finds nothing by construction', v_secdef_total::text));
  end if;
  v_checks := v_checks + 1;
  if v_secdef_naive <= v_secdef_stripped then
    v_bad := array_append(v_bad, format('the comment strip changed nothing (naive=%s, stripped=%s) — either no live body comments on the pattern any more or the strip is not running; a strip nobody exercises is the step migration 747 lost a first apply to', v_secdef_naive::text, v_secdef_stripped::text));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 7 — EVERY PROBE ROW IS GONE. The counts are scoped to the probe
  -- workspaces: a global count re-read at the end of the same READ COMMITTED
  -- transaction goes red because an unrelated workspace committed a row.
  ------------------------------------------------------------------------
  v_probes := v_probes + 1;
  select count(*) into v_wi_after from public.de_work_items
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  select count(*) into v_cert_after from public.role_certifications
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  select count(*) into v_exc_after from public.de_exceptions
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant) and status = 'approved';
  select count(*) into v_doc_after from public.knowledge_docs
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);

  v_checks := v_checks + 1;
  if v_wi_after <> v_wi_before then
    v_bad := array_append(v_bad, format('de_work_items changed %s -> %s across the probes', v_wi_before::text, v_wi_after::text));
  end if;
  v_checks := v_checks + 1;
  if v_cert_after <> v_cert_before then
    v_bad := array_append(v_bad, format('role_certifications changed %s -> %s across the probes', v_cert_before::text, v_cert_after::text));
  end if;
  v_checks := v_checks + 1;
  if v_exc_after <> v_exc_before then
    v_bad := array_append(v_bad, format('decided (approved) de_exceptions changed %s -> %s across the probes', v_exc_before::text, v_exc_after::text));
  end if;
  v_checks := v_checks + 1;
  if v_doc_after <> v_doc_before then
    v_bad := array_append(v_bad, format('knowledge_docs changed %s -> %s across the probes', v_doc_before::text, v_doc_after::text));
  end if;

  -- SECTION 3c's two writers. de_memory_write_internal INSERTS and
  -- set_de_objective_status_internal UPDATES; probe 3 fires both for real,
  -- so both need an undo arm or "rolled back" is a claim nobody measured.
  select count(*) into v_mem_after from public.de_memory
   where tenant_id in (v_tenant, v_eval_tenant, v_exc_tenant);
  v_checks := v_checks + 1;
  if v_mem_after <> v_mem_before then
    v_bad := array_append(v_bad, format('de_memory changed %s -> %s across the probes — probe 1 and probe 3 both wrote DE memory and one of them stuck', v_mem_before::text, v_mem_after::text));
  end if;

  select status into v_obj_after from public.de_objectives where id = v_obj;
  v_checks := v_checks + 1;
  if coalesce(v_obj_after,'') is distinct from coalesce(v_obj_status,'') then
    v_bad := array_append(v_bad, format('de_objectives.status for the probe objective changed %L -> %L across the probes', coalesce(v_obj_status,'NULL'), coalesce(v_obj_after,'NULL')));
  end if;

  ------------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'749 VERIFICATION FAILED (% checks across % probes):\n  %',
      v_checks, v_probes, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '749: % checks across % probes, all passed — a caller with NO identity is now REFUSED by enqueue_de_work_item, certify_de_from_eval, mcp_host_allowed and the three ingestion wrappers (this is the fix, fired), and by get_workforce_economics, get_benchmark_report, de_certification_status, apply_improvement, resolve_de_exception and certify_de_from_sim, while search_knowledge still answers it with zero rows FROM THE WORKSPACE THAT ACTUALLY HOLDS THE CORPUS and answers a member of that same workspace with more than zero (the positive control, without which the zero proved only that the shelf was empty); the eight SECTION 3c functions the first sweep''s substring predicate could not see are closed too — de_memory_write, de_memory_search, run_analytics_query, set_de_objective_status and assess_definition_of_done now refuse an unidentified caller, enqueue_conflict_backlog answers it `forbidden`, resolve_action_execution_for_task raises and verify_extraction_result raises; all ELEVEN _internal variants still work with no auth.uid() at all so the TEN edge functions keep running once deployed; `authenticated` and `anon` cannot execute any _internal and service_role can, asserted in both directions on the full signature; service_role no longer holds EXECUTE on any of the eleven old names (six from section 1, five from 3c); the workspace''s own owner still queues work (golden-path''s intake step) and still reads its economics, and a member still decides an exception in their own workspace; % of % SECURITY DEFINER functions in public now gate an authority check on `auth.uid() is not null` in CODE (naive count including comments: %, which is what makes the strip load-bearing rather than decorative), % mention it in a shape neither arm claims and is not one of the three classified non-defects (probe_chunk_neighbors and record_knowledge_conflict are FAIL-CLOSED service-role bars and were deliberately NOT "fixed"; hybrid_match_knowledge resolves an actor); and every probe row rolled back, including the DE memory rows and the objective status probe 3 really did write',
    v_checks, v_probes, v_secdef_stripped, v_secdef_total, v_secdef_naive, v_secdef_unclassified;
end;
$verify$;

commit;
