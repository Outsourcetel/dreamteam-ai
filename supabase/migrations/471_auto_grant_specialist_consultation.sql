-- 471_auto_grant_specialist_consultation.sql
-- ============================================================================
-- docs/31 decision #2 (founder: YES) — auto-grant every Digital Employee
-- consultation access to its tenant's seeded Technical Specialist, at hire
-- and by one-time backfill. The machinery already exists and is dark:
-- de_consultation_grants had ZERO rows live (verified 2026-07-28), so the
-- consult_specialist tool has never been offered to any DE (de-work offers
-- it only when >= 1 active grant exists).
--
-- ── Shape of the grant (mirrors the live Governance CRUD write) ─────────────
-- The ONLY live grant writer is src/lib/digitalEmployeesApi.ts
-- createDeConsultationGrant — a direct RLS insert of
--   (tenant_id, requester_de_id, target_de_id, category)
-- with created_by left NULL and active defaulting true. There is NO
-- grant-writing RPC and the CRUD emits NO audit event (verified: zero
-- non-internal triggers on de_consultation_grants; no append_audit_event
-- caller touches the table). We mirror the columns exactly. We DO add an
-- 'access_control' audit event (category verified against the live
-- audit_events_category_check, which allows it): a machine-side governance
-- write with no human in the loop must leave a trace — the same call the
-- mig-448-era create_digital_employee makes for its machine-written
-- de_assignments row. Divergence from "emit the same (nothing)" is
-- deliberate and stated.
--
-- category = 'other': de_consultation_grants.category is an FK to
-- system_categories(key) ('other' verified present live). The UI's own
-- whole-specialist grant (LiveWorkforceDEs.tsx toggleSpecialistHelp) uses
-- 'other' with the comment that category is audit-only on this table —
-- de-work treats a grant as membership and never branches on category.
--
-- ── Why triggers on digital_employees, not per-function splices ─────────────
-- A DE is born on FIVE live paths (all read live 2026-07-28):
--   1. instantiate_role_archetype (archetype hire; also called by
--      connector-hub dt_hire_from_archetype) — SQL insert
--   2. create_digital_employee (manual create, mig 448 body) — SQL insert
--   3. provision_starter_de_internal — SQL insert OR reactivating update
--   4. entity-draft edge fn (the hire wizard) — DIRECT service-role insert
--   5. connector-hub dt_create_digital_employee — DIRECT service-role insert
-- Paths 4 and 5 are TypeScript inserts inside edge functions: no SQL splice
-- can reach them, and an edge redeploy is exactly the path that is currently
-- blocked (mig 430 precedent). An AFTER INSERT trigger on digital_employees
-- is the single point that covers all five paths — including install_role_kit
-- hires, whose DE row is born in instantiate_role_archetype — with no edge
-- deploy. Per-path call: ALL paths get the grant (starter and
-- machine-created DEs included, for consistency: the grant is inert until
-- the DE works, and de-work re-checks the target specialist is active every
-- run). Specialists themselves are excluded (they are targets, not
-- requesters).
--
-- A second trigger fires when a tenant's Technical Specialist BECOMES
-- active (insert or status flip): it grants the tenant's existing active
-- workforce. This keeps any tenant whose specialist is created or enabled
-- LATER (e.g. the Demo Workspace, which has no Technical Specialist at
-- all today) converging to full coverage with no manual sweep.
--
-- ── What a grant ACTUALLY confers (scope containment, fix-pass 2026-07-28) ──
-- de_consultation_grants is the platform's GENERAL DE-collaboration
-- allow-list, not just the consult gate. Five live consumers:
--   1. de-work consult_specialist tool          — consult: the intended effect.
--   2. agentic-step-execute consult tool        — consult: intended (already
--      filters is_specialist=true + status='active'; consult-only by shape).
--   3. specialist-consult Step 3c (proactive
--      evidence pipeline, depth-0 DE subjects)  — consult: intended; now also
--      skips non-active targets (edge fix, same fix-pass).
--   4. de-work delegate_to_colleague            — DELEGATION: NOT intended for
--      specialists. Edge fix (same fix-pass) excludes is_specialist targets;
--      the SQL backstop below (section 6) mirrors it inside request_de_task.
--   5. de-orchestrate supervisor routing        — work handoff: NOT intended
--      for specialists. Edge fix (same fix-pass) excludes is_specialist
--      targets from the routable roster.
-- SQL-side consumers (pg_proc prosrc sweep 2026-07-28):
--   6. request_de_task                          — delegation backstop: gains
--      the specialist-target refusal in section 6 below.
--   7. can_consult_multihop (mig 160)           — consult-permission check,
--      no edge caller today; a specialist grant answering "allowed" is the
--      intended consult effect. Safe, unchanged.
--   8. check_de_retirement_readiness            — counts ACTIVE inbound
--      grants as retirement blockers. Post-backfill, retiring a Technical
--      Specialist will list its N granted consumers as an explicit blocker —
--      a BEHAVIOUR CHANGE, but fail-closed and honest (the workforce really
--      does depend on it); an admin clears it by toggling the grants off.
--      Regular DEs are unaffected (this migration creates no grants TO them).
--   9. list_consultable_for_de (UI read)        — the specialist now appears
--      in the Consultation-network card via the 'grant' UNION branch, which
--      hardcodes is_specialist=false — a COSMETIC mislabel (listing is
--      consult-semantics, no capability). Noted, not fixed here.
-- Decision of record: consult is the specialist interface; delegation and
-- routing are DE-to-DE work handoff and keep their pre-backfill behaviour.
--
-- Caller analysis for the trigger functions (house rule 2):
--   * user JWT: fires under RLS'd table writes and inside SECURITY DEFINER
--     RPCs; the functions are SECURITY DEFINER themselves so the grant
--     insert does not depend on the caller's row policies.
--   * service-role JWT: edge-fn direct inserts — fires identically.
--   * direct DB / pg_cron: no auth-dependent predicate exists in either
--     function (they read NEW, the tenant's DE rows, and the tenants row —
--     a plain table read, no auth.* anywhere), so cron-driven status flips
--     behave the same.
-- Trigger functions return trigger and are not callable via PostgREST, but
-- house rule 3 applies regardless: explicit REVOKEs below.
--
-- Suspended-tenant dormancy (fix-pass 2026-07-28): both trigger functions
-- refuse to grant in a suspended tenant (plain read of tenants.status —
-- works identically in all three contexts). Predicate is
-- status in ('active','trial'), which under the live tenants_status_check
-- (active|suspended|trial) is exactly "not suspended" — the same rule the
-- backfill uses (trial counts as a working tenant). The fix instruction
-- asked for status = 'active'; that would silently exclude the 2 live trial
-- tenants at hire time while the backfill INCLUDES them — an inconsistency,
-- so the trial-inclusive predicate was chosen and the divergence is stated.
-- A DE hired while its tenant is suspended is picked up by trigger 1's
-- status-flip arm when the DE (re)flips active after reactivation, or by
-- trigger 2 when the specialist row is touched — coverage converges; a
-- suspended tenant simply cannot mint new collaboration surface while dark.
--
-- Safety: both functions swallow their own errors with a WARNING — a failed
-- courtesy grant must never abort a hire or a status change. Idempotency is
-- structural: ON CONFLICT on the live unique key
-- (tenant_id, requester_de_id, target_de_id, category). The status-flip
-- triggers fire only on a transition INTO 'active' (house rule 7).
-- ============================================================================

