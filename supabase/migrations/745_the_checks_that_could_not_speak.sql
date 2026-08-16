-- 745_the_checks_that_could_not_speak.sql
-- ==========================================================================
-- WHY: migration 741 verified decide_discovery_proposal with eleven probes and
-- ninety-five assertions, and THIRTY-SIX of those assertions could not have
-- told anyone what they found.
--
--     v_bad := v_bad || 'a sentence explaining the failure';
--
-- is AMBIGUOUS. Postgres carries both `anyarray || anyelement` and
-- `anyarray || anyarray`, an unknown-typed literal resolves to the SECOND, and
-- the statement raises `22P02 malformed array literal` instead of appending.
-- PL/pgSQL resolves expression types LAZILY, at first execution, so the line is
-- fine until its branch fires — WHICH IS EXACTLY WHEN THE CHECK HAS FOUND
-- SOMETHING. Those thirty-six passed only because nothing was wrong. Had any of
-- them found a defect, 741 would have aborted with a type error and the finding
-- would have been invisible: a SQL fault where a diagnosis should have been.
--
-- PROVEN, not inferred, and already paid for once: the same statement lifted
-- into a DO block with its branch forced to fire raises 22P02, while
-- `array_append(v_bad, '...')`, `|| format(...)` and `|| 'x'::text` do not.
-- The live function `validate_onboarding_items` carried the identical bug from
-- migration 076; migration 685 fixed it in production and 693 wrote down why.
-- The lesson did not travel — 741 was written months later and reintroduced it
-- thirty-six times.
--
-- ==========================================================================
-- 741 IS NOT EDITED, AND THAT IS DELIBERATE
--
-- `public.schema_migrations` records a checksum taken at apply time. Editing an
-- applied migration makes `migrate:status` report DRIFTED — a TRUE statement
-- that would then be a lie about the cause. An applied migration's file must
-- keep describing what actually ran. So this migration fixes FORWARD, exactly
-- as 685 did for 076, and `scripts/migration-append-check.mjs` keeps 741 pinned
-- at EXACTLY 36 instances so the debt can neither grow nor be quietly rewritten.
--
-- ==========================================================================
-- AND A ONE-SHOT RE-RUN IS NOT WHAT IS WANTED
--
-- Copying 741's DO block into this file with `array_append` would repair the
-- error paths and leave the checks exactly as one-shot as they are now: they
-- would run once more, at apply time, and never again. The value is in making
-- them RE-RUNNABLE, because what they assert is BEHAVIOUR that nothing else
-- checks.
--
-- certify's `discovery-proposal-decisions` section asserts ROW invariants on
-- rows that happen to exist, and `discovery_proposals` holds ZERO rows today
-- (measured 2026-08-16, not assumed) — so those four row arms compare nothing.
-- Nothing anywhere checks that the compare-and-swap refuses a second accept,
-- that the role bar refuses a tenant_user, that a cross-tenant caller is
-- refused, that an unroutable kind leaves the proposal pending WITH last_error
-- set, that park is not decline, or that a successful accept clears a stale
-- reason. Those are properties of the FUNCTION, not of the table, and they are
-- true or false whether or not a customer has ever used the surface.
--
-- So: `public.verify_decide_discovery_proposal()` runs 741's eleven probes and
-- RETURNS the findings instead of raising them, and certify runs it forever.
--
-- ==========================================================================
-- ⚠⚠ ONE DELIBERATE DEVIATION FROM THE BRIEF, AND IT WAS MEASURED, NOT
-- ASSUMED: THIS FUNCTION IS `SECURITY INVOKER`, NOT `SECURITY DEFINER`.
--
-- The brief specified SECURITY DEFINER. That is incompatible with the probes'
-- central mechanism, and the incompatibility is a hard Postgres rule rather
-- than a preference. Every one of 741's RPC calls is made under
-- `set local role authenticated`, which is what proves the EXECUTE grant and
-- the SECURITY DEFINER elevation are real — a missing grant fails those calls
-- with 42501 instead of quietly succeeding as postgres. Inside a SECURITY
-- DEFINER function that statement cannot run at all:
--
--     ERROR 42501: cannot set parameter "role" within security-definer function
--
-- FIRED, not read about: the exact function shape below (plpgsql, SECURITY
-- DEFINER, `set search_path to 'public'`) was created inside a rolled-back
-- transaction on production and called; it returned that error. `role` carries
-- GUC_NOT_WHILE_SEC_REST, and `InLocalUserIdChange()` is true for the whole
-- body of any SECURITY DEFINER function. There is no way to have both.
--
-- Given the choice between a function that can elevate and probes that cannot
-- impersonate, the probes win, because impersonation is the thing being
-- verified. What SECURITY DEFINER would have bought — the ability to write
-- regardless of the caller's grants — is not needed here and is asserted rather
-- than assumed: measured on this database, BOTH callers that can reach this
-- function hold INSERT/UPDATE/SELECT on all five tables it touches
-- (discovery_sessions, discovery_proposals, connectors, profiles,
-- audit_events), and both bypass RLS. The perimeter is unchanged from what the
-- brief asked for and is what actually keeps this away from a browser:
-- public/anon/authenticated are revoked and only service_role holds EXECUTE.
--
-- ⚠ It restores the caller's role by NAME (`set local role <current_user>`),
-- never with `reset role`. `RESET ROLE` returns to the SESSION user, which for
-- a PostgREST connection is `authenticator` — a role holding almost nothing.
-- Every probe after the first would then fail for a reason that has nothing to
-- do with decide_discovery_proposal.
--
-- ==========================================================================
-- HOW IT IS SAFE TO RUN AGAINST PRODUCTION, REPEATEDLY, FOREVER
--
-- Every probe creates its fixtures, drives the RPC, records what it saw into
-- PL/pgSQL variables, and then raises the sentinel '__undo_probe__' inside its
-- own sub-block. A PL/pgSQL BEGIN...EXCEPTION is an implicit subtransaction, so
-- every row the probe wrote is rolled back when the handler catches — while the
-- VARIABLE assignments survive, because variables are backend memory and not
-- transactional. That is the mechanism migrations 741 and 525 already rely on,
-- not a new one.
--
-- AND IT IS ASSERTED RATHER THAN TRUSTED. Row counts for all five touched
-- tables are snapshotted before any probe runs and re-read after the last one;
-- any movement is a finding. Every row a probe creates is TAGGED — connectors
-- by display_name, proposals by a `vddp` key in the payload — so the leak check
-- names survivors instead of merely counting them, and is immune to whatever
-- else the platform is doing concurrently. Probe 8 deactivates a real person's
-- profile inside its sub-block; that they are active again afterwards is its
-- own assertion.
--
-- A PROBE THAT DIES IS A FINDING, NEVER A SKIP. Each sub-block catches
-- `others`: the sentinel means "done, undo it", and anything else records
-- "PROBE n ABORTED" with its SQLSTATE and message, leaves that probe's
-- assertions un-run rather than evaluating them against NULLs, and lowers the
-- completed-probe count that certify reads. The writes are rolled back either
-- way, because entering the handler at all means the subtransaction aborted.
--
-- ==========================================================================
-- WHAT THE RETURNED ARRAY CONTAINS
--
-- Elements are FINDINGS, except those beginning with 'note: ', which carry the
-- DENOMINATORS. The note is not decoration and not optional: zero findings from
-- zero probes looks exactly like a clean result, and this repo has been bitten
-- by that enough times for the count to be load-bearing. certify parses
-- `probes_completed=` out of it and REFUSES a run reporting zero, which no
-- amount of empty-array greenness can fake.
--
-- Every append in this file uses `array_append`. Not one bare literal is
-- appended to a text[] anywhere below — this migration must not reproduce the
-- defect it exists to repair, one level up.
--
-- ==========================================================================
-- ⚠ THREE OF 741's NINETY-FIVE ASSERTIONS CANNOT FAIL, AND ARE JOINED HERE BY
-- ONE THAT CAN. Found by mutation, not by reading.
--
--   "the second accept moved decided_at"   (probe 2)
--   "the re-decide moved decided_at"       (probe 3)
--   "the second Park moved decided_at"     (probe 4)
--
-- Each compares the row's `decided_at` before and after a call that must write
-- nothing. `decide_discovery_proposal` writes `decided_at = now()`, and now()
-- is the TRANSACTION timestamp — constant for every statement in one
-- transaction. All eleven probes run inside one transaction, so a call that
-- wrongly re-dated the row would write the identical value it already held and
-- the comparison would still be equal. Driven and confirmed: the mutant that
-- widens the CAS to admit every state re-writes the row three times over, and
-- these three assertions stayed silent while nine of their neighbours fired.
--
-- They are PORTED ANYWAY, unchanged, because they are correct about production
-- (where the two clicks are separate transactions and the timestamps differ)
-- and deleting them would quietly narrow what this checks. What is added
-- beside each is a `ctid` comparison, which detects the WRITE itself rather
-- than a value the write happened to preserve: any UPDATE gives the row a new
-- tuple version, so an unchanged ctid is proof the refused call touched
-- nothing. Ninety-five becomes ninety-eight, and all three of the new ones
-- have been watched to fire.
--
-- ==========================================================================
-- WHAT IS STILL NOT PROVEN HERE, and no probe below pretends otherwise. These
-- are carried over from 741 verbatim, because making the probes re-runnable
-- does not make any of them provable:
--   * that PostgREST actually populates `request.jwt.claim.sub` from a real
--     JWT. The probes set the GUC themselves. That is transport, shared with
--     every SECDEF function in this repo, and unobservable from inside SQL.
--   * CONCURRENT double-click. The compare-and-swap is proven SEQUENTIALLY (a
--     second call returns already_decided and writes nothing). A single session
--     cannot race itself; the concurrent claim rests on READ COMMITTED
--     semantics and remains INFERRED.
--   * the browser half of Path B — that `connectors.insert` succeeds under RLS
--     as the signed-in human, and that a 0-row PostgREST result is not read as
--     success. That belongs to the client task.
--   * that service_role is unreachable through PostgREST. Only the catalogue
--     grant is asserted.
-- ==========================================================================

begin;

