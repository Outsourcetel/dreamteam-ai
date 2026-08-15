-- 741_a_proposal_becomes_a_thing_or_says_why_not.sql
-- ==========================================================================
-- WHY: the discovery screen can show a person a proposal, and until now there
-- was no way for them to answer it. This is the answer path.
--
-- decide_discovery_proposal(proposal, decision, note, created_object_id) moves
-- one proposal to 'accepted', 'declined' or 'parked', records WHO decided and
-- WHEN, writes an audit line for every one of the three, and — when a writer
-- refuses — puts the proposal back in the deck with the reason written down
-- where a human can read it. That last clause is the whole point of migration
-- 740 and the reason this function returns jsonb rather than raising: a
-- proposal that silently fails to become a thing is the worst outcome this
-- surface can produce.
--
-- ==========================================================================
-- WHAT THIS MIGRATION ROUTES, AND WHAT IT DELIBERATELY REFUSES
--
-- ONE kind is routable today: `connector`, via Path B.
--
--   Path B means the BROWSER performs the ordinary write first, as the
--   signed-in human under RLS (`supabase.from('connectors').insert(...)`),
--   and then calls this function with the id it just created. This function
--   stamps that id onto the proposal. It does NOT insert the connector.
--
--   That is not a shortcut, it is the only correct shape. `authenticated`
--   holds INSERT on `connectors`; this function is SECURITY DEFINER owned by
--   `postgres`, so an `insert into connectors` inside it would bypass the very
--   RLS the human path depends on and would constitute a SECOND creation
--   engine. The plan forbids exactly that. The precedent already shipped in
--   this repo is `approveProposal` (src/lib/governanceAiApi.ts:111-153), whose
--   own comment says the rule changes "through the ordinary audited path, run
--   as the logged-in human ... After the rule is created/updated we stamp the
--   proposal".
--
-- EVERY OTHER KIND IS REFUSED, OUT LOUD: `employee`, `procedure`, `guardrail`,
-- `trust_rule`, `conversation_type` all return ok=false with
-- 'kind not yet routable: <kind>' and leave the proposal 'pending' with that
-- sentence in `last_error` and `attempts` incremented.
--
--   This is a decision, not an omission. The kinds ship one at a time in risk
--   order (contract §9), and a kind whose writer does not exist yet must SAY
--   SO rather than quietly succeed at nothing. `conversation_type` in
--   particular has no table at all — `to_regclass('public.conversation_types')`
--   is null — and is being fixed properly in its own task; giving it an accept
--   path here would be a no-op wearing a success message.
--
--   Adding a kind later is ONE `when` branch in the single `case` in Zone 3.
--   Nothing else in this function needs to change.
--
-- ==========================================================================
-- THE ROLE BAR — copied from retire_guardrail_rule, with the tenant read OFF
-- THE ROW.
--
-- `p_created_object_id` is the only id a caller supplies, and it is never
-- treated as authorisation: the tenant comes from the proposal row, and the
-- connector must already belong to that same tenant. This is the shape
-- migrations 662-664 exist to enforce (a SECDEF function that TRUSTS a
-- caller-supplied tenant id is how cross-tenant reads happened here before).
--
-- ⚠ THERE IS NO `auth.uid() is not null and` PREFIX ON THE ROLE PREDICATE.
-- That prefix is the hole in `install_role_kit` and `instantiate_role_archetype`:
-- when auth.uid() is null the whole `and not exists(...)` short-circuits to
-- false and the authority check is SKIPPED rather than failed. Here a null
-- uid is refused FIRST, on its own line, for every decision — not just accept
-- — because `decided_by` must be a real person or the audit trail records a
-- decision nobody made. Probe 9 fires it with the GUC actually cleared.
--
-- ⚠ THERE IS NO `p.layer = 'platform'` DISJUNCT EITHER, AND ITS ABSENCE IS THE
-- POINT. The contract's literal predicate carries one. It is wrong here, and
-- measurably so: `profiles` carries UNIQUE (user_id), so a platform-layer
-- profile holder CANNOT also hold a tenant profile row — 2 platform profiles
-- exist on this database, both with tenant_id NULL, and the unique constraint
-- makes that a structural fact rather than a coincidence. With the disjunct
-- present a platform operator PASSES Zone 1, the Zone-2 CAS claims the row,
-- Zone 3 validates, and then `append_audit_event` raises 'not a member of this
-- tenant' from OUTSIDE every sub-block, aborting the whole call. On Path B the
-- browser has ALREADY COMMITTED the connector in its own round trip, so the end
-- state is an orphan connector inside the customer's workspace, the proposal
-- still `pending`, `last_error` NULL, `attempts` 0, and a message naming the
-- wrong problem. An authority arm that passes the authority check and dies at
-- the audit is not an authority model. Platform operators have no audit
-- identity inside a tenant, so they cannot legitimately decide for one; they
-- are refused in Zone 1, in words, before anything is claimed. Probe 11 pins
-- it in both directions.
--
-- OWNER/ADMIN, NOT tenant_manager. `set_de_autonomy` admits managers, but it
-- edits one dial on an existing employee; this creates employees, guardrails
-- and trust caps from nothing. It is also not a practical block:
-- `install_role_systems` uses `can_admin_tenant_internal`, which refuses
-- tenant_manager anyway, so a manager-driven hire would silently produce zero
-- connected systems.
--
-- ACCEPT ONLY IS GATED. Declining and parking are open to any member, per
-- `decide_human_task`: "a rule that stops someone saying 'no' is not an
-- authority model, it is a way of forcing things through." Ungated is not
-- unrecorded — all three decisions audit, and a non-member's decline still
-- fails, because `append_audit_event` re-checks tenant membership and raises,
-- which aborts the whole call including the claim. Probe 6 fires that.
--
-- ⚠ FOUR DELIBERATE DEVIATIONS FROM THE CONTRACT'S LITERAL TEXT, ALL MEASURED:
--
--  1. THE REVOKE INCLUDES `service_role`, WHICH THE CONTRACT'S LINE OMITS.
--     Measured on this database, not assumed:
--       pg_default_acl(owner=postgres, schema=public, objtype='f')
--         = {postgres=X/postgres, service_role=X/postgres}
--     Every function created by `postgres` in `public` is granted EXECUTE to
--     service_role AUTOMATICALLY. `retire_guardrail_rule` carries
--     `service_role=X/postgres` in its ACL today for exactly this reason, and
--     nobody granted it. Revoking only from public/anon/authenticated would
--     therefore have left service_role able to execute this function — and the
--     contract's OWN assertion (has_function_privilege('service_role', ...) =
--     false) would have turned this migration red on apply. The revoke names
--     service_role explicitly and the assertion below is a real, firing pin.
--
--     Why service_role must not have it, in one line each: under service_role
--     `auth.uid()` is null, so the null-uid refusal fires and the function is
--     useless anyway; `append_audit_event` skips its membership check and its
--     `_submitted_by` stamp; and the Task 5 certify assertion (no terminal
--     state without `decided_by`) becomes unsatisfiable.
--
--  2. THE REFUSAL MESSAGE SAYS "accept", NOT "decide". The contract's string
--     is 'only workspace owners and admins can decide a discovery proposal',
--     but the contract's own §1 gates ACCEPT only — so that sentence would
--     tell a tenant_user they cannot decline, which is false. The behaviour is
--     the contract's; the words are true.
--
--  3. THE ROLE BAR DROPS THE CONTRACT'S `p.layer = 'platform' or` DISJUNCT.
--     Measured: `profiles` carries UNIQUE (user_id) and both live platform
--     profiles have tenant_id NULL, so a platform operator can never satisfy
--     `append_audit_event`'s membership check. Keeping the disjunct would let
--     them pass Zone 1 and claim the row, then abort at the audit call —
--     leaving an orphan connector already committed by the browser, a pending
--     proposal and a NULL last_error. The full reasoning is under THE ROLE BAR
--     above; the pin is probe 11.
--
--  4. THE ZONE-2 CAS ADMITS `state in ('pending','parked')`, WHERE THE
--     CONTRACT'S LITERAL IS `state = 'pending'` — AND THEN REFUSES park→park.
--     Two halves, both deliberate:
--       (a) Widening is required by the plan: park is a pause, so a parked
--           proposal must stay decidable. The contract's literal clause would
--           make park terminal, i.e. a decline with softer wording.
--       (b) But `state in ('pending','parked')` on its own makes PARK NOT
--           IDEMPOTENT: a double-clicked Park matches on 'parked', re-writes
--           decided_at/decided_by, writes a SECOND config_change audit row and
--           returns ok=true both times — the exact shape that logged one
--           human's approval three times in 37 seconds on 2026-07-27. So the
--           CAS carries `and not (state = 'parked' and p_decision = 'parked')`:
--           re-parking a parked proposal returns already_decided and writes
--           nothing, while accepting or declining it still works. Probe 4
--           fires both halves.
--
-- ==========================================================================
-- THREE ZONES, ONE TRANSACTION, EXACTLY ONE SUB-BLOCK
--
--   ZONE 1  refuse before touching anything. These RAISE. Nothing changed.
--   ZONE 2  the claim: `update ... where state in ('pending','parked')
--           returning`. This compare-and-swap IS the double-click guard, and
--           it sits OUTSIDE any sub-block so a writer's rollback cannot undo
--           it. A prior `select state; if pending then update` is NOT
--           equivalent — both concurrent transactions pass the select.
--   ZONE 3  accept only. ONE sub-block for the whole accept, not one per
--           write.
--
-- The revert-to-pending runs OUTSIDE and AFTER the sub-block, and relies ONLY
-- on VARIABLE SURVIVAL — `v_err := sqlerrm` in the handler — never on writes
-- made inside a handler surviving, because they do not. A PL/pgSQL
-- BEGIN...EXCEPTION is an implicit subtransaction and everything written
-- inside it rolls back. `install_role_kit`'s `v_skipped := v_skipped + 1` and
-- migration 525's `v_probe_err := SQLERRM` are the shipped precedents.
--
-- ⚠ DO NOT wrap the whole body in the sub-block. That rolls the Zone-2 claim
-- back with it and re-creates the silent-failure version this migration exists
-- to prevent.
--
-- 'accepted' AND `created_object_id` COMMIT TOGETHER OR NOT AT ALL. Zone 2
-- writes the state, Zone 3 writes the id, both in one transaction, and a
-- failure between them reverts the state. `accepted`-with-null-
-- `created_object_id` is therefore unreachable, which is precisely what the
-- Task 5 certify assertion demands.
--
-- PARK IS A PAUSE, NOT A DECISION. The CAS admits `state in ('pending',
-- 'parked')`, so a parked proposal stays decidable — that is what makes park
-- different from decline rather than a decline with nicer wording. Only
-- 'accepted' and 'declined' are terminal, and a second decision on those
-- returns `already_decided` without writing or auditing anything.
--
-- PARK IS ALSO IDEMPOTENT. `and not (state = 'parked' and p_decision =
-- 'parked')` is what stops a double-clicked Park from re-dating the row and
-- writing a second audit line while returning ok=true twice. Parked → accepted
-- and parked → declined stay open; only parked → parked is refused.
--
-- A FAILED ACCEPT REVERTS TO 'pending', NOT TO THE PRIOR STATE. If a parked
-- proposal is accepted and the writer refuses, it lands back in the deck with
-- its reason showing, rather than back in the parked pile where nobody looks.
-- This product's recorded failure is 19 of 26 proposals sitting undecided; a
-- refusal that hides itself in the parked pile is that failure again.
--
-- RETURNS jsonb, NEVER A COMPOSITE. PostgREST serialises a NULL composite as a
-- row of all-NULL columns, so `if (!data)` never fires — the defect that
-- logged one human's approval three times in 37 seconds on 2026-07-27. Callers
-- must check `error` AND `data.ok`: `.rpc()` RESOLVES on a Postgres error.
--
-- ==========================================================================
-- WHAT THE VERIFICATION BLOCK CAN AND CANNOT PROVE — READ THIS BEFORE
-- TRUSTING IT
--
-- `auth.uid()` reads the transaction GUC `request.jwt.claim.sub` (verified
-- against the live auth.uid() definition). A migration cannot log in, so the
-- probes below set that GUC with `set_config(..., is_local => true)` and then
-- `set local role authenticated` before every single RPC call.
--
-- PROVEN HERE, for real, by firing it:
--   * the role predicate itself — the same row, the same arguments, accepted
--     by an owner and refused for a tenant_user, so the refusal is
--     demonstrably about the ROLE and not about being unauthenticated (the
--     same tenant_user successfully DECLINES the same session's other
--     proposal, which proves the identity is present and real);
--   * the EXECUTE grant and the SECURITY DEFINER elevation, because every
--     call runs as the actual runtime role `authenticated`, not as postgres.
--     If the grant were missing these probes fail with 42501;
--   * the compare-and-swap, the revert-to-pending, `attempts`, the audit
--     payload, and the cross-tenant refusal;
--   * the null-uid refusal, with `auth.uid()` asserted null BEFORE the call
--     (both GUCs cleared) and the call made on the UNGATED arm, so the role
--     bar cannot be what refused it;
--   * that a created-object id is checked against the proposal's tenant — a
--     tenant's own owner is handed another workspace's connector id;
--   * that `last_error`/`last_error_at` are CLEARED by a successful accept,
--     fired on rows that genuinely carried a reason (probe 7e, probe 10b);
--   * that park and decline are both idempotent — a second Park and a
--     re-decided decline each return already_decided and write nothing;
--   * that a platform-layer profile is refused by the ROLE BAR, in Zone 1,
--     rather than later by append_audit_event.
--
-- NOT PROVEN HERE, and no probe below pretends otherwise:
--   * that PostgREST actually populates `request.jwt.claim.sub` from a real
--     JWT. That is transport, shared with every SECDEF function in this repo,
--     and it is unobservable from inside a migration. A probe that set the GUC
--     and then announced it had tested authentication would be theatre.
--   * CONCURRENT double-click. The CAS is proven SEQUENTIALLY (second call
--     returns already_decided and writes nothing). A single-session migration
--     cannot race itself; the concurrent claim rests on READ COMMITTED
--     semantics and remains INFERRED.
--   * the browser half of Path B — that `connectors.insert` succeeds under RLS
--     as the signed-in human, and that a 0-row PostgREST result is not read as
--     success. That belongs to the client task and to certify.
--   * that service_role is unreachable through PostgREST. Only the catalogue
--     grant is asserted here.
-- ==========================================================================