-- ── 1. Requester-side: every non-specialist DE gets the grant at birth,
--       and when it (re)enters status='active' (covers the
--       provision_starter_de_internal reuse branch and any later
--       reactivation of a DE hired while the specialist was down). ─────────
create or replace function public.de_grant_specialist_consult()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_spec_id uuid;
  v_n int := 0;
begin
  -- Dormancy guard (fix-pass 2026-07-28): no new grants in suspended tenants.
  -- Plain table read — no auth predicate, identical under user JWT /
  -- service-role / direct-DB+pg_cron. 'trial' counts as working (see header).
  if not exists (
    select 1 from tenants t
    where t.id = new.tenant_id and t.status in ('active', 'trial')) then
    return new;
  end if;

  -- Newest ACTIVE wins (fix-pass 2026-07-28): one deterministic pick shared
  -- with the specialist-consult key lookups and the 475_ installer check —
  -- retired/disabled rows are terminal history, and if two actives ever
  -- coexist the latest install is "the" specialist everywhere.
  select s.id into v_spec_id
  from digital_employees s
  where s.tenant_id = new.tenant_id
    and s.is_specialist = true
    and s.specialist_key = 'technical'
    and s.status = 'active'
  order by s.created_at desc
  limit 1;

  if v_spec_id is null or v_spec_id = new.id then
    return new;
  end if;

  insert into de_consultation_grants
    (tenant_id, requester_de_id, target_de_id, category, active, created_by)
  values
    (new.tenant_id, new.id, v_spec_id, 'other', true, null)
  on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform append_audit_event_internal(
      new.tenant_id, 'DreamTeam', 'system',
      format('Consultation access granted — %s may now consult the Technical Specialist (standard at hire, docs/31 decision 2).',
             coalesce(nullif(new.persona_name, ''), new.name)),
      'access_control',
      jsonb_build_object(
        'kind', 'de_consultation_grant_auto',
        'requester_de_id', new.id, 'target_de_id', v_spec_id,
        'category', 'other', 'via', lower(tg_op)));
  end if;

  return new;
