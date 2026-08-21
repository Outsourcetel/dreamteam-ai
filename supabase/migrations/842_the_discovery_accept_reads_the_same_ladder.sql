-- 842_the_discovery_accept_reads_the_same_ladder.sql
-- ============================================================================
-- Fix round 1, IMPORTANT 2, for migration 838 (plan: 2026-08-21-trust-promotion).
--
-- WHY: 838 gave "what a trust step grants" a SECOND source. A role archetype can
-- declare a ladder, and every reader resolves it through effective_trust_ladder
-- -- the policy's own ladder is the override, the role's declaration the default
-- beneath it. The declaration is read through the employee's archetype at read
-- time and is NEVER copied onto the policy, so a policy that inherits its role's
-- ladder still has trust_policies.ladder IS NULL.
--
-- decide_discovery_proposal (mig 760) has two guards that ask "has somebody
-- already set out what each level of trust means?" by testing that raw column.
-- After 838 both UNDER-FIRE on exactly the case they exist to refuse: a role
-- declaration IS somebody having set out what each level means, the accept
-- proceeds, and it records a stated cap beside it -- producing the "two
-- different limits recorded and no way to tell which one you meant" state the
-- first guard's own error message describes.
--
-- ⚠ BOTH GUARDS, NOT ONE, AND THE SECOND IS THE ONE THAT MATTERS MOST.
-- The first (the pre-seed check) is written `v_tr_pol.id is not null and ...`,
-- so it never fires when the policy does not exist yet -- and the accept's
-- ordinary path is to CREATE the policy through seed_de_trust_policy. The
-- second (the post-seed "nothing changes today" check) is therefore the only
-- one reachable in the common case, and it is the one whose message would have
-- said "no limits set" about an employee whose role had just declared them.
-- Fixing only the guard named in the review would have left the usual path open.
-- The audit key `ladder_written` at the end of that branch stays FALSE and is
-- untouched: it means "this accept wrote a ladder", which is still true, and the
-- branch is now unreachable for a role-inheriting policy anyway.
--
-- ── WHY THIS IS ITS OWN MIGRATION AND NOT PART OF 838 ──────────────────────
-- decide_discovery_proposal is 113,683 characters. CREATE OR REPLACE needs the
-- whole body, and folding it into 838 -- already 125KB and mid-review -- would
-- bury a three-line change in another subsystem's function. Migration 760 ships
-- this function the same way (596KB), so the shape is the repo's own.
--
-- The cost of splitting is a window in which 838 is applied and this is not, and
-- the guards under-fire. That window is bounded by the PRECONDITION below --
-- this file refuses unless effective_trust_ladder exists, so it can never be
-- applied BEFORE 838 -- and the exposure inside it is governance and
-- consent-record, not authority: nothing about what an employee may DO changes,
-- only what the accept records beside it. Apply them together.
--
-- ── ⚠ THE STALE-SNAPSHOT GUARD ────────────────────────────────────────────
-- Same hazard, same answer as 838, and 838's own guard FIRED on its first dry
-- run when a parallel session applied 837 underneath it. The body below is a
-- snapshot taken 2026-08-21; the precheck hashes the live body (line comments
-- stripped, whitespace collapsed, so CRLF and LF checkouts hash alike) and
-- refuses on anything it was not written against. Both the pre- and post- body
-- are accepted so a re-apply and a replay stay green. SQLSTATE 55000 is
-- deliberate: the function exists, so 42883 would lie, and this is not an
-- assertion about rows the environment lacks, so P0001 would make
-- audit-migration-replayability accuse this file of a defect it does not have.
--
-- The body was produced by SPLICING the live pg_get_functiondef output through a
-- script that refuses unless each anchor matches exactly once, and the diff was
-- read before pasting: THREE hunks in 1,744 lines -- the pre-seed guard, the
-- post-seed guard, and the message beside it. Nothing else was retyped.
-- CREATE OR REPLACE, never DROP + CREATE: the function is owned by postgres and
-- carries its existing grants, and only OR REPLACE preserves both.
--
-- ⚠ EVERY GENERATED REPLACEMENT IN THAT SCRIPT USES A FUNCTION REPLACER.
-- JavaScript's String.replace expands $', $& and $` inside a STRING replacement.
-- While writing 838 that silently spliced the tail of a file into the middle of
-- a function body, because the text being inserted contained '^[a-z0-9_:.-]+$'.
-- It was caught by an unbalanced dollar-quote count, not by review.
--
-- ── NEVER HARDCODE A DEPARTMENT ────────────────────────────────────────────
-- No role name, archetype key or department string appears in any executable
-- statement. The change replaces one column read with one function call, and
-- that function branches on nothing but the policy's own columns and whatever
-- category the caller already carries. Probe fixtures are prefixed
-- 'zz_probe_842_' and live inside a subtransaction that is deliberately rolled
-- back, so they leave no row behind.
-- ============================================================================

begin;

-- ── preconditions: 838 first, then the stale-snapshot hash ──────────────────
do $precheck$
declare
  v_ddp text;
  -- PRE  = the body this migration expects to FIND (measured on production
  --        2026-08-21, installed by migration 760).
  -- POST = the body it INSTALLS, accepted too so a re-apply or a replay that
  --        reaches this file twice stays green rather than refusing on this
  --        migration's own work.
  c_ddp_pre  constant text := '4d16de59e9f28733e3d8777eea99a9a0';
  c_ddp_post constant text := '28120b5e46b3e565e64a737f570e328f';
begin
  -- ORDERING, ENFORCED RATHER THAN DOCUMENTED. Without 838 there is no
  -- effective_trust_ladder, the body below would raise 42883 on every accept of
  -- a trust_rule proposal, and this file would have made the product worse in
  -- exchange for closing a governance gap that does not exist yet.
  if to_regprocedure('public.effective_trust_ladder(public.trust_policies)') is null then
    raise exception 'PRECONDITION FAILED: public.effective_trust_ladder(public.trust_policies) does not exist -- migration 838 has not been applied. Apply 838 first: this file exists only because 838 gave the ladder a second source, and without it the guards below would raise 42883 on every trust_rule accept.'
      using errcode = 'undefined_function';
  end if;

  select md5(btrim(regexp_replace(
           regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')))
    into v_ddp
    from pg_proc
   where proname = 'decide_discovery_proposal' and pronamespace = 'public'::regnamespace;

  if v_ddp is null then
    raise exception 'PRECONDITION FAILED: public.decide_discovery_proposal(uuid,text,text,uuid) does not exist -- migration 760 has not been applied. This file replaces that function; without it there is nothing to replace.'
      using errcode = 'undefined_function';
  end if;

  if v_ddp not in (c_ddp_pre, c_ddp_post) then
    raise exception E'PRECONDITION FAILED: decide_discovery_proposal has a body this migration was not written against.\n  found    %\n  expected % (the body migration 760 installs, as measured on production 2026-08-21)\n  or       % (the body this file installs, so a re-apply is not refused)\nA parallel session changed it. Applying now would SILENTLY OVERWRITE that change: the body below is a snapshot of 1,744 lines, not a merge, and it is the single largest accept path in this product. Re-diff pg_get_functiondef against the CREATE OR REPLACE in this file, fold in whatever is missing, and update c_ddp_pre to the hash you just measured.',
      v_ddp, c_ddp_pre, c_ddp_post
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$precheck$;

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

  -- ── added by 752, for the `procedure` branch ─────────────────────────────
  -- The payload is {name, trigger, steps, evidence, note} — FILL_WHITELIST
  -- .procedure is ['name','trigger','steps'], so those three are the model's
  -- and the rest is the emitter's. These four are what the branch reads off it.
  --
  -- v_sop is the SOP TEXT COMPOSED FROM THEM: byte for byte the string the
  -- browser sent the drafter, and the thing the `playbook_studies` check
  -- compares against. It is this kind's consented literal, the way `pattern` is
  -- the guardrail's — §11b's "you cannot consent to what you cannot predict"
  -- applied to a procedure is the name, the trigger and the steps the card
  -- showed.
  --
  -- v_pb_key is DERIVED FROM THE PROPOSAL ID, and that is the whole
  -- anti-duplication mechanism: one proposal, one key, UNIQUE (tenant_id, key).
  -- v_def is the draft the caller says came back, read WHOLE, because a promise
  -- nobody re-reads is a promise nobody keeps.
  -- ⚠ v_proc_name IS THE COMPARED VALUE AND v_proc_label IS THE PRINTED ONE,
  -- and they are two variables on purpose. `last_error` is written as
  -- `left(v_err, 500)`, the bound 741 chose and every kind shares; the
  -- provenance refusal below is 326 characters before the name goes in, so a
  -- name over 174 characters cut the closing sentence off the card — the one
  -- that tells the customer the draft exists, runs nothing, and can be archived.
  -- Nothing caps the name: not `validatePayload` at emission, not
  -- `procedureAcceptability` in the browser, and not the column (both `name`
  -- and `last_error` are unbounded `text`).
  --
  -- Of the three fixes, capping the name is the only one that BOUNDS the
  -- message. Raising 500 moves the cliff without removing it — a 4,000-character
  -- name truncates at any bound — and it changes a field all six kinds write for
  -- the sake of one. Shortening the sentence removes the thing the sentence is
  -- for. Capping the name makes every refusal in this branch fit whatever the
  -- customer typed, and the name is the one part already on the card in front of
  -- them. 140 + an ellipsis is the widest cap the tightest message admits: the
  -- name-mismatch refusal prints TWO names against a 216-character base, so
  -- 216 + 2 x 141 = 498.
  --
  -- ⚠ v_proc_label MUST NEVER REACH `v_sop` OR THE `v_def.name` COMPARISON. The
  -- SOP text is compared BYTE FOR BYTE against what the drafter recorded, and
  -- the name is compared byte for byte against the row; a truncated value in
  -- either would refuse a perfectly correct draft, permanently.
  v_proc_name  text;      -- what the procedure is called, off the payload
  v_proc_label text;      -- ...the same name, capped, for MESSAGES ONLY
  v_def_label  text;      -- ...and the row's own name, capped the same way
  v_proc_trig  text;      -- when it runs, in the customer's own words
  v_proc_steps text[];    -- the prose steps, trimmed, blanks dropped
  v_sop        text;      -- the composed SOP text — the consented literal
  v_pb_key     text;      -- 'discovery_' || the proposal id, dashes removed
  v_def        public.playbook_definitions%rowtype;
  v_study_ok   boolean;   -- ...was this draft compiled from THAT sop text

  -- ── added by 753, for the `trust_rule` branch ────────────────────────────
  -- The payload is {de_ref, action_category, cap, above_cap, evidence} —
  -- FILL_WHITELIST.trust_rule is ['de_ref','action_category','cap','above_cap'],
  -- so those four are the model's and `evidence` is the emitter's.
  --
  -- ⚠ THERE IS NO v_ladder VARIABLE HERE AND THAT IS THE WHOLE DESIGN. This
  -- branch NEVER writes `trust_policies.ladder`, never calls set_trust_ladder
  -- and never calls trust_apply_level. See the header's three measured reasons;
  -- the shortest is that `cap` carries no unit and `max_amount_cents` is CENTS,
  -- so writing it would be the same factor-of-a-hundred guess the founder
  -- already refused for guardrail thresholds on 2026-08-15.
  v_tr_ref     text;      -- "archetype:<key>", off the payload
  v_tr_arch    text;      -- ...the key on its own
  v_tr_cat     text;      -- the action category, off the payload
  v_tr_cap_raw text;      -- the cap exactly as the payload carries it
  v_tr_cap_n   text;      -- ...normalised the way isNumericLiteral normalises
  v_tr_above   text;      -- "what happens above it", the customer's words
  v_tr_unit    text;      -- 'confidence' or 'amount' — set_trust_ladder's split
  v_tr_de      uuid;      -- the employee, resolved from an ACCEPTED sibling
  v_tr_emp     text;      -- ...its name, for the messages
  v_tr_pol     public.trust_policies%rowtype;
  v_tr_seeded  boolean := false;  -- did THIS accept open the setting
  v_tr_dials   bigint;    -- de_autonomy rows for this exact scope, counted

  -- ── added by 754, for the `conversation_type` branch ────────────────────
  -- The payload is {label, set_category, match_pattern, examples, evidence} —
  -- FILL_WHITELIST.conversation_type is ['label','set_category','match_pattern'],
  -- so those three are the model's and the rest is the emitter's. All three are
  -- COMPARED byte for byte against the row the browser created, which is why
  -- they are trimmed with 751's explicit set rather than one-argument btrim.
  --
  -- v_ct_ties and v_ct_ahead are COUNTED, never claimed. classify_support_text
  -- walks the rules `ORDER BY rule_order, created_at` and returns on the FIRST
  -- match, so where a rule sits IS the routing decision — and a tie is broken by
  -- a timestamp no screen shows.
  v_ct_label   text;      -- what the topic is called, off the payload
  v_ct_cat     text;      -- the token written into de_conversations.category
  v_ct_pattern text;      -- the pipe-separated literal phrases, verbatim
  v_ct_ties    bigint;    -- other active rules sharing its position
  v_ct_ahead   bigint;    -- active rules consulted BEFORE it
  v_ct_rule    public.support_triage_rules%rowtype;
  -- ⚠ 760. THE OWNER, and it is resolved the way 753 resolves a trust rule's
  -- de_ref rather than the way every other Path B kind resolves an object id:
  -- `owner_ref` is "archetype:<key>", never an employee id, because at the
  -- moment the interview writes the card that employee DOES NOT EXIST YET. The
  -- id it means is the one an ACCEPTED employee proposal IN THIS SAME SESSION
  -- created, so "you cannot own a topic until you have been hired" is enforced
  -- here in SQL and not only by the browser.
  v_ct_own_ref  text;     -- "archetype:<key>", off the payload, or NULL
  v_ct_own_arch text;     -- ...the key on its own
  v_ct_owner    uuid;     -- the employee it resolves to, or NULL for "nobody"
  v_ct_own_name text;     -- ...their name, for the card and the audit line
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

      -- ---- procedure — Path B, AND THE WRITER IS AN EDGE FUNCTION ---------
      -- The browser already drafted it through `draftPlaybookFromSop`
      -- (src/lib/playbookBuilderApi.ts) over the `playbook-draft` edge
      -- function, and then stamped the deterministic key and the agreed name
      -- onto the row it got back. This verifies and links it.
      --
      -- It does NOT draft: `net.http_post` returns a request id, the request is
      -- not dispatched until COMMIT and the reply arrives later in
      -- `net._http_response`, so a SQL function cannot call the drafter and read
      -- what it made. See this migration's header — that is a mechanical
      -- impossibility, not a preference, and it is a stronger reason for Path B
      -- than connector's or guardrail's.
      when 'procedure' then
        v_writer     := 'draftPlaybookFromSop -> playbook-draft edge function (service-role inside), key+name stamped by the browser under RLS, verified here';
        v_object_tbl := 'playbook_definitions';

        -- ⚠ THE SAME EXPLICIT WHITESPACE SET AS 751'S PATTERN TRIM, and for the
        -- same measured reason: one-argument `btrim` strips SPACES ONLY, while
        -- the client composes with JS `.trim()`, which strips all of it. Here
        -- the consequence is sharper than a mismatched literal — every one of
        -- these three fields goes into `v_sop`, and `v_sop` is compared BYTE FOR
        -- BYTE against what the drafter was given. A single stray tab on either
        -- side and the provenance check refuses a draft that is perfectly
        -- correct, permanently, while the draft sits in the workspace.
        v_proc_name := nullif(btrim(v_p.payload ->> 'name',    E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_proc_trig := nullif(btrim(v_p.payload ->> 'trigger', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        -- `jsonb_typeof` first: `jsonb_array_elements_text` RAISES on a non-array,
        -- and a payload whose `steps` is a bare string would then reach the
        -- customer as `22023 cannot extract elements from a scalar` — a sentence
        -- about a jsonb function, written onto the card by 740's last_error and
        -- still there tomorrow. Empty and whitespace-only entries are dropped
        -- rather than kept, exactly as the client's composer drops them.
        v_proc_steps := case when jsonb_typeof(v_p.payload -> 'steps') = 'array' then
            array(select btrim(s, E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
                    from jsonb_array_elements_text(v_p.payload -> 'steps') s
                   where nullif(btrim(s, E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '') is not null)
          else '{}'::text[] end;

        -- The three literals validatePayload already requires at emission, read
        -- again HERE because this function is the only thing that can write a
        -- reason onto the row — and because a row can reach this line from
        -- before that validator existed, or from an operator insert.
        if v_proc_name is null then
          raise exception 'this recommendation does not say what the procedure is called, so there is nothing to draft it as. Nothing was created, and it is still here waiting for you.';
        end if;
        -- THE PRINTED FORM, computed once, used by every message below and by
        -- nothing else. See its declaration for why the compared value stays
        -- whole and why the cap is 140.
        v_proc_label := case when length(v_proc_name) > 140
                             then left(v_proc_name, 140) || '…' else v_proc_name end;
        if v_proc_trig is null then
          raise exception 'this recommendation does not say when "%" should run, and a procedure nobody can say the starting point for is not one anybody can review. Nothing was created, and it is still here waiting for you.', v_proc_label;
        end if;
        if coalesce(array_length(v_proc_steps, 1), 0) = 0 then
          raise exception 'this recommendation has no steps written down for "%", so there is nothing to draft from. Nothing was created, and it is still here waiting for you.', v_proc_label;
        end if;

        -- ⚠ THE CONSENTED LITERAL, COMPOSED. This is the exact string the
        -- browser sends to the drafter, and the `playbook_studies` check at the
        -- bottom of this branch compares it byte for byte against what the
        -- drafter recorded it was given. It is the procedure's answer to §11b:
        -- the guardrail's consented literal is its pattern, and this one's is
        -- the name, the trigger and the steps the card showed.
        --
        -- Kept deliberately dull — three fixed labels, one bullet per step, no
        -- conditional shape — because it exists twice (here and
        -- `sopTextForProcedure` in src/lib/discoveryProposalPresentation.ts) and
        -- every branch in it is a way for the two to disagree. The vitest drift
        -- guard pins this composer's shape and its trim set against the
        -- TypeScript one.
        v_sop := v_proc_name || E'\n\n'
              || 'Runs when: ' || v_proc_trig || E'\n\n'
              || 'Steps:' || E'\n'
              || array_to_string(array(select '- ' || x from unnest(v_proc_steps) x), E'\n');

        -- The drafter's own floor, restated so the refusal is a sentence rather
        -- than an HTTP 400 the browser has to translate:
        --   playbook-draft/index.ts:364
        --   if (!recompileDefId && sopText.length < 40) return json({ error: 'sop_text required …' }, 400)
        -- The client checks it first and drafts nothing, so reaching this line
        -- means the client's copy drifted looser — the SAFE direction, and this
        -- is what catches it.
        if length(v_sop) < 40 then
          raise exception 'there is not enough written down here to draft from — what was recorded for "%" comes to % characters, and the drafter needs at least 40 before it can turn a description into steps. A sentence or two more about what happens, and when, is enough. Nothing was created, and it is still here waiting for you.',
            v_proc_label, length(v_sop);
        end if;

        -- ⚠ THE DETERMINISTIC KEY. One proposal, one procedure. The browser
        -- stamps this onto the row the drafter made, UNIQUE (tenant_id, key)
        -- makes a second one impossible, and refusing any other key below is
        -- what makes a retry re-use the first draft rather than mint a twin.
        -- The dashes come out so the key stays inside the [a-z0-9_] shape every
        -- other key in this table uses.
        v_pb_key := 'discovery_' || replace(v_p.id::text, '-', '');

        if p_created_object_id is null then
          raise exception 'a procedure is drafted first and linked second: nothing was drafted for "%", so there is nothing to link here. Nothing was created, and it is still here waiting for you.', v_proc_label;
        end if;

        -- The id a caller hands us is NOT its own authorisation. Read the WHOLE
        -- row back — every check below is a sentence printed on the card.
        select * into v_def
          from public.playbook_definitions d
         where d.id = p_created_object_id
           and d.tenant_id = v_p.tenant_id;
        if v_def.id is null then
          raise exception 'no draft procedure % in this workspace — a created-object id is not its own authorisation', p_created_object_id;
        end if;
        -- The row's own name is capped for printing too, and for the same
        -- reason: the browser writes it and nothing bounds what it writes.
        v_def_label := case when length(v_def.name) > 140
                            then left(v_def.name, 140) || '…' else v_def.name end;

        -- ⚠ THE ANTI-DUPLICATION PIN. Everything else in this branch is about
        -- whether the draft is the right SHAPE; this one is about whether it is
        -- THE one this recommendation drafted. A draft under any other key is
        -- either somebody else's procedure or a second copy of this one, and
        -- stamping it would make "accept twice, get one procedure" false.
        if v_def.key is distinct from v_pb_key then
          raise exception 'the draft that came back is filed as "%", and the draft for this recommendation is filed as "%" — accepting this would have left you with two copies of the same procedure instead of re-using the first, so nothing was linked. It is still here waiting for you.',
            coalesce(v_def.key, 'nothing'), v_pb_key;
        end if;

        -- ⚠ THE NAME, BYTE FOR BYTE, AND THE DRAFTER DOES NOT DO THIS ON ITS
        -- OWN. playbook-draft:622 takes `compiled.name` — the COMPILING model's
        -- own title — and only falls back to what it was asked for. The card
        -- read `Draft the "<name>" procedure`; a draft that came out called
        -- something else is a procedure the customer did not agree to by the one
        -- handle they were given for it. The browser re-stamps the name in the
        -- same update as the key; this refuses a row where it did not take.
        if v_def.name is distinct from v_proc_name then
          raise exception 'the draft that came back is called "%", but this recommendation was for "%" — a procedure has to be the one that was agreed to, by the name it was agreed under. Nothing was linked, and it is still here waiting for you.',
            coalesce(v_def_label, 'nothing'), v_proc_label;
        end if;

        -- ⚠ THE CARD'S CENTRAL PROMISE: "This becomes a draft — nothing runs
        -- until you publish it." Every path that RUNS a definition filters on
        -- `published` — eight gates across five callers, enumerated in this
        -- migration's header (playbook-execute:2428, :655 and :2952,
        -- de-work:215, de-mission:108, dispatch_due_triggers twice, and
        -- emit_tenant_event) — so
        -- `draft` is not a detail of this row — it is the entire reason this
        -- kind can be accepted at all before the customer has read a single
        -- step. An archived row is refused by the same arm, which is what makes
        -- probe 16's removal drive mean something.
        if v_def.status is distinct from 'draft' then
          raise exception 'the draft that came back is %, not a draft. The card said this becomes a draft and runs nothing until you publish it, so a draft is what has to exist. Nothing was linked, and it is still here waiting for you.',
            coalesce(v_def.status, 'null');
        end if;

        -- ⚠ TWO ENGINES, ONE TABLE. `kind` is DERIVED from the steps by trigger
        -- (playbook_definitions_set_kind -> playbook_definition_kind, which
        -- answers 'sop' iff any step carries kind='use_tool'), so it cannot
        -- drift from what the row holds. An 'sop' row is compiled into work
        -- items by de-work, not run by playbook-execute; the card describes the
        -- one you publish and run.
        if v_def.kind is distinct from 'procedure' then
          raise exception 'the draft that came back is a standing instruction rather than a procedure that runs — a different part of the workforce reads that kind, and it is not what this card described. Nothing was linked, and it is still here waiting for you.';
        end if;

        -- ⚠ AND IT IS NOBODY'S WORK YET. de-work and de-mission both select on
        -- `de_id`, so a draft already assigned to an employee is one publish away
        -- from becoming that employee's queue. The card offered a draft for the
        -- customer to read, not work handed to somebody.
        if v_def.de_id is not null then
          raise exception 'the draft that came back is already assigned to one of your digital employees. This card offered you a draft to read over first, not work handed to somebody, so that is not what was agreed to. Nothing was linked, and it is still here waiting for you.';
        end if;

        -- An empty draft is nothing a person can review, approve or decline —
        -- validatePayload's own words for refusing an empty `steps` at emission.
        if coalesce(case when jsonb_typeof(v_def.steps) = 'array'
                         then jsonb_array_length(v_def.steps) else 0 end, 0) = 0 then
          raise exception 'the draft for "%" came back with no steps in it, so there is nothing for you to read over or publish. Nothing was linked, and it is still here waiting for you.', v_proc_label;
        end if;

        -- ⚠ PROVENANCE, AND WITHOUT IT THE TWO CHECKS ABOVE ARE WORTHLESS.
        -- `key` and `name` are both written by the BROWSER. A function that
        -- verified only those would be verifying the caller's own claims — "a
        -- created-object id is not its own authorisation" turned into "an id
        -- plus two strings the caller chose is". `playbook_studies.sop_text` is
        -- written by the drafter's own service-role client from the text it was
        -- handed (playbook-draft:632, upserted on `definition_id`, which carries
        -- a UNIQUE index), and `authenticated` holds SELECT and nothing else on
        -- that table — so it is the one field on this path the browser cannot
        -- choose. Byte-identical to the composed text, or this draft was not
        -- made from what the customer described.
        --
        -- ⚠ AND THE HONEST LIMIT: playbook-draft does not check that upsert's
        -- error (`await admin.from('playbook_studies').upsert(…)`, result
        -- discarded), so a draft CAN come back from a 200 with no study row.
        -- That would make this arm unsatisfiable and the proposal permanently
        -- stuck — the milder version of 751's stuck guardrail, with an inert
        -- draft instead of a live blocking rule. It is stated rather than fixed,
        -- and the evidence that it is rare is a DATE, not a key shape: six live
        -- rows carry the `<slug>_<random6>` shape and only three carry a study,
        -- but the other three predate playbook-draft's existence entirely —
        -- connector-hub's `dt_draft_playbook` mints the same shape and writes no
        -- study. Of the rows created since the study writer shipped, 3 of 3
        -- carry one, and the unique index the upsert needs exists. The header
        -- has the measurement. The refusal below says what to do about the draft
        -- either way, because a customer should never have to infer that from
        -- silence.
        select exists (
          select 1 from public.playbook_studies s
           where s.definition_id = v_def.id
             and s.tenant_id     = v_p.tenant_id
             and s.sop_text      = v_sop
        ) into v_study_ok;
        if not coalesce(v_study_ok, false) then
          raise exception 'we could not confirm that this draft was written from what you described for "%", so we have not linked it to this recommendation. The draft is on your Playbooks screen — it is a draft, so it runs nothing — and you can read it there and archive it if it is not what you meant. This recommendation is still here waiting for you.', v_proc_label;
        end if;

        -- What the screen and the audit line are allowed to say, from ONE object
        -- so they cannot drift. The composed SOP TEXT is deliberately NOT in
        -- here — it is already in `payload`, which the audit detail carries
        -- whole and verbatim — but its length is, because "we drafted from 40
        -- characters" and "we drafted from 4,000" are different facts about the
        -- same accept. `steps_drafted` is the drafter's count, not the payload's:
        -- the customer described N things and the compiler emitted M, and a card
        -- that showed only N would hide the compile.
        v_counters := jsonb_build_object(
          'playbook_key',      v_def.key,
          'playbook_name',     v_def.name,
          'playbook_status',   v_def.status,
          'playbook_kind',     v_def.kind,
          'assigned_to_de',    v_def.de_id,
          'steps_described',   coalesce(array_length(v_proc_steps, 1), 0),
          'steps_drafted',     case when jsonb_typeof(v_def.steps) = 'array'
                                    then jsonb_array_length(v_def.steps) else 0 end,
          'sop_chars',         length(v_sop),
          'trigger_described', v_proc_trig);

        v_object_id := v_def.id;

      -- ---- trust_rule — PATH A, AND IT DELIBERATELY WRITES NO LIMIT --------
      -- THE ONLY PROPOSAL THAT REMOVES A HUMAN FROM A LOOP (§11b), and the one
      -- this function is allowed to make the LEAST of. Everything the other
      -- four kinds accept ADDS a capability; this one subtracts oversight. So
      -- the accept does the smallest true thing: it opens the trust setting the
      -- customer's sentence was about, at level 0, where it already effectively
      -- sat — and records the limit they stated as CONSENT DATA rather than as
      -- configuration.
      --
      -- PATH A, and the argument is NOT "SQL can reach the writer". Path B
      -- exists in 741/751/752 because those kinds' ordinary writers are a
      -- PostgREST insert under RLS (connector, guardrail) or an edge function
      -- (procedure): duplicating them inside a SECURITY DEFINER body would
      -- bypass an RLS policy the human path depends on, which is contract
      -- §8.3's second creation engine. HERE THERE IS NO SUCH POLICY TO BYPASS.
      -- Measured live: `authenticated` holds SELECT on public.trust_policies
      -- and nothing else — no INSERT, no UPDATE, no DELETE — so there is no
      -- PostgREST write path at all and no browser half to preserve. The
      -- ordinary writer IS a SECURITY DEFINER RPC (`seed_de_trust_policy`),
      -- calling it from here is calling THE engine from one more place, and it
      -- re-checks the caller itself: auth.uid() and auth_tenant_id() read the
      -- request GUC, which SECURITY DEFINER does not change, so its own bar
      -- (owner/admin/manager plus can_access_de) fires against the real human
      -- exactly as it does from the browser. 746's employee branch already
      -- rests on the same fact.
      --
      -- ⚠ AND PATH A REMOVES THIS KIND'S VERSION OF THE 751/752 TRAP. Those two
      -- have an asymmetric drift invariant — the client must be at least as
      -- strict as this function, always — because the browser has already
      -- created a live blocking rule (751) or an inert draft (752) by the time
      -- the refusal lands. Here the browser writes NOTHING before calling, so
      -- BOTH drift directions are safe: a stricter SQL copy refuses a card and
      -- leaves the workspace exactly as it was. That is why the THREE checks
      -- below that the client does not have (a negative cap; a confidence cap
      -- above 100; a capability that is not on this employee's surface) can be
      -- added without the stuck-state risk 752's header spends four paragraphs
      -- on.
      when 'trust_rule' then
        v_writer     := 'seed_de_trust_policy, inside decide_discovery_proposal — NO ladder is written and no dial is applied, so the stated limit is recorded and nothing this employee does changes';
        v_object_tbl := 'trust_policies';

        -- ⚠ THE SAME EXPLICIT WHITESPACE SET 751 ESTABLISHED. One-argument
        -- `btrim` strips SPACES ONLY; the client's `str()` uses JS `.trim()`,
        -- which strips all of it. `de_ref` and `action_category` are both
        -- COMPARED against other stored values below, and `cap` is normalised
        -- by a regex whose anchors a stray tab would defeat.
        v_tr_ref     := nullif(btrim(v_p.payload ->> 'de_ref',          E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_tr_cat     := nullif(btrim(v_p.payload ->> 'action_category', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_tr_cap_raw := nullif(btrim(coalesce(v_p.payload ->> 'cap', ''), E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_tr_above   := nullif(btrim(coalesce(v_p.payload ->> 'above_cap', ''), E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');

        if v_tr_ref is null then
          raise exception 'this recommendation does not say which of your digital employees it is about, and a limit that names nobody is not something anyone can agree to. Nothing was changed, and it is still here waiting for you.';
        end if;
        if v_tr_cat is null then
          raise exception 'this recommendation does not say what kind of work the limit is for, so there is nothing to record it against. Nothing was changed, and it is still here waiting for you.';
        end if;

        -- ⚠ THE CAP, AND `isNumericLiteral` MIRRORED CHARACTER FOR CHARACTER.
        -- supabase/functions/_shared/discoveryProposals.ts:485 strips a LEADING
        -- '$', ALL commas and a TRAILING '%' and then tests
        -- /^-?\d+(\.\d+)?$/. Restated here because a payload can reach this
        -- line from before that validator existed, or from an operator insert,
        -- and because this function is the only thing that can write a reason
        -- onto the row (migration 740).
        --
        -- ⚠ 0 IS A VALID CAP and this is deliberately not a truthiness test —
        -- that module's own comment says so. A NEGATIVE cap is refused, and
        -- that check is STRICTER THAN THE CLIENT'S: validatePayload admits
        -- "-500". On Path A a stricter server is safe (see the branch header),
        -- and "act on its own up to minus five hundred dollars" is not a
        -- sentence a person can consent to.
        v_tr_cap_n := regexp_replace(
                        regexp_replace(
                          regexp_replace(coalesce(v_tr_cap_raw, ''), '^\$', ''),
                          ',', '', 'g'),
                        '%$', '');
        if v_tr_cap_raw is null or v_tr_cap_n !~ '^-?\d+(\.\d+)?$' then
          raise exception 'this recommendation does not carry a limit we can read — what was recorded was "%". This is the one recommendation that would let an employee act without asking you, so a number is the whole of the decision and we will not guess one. Nothing was changed, and it is still here waiting for you.',
            coalesce(v_tr_cap_raw, 'nothing');
        end if;
        if v_tr_cap_n::numeric < 0 then
          raise exception 'the limit on this recommendation is %, and a limit below zero is not something we can write down as an agreement. Nothing was changed, and it is still here waiting for you.',
            v_tr_cap_n;
        end if;

        -- WHICH UNIT THE NUMBER IS IN, taken from the SAME split
        -- set_trust_ladder uses (`v_uses_conf := action_category in
        -- ('answer_dock','answer_widget')`, read live) and from the client's
        -- own formatCap, which reads that split too. It is recorded beside the
        -- number rather than folded into it: a bare cap with no unit is exactly
        -- what the founder refused for guardrail thresholds, and a later reader
        -- of this audit row must not have to re-derive it.
        v_tr_unit := case when v_tr_cat in ('answer_dock', 'answer_widget')
                          then 'confidence' else 'amount' end;

        -- ⚠ AND A CONFIDENCE CAP IS RANGE-CHECKED. AN AMOUNT IS NOT, AND THE
        -- ASYMMETRY IS THE POINT. For 'amount' there is no bound to check
        -- against — the payload carries no currency and no scale, which is the
        -- whole reason no ladder is written — so any non-negative number is a
        -- number a person could have meant. For 'confidence' there IS a bound,
        -- and it is not invented here: `validate_trust_ladder`, the one
        -- validator every ladder in this database passes through, requires
        -- min_confidence to be between 0 and 100 (read live). Restating it here
        -- is the same move this branch already makes for `isNumericLiteral` and
        -- for set_trust_ladder's unit split.
        --
        -- Without it, the accept would record stated_cap "500" beside
        -- stated_cap_unit "confidence": consent to 500% confidence. INERT TODAY,
        -- and that is exactly the reason it matters — `stated_cap` is written
        -- nowhere else, and the header's whole provenance argument is that a
        -- FUTURE enforcement layer is meant to find it and read it. "Act on its
        -- own above 500% confidence" is not a sentence a person can agree to,
        -- which is the argument the negative-amount refusal above already makes.
        --
        -- ⚠ STRICTER THAN THE CLIENT, a third time, and safe for the same Path A
        -- reason: formatCap renders "500% confidence" without complaint and
        -- validatePayload has no range at all, but nothing is written before
        -- this line, so a refusal leaves the workspace exactly as it was.
        --
        -- ⚠ ONLY THE RANGE, NOT THE WHOLE-NUMBER RULE. validate_trust_ladder
        -- also demands an integer; this deliberately does not, because "60.5%
        -- confidence" is a thing a person can mean and consent to, and refusing
        -- it would be refusing a coherent answer to protect a field this accept
        -- does not write. The range is checked because only the range makes the
        -- recorded sentence impossible.
        -- ⚠ Upper bound only: a cap below zero was already refused above, in ANY
        -- unit, so a `< 0` arm here could never fire and would be one more
        -- comparison that cannot fail.
        if v_tr_unit = 'confidence' and v_tr_cap_n::numeric > 100 then
          raise exception 'this recommendation records a confidence limit of %, and confidence runs from 0 to 100 — so there is no setting this could ever mean, and we will not write it down as something you agreed to. Nothing was changed, and it is still here waiting for you.',
            v_tr_cap_n;
        end if;

        -- ⚠ THE EMPLOYEE IS RESOLVED FROM THE SESSION, NEVER FROM THE CALLER.
        -- Every other Path B kind has to answer "an id is not its own
        -- authorisation" by reading the row back. This branch answers it by
        -- construction: there is no id to hand us. `de_ref` is
        -- "archetype:<key>", and the employee it means is the one an ACCEPTED
        -- employee proposal IN THIS SAME SESSION created. §11b requirement 4 —
        -- "a trust rule cannot exist without the employee it governs" — is
        -- therefore enforced here in SQL, not only by the browser's
        -- trustRuleBlockReason.
        if v_tr_ref !~ '^archetype:[a-z0-9_]+$' then
          raise exception 'this recommendation points at "%" rather than at one of the employees it recommended, so there is nobody to record a limit for. Nothing was changed, and it is still here waiting for you.',
            v_tr_ref;
        end if;
        v_tr_arch := substring(v_tr_ref from 11);

        select s.created_object_id into v_tr_de
          from public.discovery_proposals s
         where s.session_id = v_p.session_id
           and s.tenant_id  = v_p.tenant_id
           and s.kind       = 'employee'
           and s.state      = 'accepted'
           and s.created_object_id is not null
           and nullif(btrim(s.payload ->> 'archetype_key', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '') = v_tr_arch
         order by s.decided_at desc nulls last
         limit 1;
        if v_tr_de is null then
          raise exception 'we have not set up the employee this limit is for yet. Say yes to that recommendation first and this one will be ready straight after — a limit on somebody who does not exist is not something we can record. Nothing was changed, and it is still here waiting for you.';
        end if;

        -- ...and that id, which came off a SIBLING ROW rather than off this
        -- decision, still has to be a real employee in THIS workspace. The
        -- sibling's `created_object_id` is written by this same function, but a
        -- row can be edited by anything holding UPDATE, so it is re-read here.
        -- ⚠ The Workspace Assistant exclusion is a FILTER, never a value read:
        -- this select cannot return an assistant row, which is the standing
        -- instruction stated as a predicate rather than as a promise.
        select d.name into v_tr_emp
          from public.digital_employees d
         where d.id = v_tr_de
           and d.tenant_id = v_p.tenant_id
           and coalesce(d.is_workforce_assistant, false) = false;
        if v_tr_emp is null then
          raise exception 'the employee this limit was for is not one of yours any more, so there is nothing to record it against. Nothing was changed, and it is still here waiting for you.';
        end if;

        -- PATH A'S OWN SHAPE, said the way 752 says Path B's. There is nothing
        -- for a browser to have created first — it holds SELECT on this table
        -- and nothing else — so being handed an object id means something
        -- upstream believes this kind works the other way round.
        if p_created_object_id is not null then
          raise exception 'a trust limit is recorded by this workspace itself, not created first and linked after, so there was nothing to link. Nothing was changed, and it is still here waiting for you.';
        end if;

        -- ⚠⚠ THE INERTNESS PIN, AND IT IS ASKED OF THIS ROW RATHER THAN OF THE
        -- PLATFORM. The card says nothing changes today. That sentence is true
        -- because this employee is at level 0 for this capability, where
        -- `trust_ladder_settings` returns {enabled:false} before it even looks
        -- at a ladder — NOT because "no policy anywhere is above level 0",
        -- which is a fact about the 90 rows that exist today and would stop
        -- being true the first time anybody approves a promotion.
        --
        -- So the row is read FIRST, and an already-promoted policy is REFUSED.
        -- Accepting one would mean re-opening a setting on an employee that has
        -- already earned autonomy here, which is a different decision with a
        -- different blast radius from the one the card described.
        select * into v_tr_pol
          from public.trust_policies t
         where t.tenant_id       = v_p.tenant_id
           and t.de_id           = v_tr_de
           and t.action_category = v_tr_cat
           and t.source_category is null;

        if v_tr_pol.id is not null and coalesce(v_tr_pol.current_level, 0) > 0 then
          raise exception '% has already earned some independence on this kind of work — it is at level % of %. This recommendation was written as "nothing changes today", and on an employee that is already acting on its own it would not be, so we have not touched it. You can see and change what % is allowed to do on its own under its Trust settings. Nothing was changed, and this is still here waiting for you.',
            v_tr_emp, v_tr_pol.current_level, coalesce(v_tr_pol.max_level, 3), v_tr_emp;
        end if;

        -- ...and the same question about the OTHER half of the pair. A policy
        -- that already carries a ladder has had somebody set what each level
        -- means, deliberately, through set_trust_ladder — the one door. Opening
        -- this card on top of that would put a number in the audit trail beside
        -- a configuration nobody here wrote, and a later reader could not tell
        -- which of the two the customer agreed to.
        -- ⚠ MIGRATION 842. effective_trust_ladder, not v_tr_pol.ladder.
        -- Migration 838 made a role's declaration a second source of "somebody
        -- has already set out what each level means" -- read through the
        -- employee's archetype, never copied onto the policy -- so a policy
        -- inheriting its role's ladder still has trust_policies.ladder IS NULL
        -- and this guard UNDER-FIRED on exactly the case it exists to refuse.
        if v_tr_pol.id is not null and public.effective_trust_ladder(v_tr_pol) is not null then
          raise exception 'somebody has already set out what each level of trust means for % on this kind of work, and this recommendation would sit beside that without changing it — which would leave two different limits recorded and no way to tell which one you meant. Have a look under %''s Trust settings and set the limit there instead. Nothing was changed, and this is still here waiting for you.',
            v_tr_emp, v_tr_emp;
        end if;

        -- OPEN THE SETTING, THROUGH THE ORDINARY WRITER. seed_de_trust_policy
        -- creates the row at level 0 and is idempotent on
        -- (tenant, action_category, coalesce(source_category,''),
        -- coalesce(de_id::text,'')) — the live unique index — so a re-run finds
        -- the row rather than making a second one.
        --
        -- ⚠ ITS OWN BAR REFUSES A CAPABILITY THAT IS NOT REAL FOR THIS
        -- EMPLOYEE: `de_trust_surface_candidates` decides what an employee can
        -- even be dialled on, and an `action:<category>` needs a CONNECTED
        -- connector behind it. That refusal is checked here first so the
        -- customer reads a sentence instead of a function's internal message —
        -- the same reason 752 restates playbook-draft's 40-character floor.
        -- ⚠ STRICTER THAN THE CLIENT AGAIN, and safe for the same Path A
        -- reason: validatePayload only checks the category against the live
        -- NAMESPACE (the distinct values in trust_policies), which is a
        -- workspace-wide fact and says nothing about THIS employee.
        if v_tr_pol.id is null then
          if not exists (
            select 1 from public.de_trust_surface_candidates(v_p.tenant_id, v_tr_de) c
             where c.capability_key = v_tr_cat
               and coalesce(c.dialable, false)
          ) then
            raise exception 'this workspace cannot yet let % work on its own on this — "%" either is not something % does, or it needs a system connected before it can be dialled at all. Connect that system, or set the limit under %''s Trust settings once it appears there. Nothing was changed, and this is still here waiting for you.',
              v_tr_emp, v_tr_cat, v_tr_emp, v_tr_emp;
          end if;

          -- ⚠ p_display_name IS DELIBERATELY NULL. A marker written into a
          -- customer-facing label would be a SECOND, WEAKER copy of provenance
          -- — editable by anyone with the ladder editor, and silent about who
          -- agreed or when. The record that this limit came from an interview
          -- is the ACCEPTED PROPOSAL POINTING AT THIS ROW (created_object_id)
          -- plus its audit event, which carry the whole payload, the session,
          -- the source dimension and the person. See the header.
          perform public.seed_de_trust_policy(v_tr_de, v_tr_cat, null);
          v_tr_seeded := true;

          select * into v_tr_pol
            from public.trust_policies t
           where t.tenant_id       = v_p.tenant_id
             and t.de_id           = v_tr_de
             and t.action_category = v_tr_cat
             and t.source_category is null;
        end if;

        -- READ BACK AND RE-CHECK EVERY PROMISE, exactly as the Path B kinds do
        -- with the row the browser made. A writer nobody re-reads is a writer
        -- nobody keeps.
        if v_tr_pol.id is null then
          raise exception 'we could not open a trust setting for % on this kind of work, so nothing was recorded. Nothing was changed, and this is still here waiting for you.',
            v_tr_emp;
        end if;
        if v_tr_pol.tenant_id is distinct from v_p.tenant_id
           or v_tr_pol.de_id is distinct from v_tr_de
           or v_tr_pol.action_category is distinct from v_tr_cat
           or v_tr_pol.source_category is not null then
          raise exception 'the trust setting that came back is not the one this recommendation was about (it is for a different employee, a different kind of work, or a different workspace), so nothing was recorded. Nothing was changed, and this is still here waiting for you.';
        end if;

        -- ⚠ THE CARD'S CENTRAL PROMISE, RE-ASSERTED AGAINST THE ROW THAT NOW
        -- EXISTS. Level 0 and no ladder together are the whole of "nothing
        -- changes today":
        --   · trust_ladder_settings(policy, 0) returns {enabled:false} before
        --     it reads the ladder at all, so level 0 enforces nothing;
        --   · a NULL ladder means a future promotion falls back to
        --     trust_level_settings — the built-in defaults — so this accept
        --     cannot change what level 1 will mean either. THE INTERVIEW
        --     CANNOT MOVE A DIAL IT DID NOT SET.
        -- Probe 17 drives both, and inverts both.
        if coalesce(v_tr_pol.current_level, 0) <> 0
           or coalesce(v_tr_pol.baseline_level, 0) <> 0
           or public.effective_trust_ladder(v_tr_pol) is not null then
          raise exception 'the trust setting for % came back at level % with %, and this recommendation was recorded on the promise that nothing changes today. Nothing was recorded, and this is still here waiting for you.',
            v_tr_emp, coalesce(v_tr_pol.current_level, 0),
            case when public.effective_trust_ladder(v_tr_pol) is null then 'no limits set' else 'limits already set on it' end;
        end if;
        if coalesce(v_tr_pol.status, '') is distinct from 'active' then
          raise exception 'the trust setting for % is %, not active, so a limit recorded against it would not be looked at even when you do decide to use it. Nothing was recorded, and this is still here waiting for you.',
            v_tr_emp, coalesce(v_tr_pol.status, 'in an unknown state');
        end if;

        -- WHAT IS ENFORCED FOR THIS EXACT SCOPE RIGHT NOW, counted rather than
        -- claimed. `de_autonomy` is the table the four enforcement paths read
        -- through resolve_de_autonomy, and `trust_apply_level` is the only
        -- thing that writes it from a ladder. This number travels into the
        -- return payload and the audit detail so "nothing changes today" is
        -- checkable against the ledger rather than believed.
        select count(*) into v_tr_dials
          from public.de_autonomy a
         where a.tenant_id      = v_p.tenant_id
           and a.de_id          = v_tr_de
           and a.action_type    = v_tr_cat
           and a.source_category is null;

        -- What the screen and the audit line are allowed to say, from ONE
        -- object so the two cannot drift. The STATED CAP IS IN HERE, with its
        -- unit beside it, because it is the thing the customer agreed to and it
        -- is written nowhere else that a future enforcement layer could find:
        -- the policy row deliberately does not carry it. `ladder_written` and
        -- `enforces_today` are stated as facts rather than left to be inferred
        -- from an absence.
        v_counters := jsonb_build_object(
          'policy_id',           v_tr_pol.id,
          'action_category',     v_tr_pol.action_category,
          'de_id',               v_tr_de,
          'employee_name',       v_tr_emp,
          'current_level',       coalesce(v_tr_pol.current_level, 0),
          'max_level',           coalesce(v_tr_pol.max_level, 3),
          'policy_opened_here',  v_tr_seeded,
          'stated_cap',          v_tr_cap_n,
          'stated_cap_unit',     v_tr_unit,
          'above_cap',           v_tr_above,
          'ladder_written',      false,
          'enforced_dials_for_this_scope', coalesce(v_tr_dials, 0),
          'enforces_today',      false);

        v_object_id := v_tr_pol.id;

      -- ---- conversation_type — Path B, and the LAST kind ------------------
      -- The browser already inserted the triage rule as the signed-in human
      -- under RLS (`authenticated` holds INSERT/UPDATE/DELETE/SELECT on
      -- support_triage_rules, and support_triage_rules_admin_write is a
      -- FOR ALL policy over tenant_owner/tenant_admin/tenant_manager). This
      -- verifies and stamps it. It does NOT insert: an `insert into
      -- support_triage_rules` here runs as postgres and bypasses RLS, which is
      -- the second creation engine the plan forbids — the same argument the
      -- connector arm makes, and it applies with full force here because the
      -- ORDINARY writer for this table is PostgREST (upsertTriageRule,
      -- src/lib/supportInboxApi.ts:333) behind a full CRUD editor the customer
      -- already uses.
      --
      -- ⚠ WHY THIS KIND IS NOT PATH A, stated against the two that are.
      -- `employee` is Path A because `authenticated` holds SELECT and nothing
      -- else on digital_employees; `trust_rule` is Path A for the same reason on
      -- trust_policies. Neither is true here. There IS a PostgREST write path,
      -- customers use it, and routing the interview around it would mean two
      -- writers for one table with only one of them under RLS.
      when 'conversation_type' then
        v_writer     := 'createTriageRuleFromProposal -> support_triage_rules (client, under RLS), verified and stamped here';
        v_object_tbl := 'support_triage_rules';

        -- ⚠ THE SAME EXPLICIT WHITESPACE SET 751 ESTABLISHED, for the same
        -- measured reason: one-argument `btrim` strips SPACES ONLY, while the
        -- client composes with JS `.trim()`. All three of these are COMPARED
        -- byte for byte against what the browser wrote, so a lone tab surviving
        -- here and not there is a permanent stuck proposal beside a live rule.
        v_ct_label   := nullif(btrim(v_p.payload ->> 'label',         E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_ct_cat     := nullif(btrim(v_p.payload ->> 'set_category',  E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        v_ct_pattern := nullif(btrim(v_p.payload ->> 'match_pattern', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');
        -- ⚠ 760: the FOURTH literal, trimmed with the same explicit whitespace
        -- set for the same reason — one-argument btrim strips SPACES ONLY and
        -- the browser composes with JS .trim(). This one is OPTIONAL: a topic
        -- nobody owns is a topic the workspace answers the way it does today,
        -- which is the whole of the founder's "no match keeps today's behaviour".
        v_ct_own_ref := nullif(btrim(v_p.payload ->> 'owner_ref',     E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '');

        if v_ct_label is null then
          raise exception 'this recommendation has no name for the topic, and a topic nobody can read on a screen is not something anyone can agree to. Nothing was created, and it is still here waiting for you.';
        end if;
        if v_ct_cat is null then
          raise exception 'this recommendation does not say which topic to file these conversations under, so there is nothing to write down. Nothing was created, and it is still here waiting for you.';
        end if;

        -- ⚠ THE CATEGORY TOKEN IS WRITTEN INTO de_conversations.category AND
        -- READ BACK BY THE INBOX FILTER AS AN EXACT STRING (supportInboxApi.ts's
        -- CONV_COLS and SupportInboxPage's `c.category !== topic`), and
        -- SupportHistoryReport renders `category.replace(/_/g, ' ')`. So the
        -- shape is fixed here rather than left to whatever a model wrote: lower
        -- case, a-z 0-9 and underscore, at most 40 characters. The eleven live
        -- categories all satisfy it (safety, security, legal, outage, data,
        -- billing, access, complaint, feature_request, how_to, general —
        -- measured 2026-08-17 across 18 tenants).
        if v_ct_cat !~ '^[a-z0-9]+(_[a-z0-9]+)*$' or length(v_ct_cat) > 40 then
          raise exception 'we cannot file conversations under "%" — a topic name we can sort and count by has to be plain lower-case words joined by underscores, like "delivery_delay". Nothing was created, and it is still here waiting for you.',
            v_ct_cat;
        end if;

        -- ⚠ THE PATTERN IS NOT A REGULAR EXPRESSION HERE, AND THAT IS THE
        -- OPPOSITE OF THE GUARDRAIL CASE — measured from the matcher itself
        -- rather than assumed from the field name. `classify_support_text`
        -- (read live 2026-08-17) does:
        --     FOREACH frag IN ARRAY string_to_array(r.match_pattern, '|')
        --       IF position(lower(btrim(frag)) IN lower(text)) > 0 THEN ...
        -- `position`, not `~` and not `new RegExp`. So every character in a
        -- triage pattern means itself, and 751's whole regex-metacharacter
        -- screen would be refusing safe input if it were copied here. What DOES
        -- carry over is the empty-alternative hazard, and it lands differently:
        -- an empty fragment is skipped by `frag <> ''`, so "billing|" matches
        -- exactly what "billing" does rather than matching everything. It is
        -- refused anyway, because a card showing a trailing bar promises a
        -- second phrase that will never be looked at.
        --
        -- A NULL pattern is refused OUTRIGHT and this is the sharpest edge on
        -- this kind: a rule with no pattern is a CATCH-ALL that returns
        -- IMMEDIATELY for every message reaching it, which would silently swallow
        -- every conversation the rules below it were written for. All 18 live
        -- tenants carry exactly one such rule, at rule_order 9999, called
        -- "Default". An interview must never mint a second one.
        if v_ct_pattern is null then
          raise exception 'this recommendation has no words to look for, and a topic rule with no words catches EVERY conversation rather than the ones about "%" — every other topic below it would stop being used. Nothing was created, and it is still here waiting for you.',
            v_ct_label;
        end if;
        if v_ct_pattern ~ '(^\||\|\||\|$)' then
          raise exception 'the words to look for on this one — "%" — have a "|" with nothing beside it. The blank between the bars is skipped rather than matched, so the card would be showing you a phrase that is never looked at. Nothing was created, and it is still here waiting for you.',
            v_ct_pattern;
        end if;

        -- ⚠⚠ 760 — WHO ANSWERS, RESOLVED FROM THE SESSION AND NEVER FROM THE
        -- CALLER. This is 753's de_ref shape, and it is that shape for the same
        -- reason: there is no employee id to hand us at the moment the card is
        -- written, so the reference is to an ARCHETYPE the same interview
        -- proposed, and the employee it means is the one an ACCEPTED employee
        -- proposal in THIS session created.
        --
        -- ⚠ AN UNRESOLVABLE OWNER REFUSES; IT DOES NOT DEGRADE TO "nobody". The
        -- card named a person. Writing the rule without them would be a card
        -- that said one thing and a workspace that does another, with no later
        -- reader able to tell — and this repo has paid for silent degradation
        -- before. The refusal says which card to say yes to first.
        if v_ct_own_ref is not null then
          if v_ct_own_ref !~ '^archetype:[a-z0-9_]+$' then
            raise exception 'this recommendation says these conversations should go to "%" rather than to one of the people it recommended, so there is nobody to send them to. Nothing was created, and it is still here waiting for you.',
              v_ct_own_ref;
          end if;
          v_ct_own_arch := substring(v_ct_own_ref from 11);

          select s.created_object_id into v_ct_owner
            from public.discovery_proposals s
           where s.session_id = v_p.session_id
             and s.tenant_id  = v_p.tenant_id
             and s.kind       = 'employee'
             and s.state      = 'accepted'
             and s.created_object_id is not null
             and nullif(btrim(s.payload ->> 'archetype_key', E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'), '') = v_ct_own_arch
           order by s.decided_at desc nulls last
           limit 1;
          if v_ct_owner is null then
            raise exception 'we have not set up the person who would answer these yet. Say yes to that recommendation first and this one will be ready straight after — a topic that goes to somebody who does not exist would just sit there. Nothing was created, and it is still here waiting for you.';
          end if;

          -- ...and that id, which came off a SIBLING ROW rather than off this
          -- decision, still has to be an employee in THIS workspace.
          -- ⚠ THE WORKSPACE ASSISTANT IS A FILTER, NEVER A VALUE READ — the
          -- standing instruction stated as a predicate. It is the workspace's
          -- own internal helper, not one of the customer's employees, and this
          -- would otherwise be the first path on the platform that puts
          -- customer support traffic in front of it.
          --
          -- ⚠⚠ AND LIFECYCLE IS DELIBERATELY *NOT* A BAR HERE, WHICH IS THE
          -- OPPOSITE OF WHAT THE FIRST VERSION OF THIS BRANCH DID — measured,
          -- not reasoned. The employee an owner_ref resolves to is ALWAYS one
          -- an accepted employee proposal in this same session just created,
          -- and the ordinary discovery hire lands at
          -- `lifecycle_status = 'designed', status = 'idle'` (driven live
          -- 2026-08-18 through this very function). So a lifecycle bar here
          -- would refuse EVERY owner the interview can ever propose, and the
          -- feature would be dead on arrival with a message blaming the
          -- customer.
          --
          -- THE SPLIT IS THE POINT: this function records CONSENT — the
          -- customer said this person answers this topic — and
          -- classify_support_text decides ELIGIBILITY at answer time, where a
          -- 'designed', paused, retired or archived owner returns NULL and the
          -- workspace's ordinary choice answers instead. One place, one rule,
          -- re-evaluated on every message rather than frozen at accept time.
          --
          -- ⚠ AND IT IS ALSO THE SECOND GATE THIS KIND WAS SAID NOT TO HAVE.
          -- Because the owner is always a just-hired 'designed' employee,
          -- accepting a topic with an owner CHANGES NOTHING ABOUT WHO ANSWERS
          -- until that employee is published. The card and the drawer both say
          -- so; the sentence a customer reads before pressing a button has to
          -- be the sentence that turns out to be true.
          select d.name into v_ct_own_name
            from public.digital_employees d
           where d.id = v_ct_owner
             and d.tenant_id = v_p.tenant_id
             and coalesce(d.is_workforce_assistant, false) = false;
          if v_ct_own_name is null then
            raise exception 'the person this topic would go to is not one of yours, so these conversations would have nowhere to land. Nothing was created, and it is still here waiting for you.';
          end if;
        end if;

        if p_created_object_id is null then
          raise exception 'a conversation topic is accepted by creating the rule first: add it as the signed-in person, then pass its id here (Path B)';
        end if;

        -- The id a caller hands us is NOT its own authorisation. Read the WHOLE
        -- row back — every sentence on the card is checked against it below.
        select * into v_ct_rule
          from public.support_triage_rules t
         where t.id = p_created_object_id
           and t.tenant_id = v_p.tenant_id;
        if v_ct_rule.id is null then
          raise exception 'no topic rule % in this workspace — a created-object id is not its own authorisation', p_created_object_id;
        end if;

        -- ⚠⚠ THE PROVENANCE COLUMN IS THE IDEMPOTENCY, AND IT IS THE ONLY
        -- THING THAT COULD BE. support_triage_rules carried exactly three
        -- constraints before this migration — the primary key, the
        -- set_priority CHECK and the tenant FK (read live 2026-08-17) — and NO
        -- unique index of any kind. So a browser that died between the insert
        -- and the stamp left an orphan rule, and a retry minted a second one
        -- with nothing in the database to stop it. 752 solved the same problem
        -- with a deterministic key over an index that already existed; there was
        -- no key column here to be deterministic about.
        -- This file adds `source_proposal_id` plus a UNIQUE index over it, so
        -- one proposal can own at most ONE rule, enforced by the database rather
        -- than by the browser not clicking twice. The client's find-first is a
        -- COURTESY that turns a 23505 into a re-use; this is the guarantee.
        if v_ct_rule.source_proposal_id is distinct from v_p.id then
          raise exception 'the topic rule that was created is not linked to this recommendation (it points at %), so accepting this would leave two rules where you agreed to one. Nothing was recorded, and this is still here waiting for you.',
            coalesce(v_ct_rule.source_proposal_id::text, 'nothing');
        end if;

        -- ⚠ THE CONSENTED LITERALS, BYTE FOR BYTE — §11b's "you cannot consent
        -- to what you cannot predict" applied to a topic rule. The card rendered
        -- the topic name, the words to look for and the file-under token; if the
        -- row carries anything else the customer agreed to one rule and got
        -- another, and no later reader could tell.
        if v_ct_rule.set_category is distinct from v_ct_cat then
          raise exception 'the rule that was created files conversations under "%", but this recommendation showed "%" — a topic has to be the one that was agreed to, exactly', coalesce(v_ct_rule.set_category, 'nothing'), v_ct_cat;
        end if;
        if v_ct_rule.match_pattern is distinct from v_ct_pattern then
          raise exception 'the rule that was created looks for "%", but this recommendation showed "%" — the words on the card are the whole of what you agreed to', coalesce(v_ct_rule.match_pattern, 'nothing'), v_ct_pattern;
        end if;
        if v_ct_rule.name is distinct from v_ct_label then
          raise exception 'the rule that was created is called "%", but this recommendation showed "%" — the name is what you will see in your triage rules, so it has to be the one on the card', coalesce(v_ct_rule.name, 'nothing'), v_ct_label;
        end if;
        -- ⚠⚠ 760 — AND WHO ANSWERS, WHICH IS NOW THE LARGEST FACT ON THE CARD.
        -- `is distinct from` compares BOTH DIRECTIONS with one operator and
        -- that is deliberate: a card naming nobody must not create a rule that
        -- sends traffic to somebody, and a card naming somebody must not create
        -- a rule that sends it nowhere. Either way the customer agreed to one
        -- thing and got another, and a triage rule is editable with no version
        -- history anywhere else, so the literal has to be checked here or never.
        if v_ct_rule.owner_de_id is distinct from v_ct_owner then
          raise exception 'the rule that was created sends these conversations to %, but this recommendation said %. Who answers is the biggest thing on that card, so it has to be the one that was agreed to. Nothing was recorded, and it is still here waiting for you.',
            coalesce((select d.name from public.digital_employees d
                       where d.id = v_ct_rule.owner_de_id and d.tenant_id = v_p.tenant_id
                         and coalesce(d.is_workforce_assistant, false) = false), 'nobody in particular'),
            coalesce(v_ct_own_name, 'nobody in particular');
        end if;

        -- ...and it has to actually be consulted. `classify_support_text`
        -- filters `WHERE tenant_id = p_tenant_id AND active`, so an inactive rule
        -- is a card that says a topic is being tracked while nothing looks at it.
        if not coalesce(v_ct_rule.active, false) then
          raise exception 'the rule that was created is switched off, and a topic nothing looks for is not the thing this recommendation described. Nothing was recorded, and this is still here waiting for you.';
        end if;

        -- ⚠⚠ THE ORDER IS THE ROUTING DECISION, AND IT IS CHECKED RATHER THAN
        -- DEFAULTED. `classify_support_text` walks the rules
        -- `ORDER BY rule_order, created_at` and RETURNS ON THE FIRST MATCH. The
        -- column defaults to 100 — and every one of the 18 live tenants already
        -- carries a baseline rule AT 100 ("How-to"), seeded before today, so a
        -- rule taking the default would tie with it and lose the tie on
        -- created_at, silently and forever. That is an ordering nobody chose.
        --
        -- The live baseline, measured 2026-08-17, is identical in all 18
        -- tenants: 10 Safety, 20 Security, 30 Legal/Regulatory, 40 Outage,
        -- 50 Data loss, 60 Billing, 70 Access, 80 Complaint, 90 Feature request,
        -- 100 How-to, 9999 Default (the catch-all).
        --
        -- So this kind is confined to the band 200..9998, and the accept
        -- REFUSES a row outside it. That band is a decision with two halves,
        -- and both are on the card:
        --   · ABOVE 100 — a topic from an interview NEVER outranks Safety or
        --     Security. "Someone is hurt" must not be re-filed as "delivery
        --     delay" because a customer described their inbox that way.
        --   · BELOW 9999 — it is still consulted before the catch-all, so it
        --     does change what a conversation is filed as. A rule that only ran
        --     after "Default" could never fire at all.
        if coalesce(v_ct_rule.rule_order, 100) < 200 or coalesce(v_ct_rule.rule_order, 100) > 9998 then
          raise exception 'the rule that was created sits at position % in your triage list, and a topic from this conversation belongs between 200 and 9998 — after the built-in urgent categories like Safety and Security, and before the catch-all. Nothing was recorded, and this is still here waiting for you.',
            coalesce(v_ct_rule.rule_order::text, 'the default');
        end if;

        -- WHAT ELSE IS AT THAT POSITION, COUNTED RATHER THAN ASSUMED. Ties are
        -- broken by created_at, which nothing on any screen shows, so a tie is a
        -- routing decision made invisibly. This does NOT refuse — two of the
        -- customer's own topics sharing a position is a display question between
        -- rules they both wrote, not a safety question, and refusing would make
        -- a second interview session unable to accept anything. It is COUNTED,
        -- and the number travels into the audit detail and the return payload so
        -- the screen can say it out loud.
        select count(*) into v_ct_ties
          from public.support_triage_rules t
         where t.tenant_id = v_p.tenant_id
           and t.active
           and t.rule_order = v_ct_rule.rule_order
           and t.id <> v_ct_rule.id;

        -- ...and how many active rules sit AHEAD of it, which is the honest
        -- answer to "will this actually catch anything". A rule behind ten
        -- broader patterns fires for whatever they leave.
        select count(*) into v_ct_ahead
          from public.support_triage_rules t
         where t.tenant_id = v_p.tenant_id
           and t.active
           and t.rule_order < v_ct_rule.rule_order;

        -- What the screen and the audit line are allowed to say, from ONE
        -- object so the two cannot drift. The PATTERN and the CATEGORY are in
        -- here deliberately: the row is editable and deletable from the triage
        -- rules editor with no version history anywhere else, so the literals
        -- the customer consented to have to outlive it — the same reasoning
        -- 751 states for a guardrail's pattern.
        -- ⚠⚠ 760 REPLACED THE PARAGRAPH THAT USED TO STAND HERE, AND THE OLD ONE
        -- WAS TRUE WHEN IT WAS WRITTEN. It said `routes_to_employee` is FALSE
        -- because "nothing on this platform reads de_conversations.category to
        -- choose a digital employee". That is no longer the shape: the three
        -- functions that CREATE a conversation now classify the question BEFORE
        -- the row exists, look the topic's owner up from that one classification,
        -- and stamp de_id from it (widget-ask, email-inbound, de-answer).
        --
        -- ⚠ SO THE COUNTER IS AN EXPRESSION, NOT A LITERAL, and that is the
        -- whole point of it. A topic with no owner still routes nothing, and
        -- `routes_to_employee` says so for that card; a topic with an owner says
        -- so for that one. A hardcoded `true` would be the same defect the
        -- hardcoded `false` became — a sentence the customer is shown that
        -- nothing can be checked against — and both arms are driven in probe 19.
        v_counters := jsonb_build_object(
          'rule_id',            v_ct_rule.id,
          'topic_name',         v_ct_rule.name,
          'set_category',       v_ct_rule.set_category,
          'match_pattern',      v_ct_rule.match_pattern,
          'set_priority',       v_ct_rule.set_priority,
          'set_severity',       v_ct_rule.set_severity,
          'rule_order',         v_ct_rule.rule_order,
          'rules_ahead_of_it',  coalesce(v_ct_ahead, 0),
          'rules_sharing_its_position', coalesce(v_ct_ties, 0),
          'owner_de_id',        v_ct_owner,
          'owner_name',         v_ct_own_name,
          'routes_to_employee', (v_ct_owner is not null),
          'labels_conversations', true);

        v_object_id := v_ct_rule.id;

      -- ---- every other kind ---------------------------------------------
      -- ⚠ NO PRODUCT KIND REACHES THIS ARM ANY MORE. All six kinds
      -- discovery_proposals_kind_check admitted before today now have a `when`
      -- branch above. What reaches it is `__unrouted_probe__`, a SENTINEL this
      -- migration adds to the CHECK precisely so this arm stays drivable — see
      -- the header. Nothing emits it, `authenticated` holds SELECT and nothing
      -- else on discovery_proposals, and it is absent from ProposalKind, from
      -- KIND_LABELS and from SECTION_ORDER, so no card can ever carry it.
      --
      -- ⚠⚠ AND THE PROBES THAT DRIVE IT NO LONGER NAME IT. 751 repointed probe
      -- 7 off `guardrail`, 752 repointed probe 14 off `procedure`, and each
      -- repoint was a rename that happened to still have a spare kind. There is
      -- no spare left. So 753 rebuilt both probes to DERIVE their subject: they
      -- read discovery_proposals_kind_check for the admitted kinds, strip the
      -- comments out of THIS function's body, subtract every `when '<kind>'
      -- then` arm that is really there, and drive whatever survives. The day
      -- `conversation_type` gains a branch that set is EMPTY, and the fixture
      -- guard turns that into a FINDING naming what has to be rebuilt — instead
      -- of two probes that keep running and compare nothing. Whoever ships it
      -- should expect red here and read the message rather than move a number.
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
$function$
;

-- ── proof ───────────────────────────────────────────────────────────────────
-- Every probe states its DENOMINATOR; an arm that compared nothing raises a
-- named VACUITY notice and does not count. ⚠ db-query.mjs SWALLOWS raise notice,
-- so the success line is invisible on a real apply -- silence IS the pass.
--
-- ⚠ WHAT IS NOT IN HERE, AND WHY. The end-to-end drive of this function --
-- verify_decide_discovery_proposal(), which runs the REAL RPC across 19 probes
-- and 287 assertions, including Probe 17 which exercises BOTH guards changed
-- here and inverts them -- is deliberately NOT called from inside this
-- migration. It creates and decides real proposals; run inside the migration's
-- own transaction, anything it failed to clean up would COMMIT with the
-- migration. It was run instead as a separate always-aborting transaction
-- before this file was committed, against production, with this migration
-- applied in the same transaction. Result reported in the task report, not
-- asserted here where its side effects would be permanent. It returned
-- probes_completed=19, assertions=287, no findings -- byte-identical to the
-- baseline run with neither migration applied, so this change regresses nothing
-- on the accept path it edits.
--
-- ── FOUR INVERSIONS, EACH RED WITH ITS OWN MESSAGE ─────────────────────────
-- Clean chain first (838 then 842, one aborting transaction): exit 0.
--   I1  the PRE-SEED guard reverted to v_tr_pol.ladder .... PROBE 1 RED
--   I2  the POST-SEED guard reverted to v_tr_pol.ladder ... PROBE 1 RED
--   I3  effective_trust_ladder made non-null for all ...... PROBE 3b RED
--   I4  effective_trust_ladder made to ignore the role .... PROBE 3a RED
--
-- ⚠ I3 AND I4 HAD TO BE INJECTED BETWEEN THE TWO MIGRATIONS, and that is worth
-- writing down. Breaking effective_trust_ladder inside 838 turns 838's OWN
-- probes red first, so the transaction aborts before any arm here runs and the
-- inversion proves nothing about THIS file. Overriding the function after 838's
-- verify block has passed is what isolates these two arms. The first attempt did
-- it the naive way and reported a false PASS-shaped failure; the harness was
-- fixed rather than the expectation lowered.
do $verify$
declare
  v_checks integer := 0;
  v_bad    text[]  := '{}';
  v_src    text;
  v_row    record;

  v_tenant   uuid;
  v_de       uuid;
  v_de_plain uuid;
  v_pol      public.trust_policies;
  v_pol2     public.trust_policies;
  v_fix_ran  boolean := false;
  v_fix_err  text;
  c_rollback constant text := 'zz_probe_842_deliberate_rollback';

  c_role_key    constant text  := 'zz_probe_842_declares';
  c_cat         constant text  := 'zz_probe_842_cat';
  c_ladder      constant jsonb :=
    '[{"level":1,"name":"zz probe 842 step one","mode":"act_within_limits","settings":{"max_amount_cents":50000}}]'::jsonb;
begin
  -- ══ PROBE 1 -- WIRING, asserted about SCHEMA so it is true wherever this
  -- replays. Denominator 2. Comments are stripped FIRST: this file's own prose
  -- names `v_tr_pol.ladder` repeatedly and would otherwise satisfy the very
  -- pattern that must be absent.
  select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc
   where proname = 'decide_discovery_proposal' and pronamespace = 'public'::regnamespace;

  if v_src is null then
    v_bad := array_append(v_bad, 'PROBE 1: public.decide_discovery_proposal does not exist after this migration ran');
  else
    v_checks := v_checks + 1;
    if v_src ~ '\mv_tr_pol\.ladder\M' then
      v_bad := array_append(v_bad,
        'PROBE 1: the installed decide_discovery_proposal still reads v_tr_pol.ladder directly. That is the raw column, which is NULL for a policy inheriting its role''s ladder -- the guard under-fires on exactly the case it exists to refuse.');
    end if;

    v_checks := v_checks + 1;
    if (select count(*) from regexp_matches(v_src, 'effective_trust_ladder\s*\(\s*v_tr_pol\s*\)', 'g')) <> 3 then
      v_bad := array_append(v_bad, format(
        'PROBE 1: expected exactly 3 effective_trust_ladder(v_tr_pol) call sites in decide_discovery_proposal (the pre-seed guard, the post-seed guard, and the message beside it), found %s',
        (select count(*) from regexp_matches(v_src, 'effective_trust_ladder\s*\(\s*v_tr_pol\s*\)', 'g'))));
    end if;
  end if;

  -- ══ PROBE 2 -- the post-apply body hash matches what the precheck declares,
  -- so this migration's own work cannot make a re-apply refuse. Denominator 1.
  v_checks := v_checks + 1;
  select md5(btrim(regexp_replace(
           regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')))
    into v_src
    from pg_proc
   where proname = 'decide_discovery_proposal' and pronamespace = 'public'::regnamespace;
  if v_src is distinct from '28120b5e46b3e565e64a737f570e328f' then
    v_bad := array_append(v_bad, format(
      'PROBE 2: the installed decide_discovery_proposal hashes to %s, but the precheck declares 28120b5e46b3e565e64a737f570e328f as its post-apply body. Update that constant in BOTH places or every re-apply will refuse.',
      coalesce(v_src, 'SQL NULL')));
  end if;

  -- ══ PROBE 3 -- THE SEMANTIC CORE: the old predicate and the new one must
  -- genuinely DISAGREE on the case that mattered, and AGREE everywhere else.
  -- This is what makes PROBE 1 more than a spelling check -- without it, both
  -- predicates could be equivalent and the whole migration a no-op.
  --
  -- Needs a tenant. On a database with none the arm makes ZERO comparisons and
  -- says so. The whole fixture runs in a subtransaction that is deliberately
  -- aborted: role_archetypes, digital_employees and trust_policies inserts all
  -- fire activity-log triggers, and deleting the rows afterwards would not undo
  -- those. PL/pgSQL variables are not transactional, so the findings survive.
  select t.id into v_tenant
    from public.tenants t
   where public.tenant_is_operational(t.id)
   order by t.created_at
   limit 1;
  if v_tenant is null then
    select id into v_tenant from public.tenants order by created_at limit 1;
  end if;

  if v_tenant is null then
    raise notice '842 VACUITY -- no tenant exists on this database, so PROBE 3 made ZERO comparisons: the disagreement between the old and new predicates is unexercised here. True and honest on an empty database, not a manufactured pass. PROBES 1 and 2 are unaffected.';
  else
    begin
      v_fix_ran := true;

      insert into public.role_archetypes (key, name, domain, trust_ladder)
        values (c_role_key, 'zz probe 842 (declares)', 'zz_probe_842',
                jsonb_build_object(c_cat, c_ladder));

      insert into public.digital_employees (tenant_id, name, archetype_key)
        values (v_tenant, 'zz probe 842 DE (role declares)', c_role_key)
        returning id into v_de;
      insert into public.digital_employees (tenant_id, name)
        values (v_tenant, 'zz probe 842 DE (no archetype)')
        returning id into v_de_plain;

      insert into public.trust_policies (tenant_id, de_id, action_category, ladder)
        values (v_tenant, v_de, c_cat, null);
      insert into public.trust_policies (tenant_id, de_id, action_category, ladder)
        values (v_tenant, v_de_plain, c_cat, null);

      select * into v_pol  from public.trust_policies where de_id = v_de       and action_category = c_cat;
      select * into v_pol2 from public.trust_policies where de_id = v_de_plain and action_category = c_cat;

      -- (3a) THE DISAGREEMENT. The policy carries no ladder of its own, so the
      -- OLD predicate says "nobody has set out what each level means" -- and the
      -- role has. The new predicate must say the opposite.
      v_checks := v_checks + 1;
      if v_pol.ladder is not null then
        v_bad := array_append(v_bad,
          'PROBE 3a FIXTURE BUG: the inheriting fixture policy carries its own ladder, so it does not exercise the under-firing case at all');
      elsif public.effective_trust_ladder(v_pol) is null then
        v_bad := array_append(v_bad,
          'PROBE 3a: a policy whose ROLE declares a ladder for this category still resolved to no effective ladder. The guards this migration rewires would keep under-firing, and this migration changes nothing.');
      end if;

      -- (3b) ⛔ THE CONTROL. Same shape, employee with NO archetype, so there is
      -- nothing to inherit: both predicates must agree that no ladder is set.
      -- Without this, 3a passes for an effective_trust_ladder that returns
      -- non-null for everything -- which would make the guards refuse EVERY
      -- trust_rule accept, a far worse outcome than the one being fixed.
      v_checks := v_checks + 1;
      if public.effective_trust_ladder(v_pol2) is not null then
        v_bad := array_append(v_bad, format(
          'PROBE 3b: CONTROL FAILED -- a policy whose employee has NO archetype resolved to an effective ladder (%s). The rewired guards would refuse every trust_rule accept, so PROBE 3a proves nothing.',
          public.effective_trust_ladder(v_pol2)::text));
      end if;

      raise exception '%', c_rollback;
    exception when others then
      if sqlerrm <> c_rollback then
        v_fix_err := sqlerrm;
        v_bad := array_append(v_bad, format(
          'PROBE 3: the fixture arm died before it could finish (%s). Findings collected before that point still stand; arms after it compared nothing.',
          v_fix_err));
      end if;
    end;
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'VERIFICATION FAILED (% findings across % checks): %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  if v_fix_ran and v_fix_err is null then
    raise notice '842: % checks compared, 0 findings -- FULL RUN (tenant found; PROBE 3 and its control both exercised). NOTE: db-query.mjs does not surface RAISE NOTICE.', v_checks;
  else
    raise notice '842: % checks compared, 0 findings -- REDUCED RUN: PROBE 3 did not complete (%). PROBES 1 and 2 carried this result alone. NOTE: db-query.mjs does not surface RAISE NOTICE.',
      v_checks, coalesce(v_fix_err, 'no tenant on this database');
  end if;
end
$verify$;

commit;