create or replace function public.verify_decide_discovery_proposal()
returns text[]
language plpgsql
-- ⚠ INVOKER, and the reason is fired rather than argued — see the header.
-- `set local role` raises 42501 inside a SECURITY DEFINER body, and without it
-- every probe would run as postgres, which holds EXECUTE on everything and so
-- can never demonstrate that `authenticated` does.
security invoker
set search_path to 'public'
as $function$
declare
  v_caller          text;
  v_seen_role       text;
  v_notes           text[] := '{}';
  v_probes_done     integer := 0;
  v_abort           text;

  v_tenant          uuid;
  v_admin_uid       uuid;
  v_user_uid        uuid;
  v_other_tenant    uuid;
  v_other_admin     uuid;
  v_platform_uid    uuid;
  v_dim             text;

  v_prop_before     bigint;
  v_prop_after      bigint;
  v_sess_before     bigint;
  v_sess_after      bigint;
  v_conn_before     bigint;
  v_conn_after      bigint;
  v_audit_before    bigint;
  v_audit_after     bigint;
  v_leak_conn       bigint;
  v_leak_prop       bigint;
  v_admin_active    boolean;

  v_session         uuid;
  v_session_b       uuid;
  v_conn            uuid;
  v_conn_b          uuid;
  v_conn_other      uuid;
  v_prop            uuid;
  v_prop_b          uuid;
  v_prop_other      uuid;

  v_res             jsonb;
  v_res2            jsonb;

  -- one per probe: did the sub-block reach its sentinel? An aborted probe must
  -- not have its assertions evaluated against NULLs.
  v_d1              boolean := false;
  v_d3              boolean := false;
  v_d4              boolean := false;
  v_d5              boolean := false;
  v_d6              boolean := false;
  v_d7              boolean := false;
  v_d8              boolean := false;
  v_d9              boolean := false;
  v_d10             boolean := false;
  v_d11             boolean := false;

  -- probe 1 / 2
  v_p1_ok           boolean;
  v_p1_state        text;
  v_p1_obj          uuid;
  v_p1_by           uuid;
  v_p1_at           timestamptz;
  v_p1_err          text;
  v_p1_audit_n      bigint;
  v_p1_detail       jsonb;
  v_p1_actor_type   text;
  v_p1_category     text;
  v_p1_ctid         text;
  v_p2_ok           boolean;
  v_p2_error        text;
  v_p2_state        text;
  v_p2_obj          uuid;
  v_p2_at           timestamptz;
  v_p2_audit_n      bigint;
  v_p2_ctid         text;

  -- probe 3
  v_p3_state        text;
  v_p3_obj          uuid;
  v_p3_by           uuid;
  v_p3_at           timestamptz;
  v_p3_re_ok        boolean;
  v_p3_re_error     text;
  v_p3_re_state     text;
  v_p3_re_row_state text;
  v_p3_re_obj       uuid;
  v_p3_re_at        timestamptz;
  v_p3_re_audit_n   bigint;
  v_p3_conn_delta   bigint;
  v_p3_de_delta     bigint;
  v_p3_gr_delta     bigint;
  v_p3_conn_pre     bigint;
  v_p3_de_pre       bigint;
  v_p3_gr_pre       bigint;
  v_p3_audit_n      bigint;
  v_p3_note         text;
  v_p3_decision     text;
  v_p3_ctid         text;
  v_p3_re_ctid      text;

  -- probe 4
  v_p4_park_ok      boolean;
  v_p4_park_state   text;
  v_p4_park_at      timestamptz;
  v_p4_audit_park   bigint;
  v_p4_park2_ok     boolean;
  v_p4_park2_error  text;
  v_p4_park2_state  text;
  v_p4_park2_row    text;
  v_p4_park2_at     timestamptz;
  v_p4_park2_audit  bigint;
  v_p4_park_ctid    text;
  v_p4_park2_ctid   text;
  v_p4_acc_ok       boolean;
  v_p4_acc_state    text;
  v_p4_acc_obj      uuid;

  -- probe 5
  v_p5_seen_uid     uuid;
  v_p5_decline_ok   boolean := false;
  v_p5_decline_st   text;
  v_p5_refused      boolean := false;
  v_p5_msg          text;
  v_p5_admin_ok     boolean := false;
  v_p5_admin_state  text;

  -- probe 6
  v_p6_own_ok       boolean := false;
  v_p6_cross_ref    boolean := false;
  v_p6_cross_msg    text;
  v_p6_decline_ref  boolean := false;
  v_p6_decline_msg  text;
  v_p6_cross_state  text;

  -- probe 7
  v_p7_ok           boolean;
  v_p7_error        text;
  v_p7_state        text;
  v_p7_lasterr      text;
  v_p7_lastat       timestamptz;
  v_p7_attempts     integer;
  v_p7_attempts2    integer;
  v_p7_by           uuid;
  v_p7_at           timestamptz;
  v_p7_obj          uuid;
  v_p7_audit_n      bigint;
  v_p7_audit_out    text;
  v_p7_sibling_ok   boolean := false;
  v_p7_sibling_st   text;
  v_p7_pre_lasterr  text;
  v_p7_retry_ok     boolean := false;
  v_p7_retry_state  text;
  v_p7_retry_err    text;
  v_p7_retry_at     timestamptz;
  v_p7_retry_att    integer;
  v_p7_retry_obj    uuid;

  -- probe 8
  v_p8_refused      boolean := false;
  v_p8_msg          text;

  -- probe 9
  v_p9_uid_seen     uuid;
  v_p9_refused      boolean := false;
  v_p9_msg          text;
  v_p9_state        text;
  v_p9_lasterr      text;
  v_p9_inv_ok       boolean := false;
  v_p9_inv_state    text;

  -- probe 10
  v_p10_ok          boolean;
  v_p10_error       text;
  v_p10_state       text;
  v_p10_obj         uuid;
  v_p10_lasterr     text;
  v_p10_lastat      timestamptz;
  v_p10_attempts    integer;
  v_p10_fix_ok      boolean := false;
  v_p10_fix_state   text;
  v_p10_fix_obj     uuid;
  v_p10_fix_err     text;
  v_p10_fix_at      timestamptz;

  -- probe 11
  v_p11_refused     boolean := false;
  v_p11_msg         text;
  v_p11_state       text;
  v_p11_lasterr     text;
  v_p11_decline_ref boolean := false;
  v_p11_decline_msg text;
  v_p11_owner_ok    boolean := false;
  v_p11_owner_state text;

  v_sig             text := 'public.decide_discovery_proposal(uuid, text, text, uuid)';
  v_checks          integer := 0;
  v_bad             text[] := '{}';