exception when others then
  raise warning 'de_grant_specialist_consult skipped for DE %: %', new.id, sqlerrm;
  return new;
end $$;

revoke all on function public.de_grant_specialist_consult() from PUBLIC;
revoke all on function public.de_grant_specialist_consult() from anon;
revoke all on function public.de_grant_specialist_consult() from authenticated;

-- ── 2. Specialist-side: when a tenant's Technical Specialist becomes
--       active, grant the tenant's existing active workforce. DEs that are
--       idle at that moment are picked up by trigger 1 when they next flip
--       active — the two triggers converge on full coverage. ───────────────
create or replace function public.de_specialist_grant_workforce()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int := 0;
begin
  -- Dormancy guard (fix-pass 2026-07-28): no new grants in suspended tenants.
  -- Plain table read — no auth predicate, identical in all three contexts.
  if not exists (
    select 1 from tenants t
    where t.id = new.tenant_id and t.status in ('active', 'trial')) then
    return new;
  end if;

  insert into de_consultation_grants
    (tenant_id, requester_de_id, target_de_id, category, active, created_by)
  select new.tenant_id, d.id, new.id, 'other', true, null
  from digital_employees d
  where d.tenant_id = new.tenant_id
    and d.is_specialist is not true
    and d.status = 'active'
    and d.id <> new.id
  on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform append_audit_event_internal(
      new.tenant_id, 'DreamTeam', 'system',
      format('Technical Specialist activated — consultation access granted to %s active digital employee(s) (docs/31 decision 2).', v_n),
      'access_control',
      jsonb_build_object(
        'kind', 'de_consultation_grant_specialist_activated',
        'target_de_id', new.id, 'grants_created', v_n,
        'category', 'other', 'via', lower(tg_op)));
  end if;

  return new;
exception when others then
  raise warning 'de_specialist_grant_workforce skipped for specialist %: %', new.id, sqlerrm;
  return new;
end $$;

revoke all on function public.de_specialist_grant_workforce() from PUBLIC;
revoke all on function public.de_specialist_grant_workforce() from anon;
revoke all on function public.de_specialist_grant_workforce() from authenticated;

-- ── 3. Triggers (WHEN clauses keep the fast path free of function calls;
--       the status-flip pair fires only on a transition INTO 'active'). ────
drop trigger if exists trg_de_auto_consult_grant_ins on digital_employees;
create trigger trg_de_auto_consult_grant_ins
  after insert on digital_employees
  for each row
  when (new.is_specialist is not true)
  execute function public.de_grant_specialist_consult();

drop trigger if exists trg_de_auto_consult_grant_upd on digital_employees;
create trigger trg_de_auto_consult_grant_upd
  after update of status on digital_employees
  for each row
  when (new.is_specialist is not true
        and new.status = 'active'
        and old.status is distinct from 'active')
  execute function public.de_grant_specialist_consult();

drop trigger if exists trg_spec_auto_consult_grant_ins on digital_employees;
create trigger trg_spec_auto_consult_grant_ins
  after insert on digital_employees
  for each row
  when (new.is_specialist is true
        and new.specialist_key = 'technical'
        and new.status = 'active')
  execute function public.de_specialist_grant_workforce();

drop trigger if exists trg_spec_auto_consult_grant_upd on digital_employees;
create trigger trg_spec_auto_consult_grant_upd
  after update of status on digital_employees
  for each row
  when (new.is_specialist is true
        and new.specialist_key = 'technical'
        and new.status = 'active'
        and old.status is distinct from 'active')
  execute function public.de_specialist_grant_workforce();

