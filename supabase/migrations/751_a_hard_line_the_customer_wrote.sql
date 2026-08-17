-- 751_a_hard_line_the_customer_wrote.sql
-- ==========================================================================
-- WHY: the interview asks "what must never happen", the customer answers in
-- their own words, and until now the card that came back could not be acted
-- on. `decide_discovery_proposal` routed `connector` (741) and `employee`
-- (746); `guardrail` fell into the `kind not yet routable` arm along with
-- everything else. A real interview run produced twelve proposals across five
-- kinds and a customer could act on two of them.
--
-- This adds the THIRD kind, `guardrail`, and it adds only half of it, on
-- purpose.
--
-- ==========================================================================
-- THE FOUNDER'S RULING, 2026-08-15: PATTERNS NOW, THRESHOLDS HELD.
--
-- A guardrail payload is exactly {rule, pattern, threshold, severity}
-- (supabase/functions/_shared/discoveryProposals.ts — FILL_WHITELIST.guardrail
-- is ['pattern','threshold'] and the emitted draft hardcodes severity), and it
-- carries NO rule_type. The writer must choose one, and the choice decides
-- whether the rule enforces anything at all.
--
-- A PATTERN-BEARING guardrail is accepted, as `blocked_phrase`:
--   * it is enforced on four live paths (de-answer, widget-ask, voice-turn and
--     the adjudicator all reach findBlockingMatch through
--     supabase/functions/_shared/guardrailMatch.ts; playbook-execute reaches
--     matchPattern directly);
--   * `pattern` is exactly the string matchPattern compiles;
--   * the card shows that same string verbatim (`matches: <pattern>`).
--   So the promise on the card holds end to end, which is the only reason this
--   half ships.
--
-- A THRESHOLD-ONLY guardrail is REFUSED, in words the customer can read, and
-- the refusal lands in `discovery_proposals.last_error` so the card still says
-- why tomorrow. Two measured reasons, neither of them stylistic:
--   * THE NUMBER HAS NO UNIT. The fill prompt asks for "a bare number, no
--     words", while the two threshold-bearing rule_types read it in DIFFERENT
--     units — `require_approval_over_cents` is CENTS and `max_discount_pct` is
--     PERCENT. A customer who said "anything over 10,000" and was shown
--     "threshold: 10,000" would get a $100 gate if it were mapped raw. That is
--     not a smaller version of "you cannot consent to a block you cannot
--     predict"; it IS that failure.
--   * `max_discount_pct` HAS NO ENFORCEMENT PATH AT ALL. Its only readers in
--     the entire database are `get_de_briefing` and
--     `get_de_briefing_for_objective`, which interpolate it into a prompt. A
--     card promising "above this it needs your approval" against a rule_type
--     nothing gates would be the "looks governed and is not" artefact this
--     whole surface exists to prevent.
--
-- ==========================================================================
-- PATH B, AND WHY THIS FUNCTION DOES NOT INSERT THE RULE
--
-- A guardrail's ordinary writer is `addGuardrailRule` (src/lib/guardrailApi.ts)
-- — a PostgREST insert made by the signed-in human under RLS. `authenticated`
-- holds INSERT on `guardrail_rules` and the `guardrail_rules_tenant_write`
-- policy reads `tenant_id = auth_tenant_id() and auth_has_tenant_role(
-- ['tenant_owner','tenant_admin'])` (both read from the live catalogue). So the
-- browser creates the rule and then calls this function with the id it made,
-- exactly as `connector` does.
--
-- An `insert into guardrail_rules` inside this SECURITY DEFINER body would run
-- as `postgres`, bypass that policy entirely, and be a SECOND creation engine
-- (contract §8.3). It is not here.
--
-- WHAT THIS FUNCTION DOES INSTEAD IS CHECK THE ROW IT IS HANDED, and every one
-- of those checks is a promise printed on the card:
--   * the rule belongs to THIS proposal's tenant — a created-object id is not
--     its own authorisation (migrations 662-664);
--   * `rule_type = 'blocked_phrase'` — the one variant of nine the live CHECK
--     admits whose card promise is true end to end;
--   * `pattern` is BYTE-IDENTICAL to the payload's pattern — the card showed
--     that literal, and a rule that blocks something else is a block the
--     customer could not have predicted;
--   * `severity = 'blocking'`, `scope = 'workspace'`, `applies_to = 'all'`,
--     active and not retired — `loadBlockingRules` filters
--     `severity === 'blocking'` and every reader filters `active`, so any other
--     combination is a rule the card calls enforced and nothing enforces.
--     ⚠ `scope` IS THE COLUMN THAT DECIDES BLAST RADIUS, AND IT IS NOT
--     `applies_to`. Measured live from pg_get_functiondef:
--     `guardrail_rules_for_de` — the sole resolver behind loadBlockingRules and
--     loadBlockingRulesForJudge, i.e. all four enforcement paths — does not
--     contain the string `applies_to` anywhere in its body. Its scope predicate
--     has FOUR arms, not two, and this paragraph named only two of them
--     (corrected 2026-08-17 — the behaviour described was right, but naming a
--     four-arm resolver as a two-arm one is the same class of error that
--     produced B1):
--         g.scope = 'workspace'
--      or g.scope = 'employee'   and g.scope_ref = p_de_id::text
--      or g.scope = 'department' and g.scope_ref = (that employee's department)
--      or g.scope = 'playbook'   and g.scope_ref = p_playbook_def_id::text
--     In supabase/functions/_shared, `applies_to` appears only as a field
--     carried onto a block record, never as a filter. So a rule at any of the
--     three NON-workspace scopes with applies_to='all' is enforced for a strict
--     subset — one employee, one department, one playbook — while every card
--     sentence about it says "for every employee in this workspace";
--   * `compliance_pack_key IS NULL`. ⚠ THIS ONE IS ABOUT BEING ABLE TO CHANGE
--     YOUR MIND. `retire_guardrail_rule` refuses a pack rule by name
--     ("it belongs to a pack — detach the pack instead"), and
--     `trg_guard_compliance_guardrails` blocks deactivating one. A discovery
--     guardrail carrying a pack key would be a rule the customer accepted and
--     cannot remove — the defect migration 747 has just finished fixing on the
--     other side of this same table. Probe 15 retires the rule it just created
--     and watches it succeed.
--
-- ==========================================================================
-- ⚠ THE THIRD COPY OF looksLikeEnforceablePattern, AND WHY IT IS HERE
--
-- `validatePayload` (Task 1) accepts a guardrail whose `pattern` is PROSE as
-- long as `threshold` is a valid number — it never nulls the prose out. So a
-- stored payload can carry `pattern: "anything the customer might find
-- upsetting"` beside `threshold: 10000`, and the card correctly renders it as
-- "threshold: 10,000" (guardrailKindOf returns 'threshold' because the pattern
-- fails looksLikeEnforceablePattern). That payload is threshold-only in every
-- sense that matters, and this function has to say so IN THOSE WORDS — because
-- this function is the only thing that can write `last_error`.
--
-- Testing `pattern is not null` would not have done it: the prose is not null.
-- So the predicate is restated here, as SQL, and it is the THIRD copy —
-- src/lib/discoveryProposalPresentation.ts and
-- supabase/functions/_shared/discoveryProposals.ts hold the other two, kept in
-- step by tests/discovery-proposal-batching.test.ts's drift guard.
--
-- ⚠ THE TWO DRIFT DIRECTIONS ARE NOT SYMMETRIC, AND THIS PARAGRAPH USED TO SAY
-- THEY WERE. It read: "If the SQL copy is STRICTER than the card's, a card
-- promising a block meets a refusal that says why and creates nothing… Neither
-- direction can produce an enforced rule the customer did not see." The second
-- half of that is false under the Path B wiring THIS MIGRATION ADDS, and false
-- in the direction that matters. Corrected 2026-08-17.
--
-- The real ordering, from acceptGuardrailProposal (src/lib/discoveryApi.ts):
-- the TS gate runs, the browser INSERTS the rule through addGuardrailRule, and
-- only then is decide_discovery_proposal called. So:
--
--   * SQL LOOSER than TS — safe, and for the stated reason. The client refused
--     first, created nothing, and the accept lands on the
--     `p_created_object_id is null` arm.
--
--   * SQL STRICTER than TS — NOT safe. The rule is already in
--     `guardrail_rules`, active, blocking, workspace-wide. This function then
--     refuses the stamp, the proposal reverts to `pending` with its reason in
--     `last_error`, and the client's reuse-find re-finds that same live rule on
--     every retry and re-refuses forever. The customer is told "The rule was
--     created and is switched on now" at the moment of the click and sees only
--     the refusal after a reload — with a workspace-wide blocking rule live the
--     whole time. That is B2's sharp case, generalised from the trim to the
--     whole predicate.
--
-- WHICH MEANS THE ONE INVARIANT IS ASYMMETRIC: THE CLIENT MUST BE AT LEAST AS
-- STRICT AS THIS FUNCTION, ALWAYS. Measured 2026-08-17 across a 90-pattern
-- battery: 2 disagreements, BOTH TS-stricter, i.e. both on the safe side —
-- 61 astral characters (Postgres `length()` counts code points, JS `.length`
-- counts UTF-16 units, against the shared bound of 120) and 'éanything'
-- (Postgres `\y` treats é as a word character so the prose-word alternation
-- does not fire; JS `\b` does not, so it does). tests/discovery-proposal-
-- batching.test.ts now pins that direction with a differential battery that
-- goes red the moment any pattern exists where TS accepts and this function
-- refuses, plus a structural count of this branch's refusal clauses so a NEW
-- conjunct or a NEW raise added here alone cannot be silent.
--
-- ⚠ CORRECTED. This paragraph used to end "Probe 15 fires the prose arm against
-- a payload the CHECK constraint and validatePayload both admit, so it is the
-- router refusing and nothing else", and probe 15(e)'s own comment said the
-- same. BOTH WERE FALSE, and measurably so: 15(e)'s payload is a prose pattern
-- with `threshold: null`, and validatePayload
-- (supabase/functions/_shared/discoveryProposals.ts:946-952) nulls a
-- non-enforceable pattern to '' and then THROWS when neither a pattern nor a
-- numeric threshold survives. guardrailKindOf returns 'none' for it too, not
-- 'threshold', so the card reads "no literal recorded yet". The BEHAVIOUR the
-- probe covers is right and stays; only the justification was wrong. What
-- validatePayload really admits is prose BESIDE a valid threshold — that
-- payload reaches the threshold refusal, not this one — so the prose arm exists
-- for a payload that arrives any other way (a row written before this predicate
-- existed, or an operator insert), and probe 15(e) drives it directly.
--
-- ==========================================================================
-- WHAT ELSE MOVED, ENUMERATED
--
--  1. `verify_decide_discovery_proposal()` PROBE 7 IS REPOINTED. It used
--     `guardrail` as its admitted-but-unroutable example — routing the kind
--     would have made every one of its fifteen assertions answer about the
--     guardrail branch's own refusals instead of about the router, i.e. it
--     would have gone vacuous while staying green. It now uses `trust_rule`,
--     which contract §9 orders LAST and which is therefore the kind that stays
--     unroutable longest. Probe 14 still fires `procedure` and `trust_rule`
--     independently.
--  2. PROBE 15 IS NEW: the whole guardrail path, both halves, driven as the
--     real runtime role `authenticated` and rolled back.
--  3. THE DENOMINATORS MOVE: 14 probes -> 15, assertion floor 138 -> 169.
--     (26 added by probe 15 and the guardrail leak arm, then 5 more by the
--     review fixes: the prose-word alternation's only behavioural case, the
--     regex-metacharacter screen, the empty-alternative screen, the
--     whitespace-padded accept and the employee-scope decoy. This line and the
--     one in PART 2's header both said 164 while the ratchet at the bottom of
--     this file and scripts/certify.mjs both said 169 — corrected 2026-08-17.)
--     scripts/certify.mjs carries the same two numbers and they move in this
--     same commit, or the section goes red.
--  4. scripts/discovery-proposal-check.mjs already routes `guardrail` to
--     `guardrail_rules` in KIND_ROUTES and EXPECTED_KIND_TABLES (it was written
--     ahead of the writer, deliberately), so certify's "kinds the CHECK admits
--     that no writer routes" note drops guardrail with no edit there.
--  5. The client half — ACCEPT_WRITERS, the accept writer itself, and the two
--     card sentences that used to promise a threshold guardrail would gate an
--     approval — is in src/lib/discoveryApi.ts,
--     src/lib/discoveryProposalPresentation.ts and
--     src/pages/tenant/DiscoveryProposalsPage.tsx.
--
-- ==========================================================================
-- WHAT THIS MIGRATION DOES NOT PROVE, said before the probes rather than after
--   * that PostgREST populates request.jwt.claim.sub from a real JWT. Transport,
--     shared with every SECDEF function here, unobservable from inside SQL.
--   * the BROWSER half — that addGuardrailRule's insert succeeds under RLS from
--     a real signed-in session. Probe 15 performs the same insert as the same
--     runtime role with the same person's uid, which exercises the grant and the
--     policy; it does not exercise PostgREST.
--   * concurrency. The compare-and-swap is proven SEQUENTIALLY; a single
--     session cannot race itself.
--   * that any of the four enforcement paths actually blocks an outbound
--     message. They are Deno edge functions. What is proven here is that the
--     row this accept creates is the shape those readers select for.
-- ==========================================================================

begin;

-- ===========================================================================
-- PART 1 — THE ROUTER GAINS A `guardrail` ARM.
--
-- Replaced forward from the text migration 746 applied (read back from
-- pg_get_functiondef before editing, not from the file). Everything outside
-- the new `when 'guardrail' then` branch, its four declarations and the
-- function comment is unchanged.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.decide_discovery_proposal(p_proposal_id uuid, p_decision text, p_note text DEFAULT NULL::text, p_created_object_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ── added by 746, for the `employee` branch ──────────────────────────────
  v_arch       text;      -- the archetype key, off the payload
  v_name       text;      -- what the new employee is called, off the payload
  v_de_id      uuid;      -- what instantiate_role_archetype created
  v_kit        jsonb;     -- install_role_kit's own account of what it installed
  v_systems    integer;   -- install_role_systems' count, or 0 if it refused
  -- Everything the accept wants to be able to SAY afterwards, in one object
  -- that is merged into BOTH the return payload and the audit detail so the two
  -- can never disagree. Empty for every kind that does not fill it, so the
  -- connector branch's shape is byte-identical to what 741 returned.
  v_counters   jsonb := '{}'::jsonb;

  -- ── added by 747, for the `employee` branch ──────────────────────────────
  -- ⚠ A HIRE ATTACHES WORKSPACE-WIDE BLOCKING RULES AND SAID NOTHING. 7 of 15
  -- active archetypes carry a compliance pack; instantiate_role_archetype
  -- materialises its rules as guardrail_rules with applies_to='all',
  -- severity='blocking'. None of that reached a counter, an audit detail or a
  -- card, so a customer accepted controls they were never shown — the same
  -- §11b problem the guardrail card already solves for a single rule.
  --
  -- Measured as a BEFORE/AFTER DELTA rather than read off the archetype,
  -- because the two answer different questions: the archetype says which packs
  -- the role declares, the delta says how many rules THIS accept actually put
  -- in force. They differ whenever the workspace already had the pack, which is
  -- the common case for a second finance hire — and a card that claims two new
  -- blocking rules when it added none is the overclaim this file already
  -- refuses for guardrails and systems.
  v_pack_keys  text[];    -- what the role declares
  v_pack_before bigint;   -- active pack rules in the workspace before the hire
  v_pack_after  bigint;   -- ...and after

  -- ── added by 751, for the `guardrail` branch ─────────────────────────────
  -- The payload is exactly {rule, pattern, threshold, severity} and carries NO
  -- rule_type; these three are what the branch reads off it, and v_rule is the
  -- row the browser says it created, read back so every promise on the card can
  -- be checked against the thing that now exists rather than against the thing
  -- the caller says exists.
  v_pattern    text;      -- the literal the card showed, verbatim
  v_threshold  text;      -- the bare, unitless number — held, never written
  v_pattern_ok boolean;   -- ...is that literal one the matcher can actually use
  v_rule       public.guardrail_rules%rowtype;
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

      -- ---- employee — Path A, ONE transaction ----------------------------
      -- THE FIRST KIND THIS FUNCTION CREATES ITSELF, and it can only because
      -- all three of its ordinary writers are SQL. `p_created_object_id` is
      -- IGNORED here: there is nothing for the browser to have made first, and
      -- `authenticated` holds only SELECT on digital_employees, which is
      -- exactly why this kind cannot be Path B.
      --
      -- The human hire is three RPCs in three transactions
      -- (src/lib/hireApi.ts:104-149) and has already stranded half-hired
      -- employees. This is one.
      when 'employee' then
        v_writer     := 'instantiate_role_archetype + install_role_kit + install_role_systems, inside decide_discovery_proposal';
        v_object_tbl := 'digital_employees';

        -- Both literals are read BEFORE anything is created, and refused in
        -- words. digital_employees.name is NOT NULL with no default (read live
        -- from pg_attribute), so a payload without one would otherwise reach
        -- the customer as `23502 null value in column "name"` — a sentence
        -- about a column nobody outside this file has heard of, written onto
        -- the card by migration 740's last_error and still there tomorrow.
        v_arch := nullif(btrim(v_p.payload ->> 'archetype_key'), '');
        v_name := nullif(btrim(v_p.payload ->> 'name'), '');
        if v_arch is null then
          raise exception 'this recommendation does not say which role to hire, so there is nothing to create — it carries no archetype_key';
        end if;
        if v_name is null then
          raise exception 'this recommendation does not say what to call the new employee, and an employee has to have a name';
        end if;

        -- 1. THE HIRE. Creates the digital_employees row at
        --    designed/supervised, attaches the archetype's mandatory compliance
        --    packs and materialises its PER-EMPLOYEE autonomy dials, so a hire
        --    never widens the workspace.
        --
        --    ⚠ It does NOT set is_workforce_assistant (live body, read via
        --    pg_get_functiondef), so the column takes its default of false: a
        --    discovery accept can never stamp the workspace's own admin desk,
        --    which is what scripts/discovery-proposal-check.mjs's `excluded`
        --    resolver arm refuses on every certify.
        --    ⚠ THE PACK COUNT IS TAKEN EITHER SIDE OF THIS CALL, because
        --    instantiate_role_archetype returns only a uuid and the pack attach
        --    happens inside it. Counting `active and retired_at is null` on
        --    both sides means a pack the workspace already held contributes 0,
        --    and a pack whose rules were previously RETIRED by a detach and are
        --    revived here contributes them — which is exactly what a person
        --    needs to be told, since revived rules start blocking again.
        select count(*) into v_pack_before
          from public.guardrail_rules g
         where g.tenant_id = v_p.tenant_id
           and g.compliance_pack_key is not null
           and g.active and g.retired_at is null;
        select coalesce(a.compliance_pack_keys, '{}'::text[]) into v_pack_keys
          from public.role_archetypes a where a.key = v_arch;

        v_de_id := public.instantiate_role_archetype(
                     v_p.tenant_id, v_arch, v_name, null);
        if v_de_id is null then
          raise exception 'the hire returned no employee';
        end if;

        select count(*) into v_pack_after
          from public.guardrail_rules g
         where g.tenant_id = v_p.tenant_id
           and g.compliance_pack_key is not null
           and g.active and g.retired_at is null;

        -- 2. THE KIT — its Book of Work watchers, its published SOP and its
        --    role guardrails. DELIBERATELY UNGUARDED. This is what makes the
        --    new employee an employee rather than a row, so a failure here must
        --    take the whole accept down: the sub-block below rolls the employee
        --    back and the card returns to the deck with the reason on it.
        --    Probe 13 forces exactly that and asserts no employee is left
        --    behind — the asymmetry with step 3 is a claim, so it is driven.
        v_kit := public.install_role_kit(v_de_id, v_arch);

        -- 3. THE SYSTEMS — additive, and therefore in their OWN nested block.
        --
        --    ⚠⚠ THIS NESTING IS LOAD-BEARING, and it is not a style choice.
        --    install_role_systems opens with
        --        IF NOT coalesce(can_admin_tenant_internal(<the DE's tenant>),
        --                        false) THEN RAISE EXCEPTION 'not permitted';
        --    and can_admin_tenant_internal admits service_role or
        --    tenant_owner/tenant_admin only. Un-nested, that refusal — and
        --    every other way this step can fail — would abort the hire and undo
        --    the kit as well, for a step the product has always treated as
        --    additive. apply_role_kit_to_employee wraps it exactly this way;
        --    hireApi.ts means to and cannot, because .rpc() resolves on a
        --    Postgres error and its catch is dead code.
        --
        --    ⚠ coalesce, because a SQL function returning NULL would otherwise
        --    put a null into a counter the screen prints as a number.
        begin
          v_systems := coalesce(public.install_role_systems(v_de_id, v_arch), 0);
        exception when others then
          v_systems := 0;
        end;

        -- WHAT THE SCREEN IS ALLOWED TO SAY. A SILENT ZERO IS THE DEFECT: the
        -- existing hire wizard prints "0 connected systems" identically for
        -- "this archetype has none" and "the systems step refused", and there
        -- is no way from the outside to tell which happened. These travel in
        -- the return payload AND the audit detail, from ONE object, so the two
        -- accounts cannot drift.
        --
        -- sop_snapshot_published is here because install_role_kit already
        -- reports it honestly (false for every SOP archetype — an SOP is
        -- compiled by de-work, never run by playbook-execute) while the card
        -- asserts comes_with_published_sop unconditionally. The accept should
        -- be able to contradict the card.
        v_counters := jsonb_build_object(
          'archetype_key',          v_arch,
          -- ⚠ THREE numbers, not one, for the reason systems_installed has a
          -- sentence of its own above: "0 new blocking rules" and "this
          -- workspace has no compliance rules at all" are opposite facts and
          -- read identically as a bare zero. in_force is what tells them apart,
          -- and packs_attached names WHICH controls, since a rule the customer
          -- cannot name is a rule they cannot consent to.
          'compliance_packs_attached', to_jsonb(coalesce(v_pack_keys, '{}'::text[])),
          'compliance_rules_created',  greatest(coalesce(v_pack_after, 0) - coalesce(v_pack_before, 0), 0),
          'compliance_rules_in_force', coalesce(v_pack_after, 0),
          'systems_installed',      v_systems,
          'watchers_created',       coalesce((v_kit ->> 'watchers_created')::integer, 0),
          'watchers_skipped',       coalesce((v_kit ->> 'watchers_skipped')::integer, 0),
          'guardrails_created',     coalesce((v_kit ->> 'guardrails_created')::integer, 0),
          'sop_playbook_id',        v_kit ->> 'sop_playbook_id',
          'sop_snapshot_published', coalesce((v_kit ->> 'sop_snapshot_published')::boolean, false));

        v_object_id := v_de_id;

      -- ---- guardrail — Path B, PATTERN-BEARING ONLY ----------------------
      -- The browser already added the rule through addGuardrailRule
      -- (src/lib/guardrailApi.ts) as the signed-in human under RLS. This
      -- stamps it. It does NOT insert: `authenticated` holds INSERT on
      -- guardrail_rules and guardrail_rules_tenant_write is the policy the
      -- human path depends on — an insert here runs as postgres, bypasses that
      -- policy entirely, and is the second creation engine the plan forbids.
      --
      -- THE FOUNDER'S RULING, 2026-08-15: patterns now, thresholds held. See
      -- this migration's header for the two measured reasons; the refusals
      -- below are written in words a business owner can read, because
      -- migration 740 puts them straight onto the card and leaves them there.
      when 'guardrail' then
        v_writer     := 'addGuardrailRule -> guardrail_rules (client, under RLS), stamped here';
        v_object_tbl := 'guardrail_rules';

        -- ⚠ btrim IS NOT .trim(), AND THE DIFFERENCE LEAVES A LIVE BLOCKING
        -- RULE THAT CAN NEVER BE STAMPED. One-argument `btrim` strips SPACES
        -- and nothing else — measured: length(btrim(E'\treturn|refund')) = 14
        -- against length('return|refund') = 13, and
        -- btrim(E'refund|chargeback\n') <> 'refund|chargeback'. The client gate
        -- (discoveryProposalPresentation.ts's `str`, and guardrailAcceptability
        -- through it) uses JS `.trim()`, which strips ALL whitespace. So on a
        -- payload the model filled as "refund|chargeback\n" — applyModelFill
        -- writes the model's bytes verbatim and `pattern` is on
        -- FILL_WHITELIST.guardrail — the browser creates the rule with the
        -- TRIMMED literal, this function compares it against the UNTRIMMED one,
        -- and the verbatim check below raises 'the rule that was created blocks
        -- X, but this recommendation showed X' about two identical-looking
        -- strings. The proposal reverts to pending, attempts increments, THE
        -- RULE STAYS LIVE AND BLOCKING, and every retry re-finds it and refuses
        -- again: a permanent stuck state plus an orphan workspace-wide rule.
        -- A lone "\t" was worse still — btrim left it, so it was length 1, one
        -- whitespace-split word, no trailing punctuation, and v_pattern_ok came
        -- back TRUE: the readable refusal was skipped and a business owner was
        -- shown "…add it as the signed-in person, then pass its id here
        -- (Path B)" permanently, through migration 740's last_error.
        --
        -- The character set is EXPLICIT rather than `\s`, so it cannot move
        -- with the database's ctype, and it is the set JS `.trim()` strips:
        -- ASCII whitespace plus the Unicode space separators, the two line
        -- separators and the BOM. Verified against `.trim()` on the same
        -- battery; kept in step by the vitest drift guard, which now pins the
        -- trim as well as the four predicate clauses behind it.
        v_pattern   := nullif(btrim(v_p.payload ->> 'pattern', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_threshold := nullif(btrim(coalesce(v_p.payload ->> 'threshold', ''), E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');

        -- ⚠ THE THIRD COPY of looksLikeEnforceablePattern, and the header says
        -- why it has to be here rather than only in the two TypeScript copies:
        -- validatePayload lets a PROSE pattern sit beside a valid threshold and
        -- never nulls it out, the card correctly renders that payload as
        -- "threshold: N", and this function is the only thing that can write
        -- the reason onto the row. `pattern is not null` would have called that
        -- payload pattern-bearing and created a rule blocking on a sentence.
        --
        -- Mirrors the TS predicate line for line: non-empty, at most 120
        -- characters, does not end in sentence punctuation, at most five
        -- whitespace-separated words, and contains none of the prose words.
        -- `\y` is Postgres's word boundary — JS's `\b`.
        v_pattern_ok := v_pattern is not null
          and length(v_pattern) <= 120
          and v_pattern !~ '[.!?]$'
          and coalesce(array_length(regexp_split_to_array(v_pattern, '\s+'), 1), 0) <= 5
          and v_pattern !~* '\y(the|and|might|could|should|would|whatever|anything|something|appropriate|reasonable|seems|find|please|kindly|customer|customers)\y';

        if not v_pattern_ok then
          if v_threshold is not null then
            -- The number, said back to them, because the card showed exactly
            -- this and nothing about it says which unit it is in.
            raise exception 'this one is a bare number with no unit, so we have not switched it on: % could mean % dollars or % per cent, and those are two different rules in this workspace — one holds payments for approval, the other caps a discount. We would rather ask than guess by a factor of a hundred. Nothing was created, and it is still here waiting for you.',
              v_threshold, v_threshold, v_threshold;
          else
            raise exception 'this one has no phrase we can match on: "%" reads as a sentence rather than a literal, and a blocking rule only stops the exact words it is given. Nothing was created, and it is still here waiting for you.',
              coalesce(v_pattern, 'nothing');
          end if;
        end if;

        -- ⚠ THE CONSENTED LITERAL IS COMPILED AS A REGULAR EXPRESSION, AND
        -- NOTHING ON THE CARD SAYS SO. matchPattern
        -- (supabase/functions/_shared/guardrailMatch.ts:65-79) does
        -- `text.match(new RegExp(pattern, 'i'))` and only falls back to literal
        -- fragments when that compilation THROWS. Its own header rests the
        -- safety argument on an audit of 85 HAND-AUTHORED patterns, and money
        -- amounts and parentheticals are exactly what a "never say X" rule
        -- contains.
        --
        -- ⚠ CORRECTED. This paragraph, guardrailAcceptability's header in
        -- src/lib/discoveryProposalPresentation.ts and probe 15(e3)'s own
        -- finding all said this migration was "the FIRST path that lets a
        -- MODEL-authored literal reach that compiler". FALSE about the code,
        -- true only about the data: `approveProposal`
        -- (src/lib/governanceAiApi.ts) passes `governance_proposals.pattern` —
        -- a column the Workspace Assistant writes — straight into
        -- addGuardrailRule, and did so with NO screen of any kind: not this
        -- one, not the empty-alternative one, not even
        -- looksLikeEnforceablePattern. A human clicks Approve; the bytes are
        -- the model's. "refund|" through that door mutes every outbound message
        -- on all four enforcement paths exactly as it would through this one.
        -- `governance_proposals` holds 0 rows (measured 2026-08-17), so the
        -- door has never been used — which is why the sentence read as true.
        -- The client half of this migration therefore moves both screens onto
        -- `addGuardrailRule` itself, so a door added later gets them without
        -- anybody remembering to ask.
        --
        -- Replicated in node against the real matcher, all four passing
        -- looksLikeEnforceablePattern:
        --
        --   "$500 off"     on "we can do $500 off for you"  -> null, BLOCKS NOTHING
        --   "(free) month" on "have a (free) month"         -> null, BLOCKS NOTHING
        --   "3.5% fee"     on "our 3x5% fee applies"        -> matches, BLOCKS WIDER
        --   "refund|"      on "we will ship it tomorrow"    -> "", BLOCKS EVERYTHING
        --
        -- The last one is the worst and was not in the report: an empty
        -- alternative compiles to a regex that matches the empty string,
        -- matchPattern returns '' and findBlockingMatch tests `!== null`, so a
        -- single trailing "|" withholds EVERY outbound message on all four
        -- enforcement paths until someone finds the rule.
        --
        -- THE CHOICE, and it is a choice: SCREEN AT THE ACCEPTANCE GATE, do not
        -- touch the matcher. Changing matchPattern would change enforcement for
        -- the 85 live hand-authored rules — including the one that legitimately
        -- uses grouping — which is a different migration with a different
        -- argument. Screening here narrows only what a customer can be asked to
        -- consent to, and it narrows it to the shape where the compiled regex
        -- and a plain reading of the words agree: literal characters, with `|`
        -- between alternatives and something on both sides of every one. The
        -- card is then true as written; the alternative — leaving the gate open
        -- and rewriting the card to explain regex to a business owner — fails
        -- §11b, which is about predicting the block, not about disclosing that
        -- it is unpredictable. The same screen is in guardrailAcceptability
        -- (src/lib/discoveryProposalPresentation.ts), which is the gate the card
        -- copy and the accept writer both read, and the two are pinned against
        -- each other in tests/discovery-proposal-batching.test.ts.
        if v_pattern ~ '[\\^$.?*+(){}\[\]]' then
          raise exception 'we cannot switch this one on as written: "%" contains % — and a blocking rule is read as a search expression, so those characters mean something other than themselves and it would block something other than the words on the card. A phrase of plain words, with "|" between alternatives, is one we can promise. Nothing was created, and it is still here waiting for you.',
            v_pattern, regexp_replace(v_pattern, '[^\\^$.?*+(){}\[\]]', '', 'g');
        end if;
        if v_pattern ~ '(^\||\|\||\|$)' then
          raise exception 'we cannot switch this one on as written: "%" has a "|" with nothing beside it, and a rule written that way matches every message rather than these words — every answer this workspace sends would be withheld. Nothing was created, and it is still here waiting for you.',
            v_pattern;
        end if;

        if p_created_object_id is null then
          raise exception 'a guardrail proposal is accepted by creating the rule first: add it as the signed-in person, then pass its id here (Path B)';
        end if;

        -- The id a caller hands us is NOT its own authorisation. Read the WHOLE
        -- row back — every check below is a sentence printed on the card, and a
        -- promise nobody re-reads is a promise nobody keeps.
        select * into v_rule
          from public.guardrail_rules g
         where g.id = p_created_object_id
           and g.tenant_id = v_p.tenant_id;
        if v_rule.id is null then
          raise exception 'no guardrail rule % in this workspace — a created-object id is not its own authorisation', p_created_object_id;
        end if;

        -- blocked_phrase, of the NINE values guardrail_rules_rule_type_check
        -- admits (read live: blocked_topic, blocked_phrase,
        -- require_approval_over_cents, max_discount_pct, frustration_signal,
        -- require_computed_number, require_citation, spend_cap_daily_cents,
        -- spend_cap_monthly_cents). It is the one whose card promise is true
        -- end to end: loadBlockingRules asks guardrail_rules_for_de for
        -- ['blocked_phrase','blocked_topic'] and findBlockingMatch compiles
        -- `pattern`, so the string on the card is the string that blocks.
        if v_rule.rule_type is distinct from 'blocked_phrase' then
          raise exception 'the rule that was created is a % rule, not a blocked phrase — this recommendation was shown as words to block, and nothing else was agreed to', v_rule.rule_type;
        end if;

        -- ⚠ THE LITERAL, BYTE FOR BYTE. §11b: "the rule sentence AND its
        -- literal pattern, verbatim — you cannot consent to a block you cannot
        -- predict." The card rendered `matches: <payload.pattern>`; if the row
        -- carries anything else, the customer agreed to one block and got
        -- another, and no later reader could tell.
        if v_rule.pattern is distinct from v_pattern then
          raise exception 'the rule that was created blocks "%", but this recommendation showed "%" — a guardrail has to be the one that was agreed to, exactly', coalesce(v_rule.pattern, 'nothing'), v_pattern;
        end if;

        -- ⚠ AND IT HAS TO BE REMOVABLE. retire_guardrail_rule refuses a pack
        -- rule by name ("it belongs to a pack — detach the pack instead"), and
        -- trg_guard_compliance_guardrails blocks deactivating one. A discovery
        -- guardrail carrying a pack key would be a rule the customer accepted
        -- and then could not take off — the defect migration 747 has just
        -- finished fixing on the other side of this same table.
        if v_rule.compliance_pack_key is not null then
          raise exception 'the rule that was created belongs to the % compliance pack, and a pack rule cannot be taken off on its own — a guardrail you agreed to here has to be one you can remove here', v_rule.compliance_pack_key;
        end if;

        -- One arm, five conditions, because they are one promise: "anything
        -- matching this is blocked before it reaches a customer, FOR EVERY
        -- EMPLOYEE IN THIS WORKSPACE" (the card at
        -- discoveryProposalPresentation.ts:518 and :706, and the flash at
        -- DiscoveryProposalsPage.tsx:365, all say the second half out loud).
        --
        -- loadBlockingRules filters severity='blocking' and every reader filters
        -- `active`. ⚠ AND `scope` IS WHAT DECIDES WHO IT REACHES — NOT
        -- `applies_to`, which this arm used to test on its own. Measured live:
        -- `guardrail_rules_for_de`, the sole resolver behind loadBlockingRules
        -- and loadBlockingRulesForJudge and therefore behind all four
        -- enforcement paths, does not contain the string `applies_to` at all.
        --
        -- ⚠ CORRECTED 2026-08-17, AND THIS IS THE THIRD SITE IN THIS ONE FILE.
        -- These two lines said the resolver "admits `g.scope = 'workspace'`, or
        -- `g.scope = 'employee'` matched against the asking employee's id" — a
        -- TWO-ARM description of a FOUR-ARM predicate. The round before fixed
        -- the two other places that said the same thing and did not enumerate
        -- this one, which is the same class of error one level out. Read live
        -- from pg_get_functiondef, the scope predicate is:
        --         g.scope = 'workspace'
        --      or g.scope = 'employee'   and p_de_id is not null
        --                                and g.scope_ref = p_de_id::text
        --      or g.scope = 'department' and p_de_id is not null
        --                                and g.scope_ref = (that employee's department)
        --      or g.scope = 'playbook'   and p_playbook_def_id is not null
        --                                and g.scope_ref = p_playbook_def_id::text
        -- — so each of the three non-workspace arms ALSO needs its parameter to
        -- be non-null, which is why a department- or playbook-scoped rule can be
        -- enforced for a strictly narrower audience still.
        --
        -- Both columns default (workspace/all) so the ordinary create path lands
        -- right — but nothing here was reading the one that matters, and the
        -- client's crash-window reuse-find could hand this function an
        -- employee-scoped row on a pattern collision. In outsourcetel-hq there
        -- are 12 rows matching every filter that find applies except the
        -- pattern, all of them scope='employee'.
        if v_rule.severity is distinct from 'blocking'
           or v_rule.scope is distinct from 'workspace'
           or v_rule.applies_to is distinct from 'all'
           or not coalesce(v_rule.active, false)
           or v_rule.retired_at is not null then
          raise exception 'the rule that was created would not actually stop anything, or would not stop it for everyone — it is severity=%, scope=%, applies_to=%, active=%, retired=%. The card said this blocks the phrase for every employee in this workspace, so that is what has to exist; a rule scoped to one employee is enforced for that employee alone.',
            coalesce(v_rule.severity, 'null'), coalesce(v_rule.scope, 'null'),
            coalesce(v_rule.applies_to, 'null'),
            coalesce(v_rule.active::text, 'null'), coalesce(v_rule.retired_at::text, 'no');
        end if;

        -- What the screen and the audit line are allowed to say, from ONE
        -- object so they cannot drift. The PATTERN is in here deliberately: the
        -- row can be edited or retired afterwards and there is no version
        -- history anywhere else, so the literal the customer consented to has
        -- to outlive it — the same reasoning retire_guardrail_rule states in
        -- its own comment.
        v_counters := jsonb_build_object(
          'rule_type',           v_rule.rule_type,
          'pattern',             v_rule.pattern,
          'severity',            v_rule.severity,
          'applies_to',          v_rule.applies_to,
          'scope',               v_rule.scope,
          'compliance_pack_key', v_rule.compliance_pack_key,
          'threshold_held',      v_threshold);

        v_object_id := v_rule.id;

      -- ---- every other kind ---------------------------------------------
      -- procedure, trust_rule, conversation_type. All three are admitted by
      -- discovery_proposals_kind_check, so this refusal is the ROUTER's and
      -- nothing else's. Each ships in its own task, in risk order. A kind with
      -- no writer must say so. Probe 7 fires this for `trust_rule` and probe 14
      -- for `procedure` and `trust_rule` again, so "the router did not swing
      -- open when guardrail was added" is a comparison, not a hope.
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

  -- ⚠ `|| v_counters` on BOTH, from the SAME variable. The audit line and the
  -- answer the screen prints are then the same sentence read twice — a card
  -- saying "0 connected systems" can be checked against the audit trail rather
  -- than believed. For every kind that does not fill it, v_counters is '{}' and
  -- both shapes are byte-identical to what migration 741 returned.
  v_detail := v_detail || jsonb_build_object(
    'outcome',              'created',
    'writer',               v_writer,
    'created_object_table', v_object_tbl,   -- a bare uuid with no table name
    'created_object_id',    v_object_id)    -- is not reconstructable later
    || v_counters;

  perform public.append_audit_event(
    v_p.tenant_id, 'You', 'human', v_action, 'config_change', v_detail);

  return jsonb_build_object(
    'ok',                   true,
    'state',                'accepted',
    'proposal_id',          v_p.id,
    'created_object_table', v_object_tbl,
    'created_object_id',    v_object_id)
    || v_counters;
end;
$function$;

comment on function public.decide_discovery_proposal(uuid, text, text, uuid) is
  'Decide one discovery proposal: accepted | declined | parked. Accept is owner/admin only (tenant read off the row); decline and park are open to any member but still audited. '
  'Routes THREE kinds. ''connector'' via Path B — the browser creates the connector as the signed-in human under RLS and passes its id, which this stamps. '
  '''employee'' via Path A — this function hires it itself in ONE transaction: instantiate_role_archetype, then install_role_kit UNGUARDED, then install_role_systems inside its own sub-block so a refusal there is additive and never costs the hire. '
  '''guardrail'' via Path B, PATTERN-BEARING ONLY (migration 751, founder ruling 2026-08-15) — the browser adds the rule through addGuardrailRule under RLS and passes its id; this checks the row is a blocked_phrase rule in this tenant carrying the payload''s literal verbatim, blocking, applies_to=all, active and NOT pack-owned (a pack rule cannot be retired), then stamps it. '
  'A threshold-only guardrail is REFUSED in words the customer can read, because the payload carries a bare number with no unit while require_approval_over_cents reads CENTS and max_discount_pct reads PERCENT — and max_discount_pct has no enforcement path at all. '
  'The accept returns and audits systems_installed, watchers_created, watchers_skipped, guardrails_created and sop_snapshot_published for a hire, and rule_type/pattern/severity/applies_to/compliance_pack_key for a guardrail, because a silent zero (or a silent literal) is indistinguishable from one nobody measured. '
  'Every other kind is refused with ''kind not yet routable: <kind>'' and left pending with the reason in last_error. Returns jsonb, never a composite: callers must check error AND data.ok.';

-- ---------------------------------------------------------------------------
-- PERIMETER, restated. `create or replace` keeps the oid and therefore the ACL,
-- so this changes nothing today — it is here so the intended surface is stated
-- in the file that last touched the function rather than inherited from one
-- five migrations back. `service_role` is named in the REVOKE because
-- pg_default_acl grants it automatically on every function postgres creates in
-- `public`, and under service_role auth.uid() is null: instantiate_role_archetype
-- and install_role_kit would then SKIP their authority checks rather than fail
-- them, append_audit_event would drop its identity stamp, and decided_by would
-- be unsatisfiable. Four safety mechanisms failing open at once.
-- ---------------------------------------------------------------------------
revoke all on function public.decide_discovery_proposal(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_discovery_proposal(uuid, text, text, uuid)
  to authenticated;

-- ===========================================================================
-- PART 2 — THE STANDING CHECK GAINS A PROBE, AND ONE OLD PROBE IS REPOINTED.
--
-- Migration 746's verifier, replaced forward from the exact text that was
-- applied, with:
--   * PROBE 7 repointed from `guardrail` to `trust_rule`. This is not a tidy-up.
--     Probe 7 is the unroutable-kind probe — it asserts the refusal names the
--     kind, that the row returns to `pending` WITH its reason, that `attempts`
--     increments rather than being set, and that a twice-failed row can still
--     be accepted once its kind becomes routable. Every one of those fifteen
--     assertions is phrased against `kind not yet routable%`. Route `guardrail`
--     and the probe keeps running, keeps reporting, and compares nothing it was
--     built to compare — a check that cannot fail, arrived at by accident.
--     `trust_rule` is the replacement because contract §9 orders it LAST, so it
--     is the kind that stays unroutable longest.
--   * PROBE 15 added: the guardrail path, both halves, every pin inverted.
--   * the denominators moved from 14/138 to 15/169, and the guardrail leak
--     check added to the rollback section. (169, not 164: the review fixes
--     added five more assertions after that sentence was first written, and the
--     ratchet at the bottom of this file has said 169 ever since.)
-- Everything else — the impersonation guard, probes 1-6 and 8-14, and the
-- perimeter block — is unchanged.
--
-- ⚠ It stays SECURITY INVOKER. `set local role` raises 42501 inside a
-- security-definer body, and the impersonation is the whole point: without it
-- every probe would run as the caller, which holds EXECUTE on everything.
-- ===========================================================================

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

  -- ════ added by 746 — probes 12, 13, 14 and their baselines ══════════════
  -- ⚠ EVERY employee count in this function carries
  -- `coalesce(is_workforce_assistant, false) = false`. The standing
  -- instruction is that no Workspace Assistant row is read or written here,
  -- and count(*) touches every row it counts. The ONE place an assistant flag
  -- is read at all is v_p12_is_assistant, which reads the row THIS accept just
  -- created — the assertion the whole exclusion exists to make.
  v_d12             boolean := false;
  v_d13             boolean := false;
  v_d14             boolean := false;
  v_d15             boolean := false;

  v_emp_before      bigint;
  v_emp_after       bigint;
  v_pb_before       bigint;
  v_pb_after        bigint;
  v_gr_before       bigint;
  v_gr_after        bigint;
  v_leak_emp        bigint;
  v_leak_arch       bigint;
  -- 751: the guardrail path CREATES guardrail_rules rows, so the rollback needs
  -- a per-row leak check of its own and not just the count. The count alone
  -- would be satisfied by a probe row surviving while an unrelated row was
  -- deleted in the same window — unlikely, and exactly the kind of "unlikely"
  -- this file does not rely on anywhere else.
  v_leak_gr         bigint;

  v_arch_key        text;   -- a REAL active archetype, chosen from live data
  v_de              uuid;

  -- probe 12 — the hire happens, and happens once
  v_p12_ok          boolean;
  v_p12_state       text;
  v_p12_obj         uuid;
  v_p12_tbl         text;
  v_p12_systems     integer;
  v_p12_skipped     integer;
  v_p12_emp_pre     bigint;
  v_p12_emp_delta   bigint;
  v_p12_row_found   boolean := false;
  v_p12_is_assistant boolean;
  v_p12_arch        text;
  v_p12_life        text;
  v_p12_trust       text;
  v_p12_detail      jsonb;
  v_p12_audit_n     bigint;
  v_p12_2_ok        boolean;
  v_p12_2_error     text;
  v_p12_2_obj       uuid;
  v_p12_2_delta     bigint;

  -- probe 13 — the nested sub-block, driven in BOTH directions
  v_p13_ok          boolean;
  v_p13_state       text;
  v_p13_obj         uuid;
  v_p13_systems     integer;
  v_p13_skipped     integer;
  v_p13_detail      jsonb;
  v_p13_row_found   boolean := false;
  v_p13_sys_rows    bigint;
  v_p13_direct_raised boolean := false;
  v_p13_direct_state text;
  v_p13_kit_ok      boolean;
  v_p13_kit_state   text;
  v_p13_kit_err     text;
  v_p13_kit_obj     uuid;
  v_p13_kit_pre     bigint;
  v_p13_kit_delta   bigint;

  -- probe 14 — the router did not swing open, and a non-owner creates nothing
  v_p14_proc_ok     boolean;
  v_p14_proc_err    text;
  v_p14_proc_state  text;
  v_p14_proc_last   text;
  v_p14_trust_ok    boolean;
  v_p14_trust_err   text;
  v_p14_trust_state text;
  v_p14_trust_last  text;
  v_p14_user_refused boolean := false;
  v_p14_user_msg    text;
  v_p14_user_state  text;
  v_p14_user_last   text;
  v_p14_emp_pre     bigint;
  v_p14_emp_delta   bigint;
  v_p14_owner_ok    boolean := false;
  v_p14_owner_state text;

  -- probe 15 (751) — the guardrail path, both halves
  v_gr_rule         uuid;    -- the rule the "browser" adds, under RLS
  v_gr_rule_b       uuid;    -- a decoy: right shape, WRONG pattern
  v_gr_rule_type    uuid;    -- a decoy: right pattern, wrong rule_type
  v_gr_rule_pack    uuid;    -- a decoy: pack-owned, therefore un-retirable
  v_gr_rule_warn    uuid;    -- a decoy: severity=warning, enforces nothing
  v_gr_rule_other   uuid;    -- a real rule in ANOTHER workspace
  -- ⚠ THE DECOY THAT MAKES THE SCOPE ARM NON-VACUOUS. Right tenant, right
  -- rule_type, right pattern, right severity, active, pack-free, applies_to
  -- 'all' — i.e. it satisfies every filter the client's crash-window reuse-find
  -- applies and every check this branch made before the scope arm existed — and
  -- scope='employee'. guardrail_rules_for_de returns it for ONE employee while
  -- the card says "for every employee in this workspace". Without this row the
  -- new conjunct compares nothing: every other rule in the probe defaults to
  -- scope='workspace'.
  v_gr_rule_scope   uuid;
  v_gr_rule_ws      uuid;    -- the rule for the WHITESPACE-padded payload
  v_p15_scope_ok    boolean;
  v_p15_scope_err   text;
  v_p15_scope       text;    -- the accepted rule's own scope
  v_p15_ws_ok       boolean;
  v_p15_ws_err      text;
  v_p15_ws_state    text;
  v_p15_meta_ok     boolean;
  v_p15_meta_err    text;
  v_p15_meta_last   text;
  v_p15_alt_ok      boolean;
  v_p15_alt_err     text;
  v_p15_alt_last    text;
  v_p15_prose2_ok   boolean;
  v_p15_prose2_err  text;
  v_prop_c          uuid;
  v_p15_insert_ok   boolean := false;
  v_p15_ok          boolean;
  v_p15_state       text;
  v_p15_obj         uuid;
  v_p15_err         text;
  v_p15_lasterr     text;
  v_p15_rt          text;
  v_p15_pattern     text;
  v_p15_applies     text;
  v_p15_severity    text;
  v_p15_active      boolean;
  v_p15_pack        text;
  v_p15_detail      jsonb;
  v_p15_audit_n     bigint;
  v_p15_retire      jsonb;
  v_p15_ret_at      timestamptz;
  v_p15_ret_active  boolean;
  v_p15_again_ok    boolean;
  v_p15_again_err   text;
  v_p15_thr_ok      boolean;
  v_p15_thr_err     text;
  v_p15_thr_state   text;
  v_p15_thr_last    text;
  v_p15_thr_att     integer;
  v_p15_thr_by      uuid;
  v_p15_thr_obj     uuid;
  v_p15_thr_audit   text;
  v_p15_prose_ok    boolean;
  v_p15_prose_err   text;
  v_p15_prose_last  text;
  v_p15_nullid_ok   boolean;
  v_p15_nullid_err  text;
  v_p15_wrongpat_ok boolean;
  v_p15_wrongpat_er text;
  v_p15_wrongrt_ok  boolean;
  v_p15_wrongrt_er  text;
  v_p15_pack_ok     boolean;
  v_p15_pack_err    text;
  v_p15_warn_ok     boolean;
  v_p15_warn_err    text;
  v_p15_other_ok    boolean;
  v_p15_other_err   text;
  v_p15_user_ref    boolean := false;
  v_p15_user_msg    text;
  v_p15_user_state  text;
  v_p15_gr_pre      bigint;
  v_p15_gr_delta    bigint;

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
      'note: probes_completed=0 probes_attempted=14 assertions=0 caller=%s — impersonation unavailable, nothing was compared', v_caller));
    return array_cat(v_bad, v_notes);
  end;

  if v_seen_role is distinct from 'authenticated' then
    v_bad := array_append(v_bad, format(
      'the role switch reported current_user=%L rather than authenticated — the probes below would not be running as the runtime role they claim to test',
      coalesce(v_seen_role, 'NULL')));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=14 assertions=0 caller=%s — role switch did not take effect', v_caller));
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

  -- A REAL, ACTIVE archetype for probe 12 — chosen from live data rather than
  -- hardcoded, and chosen for three properties the probe's assertions depend
  -- on, each stated so a data change makes the arm report NO FIXTURE instead of
  -- passing on an empty set:
  --   · status='active'          instantiate_role_archetype refuses any other;
  --   · a NON-EMPTY system_templates ARRAY, so `systems_installed > 0` is a
  --     real inversion. Handed an archetype with none, install_role_systems
  --     returns 0 legitimately and "the counter travels" would be untestable;
  --   · NO compliance_pack_keys, so the hire does not materialise a workspace's
  --     compliance guardrails as a side effect of a health check. Those rows
  --     would roll back, but they take locks on shared rows and the probe has
  --     no reason to.
  --   · its SOP has DEMONSTRABLY INSTALLED at least once somewhere on this
  --     platform (a playbook_definitions row keyed `<archetype>_sop` exists).
  --     install_role_kit is unguarded by design, and `playbook_steps_guard`
  --     raises `invalid_step_shape` on a badly-formed steps array — so an
  --     archetype whose SOP has never actually been installed would make probe
  --     12 report THE INVERSION FAILED for a reason that has nothing to do with
  --     the code under test. Grounding the choice in evidence is cheaper than
  --     diagnosing that later.
  select a.key into v_arch_key
    from public.role_archetypes a
   where a.status = 'active'
     and coalesce(array_length(a.compliance_pack_keys, 1), 0) = 0
     and a.system_templates is not null
     and jsonb_typeof(a.system_templates) = 'array'
     and jsonb_array_length(a.system_templates) > 0
     and exists (select 1 from public.playbook_definitions pd
                  where pd.key = a.key || '_sop')
   order by a.key
   limit 1;

  if v_tenant is null or v_user_uid is null or v_other_admin is null
     or v_platform_uid is null or v_dim is null or v_arch_key is null then
    v_bad := array_append(v_bad, format(
      'VACUITY: this check could not assemble its fixtures — tenant=%L owner=%L non-admin member=%L second-tenant owner=%L platform profile=%L active dimension=%L active archetype with systems and no compliance packs=%L. A missing fixture is not a pass: probe 5 could not tell "refused because of the role" from "refused because there is no identity", probe 6 could not fire the cross-tenant refusal, probe 11 could not fire at all — so the platform disjunct could be put back into the role bar with everything here still green — and probes 12/13/14 could not hire anybody, which is the whole of what migration 746 added.',
      coalesce(v_tenant::text, 'NULL'), coalesce(v_admin_uid::text, 'NULL'),
      coalesce(v_user_uid::text, 'NULL'), coalesce(v_other_admin::text, 'NULL'),
      coalesce(v_platform_uid::text, 'NULL'), coalesce(v_dim, 'NULL'),
      coalesce(v_arch_key, 'NULL')));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=14 assertions=0 caller=%s — fixtures missing, nothing was compared', v_caller));
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

  -- ── added by 746. A hire writes into FOUR MORE TABLES than a connector
  -- accept does, and the rollback assertion is only worth what it covers: a
  -- baseline that stops at proposals/sessions/connectors/audit would report a
  -- clean rollback while a probe employee, its watchers' SOP and its role
  -- guardrails sat in a customer's workspace.
  --   digital_employees   — what the hire creates (ALWAYS excluding the
  --                         Workspace Assistant, see the declare block);
  --   playbook_definitions — install_role_kit UPSERTS the archetype's SOP on
  --                         (tenant_id, key), so on a workspace that already
  --                         holds that key it UPDATES a real row rather than
  --                         inserting: the count would not move even though a
  --                         row changed, which is why the rollback is asserted
  --                         by count AND by tag below;
  --   guardrail_rules     — the archetype's role guardrails.
  select count(*) into v_emp_before from public.digital_employees
   where tenant_id in (v_tenant, v_other_tenant)
     and coalesce(is_workforce_assistant, false) = false;
  select count(*) into v_pb_before from public.playbook_definitions
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_gr_before from public.guardrail_rules
   where tenant_id in (v_tenant, v_other_tenant);

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
    -- second click on the row probe 1 just accepted, so fourteen probes live in
    -- thirteen sub-blocks. Counting sub-blocks here would report 13/14 forever
    -- and teach whoever reads it that the denominator is approximate.
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
  -- 'trust_rule' is a value discovery_proposals_kind_check ACCEPTS, so the
  -- refusal can only come from the router — a refusal intercepted by an
  -- earlier constraint would prove nothing.
  --
  -- ⚠ REPOINTED BY 751, FROM 'guardrail'. This probe's fifteen assertions are
  -- all phrased against `kind not yet routable%`; the moment migration 751 gave
  -- `guardrail` a branch, every one of them would have been answering about the
  -- guardrail branch's OWN refusals (a missing pattern, a missing created id)
  -- while still reporting a probe and a clean result. That is a check that
  -- cannot fail, arrived at by accident rather than by design, and it is this
  -- repo's oldest mistake. `trust_rule` replaces it because contract §9 orders
  -- that kind LAST — it stays unroutable longer than anything else, so this
  -- probe stays a comparison for longer. Probe 14 fires the same two remaining
  -- kinds independently; the duplication is deliberate, because probe 14 asks
  -- "did the router swing open" and this one asks "does a refusal leave a
  -- readable reason and a moving counter".
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
      values (v_session, v_tenant, 'trust_rule',
              jsonb_build_object('vddp','1','de_ref','archetype:' || v_arch_key,'action_category','answer_dock','cap',80),
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
    -- not yet routable: trust_rule" at the same time, forever. This row has
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
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the routable sibling in the SAME session, decided by the SAME owner, was not accepted (state=%L). The trust_rule refusal is then not about the kind.', coalesce(v_p7_sibling_st,'NULL')));
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
  -- PROBE 12 — AN EMPLOYEE IS ACTUALLY HIRED, AND HIRED ONCE.
  --
  -- The inversion for everything migration 746 added: if this refuses, every
  -- "still refuses" assertion below is a statement about a function that
  -- refuses everything.
  --
  -- Red if: the accept refuses; or it accepts and creates nothing (accepted
  -- with a null created_object_id is the worst row this table has); or it
  -- creates MORE than one employee; or the id it stamps is not the row that
  -- exists; or the row it made is a Workspace Assistant; or the counters the
  -- screen prints are absent from the return or disagree with the audit; or a
  -- second click hires a SECOND person, which is the one failure a customer
  -- would find out about by being billed for it.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', v_arch_key,
                                 'name', 'vddp probe employee hire',
                                 'starts_supervised', true,
                                 'comes_with_published_sop', true),
              'probe: heard evidence for this dimension', v_dim, 'pending')
      returning id into v_prop;

    -- ⚠ ALWAYS EXCLUDING THE WORKSPACE ASSISTANT. count(*) touches every row
    -- it counts, and the standing instruction is that no assistant row is read
    -- here. Excluding them is also the correct denominator: the delta this
    -- measures is "employees a hire could have created", and hires never make
    -- assistants.
    select count(*) into v_p12_emp_pre from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'hire them', null);
    execute format('set local role %I', v_caller);

    v_p12_ok      := (v_res ->> 'ok')::boolean;
    v_p12_tbl     := v_res ->> 'created_object_table';
    v_p12_systems := (v_res ->> 'systems_installed')::integer;
    v_p12_skipped := (v_res ->> 'watchers_skipped')::integer;

    select state, created_object_id into v_p12_state, v_p12_obj
      from public.discovery_proposals where id = v_prop;

    select count(*) - v_p12_emp_pre into v_p12_emp_delta from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    -- THE ROW IS LOOKED UP THROUGH THE EXCLUSION, not around it — the same
    -- predicate scripts/discovery-proposal-check.mjs's resolver applies on
    -- every certify. If the accept ever stamped an assistant's id, this finds
    -- nothing and the arm below says so.
    if v_p12_obj is not null then
      select true, d.archetype_key, d.lifecycle_status, d.trust_level
        into v_p12_row_found, v_p12_arch, v_p12_life, v_p12_trust
        from public.digital_employees d
       where d.id = v_p12_obj
         and d.tenant_id = v_tenant
         and coalesce(d.is_workforce_assistant, false) = false;

      -- ...and the flag itself, read off THE ROW THIS ACCEPT JUST CREATED and
      -- nothing else. That is the one direct statement the exclusion is for,
      -- and it reads a row the probe made rather than one the workspace owns.
      select coalesce(d.is_workforce_assistant, false) into v_p12_is_assistant
        from public.digital_employees d where d.id = v_p12_obj;
    end if;

    select count(*) into v_p12_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'kind' = 'discovery_proposal_decision'
       and a.detail ->> 'proposal_id' = v_prop::text;
    select a.detail into v_p12_detail
      from public.audit_events a
     where a.tenant_id = v_tenant
       and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc, a.id desc limit 1;

    -- THE SECOND CLICK. Path A creates the object itself, so a compare-and-swap
    -- that let this through would not merely re-stamp a row — it would hire a
    -- second person, with a second SOP and a second set of watchers.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop, 'accepted', 'hire them again', null);
    execute format('set local role %I', v_caller);

    v_p12_2_ok    := (v_res2 ->> 'ok')::boolean;
    v_p12_2_error := v_res2 ->> 'error';
    select created_object_id into v_p12_2_obj from public.discovery_proposals where id = v_prop;
    select count(*) - v_p12_emp_pre into v_p12_2_delta from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    v_d12 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 12 ABORTED before it could finish (%s: %s) — the employee hire, its counters and the hire-once guard were NOT compared this run', sqlstate, sqlerrm));
      v_d12 := false;
    end if;
  end;

  if v_d12 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if not coalesce(v_p12_ok, false) then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: an owner accepting an "employee" proposal for the live archetype %L got ok=%L. Hiring a digital employee is what this whole interview exists to do, and if it refuses then every "still refuses" assertion below is a statement about a function that refuses everything.', v_arch_key, coalesce(v_p12_ok::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('the employee accept left state=%L, expected accepted', coalesce(v_p12_state, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_obj is null then
      v_bad := array_append(v_bad, 'an employee proposal reached ACCEPTED with a NULL created_object_id — the customer was told they had hired somebody and nothing records who. Zone 2 claims the row and Zone 3 stamps the id in the same transaction precisely so this state is unreachable.');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p12_emp_delta, -1) <> 1 then
      v_bad := array_append(v_bad, format('the hire changed the workspace''s employee count by %s, expected exactly 1 — a hire that creates two people, or none, is not a hire', coalesce(v_p12_emp_delta::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p12_row_found, false) then
      v_bad := array_append(v_bad, format('created_object_id %L does not name a live NON-ASSISTANT digital_employees row in this workspace. That is the exact predicate certify''s resolver applies, so this row would be reported as a dangling uuid — or, worse, the id points at a Workspace Assistant.', coalesce(v_p12_obj::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p12_is_assistant, true) then
      v_bad := array_append(v_bad, 'the employee this accept created carries is_workforce_assistant = true — a discovery proposal has claimed credit for the workspace''s own admin desk, which no writer in this path is capable of creating and which the standing instruction puts out of bounds entirely');
    end if;
    v_checks := v_checks + 1;
    if v_p12_arch is distinct from v_arch_key then
      v_bad := array_append(v_bad, format('the new employee carries archetype_key=%L, expected %L — the role the customer approved is not the role that was hired', coalesce(v_p12_arch, 'NULL'), v_arch_key));
    end if;
    v_checks := v_checks + 1;
    if v_p12_life is distinct from 'designed' or v_p12_trust is distinct from 'supervised' then
      v_bad := array_append(v_bad, format('the new employee landed at lifecycle=%L trust=%L, expected designed/supervised. §11b''s card promises "starts supervised, sends nothing"; anything else means an accept put a working employee straight into a customer''s workspace.', coalesce(v_p12_life, 'NULL'), coalesce(v_p12_trust, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_tbl is distinct from 'digital_employees' then
      v_bad := array_append(v_bad, format('the accept returned created_object_table=%L — a bare uuid with no table name cannot be reconstructed once the row is gone, and certify''s per-row resolver reads this to know which table to look in', coalesce(v_p12_tbl, 'NULL')));
    end if;
    -- THE COUNTERS. A hardcoded zero and a real zero look identical on the
    -- screen, so the number is asserted to have TRAVELLED: this archetype was
    -- chosen for a non-empty system_templates array, so systems_installed must
    -- be > 0 here. Probe 13 drives the other end, where it must be 0 because
    -- the step actually failed.
    v_checks := v_checks + 1;
    if v_p12_systems is null then
      v_bad := array_append(v_bad, 'the accept did not return systems_installed at all — the hire wizard''s "0 connected systems" is indistinguishable from "the systems step refused", and this counter is the whole repair');
    elsif v_p12_systems <= 0 then
      v_bad := array_append(v_bad, format('the accept returned systems_installed=%s for archetype %L, whose system_templates is a NON-EMPTY array (the fixture is chosen for that). Either install_role_systems refused for the accepting owner — who is tenant_owner/tenant_admin, which can_admin_tenant_internal admits — or the counter is not being read from it.', v_p12_systems::text, v_arch_key));
    end if;
    v_checks := v_checks + 1;
    if v_p12_skipped is null then
      v_bad := array_append(v_bad, 'the accept did not return watchers_skipped — install_role_kit counts the watcher templates it could not install and says so in its own return value; dropping it on the way out is how a customer gets an employee that watches nothing and a screen that never mentions it');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p12_audit_n, 0) <> 1 then
      v_bad := array_append(v_bad, format('the hire wrote %s audit row(s), expected exactly 1', coalesce(v_p12_audit_n::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_detail ->> 'writer' is distinct from 'instantiate_role_archetype + install_role_kit + install_role_systems, inside decide_discovery_proposal' then
      v_bad := array_append(v_bad, format('audit detail writer=%L — the writer name is the only evidence that the ordinary validated writers ran rather than a second creation engine inlining `insert into digital_employees`', coalesce(v_p12_detail ->> 'writer', 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_detail ->> 'created_object_table' is distinct from 'digital_employees'
       or v_p12_detail ->> 'created_object_id' is distinct from v_p12_obj::text then
      v_bad := array_append(v_bad, format('audit detail names %L/%L, the row carries %L — the audit event and the stamp are written from the same two variables in the same transaction, so a disagreement means one of them was rebuilt somewhere else', coalesce(v_p12_detail ->> 'created_object_table', 'NULL'), coalesce(v_p12_detail ->> 'created_object_id', 'NULL'), coalesce(v_p12_obj::text, 'NULL')));
    end if;
    -- The two accounts have to be ONE account. The counters go into the return
    -- and into the detail from the same jsonb object, so this can only fail if
    -- a later edit rebuilds one of them.
    v_checks := v_checks + 1;
    if (v_p12_detail ->> 'systems_installed')::integer is distinct from v_p12_systems
       or (v_p12_detail ->> 'watchers_skipped')::integer is distinct from v_p12_skipped then
      v_bad := array_append(v_bad, format('the screen was told systems=%L watchers_skipped=%L and the audit trail records systems=%L watchers_skipped=%L. A customer cannot check a card against a ledger that disagrees with it.', coalesce(v_p12_systems::text, 'NULL'), coalesce(v_p12_skipped::text, 'NULL'), coalesce(v_p12_detail ->> 'systems_installed', 'NULL'), coalesce(v_p12_detail ->> 'watchers_skipped', 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_detail -> 'payload' ->> 'archetype_key' is distinct from v_arch_key then
      v_bad := array_append(v_bad, format('the audit detail does not carry the payload VERBATIM — archetype_key reads %L. It is the only copy of the role the customer actually agreed to hire.', coalesce(v_p12_detail -> 'payload' ->> 'archetype_key', 'NULL')));
    end if;

    -- ---- HIRED ONCE ----
    v_checks := v_checks + 1;
    if coalesce(v_p12_2_ok, true) then
      v_bad := array_append(v_bad, 'a SECOND accept on an already-accepted EMPLOYEE proposal returned ok=true — on Path A that is not a re-stamp, it is a second person hired, with a second SOP, a second set of watchers and a second set of guardrails');
    end if;
    v_checks := v_checks + 1;
    if v_p12_2_error is distinct from 'already_decided' then
      v_bad := array_append(v_bad, format('the second employee accept returned error=%L, expected already_decided', coalesce(v_p12_2_error, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p12_2_obj is distinct from v_p12_obj then
      v_bad := array_append(v_bad, format('the second accept moved created_object_id from %L to %L', coalesce(v_p12_obj::text, 'NULL'), coalesce(v_p12_2_obj::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p12_2_delta, -1) <> 1 then
      v_bad := array_append(v_bad, format('after the second click the workspace holds %s more employee(s) than before the first, expected still exactly 1 — the compare-and-swap let a second hire through', coalesce(v_p12_2_delta::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 13 — THE ASYMMETRY, DRIVEN IN BOTH DIRECTIONS.
  --
  -- `install_role_systems` sits in its own nested sub-block and
  -- `install_role_kit` does not. That is a claim about which failures are
  -- additive and which are fatal, and a claim nobody fires is a comment.
  --
  --   (a) SYSTEMS FAILS -> THE HIRE SURVIVES. A probe archetype whose
  --       `system_templates` is a JSON SCALAR makes install_role_systems raise
  --       22023 `cannot extract elements from a scalar` (fired directly, at the
  --       bottom of this probe, so "it returned 0" cannot be mistaken for "it
  --       never failed"). The employee must still exist and the accept must
  --       report systems=0 rather than pretending.
  --   (b) THE KIT FAILS -> THE HIRE IS UNDONE. A second probe archetype whose
  --       `guardrail_templates` names a rule_type `guardrail_rules_rule_type_check`
  --       refuses makes install_role_kit raise 23514 from a loop it does NOT
  --       wrap. The accept must come back pending WITH a reason and, the part
  --       that matters, must leave NO employee behind — the Zone-3 sub-block
  --       has to have rolled the hire back.
  --
  -- Both archetypes are INSERTED here and rolled back with everything else.
  -- They are tagged `vddp_` and the leak check at the bottom names survivors.
  -- An INSERT is chosen over mutating a real archetype deliberately: it takes
  -- no lock on a row other workspaces are reading, and it cannot be seen by any
  -- other session because it never commits.
  --
  -- Red if: a refused systems step takes the employee down with it; or a
  -- refused KIT leaves a half-made employee in a customer's workspace with the
  -- card still saying pending; or the counters are hardcoded rather than read.
  ------------------------------------------------------------------------
  begin
    insert into public.role_archetypes
      (key, name, domain, description, status,
       system_templates, watcher_templates, sop_playbook, guardrail_templates)
    values
      ('vddp_probe_systems_fail', 'vddp probe role (systems fail)', 'Customer Success',
       'probe archetype: its systems step cannot succeed', 'active',
       -- a SCALAR, not an array -> jsonb_array_elements raises 22023
       '"not an array"'::jsonb,
       -- one watcher template work_watchers_kind_check refuses, so
       -- watchers_skipped must come back as 1 and not as a hardcoded 0
       jsonb_build_array(jsonb_build_object(
         'kind', 'vddp_not_a_watcher_kind',
         'label', 'vddp probe watcher',
         'description', 'a watcher template the kind CHECK refuses',
         'config', '{}'::jsonb)),
       null, null);

    insert into public.role_archetypes
      (key, name, domain, description, status,
       system_templates, watcher_templates, sop_playbook, guardrail_templates)
    values
      ('vddp_probe_kit_fail', 'vddp probe role (kit fail)', 'Customer Success',
       'probe archetype: its kit step cannot succeed', 'active',
       null, null, null,
       jsonb_build_array(jsonb_build_object(
         'rule', 'vddp probe guardrail',
         'rule_type', 'vddp_not_a_rule_type',
         'severity', 'blocking')));

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', 'vddp_probe_systems_fail',
                                 'name', 'vddp probe employee systems-fail'),
              'probe', v_dim, 'pending')
      returning id into v_prop;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', 'vddp_probe_kit_fail',
                                 'name', 'vddp probe employee kit-fail'),
              'probe', v_dim, 'pending')
      returning id into v_prop_b;

    -- ---- (a) the systems step refuses ----
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'systems will fail', null);
    execute format('set local role %I', v_caller);

    v_p13_ok      := (v_res ->> 'ok')::boolean;
    v_p13_systems := (v_res ->> 'systems_installed')::integer;
    v_p13_skipped := (v_res ->> 'watchers_skipped')::integer;
    select state, created_object_id into v_p13_state, v_p13_obj
      from public.discovery_proposals where id = v_prop;
    if v_p13_obj is not null then
      select true into v_p13_row_found from public.digital_employees d
       where d.id = v_p13_obj and d.tenant_id = v_tenant
         and coalesce(d.is_workforce_assistant, false) = false;
      select count(*) into v_p13_sys_rows
        from public.de_connected_systems s where s.de_id = v_p13_obj;
      v_de := v_p13_obj;
    end if;
    select a.detail into v_p13_detail
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc, a.id desc limit 1;

    -- ---- (b) the KIT refuses ----
    select count(*) into v_p13_kit_pre from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res2 := public.decide_discovery_proposal(v_prop_b, 'accepted', 'kit will fail', null);
    execute format('set local role %I', v_caller);

    v_p13_kit_ok := (v_res2 ->> 'ok')::boolean;
    select state, last_error, created_object_id
      into v_p13_kit_state, v_p13_kit_err, v_p13_kit_obj
      from public.discovery_proposals where id = v_prop_b;
    select count(*) - v_p13_kit_pre into v_p13_kit_delta from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    -- ---- THE PROOF THAT (a) WAS A REAL FAILURE ----
    -- Without this, `systems_installed = 0` is equally consistent with "the
    -- step raised and the nested block caught it" and with "the step returned 0
    -- because there was nothing to install" — and the second proves nothing at
    -- all about the nesting. Driven LAST, and after de_connected_systems has
    -- been counted, so a call that unexpectedly SUCCEEDED cannot alter what the
    -- assertions above already measured.
    begin
      perform public.install_role_systems(v_de, 'vddp_probe_systems_fail');
      v_p13_direct_raised := false;
    exception when others then
      v_p13_direct_raised := true;
      v_p13_direct_state  := sqlstate;
    end;

    v_d13 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 13 ABORTED before it could finish (%s: %s) — "a refused systems step never costs the hire" and "a refused kit always does" were NOT compared this run', sqlstate, sqlerrm));
      v_d13 := false;
    end if;
  end;

  if v_d13 then
    v_probes_done := v_probes_done + 1;

    -- (a)
    v_checks := v_checks + 1;
    if not coalesce(v_p13_direct_raised, false) then
      v_bad := array_append(v_bad, 'install_role_systems did NOT raise when handed an archetype whose system_templates is a JSON scalar. The probe therefore never forced a failure, and every assertion below about "a refused systems step" was measured against a step that did not refuse — zero findings from zero comparisons.');
    elsif v_p13_direct_state is distinct from '22023' then
      v_bad := array_append(v_bad, format('install_role_systems raised %L rather than 22023 (cannot extract elements from a scalar). It failed for some OTHER reason — most likely can_admin_tenant_internal refusing the caller — so what this probe proved is not what it claims to have proved.', coalesce(v_p13_direct_state, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p13_ok, false) or v_p13_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('A REFUSED SYSTEMS STEP COST THE HIRE (ok=%L state=%L). install_role_systems is additive — apply_role_kit_to_employee wraps it in its own sub-block for exactly this reason, and un-nesting it means a workspace whose owner is not an admin, or any other refusal there, loses the employee, its watchers, its SOP and its guardrails as well.', coalesce(v_p13_ok::text, 'NULL'), coalesce(v_p13_state, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p13_row_found, false) then
      v_bad := array_append(v_bad, format('after a refused systems step the employee %L is not there — the nested sub-block did not contain the failure', coalesce(v_p13_obj::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p13_systems, -1) <> 0 then
      v_bad := array_append(v_bad, format('after a refused systems step the accept reported systems_installed=%L, expected 0. Reporting anything else is worse than reporting nothing: the screen would tell the customer their employee can reach systems it cannot.', coalesce(v_p13_systems::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p13_sys_rows, -1) <> 0 then
      v_bad := array_append(v_bad, format('the refused systems step still left %s de_connected_systems row(s) behind', coalesce(v_p13_sys_rows::text, 'NULL')));
    end if;
    -- THE COUNTER TRAVELS. This archetype carries exactly one watcher template
    -- and work_watchers_kind_check refuses its kind, so install_role_kit's own
    -- v_skipped is 1. A hardcoded zero, or a counter read from the wrong key,
    -- fires here — and probe 12 pins the other end at a real archetype.
    v_checks := v_checks + 1;
    if coalesce(v_p13_skipped, -1) <> 1 then
      v_bad := array_append(v_bad, format('watchers_skipped came back %L after a hire whose ONE watcher template the kind CHECK refuses, expected 1. install_role_kit counts the skip in its own return value; a number that does not move is a number nobody is reading.', coalesce(v_p13_skipped::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if (v_p13_detail ->> 'systems_installed')::integer is distinct from 0
       or (v_p13_detail ->> 'watchers_skipped')::integer is distinct from 1 then
      v_bad := array_append(v_bad, format('the audit trail records systems=%L watchers_skipped=%L for a hire whose systems step refused and whose one watcher was skipped. The audit line is what a person reconstructs the hire from months later; a silent zero there is the defect this migration exists to end.', coalesce(v_p13_detail ->> 'systems_installed', 'NULL'), coalesce(v_p13_detail ->> 'watchers_skipped', 'NULL')));
    end if;

    -- (b) — the other direction
    v_checks := v_checks + 1;
    if coalesce(v_p13_kit_ok, true) then
      v_bad := array_append(v_bad, 'a hire whose install_role_kit RAISED returned ok=true — the kit is what makes an employee an employee (its watchers, its published SOP, its role guardrails), and an accept that survives without it hands the customer a row and calls it a hire');
    end if;
    v_checks := v_checks + 1;
    if v_p13_kit_state is distinct from 'pending' or v_p13_kit_err is null then
      v_bad := array_append(v_bad, format('after a refused kit the proposal is %L with last_error=%L — a failed accept must return the card to the deck WITH the reason on it, which is the whole of migration 740', coalesce(v_p13_kit_state, 'NULL'), coalesce(v_p13_kit_err, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p13_kit_obj is not null then
      v_bad := array_append(v_bad, format('a refused hire left created_object_id=%L on a pending proposal — the next retry would create a SECOND employee and the stamp would point at the first', coalesce(v_p13_kit_obj::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p13_kit_delta, -1) <> 0 then
      v_bad := array_append(v_bad, format('a refused hire left %s employee(s) behind in the workspace. instantiate_role_archetype had already run when install_role_kit raised, so the Zone-3 sub-block is what has to undo it — and it did not. The customer is left paying for a half-made employee that the card still shows as pending.', coalesce(v_p13_kit_delta::text, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 14 — THE ROUTER DID NOT SWING OPEN, AND A NON-OWNER STILL CREATES
  -- NOTHING.
  --
  -- Adding a `when 'employee'` branch to a CASE is one line away from adding
  -- three. This fires BOTH kinds the CHECK still admits and no writer routes,
  -- so "only the intended kind was opened" is a comparison rather than a
  -- reading of the diff.
  --
  -- ⚠ 751: it used to say "`guardrail` is already fired by probe 7; this fires
  -- the OTHER two". `guardrail` now routes, and probe 7 has been repointed to
  -- `trust_rule` — so this probe and probe 7 now overlap on that one kind. That
  -- overlap is kept rather than tidied: the two probes ask different questions
  -- (this one, "is the router still shut"; probe 7, "does a refusal leave a
  -- reason and move the counter"), and the day `trust_rule` ships, BOTH have to
  -- be re-pointed rather than one of them quietly going vacuous.
  --
  -- And the role bar, on the FIRST kind where passing it wrongly would create a
  -- real, billable object: probe 5 proves a tenant_user is refused a connector
  -- accept, where the object was already made by the browser. Here the RPC is
  -- the writer, so a hole in the bar means a member with no authority hires
  -- somebody.
  --
  -- Red if: procedure or trust_rule silently accept; or a refusal leaves no
  -- reason; or a tenant_user hires anyone; or the owner cannot hire on the same
  -- row, which would make the refusal a statement about the row and not the
  -- role.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp', '1', 'name', 'vddp probe procedure',
                                 'trigger', 'when a probe runs', 'steps', jsonb_build_array('do nothing')),
              'probe', v_dim, 'pending')
      returning id into v_prop;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              jsonb_build_object('vddp', '1', 'de_ref', 'archetype:' || v_arch_key,
                                 'action_category', 'answer_dock', 'cap', 80),
              'probe', v_dim, 'pending')
      returning id into v_prop_b;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', v_arch_key,
                                 'name', 'vddp probe employee role-bar'),
              'probe', v_dim, 'pending')
      returning id into v_prop_other;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'route it', null);
    execute format('set local role %I', v_caller);
    v_p14_proc_ok  := (v_res ->> 'ok')::boolean;
    v_p14_proc_err := v_res ->> 'error';
    select state, last_error into v_p14_proc_state, v_p14_proc_last
      from public.discovery_proposals where id = v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'route it', null);
    execute format('set local role %I', v_caller);
    v_p14_trust_ok  := (v_res ->> 'ok')::boolean;
    v_p14_trust_err := v_res ->> 'error';
    select state, last_error into v_p14_trust_state, v_p14_trust_last
      from public.discovery_proposals where id = v_prop_b;

    -- ---- the role bar, on a kind whose accept CREATES ----
    select count(*) into v_p14_emp_pre from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_other, 'accepted', 'can I hire?', null);
    exception when others then
      v_p14_user_refused := true;
      v_p14_user_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    select state, last_error into v_p14_user_state, v_p14_user_last
      from public.discovery_proposals where id = v_prop_other;
    select count(*) - v_p14_emp_pre into v_p14_emp_delta from public.digital_employees
     where tenant_id = v_tenant and coalesce(is_workforce_assistant, false) = false;

    -- THE INVERSION: the workspace's OWN owner, on the SAME row.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_other, 'accepted', 'the owner can', null);
    execute format('set local role %I', v_caller);
    v_p14_owner_ok := (v_res ->> 'ok')::boolean;
    select state into v_p14_owner_state from public.discovery_proposals where id = v_prop_other;

    v_d14 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 14 ABORTED before it could finish (%s: %s) — "procedure and trust_rule still refuse" and "a tenant_user cannot hire" were NOT compared this run', sqlstate, sqlerrm));
      v_d14 := false;
    end if;
  end;

  if v_d14 then
    v_probes_done := v_probes_done + 1;

    v_checks := v_checks + 1;
    if coalesce(v_p14_proc_ok, true) or coalesce(v_p14_proc_err, '') not like 'kind not yet routable%' then
      v_bad := array_append(v_bad, format('a PROCEDURE proposal was accepted (ok=%L error=%L). Its writer is the playbook-draft EDGE FUNCTION over HTTP; pg_net is fire-and-forget and no SQL function can call it and read the reply, so there is no way this kind can have gained a writer — which means the router opened by accident when employee was added.', coalesce(v_p14_proc_ok::text, 'NULL'), coalesce(v_p14_proc_err, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p14_proc_state is distinct from 'pending' or v_p14_proc_last is null then
      v_bad := array_append(v_bad, format('the refused procedure sits at %L with last_error=%L — a card that will not become a thing must say why, and still say why tomorrow', coalesce(v_p14_proc_state, 'NULL'), coalesce(v_p14_proc_last, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p14_trust_ok, true) or coalesce(v_p14_trust_err, '') not like 'kind not yet routable%' then
      v_bad := array_append(v_bad, format('a TRUST_RULE proposal was accepted (ok=%L error=%L). task-3-contract.md §7 BLOCKER 4 measured 90 trust_policies rows with 0 ladders and 0 above level 0 — accepting one today writes a policy nothing consults while the card says a human has been removed from the loop.', coalesce(v_p14_trust_ok::text, 'NULL'), coalesce(v_p14_trust_err, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p14_trust_state is distinct from 'pending' or v_p14_trust_last is null then
      v_bad := array_append(v_bad, format('the refused trust_rule sits at %L with last_error=%L', coalesce(v_p14_trust_state, 'NULL'), coalesce(v_p14_trust_last, 'NULL')));
    end if;

    v_checks := v_checks + 1;
    if not v_p14_user_refused then
      v_bad := array_append(v_bad, 'a TENANT_USER accepted an employee proposal — on Path A the RPC is the writer, so a hole in the role bar is a member with no authority putting a digital employee on the payroll');
    elsif coalesce(v_p14_user_msg, '') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but NOT by the role bar: %L. A refusal that comes from somewhere else means Zone 1 passed and something further in stopped it, which is a different guarantee with a different blast radius.', coalesce(v_p14_user_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p14_user_state is distinct from 'pending' or v_p14_user_last is not null then
      v_bad := array_append(v_bad, format('the refused tenant_user accept left state=%L last_error=%L — Zone 1 refuses BEFORE the compare-and-swap, so nothing at all should have been written', coalesce(v_p14_user_state, 'NULL'), coalesce(v_p14_user_last, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p14_emp_delta, -1) <> 0 then
      v_bad := array_append(v_bad, format('the refused tenant_user accept created %s employee(s)', coalesce(v_p14_emp_delta::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p14_owner_ok, false) or v_p14_owner_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME employee row the tenant_user was refused (ok=%L state=%L). The refusal above is then about the row, or about the kind, and says nothing about the role.', coalesce(v_p14_owner_ok::text, 'NULL'), coalesce(v_p14_owner_state, 'NULL')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 15 (751) — THE GUARDRAIL PATH, BOTH HALVES.
  --
  -- The browser half is performed HERE, as the real runtime role
  -- `authenticated` with a real owner's uid in request.jwt.claim.sub, by the
  -- same `insert into guardrail_rules` addGuardrailRule makes — so the table
  -- grant and `guardrail_rules_tenant_write` are exercised rather than assumed.
  -- (What is NOT exercised is PostgREST; that is transport, and this migration's
  -- header says so.)
  --
  -- ⚠ THE INVERSION IS FIRST, and everything else is paired against it. One
  -- accept SUCCEEDS — same owner, same workspace, same session — so "the
  -- guardrail branch refuses everything" and "the guardrail branch checks what
  -- it is handed" are distinguishable. Ten refusals follow, each differing from
  -- that success in exactly ONE respect:
  --     a payload with a number and no phrase        (the founder's ruling)
  --     a payload whose phrase is prose              (the third copy of the
  --                                                   pattern predicate is live)
  --     a good payload with no rule created first    (Path B's own shape)
  --     a rule carrying a DIFFERENT pattern          (§11b: verbatim or nothing)
  --     a rule of the wrong rule_type                (blocked_topic)
  --     a rule owned by a compliance pack            (un-retirable)
  --     a rule at severity=warning                   (enforces nothing)
  --     a rule belonging to ANOTHER workspace        (id ≠ authorisation)
  --     a tenant_user                                (the role bar)
  --     a second accept on a decided row             (the compare-and-swap)
  --
  -- ⚠ AND THE RULE IS RETIRED AFTERWARDS, by the customer's own RPC. A guardrail
  -- somebody accepted and cannot remove is the defect migration 747 has just
  -- finished fixing on the other side of this table; `compliance_pack_key is
  -- null` is the condition that makes removal possible, and asserting the column
  -- without driving retire_guardrail_rule would be asserting the reason instead
  -- of the fact.
  --
  -- Red if: a threshold guardrail is accepted; or a pattern guardrail is not; or
  -- the stamped rule is anything other than the blocking, workspace-wide,
  -- pack-free blocked_phrase rule carrying the customer's literal; or the
  -- refusals leave no reason on the row; or the function inserts a rule of its
  -- own (the delta arm).
  ------------------------------------------------------------------------
  begin
    select count(*) into v_p15_gr_pre from public.guardrail_rules where tenant_id = v_tenant;

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    -- ── THE BROWSER HALF, under RLS, as the signed-in owner ──────────────
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    insert into public.guardrail_rules
      (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_tenant, 'vddp probe — never promise a refund', 'blocked_phrase',
              'refund|chargeback', 'all', 'blocking', true)
      returning id into v_gr_rule;
    execute format('set local role %I', v_caller);
    v_p15_insert_ok := v_gr_rule is not null;

    -- ── the decoys. Inserted as the CALLER, because their only job is to be
    -- refused; provenance is not what any of them is testing. ─────────────
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_tenant, 'vddp probe — decoy, wrong pattern', 'blocked_phrase', 'discount|free month', 'all', 'blocking', true)
      returning id into v_gr_rule_b;
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_tenant, 'vddp probe — decoy, wrong rule_type', 'blocked_topic', 'refund|chargeback', 'all', 'blocking', true)
      returning id into v_gr_rule_type;
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active, compliance_pack_key)
      values (v_tenant, 'vddp probe — decoy, pack-owned', 'blocked_phrase', 'refund|chargeback', 'all', 'blocking', true, 'vddp_probe_pack')
      returning id into v_gr_rule_pack;
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_tenant, 'vddp probe — decoy, warning only', 'blocked_phrase', 'refund|chargeback', 'all', 'warning', true)
      returning id into v_gr_rule_warn;
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_other_tenant, 'vddp probe — decoy, another workspace', 'blocked_phrase', 'refund|chargeback', 'all', 'blocking', true)
      returning id into v_gr_rule_other;
    -- ⚠ THE SCOPE DECOY. applies_to='all' and scope='employee': it passes every
    -- check this branch made before the scope arm was added, and it is what the
    -- client's reuse-find would return on a pattern collision — 12 rows in
    -- outsourcetel-hq match that find's every filter except the pattern and all
    -- 12 are scope='employee'. scope_ref points at nothing in particular
    -- because guardrail_rules_for_de compares it to the ASKING employee's id;
    -- what matters is that it is not 'workspace'.
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active, scope, scope_ref)
      values (v_tenant, 'vddp probe — decoy, one employee only', 'blocked_phrase', 'refund|chargeback', 'all', 'blocking', true, 'employee', gen_random_uuid()::text)
      returning id into v_gr_rule_scope;
    -- the rule the WHITESPACE-padded payload must stamp: created with the
    -- TRIMMED literal, exactly as the browser's `str()`/.trim() would write it.
    insert into public.guardrail_rules (tenant_id, rule, rule_type, pattern, applies_to, severity, active)
      values (v_tenant, 'vddp probe — never promise a late fee waiver', 'blocked_phrase', 'late fee|penalty', 'all', 'blocking', true)
      returning id into v_gr_rule_ws;

    -- ── (a) THE INVERSION: a pattern-bearing guardrail is accepted ───────
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never promise a refund',
                                 'pattern','refund|chargeback','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'yes, block that', v_gr_rule);
    execute format('set local role %I', v_caller);

    v_p15_ok  := (v_res ->> 'ok')::boolean;
    v_p15_err := v_res ->> 'error';
    select state, created_object_id, last_error into v_p15_state, v_p15_obj, v_p15_lasterr
      from public.discovery_proposals where id = v_prop;
    select rule_type, pattern, applies_to, severity, active, compliance_pack_key, scope
      into v_p15_rt, v_p15_pattern, v_p15_applies, v_p15_severity, v_p15_active, v_p15_pack, v_p15_scope
      from public.guardrail_rules where id = v_gr_rule;
    select count(*) into v_p15_audit_n
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text;
    select a.detail into v_p15_detail
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc limit 1;

    -- ── (b) …AND THE CUSTOMER CAN TAKE IT BACK OFF ───────────────────────
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_p15_retire := public.retire_guardrail_rule(v_gr_rule, 'probe: the customer changed their mind');
    execute format('set local role %I', v_caller);
    select retired_at, active into v_p15_ret_at, v_p15_ret_active
      from public.guardrail_rules where id = v_gr_rule;

    -- ── (c) a second accept on the decided row ───────────────────────────
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'again', v_gr_rule);
    execute format('set local role %I', v_caller);
    v_p15_again_ok  := (v_res ->> 'ok')::boolean;
    v_p15_again_err := v_res ->> 'error';

    -- ── (d) THE FOUNDER'S RULING: a threshold-only payload is refused ────
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Anything over 10,000 needs my say-so',
                                 'pattern',null,'threshold','10000','severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_b;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'switch it on', null);
    execute format('set local role %I', v_caller);
    v_p15_thr_ok  := (v_res ->> 'ok')::boolean;
    v_p15_thr_err := v_res ->> 'error';
    select state, last_error, attempts, decided_by, created_object_id
      into v_p15_thr_state, v_p15_thr_last, v_p15_thr_att, v_p15_thr_by, v_p15_thr_obj
      from public.discovery_proposals where id = v_prop_b;
    select max(a.detail ->> 'outcome') into v_p15_thr_audit
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop_b::text;

    -- ── (e) a PROSE pattern, refused by the pattern predicate itself ─────
    -- ⚠ CORRECTED. This comment used to read "validatePayload admits this shape
    -- and the card renders it as a threshold". Both halves are false and were
    -- measured false: validatePayload
    -- (supabase/functions/_shared/discoveryProposals.ts:946-952) nulls a
    -- non-enforceable pattern to '' and then throws when no numeric threshold
    -- survives beside it, and guardrailKindOf returns 'none' for this payload,
    -- so the card reads "no literal recorded yet" rather than a threshold. The
    -- payload validatePayload really does admit is prose BESIDE a valid
    -- threshold, and that one reaches the THRESHOLD refusal at (d), not this
    -- one. This arm still earns its place: this branch is the only thing that
    -- can write a reason onto the row, `pattern is not null` would call this
    -- payload pattern-bearing and create a rule blocking on a sentence, and a
    -- row can reach here from before this predicate existed or from an operator
    -- insert. Deliberately carries NO threshold, so the refusal comes from the
    -- pattern predicate and not from a number beside it.
    -- ⚠ SIX WORDS, so it fails the `<= 5` arm and the prose-word alternation is
    -- never consulted. (e2) below is the ≤5-word case that gives the
    -- alternation its only behavioural coverage.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Nothing upsetting',
                                 'pattern','anything the customer might find upsetting',
                                 'threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_other;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_other, 'accepted', 'switch it on', null);
    execute format('set local role %I', v_caller);
    v_p15_prose_ok  := (v_res ->> 'ok')::boolean;
    v_p15_prose_err := v_res ->> 'error';
    select last_error into v_p15_prose_last from public.discovery_proposals where id = v_prop_other;

    -- ── (e2) THE PROSE-WORD ALTERNATION, on its own ──────────────────────
    -- "anything upsetting": two words, 18 characters, no trailing punctuation.
    -- Every other clause of the predicate passes, so the ONLY thing that can
    -- refuse it is `\y(the|and|might|…|anything|…)\y`. Without this the
    -- alternation — the one clause the vitest drift guard compares word for word
    -- against the TypeScript list — has no behavioural coverage anywhere: (e)'s
    -- six-word payload fails the `<= 5` arm first and never reaches it.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Nothing upsetting, briefly',
                                 'pattern','anything upsetting','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_c;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_c, 'accepted', 'switch it on', null);
    execute format('set local role %I', v_caller);
    v_p15_prose2_ok  := (v_res ->> 'ok')::boolean;
    v_p15_prose2_err := v_res ->> 'error';

    -- ── (e3) A REGEX METACHARACTER IN THE CONSENTED LITERAL ──────────────
    -- "$500 off" passes looksLikeEnforceablePattern in all three copies, and
    -- matchPattern compiles it: `$` is an end-of-input anchor, so the rule
    -- blocks NOTHING while the card used to say "matches: $500 off" and
    -- "anything matching this is blocked before it reaches a customer".
    -- Replicated in node against the real matcher — "$500 off" on "we can do
    -- $500 off for you" returns null. This is the arm that says the screen is
    -- live. (The card no longer says "matches:" for a screened-out literal
    -- either — guardrailLiteral now renders "phrase as written: $500 off", so
    -- the promise and its withdrawal stopped sitting side by side on one card.)
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never offer money off',
                                 'pattern','$500 off','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_c;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_c, 'accepted', 'switch it on', null);
    execute format('set local role %I', v_caller);
    v_p15_meta_ok  := (v_res ->> 'ok')::boolean;
    v_p15_meta_err := v_res ->> 'error';
    select last_error into v_p15_meta_last from public.discovery_proposals where id = v_prop_c;

    -- ── (e4) AN EMPTY ALTERNATIVE — the workspace-wide mute ───────────────
    -- "refund|" compiles to a regex with an empty branch, which matches the
    -- empty string: matchPattern returns '' and findBlockingMatch tests
    -- `!== null`, so EVERY outbound message on all four enforcement paths is
    -- withheld. It passes looksLikeEnforceablePattern — one word, no trailing
    -- sentence punctuation, no prose word — so nothing before this screen
    -- stopped it.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never promise a refund',
                                 'pattern','refund|','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_c;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_c, 'accepted', 'switch it on', null);
    execute format('set local role %I', v_caller);
    v_p15_alt_ok  := (v_res ->> 'ok')::boolean;
    v_p15_alt_err := v_res ->> 'error';
    select last_error into v_p15_alt_last from public.discovery_proposals where id = v_prop_c;

    -- ── (e5) THE TRIM, AS AN INVERSION — a padded payload must ACCEPT ────
    -- The model's bytes reach the payload verbatim (applyModelFill; `pattern` is
    -- on FILL_WHITELIST.guardrail), the browser writes the JS-`.trim()`ed
    -- literal, and this branch must arrive at the same string. With
    -- one-argument btrim it does not — btrim strips SPACES only — and the
    -- verbatim check then raises about two identical-looking strings while the
    -- rule it names STAYS LIVE AND BLOCKING. The padding here is a tab, a
    -- newline and a non-breaking space, all three of which JS `.trim()` removes
    -- and one-argument btrim does not.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never waive a late fee',
                                 'pattern', E'\t\u00a0late fee|penalty\n\u00a0','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_c;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_c, 'accepted', 'switch it on', v_gr_rule_ws);
    execute format('set local role %I', v_caller);
    v_p15_ws_ok  := (v_res ->> 'ok')::boolean;
    v_p15_ws_err := v_res ->> 'error';
    select state into v_p15_ws_state from public.discovery_proposals where id = v_prop_c;

    -- ── (f)-(k): ONE good payload, six wrong created-object ids ──────────
    -- Every one of these uses the SAME proposal shape as (a) — the only thing
    -- that differs is the id it is handed, so a refusal cannot be about the
    -- payload.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','Never promise a refund',
                                 'pattern','refund|chargeback','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'no rule made', null);
    v_p15_nullid_ok  := (v_res ->> 'ok')::boolean;
    v_p15_nullid_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'wrong pattern', v_gr_rule_b);
    v_p15_wrongpat_ok := (v_res ->> 'ok')::boolean;
    v_p15_wrongpat_er := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'wrong type', v_gr_rule_type);
    v_p15_wrongrt_ok := (v_res ->> 'ok')::boolean;
    v_p15_wrongrt_er := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'pack rule', v_gr_rule_pack);
    v_p15_pack_ok  := (v_res ->> 'ok')::boolean;
    v_p15_pack_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'warning only', v_gr_rule_warn);
    v_p15_warn_ok  := (v_res ->> 'ok')::boolean;
    v_p15_warn_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'someone else''s rule', v_gr_rule_other);
    v_p15_other_ok  := (v_res ->> 'ok')::boolean;
    v_p15_other_err := v_res ->> 'error';
    -- THE SCOPE DECOY, against the SAME good payload as every id above. It is
    -- blocking, active, pack-free, applies_to='all', right tenant, right
    -- rule_type and carries the customer's exact literal — it satisfies every
    -- other check in the branch — and guardrail_rules_for_de would return it for
    -- ONE employee.
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'one employee only', v_gr_rule_scope);
    v_p15_scope_ok  := (v_res ->> 'ok')::boolean;
    v_p15_scope_err := v_res ->> 'error';
    execute format('set local role %I', v_caller);

    -- ── (l) the role bar, and its inversion on the SAME row ──────────────
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'guardrail',
              jsonb_build_object('vddp','1','rule','No free months',
                                 'pattern','discount|free month','threshold',null,'severity','blocking'),
              'probe', v_dim, 'pending')
      returning id into v_prop_b;

    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'can I?', v_gr_rule_b);
    exception when others then
      v_p15_user_ref := true;
      v_p15_user_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);

    -- THE INVERSION, on the SAME row and with the SAME rule id: only the actor
    -- changed. v_p15_user_state is read AFTER this, so 'accepted' can only mean
    -- the owner got through where the member did not.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'the owner can', v_gr_rule_b);
    execute format('set local role %I', v_caller);
    select state into v_p15_user_state from public.discovery_proposals where id = v_prop_b;

    select count(*) - v_p15_gr_pre into v_p15_gr_delta
      from public.guardrail_rules where tenant_id = v_tenant;

    v_d15 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 15 ABORTED before it could finish (%s: %s) — the guardrail accept, the threshold refusal, the retirability of the rule it creates and the six created-object checks were NOT compared this run', sqlstate, sqlerrm));
      v_d15 := false;
    end if;
  end;

  if v_d15 then
    v_probes_done := v_probes_done + 1;

    -- (a) askability first: if the browser half could not write, nothing below
    -- is about anything.
    v_checks := v_checks + 1;
    if not v_p15_insert_ok then
      v_bad := array_append(v_bad, 'the guardrail rule could not be inserted as `authenticated` under RLS, so the whole of probe 15 is a statement about a row that does not exist. addGuardrailRule makes exactly this insert from the browser; if it fails here it fails there.');
    end if;

    v_checks := v_checks + 1;
    if not coalesce(v_p15_ok, false) or v_p15_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: a PATTERN-bearing guardrail was not accepted (ok=%L state=%L error=%L). Every refusal below is then a statement about a branch that refuses everything, which is not a gate.', coalesce(v_p15_ok::text,'NULL'), coalesce(v_p15_state,'NULL'), coalesce(v_p15_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_obj is distinct from v_gr_rule then
      v_bad := array_append(v_bad, format('the accepted guardrail stamped created_object_id=%L, expected the rule the browser made (%L)', coalesce(v_p15_obj::text,'NULL'), coalesce(v_gr_rule::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_lasterr is not null then
      v_bad := array_append(v_bad, format('a SUCCESSFUL guardrail accept left last_error=%L on the row', v_p15_lasterr));
    end if;

    -- the shape of the thing that now exists — every one of these is a
    -- sentence the card printed
    v_checks := v_checks + 1;
    if v_p15_rt is distinct from 'blocked_phrase' then
      v_bad := array_append(v_bad, format('the accepted rule is rule_type=%L, not blocked_phrase — the live CHECK admits nine values and only this one is compiled by findBlockingMatch AND shown verbatim on the card', coalesce(v_p15_rt,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_pattern is distinct from 'refund|chargeback' then
      v_bad := array_append(v_bad, format('the accepted rule blocks %L, but the card showed "refund|chargeback" — §11b: you cannot consent to a block you cannot predict', coalesce(v_p15_pattern,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_applies is distinct from 'all' or v_p15_severity is distinct from 'blocking' or not coalesce(v_p15_active,false)
       or v_p15_scope is distinct from 'workspace' then
      v_bad := array_append(v_bad, format('the accepted rule is applies_to=%L severity=%L active=%L scope=%L — loadBlockingRules keeps only severity=blocking and every reader filters active, and guardrail_rules_for_de (the sole resolver behind all four enforcement paths) admits a rule on `scope`, not on `applies_to`, which it does not read at all. Any other combination is a rule the card calls enforced for everyone and either nothing enforces or one employee gets.', coalesce(v_p15_applies,'NULL'), coalesce(v_p15_severity,'NULL'), coalesce(v_p15_active::text,'NULL'), coalesce(v_p15_scope,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_pack is not null then
      v_bad := array_append(v_bad, format('the accepted rule carries compliance_pack_key=%L — retire_guardrail_rule refuses a pack rule by name and trg_guard_compliance_guardrails blocks deactivating one, so the customer could never take off a rule they had just agreed to', v_p15_pack));
    end if;

    -- the audit line has to carry the literal, because the row can be edited
    v_checks := v_checks + 1;
    if coalesce(v_p15_audit_n,0) <> 1 then
      v_bad := array_append(v_bad, format('the guardrail accept wrote %s audit row(s) for this proposal, expected exactly 1', coalesce(v_p15_audit_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_detail ->> 'created_object_table' is distinct from 'guardrail_rules'
       or v_p15_detail ->> 'outcome' is distinct from 'created'
       or v_p15_detail ->> 'pattern' is distinct from 'refund|chargeback'
       or v_p15_detail -> 'payload' ->> 'pattern' is distinct from 'refund|chargeback' then
      v_bad := array_append(v_bad, format('the guardrail audit detail reads table=%L outcome=%L pattern=%L payload.pattern=%L. The row can be edited or retired later and there is no version history anywhere else, so the literal the customer agreed to has to outlive it — twice: once as consented (payload) and once as created (pattern).',
        coalesce(v_p15_detail ->> 'created_object_table','NULL'), coalesce(v_p15_detail ->> 'outcome','NULL'),
        coalesce(v_p15_detail ->> 'pattern','NULL'), coalesce(v_p15_detail -> 'payload' ->> 'pattern','NULL')));
    end if;

    -- (b) …and it can be taken back off
    v_checks := v_checks + 1;
    if not coalesce((v_p15_retire ->> 'ok')::boolean, false)
       or v_p15_ret_at is null or coalesce(v_p15_ret_active, true) then
      v_bad := array_append(v_bad, format('retire_guardrail_rule on the rule this accept created returned %L and left retired_at=%L active=%L. A guardrail somebody accepted and cannot remove is the defect migration 747 exists to fix; compliance_pack_key IS NULL is why this must work, and this is the arm that proves it rather than restating the reason.',
        coalesce(v_p15_retire::text,'NULL'), coalesce(v_p15_ret_at::text,'NULL'), coalesce(v_p15_ret_active::text,'NULL')));
    end if;

    -- (c) the compare-and-swap
    v_checks := v_checks + 1;
    if coalesce(v_p15_again_ok, true) or coalesce(v_p15_again_err,'') is distinct from 'already_decided' then
      v_bad := array_append(v_bad, format('a SECOND accept on the decided guardrail returned ok=%L error=%L, expected already_decided', coalesce(v_p15_again_ok::text,'NULL'), coalesce(v_p15_again_err,'NULL')));
    end if;

    -- (d) the founder's ruling
    v_checks := v_checks + 1;
    if coalesce(v_p15_thr_ok, true) or coalesce(v_p15_thr_err,'') not like '%bare number with no unit%' then
      v_bad := array_append(v_bad, format('a THRESHOLD-ONLY guardrail returned ok=%L error=%L. The payload carries a bare number with no unit while require_approval_over_cents reads CENTS and max_discount_pct reads PERCENT — accepting one is a hundred-fold guess — and max_discount_pct has no enforcement path at all. It must be refused, in words.', coalesce(v_p15_thr_ok::text,'NULL'), coalesce(v_p15_thr_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_thr_state is distinct from 'pending' or coalesce(v_p15_thr_last,'') not like '%bare number with no unit%' then
      v_bad := array_append(v_bad, format('the refused threshold guardrail sits at %L with last_error=%L — the reason has to be ON THE ROW, in the customer''s language, or a reload turns a refusal back into an undecided card', coalesce(v_p15_thr_state,'NULL'), coalesce(v_p15_thr_last,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_thr_att,-1) <> 1 or v_p15_thr_by is not null or v_p15_thr_obj is not null then
      v_bad := array_append(v_bad, format('after the threshold refusal attempts=%L decided_by=%L created_object_id=%L, expected 1/null/null', coalesce(v_p15_thr_att::text,'NULL'), coalesce(v_p15_thr_by::text,'NULL'), coalesce(v_p15_thr_obj::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_thr_audit is distinct from 'refused' then
      v_bad := array_append(v_bad, format('the threshold refusal audited outcome=%L, expected refused — a refusal nobody recorded is indistinguishable from a proposal nobody opened', coalesce(v_p15_thr_audit,'NULL')));
    end if;

    -- (e) the third copy of the pattern predicate is LIVE
    v_checks := v_checks + 1;
    if coalesce(v_p15_prose_ok, true) or coalesce(v_p15_prose_err,'') not like '%no phrase we can match on%'
       or v_p15_prose_last is null then
      v_bad := array_append(v_bad, format('a PROSE pattern was accepted, or refused for the wrong reason (ok=%L error=%L last_error=%L). This branch is the only thing that can write a reason onto the row, and if it reads `pattern is not null` it will create a rule that blocks a whole sentence — the un-consentable block §11b names. (validatePayload refuses THIS shape at emission; what it admits is prose beside a valid threshold, which lands on (d).)', coalesce(v_p15_prose_ok::text,'NULL'), coalesce(v_p15_prose_err,'NULL'), coalesce(v_p15_prose_last,'NULL')));
    end if;

    -- (e2) the prose-word alternation, the ONLY arm that can refuse a
    -- two-word prose pattern — and the only behavioural coverage the
    -- alternation has anywhere.
    v_checks := v_checks + 1;
    if coalesce(v_p15_prose2_ok, true) or coalesce(v_p15_prose2_err,'') not like '%no phrase we can match on%' then
      v_bad := array_append(v_bad, format('"anything upsetting" was accepted, or refused for the wrong reason (ok=%L error=%L). It is two words, 18 characters and ends in no sentence punctuation, so every clause of the predicate except the prose-word alternation passes it: if this arm is green for any other reason the alternation is being compared by the vitest drift guard as text and by nothing at all as behaviour.', coalesce(v_p15_prose2_ok::text,'NULL'), coalesce(v_p15_prose2_err,'NULL')));
    end if;

    -- (e3) the regex-metacharacter screen
    v_checks := v_checks + 1;
    if coalesce(v_p15_meta_ok, true) or coalesce(v_p15_meta_err,'') not like '%read as a search expression%'
       or v_p15_meta_last is null then
      v_bad := array_append(v_bad, format('"$500 off" was accepted, or refused for the wrong reason (ok=%L error=%L last_error=%L). matchPattern compiles the consented literal as a regex and only falls back to literal fragments when compilation THROWS, so "$" is an end-of-input anchor and that rule blocks NOTHING while the card promises the block. Replicated in node against the real matcher. It is NOT the only path: approveProposal (src/lib/governanceAiApi.ts) hands governance_proposals.pattern — the Workspace Assistant''s own bytes — to addGuardrailRule as well, which is why both screens now live on that writer rather than on this one caller.', coalesce(v_p15_meta_ok::text,'NULL'), coalesce(v_p15_meta_err,'NULL'), coalesce(v_p15_meta_last,'NULL')));
    end if;

    -- (e4) the empty-alternative screen — the workspace-wide mute
    v_checks := v_checks + 1;
    if coalesce(v_p15_alt_ok, true) or coalesce(v_p15_alt_err,'') not like '%with nothing beside it%'
       or v_p15_alt_last is null then
      v_bad := array_append(v_bad, format('"refund|" was accepted, or refused for the wrong reason (ok=%L error=%L last_error=%L). An empty alternative compiles to a regex matching the empty string; matchPattern returns '''' and findBlockingMatch tests `!== null`, so ONE trailing pipe withholds every outbound message on all four enforcement paths until somebody finds the rule. It passes looksLikeEnforceablePattern in all three copies.', coalesce(v_p15_alt_ok::text,'NULL'), coalesce(v_p15_alt_err,'NULL'), coalesce(v_p15_alt_last,'NULL')));
    end if;

    -- (e5) THE TRIM, AS AN INVERSION. This one must SUCCEED — a refusal here is
    -- the defect, not the proof.
    v_checks := v_checks + 1;
    if not coalesce(v_p15_ws_ok, false) or v_p15_ws_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('a WHITESPACE-PADDED payload was not accepted (ok=%L error=%L state=%L). The model''s bytes reach the payload verbatim and the browser writes the JS-.trim()ed literal, so this branch has to arrive at the same string: one-argument btrim strips SPACES ONLY (length(btrim(E''\treturn|refund'')) = 14 against 13), and the mismatch then raises the verbatim refusal about two identical-looking strings while the rule it names STAYS LIVE AND BLOCKING and every retry re-finds it. Permanent stuck state plus an orphan workspace-wide rule.', coalesce(v_p15_ws_ok::text,'NULL'), coalesce(v_p15_ws_err,'NULL'), coalesce(v_p15_ws_state,'NULL')));
    end if;

    -- (f)-(k) six wrong ids against ONE good payload
    v_checks := v_checks + 1;
    if coalesce(v_p15_nullid_ok, true) or coalesce(v_p15_nullid_err,'') not like '%creating the rule first%' then
      v_bad := array_append(v_bad, format('a guardrail accept with NO created object returned ok=%L error=%L — Path B means the browser writes first, and stamping nothing would be accepted-with-no-object, the worst state this table has', coalesce(v_p15_nullid_ok::text,'NULL'), coalesce(v_p15_nullid_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_wrongpat_ok, true) or coalesce(v_p15_wrongpat_er,'') not like '%has to be the one that was agreed to%' then
      v_bad := array_append(v_bad, format('a rule blocking a DIFFERENT phrase was stamped onto this proposal (ok=%L error=%L). The card showed one literal; anything else is a block the customer could not have predicted and no later reader could catch.', coalesce(v_p15_wrongpat_ok::text,'NULL'), coalesce(v_p15_wrongpat_er,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_wrongrt_ok, true) or coalesce(v_p15_wrongrt_er,'') not like '%not a blocked phrase%' then
      v_bad := array_append(v_bad, format('a rule of another rule_type was stamped (ok=%L error=%L)', coalesce(v_p15_wrongrt_ok::text,'NULL'), coalesce(v_p15_wrongrt_er,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_pack_ok, true) or coalesce(v_p15_pack_err,'') not like '%compliance pack%' then
      v_bad := array_append(v_bad, format('a PACK-OWNED rule was stamped onto a discovery proposal (ok=%L error=%L) — the customer would hold a rule they agreed to and cannot retire', coalesce(v_p15_pack_ok::text,'NULL'), coalesce(v_p15_pack_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_warn_ok, true) or coalesce(v_p15_warn_err,'') not like '%would not actually stop anything%' then
      v_bad := array_append(v_bad, format('a severity=warning rule was stamped (ok=%L error=%L) — loadBlockingRules keeps only severity=blocking, so the card would promise a block against a rule that logs and lets it through', coalesce(v_p15_warn_ok::text,'NULL'), coalesce(v_p15_warn_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p15_other_ok, true) or coalesce(v_p15_other_err,'') not like '%not its own authorisation%' then
      v_bad := array_append(v_bad, format('ANOTHER WORKSPACE''S guardrail id was stamped onto this workspace''s proposal (ok=%L error=%L) — a created-object id supplied by the caller is not authorisation, which is the whole of migrations 662-664', coalesce(v_p15_other_ok::text,'NULL'), coalesce(v_p15_other_err,'NULL')));
    end if;
    -- the scope decoy: the blast-radius column, which nothing checked
    v_checks := v_checks + 1;
    if coalesce(v_p15_scope_ok, true) or coalesce(v_p15_scope_err,'') not like '%scoped to one employee is enforced for that employee alone%' then
      v_bad := array_append(v_bad, format('an EMPLOYEE-SCOPED rule was stamped onto this proposal (ok=%L error=%L). It is blocking, active, pack-free, applies_to=''all'', right tenant, right rule_type and carries the customer''s exact literal, so every other check in the branch passes it — and guardrail_rules_for_de, the sole resolver behind all four enforcement paths, returns it for ONE employee while the card, the drawer and the flash all say "for every employee in this workspace". The client''s crash-window reuse-find can hand this function exactly such a row on a pattern collision: 12 rows in outsourcetel-hq match its every filter except the pattern and all 12 are scope=''employee''.', coalesce(v_p15_scope_ok::text,'NULL'), coalesce(v_p15_scope_err,'NULL')));
    end if;

    -- (l) the role bar, and its inversion
    v_checks := v_checks + 1;
    if not v_p15_user_ref then
      v_bad := array_append(v_bad, 'a TENANT_USER accepted a guardrail proposal — the accept switches on a workspace-wide blocking rule, and a member with no authority must not be able to');
    elsif coalesce(v_p15_user_msg,'') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but NOT by the role bar: %L', coalesce(v_p15_user_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p15_user_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s own OWNER could not accept the SAME guardrail row the tenant_user was refused (state after the owner''s accept=%L). The refusal above is then about the row and says nothing about the role.', coalesce(v_p15_user_state,'NULL')));
    end if;

    -- and the one that says this function did not become a second creation
    -- engine: SEVEN rules were inserted by this probe in v_tenant (the browser
    -- half, five decoys — wrong pattern, wrong rule_type, pack-owned, warning
    -- only, employee-scoped — and the rule the whitespace-padded payload
    -- stamps), plus one in v_other_tenant which this count does not see. The
    -- accept must have added none of its own.
    v_checks := v_checks + 1;
    if coalesce(v_p15_gr_delta, -1) <> 7 then
      v_bad := array_append(v_bad, format('the workspace holds %L more guardrail rule(s) than before probe 15, expected exactly the 7 the probe inserted itself. Anything more means decide_discovery_proposal inserted one — a SECOND creation engine running as postgres, outside the RLS the human path depends on.', coalesce(v_p15_gr_delta::text,'NULL')));
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

  -- ── added by 746 — the three tables a HIRE writes that a connector accept
  -- does not. Without these the rollback assertion would report clean while a
  -- probe employee, its SOP and its role guardrails sat in a real workspace.
  select count(*) into v_emp_after from public.digital_employees
   where tenant_id in (v_tenant, v_other_tenant)
     and coalesce(is_workforce_assistant, false) = false;
  select count(*) into v_pb_after from public.playbook_definitions
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_gr_after from public.guardrail_rules
   where tenant_id in (v_tenant, v_other_tenant);

  -- The exact leak checks. Every row this function creates is TAGGED — a
  -- `vddp` key in the payload, a display_name prefix on the connector, a
  -- `vddp probe employee` name, a `vddp_` archetype key — so these are immune
  -- to whatever else the platform is doing concurrently, and they name the
  -- survivor rather than only its count.
  select count(*) into v_leak_conn from public.connectors
   where display_name like 'vddp probe connector%';
  select count(*) into v_leak_prop from public.discovery_proposals
   where payload ? 'vddp';
  -- ⚠ The exclusion is on this one too. It is a leak check, not a census, and
  -- no Workspace Assistant is named 'vddp probe employee…' — but a predicate
  -- that reads assistant rows to prove they were not touched is the shape this
  -- file is not allowed to have.
  select count(*) into v_leak_emp from public.digital_employees
   where name like 'vddp probe employee%'
     and coalesce(is_workforce_assistant, false) = false;
  -- role_archetypes is GLOBAL, not tenant-scoped, so this one is unqualified
  -- on purpose: a probe archetype that survived would be offered to every
  -- workspace on the platform in the hire wizard.
  select count(*) into v_leak_arch from public.role_archetypes
   where key like 'vddp\_%';
  -- ── added by 751. Probe 15 inserts EIGHT guardrail rules, FIVE of them
  -- workspace-wide, blocking and pack-free — i.e. rules that would silently
  -- start blocking the words "refund", "chargeback", "discount", "free month",
  -- "late fee" and "penalty" in a real customer's answers if the rollback ever
  -- failed.
  --
  -- ⚠ CORRECTED 2026-08-17: this said THREE, and it undercounted the two decoys
  -- that are still enforced rules. The "wrong rule_type" decoy is
  -- `blocked_topic`, which is NOT excluded from enforcement —
  -- supabase/functions/_shared/answerGuardrails.ts:52 and guardrailJudge.ts:71
  -- both resolve `p_rule_types => ['blocked_phrase','blocked_topic']`, so it is
  -- refused by the STAMP and enforced by the READERS. The "wrong pattern" decoy
  -- carries 'discount|free month', which the phrase list also omitted. The
  -- three that genuinely would not enforce are the pack-owned one (its
  -- `compliance_pack_key` makes it a pack rule, not that it stops matching),
  -- the severity='warning' one (both loaders filter `severity === 'blocking'`)
  -- and the scope='employee' one (guardrail_rules_for_de's employee arm needs
  -- `scope_ref` to be the asking employee, and this one's is a random uuid).
  --
  -- Unqualified by tenant on purpose: seven are in v_tenant and one is in
  -- v_other_tenant, and a leak check that only looked where it expected the
  -- leak would be looking with the same assumption that produced it.
  select count(*) into v_leak_gr from public.guardrail_rules
   where rule like 'vddp probe%';

  v_checks := v_checks + 1;
  if v_prop_after <> v_prop_before or v_sess_after <> v_sess_before
     or v_conn_after <> v_conn_before or v_audit_after <> v_audit_before then
    v_bad := array_append(v_bad, format(
      'A PROBE ROLLBACK IS BROKEN AND THIS CHECK HAS LEFT TEST DATA IN PRODUCTION — discovery_proposals %s -> %s, discovery_sessions %s -> %s, connectors %s -> %s, decision audit events %s -> %s (counts scoped to tenants %s and %s). Stop running this until it is fixed: it runs on every certify.',
      v_prop_before, v_prop_after, v_sess_before, v_sess_after,
      v_conn_before, v_conn_after, v_audit_before, v_audit_after,
      v_tenant::text, v_other_tenant::text));
  end if;
  -- ── added by 746. Separate from the arm above so the message names the
  -- HIRE's tables: a person reading "employees 17 -> 18" needs to be sent to
  -- probe 12, not to the connector probes.
  v_checks := v_checks + 1;
  if v_emp_after <> v_emp_before or v_pb_after <> v_pb_before or v_gr_after <> v_gr_before then
    v_bad := array_append(v_bad, format(
      'A HIRE PROBE ROLLBACK IS BROKEN AND THIS CHECK HAS PUT A DIGITAL EMPLOYEE INTO A REAL WORKSPACE — digital_employees (excluding the Workspace Assistant) %s -> %s, playbook_definitions %s -> %s, guardrail_rules %s -> %s (counts scoped to tenants %s and %s). Stop running this until it is fixed: it runs on every certify, and each run would hire another one.',
      v_emp_before, v_emp_after, v_pb_before, v_pb_after,
      v_gr_before, v_gr_after, v_tenant::text, v_other_tenant::text));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_leak_conn, 0) <> 0 or coalesce(v_leak_prop, 0) <> 0
     or coalesce(v_leak_emp, 0) <> 0 or coalesce(v_leak_arch, 0) <> 0
     or coalesce(v_leak_gr, 0) <> 0 then
    v_bad := array_append(v_bad, format(
      'PROBE ROWS SURVIVED — %s connector(s) named "vddp probe connector…", %s discovery proposal(s) carrying the vddp payload tag, %s digital employee(s) named "vddp probe employee…", %s role archetype(s) keyed "vddp_…" and %s guardrail rule(s) named "vddp probe…" are in production. The archetype count is PLATFORM-WIDE: a surviving one appears in every workspace''s hire wizard. A surviving guardrail rule is worse than an orphan row — it is a BLOCKING, workspace-wide rule nobody agreed to, and it would start withholding real answers.',
      v_leak_conn, v_leak_prop, coalesce(v_leak_emp, 0), coalesce(v_leak_arch, 0), coalesce(v_leak_gr, 0)));
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
    'note: probes_completed=%s probes_attempted=15 assertions=%s caller=%s role=authenticated tenants=%s,%s archetype=%s — FOURTEEN accepts driven to SUCCESS so the refusals mean something (probe 1 owner+routable kind; 4 a parked proposal after a second Park was refused; 5d the owner on the row a tenant_user was refused; 6 the other tenant''s owner in their OWN workspace; 7 the routable sibling; 7e the twice-failed row once routable; 9 the row an unidentified caller was refused on; 10b the same owner with a connector that IS theirs; 11c the workspace''s own owner on the row a platform operator was refused on; 12 the employee hire itself; 13a the hire whose systems step raised 22023 and survived; 14 the owner on the employee row a tenant_user was refused; 15a a pattern-bearing guardrail, created under RLS by the owner and stamped; 15e5 the SAME accept on a whitespace-padded payload, which is the inversion that proves the trim; 15l the owner on the guardrail row a tenant_user was refused). Rows unchanged in the two probe tenants: %s proposals, %s sessions, %s connectors, %s decision audit events, %s employees (excluding the Workspace Assistant), %s playbook definitions, %s guardrail rules; %s tagged connector(s), %s tagged proposal(s), %s tagged employee(s), %s tagged archetype(s) and %s tagged guardrail rule(s) survive. NOT proven here: PostgREST''s JWT transport (the probes set request.jwt.claim.sub themselves), CONCURRENT as opposed to sequential double-click, and whether the four edge-function enforcement paths actually withhold an answer (they are Deno; what is proven is that the row this accept creates is the shape they select for).',
    v_probes_done, v_checks, v_caller, v_tenant::text, v_other_tenant::text, v_arch_key,
    v_prop_after, v_sess_after, v_conn_after, v_audit_after,
    v_emp_after, v_pb_after, v_gr_after,
    coalesce(v_leak_conn, 0), coalesce(v_leak_prop, 0),
    coalesce(v_leak_emp, 0), coalesce(v_leak_arch, 0), coalesce(v_leak_gr, 0)));

  if v_probes_done < 15 then
    v_bad := array_append(v_bad, format(
      'only %s of 15 probes completed. The ones that did not are named above with their SQLSTATE; a probe that cannot run is a failure, never a skip, because its assertions did not compare anything this run.',
      v_probes_done));
  end if;

  return array_cat(v_bad, v_notes);
end;
$function$;

comment on function public.verify_decide_discovery_proposal() is
  'Re-runnable behavioural verification of decide_discovery_proposal: migration 741''s eleven probes, plus 746''s three, plus 751''s one, made to RETURN their findings instead of raising them. '
  'Probes 1-11 cover the connector path, the compare-and-swap, the role bar, the null-uid refusal and the cross-tenant refusals; 12 hires a digital employee and proves it is hired ONCE; '
  '13 forces install_role_systems to raise 22023 and asserts the hire survived with systems=0, then forces install_role_kit to raise and asserts the employee was rolled back; '
  '14 asserts procedure and trust_rule still refuse and that a tenant_user cannot hire anybody; '
  '15 drives the whole guardrail path — the browser''s own insert under RLS, the accept, the accept again on a WHITESPACE-PADDED payload (the inversion that proves the SQL trim matches the client''s JS .trim()), the shape of the rule that now exists INCLUDING its `scope`, RETIRING it, and fourteen refusals: the founder''s threshold ruling, a six-word prose pattern, a two-word prose pattern (the prose-word alternation''s only behavioural coverage), a regex metacharacter, an empty alternative, and seven wrong created-object ids of which one is employee-scoped. '
  '⚠ PROBE 7 uses ''trust_rule'' as its admitted-but-unroutable example, NOT ''guardrail'' (751 repointed it): all fifteen of its assertions read `kind not yet routable%`, so the day guardrail gained a branch it would have kept reporting and compared nothing. Whoever ships trust_rule must repoint it again. '
  'Every probe creates fixtures, drives the RPC as the real runtime role `authenticated`, and rolls everything back by raising the sentinel ''__undo_probe__'' inside its own sub-block; '
  'variable assignments survive the subtransaction, writes do not, and the rollback is asserted against row-count baselines and per-row tags rather than trusted. '
  'Returns text[]: elements are FINDINGS, except those beginning with ''note: '', which carry the denominators (probes_completed=, assertions=). No findings and 15 probes completed is the only clean result. '
  'No digital_employees row with is_workforce_assistant = true is read or written anywhere in it: every employee count carries the exclusion, and the one flag it reads belongs to a row a probe just created. '
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
-- VERIFICATION — this migration calls the checker it just extended and
-- asserts the result is clean. Same shape as 745's own block, with the two
-- denominators moved to the new totals.
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
    raise exception '751: verify_decide_discovery_proposal() does not exist after this migration created it';
  end if;

  -- ── added by 746, kept. The employee branch must still be there: this
  -- migration rewrote the whole function body, so "I only added a branch" is a
  -- claim about a 470-line replacement and has to be checked like one.
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
       and p.prosrc like '%when ''employee'' then%'
       and p.prosrc like '%install_role_systems%') then
    v_bad := array_append(v_bad, '751: decide_discovery_proposal carries no `employee` branch calling install_role_systems — 746''s work was dropped by this replacement, and probes 12/13 would be aborting rather than failing');
  end if;

  -- ── added by 751. THE STATIC RATCHET, WITH ITS LINE COMMENTS STRIPPED AND A
  -- VACUITY GUARD, because both are load-bearing here and neither is optional.
  --
  --  · STRIPPED, and this is not hypothetical for one of the three conjuncts.
  --    `blocked_phrase` appears THREE times inside the guardrail branch's own
  --    comments (measured in the file, lines 442/443/448 of the function body),
  --    so an unstripped `prosrc like '%blocked_phrase%'` is satisfied by prose:
  --    delete the rule_type check, leave the paragraph explaining it, and the
  --    arm stays green while any of the nine rule_types can be stamped onto a
  --    card that promised a blocked phrase. Stripping every `--` line first
  --    means the arm can only be satisfied by CODE. (Measured before the edit:
  --    the live body is 23,864 characters and 10,246 with comments removed —
  --    well over half of what a naive grep would have been reading is prose.)
  --  · GUARDED. If that regexp ever ate more than it should — a `--` inside a
  --    string literal would do it — the stripped body would come back short or
  --    empty, the branch test would answer false, and this arm would report "the
  --    branch is missing" about a branch that is present. So the guard asserts
  --    the stripped body is still substantial AND still contains the `case
  --    v_p.kind` line that every branch hangs off. A ratchet that cannot tell
  --    "absent" from "unreadable" is not a ratchet.
  --  · AND EACH CONJUNCT IS PINNED TO A STRING THAT EXISTS ONLY IN THE BRANCH IT
  --    CLAIMS TO CHECK. ⚠ THIS ARM SHIPPED WITH ONE THAT WAS ALREADY TRUE.
  --    Measured against the LIVE 747 body, before this migration ran: stripped
  --    length 10,246; `when 'guardrail' then` false; `blocked_phrase` false;
  --    `compliance_pack_key is not null` TRUE — satisfied by the EMPLOYEE
  --    branch's two pack-count queries, which have nothing to do with this
  --    refusal. So deleting the guardrail pack refusal would have left the arm
  --    green while its own message claimed it had verified "refusing a
  --    pack-owned rule". The strip and the vacuity guard were both right; the
  --    defect was a duplicate string. Every pin below is now a fragment of the
  --    guardrail branch's OWN refusal message or its own comparison, and each is
  --    reported separately so the finding names which one went missing rather
  --    than making a reader diff a 470-line body to find out.
  v_checks := v_checks + 1;
  declare
    v_src     text;
    v_missing text[] := '{}';
  begin
    select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';

    if v_src is null or length(v_src) < 4000 or v_src not like '%case v_p.kind%' then
      v_bad := array_append(v_bad, format('751: the comment-stripped body of decide_discovery_proposal came back %s characters long and %s the `case v_p.kind` dispatch. The ratchet below cannot tell a missing branch from an unreadable body, so it is refusing to answer rather than guessing.',
        coalesce(length(v_src)::text, 'NULL'),
        case when coalesce(v_src,'') like '%case v_p.kind%' then 'contains' else 'does NOT contain' end));
    else
      -- the branch itself
      if v_src not like '%when ''guardrail'' then%' then
        v_missing := array_append(v_missing, 'the `when ''guardrail'' then` branch');
      end if;
      -- the rule_type refusal — its own sentence, not the bare token
      -- `blocked_phrase`, which 746's body and this file's prose both carry
      if v_src not like '%not a blocked phrase%' then
        v_missing := array_append(v_missing, 'the rule_type refusal (its message reads "not a blocked phrase")');
      end if;
      -- the pack refusal — its own sentence. NOT `compliance_pack_key is not
      -- null`, which the employee branch's pack counting already satisfies.
      if v_src not like '%belongs to the % compliance pack%' then
        v_missing := array_append(v_missing, 'the pack-owned refusal (its message reads "belongs to the … compliance pack")');
      end if;
      -- the blast-radius check. `applies_to` alone was never the one that
      -- decides who a rule reaches; guardrail_rules_for_de gates on `scope`.
      if v_src not like '%v_rule.scope is distinct from ''workspace''%' then
        v_missing := array_append(v_missing, 'the scope check (`v_rule.scope is distinct from ''workspace''`), without which an employee-scoped rule is stamped and the card still says "for every employee in this workspace"');
      end if;
      -- the metacharacter screen — its own sentence
      if v_src not like '%read as a search expression%' then
        v_missing := array_append(v_missing, 'the regex-metacharacter screen (its message reads "read as a search expression")');
      end if;
      -- the empty-alternative screen — its own sentence
      if v_src not like '%with nothing beside it%' then
        v_missing := array_append(v_missing, 'the empty-alternative screen (its message reads: a "|" with nothing beside it), without which one trailing pipe withholds every outbound message in the workspace');
      end if;
      -- the trim, by its second argument. The vitest drift guard pins WHICH
      -- characters; this only says the one-argument btrim did not come back.
      if v_src not like '%payload ->> ''pattern'', E''%' then
        v_missing := array_append(v_missing, 'the explicit whitespace set on the pattern trim (one-argument btrim strips spaces only, and the client uses JS .trim())');
      end if;

      if coalesce(array_length(v_missing, 1), 0) > 0 then
        v_bad := array_append(v_bad, format('751: decide_discovery_proposal''s CODE (comments stripped, %s characters) is missing %s of the guardrail branch''s load-bearing parts: %s. Probe 15 would be aborting or answering about something else rather than failing.',
          length(v_src), array_length(v_missing, 1), array_to_string(v_missing, '; ')));
      end if;
    end if;
  end;

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
  if coalesce(v_probes, 0) <> 15 then
    v_bad := array_append(v_bad, format('the function reported probes_completed=%L, expected 15. Zero findings from zero probes looks exactly like a clean result, which is the whole reason this number is printed.', coalesce(v_probes::text, 'ABSENT')));
  end if;

  -- ⚠ NOT a pinned constant. Pinning the assertion count would go red every
  -- time a probe legitimately gains a check, and someone would then edit the
  -- pin rather than read it. What must never happen is the number collapsing,
  -- which is what a silently-skipped probe looks like.
  v_checks := v_checks + 1;
  if coalesce(v_asserts, 0) < 169 then
    v_bad := array_append(v_bad, format('the function compared only %L assertion(s). 741 carried 95, 745 carried 98, 746 carried 138, and this carries 169 (26 added by probe 15 and the guardrail leak arm, then 5 more by the review fixes: the prose-word alternation''s only behavioural case, the regex-metacharacter screen, the empty-alternative screen, the whitespace-padded accept and the employee-scope decoy); a collapse means probes are being skipped rather than run. scripts/certify.mjs carries the same floor and must move with it.', coalesce(v_asserts::text, 'ABSENT')));
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
  -- silently reduce fourteen probes to zero.
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
    raise exception '751: % of % assertion(s) failed: %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '751: a hard line the customer wrote — verify_decide_discovery_proposal() returned CLEAN on its first run after the guardrail branch landed: % probe(s) completed, % assertion(s) compared, 0 findings, and % assertion(s) about the migration and the verifier itself passed. %',
    v_probes, v_asserts, v_checks, coalesce(v_notes[1], '(no note)');
end $$;

commit;