begin
  v_caller := current_user::text;

  ------------------------------------------------------------------------
  -- CAN THIS FUNCTION IMPERSONATE AT ALL? Asked first, and answered by DOING
  -- it, because every probe below is a statement about what the role
  -- `authenticated` can and cannot do. If the switch is unavailable the probes
  -- would silently run as the caller — a role that holds EXECUTE on
  -- everything — and every refusal below would become a claim about postgres.
  -- That is the "check that cannot fail" trap with a privilege cause, so it is
  -- refused loudly and reported as ZERO probes rather than as a clean run.
  ------------------------------------------------------------------------
  begin
    set local role authenticated;
    v_seen_role := current_user::text;
    execute format('set local role %I', v_caller);
  exception when others then
    v_bad := array_append(v_bad, format(
      'verify_decide_discovery_proposal cannot switch to role `authenticated` and back to %L (%s: %s). Every probe here drives the RPC as the real runtime role; without that they would run as the caller, which holds EXECUTE on everything, and every refusal below would be a statement about the caller rather than about the function.',
      v_caller, sqlstate, sqlerrm));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=11 assertions=0 caller=%s — impersonation unavailable, nothing was compared', v_caller));
    return array_cat(v_bad, v_notes);
  end;

  if v_seen_role is distinct from 'authenticated' then
    v_bad := array_append(v_bad, format(
      'the role switch reported current_user=%L rather than authenticated — the probes below would not be running as the runtime role they claim to test',
      coalesce(v_seen_role, 'NULL')));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=11 assertions=0 caller=%s — role switch did not take effect', v_caller));
    return array_cat(v_bad, v_notes);
  end if;

  ------------------------------------------------------------------------
  -- FIXTURES. Chosen dynamically, never hardcoded, and every one of them
  -- guarded for vacuity: if the shape a probe needs does not exist, this says
  -- so as a FINDING rather than passing on an empty set. 741 raised here; a
  -- standing check must report instead, or an environment that lost its
  -- fixtures would look exactly like an environment that passed.
  ------------------------------------------------------------------------

  -- An ACTIVE tenant-layer owner/admin who holds NO platform profile (a
  -- platform profile passes the bar for every tenant, which would make the
  -- cross-tenant probe meaningless), in a live tenant that ALSO contains an
  -- active tenant-layer NON-admin — the subject of the role probe.
  select p.tenant_id, p.user_id
    into v_tenant, v_admin_uid
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.layer = 'platform')
     and exists (
       select 1 from public.profiles u
        where u.tenant_id = p.tenant_id
          and u.layer = 'tenant'
          and u.role not in ('tenant_owner', 'tenant_admin')
          and coalesce(u.is_active, true)
          and u.user_id <> p.user_id
          and not exists (select 1 from public.profiles q2
                           where q2.user_id = u.user_id and q2.layer = 'platform')
          and not exists (select 1 from public.profiles q3
                           where q3.user_id = u.user_id
                             and q3.tenant_id = p.tenant_id
                             and q3.role in ('tenant_owner', 'tenant_admin')))
   order by p.created_at
   limit 1;

  if v_tenant is not null then
    select u.user_id into v_user_uid
      from public.profiles u
     where u.tenant_id = v_tenant
       and u.layer = 'tenant'
       and u.role not in ('tenant_owner', 'tenant_admin')
       and coalesce(u.is_active, true)
       and u.user_id <> v_admin_uid
       and not exists (select 1 from public.profiles q2
                        where q2.user_id = u.user_id and q2.layer = 'platform')
       and not exists (select 1 from public.profiles q3
                        where q3.user_id = u.user_id
                          and q3.tenant_id = v_tenant
                          and q3.role in ('tenant_owner', 'tenant_admin'))
     order by u.created_at
     limit 1;
  end if;

  -- An owner/admin of a DIFFERENT tenant, with no profile in v_tenant and no
  -- platform profile. They must be a genuine owner/admin somewhere, or the
  -- cross-tenant refusal would just be the role bar firing again.
  select p.tenant_id, p.user_id
    into v_other_tenant, v_other_admin
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where p.layer = 'tenant'
     and p.role in ('tenant_owner', 'tenant_admin')
     and coalesce(p.is_active, true)
     and t.status in ('active', 'trial')
     and p.tenant_id is distinct from v_tenant
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.layer = 'platform')
     and not exists (select 1 from public.profiles q
                      where q.user_id = p.user_id and q.tenant_id = v_tenant)
   order by p.created_at
   limit 1;

  -- An ACTIVE platform-layer profile — probe 11's subject, and the pin on the
  -- deliberate absence of the contract's `p.layer = 'platform' or` disjunct.
  -- Nothing is written to this row; it is only impersonated through
  -- request.jwt.claim.sub, inside a sub-block that is rolled back.
  select p.user_id into v_platform_uid
    from public.profiles p
   where p.layer = 'platform'
     and coalesce(p.is_active, true)
   order by p.created_at
   limit 1;

  select key into v_dim from public.discovery_dimensions where active order by key limit 1;

  if v_tenant is null or v_user_uid is null or v_other_admin is null
     or v_platform_uid is null or v_dim is null then
    v_bad := array_append(v_bad, format(
      'VACUITY: this check could not assemble its fixtures — tenant=%L owner=%L non-admin member=%L second-tenant owner=%L platform profile=%L active dimension=%L. A missing fixture is not a pass: probe 5 could not tell "refused because of the role" from "refused because there is no identity", probe 6 could not fire the cross-tenant refusal, and probe 11 could not fire at all, so the platform disjunct could be put back into the role bar with everything here still green.',
      coalesce(v_tenant::text, 'NULL'), coalesce(v_admin_uid::text, 'NULL'),
      coalesce(v_user_uid::text, 'NULL'), coalesce(v_other_admin::text, 'NULL'),
      coalesce(v_platform_uid::text, 'NULL'), coalesce(v_dim, 'NULL')));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=11 assertions=0 caller=%s — fixtures missing, nothing was compared', v_caller));
    return array_cat(v_bad, v_notes);
  end if;

  -- Baselines are SCOPED TO THE TWO PROBE TENANTS, and the audit baseline is
  -- scoped further to this feature's own detail kind. A global count(*) on
  -- audit_events read again at the end of the same READ COMMITTED transaction
  -- would turn this red because some unrelated tenant committed a row while it
  -- ran. A check that fires for the wrong reason is no better than one that
  -- cannot fire. The exact leak checks below close the gap this narrowing
  -- opens, and they name survivors rather than only counting them.
  select count(*) into v_prop_before  from public.discovery_proposals
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_sess_before  from public.discovery_sessions
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_conn_before  from public.connectors
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_audit_before from public.audit_events
   where tenant_id in (v_tenant, v_other_tenant)
     and detail ->> 'kind' = 'discovery_proposal_decision';

  ------------------------------------------------------------------------
  -- PROBE 1 + 2 — the accept path SUCCEEDS (this is THE inversion), and a
  -- second accept on the same row is refused without writing anything.
  --
  -- Red if: accept refuses everything (then nothing below distinguishes a
  -- working gate from a broken function); or state and created_object_id are
  -- written apart; or the second click re-stamps, re-audits, or re-dates.
  -- The second call deliberately passes a DIFFERENT connector id, so a
  -- function that wrongly re-ran would visibly move created_object_id.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector accept', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector accept (decoy)', '', 'pending_credentials', 'other')
      returning id into v_conn_b;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('vddp', '1', 'provider_key', 'vddp_provider_a', 'label', 'Probe Helpdesk',
                                 'category', 'helpdesk',
                                 'credential_note', 'You still enter the credential yourself.'),
              'probe: matched in the evidence for this dimension', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', '  keep this note  ', v_conn);
    execute format('set local role %I', v_caller);

    v_p1_ok := (v_res ->> 'ok')::boolean;
    select state, created_object_id, decided_by, decided_at, last_error, ctid::text
      into v_p1_state, v_p1_obj, v_p1_by, v_p1_at, v_p1_err, v_p1_ctid
      from public.discovery_proposals where id = v_prop;

    select count(*) into v_p1_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'kind' = 'discovery_proposal_decision'
       and a.detail ->> 'proposal_id' = v_prop::text;

    select a.detail, a.actor_type, a.category
      into v_p1_detail, v_p1_actor_type, v_p1_category
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc, a.id desc
     limit 1;

    -- ---- PROBE 2: the second click ------------------------------------
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'accepted', 'second click', v_conn_b);
    execute format('set local role %I', v_caller);

    v_p2_ok    := (v_res2 ->> 'ok')::boolean;
    v_p2_error := v_res2 ->> 'error';
    v_p2_state := v_res2 ->> 'state';
    select created_object_id, decided_at, ctid::text into v_p2_obj, v_p2_at, v_p2_ctid
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p2_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'kind' = 'discovery_proposal_decision'
       and a.detail ->> 'proposal_id' = v_prop::text;

    v_d1 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      -- One sub-block, TWO probes: an abort here loses both.
      v_abort := format('PROBES 1 AND 2 ABORTED before they could finish (%s: %s) — the accept path and the double-click guard were NOT compared this run', sqlstate, sqlerrm);
      v_bad := array_append(v_bad, v_abort);
      v_d1 := false;
    end if;
  end;

  if v_d1 then
    -- TWO, not one: probes 1 and 2 share a sub-block because probe 2 is the
    -- second click on the row probe 1 just accepted, so eleven probes live in
    -- ten sub-blocks. Counting sub-blocks here would report 10/11 forever and
    -- teach whoever reads it that the denominator is approximate.
    v_probes_done := v_probes_done + 2;

    v_checks := v_checks + 1;
    if not coalesce(v_p1_ok, false) then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: an owner accepting a routable connector proposal got ok=%L. If every path refuses, none of the refusals below proves a gate works.', coalesce(v_p1_ok::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('accept left state=%L, expected accepted', coalesce(v_p1_state, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_obj is distinct from v_conn then
      v_bad := array_append(v_bad, 'accepted WITHOUT created_object_id being the connector the caller created — this is the exact state the Task 5 certify assertion goes red on');
    end if;
    v_checks := v_checks + 1;
    if v_p1_by is distinct from v_admin_uid then
      v_bad := array_append(v_bad, format('decided_by=%L, expected the deciding person %L — auth.uid() is not reaching the row', coalesce(v_p1_by::text,'NULL'), v_admin_uid::text));
    end if;
    v_checks := v_checks + 1;
    if v_p1_at is null then
      v_bad := array_append(v_bad, 'decided_at is null on an accepted proposal — a terminal state with no timestamp');
    end if;
    v_checks := v_checks + 1;
    if v_p1_err is not null then
      v_bad := array_append(v_bad, format('last_error survived a successful accept (%L) — a stale reason on a live row', v_p1_err));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p1_audit_n, 0) <> 1 then
      v_bad := array_append(v_bad, format('the accept wrote %s audit row(s), expected exactly 1', coalesce(v_p1_audit_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail -> 'payload' ->> 'credential_note' is distinct from 'You still enter the credential yourself.'
       or v_p1_detail -> 'payload' ->> 'provider_key' is distinct from 'vddp_provider_a' then
      v_bad := array_append(v_bad, format('the audit detail does not carry the payload VERBATIM — got %L. It is the only copy of what the customer consented to.', coalesce((v_p1_detail -> 'payload')::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> 'decided_by' is distinct from v_admin_uid::text then
      v_bad := array_append(v_bad, 'decided_by is not inside audit detail — the hash covers detail, not the actor column, so the identity is outside the tamper-evident chain');
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> 'created_object_table' is distinct from 'connectors' then
      v_bad := array_append(v_bad, format('audit detail created_object_table=%L — a bare uuid with no table name cannot be reconstructed once the row is gone', coalesce(v_p1_detail ->> 'created_object_table','NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> 'created_object_id' is distinct from v_conn::text then
      v_bad := array_append(v_bad, 'audit detail created_object_id does not match what was stamped');
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> 'note' is distinct from 'keep this note' then
      v_bad := array_append(v_bad, format('the note was not trimmed and recorded (got %L) — there is no note column, so the audit line is the only place it survives', coalesce(v_p1_detail ->> 'note','NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> 'writer' is distinct from 'connectProvider -> connectors (client, under RLS), stamped here' then
      v_bad := array_append(v_bad, format('audit detail writer=%L — the writer name is the only evidence no second creation engine ran', coalesce(v_p1_detail ->> 'writer','NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_actor_type is distinct from 'human' then
      v_bad := array_append(v_bad, format('the audit row actor_type=%L — a decision recorded as anything but human means append_audit_event took the service_role path and stamped no identity', coalesce(v_p1_actor_type,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p1_detail ->> '_submitted_by' is distinct from v_admin_uid::text then
      v_bad := array_append(v_bad, 'append_audit_event did not stamp _submitted_by — the server-attested identity is missing from the chain');
    end if;
    v_checks := v_checks + 1;
    if v_p1_category is distinct from 'config_change' then
      v_bad := array_append(v_bad, format('audit category=%L, expected config_change', coalesce(v_p1_category,'NULL')));
    end if;

    v_checks := v_checks + 1;
    if coalesce(v_p2_ok, true) then
      v_bad := array_append(v_bad, 'a SECOND accept on an already-accepted proposal returned ok=true — the compare-and-swap is not guarding the double click');
    end if;
    v_checks := v_checks + 1;
    if v_p2_error is distinct from 'already_decided' then
      v_bad := array_append(v_bad, format('the second accept returned error=%L, expected already_decided', coalesce(v_p2_error,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p2_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('already_decided reported state=%L — the caller cannot see what it was already decided as', coalesce(v_p2_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p2_obj is distinct from v_conn then
      v_bad := array_append(v_bad, format('the second accept RE-STAMPED created_object_id to %L — it was handed a different connector id and took it', coalesce(v_p2_obj::text,'NULL')));
    end if;
    -- ⚠ THIS ONE CANNOT FAIL, and it is kept anyway — see the header. now() is
    -- the transaction timestamp, so a wrongly re-run accept would rewrite
    -- decided_at with the value it already holds. It is true about production,
    -- where the two clicks are separate transactions; it is inert here.
    v_checks := v_checks + 1;
    if v_p2_at is distinct from v_p1_at then
      v_bad := array_append(v_bad, 'the second accept moved decided_at — a refused call must write nothing at all');
    end if;
    -- ...and this is the one that CAN. Any UPDATE gives the row a new tuple
    -- version, so an unchanged ctid is proof the refused call wrote nothing —
    -- independent of what value it would have written.
    v_checks := v_checks + 1;
    if v_p2_ctid is distinct from v_p1_ctid then
      v_bad := array_append(v_bad, format('the second accept REWROTE the proposal row (ctid %s -> %s) — the compare-and-swap matched a row it should not have, and a refused call must write nothing at all', coalesce(v_p1_ctid,'NULL'), coalesce(v_p2_ctid,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p2_audit_n, 0) <> 1 then
      v_bad := array_append(v_bad, format('after the second accept the proposal has %s audit rows, expected still exactly 1 — this is the shape that logged one approval three times', coalesce(v_p2_audit_n::text,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 3 — DECLINE creates nothing and leaves an audit row, and DECLINED
  -- IS TERMINAL.
  --
  -- Red if: decline routes into Zone 3 and creates something; or a refusal is
  -- recorded nowhere, which would make "seen and refused" indistinguishable
  -- from "never generated"; or a customer's "no" can be overwritten.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    -- A REAL, live connector in this workspace, so the re-decide below is not
    -- refused for some incidental reason. If the CAS ever admitted 'declined',
    -- this accept would fully SUCCEED and the assertions would report the
    -- loudest possible failure — state flipped to 'accepted' with an object
    -- stamped on a proposal the customer had refused.
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector decline', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('vddp', '1', 'provider_key', 'vddp_provider_decline', 'label', 'Probe Decline'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    -- ⚠ the digital_employees count EXCLUDES the Workspace Assistant. Nothing
    -- in this function may read or write a row with is_workforce_assistant =
    -- true, and count(*) touches every row it counts.
    -- ⚠ SCOPED TO THE PROBE TENANT, and that is a deliberate correction to what
    -- 741 did. 741 counted these GLOBALLY. It ran ONCE, so a concurrent commit
    -- by an unrelated workspace between the two counts was a vanishingly
    -- unlikely one-off. This function runs on every certify, forever, and READ
    -- COMMITTED gives each count a fresh snapshot — so a global delta would
    -- eventually report "decline changed row counts" because some other tenant
    -- inserted a connector while this ran. That is a red with the wrong
    -- diagnosis on a healthy system, which is worse than no check at all.
    -- Nothing is lost by narrowing: the decline under test cannot create a row
    -- in another tenant, so a delta anywhere else was never evidence about it.
    -- The outer rollback baselines were narrowed for exactly this reason; this
    -- is the same argument applied where it had been missed.
    select count(*) into v_p3_conn_pre from public.connectors where tenant_id = v_tenant;
    select count(*) into v_p3_de_pre   from public.digital_employees
                                       where tenant_id = v_tenant
                                         and coalesce(is_workforce_assistant, false) = false;
    select count(*) into v_p3_gr_pre   from public.guardrail_rules where tenant_id = v_tenant;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'declined', 'we do not use that system');
    execute format('set local role %I', v_caller);

    select state, created_object_id, decided_by, decided_at, ctid::text
      into v_p3_state, v_p3_obj, v_p3_by, v_p3_at, v_p3_ctid
      from public.discovery_proposals where id = v_prop;

    select count(*) - v_p3_conn_pre into v_p3_conn_delta from public.connectors where tenant_id = v_tenant;
    select count(*) - v_p3_de_pre   into v_p3_de_delta   from public.digital_employees
                                                         where tenant_id = v_tenant
                                                           and coalesce(is_workforce_assistant, false) = false;
    select count(*) - v_p3_gr_pre   into v_p3_gr_delta   from public.guardrail_rules where tenant_id = v_tenant;

    select count(*) into v_p3_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;
    select a.detail ->> 'note', a.detail ->> 'decision' into v_p3_note, v_p3_decision
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc, a.id desc limit 1;

    -- DECLINED IS TERMINAL. Probe 2 proves terminality only for 'accepted', so
    -- widening the Zone-2 CAS to `state in ('pending','parked','declined')`
    -- would go unnoticed — and a re-decided decline would overwrite the only
    -- sentence explaining why the customer said no. The retry deliberately asks
    -- for 'accepted' with a real connector id, so a function that wrongly
    -- re-ran would visibly stamp created_object_id and flip the state.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'accepted', 'changed my mind', v_conn);
    execute format('set local role %I', v_caller);

    v_p3_re_ok    := (v_res2 ->> 'ok')::boolean;
    v_p3_re_error := v_res2 ->> 'error';
    v_p3_re_state := v_res2 ->> 'state';
    select state, decided_at, created_object_id, ctid::text
      into v_p3_re_row_state, v_p3_re_at, v_p3_re_obj, v_p3_re_ctid
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p3_re_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;

    v_d3 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 3 ABORTED before it could finish (%s: %s) — decline-creates-nothing and declined-is-terminal were NOT compared this run', sqlstate, sqlerrm));
      v_d3 := false;
    end if;
  end;

  if v_d3 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if v_p3_state is distinct from 'declined' then
      v_bad := array_append(v_bad, format('decline left state=%L', coalesce(v_p3_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p3_obj is not null then
      v_bad := array_append(v_bad, 'a DECLINED proposal has a created_object_id — declining created something');
    end if;
    v_checks := v_checks + 1;
    if v_p3_by is distinct from v_admin_uid then
      v_bad := array_append(v_bad, 'a declined proposal did not record who declined it');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p3_conn_delta,-1) <> 0 or coalesce(v_p3_de_delta,-1) <> 0 or coalesce(v_p3_gr_delta,-1) <> 0 then
      v_bad := array_append(v_bad, format('decline changed row counts: connectors %s, digital_employees %s, guardrail_rules %s — declining must create nothing anywhere',
        coalesce(v_p3_conn_delta::text,'NULL'), coalesce(v_p3_de_delta::text,'NULL'), coalesce(v_p3_gr_delta::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p3_audit_n,0) <> 1 then
      v_bad := array_append(v_bad, format('decline wrote %s audit row(s), expected 1 — an unaudited decline destroys the only sentence explaining why a customer said no', coalesce(v_p3_audit_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p3_note is distinct from 'we do not use that system' or v_p3_decision is distinct from 'declined' then
      v_bad := array_append(v_bad, format('the decline audit line reads decision=%L note=%L', coalesce(v_p3_decision,'NULL'), coalesce(v_p3_note,'NULL')));
    end if;

    -- ---- DECLINED IS TERMINAL ----
    v_checks := v_checks + 1;
    if coalesce(v_p3_re_ok, true) then
      v_bad := array_append(v_bad, 'a DECLINED proposal was re-decided and returned ok=true — "declined is terminal" is asserted in migration 741''s header and the CAS is not enforcing it');
    end if;
    v_checks := v_checks + 1;
    if v_p3_re_error is distinct from 'already_decided' then
      v_bad := array_append(v_bad, format('re-deciding a declined proposal returned error=%L, expected already_decided', coalesce(v_p3_re_error,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p3_re_state is distinct from 'declined' or v_p3_re_row_state is distinct from 'declined' then
      v_bad := array_append(v_bad, format('after re-deciding, already_decided reported state=%L and the row reads %L — a customer''s "no" was overwritten', coalesce(v_p3_re_state,'NULL'), coalesce(v_p3_re_row_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p3_re_obj is not null then
      v_bad := array_append(v_bad, 'the re-decide STAMPED a created_object_id onto a declined proposal — declining is supposed to create nothing, ever');
    end if;
    -- Inert for the same reason as probe 2's twin — kept because it is true
    -- about production, paired below with the one that can fail.
    v_checks := v_checks + 1;
    if v_p3_re_at is distinct from v_p3_at then
      v_bad := array_append(v_bad, 'the re-decide moved decided_at on a declined proposal — a refused call must write nothing at all');
    end if;
    v_checks := v_checks + 1;
    if v_p3_re_ctid is distinct from v_p3_ctid then
      v_bad := array_append(v_bad, format('the re-decide REWROTE the declined row (ctid %s -> %s) — a customer''s "no" was overwritten by a call that should have matched zero rows', coalesce(v_p3_ctid,'NULL'), coalesce(v_p3_re_ctid,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p3_re_audit_n, 0) <> 1 then
      v_bad := array_append(v_bad, format('after re-deciding, the declined proposal has %s audit rows, expected still exactly 1 — a second line would rewrite the record of why the customer said no', coalesce(v_p3_re_audit_n::text,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 4 — PARK is not decline, park is IDEMPOTENT, and a parked proposal
  -- is still decidable.
  --
  -- Red if: park writes 'declined'; or park is terminal, which would make it a
  -- decline with softer wording; or a double-clicked Park re-dates the row and
  -- writes a second audit line while returning ok=true twice.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector park', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('vddp', '1', 'provider_key', 'vddp_provider_park', 'label', 'Probe Park'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'parked', 'ask me after the migration');
    execute format('set local role %I', v_caller);

    v_p4_park_ok := (v_res ->> 'ok')::boolean;
    select state, decided_at, ctid::text into v_p4_park_state, v_p4_park_at, v_p4_park_ctid
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p4_audit_park
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
       and a.detail ->> 'decision' = 'parked';

    -- PARK IS IDEMPOTENT — the second click. Widening the CAS to admit
    -- 'parked' is what keeps a parked proposal decidable, but on its own it
    -- also lets a double-clicked Park match again. `and not (state = 'parked'
    -- and p_decision = 'parked')` is the guard, and this is the only thing
    -- that fires it.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'parked', 'still not now');
    execute format('set local role %I', v_caller);

    v_p4_park2_ok    := (v_res2 ->> 'ok')::boolean;
    v_p4_park2_error := v_res2 ->> 'error';
    v_p4_park2_state := v_res2 ->> 'state';
    select state, decided_at, ctid::text into v_p4_park2_row, v_p4_park2_at, v_p4_park2_ctid
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p4_park2_audit
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
       and a.detail ->> 'decision' = 'parked';

    -- ...and it can still be decided afterwards. THIS is the inversion that
    -- keeps the clause above from turning park into a terminal state.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'accepted', 'ready now', v_conn);
    execute format('set local role %I', v_caller);

    v_p4_acc_ok := (v_res2 ->> 'ok')::boolean;
    select state, created_object_id into v_p4_acc_state, v_p4_acc_obj
      from public.discovery_proposals where id = v_prop;

    v_d4 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 4 ABORTED before it could finish (%s: %s) — park-is-not-decline, park-is-idempotent and parked-stays-decidable were NOT compared this run', sqlstate, sqlerrm));
      v_d4 := false;
    end if;
  end;

  if v_d4 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if not coalesce(v_p4_park_ok, false) or v_p4_park_state is distinct from 'parked' then
      v_bad := array_append(v_bad, format('park returned ok=%L and left state=%L', coalesce(v_p4_park_ok::text,'NULL'), coalesce(v_p4_park_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p4_park_state = 'declined' then
      v_bad := array_append(v_bad, 'PARK WROTE DECLINED — "ask me later" was recorded as "no"');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p4_audit_park,0) <> 1 then
      v_bad := array_append(v_bad, format('park wrote %s audit row(s) with decision=parked, expected 1 — an unaudited park is the invisible pile', coalesce(v_p4_audit_park::text,'NULL')));
    end if;

    -- ---- the second Park ----
    v_checks := v_checks + 1;
    if coalesce(v_p4_park2_ok, true) then
      v_bad := array_append(v_bad, 'a SECOND Park on an already-parked proposal returned ok=true — park is not idempotent, and the CAS clause `and not (state = ''parked'' and p_decision = ''parked'')` is not firing');
    end if;
    v_checks := v_checks + 1;
    if v_p4_park2_error is distinct from 'already_decided' then
      v_bad := array_append(v_bad, format('the second Park returned error=%L, expected already_decided', coalesce(v_p4_park2_error,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p4_park2_state is distinct from 'parked' or v_p4_park2_row is distinct from 'parked' then
      v_bad := array_append(v_bad, format('after a second Park the call reported state=%L and the row reads %L', coalesce(v_p4_park2_state,'NULL'), coalesce(v_p4_park2_row,'NULL')));
    end if;
    -- Inert for the same reason as its two siblings — kept, and paired.
    v_checks := v_checks + 1;
    if v_p4_park2_at is distinct from v_p4_park_at then
      v_bad := array_append(v_bad, 'the second Park moved decided_at — a refused call must write nothing at all');
    end if;
    v_checks := v_checks + 1;
    if v_p4_park2_ctid is distinct from v_p4_park_ctid then
      v_bad := array_append(v_bad, format('the second Park REWROTE the parked row (ctid %s -> %s) — `and not (state = ''parked'' and p_decision = ''parked'')` is not firing and a double-clicked Park is re-dating the row', coalesce(v_p4_park_ctid,'NULL'), coalesce(v_p4_park2_ctid,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p4_park2_audit, 0) <> 1 then
      v_bad := array_append(v_bad, format('after a second Park the proposal has %s audit row(s) with decision=parked, expected still exactly 1 — this is the shape that logged one approval three times', coalesce(v_p4_park2_audit::text,'NULL')));
    end if;

    v_checks := v_checks + 1;
    if not coalesce(v_p4_acc_ok, false) or v_p4_acc_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('a PARKED proposal could not be accepted later (ok=%L state=%L) — park is behaving as a terminal state, which makes it a decline', coalesce(v_p4_acc_ok::text,'NULL'), coalesce(v_p4_acc_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p4_acc_obj is distinct from v_conn then
      v_bad := array_append(v_bad, 'accepting a parked proposal did not stamp its created_object_id');
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 5 — THE ROLE BAR, and the proof that the refusal is about the ROLE.
  --
  --   (a) auth.uid() resolves to the tenant_user — they are NOT anonymous;
  --   (b) that same identity DECLINES successfully — the function is reachable
  --       to them and their identity is accepted for the ungated arm;
  --   (c) that same identity is REFUSED on accept;
  --   (d) the OWNER then accepts THE SAME proposal row with THE SAME connector
  --       id and succeeds.
  --
  -- Without (b) and (d) this probe would be indistinguishable from "the call
  -- failed for some other reason".
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector role', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_role_a','label','Probe Role A'), 'probe', v_dim, 'pending')
      returning id into v_prop;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_role_b','label','Probe Role B'), 'probe', v_dim, 'pending')
      returning id into v_prop_b;

    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    select auth.uid() into v_p5_seen_uid;

    -- (b) the ungated arm works for this very identity
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'declined', 'not for us');
      v_p5_decline_ok := (v_res ->> 'ok')::boolean;
      v_p5_decline_st := v_res ->> 'state';
    exception when others then
      v_p5_decline_ok := false;
      v_p5_decline_st := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    -- (c) the gated arm refuses the same identity
    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'let me in', v_conn);
    exception when others then
      v_p5_refused := true;
      v_p5_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    -- (d) THE INVERSION — same row, same connector id, owner instead
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'approved', v_conn);
      v_p5_admin_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p5_admin_ok := false;
      v_p5_msg      := concat(coalesce(v_p5_msg, ''), ' / owner also failed: ', sqlerrm);
    end;
    execute format('set local role %I', v_caller);
    select state into v_p5_admin_state from public.discovery_proposals where id = v_prop_b;

    v_d5 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 5 ABORTED before it could finish (%s: %s) — the role bar was NOT compared this run', sqlstate, sqlerrm));
      v_d5 := false;
    end if;
  end;

  if v_d5 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if v_p5_seen_uid is distinct from v_user_uid then
      v_bad := array_append(v_bad, format('the probe could not put a real identity on the transaction (auth.uid()=%L) — everything probe 5 claims about ROLE would actually be about being unauthenticated', coalesce(v_p5_seen_uid::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p5_decline_ok, false) or v_p5_decline_st is distinct from 'declined' then
      v_bad := array_append(v_bad, format('the tenant_user could not DECLINE (%L) — so the accept refusal below is not attributable to the role bar, and saying "no" has been gated, which is not an authority model', coalesce(v_p5_decline_st,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p5_refused then
      v_bad := array_append(v_bad, 'a tenant_user ACCEPTED a discovery proposal — the role bar is not firing, and accepting is what creates employees, guardrails and trust caps from nothing');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p5_msg,'') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but for the wrong reason: %L. A refusal that is really about something else proves nothing about the role bar.', coalesce(v_p5_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p5_admin_ok, false) or v_p5_admin_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the OWNER could not accept the SAME row with the SAME connector id (state=%L). The tenant_user refusal therefore proves nothing about roles.', coalesce(v_p5_admin_state,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 6 — a proposal id is not its own authorisation.
  --
  -- The other tenant's owner first accepts a proposal in THEIR OWN workspace,
  -- so the refusal that follows cannot be read as "that user cannot accept
  -- anything". Then both the gated arm (accept) and the ungated one (decline)
  -- are fired at tenant A's proposal; the decline must fail too, via
  -- append_audit_event's membership check, or "ungated" would mean "open to
  -- every workspace on the platform".
  ------------------------------------------------------------------------
  begin
    -- their own workspace
    insert into public.discovery_sessions (tenant_id) values (v_other_tenant) returning id into v_session_b;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_other_tenant, 'generic_rest', 'vddp probe connector own', '', 'pending_credentials', 'other')
      returning id into v_conn_other;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_other_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_own','label','Probe Own'), 'probe', v_dim, 'pending')
      returning id into v_prop_other;

    -- tenant A's workspace
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector cross', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_cross','label','Probe Cross'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_other, 'accepted', 'mine', v_conn_other);
      v_p6_own_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p6_own_ok := false;
      v_p6_cross_msg := concat('own-tenant accept failed: ', sqlerrm);
    end;
    execute format('set local role %I', v_caller);

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'not mine', v_conn);
    exception when others then
      v_p6_cross_ref := true;
      v_p6_cross_msg := concat(case when v_p6_cross_msg is null then '' else v_p6_cross_msg || ' / ' end, sqlerrm);
    end;
    execute format('set local role %I', v_caller);

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'declined', 'not mine either');
    exception when others then
      v_p6_decline_ref := true;
      v_p6_decline_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    select state into v_p6_cross_state from public.discovery_proposals where id = v_prop;

    v_d6 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 6 ABORTED before it could finish (%s: %s) — the cross-tenant refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d6 := false;
    end if;
  end;

  if v_d6 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if not coalesce(v_p6_own_ok, false) then
      v_bad := array_append(v_bad, format('the second tenant''s owner could not accept a proposal in their OWN workspace (%L) — so the cross-tenant refusal below is not evidence about tenancy', coalesce(v_p6_cross_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p6_cross_ref then
      v_bad := array_append(v_bad, 'an owner of ANOTHER workspace ACCEPTED this tenant''s proposal — the proposal id was treated as its own authorisation');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p6_cross_msg,'') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the cross-tenant accept was refused for the wrong reason: %L', coalesce(v_p6_cross_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p6_decline_ref then
      v_bad := array_append(v_bad, 'an owner of ANOTHER workspace DECLINED this tenant''s proposal — decline is ungated by ROLE, but it must never be open across tenants. The refusal is expected to come from append_audit_event''s membership check, which raises and takes the claim down with it.');
    elsif coalesce(v_p6_decline_msg, '') = '' then
      v_bad := array_append(v_bad, 'the cross-tenant decline was refused with an empty message — a refusal nobody can read is the failure this whole migration is about');
    end if;
    v_checks := v_checks + 1;
    if v_p6_cross_state is distinct from 'pending' then
      v_bad := array_append(v_bad, format('after two refused cross-tenant decisions the proposal is %L, not pending — a refused call wrote to the row', coalesce(v_p6_cross_state,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 7 — AN UNROUTABLE KIND. The whole reason migration 740 exists.
  --
  -- 'guardrail' is a value discovery_proposals_kind_check ACCEPTS, so the
  -- refusal can only come from the router — a refusal intercepted by an
  -- earlier constraint would prove nothing.
  --
  -- Red if: an unroutable kind is silently accepted (worst case: 'accepted'
  -- with a null created_object_id); or the reason is not written down, which
  -- makes "the writer refused" indistinguishable from "nobody got to it"; or
  -- `attempts` does not move, so a card on its third failure looks like a
  -- card on its first.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never promise a refund','pattern','refund|chargeback','severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    -- a sibling the router CAN route, in the same session, decided by the
    -- same owner — so a refusal below is about the KIND and nothing else
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector sibling', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_sibling','label','Probe Sibling'), 'probe', v_dim, 'pending')
      returning id into v_prop_b;
    -- for step (e): the row that has ALREADY failed twice gets a real connector
    -- to succeed with, so the retry is a genuine second attempt on the same row
    -- rather than a fresh one.
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector retry', '', 'pending_credentials', 'other')
      returning id into v_conn_b;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'try it', null);
    execute format('set local role %I', v_caller);

    v_p7_ok    := (v_res ->> 'ok')::boolean;
    v_p7_error := v_res ->> 'error';
    select state, last_error, last_error_at, attempts, decided_by, decided_at, created_object_id
      into v_p7_state, v_p7_lasterr, v_p7_lastat, v_p7_attempts, v_p7_by, v_p7_at, v_p7_obj
      from public.discovery_proposals where id = v_prop;

    select count(*), max(a.detail ->> 'outcome') into v_p7_audit_n, v_p7_audit_out
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;

    -- a second attempt must INCREMENT, not merely set
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'try it again', null);
    execute format('set local role %I', v_caller);
    select attempts into v_p7_attempts2 from public.discovery_proposals where id = v_prop;

    -- (e) THE RETRY LOOP — the ONLY place `last_error = null, last_error_at =
    -- null` on the success path is fired. Every other probe that accepts a
    -- proposal accepts one that had never failed, so the two clears could be
    -- deleted from the success UPDATE with all assertions still green — and a
    -- card that had failed once would read "accepted" and "failed because kind
    -- not yet routable: guardrail" at the same time, forever. This row has
    -- genuinely failed twice and carries a real reason; making its kind
    -- routable is the stand-in for the product's own retry.
    select last_error into v_p7_pre_lasterr
      from public.discovery_proposals where id = v_prop;
    update public.discovery_proposals set kind = 'connector' where id = v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'routable now', v_conn_b);
    execute format('set local role %I', v_caller);

    v_p7_retry_ok := (v_res ->> 'ok')::boolean;
    select state, last_error, last_error_at, attempts, created_object_id
      into v_p7_retry_state, v_p7_retry_err, v_p7_retry_at, v_p7_retry_att, v_p7_retry_obj
      from public.discovery_proposals where id = v_prop;

    -- THE INVERSION: the routable sibling, same session, same owner
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'this one routes', v_conn);
    execute format('set local role %I', v_caller);
    v_p7_sibling_ok := (v_res ->> 'ok')::boolean;
    select state into v_p7_sibling_st from public.discovery_proposals where id = v_prop_b;

    v_d7 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 7 ABORTED before it could finish (%s: %s) — the unroutable-kind refusal, the attempts counter and the retry loop were NOT compared this run', sqlstate, sqlerrm));
      v_d7 := false;
    end if;
  end;

  if v_d7 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if coalesce(v_p7_ok, true) then
      v_bad := array_append(v_bad, 'an UNROUTABLE kind returned ok=true — a kind with no writer reported success at doing nothing');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p7_error,'') not like 'kind not yet routable%' then
      v_bad := array_append(v_bad, format('the unroutable refusal reads %L — it must name the kind so the card can say why', coalesce(v_p7_error,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_state is distinct from 'pending' then
      v_bad := array_append(v_bad, format('after a refused accept the proposal is %L, not pending — a failed accept must return it to the deck (and %L would mean an accepted row with no object)', coalesce(v_p7_state,'NULL'), coalesce(v_p7_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_lasterr is null or v_p7_lasterr not like 'kind not yet routable%' then
      v_bad := array_append(v_bad, format('last_error is %L after a refusal — this is the whole point of migration 740: a silent refusal is indistinguishable from an undecided proposal', coalesce(v_p7_lasterr,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_lastat is null then
      v_bad := array_append(v_bad, 'last_error_at is null after a refusal — a reason with no date cannot be told from a stale one');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p7_attempts, -1) <> 1 then
      v_bad := array_append(v_bad, format('attempts=%L after one failed accept, expected 1', coalesce(v_p7_attempts::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p7_attempts2, -1) <> 2 then
      v_bad := array_append(v_bad, format('attempts=%L after a SECOND failed accept, expected 2 — the counter is being set, not incremented, so a card on its third try looks like its first', coalesce(v_p7_attempts2::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_by is not null or v_p7_at is not null then
      v_bad := array_append(v_bad, 'a refused accept left decided_by/decided_at on a pending row — the row claims a decision that did not happen');
    end if;
    v_checks := v_checks + 1;
    if v_p7_obj is not null then
      v_bad := array_append(v_bad, 'a refused accept stamped a created_object_id');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p7_audit_n,0) <> 1 or v_p7_audit_out is distinct from 'refused' then
      v_bad := array_append(v_bad, format('the refusal wrote %s audit row(s) with outcome=%L, expected 1 marked refused', coalesce(v_p7_audit_n::text,'NULL'), coalesce(v_p7_audit_out,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p7_sibling_ok, false) or v_p7_sibling_st is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the routable sibling in the SAME session, decided by the SAME owner, was not accepted (state=%L). The guardrail refusal is then not about the kind.', coalesce(v_p7_sibling_st,'NULL')));
    end if;

    -- ---- (e) the retry loop: a row that HAD a reason is accepted ----
    v_checks := v_checks + 1;
    if v_p7_pre_lasterr is null then
      v_bad := array_append(v_bad, 'the retry step started from a row with NO last_error — then "last_error is null afterwards" proves nothing, because it was never anything else. This assertion exists so the clear below cannot pass vacuously.');
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p7_retry_ok, false) or v_p7_retry_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE RETRY FAILED: a proposal that had failed twice could not be accepted once its kind was routable (ok=%L state=%L). A card that fails is then permanently stuck, which is worse than the silence 740 exists to end.', coalesce(v_p7_retry_ok::text,'NULL'), coalesce(v_p7_retry_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_retry_err is not null or v_p7_retry_at is not null then
      v_bad := array_append(v_bad, format('a SUCCESSFUL accept left last_error=%L / last_error_at=%L on the row — the card would read "accepted" and "failed because…" at the same time, forever', coalesce(v_p7_retry_err,'NULL'), coalesce(v_p7_retry_at::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p7_retry_obj is distinct from v_conn_b then
      v_bad := array_append(v_bad, 'the successful retry did not stamp the connector it was given');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p7_retry_att, -1) <> 2 then
      v_bad := array_append(v_bad, format('after a successful retry attempts=%L, expected it to STAY at 2. attempts counts how hard this was, not whether it is currently broken — last_error is what says that, and it has been cleared. Silently zeroing it would erase the evidence of the two failures.', coalesce(v_p7_retry_att::text,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 8 — a DEACTIVATED owner cannot accept.
  --
  -- `coalesce(p.is_active, true)` is in the role predicate; if it were never
  -- fired it would be decoration. The same owner accepted successfully in
  -- probe 1, so the only thing that changed is the flag.
  --
  -- ⚠ This deactivates a REAL person's profile row inside its own sub-block.
  -- The sentinel rolls it back, and that they are active again is asserted at
  -- the bottom of this function, on every run.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector inactive', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_inactive','label','Probe Inactive'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    update public.profiles set is_active = false
     where user_id = v_admin_uid and tenant_id = v_tenant;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'still here?', v_conn);
    exception when others then
      v_p8_refused := true;
      v_p8_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    v_d8 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 8 ABORTED before it could finish (%s: %s) — the deactivated-owner refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d8 := false;
    end if;
  end;

  if v_d8 then
    v_probes_done := v_probes_done + 1;
    v_checks := v_checks + 1;
    if not v_p8_refused or coalesce(v_p8_msg,'') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('a DEACTIVATED owner accepted a discovery proposal (refused=%L, %L) — coalesce(is_active, true) in the role predicate is decoration', coalesce(v_p8_refused::text,'NULL'), coalesce(v_p8_msg,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 9 — NO IDENTITY AT ALL. The null-uid refusal, actually fired.
  --
  -- ⚠ BOTH GUCs. The live auth.uid() body falls back from
  -- request.jwt.claim.sub to request.jwt.claims->>'sub', so clearing only the
  -- first leaves a fallback. `v_p9_uid_seen` is asserted null below precisely
  -- so "refused" cannot be mistaken for "the probe failed to clear the
  -- identity" — a refusal for the wrong reason is no evidence.
  --
  -- ⚠ IT FIRES **DECLINE**, NOT ACCEPT, AND THAT IS THE WHOLE CONSTRUCTION.
  -- Accept is role-gated, so a null uid would be refused by the role bar too
  -- and the probe could not tell the two apart. Decline is ungated, so the
  -- ONLY thing in Zone 1 that can refuse it is the null-uid line. Deleting
  -- that line does not make this probe green: the call would then claim the
  -- row with decided_by = NULL and die inside append_audit_event's membership
  -- check instead — which is why the MESSAGE is asserted, not merely the fact
  -- of a refusal.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector anon', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_anon','label','Probe Anon'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims',   '', true);
    select auth.uid() into v_p9_uid_seen;

    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'declined', 'nobody at all');
    exception when others then
      v_p9_refused := true;
      v_p9_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    select state, last_error into v_p9_state, v_p9_lasterr
      from public.discovery_proposals where id = v_prop;

    -- THE INVERSION — the same row, an identity present, and it works.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'a real person', v_conn);
      v_p9_inv_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p9_inv_ok := false;
      v_p9_msg    := concat(coalesce(v_p9_msg,''), ' / the IDENTIFIED caller also failed: ', sqlerrm);
    end;
    execute format('set local role %I', v_caller);
    select state into v_p9_inv_state from public.discovery_proposals where id = v_prop;

    v_d9 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 9 ABORTED before it could finish (%s: %s) — the null-uid refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d9 := false;
    end if;
  end;

  if v_d9 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if v_p9_uid_seen is not null then
      v_bad := array_append(v_bad, format('the probe could not clear the identity (auth.uid()=%L) — everything below would then be a statement about some OTHER refusal, not about the null-uid bar', v_p9_uid_seen::text));
    end if;
    v_checks := v_checks + 1;
    if not v_p9_refused then
      v_bad := array_append(v_bad, 'a caller with NO identity DECLINED a discovery proposal — decided_by would be null on a terminal row, which is a decision nobody made, and it is unsatisfiable for the Task 5 certify assertion');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p9_msg,'') not like 'not authenticated%' then
      v_bad := array_append(v_bad, format('the unidentified caller was refused, but by something OTHER than the null-uid bar: %L. If that line is gone, the call claims the row with decided_by=NULL and dies later inside append_audit_event — a different refusal, in worse words, after a write.', coalesce(v_p9_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p9_state is distinct from 'pending' or v_p9_lasterr is not null then
      v_bad := array_append(v_bad, format('the refused anonymous call left state=%L last_error=%L — Zone 1 refuses BEFORE anything is written', coalesce(v_p9_state,'NULL'), coalesce(v_p9_lasterr,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p9_inv_ok, false) or v_p9_inv_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the same row could not be decided by an IDENTIFIED owner either (state=%L). The anonymous refusal then proves nothing about identity.', coalesce(v_p9_inv_state,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 10 — A CREATED-OBJECT ID IS NOT ITS OWN AUTHORISATION.
  --
  -- Every other probe pairs a connector with a proposal in the SAME tenant, so
  -- `and c.tenant_id = v_p.tenant_id` in the connector arm could be deleted
  -- with all assertions still green — and tenant A's own owner could stamp
  -- tenant B's connector id onto tenant A's proposal, satisfying certify's
  -- "no accepted row without a created_object_id" with a cross-tenant pointer.
  --
  -- The caller here is tenant A's OWN owner deciding tenant A's OWN proposal —
  -- so nothing about the role bar or the proposal's tenancy is in play. The
  -- only wrong thing is the id, and step (b) proves it by handing the same
  -- owner the same row with a connector that IS theirs.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_other_tenant, 'generic_rest', 'vddp probe connector foreign', '', 'pending_credentials', 'other')
      returning id into v_conn_other;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector home', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_foreign_id','label','Probe Foreign Id'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    -- (a) the right person, the right proposal, ANOTHER WORKSPACE'S connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'someone else''s connector', v_conn_other);
    execute format('set local role %I', v_caller);

    v_p10_ok    := (v_res ->> 'ok')::boolean;
    v_p10_error := v_res ->> 'error';
    select state, created_object_id, last_error, last_error_at, attempts
      into v_p10_state, v_p10_obj, v_p10_lasterr, v_p10_lastat, v_p10_attempts
      from public.discovery_proposals where id = v_prop;

    -- (b) THE INVERSION — same owner, same row, THIS workspace's connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'my own connector', v_conn);
    execute format('set local role %I', v_caller);

    v_p10_fix_ok := (v_res ->> 'ok')::boolean;
    select state, created_object_id, last_error, last_error_at
      into v_p10_fix_state, v_p10_fix_obj, v_p10_fix_err, v_p10_fix_at
      from public.discovery_proposals where id = v_prop;

    v_d10 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 10 ABORTED before it could finish (%s: %s) — the foreign-connector-id refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d10 := false;
    end if;
  end;

  if v_d10 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if coalesce(v_p10_ok, true) then
      v_bad := array_append(v_bad, 'a workspace owner stamped ANOTHER WORKSPACE''S connector id onto their own proposal and got ok=true — a created-object id was treated as its own authorisation, and certify''s "no accepted row without a created_object_id" would be satisfied by a cross-tenant pointer');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p10_error,'') not like 'no connector %' then
      v_bad := array_append(v_bad, format('the foreign connector id was refused for the wrong reason: %L', coalesce(v_p10_error,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p10_state is distinct from 'pending' or v_p10_obj is not null then
      v_bad := array_append(v_bad, format('after the foreign-id refusal the row reads state=%L created_object_id=%L — a refused accept must return it to the deck with nothing stamped', coalesce(v_p10_state,'NULL'), coalesce(v_p10_obj::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p10_lasterr is null or v_p10_lasterr not like 'no connector %' or v_p10_lastat is null
       or coalesce(v_p10_attempts, -1) <> 1 then
      v_bad := array_append(v_bad, format('the foreign-id refusal recorded last_error=%L last_error_at=%L attempts=%L — a refusal nobody can read is the failure this migration exists to end', coalesce(v_p10_lasterr,'NULL'), coalesce(v_p10_lastat::text,'NULL'), coalesce(v_p10_attempts::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p10_fix_ok, false) or v_p10_fix_state is distinct from 'accepted'
       or v_p10_fix_obj is distinct from v_conn then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the SAME owner could not accept the SAME row with a connector that IS theirs (ok=%L state=%L). The refusal above is then not about tenancy, and a card that fails once is stuck forever.', coalesce(v_p10_fix_ok::text,'NULL'), coalesce(v_p10_fix_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p10_fix_err is not null or v_p10_fix_at is not null then
      v_bad := array_append(v_bad, format('the successful retry left last_error=%L / last_error_at=%L behind — the card would read "accepted" and "no connector … in this workspace" at once', coalesce(v_p10_fix_err,'NULL'), coalesce(v_p10_fix_at::text,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 11 — A PLATFORM-LAYER PROFILE HAS NO STANDING INSIDE A TENANT.
  --
  -- This pins the deliberate absence of the contract's `p.layer = 'platform'
  -- or` disjunct. Both fixture queries above filter platform-profile holders
  -- OUT, so without this probe the arm is never driven in either direction.
  --
  -- ⚠ THE ASSERTION IS ON THE MESSAGE, NOT ON "was it refused". Put the
  -- disjunct back and this call is still refused — but LATER and ELSEWHERE:
  -- Zone 1 passes, the CAS CLAIMS the row, and append_audit_event then raises
  -- 'not a member of this tenant' from outside every sub-block. Here that abort
  -- is caught and rolled back, so the row looks the same either way; in
  -- production it is not the same at all, because Path B means the browser has
  -- ALREADY COMMITTED the connector in a separate round trip. The end state
  -- there is an orphan connector inside the customer's workspace, the proposal
  -- still pending, last_error NULL, and a message naming the wrong problem.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'vddp probe connector platform', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('vddp','1','provider_key','vddp_platform','label','Probe Platform'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    -- (a) the gated arm
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'platform override', v_conn);
    exception when others then
      v_p11_refused := true;
      v_p11_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    select state, last_error into v_p11_state, v_p11_lasterr
      from public.discovery_proposals where id = v_prop;

    -- (b) the UNGATED arm is refused too — 'ungated by role' must not mean
    -- 'open to anyone on the platform'. The refusal here legitimately comes
    -- from append_audit_event's membership check, exactly as it does for
    -- another tenant's owner in probe 6.
    perform set_config('request.jwt.claim.sub', v_platform_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'declined', 'platform decline');
    exception when others then
      v_p11_decline_ref := true;
      v_p11_decline_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    -- (c) THE INVERSION — the workspace's OWN owner, same row, same connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'the workspace decides', v_conn);
      v_p11_owner_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p11_owner_ok := false;
      v_p11_msg      := concat(coalesce(v_p11_msg,''), ' / the workspace owner also failed: ', sqlerrm);
    end;
    execute format('set local role %I', v_caller);
    select state into v_p11_owner_state from public.discovery_proposals where id = v_prop;

    v_d11 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 11 ABORTED before it could finish (%s: %s) — the platform-layer refusal was NOT compared this run', sqlstate, sqlerrm));
      v_d11 := false;
    end if;
  end;

  if v_d11 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if not v_p11_refused then
      v_bad := array_append(v_bad, 'a PLATFORM-layer profile ACCEPTED a tenant''s discovery proposal — the platform disjunct is back in the role bar, and on Path B that means an orphan connector already committed in the customer''s workspace with the proposal left pending and last_error NULL');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p11_msg,'') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the platform operator was refused, but NOT by the role bar: %L. That is the signature of the disjunct being present — Zone 1 passed, the CAS claimed the row, and the call died at append_audit_event instead, outside every sub-block.', coalesce(v_p11_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p11_state is distinct from 'pending' or v_p11_lasterr is not null then
      v_bad := array_append(v_bad, format('the refused platform accept left state=%L last_error=%L — Zone 1 refuses before anything is written', coalesce(v_p11_state,'NULL'), coalesce(v_p11_lasterr,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p11_decline_ref then
      v_bad := array_append(v_bad, 'a PLATFORM-layer profile DECLINED a tenant''s discovery proposal — decline is ungated by ROLE, but it must never be open to someone with no membership in the workspace at all');
    elsif coalesce(v_p11_decline_msg,'') = '' then
      v_bad := array_append(v_bad, 'the platform decline was refused with an empty message — a refusal nobody can read is the failure this whole migration is about');
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p11_owner_ok, false) or v_p11_owner_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME row with the SAME connector id (ok=%L state=%L). The platform refusal then proves nothing about layer.', coalesce(v_p11_owner_ok::text,'NULL'), coalesce(v_p11_owner_state,'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PERIMETER, all four roles, both directions, full-signature form so an
  -- unresolvable name ERRORs 42883 instead of quietly returning false.
  --
  -- ⚠ service_role=false is the pin that fires if anyone drops the explicit
  -- revoke: pg_default_acl grants it automatically on every function postgres
  -- creates in `public`.
  ------------------------------------------------------------------------
  v_checks := v_checks + 1;
  if has_function_privilege('public', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'PUBLIC can execute decide_discovery_proposal');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('anon', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'anon can execute decide_discovery_proposal — the internet can decide a workspace''s proposals');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('service_role', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'service_role can execute decide_discovery_proposal — under service_role auth.uid() is null, append_audit_event skips its membership check and its _submitted_by stamp, and the accept leaves no identity anywhere. This grant arrives by DEFAULT (pg_default_acl), so it must be revoked explicitly.');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'authenticated CANNOT execute decide_discovery_proposal — the only caller that is supposed to has been locked out');
  end if;
  v_checks := v_checks + 1;
  if has_table_privilege('authenticated', 'public.discovery_proposals', 'UPDATE') then
    v_bad := array_append(v_bad, 'authenticated can UPDATE discovery_proposals directly — a client that can write its own state does not need this function and is not audited');
  end if;

  ------------------------------------------------------------------------
  -- ROLLBACK INTEGRITY. Every probe above is a statement about rows that are
  -- still in production unless these match. Compared against baselines taken
  -- before any probe ran, never against a hardcoded zero — and this function
  -- runs on EVERY certify, so a rollback that stopped working would otherwise
  -- fill a customer's workspace with probe rows one run at a time.
  ------------------------------------------------------------------------
  select count(*) into v_prop_after  from public.discovery_proposals
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_sess_after  from public.discovery_sessions
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_conn_after  from public.connectors
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_audit_after from public.audit_events
   where tenant_id in (v_tenant, v_other_tenant)
     and detail ->> 'kind' = 'discovery_proposal_decision';
  select coalesce(is_active, true) into v_admin_active
    from public.profiles where user_id = v_admin_uid and tenant_id = v_tenant;

  -- The exact leak checks. Every row this function creates is TAGGED — a
  -- `vddp` key in the payload, a display_name prefix on the connector — so
  -- these are immune to whatever else the platform is doing concurrently, and
  -- they name the survivor rather than only its count.
  select count(*) into v_leak_conn from public.connectors
   where display_name like 'vddp probe connector%';
  select count(*) into v_leak_prop from public.discovery_proposals
   where payload ? 'vddp';

  v_checks := v_checks + 1;
  if v_prop_after <> v_prop_before or v_sess_after <> v_sess_before
     or v_conn_after <> v_conn_before or v_audit_after <> v_audit_before then
    v_bad := array_append(v_bad, format(
      'A PROBE ROLLBACK IS BROKEN AND THIS CHECK HAS LEFT TEST DATA IN PRODUCTION — discovery_proposals %s -> %s, discovery_sessions %s -> %s, connectors %s -> %s, decision audit events %s -> %s (counts scoped to tenants %s and %s). Stop running this until it is fixed: it runs on every certify.',
      v_prop_before, v_prop_after, v_sess_before, v_sess_after,
      v_conn_before, v_conn_after, v_audit_before, v_audit_after,
      v_tenant::text, v_other_tenant::text));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_leak_conn, 0) <> 0 or coalesce(v_leak_prop, 0) <> 0 then
    v_bad := array_append(v_bad, format(
      'PROBE ROWS SURVIVED — %s connector(s) named "vddp probe connector…" and %s discovery proposal(s) carrying the vddp payload tag are in production',
      v_leak_conn, v_leak_prop));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_admin_active, false) then
    v_bad := array_append(v_bad, format(
      'PROBE 8 LEFT A REAL PERSON DEACTIVATED IN PRODUCTION (%s in tenant %s) — its rollback is broken and someone has lost access to their workspace',
      v_admin_uid::text, v_tenant::text));
  end if;

  ------------------------------------------------------------------------
  -- THE DENOMINATOR. Not optional and not decoration: zero findings from zero
  -- probes looks exactly like a clean result. certify parses
  -- `probes_completed=` out of this line and refuses a run reporting zero.
  ------------------------------------------------------------------------
  v_notes := array_append(v_notes, format(
    'note: probes_completed=%s probes_attempted=11 assertions=%s caller=%s role=authenticated tenants=%s,%s — nine accepts driven to SUCCESS so the refusals mean something (probe 1 owner+routable kind; 4 a parked proposal after a second Park was refused; 5d the owner on the row a tenant_user was refused; 6 the other tenant''s owner in their OWN workspace; 7 the routable sibling; 7e the twice-failed row once routable; 9 the row an unidentified caller was refused on; 10b the same owner with a connector that IS theirs; 11c the workspace''s own owner on the row a platform operator was refused on). Rows unchanged in the two probe tenants: %s proposals, %s sessions, %s connectors, %s decision audit events; %s tagged connector(s) and %s tagged proposal(s) survive. NOT proven here: PostgREST''s JWT transport (the probes set request.jwt.claim.sub themselves) and CONCURRENT as opposed to sequential double-click.',
    v_probes_done, v_checks, v_caller, v_tenant::text, v_other_tenant::text,
    v_prop_after, v_sess_after, v_conn_after, v_audit_after,
    coalesce(v_leak_conn, 0), coalesce(v_leak_prop, 0)));

  if v_probes_done < 11 then
    v_bad := array_append(v_bad, format(
      'only %s of 11 probes completed. The ones that did not are named above with their SQLSTATE; a probe that cannot run is a failure, never a skip, because its assertions did not compare anything this run.',
      v_probes_done));
  end if;

  return array_cat(v_bad, v_notes);
end;
$function$;

comment on function public.verify_decide_discovery_proposal() is
  'Re-runnable behavioural verification of decide_discovery_proposal: migration 741''s eleven probes, made to RETURN their findings instead of raising them. '
  'Every probe creates fixtures, drives the RPC as the real runtime role `authenticated`, and rolls everything back by raising the sentinel ''__undo_probe__'' inside its own sub-block; '
  'variable assignments survive the subtransaction, writes do not, and the rollback is asserted against row-count baselines and per-row tags rather than trusted. '
  'Returns text[]: elements are FINDINGS, except those beginning with ''note: '', which carry the denominators (probes_completed=, assertions=). No findings and 11 probes completed is the only clean result. '
  'SECURITY INVOKER, not DEFINER, because `set local role` raises 42501 inside a security-definer body and the impersonation is the point. service_role only — it must never be reachable from a browser.';

-- ---------------------------------------------------------------------------
-- PERIMETER. `service_role` is named in the REVOKE even though it is then
-- granted back, because pg_default_acl for postgres/public/functions is
-- {postgres=X/postgres, service_role=X/postgres} — stating both makes the
-- intended surface explicit rather than inherited.
--
-- This function manipulates request.jwt.claim.sub to impersonate real people
-- and switches role to `authenticated`. anon and authenticated must never hold
-- EXECUTE on it, and the assertion below is what says so on every apply.
-- ---------------------------------------------------------------------------
revoke all on function public.verify_decide_discovery_proposal()
  from public, anon, authenticated, service_role;
grant execute on function public.verify_decide_discovery_proposal()
  to service_role;

-- ===========================================================================
-- VERIFICATION — this migration's own block, which calls the function it just
-- created and asserts the result is clean.
--
-- ⚠ EVERY APPEND BELOW USES array_append. This migration exists because 741
-- used `v_bad := v_bad || 'a sentence'` thirty-six times, which raises 22P02
-- instead of appending the moment a branch fires. Reproducing that here — in
-- the block verifying the repair — is the failure mode one level up, and
-- scripts/migration-append-check.mjs will refuse this file if it happens.
-- ===========================================================================
do $$
declare
  v_res       text[];
  v_findings  text[] := '{}';
  v_notes     text[] := '{}';
  v_line      text;
  v_probes    integer;
  v_asserts   integer;
  v_bad       text[] := '{}';
  v_checks    integer := 0;
  v_sig       text := 'public.verify_decide_discovery_proposal()';
begin
  -- Vacuity guard: the thing under test must exist before we claim anything
  -- about what it found.
  if to_regprocedure(v_sig) is null then
    raise exception '745: verify_decide_discovery_proposal() does not exist after this migration created it';
  end if;

  v_res := public.verify_decide_discovery_proposal();

  foreach v_line in array coalesce(v_res, '{}'::text[]) loop
    if v_line like 'note: %' then
      v_notes := array_append(v_notes, v_line);
    else
      v_findings := array_append(v_findings, v_line);
    end if;
  end loop;

  -- The note must exist and must carry a machine-readable denominator, or
  -- certify has nothing to refuse a zero-probe run with.
  v_checks := v_checks + 1;
  if coalesce(array_length(v_notes, 1), 0) <> 1 then
    v_bad := array_append(v_bad, format('the function returned %s note line(s), expected exactly 1 carrying the denominators', coalesce(array_length(v_notes,1),0)::text));
  end if;

  v_probes  := (substring(coalesce(v_notes[1], '') from 'probes_completed=(\d+)'))::integer;
  v_asserts := (substring(coalesce(v_notes[1], '') from 'assertions=(\d+)'))::integer;

  v_checks := v_checks + 1;
  if coalesce(v_probes, 0) <> 11 then
    v_bad := array_append(v_bad, format('the function reported probes_completed=%L, expected 11. Zero findings from zero probes looks exactly like a clean result, which is the whole reason this number is printed.', coalesce(v_probes::text, 'ABSENT')));
  end if;

  -- ⚠ NOT a pinned constant. Pinning the assertion count would go red every
  -- time a probe legitimately gains a check, and someone would then edit the
  -- pin rather than read it. What must never happen is the number collapsing,
  -- which is what a silently-skipped probe looks like.
  v_checks := v_checks + 1;
  if coalesce(v_asserts, 0) < 95 then
    v_bad := array_append(v_bad, format('the function compared only %L assertion(s). 741 carried 95 across the same eleven probes and this carries 98 (three ctid arms added beside the three inert decided_at ones); a collapse means probes are being skipped rather than run.', coalesce(v_asserts::text, 'ABSENT')));
  end if;

  v_checks := v_checks + 1;
  if coalesce(array_length(v_findings, 1), 0) > 0 then
    v_bad := array_append(v_bad, format('%s finding(s) from the live run: %s',
      array_length(v_findings, 1)::text, array_to_string(v_findings, ' | ')));
  end if;

  ------------------------------------------------------------------------
  -- PERIMETER on the verifier ITSELF. It impersonates real people through
  -- request.jwt.claim.sub and switches role; a browser must never reach it.
  -- Full-signature form so an unresolvable name ERRORs 42883 rather than
  -- quietly returning false.
  ------------------------------------------------------------------------
  v_checks := v_checks + 1;
  if has_function_privilege('anon', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'anon can execute verify_decide_discovery_proposal — it impersonates real user ids');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('authenticated', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'authenticated can execute verify_decide_discovery_proposal — a signed-in browser could drive impersonation of any profile on the platform');
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('public', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'PUBLIC can execute verify_decide_discovery_proposal');
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    v_bad := array_append(v_bad, 'service_role CANNOT execute verify_decide_discovery_proposal — certify would be unable to run the only standing behavioural check this function exists to provide');
  end if;

  -- SECURITY INVOKER is a DECISION here, not an oversight, and the header
  -- explains why. Pinning it stops a well-meaning later edit from switching it
  -- to DEFINER, which would make every `set local role` inside raise 42501 and
  -- silently reduce eleven probes to zero.
  v_checks := v_checks + 1;
  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'verify_decide_discovery_proposal') then
    v_bad := array_append(v_bad, 'verify_decide_discovery_proposal is SECURITY DEFINER — `set local role` raises 42501 inside a security-definer body, so every probe would abort and the check would report zero probes. It must stay INVOKER; see this migration''s header.');
  end if;
  v_checks := v_checks + 1;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'verify_decide_discovery_proposal'
                    and 'search_path=public' = any(coalesce(p.proconfig, '{}'::text[]))) then
    v_bad := array_append(v_bad, 'verify_decide_discovery_proposal has no pinned search_path');
  end if;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '745: % of % assertion(s) failed: %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '745: verify_decide_discovery_proposal() is live and returned CLEAN on its first run — % probe(s) completed, % assertion(s) compared, 0 findings, and % assertion(s) about the verifier itself passed. %',
    v_probes, v_asserts, v_checks, coalesce(v_notes[1], '(no note)');
end $$;

commit;