-- ── 4. One-time backfill + in-migration asserts ────────────────────────────
-- For every ACTIVE non-specialist DE in a NON-SUSPENDED tenant (trial counts
-- as non-suspended) whose tenant has an ACTIVE Technical Specialist, insert
-- the grant if absent. Expected from live data 2026-07-28: 46 grants across
-- 13 tenants (12 tenants x 3 DEs + outsourcetel-hq x 10). Deliberately
-- receiving ZERO:
--   * outsourcetel (a0000000-…, Demo Workspace): no Technical Specialist
--     row at all (2 active DEs).
--   * acme-telecom, kinetic: tenants suspended (8 DEs between them).
-- OVERTAKEN-BY-EVENTS NOTE: the docs/31 audit found outsourcetel-hq's
-- Technical Specialist disabled. A NEW, ACTIVE Technical Specialist
-- (39521a06-…) was created in that tenant on 2026-07-27 20:44 UTC — after
-- the audit, during parallel decision work — so hq's 10 active DEs now
-- qualify and ARE backfilled here. The retired duplicate (b532000c-…,
-- status 'disabled', still is_specialist=true/specialist_key='technical')
-- REMAINS: it is excluded from targeting by the status filter everywhere in
-- this migration; the specialist-consult lookup bug it exposed (unfiltered
-- maybeSingle by specialist_key) is fixed in this fix-pass's edge changes,
-- and the installer's reinstall block by the 475_ companion migration.
--
-- HONEST EXPOSURE BOUND (fix-pass 2026-07-28 — corrects an earlier FALSE
-- claim that post-apply LLM exposure in outsourcetel-hq ≈ 0 because consults
-- would fail fast on the duplicate-specialist lookup): that fail-fast only
-- ever applied to the specialist_key lookup path. specialist-consult Step 3c
-- resolves each grant's TARGET BY ID, so from the moment this backfill lands
-- consults are LIVE in outsourcetel-hq — every depth-0 DE-subject inquiry
-- fans out one real specialist sub-run per active grant, and the de-work
-- consult tool goes live too (and with the edge fixes deployed, the key
-- lookups work as well). Measured worst-case ≈ 82 consults/day tenant-wide
-- (16.3 de-work items/day × ≤5 tool calls, the only work-generating tenant),
-- each a single LLM call at max_tokens 1024. Spend is doubly budget-governed
-- — check_tenant_ai_budget inside specialist-consult's answer path (and
-- pipeline-internal), plus de-work's per-DE check_de_budget pre-gate — and
-- every call is metered via record_de_token_usage attributed to the
-- specialist DE. Step 3c per-inquiry fan-out volume was NOT separately
-- measured; it is bounded by the same budgets.
-- The count assert is dynamic (missing-before == inserted, missing-after
-- == 0) so live drift between draft and apply fails loudly instead of
-- silently diverging.
do $$
declare
  v_expected int;
  v_inserted int;
  v_remaining int;
  r record;