begin;

create or replace function public.decide_discovery_proposal(
  p_proposal_id       uuid,
  p_decision          text,
  p_note              text default null,
  p_created_object_id uuid default null   -- Path B only; ignored on decline/park
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_p          public.discovery_proposals%rowtype;   -- the proposal, read once
  v_row        public.discovery_proposals%rowtype;   -- what the CAS claimed
  v_detail     jsonb;
  v_label      text;
  v_action     text;
  v_object_id  uuid;
  v_object_tbl text;
  v_writer     text;
  v_err        text;
  v_errstate   text;
  v_attempts   integer;
begin
  --------------------------------------------------------------------------
  -- ZONE 1 — refuse before touching anything. Every branch here RAISES, and
  -- nothing has been written when it does.
  --------------------------------------------------------------------------

  -- A null uid is refused on its own line and FIRST, for all three decisions.
  -- Folding this into the role predicate as `auth.uid() is not null and ...`
  -- is the exact bug in install_role_kit: it makes the authority check SKIP
  -- instead of FAIL. It applies to decline and park too, because a terminal
  -- state with a null decided_by is a decision nobody made.
  if auth.uid() is null then
    raise exception 'not authenticated: a discovery proposal is decided by a person, and the decision records which person';
  end if;

  select * into v_p from public.discovery_proposals where id = p_proposal_id;
  if v_p.id is null then
    raise exception 'unknown discovery proposal %', p_proposal_id;
  end if;

  if p_decision is null or p_decision not in ('accepted', 'declined', 'parked') then
    raise exception 'decide_discovery_proposal: % is not a decision — must be ''accepted'', ''declined'' or ''parked''',
      coalesce(p_decision, 'NULL');
  end if;

  -- The role bar. The tenant comes off the ROW (v_p.tenant_id), never from a
  -- parameter. Accept only: saying no is not gated.
  --
  -- ⚠ NO `p.layer = 'platform' or` DISJUNCT. A platform profile has
  -- tenant_id NULL and `profiles` is UNIQUE (user_id), so its holder can never
  -- satisfy append_audit_event's membership check. Admitting them here means
  -- passing the authority check and then aborting at the audit call OUTSIDE
  -- every sub-block — with the browser's connector already committed. Refuse
  -- in Zone 1, in words, before anything is claimed. See the header.
  if p_decision = 'accepted' then
    if not exists (
      select 1 from public.profiles p
       where p.user_id = auth.uid()
         and coalesce(p.is_active, true)
         and p.tenant_id = v_p.tenant_id
         and p.role in ('tenant_owner', 'tenant_admin')
    ) then
      raise exception 'only workspace owners and admins can accept a discovery proposal — declining and parking are open to anyone in the workspace';
    end if;
  end if;

  --------------------------------------------------------------------------
  -- ZONE 2 — THE CLAIM. This compare-and-swap is the double-click guard.
  -- It is OUTSIDE any sub-block on purpose: a writer's rollback in Zone 3
  -- must not be able to undo it.
  --
  -- 'parked' is in the admitted set because park is a pause. 'accepted' and
  -- 'declined' are not, so a second decision on either matches zero rows,
  -- leaves v_row NULL, and returns already_decided having written nothing.
  --
  -- ⚠ `and not (state = 'parked' and p_decision = 'parked')` is what makes PARK
  -- ITSELF IDEMPOTENT. Without it a double-clicked Park matches on 'parked',
  -- re-dates decided_at, writes a SECOND config_change audit row and returns
  -- ok=true twice — the same class of defect that logged one human's approval
  -- three times in 37 seconds. Parked → accepted and parked → declined are
  -- untouched by this clause; only parked → parked is refused.
  --------------------------------------------------------------------------
  update public.discovery_proposals
     set state      = p_decision,
         decided_by = auth.uid(),
         decided_at = now()
   where id        = p_proposal_id
     and tenant_id = v_p.tenant_id
     and state in ('pending', 'parked')
     and not (state = 'parked' and p_decision = 'parked')
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object(
      'ok',          false,
      'error',       'already_decided',
      'proposal_id', p_proposal_id,
      'state',       (select state from public.discovery_proposals
                       where id = p_proposal_id and tenant_id = v_p.tenant_id));
  end if;

  --------------------------------------------------------------------------
  -- THE AUDIT DETAIL, BUILT ONCE, BEFORE THE BRANCH.
  --
  -- Built here rather than per-arm so that a decline cannot be dropped by
  -- someone editing a separate code path. The accept arm ADDS to it; no arm
  -- rebuilds it.
  --
  -- `payload` goes in WHOLE AND VERBATIM. It is the only copy of the literal
  -- the customer consented to, and the row it came from can be edited or
  -- deleted with no version history anywhere else — the same reasoning
  -- retire_guardrail_rule states in its own comment.
  --
  -- `decided_by` goes INSIDE detail. append_audit_event's hash covers
  -- prev_hash || tenant_id || action || detail::text || created_at. The
  -- `actor` COLUMN is not in the digest; `detail` is. The tamper-evident
  -- chain does not protect the identity column, so the identity is put where
  -- the chain reaches.
  --
  -- ⚠ append_audit_event, not _internal, and UNGUARDED: it raises on failure,
  -- so no audit row means no decision. Swallowing it is the deprecated
  -- resolve_account_writeback shape. Category MUST be 'config_change' — an
  -- invented category violates audit_events_category_check and aborts the
  -- decision, which is the mig-429 lesson.
  --------------------------------------------------------------------------
  v_label := coalesce(
    nullif(btrim(v_p.payload ->> 'name'), ''),
    nullif(btrim(v_p.payload ->> 'label'), ''),
    nullif(btrim(v_p.payload ->> 'rule'), ''),
    nullif(btrim(v_p.payload ->> 'archetype_key'), ''),
    nullif(btrim(v_p.payload ->> 'provider_key'), ''),
    'unnamed');

  v_detail := jsonb_build_object(
    'kind',             'discovery_proposal_decision',
    'decision',         p_decision,
    'proposal_id',      v_p.id,
    'session_id',       v_p.session_id,
    'proposal_kind',    v_p.kind,
    'source_dimension', v_p.source_dimension,
    'payload',          v_p.payload,
    'rationale',        v_p.rationale,
    'note',             nullif(btrim(p_note), ''),
    'decided_by',       auth.uid());

  v_action := format('Discovery proposal %s — %s (%s).', p_decision, v_label, v_p.kind);

  -- Decline and park end here. Both audited, for three reasons: there is no
  -- note column on the table, so an unaudited decline destroys the only
  -- sentence explaining why a customer refused; absence must be
  -- distinguishable from never-shown; and an unaudited park re-creates the
  -- invisible pile.
  if p_decision <> 'accepted' then
    perform public.append_audit_event(
      v_p.tenant_id, 'You', 'human', v_action, 'config_change', v_detail);

    return jsonb_build_object(
      'ok',                true,
      'state',             p_decision,
      'proposal_id',       v_p.id,
      'created_object_id', null);
  end if;

  --------------------------------------------------------------------------
  -- ZONE 3 — ACCEPT ONLY. Exactly ONE sub-block, for the whole accept.
  --
  -- ADDING A KIND IS ONE `when` BRANCH HERE AND NOTHING ELSE. A branch must
  -- set v_writer and v_object_tbl (they are what the audit line and the
  -- refusal record report) and end with v_object_id set to the thing that now
  -- exists, or raise with a sentence a person can read.
  --------------------------------------------------------------------------
  begin
    case v_p.kind

      -- ---- connector — Path B -------------------------------------------
      -- The browser already inserted the row as the signed-in human under
      -- RLS. This stamps it. It does NOT insert: an `insert into connectors`
      -- here runs as postgres, bypasses RLS entirely, and is the second
      -- creation engine the plan forbids.
      --
      -- ⚠ NO `data_access_grants` ROW IS WRITTEN, and that is load-bearing
      -- rather than an oversight. `poll_de_work_sources_targets` filters
      -- `c.status <> 'disconnected'`, which ADMITS 'pending_credentials', and
      -- joins to data_access_grants. The grant is what arms the poller.
      -- Withholding it is what makes the card's promise — "you still enter
      -- the credential yourself" — true on every traced path.
      when 'connector' then
        v_writer     := 'connectProvider -> connectors (client, under RLS), stamped here';
        v_object_tbl := 'connectors';

        if p_created_object_id is null then
          raise exception 'a connector proposal is accepted by creating the connector first: insert it as the signed-in person, then pass its id here (Path B)';
        end if;

        -- The id a caller hands us is NOT its own authorisation. It must be a
        -- connector already belonging to THIS proposal's tenant, or
        -- created_object_id would point at another workspace's row — or at
        -- nothing at all, which would satisfy the Task 5 certify assertion
        -- with garbage.
        if not exists (
          select 1 from public.connectors c
           where c.id = p_created_object_id
             and c.tenant_id = v_p.tenant_id
        ) then
          raise exception 'no connector % in this workspace — a created-object id is not its own authorisation', p_created_object_id;
        end if;

        v_object_id := p_created_object_id;

      -- ---- every other kind ---------------------------------------------
      -- employee, procedure, guardrail, trust_rule, conversation_type.
      -- All five are admitted by discovery_proposals_kind_check, so this
      -- refusal is the ROUTER's and nothing else's. Each ships in its own
      -- task, in risk order. A kind with no writer must say so.
      else
        raise exception 'kind not yet routable: %', v_p.kind;

    end case;

    -- Belt and braces for a future branch that forgets: never leave Zone 3
    -- with the state claimed and nothing created.
    if v_object_id is null then
      raise exception 'writer_returned_no_object';
    end if;

  exception when others then
    -- ⚠ ONLY variable capture. Everything the failed writer wrote is already
    -- rolled back by the time this line runs, and anything written HERE would
    -- roll back too. The record of the failure is made below, outside.
    -- ⚠ `sqlstate`, NOT `returned_sqlstate`. RETURNED_SQLSTATE is a GET STACKED
    -- DIAGNOSTICS ITEM NAME, not an identifier: only SQLSTATE and SQLERRM exist
    -- in a handler's namespace. plpgsql defers expression parsing to first
    -- execution, so `returned_sqlstate` here compiled fine and then raised
    -- 42703 `column "returned_sqlstate" does not exist` INSIDE the handler on
    -- the first refusal — escaping this block and killing the entire
    -- revert-to-pending / last_error / attempts / refusal-audit arm below.
    -- The shipped precedent is migration 738's `v_null_sqlstate := sqlstate;`.
    v_err      := sqlerrm;
    v_errstate := sqlstate;
  end;

  --------------------------------------------------------------------------
  -- OUTSIDE the sub-block. These writes commit with the rest of the
  -- transaction — migration 525's pattern.
  --------------------------------------------------------------------------
  if v_err is not null then
    update public.discovery_proposals
       set state         = 'pending',
           decided_by    = null,
           decided_at    = null,
           last_error    = left(v_err, 500),
           last_error_at = now(),
           attempts      = attempts + 1
     where id = p_proposal_id and tenant_id = v_p.tenant_id
    returning attempts into v_attempts;

    v_detail := v_detail || jsonb_build_object(
      'outcome',                'refused',
      'error',                  left(v_err, 500),
      'sqlstate',               v_errstate,
      'attempts',               v_attempts,
      'writer',                 v_writer,
      'attempted_object_table', v_object_tbl);

    perform public.append_audit_event(
      v_p.tenant_id, 'You', 'human',
      format('Discovery proposal could not be accepted — %s (%s): %s', v_label, v_p.kind, left(v_err, 200)),
      'config_change', v_detail);

    return jsonb_build_object(
      'ok',          false,
      'state',       'pending',
      'proposal_id', v_p.id,
      'error',       v_err,
      'sqlstate',    v_errstate,
      'attempts',    v_attempts);
  end if;

  -- The accept succeeded. state='accepted' (Zone 2) and created_object_id
  -- (here) commit together; neither can be observed without the other.
  update public.discovery_proposals
     set created_object_id = v_object_id,
         last_error        = null,
         last_error_at     = null
   where id = p_proposal_id and tenant_id = v_p.tenant_id;

  v_detail := v_detail || jsonb_build_object(
    'outcome',              'created',
    'writer',               v_writer,
    'created_object_table', v_object_tbl,   -- a bare uuid with no table name
    'created_object_id',    v_object_id);   -- is not reconstructable later

  perform public.append_audit_event(
    v_p.tenant_id, 'You', 'human', v_action, 'config_change', v_detail);

  return jsonb_build_object(
    'ok',                   true,
    'state',                'accepted',
    'proposal_id',          v_p.id,
    'created_object_table', v_object_tbl,
    'created_object_id',    v_object_id);
end;
$function$;

comment on function public.decide_discovery_proposal(uuid, text, text, uuid) is
  'Decide one discovery proposal: accepted | declined | parked. Accept is owner/admin only (tenant read off the row); decline and park are open to any member but still audited. '
  'Routes ''connector'' via Path B — the browser creates the connector as the signed-in human under RLS and passes its id, which this stamps. Every other kind is refused with '
  '''kind not yet routable: <kind>'' and left pending with the reason in last_error. Returns jsonb, never a composite: callers must check error AND data.ok.';

-- ---------------------------------------------------------------------------
-- PERIMETER. `service_role` is named in the REVOKE because it is granted by
-- DEFAULT — pg_default_acl for postgres/public/functions is
-- {postgres=X/postgres, service_role=X/postgres}. Omitting it here leaves the
-- grant in place and turns the assertion below red.
-- ---------------------------------------------------------------------------
revoke all on function public.decide_discovery_proposal(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_discovery_proposal(uuid, text, text, uuid)
  to authenticated;

-- ===========================================================================
-- VERIFICATION.
--
-- Eleven probes across ten sub-blocks — probes 1 and 2 share one, because
-- probe 2 is the second click on the row probe 1 just accepted — each undone
-- by raising the sentinel '__undo_probe__'. Every RPC call runs as the real
-- runtime role
-- `authenticated` with a real profile's user id in request.jwt.claim.sub, so
-- a missing grant or a broken SECURITY DEFINER fails these outright.
--
-- ⚠ PROBES 9, 10 AND 11 EXIST BECAUSE THREE PINS IN THIS FUNCTION PREVIOUSLY
-- COULD NOT FAIL. Each was verified unfireable by enumerating the CALL SITES,
-- not the definitions:
--   * the null-uid refusal — every RPC call in this block was preceded by
--     set_config('request.jwt.claim.sub', <a real uid>, true), so deleting the
--     refusal outright changed no assertion. Probe 9 clears the GUC (BOTH of
--     them: auth.uid() falls back to request.jwt.claims) and asserts
--     auth.uid() really is null before it calls, so "refused" cannot be
--     confused with "the probe failed to clear the identity".
--   * the created-object-id tenancy guard — every probe paired a connector
--     with a SAME-TENANT proposal, so `and c.tenant_id = v_p.tenant_id` could
--     be deleted with all assertions still green, and a workspace owner could
--     stamp another workspace's connector id onto their own proposal. Probe 10
--     hands tenant A's own owner a tenant-B connector id for a tenant-A
--     proposal.
--   * `last_error = null` on success — no probe ever accepted a row that HAD a
--     last_error, so the clear could be deleted unnoticed and an accepted card
--     would read "accepted" and "failed because…" at once. Probes 7(e) and
--     10(b) both drive the real retry loop: refuse, reason written, retry,
--     succeed, reason gone.
-- Probe 11 pins the removal of the contract's platform disjunct (deviation 3).
--
-- EVERY REFUSAL IS FIRED AGAINST DATA AN EARLIER CONSTRAINT WOULD HAVE LET
-- THROUGH, because constraint ordering is unestablished and a check
-- intercepted by a prior constraint proves nothing:
--   * the unroutable-kind refusal uses 'guardrail', a value
--     discovery_proposals_kind_check ACCEPTS — so only the router can refuse
--     it;
--   * the role refusal and the accept that follows it use the SAME proposal
--     row and the SAME connector id, so the only difference is the actor;
--   * the cross-tenant refusal uses an owner who successfully accepts a
--     proposal in their OWN tenant seconds earlier, so the refusal cannot be
--     "that user cannot accept anything".
--
--   * the null-uid refusal is fired at the UNGATED arm (decline), because
--     accept is role-gated and a null uid would be refused by the role bar
--     too — the probe would then be unable to say which line refused it;
--   * the foreign-connector refusal uses the proposal's OWN tenant's OWN
--     owner, so neither the role bar nor the proposal's tenancy is in play and
--     the id is the only wrong thing;
--   * the platform refusal asserts the MESSAGE, because putting the disjunct
--     back still ends in a refusal — a later and much worse one.
--
-- AND THE INVERSION: NINE accepts are driven to SUCCESS — probe 1 (owner,
-- routable kind), probe 4 (a parked proposal accepted after a second Park was
-- refused), probe 5 step (d) (the owner on the row the tenant_user was
-- refused), probe 6 (the other tenant's owner in their OWN workspace), probe 7
-- (the routable sibling of the refused kind, same session, same owner), probe
-- 7 step (e) (the twice-failed row itself, once it is routable), probe 9 (the
-- same row an unidentified caller was refused on), probe 10 step (b) (the same
-- owner and row with a connector that IS theirs) and probe 11 step (c) (the
-- workspace's own owner on the row the platform operator was refused on).
-- "Everything was refused" and "the gate works" are therefore distinguishable
-- here, which is the only thing that makes the refusal assertions mean
-- anything. Every refusal below is paired with the success that isolates it.
-- ===========================================================================
do $$
declare
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
  v_p2_ok           boolean;
  v_p2_error        text;
  v_p2_state        text;
  v_p2_obj          uuid;
  v_p2_at           timestamptz;
  v_p2_audit_n      bigint;

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

  -- probe 9 — the null-uid refusal, fired with the GUC actually cleared
  v_p9_uid_seen     uuid;
  v_p9_refused      boolean := false;
  v_p9_msg          text;
  v_p9_state        text;
  v_p9_lasterr      text;
  v_p9_inv_ok       boolean := false;
  v_p9_inv_state    text;

  -- probe 10 — a created-object id from ANOTHER workspace
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

  -- probe 11 — a platform-layer profile has no standing inside a tenant
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
  ------------------------------------------------------------------------
  -- FIXTURES. Chosen dynamically, never hardcoded, and every one of them
  -- guarded for vacuity: if the shape this probe needs does not exist, the
  -- migration says so rather than passing on an empty set.
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

  if v_tenant is null then
    raise exception '741 vacuity guard: no live tenant holds BOTH an active owner/admin and an active non-admin member. Probe 5 could not tell "refused because of the role" from "refused because there is no identity", which is the only thing that makes the role bar worth asserting.';
  end if;

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

  if v_user_uid is null then
    raise exception '741 vacuity guard: the chosen tenant lost its non-admin member between the two reads';
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

  if v_other_admin is null then
    raise exception '741 vacuity guard: no second live tenant has an owner/admin who is not also in tenant %. The cross-tenant probe could not be fired, so "a proposal id is not its own authorisation" would be an untested claim.', v_tenant;
  end if;

  -- An ACTIVE platform-layer profile. This is probe 11's subject, and it is the
  -- pin on deviation 3 (the contract's `p.layer = 'platform' or` disjunct is
  -- deliberately absent from the role bar). Measured on this database: 2 such
  -- profiles exist, both with tenant_id NULL, and `profiles` carries
  -- UNIQUE (user_id) — so a platform profile holder structurally cannot also be
  -- a tenant member. Nothing is written to this row; it is only impersonated
  -- through request.jwt.claim.sub, inside a sub-block that is rolled back.
  select p.user_id into v_platform_uid
    from public.profiles p
   where p.layer = 'platform'
     and coalesce(p.is_active, true)
   order by p.created_at
   limit 1;

  if v_platform_uid is null then
    raise exception '741 vacuity guard: no active platform-layer profile exists, so probe 11 cannot fire. Without it, removing the contract''s `p.layer = ''platform'' or` disjunct from the role bar is an unpinned change — it could be added back and every assertion here would stay green while a platform operator claimed a tenant''s proposal and then aborted at append_audit_event, leaving an orphan connector the browser had already committed.';
  end if;

  select key into v_dim from public.discovery_dimensions where active order by key limit 1;
  if v_dim is null then
    raise exception '741 vacuity guard: no active discovery dimension exists — source_dimension carries an FK and the audit round-trip check would be a statement about NULL';
  end if;

  -- Baselines are SCOPED TO THE TWO PROBE TENANTS, and the audit baseline is
  -- scoped further to this feature's own detail kind. A global count(*) on
  -- audit_events would be read again at the end of the same READ COMMITTED
  -- transaction, so an unrelated tenant committing one audit row mid-apply
  -- would turn this migration red for a reason that has nothing to do with
  -- it. A check that fires for the wrong reason is no better than one that
  -- cannot fire. The exact leak checks further down close the gap this
  -- narrowing opens.
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
      values (v_tenant, 'generic_rest', 'probe connector 741', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 (decoy)', '', 'pending_credentials', 'other')
      returning id into v_conn_b;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('provider_key', 'probe_provider_a', 'label', 'Probe Helpdesk',
                                 'category', 'helpdesk',
                                 'credential_note', 'You still enter the credential yourself.'),
              'probe: matched in the evidence for this dimension', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', '  keep this note  ', v_conn);
    reset role;

    v_p1_ok := (v_res ->> 'ok')::boolean;
    select state, created_object_id, decided_by, decided_at, last_error
      into v_p1_state, v_p1_obj, v_p1_by, v_p1_at, v_p1_err
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
    reset role;

    v_p2_ok    := (v_res2 ->> 'ok')::boolean;
    v_p2_error := v_res2 ->> 'error';
    v_p2_state := v_res2 ->> 'state';
    select created_object_id, decided_at into v_p2_obj, v_p2_at
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p2_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'kind' = 'discovery_proposal_decision'
       and a.detail ->> 'proposal_id' = v_prop::text;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if not coalesce(v_p1_ok, false) then
    v_bad := v_bad || format('THE INVERSION FAILED: an owner accepting a routable connector proposal got ok=%L. If every path refuses, none of the refusals below proves a gate works.', coalesce(v_p1_ok::text, 'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_state is distinct from 'accepted' then
    v_bad := v_bad || format('accept left state=%L, expected accepted', coalesce(v_p1_state, 'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_obj is distinct from v_conn then
    v_bad := v_bad || 'accepted WITHOUT created_object_id being the connector the caller created — this is the exact state the Task 5 certify assertion goes red on';
  end if;
  v_checks := v_checks + 1;
  if v_p1_by is distinct from v_admin_uid then
    v_bad := v_bad || format('decided_by=%L, expected the deciding person %L — auth.uid() is not reaching the row', coalesce(v_p1_by::text,'NULL'), v_admin_uid::text);
  end if;
  v_checks := v_checks + 1;
  if v_p1_at is null then
    v_bad := v_bad || 'decided_at is null on an accepted proposal — a terminal state with no timestamp';
  end if;
  v_checks := v_checks + 1;
  if v_p1_err is not null then
    v_bad := v_bad || format('last_error survived a successful accept (%L) — a stale reason on a live row', v_p1_err);
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p1_audit_n, 0) <> 1 then
    v_bad := v_bad || format('the accept wrote %s audit row(s), expected exactly 1', coalesce(v_p1_audit_n::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail -> 'payload' ->> 'credential_note' is distinct from 'You still enter the credential yourself.'
     or v_p1_detail -> 'payload' ->> 'provider_key' is distinct from 'probe_provider_a' then
    v_bad := v_bad || format('the audit detail does not carry the payload VERBATIM — got %L. It is the only copy of what the customer consented to.', coalesce((v_p1_detail -> 'payload')::text, 'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> 'decided_by' is distinct from v_admin_uid::text then
    v_bad := v_bad || 'decided_by is not inside audit detail — the hash covers detail, not the actor column, so the identity is outside the tamper-evident chain';
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> 'created_object_table' is distinct from 'connectors' then
    v_bad := v_bad || format('audit detail created_object_table=%L — a bare uuid with no table name cannot be reconstructed once the row is gone', coalesce(v_p1_detail ->> 'created_object_table','NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> 'created_object_id' is distinct from v_conn::text then
    v_bad := v_bad || 'audit detail created_object_id does not match what was stamped';
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> 'note' is distinct from 'keep this note' then
    v_bad := v_bad || format('the note was not trimmed and recorded (got %L) — there is no note column, so the audit line is the only place it survives', coalesce(v_p1_detail ->> 'note','NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> 'writer' is distinct from 'connectProvider -> connectors (client, under RLS), stamped here' then
    v_bad := v_bad || format('audit detail writer=%L — the writer name is the only evidence no second creation engine ran', coalesce(v_p1_detail ->> 'writer','NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_actor_type is distinct from 'human' then
    v_bad := v_bad || format('the audit row actor_type=%L — a decision recorded as anything but human means append_audit_event took the service_role path and stamped no identity', coalesce(v_p1_actor_type,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p1_detail ->> '_submitted_by' is distinct from v_admin_uid::text then
    v_bad := v_bad || 'append_audit_event did not stamp _submitted_by — the server-attested identity is missing from the chain';
  end if;
  v_checks := v_checks + 1;
  if v_p1_category is distinct from 'config_change' then
    v_bad := v_bad || format('audit category=%L, expected config_change', coalesce(v_p1_category,'NULL'));
  end if;

  v_checks := v_checks + 1;
  if coalesce(v_p2_ok, true) then
    v_bad := v_bad || 'a SECOND accept on an already-accepted proposal returned ok=true — the compare-and-swap is not guarding the double click';
  end if;
  v_checks := v_checks + 1;
  if v_p2_error is distinct from 'already_decided' then
    v_bad := v_bad || format('the second accept returned error=%L, expected already_decided', coalesce(v_p2_error,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p2_state is distinct from 'accepted' then
    v_bad := v_bad || format('already_decided reported state=%L — the caller cannot see what it was already decided as', coalesce(v_p2_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p2_obj is distinct from v_conn then
    v_bad := v_bad || format('the second accept RE-STAMPED created_object_id to %L — it was handed a different connector id and took it', coalesce(v_p2_obj::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p2_at is distinct from v_p1_at then
    v_bad := v_bad || 'the second accept moved decided_at — a refused call must write nothing at all';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p2_audit_n, 0) <> 1 then
    v_bad := v_bad || format('after the second accept the proposal has %s audit rows, expected still exactly 1 — this is the shape that logged one approval three times', coalesce(v_p2_audit_n::text,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 3 — DECLINE creates nothing and leaves an audit row.
  --
  -- Red if: decline routes into Zone 3 and creates something; or a refusal is
  -- recorded nowhere, which would make "seen and refused" indistinguishable
  -- from "never generated".
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    -- A REAL, live connector in this workspace, so the re-decide below is not
    -- refused for some incidental reason. If the CAS ever admitted 'declined',
    -- this accept would fully SUCCEED and the assertions would report the
    -- loudest possible failure — state flipped to 'accepted' with an object
    -- stamped on a proposal the customer had refused.
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 decline', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('provider_key', 'probe_provider_decline', 'label', 'Probe Decline'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    -- ⚠ the digital_employees count EXCLUDES the Workspace Assistant. Nothing
    -- in this migration may read or write a row with
    -- is_workforce_assistant = true, and count(*) touches every row it counts.
    select count(*) into v_p3_conn_pre from public.connectors;
    select count(*) into v_p3_de_pre   from public.digital_employees
                                       where coalesce(is_workforce_assistant, false) = false;
    select count(*) into v_p3_gr_pre   from public.guardrail_rules;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'declined', 'we do not use that system');
    reset role;

    select state, created_object_id, decided_by, decided_at
      into v_p3_state, v_p3_obj, v_p3_by, v_p3_at
      from public.discovery_proposals where id = v_prop;

    select count(*) - v_p3_conn_pre into v_p3_conn_delta from public.connectors;
    select count(*) - v_p3_de_pre   into v_p3_de_delta   from public.digital_employees
                                                         where coalesce(is_workforce_assistant, false) = false;
    select count(*) - v_p3_gr_pre   into v_p3_gr_delta   from public.guardrail_rules;

    select count(*) into v_p3_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;
    select a.detail ->> 'note', a.detail ->> 'decision' into v_p3_note, v_p3_decision
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc, a.id desc limit 1;

    -- DECLINED IS TERMINAL. The header asserts it; until now nothing fired it.
    -- Probe 2 proves terminality only for 'accepted', so widening the Zone-2
    -- CAS to `state in ('pending','parked','declined')` would have gone
    -- unnoticed — and a re-decided decline would overwrite the only sentence
    -- explaining why the customer said no. The retry deliberately asks for
    -- 'accepted' with a real connector id, so a function that wrongly re-ran
    -- would visibly stamp created_object_id and flip the state.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'accepted', 'changed my mind', v_conn);
    reset role;

    v_p3_re_ok    := (v_res2 ->> 'ok')::boolean;
    v_p3_re_error := v_res2 ->> 'error';
    v_p3_re_state := v_res2 ->> 'state';
    select state, decided_at, created_object_id
      into v_p3_re_row_state, v_p3_re_at, v_p3_re_obj
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p3_re_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if v_p3_state is distinct from 'declined' then
    v_bad := v_bad || format('decline left state=%L', coalesce(v_p3_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p3_obj is not null then
    v_bad := v_bad || 'a DECLINED proposal has a created_object_id — declining created something';
  end if;
  v_checks := v_checks + 1;
  if v_p3_by is distinct from v_admin_uid then
    v_bad := v_bad || 'a declined proposal did not record who declined it';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p3_conn_delta,-1) <> 0 or coalesce(v_p3_de_delta,-1) <> 0 or coalesce(v_p3_gr_delta,-1) <> 0 then
    v_bad := v_bad || format('decline changed row counts: connectors %s, digital_employees %s, guardrail_rules %s — declining must create nothing anywhere',
      coalesce(v_p3_conn_delta::text,'NULL'), coalesce(v_p3_de_delta::text,'NULL'), coalesce(v_p3_gr_delta::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p3_audit_n,0) <> 1 then
    v_bad := v_bad || format('decline wrote %s audit row(s), expected 1 — an unaudited decline destroys the only sentence explaining why a customer said no', coalesce(v_p3_audit_n::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p3_note is distinct from 'we do not use that system' or v_p3_decision is distinct from 'declined' then
    v_bad := v_bad || format('the decline audit line reads decision=%L note=%L', coalesce(v_p3_decision,'NULL'), coalesce(v_p3_note,'NULL'));
  end if;

  -- ---- DECLINED IS TERMINAL (the header says so; these are what fire it) ----
  v_checks := v_checks + 1;
  if coalesce(v_p3_re_ok, true) then
    v_bad := v_bad || 'a DECLINED proposal was re-decided and returned ok=true — "declined is terminal" is asserted in this migration''s header and the CAS is not enforcing it';
  end if;
  v_checks := v_checks + 1;
  if v_p3_re_error is distinct from 'already_decided' then
    v_bad := v_bad || format('re-deciding a declined proposal returned error=%L, expected already_decided', coalesce(v_p3_re_error,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p3_re_state is distinct from 'declined' or v_p3_re_row_state is distinct from 'declined' then
    v_bad := v_bad || format('after re-deciding, already_decided reported state=%L and the row reads %L — a customer''s "no" was overwritten', coalesce(v_p3_re_state,'NULL'), coalesce(v_p3_re_row_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p3_re_obj is not null then
    v_bad := v_bad || 'the re-decide STAMPED a created_object_id onto a declined proposal — declining is supposed to create nothing, ever';
  end if;
  v_checks := v_checks + 1;
  if v_p3_re_at is distinct from v_p3_at then
    v_bad := v_bad || 'the re-decide moved decided_at on a declined proposal — a refused call must write nothing at all';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p3_re_audit_n, 0) <> 1 then
    v_bad := v_bad || format('after re-deciding, the declined proposal has %s audit rows, expected still exactly 1 — a second line would rewrite the record of why the customer said no', coalesce(v_p3_re_audit_n::text,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 4 — PARK is not decline, and a parked proposal is still decidable.
  --
  -- Red if: park writes 'declined'; or park is terminal, which would make it
  -- a decline with softer wording and would silently end the conversation the
  -- customer asked to postpone.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 park', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector',
              jsonb_build_object('provider_key', 'probe_provider_park', 'label', 'Probe Park'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'parked', 'ask me after the migration');
    reset role;

    v_p4_park_ok := (v_res ->> 'ok')::boolean;
    select state, decided_at into v_p4_park_state, v_p4_park_at
      from public.discovery_proposals where id = v_prop;
    select count(*) into v_p4_audit_park
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
       and a.detail ->> 'decision' = 'parked';

    -- PARK IS IDEMPOTENT — the second click. Widening the CAS to admit
    -- 'parked' is what keeps a parked proposal decidable, but on its own it
    -- also lets a double-clicked Park match again: re-dating the row, writing a
    -- SECOND config_change audit line and returning ok=true twice. That is the
    -- shape that logged one human's approval three times in 37 seconds.
    -- `and not (state = 'parked' and p_decision = 'parked')` is the guard, and
    -- this is the only thing that fires it.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'parked', 'still not now');
    reset role;

    v_p4_park2_ok    := (v_res2 ->> 'ok')::boolean;
    v_p4_park2_error := v_res2 ->> 'error';
    v_p4_park2_state := v_res2 ->> 'state';
    select state, decided_at into v_p4_park2_row, v_p4_park2_at
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
    reset role;

    v_p4_acc_ok := (v_res2 ->> 'ok')::boolean;
    select state, created_object_id into v_p4_acc_state, v_p4_acc_obj
      from public.discovery_proposals where id = v_prop;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if not coalesce(v_p4_park_ok, false) or v_p4_park_state is distinct from 'parked' then
    v_bad := v_bad || format('park returned ok=%L and left state=%L', coalesce(v_p4_park_ok::text,'NULL'), coalesce(v_p4_park_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p4_park_state = 'declined' then
    v_bad := v_bad || 'PARK WROTE DECLINED — "ask me later" was recorded as "no"';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p4_audit_park,0) <> 1 then
    v_bad := v_bad || format('park wrote %s audit row(s) with decision=parked, expected 1 — an unaudited park is the invisible pile', coalesce(v_p4_audit_park::text,'NULL'));
  end if;

  -- ---- the second Park (deviation 4b) ----
  v_checks := v_checks + 1;
  if coalesce(v_p4_park2_ok, true) then
    v_bad := v_bad || 'a SECOND Park on an already-parked proposal returned ok=true — park is not idempotent, and the CAS clause `and not (state = ''parked'' and p_decision = ''parked'')` is not firing';
  end if;
  v_checks := v_checks + 1;
  if v_p4_park2_error is distinct from 'already_decided' then
    v_bad := v_bad || format('the second Park returned error=%L, expected already_decided', coalesce(v_p4_park2_error,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p4_park2_state is distinct from 'parked' or v_p4_park2_row is distinct from 'parked' then
    v_bad := v_bad || format('after a second Park the call reported state=%L and the row reads %L', coalesce(v_p4_park2_state,'NULL'), coalesce(v_p4_park2_row,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p4_park2_at is distinct from v_p4_park_at then
    v_bad := v_bad || 'the second Park moved decided_at — a refused call must write nothing at all';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p4_park2_audit, 0) <> 1 then
    v_bad := v_bad || format('after a second Park the proposal has %s audit row(s) with decision=parked, expected still exactly 1 — this is the shape that logged one approval three times', coalesce(v_p4_park2_audit::text,'NULL'));
  end if;

  v_checks := v_checks + 1;
  if not coalesce(v_p4_acc_ok, false) or v_p4_acc_state is distinct from 'accepted' then
    v_bad := v_bad || format('a PARKED proposal could not be accepted later (ok=%L state=%L) — park is behaving as a terminal state, which makes it a decline', coalesce(v_p4_acc_ok::text,'NULL'), coalesce(v_p4_acc_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p4_acc_obj is distinct from v_conn then
    v_bad := v_bad || 'accepting a parked proposal did not stamp its created_object_id';
  end if;

  ------------------------------------------------------------------------
  -- PROBE 5 — THE ROLE BAR, and the proof that the refusal is about the ROLE.
  --
  -- Three steps in one sub-block, on purpose:
  --   (a) auth.uid() resolves to the tenant_user — they are NOT anonymous;
  --   (b) that same identity DECLINES successfully — the function is reachable
  --       to them and their identity is accepted for the ungated arm;
  --   (c) that same identity is REFUSED on accept;
  --   (d) the OWNER then accepts THE SAME proposal row with THE SAME connector
  --       id and succeeds.
  --
  -- Without (b) and (d) this probe would be indistinguishable from "the call
  -- failed for some other reason", which is the trap the brief names.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 role', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_role_a','label','Probe Role A'), 'probe', v_dim, 'pending')
      returning id into v_prop;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_role_b','label','Probe Role B'), 'probe', v_dim, 'pending')
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
    reset role;

    -- (c) the gated arm refuses the same identity
    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'let me in', v_conn);
    exception when others then
      v_p5_refused := true;
      v_p5_msg     := sqlerrm;
    end;
    reset role;

    -- (d) THE INVERSION — same row, same connector id, owner instead
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'approved', v_conn);
      v_p5_admin_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p5_admin_ok := false;
      v_p5_msg      := coalesce(v_p5_msg, '') || ' / owner also failed: ' || sqlerrm;
    end;
    reset role;
    select state into v_p5_admin_state from public.discovery_proposals where id = v_prop_b;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if v_p5_seen_uid is distinct from v_user_uid then
    v_bad := v_bad || format('the probe could not put a real identity on the transaction (auth.uid()=%L) — everything probe 5 claims about ROLE would actually be about being unauthenticated', coalesce(v_p5_seen_uid::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p5_decline_ok, false) or v_p5_decline_st is distinct from 'declined' then
    v_bad := v_bad || format('the tenant_user could not DECLINE (%L) — so the accept refusal below is not attributable to the role bar, and saying "no" has been gated, which is not an authority model', coalesce(v_p5_decline_st,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not v_p5_refused then
    v_bad := v_bad || 'a tenant_user ACCEPTED a discovery proposal — the role bar is not firing, and accepting is what creates employees, guardrails and trust caps from nothing';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p5_msg,'') not like '%owners and admins%' then
    v_bad := v_bad || format('the tenant_user was refused, but for the wrong reason: %L. A refusal that is really about something else proves nothing about the role bar.', coalesce(v_p5_msg,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p5_admin_ok, false) or v_p5_admin_state is distinct from 'accepted' then
    v_bad := v_bad || format('THE INVERSION FAILED: the OWNER could not accept the SAME row with the SAME connector id (state=%L). The tenant_user refusal therefore proves nothing about roles.', coalesce(v_p5_admin_state,'NULL'));
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
      values (v_other_tenant, 'generic_rest', 'probe connector 741 own', '', 'pending_credentials', 'other')
      returning id into v_conn_other;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_other_tenant, 'connector', jsonb_build_object('provider_key','probe_own','label','Probe Own'), 'probe', v_dim, 'pending')
      returning id into v_prop_other;

    -- tenant A's workspace
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 cross', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_cross','label','Probe Cross'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_other, 'accepted', 'mine', v_conn_other);
      v_p6_own_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p6_own_ok := false;
      v_p6_cross_msg := 'own-tenant accept failed: ' || sqlerrm;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'not mine', v_conn);
    exception when others then
      v_p6_cross_ref := true;
      v_p6_cross_msg := coalesce(v_p6_cross_msg || ' / ', '') || sqlerrm;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_other_admin::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'declined', 'not mine either');
    exception when others then
      v_p6_decline_ref := true;
      v_p6_decline_msg := sqlerrm;
    end;
    reset role;

    select state into v_p6_cross_state from public.discovery_proposals where id = v_prop;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if not coalesce(v_p6_own_ok, false) then
    v_bad := v_bad || format('the second tenant''s owner could not accept a proposal in their OWN workspace (%L) — so the cross-tenant refusal below is not evidence about tenancy', coalesce(v_p6_cross_msg,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not v_p6_cross_ref then
    v_bad := v_bad || 'an owner of ANOTHER workspace ACCEPTED this tenant''s proposal — the proposal id was treated as its own authorisation';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p6_cross_msg,'') not like '%owners and admins%' then
    v_bad := v_bad || format('the cross-tenant accept was refused for the wrong reason: %L', coalesce(v_p6_cross_msg,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not v_p6_decline_ref then
    v_bad := v_bad || 'an owner of ANOTHER workspace DECLINED this tenant''s proposal — decline is ungated by ROLE, but it must never be open across tenants. The refusal is expected to come from append_audit_event''s membership check, which raises and takes the claim down with it.';
  elsif coalesce(v_p6_decline_msg, '') = '' then
    v_bad := v_bad || 'the cross-tenant decline was refused with an empty message — a refusal nobody can read is the failure this whole migration is about';
  end if;
  v_checks := v_checks + 1;
  if v_p6_cross_state is distinct from 'pending' then
    v_bad := v_bad || format('after two refused cross-tenant decisions the proposal is %L, not pending — a refused call wrote to the row', coalesce(v_p6_cross_state,'NULL'));
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
              jsonb_build_object('rule','Never promise a refund','pattern','refund|chargeback','severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    -- a sibling the router CAN route, in the same session, decided by the
    -- same owner — so a refusal below is about the KIND and nothing else
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 sibling', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_sibling','label','Probe Sibling'), 'probe', v_dim, 'pending')
      returning id into v_prop_b;
    -- for step (e): the row that has ALREADY failed twice gets a real connector
    -- to succeed with, so the retry is a genuine second attempt on the same row
    -- rather than a fresh one.
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 retry', '', 'pending_credentials', 'other')
      returning id into v_conn_b;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'try it', null);
    reset role;

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
    reset role;
    select attempts into v_p7_attempts2 from public.discovery_proposals where id = v_prop;

    -- (e) THE RETRY LOOP — the ONLY place `last_error = null, last_error_at =
    -- null` on the success path is fired. Until this existed, every probe that
    -- accepted a proposal accepted one that had never failed, so the two
    -- clears could be deleted from the success UPDATE with all assertions
    -- still green — and a card that had failed once would read "accepted" and
    -- "failed because kind not yet routable: guardrail" at the same time,
    -- forever. This row has genuinely failed twice and carries a real reason;
    -- making its kind routable is the migration's stand-in for the product's
    -- own retry (fix the cause, click Accept again).
    select last_error into v_p7_pre_lasterr
      from public.discovery_proposals where id = v_prop;
    update public.discovery_proposals set kind = 'connector' where id = v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'routable now', v_conn_b);
    reset role;

    v_p7_retry_ok := (v_res ->> 'ok')::boolean;
    select state, last_error, last_error_at, attempts, created_object_id
      into v_p7_retry_state, v_p7_retry_err, v_p7_retry_at, v_p7_retry_att, v_p7_retry_obj
      from public.discovery_proposals where id = v_prop;

    -- THE INVERSION: the routable sibling, same session, same owner
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'this one routes', v_conn);
    reset role;
    v_p7_sibling_ok := (v_res ->> 'ok')::boolean;
    select state into v_p7_sibling_st from public.discovery_proposals where id = v_prop_b;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if coalesce(v_p7_ok, true) then
    v_bad := v_bad || 'an UNROUTABLE kind returned ok=true — a kind with no writer reported success at doing nothing';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p7_error,'') not like 'kind not yet routable%' then
    v_bad := v_bad || format('the unroutable refusal reads %L — it must name the kind so the card can say why', coalesce(v_p7_error,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_state is distinct from 'pending' then
    v_bad := v_bad || format('after a refused accept the proposal is %L, not pending — a failed accept must return it to the deck (and %L would mean an accepted row with no object)', coalesce(v_p7_state,'NULL'), coalesce(v_p7_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_lasterr is null or v_p7_lasterr not like 'kind not yet routable%' then
    v_bad := v_bad || format('last_error is %L after a refusal — this is the whole point of migration 740: a silent refusal is indistinguishable from an undecided proposal', coalesce(v_p7_lasterr,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_lastat is null then
    v_bad := v_bad || 'last_error_at is null after a refusal — a reason with no date cannot be told from a stale one';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p7_attempts, -1) <> 1 then
    v_bad := v_bad || format('attempts=%L after one failed accept, expected 1', coalesce(v_p7_attempts::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p7_attempts2, -1) <> 2 then
    v_bad := v_bad || format('attempts=%L after a SECOND failed accept, expected 2 — the counter is being set, not incremented, so a card on its third try looks like its first', coalesce(v_p7_attempts2::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_by is not null or v_p7_at is not null then
    v_bad := v_bad || 'a refused accept left decided_by/decided_at on a pending row — the row claims a decision that did not happen';
  end if;
  v_checks := v_checks + 1;
  if v_p7_obj is not null then
    v_bad := v_bad || 'a refused accept stamped a created_object_id';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p7_audit_n,0) <> 1 or v_p7_audit_out is distinct from 'refused' then
    v_bad := v_bad || format('the refusal wrote %s audit row(s) with outcome=%L, expected 1 marked refused', coalesce(v_p7_audit_n::text,'NULL'), coalesce(v_p7_audit_out,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p7_sibling_ok, false) or v_p7_sibling_st is distinct from 'accepted' then
    v_bad := v_bad || format('THE INVERSION FAILED: the routable sibling in the SAME session, decided by the SAME owner, was not accepted (state=%L). The guardrail refusal is then not about the kind.', coalesce(v_p7_sibling_st,'NULL'));
  end if;

  -- ---- (e) the retry loop: a row that HAD a reason is accepted ----
  v_checks := v_checks + 1;
  if v_p7_pre_lasterr is null then
    v_bad := v_bad || 'the retry step started from a row with NO last_error — then "last_error is null afterwards" proves nothing, because it was never anything else. This assertion exists so the clear below cannot pass vacuously.';
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p7_retry_ok, false) or v_p7_retry_state is distinct from 'accepted' then
    v_bad := v_bad || format('THE RETRY FAILED: a proposal that had failed twice could not be accepted once its kind was routable (ok=%L state=%L). A card that fails is then permanently stuck, which is worse than the silence 740 exists to end.', coalesce(v_p7_retry_ok::text,'NULL'), coalesce(v_p7_retry_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_retry_err is not null or v_p7_retry_at is not null then
    v_bad := v_bad || format('a SUCCESSFUL accept left last_error=%L / last_error_at=%L on the row — the card would read "accepted" and "failed because…" at the same time, forever', coalesce(v_p7_retry_err,'NULL'), coalesce(v_p7_retry_at::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p7_retry_obj is distinct from v_conn_b then
    v_bad := v_bad || 'the successful retry did not stamp the connector it was given';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p7_retry_att, -1) <> 2 then
    v_bad := v_bad || format('after a successful retry attempts=%L, expected it to STAY at 2. attempts counts how hard this was, not whether it is currently broken — last_error is what says that, and it has been cleared. Silently zeroing it would erase the evidence of the two failures.', coalesce(v_p7_retry_att::text,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 8 — a DEACTIVATED owner cannot accept.
  --
  -- `coalesce(p.is_active, true)` is in the role predicate; if it were never
  -- fired it would be decoration. The same owner accepted successfully in
  -- probe 1, so the only thing that changed is the flag.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 inactive', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_inactive','label','Probe Inactive'), 'probe', v_dim, 'pending')
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
    reset role;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if not v_p8_refused or coalesce(v_p8_msg,'') not like '%owners and admins%' then
    v_bad := v_bad || format('a DEACTIVATED owner accepted a discovery proposal (refused=%L, %L) — coalesce(is_active, true) in the role predicate is decoration', coalesce(v_p8_refused::text,'NULL'), coalesce(v_p8_msg,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 9 — NO IDENTITY AT ALL. The null-uid refusal, actually fired.
  --
  -- Every other RPC call in this block is preceded by
  -- set_config('request.jwt.claim.sub', <a real uid>, true), so the refusal at
  -- the top of Zone 1 could be deleted outright and nothing here would notice.
  -- This probe clears the identity for real.
  --
  -- ⚠ BOTH GUCs. The live auth.uid() body is
  --   coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
  --            nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'sub')::uuid
  -- so clearing only the first leaves a fallback. `v_p9_uid_seen` is asserted
  -- null below precisely so "refused" cannot be mistaken for "the probe failed
  -- to clear the identity" — a refusal for the wrong reason is no evidence.
  --
  -- ⚠ IT FIRES **DECLINE**, NOT ACCEPT, AND THAT IS THE WHOLE CONSTRUCTION.
  -- Accept is role-gated, so a null uid would be refused by the role bar too
  -- and the probe could not tell the two apart. Decline is ungated, so the
  -- ONLY thing in Zone 1 that can refuse it is the null-uid line. Deleting
  -- that line does not make this probe green: the call would then claim the
  -- row with decided_by = NULL and die inside append_audit_event's membership
  -- check instead — which is why the MESSAGE is asserted, not merely the fact
  -- of a refusal. That distinction is the pin.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 anon', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_anon','label','Probe Anon'), 'probe', v_dim, 'pending')
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
    reset role;
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
      v_p9_msg    := coalesce(v_p9_msg,'') || ' / the IDENTIFIED caller also failed: ' || sqlerrm;
    end;
    reset role;
    select state into v_p9_inv_state from public.discovery_proposals where id = v_prop;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if v_p9_uid_seen is not null then
    v_bad := v_bad || format('the probe could not clear the identity (auth.uid()=%L) — everything below would then be a statement about some OTHER refusal, not about the null-uid bar', v_p9_uid_seen::text);
  end if;
  v_checks := v_checks + 1;
  if not v_p9_refused then
    v_bad := v_bad || 'a caller with NO identity DECLINED a discovery proposal — decided_by would be null on a terminal row, which is a decision nobody made, and it is unsatisfiable for the Task 5 certify assertion';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p9_msg,'') not like 'not authenticated%' then
    v_bad := v_bad || format('the unidentified caller was refused, but by something OTHER than the null-uid bar: %L. If that line is gone, the call claims the row with decided_by=NULL and dies later inside append_audit_event — a different refusal, in worse words, after a write.', coalesce(v_p9_msg,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p9_state is distinct from 'pending' or v_p9_lasterr is not null then
    v_bad := v_bad || format('the refused anonymous call left state=%L last_error=%L — Zone 1 refuses BEFORE anything is written', coalesce(v_p9_state,'NULL'), coalesce(v_p9_lasterr,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p9_inv_ok, false) or v_p9_inv_state is distinct from 'accepted' then
    v_bad := v_bad || format('THE INVERSION FAILED: the same row could not be decided by an IDENTIFIED owner either (state=%L). The anonymous refusal then proves nothing about identity.', coalesce(v_p9_inv_state,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 10 — A CREATED-OBJECT ID IS NOT ITS OWN AUTHORISATION.
  --
  -- Every other probe pairs a connector with a proposal in the SAME tenant, so
  -- `and c.tenant_id = v_p.tenant_id` in the connector arm could be deleted
  -- with all assertions still green — and tenant A's own owner could stamp
  -- tenant B's connector id onto tenant A's proposal, satisfying the Task 5
  -- certify assertion ("no accepted row without a created_object_id") with a
  -- cross-tenant pointer. That is the stored-marker-as-truth trap.
  --
  -- The caller here is tenant A's OWN owner deciding tenant A's OWN proposal —
  -- so nothing about the role bar or the proposal's tenancy is in play. The
  -- only wrong thing is the id, and step (b) proves it by handing the same
  -- owner the same row with a connector that IS theirs.
  --
  -- Step (b) is also the second firing of the retry loop, and the honest one:
  -- refuse → reason written, attempts 1 → retry with a good id → succeed,
  -- reason gone. That is the exact sequence a real customer hits.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_other_tenant, 'generic_rest', 'probe connector 741 foreign', '', 'pending_credentials', 'other')
      returning id into v_conn_other;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 home', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_foreign_id','label','Probe Foreign Id'), 'probe', v_dim, 'pending')
      returning id into v_prop;

    -- (a) the right person, the right proposal, ANOTHER WORKSPACE'S connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'someone else''s connector', v_conn_other);
    reset role;

    v_p10_ok    := (v_res ->> 'ok')::boolean;
    v_p10_error := v_res ->> 'error';
    select state, created_object_id, last_error, last_error_at, attempts
      into v_p10_state, v_p10_obj, v_p10_lasterr, v_p10_lastat, v_p10_attempts
      from public.discovery_proposals where id = v_prop;

    -- (b) THE INVERSION — same owner, same row, THIS workspace's connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'my own connector', v_conn);
    reset role;

    v_p10_fix_ok := (v_res ->> 'ok')::boolean;
    select state, created_object_id, last_error, last_error_at
      into v_p10_fix_state, v_p10_fix_obj, v_p10_fix_err, v_p10_fix_at
      from public.discovery_proposals where id = v_prop;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if coalesce(v_p10_ok, true) then
    v_bad := v_bad || 'a workspace owner stamped ANOTHER WORKSPACE''S connector id onto their own proposal and got ok=true — a created-object id was treated as its own authorisation, and certify''s "no accepted row without a created_object_id" would be satisfied by a cross-tenant pointer';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p10_error,'') not like 'no connector %' then
    v_bad := v_bad || format('the foreign connector id was refused for the wrong reason: %L', coalesce(v_p10_error,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p10_state is distinct from 'pending' or v_p10_obj is not null then
    v_bad := v_bad || format('after the foreign-id refusal the row reads state=%L created_object_id=%L — a refused accept must return it to the deck with nothing stamped', coalesce(v_p10_state,'NULL'), coalesce(v_p10_obj::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p10_lasterr is null or v_p10_lasterr not like 'no connector %' or v_p10_lastat is null
     or coalesce(v_p10_attempts, -1) <> 1 then
    v_bad := v_bad || format('the foreign-id refusal recorded last_error=%L last_error_at=%L attempts=%L — a refusal nobody can read is the failure this migration exists to end', coalesce(v_p10_lasterr,'NULL'), coalesce(v_p10_lastat::text,'NULL'), coalesce(v_p10_attempts::text,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p10_fix_ok, false) or v_p10_fix_state is distinct from 'accepted'
     or v_p10_fix_obj is distinct from v_conn then
    v_bad := v_bad || format('THE INVERSION FAILED: the SAME owner could not accept the SAME row with a connector that IS theirs (ok=%L state=%L). The refusal above is then not about tenancy, and a card that fails once is stuck forever.', coalesce(v_p10_fix_ok::text,'NULL'), coalesce(v_p10_fix_state,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p10_fix_err is not null or v_p10_fix_at is not null then
    v_bad := v_bad || format('the successful retry left last_error=%L / last_error_at=%L behind — the card would read "accepted" and "no connector … in this workspace" at once', coalesce(v_p10_fix_err,'NULL'), coalesce(v_p10_fix_at::text,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PROBE 11 — A PLATFORM-LAYER PROFILE HAS NO STANDING INSIDE A TENANT.
  --
  -- This pins deviation 3: the contract's role bar carries a
  -- `p.layer = 'platform' or` disjunct and this function deliberately does not.
  -- Both fixture queries above filter platform-profile holders OUT, so before
  -- this probe the arm was never driven in either direction.
  --
  -- ⚠ THE ASSERTION IS ON THE MESSAGE, NOT ON "was it refused". Put the
  -- disjunct back and this call is still refused — but LATER and ELSEWHERE:
  -- it passes Zone 1, the Zone-2 CAS CLAIMS the row, Zone 3 validates, and
  -- append_audit_event then raises 'not a member of this tenant' from outside
  -- every sub-block. Here that abort is caught and rolled back, so the row
  -- looks the same either way; in production it is not the same at all,
  -- because Path B means the browser has ALREADY COMMITTED the connector in a
  -- separate round trip. The end state there is an orphan connector inside the
  -- customer's workspace, the proposal still pending, last_error NULL, and a
  -- message naming the wrong problem. So the message is the only thing that
  -- can tell the two apart, and it is what is asserted.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.connectors (tenant_id, provider, display_name, base_url, status, category)
      values (v_tenant, 'generic_rest', 'probe connector 741 platform', '', 'pending_credentials', 'other')
      returning id into v_conn;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'connector', jsonb_build_object('provider_key','probe_platform','label','Probe Platform'), 'probe', v_dim, 'pending')
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
    reset role;
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
    reset role;

    -- (c) THE INVERSION — the workspace's OWN owner, same row, same connector
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'the workspace decides', v_conn);
      v_p11_owner_ok := (v_res ->> 'ok')::boolean;
    exception when others then
      v_p11_owner_ok := false;
      v_p11_msg      := coalesce(v_p11_msg,'') || ' / the workspace owner also failed: ' || sqlerrm;
    end;
    reset role;
    select state into v_p11_owner_state from public.discovery_proposals where id = v_prop;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      reset role;
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  v_checks := v_checks + 1;
  if not v_p11_refused then
    v_bad := v_bad || 'a PLATFORM-layer profile ACCEPTED a tenant''s discovery proposal — the platform disjunct is back in the role bar, and on Path B that means an orphan connector already committed in the customer''s workspace with the proposal left pending and last_error NULL';
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_p11_msg,'') not like '%owners and admins%' then
    v_bad := v_bad || format('the platform operator was refused, but NOT by the role bar: %L. That is the signature of the disjunct being present — Zone 1 passed, the CAS claimed the row, and the call died at append_audit_event instead, outside every sub-block.', coalesce(v_p11_msg,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if v_p11_state is distinct from 'pending' or v_p11_lasterr is not null then
    v_bad := v_bad || format('the refused platform accept left state=%L last_error=%L — Zone 1 refuses before anything is written', coalesce(v_p11_state,'NULL'), coalesce(v_p11_lasterr,'NULL'));
  end if;
  v_checks := v_checks + 1;
  if not v_p11_decline_ref then
    v_bad := v_bad || 'a PLATFORM-layer profile DECLINED a tenant''s discovery proposal — decline is ungated by ROLE, but it must never be open to someone with no membership in the workspace at all';
  elsif coalesce(v_p11_decline_msg,'') = '' then
    v_bad := v_bad || 'the platform decline was refused with an empty message — a refusal nobody can read is the failure this whole migration is about';
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_p11_owner_ok, false) or v_p11_owner_state is distinct from 'accepted' then
    v_bad := v_bad || format('THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME row with the SAME connector id (ok=%L state=%L). The platform refusal then proves nothing about layer.', coalesce(v_p11_owner_ok::text,'NULL'), coalesce(v_p11_owner_state,'NULL'));
  end if;

  ------------------------------------------------------------------------
  -- PERIMETER, all four roles, both directions, full-signature form so an
  -- unresolvable name ERRORs 42883 instead of quietly returning false.
  --
  -- ⚠ service_role=false is the pin that fires if anyone drops the explicit
  -- revoke: pg_default_acl grants it automatically on every function this
  -- role creates in `public`.
  ------------------------------------------------------------------------
  v_checks := v_checks + 1;
  if has_function_privilege('public', v_sig, 'execute') then
    v_bad := v_bad || 'PUBLIC can execute decide_discovery_proposal';
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('anon', v_sig, 'execute') then
    v_bad := v_bad || 'anon can execute decide_discovery_proposal — the internet can decide a workspace''s proposals';
  end if;
  v_checks := v_checks + 1;
  if has_function_privilege('service_role', v_sig, 'execute') then
    v_bad := v_bad || 'service_role can execute decide_discovery_proposal — under service_role auth.uid() is null, append_audit_event skips its membership check and its _submitted_by stamp, and the accept leaves no identity anywhere. This grant arrives by DEFAULT (pg_default_acl), so it must be revoked explicitly.';
  end if;
  v_checks := v_checks + 1;
  if not has_function_privilege('authenticated', v_sig, 'execute') then
    v_bad := v_bad || 'authenticated CANNOT execute decide_discovery_proposal — the only caller that is supposed to has been locked out';
  end if;
  v_checks := v_checks + 1;
  if has_table_privilege('authenticated', 'public.discovery_proposals', 'UPDATE') then
    v_bad := v_bad || 'authenticated can UPDATE discovery_proposals directly — a client that can write its own state does not need this function and is not audited';
  end if;

  ------------------------------------------------------------------------
  -- ROLLBACK INTEGRITY. Every probe above is a statement about rows that are
  -- still in production unless these match. Compared against baselines taken
  -- before any probe ran, never against a hardcoded zero.
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

  -- The exact leak checks. Every row this block created is tagged, so these
  -- are immune to whatever else the platform is doing during the apply, and
  -- they name the survivor rather than only its count.
  select count(*) into v_leak_conn from public.connectors
   where display_name like 'probe connector 741%';
  select count(*) into v_leak_prop from public.discovery_proposals
   where payload ->> 'provider_key' like 'probe%'
      or payload ->> 'rule' = 'Never promise a refund';

  v_checks := v_checks + 1;
  if v_prop_after <> v_prop_before or v_sess_after <> v_sess_before
     or v_conn_after <> v_conn_before or v_audit_after <> v_audit_before then
    raise exception '741: a probe rollback is broken and this migration has left test data in production — discovery_proposals % -> %, discovery_sessions % -> %, connectors % -> %, decision audit events % -> % (counts scoped to tenants % and %)',
      v_prop_before, v_prop_after, v_sess_before, v_sess_after,
      v_conn_before, v_conn_after, v_audit_before, v_audit_after,
      v_tenant, v_other_tenant;
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_leak_conn, 0) <> 0 or coalesce(v_leak_prop, 0) <> 0 then
    raise exception '741: probe rows SURVIVED — % connector(s) named "probe connector 741%%" and % discovery proposal(s) with probe payloads are in production',
      v_leak_conn, v_leak_prop;
  end if;
  v_checks := v_checks + 1;
  if not coalesce(v_admin_active, false) then
    raise exception '741: probe 8 left a real person DEACTIVATED in production — its rollback is broken';
  end if;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '741: % of % assertion(s) failed: %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '741: % assertions compared, 0 failed, across 11 probes fired as role `authenticated`. Accept SUCCEEDS on NINE separate rows, so the refusals are meaningful rather than "everything is broken": probe 1 (owner, routable kind), 4 (a parked proposal, after a second Park was refused), 5d (the owner on the row a tenant_user was refused), 6 (the other tenant''s owner in their OWN workspace), 7 (the routable sibling) and 7e, 9, 10b, 11c (the four inversions of the new pins). REFUSED, each with the reason asserted and not merely the fact: a second accept (already_decided, nothing written); a re-decided DECLINE (already_decided — "declined is terminal" was asserted in this header and pinned by nothing until now); a SECOND Park (already_decided, no second audit row, decided_at unmoved); a tenant_user who CAN decline; a deactivated owner; another tenant''s owner, on both arms; an unroutable kind (pending, last_error, attempts 1 then 2 — then made routable and accepted, which is the ONLY firing of last_error/last_error_at being cleared on success); a caller with auth.uid() ACTUALLY null, asserted null before the call and fired at the UNGATED arm so only the null-uid line can refuse it; a same-tenant owner passing ANOTHER workspace''s connector id, then succeeding with their own; and a PLATFORM-layer profile, refused in Zone 1 by the role bar rather than later by append_audit_event. Rows unchanged in the two probe tenants: % proposals, % sessions, % connectors, % decision audit events, and zero probe-tagged rows survive. NOT proven here: PostgREST''s JWT transport (the probes set request.jwt.claim.sub themselves), and CONCURRENT as opposed to sequential double-click.',
    v_checks, v_prop_after, v_sess_after, v_conn_after, v_audit_after;
end $$;

commit;