begin
  if not exists (select 1 from system_categories where key = 'other') then
    raise exception 'system_categories has no ''other'' key — grant category FK would fail';
  end if;

  -- Fix-pass 2026-07-28 (assert the assumption instead of stating it): the
  -- per-tenant audit loop below attributes the WHOLE table's per-tenant
  -- counts to this backfill, which is only true while the table is EMPTY.
  -- Any row created between draft and apply (e.g. the UI's
  -- toggleSpecialistHelp) would be miscounted — fail loudly instead.
  -- This assert fails on any pre-existing row; if it fires, re-derive the
  -- audit attribution before applying. (It would ALSO fire on a re-run of
  -- this migration — intended: the backfill is one-time by design.)
  if exists (select 1 from de_consultation_grants) then
    raise exception 'de_consultation_grants is no longer empty (% row(s)) — the per-tenant backfill audit below assumes a zero baseline; re-derive before applying',
      (select count(*) from de_consultation_grants);
  end if;

  select count(*) into v_expected
  from digital_employees d
  join tenants t on t.id = d.tenant_id and t.status <> 'suspended'
  cross join lateral (
    select s.id from digital_employees s
    where s.tenant_id = d.tenant_id and s.is_specialist = true
      and s.specialist_key = 'technical' and s.status = 'active'
    order by s.created_at desc limit 1
  ) spec
  where d.is_specialist is not true and d.status = 'active'
    and not exists (
      select 1 from de_consultation_grants g
      where g.tenant_id = d.tenant_id and g.requester_de_id = d.id
        and g.target_de_id = spec.id and g.category = 'other');

  insert into de_consultation_grants
    (tenant_id, requester_de_id, target_de_id, category, active, created_by)
  select d.tenant_id, d.id, spec.id, 'other', true, null
  from digital_employees d
  join tenants t on t.id = d.tenant_id and t.status <> 'suspended'
  cross join lateral (
    select s.id from digital_employees s
    where s.tenant_id = d.tenant_id and s.is_specialist = true
      and s.specialist_key = 'technical' and s.status = 'active'
    order by s.created_at desc limit 1
  ) spec
  where d.is_specialist is not true and d.status = 'active'
  on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted <> v_expected then
    raise exception 'backfill drift: expected % grants, inserted %', v_expected, v_inserted;
  end if;

  select count(*) into v_remaining
  from digital_employees d
  join tenants t on t.id = d.tenant_id and t.status <> 'suspended'
  cross join lateral (
    select s.id from digital_employees s
    where s.tenant_id = d.tenant_id and s.is_specialist = true
      and s.specialist_key = 'technical' and s.status = 'active'
    order by s.created_at desc limit 1
  ) spec
  where d.is_specialist is not true and d.status = 'active'
    and not exists (
      select 1 from de_consultation_grants g
      where g.tenant_id = d.tenant_id and g.requester_de_id = d.id
        and g.target_de_id = spec.id and g.category = 'other');
  if v_remaining <> 0 then
    raise exception 'backfill incomplete: % qualifying DE(s) still without a grant', v_remaining;
  end if;

  -- Post-state integrity: every grant this migration created must point at
  -- an ACTIVE specialist. This is what proves the retired duplicate in
  -- outsourcetel-hq (b532000c-…, disabled) was never targeted.
  if exists (
    select 1 from de_consultation_grants g
    join digital_employees s on s.id = g.target_de_id
    where s.status <> 'active' or s.is_specialist is not true) then
    raise exception 'backfill targeted a non-active or non-specialist DE';
  end if;

  -- Per-tenant governance record for the backfill (the table held ZERO rows
  -- before this migration and nothing else writes it here, so a whole-table
  -- per-tenant count IS the backfill count).
  for r in
    select g.tenant_id, count(*) as c, min(g.target_de_id::text)::uuid as spec_id
    from de_consultation_grants g group by g.tenant_id
  loop
    perform append_audit_event_internal(
      r.tenant_id, 'DreamTeam', 'system',
      format('Consultation access backfilled — %s active digital employee(s) may now consult the Technical Specialist (docs/31 decision 2).', r.c),
      'access_control',
      jsonb_build_object(
        'kind', 'de_consultation_grant_backfill',
        'target_de_id', r.spec_id, 'grants_created', r.c, 'category', 'other'));
  end loop;

  raise notice 'auto-grant backfill: % grants inserted across % tenant(s)',
    v_inserted, (select count(distinct tenant_id) from de_consultation_grants);
end $$;

-- ── 5. Landing asserts ─────────────────────────────────────────────────────
do $$
declare
  v_trg int;
  v_def text;
begin
  select count(*) into v_trg
  from pg_trigger
  where tgrelid = 'digital_employees'::regclass and not tgisinternal
    and tgname in ('trg_de_auto_consult_grant_ins', 'trg_de_auto_consult_grant_upd',
                   'trg_spec_auto_consult_grant_ins', 'trg_spec_auto_consult_grant_upd');
  if v_trg <> 4 then
    raise exception 'expected 4 auto-grant triggers on digital_employees, found %', v_trg;
  end if;

  -- Dormancy guard landed in BOTH deployed trigger bodies (fix-pass item B).
  -- Token is the exact code predicate; it appears nowhere in comments, so a
  -- body without the guard cannot pass this check.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'de_grant_specialist_consult';
  if v_def not like '%t.status in (''active'', ''trial'')%' then
    raise exception 'de_grant_specialist_consult is missing the suspended-tenant guard';
  end if;
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'de_specialist_grant_workforce';
  if v_def not like '%t.status in (''active'', ''trial'')%' then
    raise exception 'de_specialist_grant_workforce is missing the suspended-tenant guard';
  end if;

  if (select count(*) from de_consultation_grants) = 0 then
    raise exception 'de_consultation_grants is still empty after backfill';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('de_grant_specialist_consult', 'de_specialist_grant_workforce')
      and grantee in ('PUBLIC', 'anon', 'authenticated')) then
    raise exception 'auto-grant trigger functions still executable by PUBLIC/anon/authenticated';
  end if;
end $$;

-- ── 6. SQL backstop: specialists are consulted, never delegated to ─────────
-- request_de_task (mig 234, redefined by mig 269 — body below REPRODUCED
-- FROM LIVE pg_get_functiondef 2026-07-28, byte-compatible plus ONE added
-- guard) is the SQL permission check behind cross-DE delegation, and it
-- reads THIS SAME grants table. The de-work delegate tool now excludes
-- specialist targets (edge fix, this fix-pass), but the RPC itself is
-- EXECUTE-granted to authenticated, so a tenant member could still craft a
-- direct call with p_from_de_id set and the auto-granted specialist as
-- target. Same decision, enforced at the backstop: a DE-requested task may
-- not target a specialist. The HUMAN path (p_from_de_id null, owner/admin
-- gated by mig 269) is deliberately untouched — a human assigning work to a
-- specialist is a human decision and worked before grants existed at all.
-- Caller analysis (house rule 2): the added guard is a plain
-- digital_employees read — no new auth predicate; the function's existing
-- auth.role()/auth.uid() usage is unchanged and this RPC is never called
-- from cron.
do $$
declare v_def text;
begin
  -- Pre-check: the live body we are about to replace is the mig-269 shape we
  -- reproduced (distinctive tokens survive our redefinition, so re-apply
  -- passes too). If this fires, request_de_task drifted after this draft was
  -- written — re-reproduce from live before applying.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'request_de_task';
  if v_def is null or v_def not like '%chain_too_deep%'
     or v_def not like '%not_tenant_member%' or v_def not like '%de_consultation_grants%' then
    raise exception 'request_de_task live body is not the mig-269 shape this draft reproduced — re-verify before applying';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.request_de_task(p_from_de_id uuid, p_to_de_id uuid, p_title text, p_context text DEFAULT NULL::text, p_expected_output text DEFAULT NULL::text, p_urgency text DEFAULT 'normal'::text, p_due_date date DEFAULT NULL::date, p_related_table text DEFAULT NULL::text, p_related_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_to_tenant uuid; v_from_name text; v_to_name text;
  v_existing uuid; v_open_pair int; v_req uuid; v_obj uuid; v_title text;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  v_title := left(btrim(coalesce(p_title,'')), 200);
  IF v_title = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'title_required'); END IF;
  IF p_to_de_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'to_de_required'); END IF;
  IF p_from_de_id IS NOT NULL AND p_from_de_id = p_to_de_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_self_assignment');
  END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_to_tenant, v_to_name FROM digital_employees WHERE id = p_to_de_id;
  IF v_to_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'target_not_found'); END IF;
  v_tenant := v_to_tenant;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  -- (B) HUMAN path is admin-only.
  IF p_from_de_id IS NULL AND NOT v_is_service
     AND NOT public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
      'detail', 'Only workspace owners/admins can assign tasks to an employee.');
  END IF;

  -- (C) SINGLE-HOP backstop: a task opened FROM a de_task case cannot re-delegate.
  IF p_from_de_id IS NOT NULL AND p_related_table = 'de_objectives' AND p_related_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM de_objectives o WHERE o.id = p_related_id AND o.entity_kind = 'de_task') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'chain_too_deep',
      'detail', 'A delegated task cannot itself be delegated onward.');
  END IF;

  -- (D — docs/31 decision #2 scope containment, fix-pass 2026-07-28) consult
  -- is the specialist interface; delegation is DE-to-DE work handoff. The
  -- specialist auto-grant (this migration) must not make specialists
  -- task-assignment targets, so a DE-requested task refuses them here even
  -- though a grant row exists. Mirrors the de-work delegate-tool exclusion.
  IF p_from_de_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM digital_employees s WHERE s.id = p_to_de_id AND s.is_specialist = true) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
      'detail', 'Specialists are consulted, not delegated to - use a consultation instead.');
  END IF;

  IF p_from_de_id IS NOT NULL THEN
    SELECT coalesce(persona_name, name) INTO v_from_name FROM digital_employees WHERE id = p_from_de_id AND tenant_id = v_tenant;
    IF v_from_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'requester_not_in_tenant'); END IF;
    IF NOT EXISTS (SELECT 1 FROM de_consultation_grants g
      WHERE g.tenant_id = v_tenant AND g.requester_de_id = p_from_de_id AND g.target_de_id = p_to_de_id AND g.active) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
        'detail', 'No active collaboration grant from the requesting employee to the target. A tenant admin configures these.');
    END IF;
    IF EXISTS (SELECT 1 FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_to_de_id AND r.to_de_id = p_from_de_id
        AND lower(r.title) = lower(v_title) AND r.status IN ('requested','accepted','in_progress')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'circular', 'detail', 'A reverse task on the same subject is already open.');
    END IF;
    SELECT count(*) INTO v_open_pair FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_from_de_id AND r.to_de_id = p_to_de_id
        AND r.status IN ('requested','accepted','in_progress');
    IF v_open_pair >= 20 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'too_many_open', 'detail', 'Too many open tasks to this employee already.');
    END IF;
  ELSE
    v_from_name := 'You';
  END IF;

  SELECT id INTO v_existing FROM de_task_requests r
    WHERE r.tenant_id = v_tenant AND r.to_de_id = p_to_de_id
      AND coalesce(r.from_de_id::text,'human') = coalesce(p_from_de_id::text,'human')
      AND lower(r.title) = lower(v_title) AND r.status IN ('requested','accepted','in_progress')
    ORDER BY r.created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'request_id', v_existing);
  END IF;

  INSERT INTO de_task_requests (tenant_id, from_de_id, to_de_id, title, context, expected_output, urgency, due_date, related_table, related_id, created_by)
  VALUES (v_tenant, p_from_de_id, p_to_de_id, v_title, left(p_context, 4000), left(p_expected_output, 2000),
          CASE WHEN p_urgency IN ('low','normal','high','urgent') THEN p_urgency ELSE 'normal' END,
          p_due_date, p_related_table, p_related_id, auth.uid())
  RETURNING id INTO v_req;

  INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
  VALUES (v_tenant, p_to_de_id, left('Task from ' || coalesce(v_from_name,'a colleague') || ': ' || v_title, 200),
          'Assigned by ' || coalesce(v_from_name,'a colleague') || '. ' || coalesce(left(p_context,1000),'')
            || coalesce(E'\nExpected: ' || left(p_expected_output,500), ''),
          'de_task', v_req::text, 'open',
          CASE p_urgency WHEN 'urgent' THEN 5 WHEN 'high' THEN 30 ELSE 60 END,
          p_due_date::timestamptz,
          jsonb_build_object('source','cross_de_task','request_id',v_req,'from_de_id',p_from_de_id,'urgency',p_urgency))
  RETURNING id INTO v_obj;
  UPDATE de_task_requests SET objective_id = v_obj WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, coalesce(v_from_name,'You'), CASE WHEN p_from_de_id IS NULL THEN 'human' ELSE 'de' END,
    coalesce(v_from_name,'You') || ' assigned a task to ' || v_to_name || ' — "' || v_title || '"', 'de_consultation',
    jsonb_build_object('kind','de_task_assigned','request_id',v_req,'from_de_id',p_from_de_id,'to_de_id',p_to_de_id,'objective_id',v_obj));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'request_id', v_req, 'objective_id', v_obj);
END; $function$;

-- CREATE OR REPLACE preserves the existing ACL (mig 234/269: no PUBLIC/anon;
-- authenticated + service_role EXECUTE) — asserted below rather than re-granted.
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'request_de_task';
  -- The guard landed (the assert question: a body without the refusal cannot
  -- contain this exact string — it appears only inside the new guard).
  if v_def not like '%Specialists are consulted, not delegated to%' then
    raise exception 'request_de_task is missing the specialist-target refusal';
  end if;
  -- Every mig-269 guard survived the redefinition.
  if v_def not like '%chain_too_deep%' or v_def not like '%Only workspace owners/admins%'
     or v_def not like '%too_many_open%' or v_def not like '%circular%' then
    raise exception 'request_de_task redefinition lost a mig-269 guard';
  end if;
  -- ACL unchanged: perimeter closed, app paths intact.
  if has_function_privilege('anon', 'public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid)', 'execute') then
    raise exception 'request_de_task became executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid)', 'execute') then
    raise exception 'request_de_task lost its authenticated EXECUTE grant';
  end if;
  if not has_function_privilege('service_role', 'public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid)', 'execute') then
    raise exception 'request_de_task lost its service_role EXECUTE grant';
  end if;
end $$;
