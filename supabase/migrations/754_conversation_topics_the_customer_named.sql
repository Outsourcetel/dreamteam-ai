-- 754_conversation_topics_the_customer_named.sql
-- ==========================================================================
-- WHY: the interview asks how customers reach you, the customer answers with a
-- list — "they ask about delivery, returns, sizing, warranty, and about ten
-- other things" — and until 2026-08-15 that produced ONE card, identical in
-- every workspace, that no writer could carry out. This is the SIXTH and LAST
-- kind. After it, `decide_discovery_proposal` routes every kind
-- discovery_proposals_kind_check admits to a real table.
--
-- THE FOUNDER'S INSTRUCTION, VERBATIM: "do the conversation topics and make
-- sure it's not addressing just one thing as a customer might ask for 10
-- different things." MANY TOPICS FROM ONE INTERVIEW IS THE REQUIREMENT. Probe
-- 18 drives ten in one session and counts ten rules with ten categories, ten
-- ids and ten positions — the denominator read off the fixture array, never
-- typed.
--
-- ==========================================================================
-- ⚠⚠ THIS KIND WAS REMOVED ON PURPOSE, AND ITS REMOVAL WAS RIGHT.
--
-- DIMENSION_STRUCTURAL_KINDS used to map how_customers_reach_us ->
-- ['conversation_type'] and emit one draft with payload {label: dim.title,
-- owner_ref}. `dim.title` for that dimension is literally "How customers reach
-- us" — the interview's own question heading — so every tenant, every session,
-- produced the SAME card; and there is no `conversation_types` table, no
-- writer, and nothing that routes on a label. Accepting it could only ever have
-- been a no-op wearing an accept button.
--
-- The kind stayed in ProposalKind, in discovery_proposals_kind_check and in the
-- presentation module PRECISELY so it could come back whole. This is that.
--
-- ==========================================================================
-- WHAT IT COMES BACK AS, AND THE MEASUREMENTS BEHIND EVERY PART OF IT.
--
-- The topic axis the old card was pretending to be IS REAL AND IS LIVE:
-- `de_conversations.category`, written by `trg_triage_support_conversation`
-- from `classify_support_text`, which reads `support_triage_rules`. Read live
-- 2026-08-17:
--
--     public.support_triage_rules — 198 rows, 18 tenants, 11 distinct
--     set_category values, 198 active, 18 with a NULL match_pattern.
--     EVERY tenant carries the SAME eleven: 10 Safety, 20 Security,
--     30 Legal/Regulatory, 40 Outage, 50 Data loss, 60 Billing, 70 Access,
--     80 Complaint, 90 Feature request, 100 How-to, 9999 Default (the
--     pattern-less catch-all).
--
-- So the payload is {label, set_category, match_pattern} plus the emitter's
-- evidence, and the accept writes a row in that table. Nothing is invented:
-- the shape is the shape eighteen workspaces already run.
--
-- ==========================================================================
-- ⚠⚠⚠ THE HONEST SENTENCE ON THE CARD, AND THE FOUR THAT WERE ON IT BEFORE.
--
-- THE INSTRUCTION WAS "1 AND 3" — the interview writes REAL triage rules AND
-- topic actually routes. HALF OF THAT IS BUILT HERE AND HALF IS NOT, and the
-- half that is not is reported rather than implied. Enumerated live:
--
--   WHO SETS de_conversations.de_id, AND WHEN
--     · widget-ask/index.ts:338 — `insert into de_conversations {... de_id:
--       subjectDeId ...}` at conversation CREATION, before any message row
--       exists;
--     · email-inbound/index.ts:190 — the same, with de_id chosen as "the first
--       eligible employee ordered by created_at, preferring
--       external_reply_mode='auto'". Nothing about the message's subject.
--
--   WHO SETS de_conversations.category, AND WHEN
--     · `trg_triage_support_conversation`, AFTER INSERT ON public.de_messages
--       FOR EACH ROW — the ONLY writer (pg_proc scan for both identifiers,
--       2026-08-17). It fires on the FIRST user message, refuses to override a
--       non-null category, and skips any channel outside
--       (widget, hosted, portal, email, dock).
--
--   SO THE ORDER IS: de_id stamped -> first message lands -> category written.
--   THE EMPLOYEE IS CHOSEN BEFORE THE TOPIC IS KNOWN.
--
--   WHO READS category TO CHOOSE AN EMPLOYEE: NOBODY. Enumerated both sides —
--   the three SQL functions naming both de_conversations and category
--   (get_de_kpi_status, get_de_work_product, snapshot_de_kpi_readings) all read
--   action_definitions.category or group conversations by CHANNEL; the client
--   readers are supportInboxApi.ts's CONV_COLS and byCategory, supportReport.ts
--   :87, SupportInboxPage.tsx:182 and SupportHistoryReport.tsx:238 — four
--   filters and a label. Not one selects a digital employee.
--
-- THEREFORE the card says LABELLED, not ROUTED, and the accept records
-- `routes_to_employee: false` as a stated fact rather than an absence. The
-- previous card said, in four places:
--     "Conversations get tagged and routed under this topic from now on."
--     "Routes to: <employee name>"
--     "No owner yet — you can assign one when you publish."
--     "Adds this as a routable conversation topic."
-- Three of those four describe behaviour that does not exist anywhere in this
-- codebase, and the fourth ("when you publish") describes a step that does not
-- exist either. All four are rewritten in this file's client half. SIX FALSE
-- COMMENTS HAVE SHIPPED IN THIS WORKSTREAM; this is the seventh through tenth
-- caught before shipping rather than after.
--
-- ⚠ TOPIC-BASED ROUTING IS A SEPARATE PIECE AND IT IS NOT BUILT HERE. It would
-- mean either re-stamping de_id after triage (which changes who owns a
-- conversation mid-flight, and every reader of de_conversations.de_id would
-- have to tolerate that) or deferring the de_id choice until after the first
-- message is classified (which changes the insert contract of two edge
-- functions and the widget's own response path). Both are a migration of their
-- own with their own argument. The scope call belongs to the founder; this file
-- builds the accept path and refuses to let the card claim the other half.
--
-- ==========================================================================
-- ⚠⚠ BLOCKER 1 — THE INDEX MADE "TEN THINGS" IMPOSSIBLE, AND TODAY IS THE FREE
-- DAY TO FIX IT.
--
-- Migration 740 put `unique (session_id, kind, identity_key)` on
-- discovery_proposals, and identity_key is GENERATED (read live, verbatim):
--
--   COALESCE(CASE kind WHEN 'employee'  THEN payload->>'archetype_key'
--                      WHEN 'connector' THEN payload->>'provider_key'
--                      ELSE source_dimension END, '')
--
-- Exactly ONE dimension emits conversation_type, so every topic in a session
-- carried the SAME identity_key and the second insert died on 23505. That is
-- the trap that cost migration 751 a failed apply, and here it is not an
-- inconvenience — it is the founder's requirement being mechanically
-- impossible. conversation_type therefore gets its own arm, the way employee
-- keys on archetype_key and connector on provider_key.
--
-- ⚠ THE KEY IS `set_category`, AND THE ALTERNATIVE WAS REAL. The two candidates
-- were set_category (one rule per topic per session) and match_pattern (several
-- patterns per topic, but two cards could then claim one category). The live
-- data decides it: `classify_support_text` splits match_pattern on '|' and
-- matches ANY fragment, and all 198 live rules use that — the ten pattern-
-- bearing baseline rules carry between 6 and 10 alternatives each, and no tenant
-- has two rules with the same set_category. The platform's own model is ONE RULE
-- PER TOPIC, MANY PHRASES IN ONE PATTERN. So "a second pattern for the same
-- topic" is not a thing the pattern key would have bought: the pattern field IS
-- the list.
--
-- WHAT THE CUSTOMER LOSES, said plainly: two rules with the SAME category but
-- different set_priority or set_severity — "billing" normally sev3 but "charged
-- twice" urgent — cannot both come out of one interview. The baseline solves
-- exactly that case with two DIFFERENT categories (billing at 60, complaint at
-- 80), so the shape has never been needed here; and the triage-rules editor
-- (src/pages/tenant/support/SupportTriageRulesPage.tsx) gives full CRUD, so a
-- customer who wants the second rule can add it. Under-proposing is the safe
-- direction; two cards fighting over one category is not.
--
-- ⚠ WHY TODAY. `discovery_proposals` holds ZERO rows (measured 2026-08-17,
-- alongside zero discovery_sessions). A generated column cannot be ALTERed — it
-- is DROP + ADD, and the unique index goes with it. On an empty table that is
-- free; after the first real interview it is a data migration with a rewrite
-- window on a customer-facing table.
--
-- A UNIQUE INDEX IS AN INTERFACE, so every reader was enumerated before it was
-- touched (grep across src/, supabase/, scripts/, tests/, docs/ plus pg_depend
-- and pg_policy):
--   · pg_depend — the ONLY database object depending on the column is
--     discovery_proposals_identity_uq itself. No view, no policy, no trigger,
--     no other index, no constraint.
--   · supabase/functions/discovery-interview/index.ts:687 —
--     `.upsert(rows, { onConflict: 'session_id,kind,identity_key',
--     ignoreDuplicates: true })`. It names the COLUMN LIST, not the index name,
--     and the column list is unchanged, so PostgREST resolves to the rebuilt
--     index exactly as before.
--   · No `on conflict` clause anywhere in SQL names the index or the column.
--   · The probes in 751/752/753 that assert 23505 on a repeated
--     source_dimension for `procedure` and `trust_rule` are UNAFFECTED — both
--     kinds still fall to the ELSE arm of the CASE.
-- The index is dropped and recreated with the SAME NAME and the SAME COLUMN
-- LIST, so nothing downstream can tell the difference except conversation_type.
--
-- ==========================================================================
-- ⚠⚠ BLOCKER 2 — THIS MIGRATION EMPTIES THE SET PROBES 7 AND 14 DEPEND ON.
--
-- Migration 753 rebuilt both probes to DERIVE the unrouted set from
-- discovery_proposals_kind_check minus the router's comment-stripped `when`
-- arms, and left a finding that fires when that set is empty. Its words:
--
--   "Rebuild both against a different construction — a deliberately unrouted
--    sentinel kind admitted by the CHECK, or a direct assertion about the
--    `else` arm — and move probes_attempted with them."
--
-- THE SENTINEL IS CHOSEN, and the alternative is argued rather than dismissed.
-- Probe 7 does not assert ABOUT the else arm; it DRIVES it, and then reads
-- last_error off the row, watches `attempts` INCREMENT rather than be set, and
-- accepts the same row once its kind becomes routable. None of that can be
-- reached without a row whose kind falls through the CASE, and no row can carry
-- such a kind unless the CHECK admits one. A "direct assertion" — grepping the
-- function body for an `else raise` — would be a statement about text, and this
-- repo already knows what a checker that reads a file instead of firing a path
-- is worth.
--
-- So `__unrouted_probe__` is added to discovery_proposals_kind_check. What
-- makes it safe rather than a hole, each part measured:
--   · `authenticated` holds SELECT, REFERENCES and TRIGGER on
--     discovery_proposals and NOTHING ELSE (read live) — no customer path can
--     insert any kind, let alone this one. Only service_role (the emitter) and
--     postgres (this probe) can.
--   · Nothing emits it: it is absent from ProposalKind, from PROPOSAL_KINDS,
--     from KIND_LABELS, from SECTION_ORDER and from DIMENSION_STRUCTURAL_KINDS,
--     so no card can render it and no batch can contain it.
--   · scripts/discovery-proposal-check.mjs checks KIND_ROUTES -> CHECK ("a kind
--     declared routable the CHECK does not admit"), never CHECK -> KIND_ROUTES;
--     `admittedButUnroutable` is PRINTED, not failed on. So the sentinel does
--     not buy any product kind an exemption — and the standing rule is
--     untouched: a kind absent from KIND_ROUTES still makes certify RED on any
--     ROW carrying it, and this one can have no rows.
--   · Probes 7 and 14 need NO edit. Their derivation returns exactly the
--     sentinel, and 753's vacuity guard still fires — with the sentinel in the
--     CHECK, an empty set now means somebody gave the SENTINEL a branch, which
--     is a finding either way.
--
-- probes_attempted moves 17 -> 18 in all four places it appears, and
-- certify.mjs's EXPECTED_PROBES and ASSERTION_FLOOR move with it.
--
-- ==========================================================================
-- ⚠⚠ THE IDEMPOTENCY, AND WHAT ENFORCES IT.
--
-- support_triage_rules carried exactly THREE constraints before this file (read
-- live 2026-08-17): the primary key, the set_priority CHECK and the tenant FK.
-- NO unique index of any kind. So Path B's crash window — the browser inserts,
-- dies, and a retry inserts again — had nothing in the database to stop it, and
-- "the client will not click twice" is not an answer. 751's guardrail branch
-- lives with that risk behind a find-first; 752 removed it with a deterministic
-- key over a UNIQUE (tenant_id, key) that already existed. There is no key
-- column here to be deterministic about.
--
-- So this migration adds one: `source_proposal_id uuid` plus
-- `unique (source_proposal_id) where source_proposal_id is not null`. ONE
-- PROPOSAL OWNS AT MOST ONE RULE, enforced by the database. The client's
-- find-first is then a courtesy that turns a 23505 into a re-use, not the
-- guarantee.
--
-- ⚠ IT IS ALSO THE ANSWER TO "IS AN ACCEPTED RULE DISTINGUISHABLE FROM THE 198
-- THAT ALREADY EXIST" — yes, and machine-readably. 753 deliberately refused a
-- provenance marker for a trust rule, and the two decisions do not conflict:
-- what 753 refused was a MARKER IN A CUSTOMER-FACING LABEL (seed_de_trust_policy's
-- p_display_name), a second weaker copy of something created_object_id already
-- carried, on a table that ALREADY had a unique index to be idempotent on. This
-- is a foreign key that is the mechanism, on a table that had none.
--
-- ON DELETE SET NULL, not CASCADE: if the proposal is ever cleared, the rule is
-- the customer's and stays; it just stops being attributable.
--
-- ==========================================================================
-- ⚠⚠ PATH B, ARGUED RATHER THAN ASSUMED.
--
-- `authenticated` holds INSERT, UPDATE, DELETE and SELECT on
-- support_triage_rules, and `support_triage_rules_admin_write` is a FOR ALL
-- policy over (tenant_owner, tenant_admin, tenant_manager) with
-- tenant_id = auth_tenant_id() on both USING and WITH CHECK. The ordinary
-- writer is PostgREST — `upsertTriageRule`, src/lib/supportInboxApi.ts:333 —
-- behind a CRUD editor customers already use.
--
-- That is exactly the connector and guardrail shape, and NOT the employee or
-- trust_rule shape: those two are Path A because `authenticated` holds SELECT
-- and nothing else on their tables, so there is no PostgREST write path to
-- preserve. Here there is one, and writing from a SECURITY DEFINER function
-- would run as postgres, bypass RLS entirely, and be the second creation engine
-- the plan forbids.
--
-- ⚠ THE ROLE BARS DIFFER AND THE STRICTER ONE WINS. RLS admits tenant_manager;
-- decide_discovery_proposal's accept gate does not. A manager can therefore
-- create the rule and cannot accept the proposal — the rule is left orphaned and
-- unstamped, which is the same state a crashed browser leaves and which the
-- unique index above makes recoverable. The accept gate is the binding one.
--
-- ⚠⚠ AND THERE IS NO CLIENT PRE-FLIGHT. This paragraph used to end "and the
-- client pre-flights the role before writing anything (see
-- acceptConversationTopicProposal)", which contradicted the sentence directly
-- above it — a pre-flight is precisely what would stop a manager creating the
-- rule — and was false besides: that function has exactly two awaits,
-- createTriageRuleFromProposal and decideDiscoveryProposal. No auth.getUser(),
-- no profiles read, no role comparison anywhere on the path.
--
-- ONE WAS DELETED RATHER THAN THE OTHER BUILT, and the reason is not effort:
--   · THE MANAGER GAINS NOTHING HERE. support_triage_rules_admin_write admits
--     tenant_manager to the ordinary triage-rules editor as well, so the rule
--     this path lets them create is a rule they can already create by hand in
--     Support › Triage rules. The accept gate withholds the one thing that is
--     actually narrower — RECORDING THE DECISION — and it does so server-side.
--   · A BROWSER CHECK IS NOT A GATE. It is advisory: PostgREST is reachable
--     without this page. Building it would put a THIRD statement of "who may do
--     this" — RLS policy, RPC role list, React — in three languages, free to
--     drift, with only the first two enforcing anything. This repo has paid for
--     a tooltip mistaken for a gate before.
--   · IT WOULD NOT CLOSE THE WINDOW IT LOOKS LIKE IT CLOSES. The identical
--     orphan arises from a browser dying between the insert and the stamp, and
--     the partial unique index — not a pre-flight — is what makes that
--     recoverable.
--
-- WHAT HAPPENS TO THE RULE THE MANAGER ALREADY CREATED, said plainly because it
-- is a real consequence and not a theoretical one: it is LIVE. It carries
-- source_proposal_id, and classify_support_text reads every active rule in the
-- workspace on the first user message of every support conversation, so it
-- starts filing traffic under that category immediately — while the proposal
-- stays `pending` and carries the accept gate's refusal in `last_error`
-- (migration 740), so the card still says so tomorrow. Recovery is the ordinary
-- one: an owner or admin accepting the same card afterwards RE-USES that rule
-- rather than minting a second (createTriageRuleFromProposal finds it by
-- source_proposal_id; the unique index is what guarantees there is only one),
-- and the accept then stamps it. If nobody does, it is removable in the same
-- editor the manager could have created it in. The user-facing message on this
-- path already says all of this; only the comment was wrong.
--
-- ==========================================================================
-- ⚠⚠ THE ORDER IS A ROUTING DECISION, AND THE DEFAULT MAKES IT BY ACCIDENT.
--
-- classify_support_text walks `ORDER BY rule_order, created_at` and RETURNS ON
-- THE FIRST MATCH. rule_order DEFAULTS TO 100 — and all 18 live tenants already
-- carry a baseline rule at exactly 100 ("How-to"). A rule taking the default
-- ties with it and loses the tie on created_at, because the baseline was seeded
-- 2026-07-21 / 2026-08-15 and anything from an interview is newer. That is an
-- ordering nobody chose, decided by a timestamp no screen shows.
--
-- So this kind is confined to the band 200..9998 and the accept REFUSES a row
-- outside it. Both edges are decisions:
--   · ABOVE 100 — a topic from an interview NEVER outranks Safety (10) or
--     Security (20). "Someone is hurt" must not be re-filed as "delivery delay"
--     because a customer described their inbox that way. This is the one place
--     where being LOWER priority is the safe direction.
--   · BELOW 9999 — still consulted before the pattern-less catch-all, so it
--     does change what a conversation is filed as. A rule after "Default" could
--     never fire at all, because a pattern-less rule returns immediately.
-- Within the band, the accept COUNTS how many active rules share the position
-- and how many sit ahead of it, and both numbers go on the card and into the
-- audit detail. It does not refuse a tie: two of the customer's own topics
-- sharing a position is a display question between rules they both wrote, and
-- refusing would make a second interview session unable to accept anything.
-- What it refuses is the ordering the customer never saw.
--
-- ==========================================================================
-- WHAT THIS FILE DOES, IN ORDER
--   PART 1 — rebuild identity_key and its unique index (free today, a data
--            migration tomorrow).
--   PART 2 — support_triage_rules gains source_proposal_id and the unique index
--            that makes the accept idempotent.
--   PART 3 — the CHECK gains the `__unrouted_probe__` sentinel so probes 7 and
--            14 stay comparisons.
--   PART 4 — decide_discovery_proposal gains its SIXTH and last branch.
--   PART 5 — the standing check gains PROBE 18 and moves to 18 probes.
-- ==========================================================================

begin;

-- ===========================================================================
-- PART 1 — identity_key, REBUILT.
--
-- Order matters: the index depends on the column, so it goes first. Dropping
-- the column alone would take the index with it silently, and a later reader
-- could not tell whether the index was meant to come back.
-- ===========================================================================
drop index if exists public.discovery_proposals_identity_uq;

alter table public.discovery_proposals drop column if exists identity_key;

alter table public.discovery_proposals
  add column identity_key text
  generated always as (
    coalesce(
      case kind
        when 'employee'          then payload ->> 'archetype_key'
        when 'connector'         then payload ->> 'provider_key'
        -- ⚠ 754. Without this arm every conversation_type in a session shares
        -- `source_dimension` and the second insert dies on 23505 — see the
        -- header's BLOCKER 1. One rule per topic per session is what the live
        -- data models: no tenant has two rules with the same set_category.
        when 'conversation_type' then payload ->> 'set_category'
        else source_dimension
      end, '')) stored;

create unique index discovery_proposals_identity_uq
  on public.discovery_proposals (session_id, kind, identity_key);

comment on column public.discovery_proposals.identity_key is
  'Generated per kind, and the right-hand column of the (session_id, kind, identity_key) unique index that makes the emitter''s upsert idempotent under a race (migration 740). '
  'archetype_key for employee (one dimension proposes many roles), provider_key for connector, set_category for conversation_type (migration 754 — one rule per topic per session, because classify_support_text expresses many phrasings for one topic INSIDE one pipe-separated match_pattern, and no live tenant has two rules sharing a category), and source_dimension for everything else. '
  'A generated column cannot be ALTERed: changing this expression is DROP + ADD and takes the unique index with it, so enumerate every reader first — today they are pg_depend (the index alone) and discovery-interview/index.ts''s onConflict, which names the column list rather than the index.';


-- ===========================================================================
-- PART 2 — support_triage_rules LEARNS WHERE A RULE CAME FROM.
--
-- This is the idempotency mechanism, not decoration — see the header. The table
-- had NO unique index of any kind, so Path B's crash window had nothing behind
-- it. It is also the only thing that tells a rule an interview wrote from the
-- eleven every workspace is seeded with.
-- ===========================================================================
alter table public.support_triage_rules
  add column if not exists source_proposal_id uuid
    references public.discovery_proposals(id) on delete set null;

-- ⚠ PARTIAL, and that is the whole point: the 198 rules that exist today carry
-- NULL and must keep being allowed to, while any two rules claiming the SAME
-- proposal is the collision a retry has to hit.
-- ⚠⚠ AND IT IS PINNED, which it was not when this file was first written.
-- verify_decide_discovery_proposal probe 18(d2) drives a second row claiming the
-- same proposal (must raise 23505), counts the rules that proposal owns (must be
-- exactly 1) and inserts a NULL-carrying rule (must succeed, or the predicate
-- has been lost and every workspace's second seeded rule would be refused).
-- Before that arm existed, DROPPING THIS INDEX left the whole verifier at 18/18
-- probes, 262 assertions and zero findings.
create unique index if not exists support_triage_rules_source_proposal_uq
  on public.support_triage_rules (source_proposal_id)
  where source_proposal_id is not null;

comment on column public.support_triage_rules.source_proposal_id is
  'The discovery proposal a customer accepted to create this rule, or NULL for the eleven seed_support_triage_baseline gives every workspace and for anything hand-written in the triage-rules editor. '
  'Two jobs, both load-bearing (migration 754). (1) IDEMPOTENCY: support_triage_rules had no unique index at all, so a browser dying between the insert and decide_discovery_proposal''s stamp left an orphan and a retry minted a second rule. The partial unique index over this column is what makes one proposal own at most ONE rule, in the database rather than in the browser. (2) PROVENANCE: it is the only thing distinguishing a rule the interview wrote from one the workspace was seeded with. '
  'ON DELETE SET NULL, never CASCADE — if the proposal is cleared the rule is still the customer''s.';

-- No GRANT is issued here. `authenticated` already holds column-less
-- INSERT/UPDATE/DELETE/SELECT on this table, which covers a new column, and RLS
-- (support_triage_rules_admin_write, FOR ALL over owner/admin/manager with
-- tenant_id = auth_tenant_id()) is what actually bounds the write.


-- ---------------------------------------------------------------------------
-- ⚠⚠ AND THE EVIDENCE PERIMETER, WHICH THIS TABLE WAS MISSING — found by
-- RUNNING scripts/discovery-proposal-check.mjs's own route arms against the new
-- entry rather than by reading the diff.
--
-- Measured live 2026-08-17, all six route tables:
--     connectors           trg_tenant_activity_log  ✓
--     digital_employees    trg_tenant_activity_log  ✓
--     guardrail_rules      trg_tenant_activity_log  ✓
--     playbook_definitions trg_tenant_activity_log  ✓
--     trust_policies       trg_tenant_activity_log  ✓
--     support_triage_rules — NONE.
--
-- It is the ONLY one without it, and the omission is not cosmetic. That check's
-- "the customer deleted it" relief reads TWO records written by two different
-- things: the governed path's own audit event, and an INDEPENDENT
-- tenant_activity_log DELETE row written by a trigger at delete time. The
-- second is the half decide_discovery_proposal cannot write, which is the only
-- reason the relief means anything at all.
--
-- Without the trigger, the FIRST customer who accepts a topic and then removes
-- it in the triage-rules editor leaves a created_object_id that resolves to
-- nothing, cannot be relieved, and turns certify red under a message about a
-- uuid that was never created — which would be false, and would point whoever
-- read it at entirely the wrong problem. Probe 18(e) drives exactly that
-- deletion, because "can the customer take one off" is a question this kind has
-- to answer.
--
-- ⚠⚠ WHERE THE PIN ON THIS TRIGGER LIVES, recorded because the obvious place is
-- the wrong one. DROPPING trg_tenant_activity_log FROM support_triage_rules
-- SURVIVES verify_decide_discovery_proposal COMPLETELY — 18/18 probes, zero
-- findings — because no probe in this file asks about it. It IS guarded, by
-- scripts/discovery-proposal-check.mjs: routeTablesSql() reads `delete_logged`
-- per route table (pg_trigger, tgfoid = log_tenant_activity, tgtype & 8 for
-- ON DELETE, so an INSERT-only trigger cannot satisfy it) and
-- discoveryProposalFailures' per-kind loop turns a false into a failure naming
-- this table and this kind. A reviewer drove that arm in BOTH directions.
--
-- That file has NO `npm run` entry of its own — it is a module, not a CLI — and
-- reaches production only through `npm run certify`, which imports it at
-- scripts/certify.mjs:96-100. So "I ran the migration's verifier and it was
-- clean" is not evidence about this trigger, and neither is running the checker
-- file directly (it exports functions and executes nothing). Do not conclude
-- from either that the trigger is unguarded.
--
-- ⚠ ADDING IT IS PART OF MAKING THE KIND ROUTABLE, not a nearby tidy-up. The
-- route entry in KIND_ROUTES and this trigger are the same claim stated in two
-- places: that a row of this table being removed is recorded by something other
-- than the function that created it.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_tenant_activity_log on public.support_triage_rules;
create trigger trg_tenant_activity_log
  after insert or delete or update on public.support_triage_rules
  for each row execute function public.log_tenant_activity();


-- ===========================================================================
-- PART 3 — THE SENTINEL KIND.
--
-- See the header's BLOCKER 2 for why this is a sentinel rather than an
-- assertion about the function's text, and for the four measurements that make
-- it unreachable from any customer path. Its ONLY consumer is
-- verify_decide_discovery_proposal's derivation, which computes
-- "kinds the CHECK admits, minus the `when` arms really present in the router".
-- ===========================================================================
alter table public.discovery_proposals drop constraint discovery_proposals_kind_check;

alter table public.discovery_proposals
  add constraint discovery_proposals_kind_check
  check (kind = any (array[
    'employee'::text, 'procedure'::text, 'connector'::text,
    'guardrail'::text, 'trust_rule'::text, 'conversation_type'::text,
    -- ⚠ NOT A PROPOSAL KIND. Nothing emits it, no card renders it, and
    -- `authenticated` cannot insert into this table at all. It exists so that
    -- probes 7 and 14 — the only two places asserting that a refusal leaves a
    -- readable reason on the row, that `attempts` INCREMENTS rather than being
    -- set, that a twice-failed proposal can still be accepted afterwards, and
    -- that the router did not swing open further than intended — can still be
    -- DRIVEN now that all six real kinds route. Deleting it does not fail a
    -- constraint; it makes probes_completed drop to 16 of 18 and certify go red
    -- with the finding migration 753 wrote for exactly this moment.
    '__unrouted_probe__'::text]));


-- ===========================================================================
-- PART 4 — THE ROUTER GAINS ITS SIXTH AND LAST BRANCH.
--
-- Replaced forward from the exact text pg_get_functiondef returns today, which
-- was diffed line by line against the copy migration 753 carries: 1,392 lines,
-- 88,067 characters, ZERO differing lines. Retyping a function this size is a
-- silent revert of whatever another session shipped.
--
-- ONE `when` arm is added and the `else` arm's comment is rewritten. Nothing
-- else in the body changes.
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
        if v_tr_pol.id is not null and v_tr_pol.ladder is not null then
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
           or v_tr_pol.ladder is not null then
          raise exception 'the trust setting for % came back at level % with %, and this recommendation was recorded on the promise that nothing changes today. Nothing was recorded, and this is still here waiting for you.',
            v_tr_emp, coalesce(v_tr_pol.current_level, 0),
            case when v_tr_pol.ladder is null then 'no limits set' else 'limits already set on it' end;
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
        -- ⚠ `routes_to_employee` is FALSE and it is stated rather than omitted.
        -- Nothing on this platform reads de_conversations.category to choose a
        -- digital employee: `de_id` is stamped when the conversation row is
        -- INSERTED (widget-ask/index.ts:338, email-inbound/index.ts:190) and the
        -- category is written afterwards by trg_triage_support_conversation, an
        -- AFTER INSERT trigger on de_messages that fires on the FIRST user
        -- message. A false absence is how the previous version of this card came
        -- to promise routing, so the absence is written down.
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
          'routes_to_employee', false,
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

comment on function public.decide_discovery_proposal(uuid, text, text, uuid) is
  'Decide one discovery proposal: accepted | declined | parked. Accept is owner/admin only (tenant read off the row); decline and park are open to any member but still audited. '
  'Routes ALL SIX kinds as of migration 754 — no product kind reaches the `else` arm any more; what does is the `__unrouted_probe__` sentinel, which nothing emits and no card can render. '
  '''connector'' via Path B — the browser creates the connector as the signed-in human under RLS and passes its id, which this stamps. '
  '''employee'' via Path A — this function hires it itself in ONE transaction: instantiate_role_archetype, then install_role_kit UNGUARDED, then install_role_systems inside its own sub-block so a refusal there is additive and never costs the hire. '
  '''guardrail'' via Path B, PATTERN-BEARING ONLY (migration 751) — the browser adds the rule through addGuardrailRule under RLS and passes its id; this checks the row is a blocked_phrase rule in this tenant carrying the payload''s literal verbatim, blocking, applies_to=all, active and NOT pack-owned, then stamps it. '
  '''procedure'' via Path B, a MECHANICAL NECESSITY rather than an RLS argument (migration 752): the ordinary writer is the playbook-draft EDGE FUNCTION, and pg_net returns a request id whose reply lands after COMMIT, so no SQL function can call the drafter and read what it made. '
  '''trust_rule'' via Path A (migration 753), the ONLY proposal that removes a human from a loop, so it deliberately does the SMALLEST true thing: a level-0 policy through seed_de_trust_policy, NO ladder written and NO dial applied, with the stated limit recorded as consent data in the payload and the audit detail and nowhere an enforcement path reads. '
  '''conversation_type'' via Path B (migration 754), and Path B for the connector/guardrail reason rather than the procedure one: `authenticated` holds INSERT/UPDATE/DELETE/SELECT on support_triage_rules behind an owner/admin/manager RLS policy, and the ordinary writer is the triage-rules editor''s own PostgREST call, so writing from here would run as postgres, bypass RLS, and be a second creation engine for a table customers already edit. '
  'The browser inserts the rule carrying source_proposal_id — added by 754 together with a PARTIAL UNIQUE index over it, because this table had NO unique index of any kind and therefore nothing to make a retry collide — and this verifies: same tenant, source_proposal_id equal to THIS proposal, the payload''s name, match_pattern and set_category byte for byte, active, a set_category the inbox filter and the history report can actually use (lower-case words joined by underscores, <= 40 chars), a non-null match_pattern (a pattern-less rule is a CATCH-ALL that returns immediately for every message and would swallow every topic below it — all 18 live tenants already have exactly one, at 9999), no empty alternative, and a rule_order inside 200..9998. '
  '⚠ THE BAND IS THE ROUTING DECISION. classify_support_text walks the rules ORDER BY rule_order, created_at and returns on the FIRST match; the column defaults to 100 and every live tenant already carries a baseline "How-to" rule at exactly 100, so a defaulted rule ties with it and loses on a timestamp no screen shows. Above 100 means an interview topic never outranks Safety (10) or Security (20); below 9999 means it is still consulted before the catch-all. '
  '⚠ IT LABELS, IT DOES NOT ROUTE, and the accept says so in `routes_to_employee: false` rather than by omission. de_conversations.de_id is stamped when the conversation row is INSERTED (widget-ask:338, email-inbound:190), the category is written afterwards by trg_triage_support_conversation on the FIRST user message, and no reader of de_conversations.category selects an employee. '
  'The accept returns and audits systems_installed/watchers_created/watchers_skipped/guardrails_created/sop_snapshot_published for a hire, rule_type/pattern/severity/applies_to/compliance_pack_key for a guardrail, playbook_key/name/status/kind/steps_described/steps_drafted/sop_chars for a procedure, policy_id/current_level/stated_cap/stated_cap_unit/ladder_written/enforced_dials_for_this_scope/enforces_today for a trust rule, and rule_id/topic_name/set_category/match_pattern/rule_order/rules_ahead_of_it/rules_sharing_its_position/routes_to_employee/labels_conversations for a conversation topic — because a silent zero (or a silent literal) is indistinguishable from one nobody measured. '
  'Returns jsonb, never a composite: callers must check error AND data.ok.';


-- ---------------------------------------------------------------------------
-- PERIMETER, restated. `create or replace` keeps the oid and therefore the ACL,
-- so this changes nothing today — it is here so the intended surface is stated
-- in the file that last touched the function. `service_role` is named in the
-- REVOKE because pg_default_acl grants it automatically on every function
-- postgres creates in `public`, and under service_role auth.uid() is null:
-- instantiate_role_archetype, install_role_kit and seed_de_trust_policy would
-- SKIP their authority checks rather than fail them, append_audit_event would
-- drop its identity stamp, and decided_by would be unsatisfiable.
-- ---------------------------------------------------------------------------
revoke all on function public.decide_discovery_proposal(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_discovery_proposal(uuid, text, text, uuid)
  to authenticated;


-- ===========================================================================
-- PART 5 — THE STANDING CHECK GAINS PROBE 18, AND PROBES 7 AND 14 KEEP RUNNING.
--
-- Migration 753's verifier, replaced forward from the exact text applied and
-- read back from pg_get_functiondef first (body: 5,066 lines, ZERO differing
-- lines against the file), with:
--
--  * PROBE 18 ADDED: the whole conversation_type path — TEN topics in ONE
--    session driven to accepted (the founder's requirement, with the
--    denominator read off the fixture array rather than typed), the classifier
--    driven in both directions, migration 740's identity index driven in both
--    directions on the NEW arm, the removability of what the accept creates
--    driven as the owner under RLS, the provenance column counted on both
--    sides, eight refusals each with its own sentence, and the role bar with
--    its inversion on the same row.
--    ⚠ FIX ROUND: plus (d2), support_triage_rules_source_proposal_uq itself —
--    a SECOND row claiming one proposal must raise 23505, one proposal must own
--    exactly one rule, and a NULL-carrying rule must still insert. It was
--    described in this header as "the guarantee … enforced by the database" and
--    pinned by nothing: dropping the index left 18/18 probes, 262 assertions and
--    zero findings. The RPC's own source_proposal_id check (probe 18(g2)) is the
--    STAMP reading a column, which is not the same claim.
--  * PROBES 7 AND 14 ARE NOT EDITED AT ALL, and that is the point of the
--    sentinel: their derivation reads the CHECK and subtracts the router's real
--    `when` arms, and `__unrouted_probe__` is what it now returns. 753's vacuity
--    guard is unchanged and still fires — with the sentinel present, an empty
--    set means somebody gave the SENTINEL a branch, which is its own finding.
--  * the denominators move from 17/239 to 18/265 — COUNTED, not estimated, and
--    from FOUR sources that agree: the static count of `v_checks := v_checks +
--    1` in the VERIFIER BODY (the span from this file's `CREATE OR REPLACE
--    FUNCTION public.verify_decide_discovery_proposal()` to its `$function$`),
--    a real aborting run's `assertions=`, scripts/certify.mjs's
--    ASSERTION_FLOOR, and PART 6's own floor arm — all four read 265.
--    ⚠⚠ "IN THIS FILE" IS THE WRONG UNIT AND THIS LINE USED TO SAY IT. A raw
--    grep of the whole file over-counts three ways: PART 6's DO block keeps its
--    own denominator in a variable of the same name (27, reported separately),
--    and any occurrence inside a comment or a message string is counted too —
--    which is why that total shifts when prose is rewrapped and is useless as a
--    pin. Before PART 6 existed the grep read 266 against a header claiming
--    265, and the extra one was a `--` comment a few lines above this; the
--    discrepancy sat there unreconciled. Split the count at the function
--    boundary. The method is proven by running the same split against 753 and
--    getting exactly 239, which is what 753's own note reports.
--    ⚠ THE DECOMPOSITION, BY STRUCTURE RATHER THAN BY NARRATIVE: probes 1-17
--    contribute 233 in both 753 and this file and are untouched here; probe 18
--    contributes 25; the rollback section goes 6 -> 7. 233 + 25 + 7 = 265.
--    ⚠ This line said 261 when the migration was first written, against a
--    measured 262, in the file whose central argument is that denominators must
--    be counted rather than typed. The fix round corrected it AND added three
--    assertions (probe 18(d2), below), which is where the other 3 come from.
--    If you change a probe, re-count all four sources rather than adjusting
--    whichever one is nearest.
--  * the rollback section
--    gains support_triage_rules — a surviving probe rule is not an inert row:
--    classify_support_text reads every active rule in the workspace on the first
--    user message of every support conversation.
--  * Everything else — the impersonation guard, probes 1-17 and the perimeter
--    block — is unchanged.
--
-- ⚠ It stays SECURITY INVOKER. `set local role` raises 42501 inside a
-- security-definer body, and the impersonation is the whole point.
--
-- ⚠⚠ AND IT IS ACTUALLY RUN AT APPLY TIME — see PART 6 at the foot of this
-- file. Creating a checker is not running one: as first written this migration
-- referenced verify_decide_discovery_proposal() exactly four times (the CREATE,
-- the COMMENT, the REVOKE and the GRANT) and CALLED IT ZERO TIMES, so it would
-- have applied silently whatever its eighteen probes said. 751, 752 and 753
-- each end with a block that calls it and raises on a finding; 751's caught its
-- own defect that way and rolled the whole file back.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.verify_decide_discovery_proposal()
 RETURNS text[]
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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

  -- ── added by 754, for probe 18 ──────────────────────────────────────────
  -- v_p18_topics is the FIXTURE the denominator is read off: every "expected"
  -- count in probe 18 is array_length(v_p18_topics, 1), never a literal. 752
  -- blocked on a probe that said 10 when it made 11.
  v_p18_topics      text[][];
  v_p18_expected    integer;
  v_p18_inserted    integer := 0;
  v_p18_accepted    integer := 0;
  v_p18_props       uuid[] := '{}';
  v_p18_rules       uuid[] := '{}';
  v_p18_prop        uuid;
  v_p18_rule        uuid;
  v_p18_rule_other  uuid;
  v_p18_ins_err     text[] := '{}';
  v_p18_acc_err     text[] := '{}';
  v_p18_first       jsonb;
  v_p18_rows        bigint;
  v_p18_cats        bigint;
  v_p18_ids         bigint;
  v_p18_orders      bigint;
  v_p18_cls_hit     text;
  v_p18_cls_miss    text;
  v_p18_cls_shadow  text;
  v_p18_dup_refused boolean;
  v_p18_dup_state   text;
  v_p18_new_ok      boolean;
  v_p18_new_err     text;
  -- ── added by the 754 FIX ROUND: the idempotency index, asked as a question.
  -- support_triage_rules_source_proposal_uq was described in this file as "the
  -- guarantee … enforced by the database rather than by the browser not
  -- clicking twice" and was pinned by NOTHING: a reviewer DROPPED it and got
  -- 18/18 probes, 262 assertions and zero findings. Probe 18(g2) drives the
  -- RPC's source_proposal_id CHECK, which is the stamp reading a column — not
  -- the database refusing a second row under the race the index exists for.
  v_p18_race_rule   uuid;
  v_p18_race_refused boolean;
  v_p18_race_state  text;
  v_p18_race_msg    text;
  v_p18_null_ok     boolean;
  v_p18_null_err    text;
  v_p18_own_n       bigint;
  v_p18_del_n       integer;
  v_p18_del_err     text;
  v_p18_still       bigint;
  v_p18_tagged      bigint;
  v_p18_untagged    bigint;
  v_p18_g1          text;
  v_p18_g2          text;
  v_p18_g3          text;
  v_p18_g4          text;
  v_p18_g5          text;
  v_p18_g5_order    integer;
  v_p18_g6          text;
  v_p18_g7          text;
  v_p18_g8          text;
  v_p18_user_refused boolean := false;
  v_p18_user_msg    text;
  v_p18_owner_ok    boolean := false;
  v_i               integer;
  v_d18             boolean := false;
  -- the rollback baseline for the table THIS probe writes into
  v_str_before      bigint;
  v_str_after       bigint;
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
  -- (752: repointed from `procedure` to `conversation_type`)
  v_p14_conv_ok     boolean;
  v_p14_conv_err    text;
  v_p14_conv_state  text;
  v_p14_conv_last   text;
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

  -- probe 16 (752) — the procedure path
  --
  -- ⚠ THE ORACLE, WRITTEN OUT. `v_p16_sop` is the SOP text the branch must
  -- compose from `v_p16_payload`, as a LITERAL. Re-composing it here with the
  -- branch's own expression would make the provenance check compare the
  -- composer with itself and stay green through any change of shape — the
  -- exam-vs-production trap. Change the labels, the bullet, the blank lines or
  -- the trim set in either copy and probe 16(a) goes red.
  v_p16_payload     jsonb := jsonb_build_object(
                       'vddp', '1',
                       'name', 'Chase an overdue invoice',
                       'trigger', 'an invoice goes 14 days past due',
                       'steps', jsonb_build_array('Check the account', 'Send the first reminder', 'Log the outcome'),
                       'note', 'draft; runs only when you publish');
  v_p16_sop         text  := E'Chase an overdue invoice\n\nRuns when: an invoice goes 14 days past due\n\nSteps:\n- Check the account\n- Send the first reminder\n- Log the outcome';
  v_p16_key         text;
  -- The leak arm's baseline and its EXPECTED SET. The expected number is not a
  -- literal: `v_p16_pb_own` is every playbook_definitions id this probe inserts,
  -- named once, and the arm compares the measured delta against how many of
  -- THOSE landed in this workspace. See the arm itself for what went wrong when
  -- the number was counted by hand instead.
  v_p16_pb_pre      bigint;
  v_p16_pb_pre_ids  uuid[];   -- the workspace's playbooks before probe 16, by id
  v_p16_pb_own      uuid[];   -- every row THIS probe inserts, both workspaces
  v_p16_pb_own_n    bigint;   -- ...how many of them landed in THIS workspace
  v_p16_pb_seen     bigint;   -- ...and how many of them exist at all
  v_p16_pb_extra_n  bigint;   -- rows that appeared and the probe did not insert
  v_p16_pb_extra    text;     -- ...named, with their keys
  v_p16_pb_delta    bigint;
  v_p16_de          uuid;     -- an employee, so the de_id decoy is a real row
  v_pb_def          uuid;     -- the draft the accept links
  v_pb_key_bad      uuid;     -- decoy: still under the drafter's random key
  v_pb_name_bad     uuid;     -- decoy: the compiling model's own title
  v_pb_pub          uuid;     -- decoy: already published
  v_pb_arch         uuid;     -- decoy: already archived
  v_pb_sop          uuid;     -- decoy: steps make it an `sop`, not a procedure
  v_pb_deid         uuid;     -- decoy: already assigned to an employee
  v_pb_nosteps      uuid;     -- decoy: no steps at all
  v_pb_nostudy      uuid;     -- decoy: no study row — no provenance
  v_pb_wrongstudy   uuid;     -- decoy: compiled from somebody else's words
  v_pb_other        uuid;     -- a real draft in ANOTHER workspace
  v_pb_rolebar      uuid;     -- the draft the role-bar pair share
  v_prop_d          uuid;
  v_prop_e          uuid;
  v_prop_f          uuid;
  v_prop_g          uuid;
  v_prop_h          uuid;
  v_prop_i          uuid;
  v_prop_j          uuid;
  v_prop_k          uuid;
  v_prop_l          uuid;
  v_prop_m          uuid;
  v_prop_n          uuid;
  v_prop_o          uuid;
  v_prop_p          uuid;
  v_prop_q          uuid;
  v_prop_r          uuid;     -- the long-name case
  -- ⚠ THE LONG-NAME CASE. `last_error` is `left(v_err, 500)`, the provenance
  -- refusal is 326 characters before the name goes in, and nothing caps the
  -- name on either side — so a name over 174 characters used to cut the closing
  -- sentence off the card, the one saying the draft exists, runs nothing, and
  -- can be archived. 228 characters, chosen to clear the 140-character display
  -- cap by enough that a truncation is unmistakable, with no trailing
  -- whitespace (btrim would take it) and no `%` or `_` (the assertions use
  -- position(), but a name that could be read as a LIKE pattern is a trap for
  -- whoever edits them next).
  v_p16_long_name   text := repeat('Chase every overdue invoice for the northern region and ', 4) || 'stop';
  v_pb_longname     uuid;     -- its draft: right key, right name, NO study
  v_p16_long_ok     boolean;
  v_p16_long_err    text;
  v_p16_long_last   text;
  v_p16_stamp_n     integer;
  v_p16_stamp_ok    boolean := false;
  v_p16_ok          boolean;
  v_p16_err         text;
  v_p16_state       text;
  v_p16_obj         uuid;
  v_p16_lasterr     text;
  v_p16_status      text;
  v_p16_kind        text;
  v_p16_deid        uuid;
  v_p16_defkey      text;
  v_p16_defname     text;
  v_p16_detail      jsonb;
  v_p16_run_n       bigint;
  v_p16_dework_n    bigint;
  v_p16_demiss_n    bigint;
  v_p16_run_pub_n   bigint;
  v_p16_arch_n      integer;
  v_p16_arch_status text;
  v_p16_again_ok    boolean;
  v_p16_again_err   text;
  v_p16_badkey_ok   boolean;
  v_p16_badkey_err  text;
  v_p16_badkey_last text;
  v_p16_badname_ok  boolean;
  v_p16_badname_err text;
  v_p16_pub_ok      boolean;
  v_p16_pub_err     text;
  v_p16_archd_ok    boolean;
  v_p16_archd_err   text;
  v_p16_sopk_ok     boolean;
  v_p16_sopk_err    text;
  v_p16_deid_ok     boolean;
  v_p16_deid_err    text;
  v_p16_nosteps_ok  boolean;
  v_p16_nosteps_err text;
  v_p16_nostudy_ok  boolean;
  v_p16_nostudy_err text;
  v_p16_nostudy_last text;
  v_p16_badsop_ok   boolean;
  v_p16_badsop_err  text;
  v_p16_other_ok    boolean;
  v_p16_other_err   text;
  v_p16_noname_ok   boolean;
  v_p16_noname_err  text;
  v_p16_notrig_ok   boolean;
  v_p16_notrig_err  text;
  v_p16_nopsteps_ok boolean;
  v_p16_nopsteps_err text;
  v_p16_short_ok    boolean;
  v_p16_short_err   text;
  v_p16_short_state text;
  v_p16_short_last  text;
  v_p16_short_att   integer;
  v_p16_nullid_ok   boolean;
  v_p16_nullid_err  text;
  v_p16_user_ref    boolean := false;
  v_p16_user_msg    text;
  v_p16_user_state  text;
  v_p16_three_n     bigint;
  v_p16_dup_refused boolean := false;
  v_p16_dup_state   text;
  v_leak_pb         bigint;
  v_d16             boolean := false;


  -- ════ added by 753 ═══════════════════════════════════════════════════════
  --
  -- ⚠ THE UNROUTABLE KIND IS DERIVED, NOT NAMED. Probes 7 and 14 have been
  -- repointed twice by swapping a literal — 751 off `guardrail`, 752 off
  -- `procedure` — and after this migration there is exactly ONE kind left that
  -- the CHECK admits and the router refuses. A third rename is impossible, and
  -- a probe that keeps running against a kind that has since gained a branch is
  -- the check-that-cannot-fail trap arrived at by accident.
  --
  -- So both probes now compute their subject: the kinds
  -- discovery_proposals_kind_check admits, MINUS every `when '<kind>' then` arm
  -- actually present in decide_discovery_proposal's body with its line comments
  -- stripped. Stripping is load-bearing — this file and that function both
  -- discuss `conversation_type` in prose, and an unstripped search would find
  -- the paragraph and conclude the kind is routed.
  --
  -- If that set comes back EMPTY the fixture guard reports a FINDING and both
  -- probes are skipped, which drops probes_completed below 18 and turns the
  -- section red with a message saying what to rebuild. That is the whole point.
  --
  -- ⚠ AND THAT DAY IS TODAY. This paragraph used to end "the day
  -- conversation_type ships, this goes red on purpose" — 754 is that ship, and
  -- what keeps the two probes drivable is the `__unrouted_probe__` sentinel
  -- added to the CHECK in PART 3, which no emitter writes and no card renders.
  -- The set is therefore non-empty for a reason that is deliberate rather than
  -- accidental, and deleting the sentinel is what makes it empty again.
  v_router_src      text;    -- decide_discovery_proposal's body, comments out
  v_kind_check      text;    -- the CHECK constraint, verbatim
  v_kinds_all       text[];  -- every kind the CHECK admits
  v_unrouted        text[];  -- ...minus the ones with a real `when` arm
  v_k               text;    -- the loop variable for probe 14

  -- probe 7, rebuilt around the derived kind
  v_p7_kind         text;
  v_p7_payload      jsonb;

  -- probe 14, rebuilt as a LOOP over every unrouted kind
  v_p14_unr_n       integer := 0;
  v_p14_unr_bad     text[]  := '{}';
  v_p14_unr_prop    uuid;
  v_p14_unr_ok      boolean;
  v_p14_unr_err     text;
  v_p14_unr_state   text;
  v_p14_unr_last    text;

  -- ════ probe 17 (753) — the trust_rule path ═══════════════════════════════
  --
  -- ⚠ THE ORACLE FOR "NOTHING CHANGES TODAY" IS A COUNT AND A COMPARISON, and
  -- both are INVERTED. A probe that only asserted "no de_autonomy row appeared"
  -- would be satisfied by a selector that never finds anything; a probe that
  -- only asserted "trust_ladder_settings(policy, 1) equals the built-in
  -- defaults" would be satisfied by two expressions that always agree. So each
  -- is driven the other way inside the same rolled-back block: trust_apply_level
  -- is called at level 1 on the very same scope and a dial MUST appear, and a
  -- ladder is written onto the very same policy and the settings MUST diverge.
  v_p17_de          uuid;    -- the employee the trust rule governs
  v_p17_de_other    uuid;    -- an employee in the OTHER workspace
  v_p17_prop_emp    uuid;    -- the employee proposal, accepted, that made it
  v_p17_pol         uuid;    -- the policy the accept links
  v_p17_pol_decoy   uuid;    -- a policy the interview never touched
  v_p17_pol_lvl     uuid;    -- a policy already above level 0
  v_p17_pol_lad     uuid;    -- a policy that already carries a ladder
  v_p17_pol_own     uuid[];  -- every trust_policies row THIS probe creates
  v_p17_pol_seen    bigint;
  v_p17_pol_pre     bigint;
  v_p17_pol_pre_ids uuid[];
  v_p17_pol_own_n   bigint;
  v_p17_pol_delta   bigint;
  v_p17_pol_extra_n bigint;
  v_p17_pol_extra   text;
  -- ⚠ THE FIXTURE CAP MOVED FROM '500' TO '80', AND THE OLD VALUE IS NOW A
  -- REFUSAL CASE (e14). `v_p17_cat` is 'answer_dock', which is on
  -- set_trust_ladder's CONFIDENCE side, so the shipped probe was driving the
  -- accept that must SUCCEED with a stated cap of 500% confidence and asserting
  -- it landed in the audit detail. The branch now range-checks a confidence cap
  -- against validate_trust_ladder's own 0-100 bound, so this value is the
  -- INVERSION of that check and 500 is the case that must be refused.
  v_p17_cap         text := '80';
  v_p17_cap_bad     text := '500';   -- ...the same number, now out of range
  v_p17_cat         text := 'answer_dock';
  v_p17_payload     jsonb;
  v_p17_ok          boolean;
  v_p17_err         text;
  v_p17_state       text;
  v_p17_obj         uuid;
  v_p17_lasterr     text;
  v_p17_detail      jsonb;
  v_p17_lvl         integer;
  v_p17_base        integer;
  v_p17_ladder      jsonb;
  v_p17_status      text;
  v_p17_polde       uuid;
  v_p17_polcat      text;
  v_p17_polsrc      text;
  -- the enforcement measurement, both directions
  v_p17_dial_pre    bigint;
  v_p17_dial_post   bigint;
  v_p17_dial_inv    bigint;
  -- ── the AUTOMATIC WIDENING chain, which nothing measured before. The accept
  -- does not enforce and does not promote, but it CREATES THE ROW the daily
  -- detector's lateral join needs, so the candidate side is measured on both
  -- sides of it: detector rows for THIS employee (0 -> 0) and trust_policies
  -- rows for THIS employee (0 -> 1). The second is what makes the first a
  -- comparison instead of a selector that always answers zero.
  v_p17_widen_pre   bigint;
  v_p17_widen_post  bigint;
  v_p17_empol_pre   bigint;
  v_p17_empol_post  bigint;
  v_p17_set_null    jsonb;   -- trust_ladder_settings(the accepted policy, 1)
  v_p17_set_dflt    jsonb;   -- trust_level_settings(category, 1)
  v_p17_set_lad     jsonb;   -- ...and the same policy WITH a ladder on it
  -- removability: the one door, driven in both directions
  v_p17_lad_set     jsonb;
  v_p17_lad_after   jsonb;
  v_p17_lad_clear   jsonb;
  v_p17_lad_final   jsonb;
  -- distinguishability: the round trip, both directions
  v_p17_prov_hit    bigint;
  v_p17_prov_cap    text;
  v_p17_prov_miss   bigint;
  -- the refusals
  v_prop_s          uuid;
  v_prop_t          uuid;
  v_prop_u          uuid;
  v_prop_v          uuid;
  v_prop_w          uuid;
  v_prop_x          uuid;
  v_prop_y          uuid;
  v_prop_z          uuid;
  v_prop_aa         uuid;
  v_prop_ab         uuid;
  v_prop_ac         uuid;
  v_prop_ad         uuid;
  v_prop_ae         uuid;
  v_prop_af         uuid;   -- (e14) a confidence cap of 500
  v_p17_nohire_ok   boolean;
  v_p17_nohire_err  text;
  v_p17_nohire_last text;
  v_p17_noprop_ok   boolean;
  v_p17_noprop_err  text;
  v_p17_unassign_ok boolean;
  v_p17_unassign_er text;
  v_p17_freetext_ok boolean;
  v_p17_freetext_er text;
  v_p17_nocat_ok    boolean;
  v_p17_nocat_err   text;
  v_p17_nocap_ok    boolean;
  v_p17_nocap_err   text;
  v_p17_prose_ok    boolean;
  v_p17_prose_err   text;
  v_p17_neg_ok      boolean;
  v_p17_neg_err     text;
  v_p17_conf_ok     boolean;
  v_p17_conf_err    text;
  v_p17_objid_ok    boolean;
  v_p17_objid_err   text;
  v_p17_lvl_ok      boolean;
  v_p17_lvl_err     text;
  v_p17_lvl_last    text;
  v_p17_lad_ok      boolean;
  v_p17_lad_err     text;
  v_p17_surf_ok     boolean;
  v_p17_surf_err    text;
  v_p17_cross_ok    boolean;
  v_p17_cross_err   text;
  v_p17_again_ok    boolean;
  v_p17_again_err   text;
  v_p17_user_ref    boolean := false;
  v_p17_user_msg    text;
  v_p17_user_state  text;
  -- the 740 identity-key model
  v_p17_one_n       bigint;
  v_p17_dup_refused boolean := false;
  v_p17_dup_state   text;
  v_p17_two_dims_n  bigint;
  -- the standing rollback arms this kind adds
  v_tp_before       bigint;
  v_tp_after        bigint;
  v_da_before       bigint;
  v_da_after        bigint;
  v_leak_tp         bigint;
  v_leak_da         bigint;
  v_d17             boolean := false;

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
      'note: probes_completed=0 probes_attempted=18 assertions=0 caller=%s — impersonation unavailable, nothing was compared', v_caller));
    return array_cat(v_bad, v_notes);
  end;

  if v_seen_role is distinct from 'authenticated' then
    v_bad := array_append(v_bad, format(
      'the role switch reported current_user=%L rather than authenticated — the probes below would not be running as the runtime role they claim to test',
      coalesce(v_seen_role, 'NULL')));
    v_notes := array_append(v_notes, format(
      'note: probes_completed=0 probes_attempted=18 assertions=0 caller=%s — role switch did not take effect', v_caller));
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
      'note: probes_completed=0 probes_attempted=18 assertions=0 caller=%s — fixtures missing, nothing was compared', v_caller));
    return array_cat(v_bad, v_notes);
  end if;

  ------------------------------------------------------------------------
  -- ⚠ 753 — THE UNROUTABLE KIND, DERIVED FROM LIVE STATE RATHER THAN NAMED.
  --
  -- Probes 7 and 14 exist to prove the router did NOT swing open when a kind
  -- was added. Both used to carry a literal, and both have already been
  -- repointed by editing that literal (751 off `guardrail`, 752 off
  -- `procedure`). After this migration exactly ONE kind is admitted by
  -- discovery_proposals_kind_check and routed by nothing, so a third rename has
  -- nothing to rename to — and a probe still driving a kind that has since
  -- gained a branch keeps running, keeps reporting, and compares nothing.
  --
  -- Computed here instead: the CHECK's own list, minus every `when '<kind>'
  -- then` arm really present in the router's body.
  --
  -- ⚠ COMMENTS STRIPPED, for the reason 752's ratchet gives: this function and
  -- that one both discuss `conversation_type` at length in prose, and an
  -- unstripped search would find a paragraph and conclude the kind is routed —
  -- silently emptying this set and taking both probes out.
  -- ⚠ AND READ WITH `position`, NOT `like`: `_` is LIKE's single-character
  -- wildcard and every kind here contains one, so `%when 'trust_rule' then%`
  -- would also match `when 'trustXrule' then`. `position` interprets nothing.
  ------------------------------------------------------------------------
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_router_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';

  select pg_get_constraintdef(c.oid) into v_kind_check
    from pg_constraint c
   where c.conrelid = 'public.discovery_proposals'::regclass
     and c.conname  = 'discovery_proposals_kind_check';

  if v_router_src is null or length(v_router_src) < 5000
     or position('case v_p.kind' in v_router_src) = 0
     or v_kind_check is null then
    -- Unreadable is NOT the same as empty, and a check that cannot tell them
    -- apart is not a check. Say which one failed.
    v_bad := array_append(v_bad, format(
      'the unroutable-kind derivation could not read what it needs: decide_discovery_proposal''s comment-stripped body came back %s character(s) and %s the `case v_p.kind` dispatch, and discovery_proposals_kind_check came back %L. Probes 7 and 14 drive whatever kind that derivation returns, so they are NOT RUN this time — they are not silently passing.',
      coalesce(length(v_router_src)::text, 'NULL'),
      case when coalesce(v_router_src, '') like '%case v_p.kind%' then 'contains' else 'does NOT contain' end,
      coalesce(left(coalesce(v_kind_check, ''), 120), 'NULL')));
    v_unrouted := '{}'::text[];
  else
    select coalesce(array_agg(m[1] order by m[1]), '{}'::text[])
      into v_kinds_all
      from regexp_matches(v_kind_check, '''([a-z_]+)''::text', 'g') m;

    select coalesce(array_agg(k order by k), '{}'::text[])
      into v_unrouted
      from unnest(coalesce(v_kinds_all, '{}'::text[])) k
     where position('when ''' || k || ''' then' in v_router_src) = 0;

    if coalesce(array_length(v_kinds_all, 1), 0) = 0 then
      v_bad := array_append(v_bad, format(
        'discovery_proposals_kind_check parsed to ZERO kinds (%L). The unroutable-kind derivation is reading a constraint whose shape it no longer understands, so probes 7 and 14 have nothing to drive and are not running.',
        left(v_kind_check, 200)));
    elsif coalesce(array_length(v_unrouted, 1), 0) = 0 then
      -- ⚠ THE DAY THIS FIRES IS THE DAY THE LAST KIND SHIPPED, AND IT IS
      -- SUPPOSED TO FIRE. It is not a false alarm and it must not be silenced
      -- by deleting probes 7 and 14: they are the only two things asserting
      -- that a refusal leaves a reason on the card, that `attempts` increments
      -- rather than being set, and that a twice-failed row can still be
      -- accepted once its kind becomes routable.
      v_bad := array_append(v_bad, format(
        'EVERY kind discovery_proposals_kind_check admits (%s) now has a `when ... then` arm in decide_discovery_proposal, so there is no unroutable kind left for probes 7 and 14 to drive and NEITHER RAN. This is the expected result of shipping the last kind, and the fix is not to delete those probes: probe 7 is the only place that proves a refusal leaves last_error on the row, that attempts INCREMENTS rather than being set, and that a twice-failed proposal can still be accepted afterwards; probe 14 is the only place that proves the router did not swing open for more kinds than were intended. Rebuild both against a different construction — a deliberately unrouted sentinel kind admitted by the CHECK, or a direct assertion about the `else` arm — and move probes_attempted with them.',
        array_to_string(coalesce(v_kinds_all, '{}'::text[]), ', ')));
    end if;
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
  -- ── added by 753. A trust rule OPENS a trust_policies row, and probe 17
  -- deliberately writes a de_autonomy row through trust_apply_level to invert
  -- its own zero. Without a baseline on both, the rollback assertion would
  -- report clean while a probe policy and a probe autonomy dial sat in a real
  -- customer's workspace — and a surviving dial is not an inert row: it is an
  -- enforced autonomy setting nobody agreed to.
  select count(*) into v_tp_before from public.trust_policies
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_da_before from public.de_autonomy
   where tenant_id in (v_tenant, v_other_tenant);
  -- ── added by 754. Probe 18 creates real triage rules under RLS in a real
  -- workspace, and a surviving one is not inert: classify_support_text reads
  -- every active rule in the tenant on the FIRST user message of every support
  -- conversation, so a leaked probe rule would re-file a customer's traffic
  -- under "vddp_delivery" on every certify run.
  select count(*) into v_str_before from public.support_triage_rules
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
  -- ⚠ ITS SUBJECT IS `__unrouted_probe__` AS OF 754, AND IT IS NOT NAMED HERE.
  -- The kind is DERIVED at run time by the fixtures block (v_unrouted: the
  -- values discovery_proposals_kind_check admits, minus the `when` arms really
  -- present in the router's comment-stripped body). After 754 every one of the
  -- six product kinds routes, so what that derivation returns is the sentinel
  -- added in PART 3 — a value nothing emits, no card renders and
  -- `authenticated` cannot insert. It is still a value the CHECK ACCEPTS, which
  -- is the property this probe needs: a refusal intercepted by an earlier
  -- constraint would prove nothing about the router.
  --
  -- ⚠⚠ THIS PARAGRAPH NAMED 'trust_rule' UNTIL THE FIX ROUND, one migration
  -- after 753 gave that kind a branch — the exact reading that let this probe
  -- go vacuous TWICE. It is left in full below because the history is the
  -- argument, but the subject line above is the one that is true today.
  --
  -- ⚠ REPOINTED BY 751, FROM 'guardrail'. This probe's fifteen assertions are
  -- all phrased against `kind not yet routable%`; the moment migration 751 gave
  -- `guardrail` a branch, every one of them would have been answering about the
  -- guardrail branch's OWN refusals (a missing pattern, a missing created id)
  -- while still reporting a probe and a clean result. That is a check that
  -- cannot fail, arrived at by accident rather than by design, and it is this
  -- repo's oldest mistake. 751 repointed it at `trust_rule` because contract §9
  -- ordered that kind LAST; 753 shipped trust_rule, 754 shipped
  -- conversation_type, and the repoint-by-rename move ran out of kinds exactly
  -- as probe 14's own header predicted it would. The DERIVATION plus the
  -- sentinel is what replaced it, and it needs no repointing ever again.
  -- Probe 14 fires every derived unrouted kind independently; the duplication
  -- is deliberate, because probe 14 asks "did the router swing open" and this
  -- one asks "does a refusal leave a readable reason and a moving counter".
  --
  -- Red if: an unroutable kind is silently accepted (worst case: 'accepted'
  -- with a null created_object_id); or the reason is not written down, which
  -- makes "the writer refused" indistinguishable from "nobody got to it"; or
  -- `attempts` does not move, so a card on its third failure looks like a
  -- card on its first.
  ------------------------------------------------------------------------
  begin
    -- 753: this probe used to name its kind ('guardrail', then 'trust_rule').
    -- It now drives whatever the fixtures block DERIVED as unrouted, and stops
    -- if there is nothing left — which the fixtures block has already reported
    -- as a FINDING naming what to rebuild. Not completing is what drops
    -- probes_completed below 18; it is never a silent skip.
    if coalesce(array_length(v_unrouted, 1), 0) = 0 then
      raise exception using errcode = 'P0001', message = '__undo_probe__';
    end if;
    v_p7_kind := v_unrouted[1];
    v_p7_payload := jsonb_build_object('vddp','1',
                      'label','vddp probe unrouted ' || v_p7_kind,
                      'owner_ref','archetype:' || v_arch_key,
                      'de_ref','archetype:' || v_arch_key,
                      'action_category','answer_dock','cap',80);
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, v_p7_kind, v_p7_payload, 'probe', v_dim, 'pending')
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
    -- not yet routable: <whatever the derivation returned>" at the same time,
    -- forever. This row has
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
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the routable sibling in the SAME session, decided by the SAME owner, was not accepted (state=%L). The unroutable-kind refusal is then not about the kind, and this probe is comparing nothing.', coalesce(v_p7_sibling_st,'NULL')));
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
  -- ⚠ WHAT IT FIRES TODAY: exactly ONE kind, `__unrouted_probe__`, and it is
  -- not named in this block either — the loop below walks whatever v_unrouted
  -- derived. After 754 BOTH kinds this paragraph used to name route to real
  -- tables (`trust_rule` since 753, `conversation_type` in this file), so the
  -- sentinel added in PART 3 is the whole of the set.
  --
  -- ⚠⚠ THE HISTORY, KEPT BECAUSE IT IS THE ARGUMENT. 752 recorded: "this fired
  -- `procedure` and `trust_rule`; `procedure` now routes, so that half would
  -- have been asserting that the procedure branch refuses a procedure — fifteen
  -- assertions still running and comparing nothing", and it warned that a
  -- repoint could not be a rename for much longer, because a probe built from
  -- "the two kinds nothing routes" cannot be built from one, let alone from
  -- none. That prediction came true one migration later. The answer was NOT
  -- another rename: it was the derivation (already in place since 753) plus a
  -- sentinel kind the CHECK admits and no product path can reach, so the probe
  -- keeps comparing something after the last real kind was wired. The trap it
  -- was written to avoid is closed rather than passed on.
  --
  -- 751's note on the probe-7 overlap still holds: the two probes ask different
  -- questions (this one, "is the router still shut"; probe 7, "does a refusal
  -- leave a reason and move the counter"), so the overlap is kept rather than
  -- tidied.
  --
  -- And the role bar, on the FIRST kind where passing it wrongly would create a
  -- real, billable object: probe 5 proves a tenant_user is refused a connector
  -- accept, where the object was already made by the browser. Here the RPC is
  -- the writer, so a hole in the bar means a member with no authority hires
  -- somebody.
  --
  -- Red if: ANY derived-unrouted kind silently accepts; or a refusal leaves no
  -- reason; or a tenant_user hires anyone; or the owner cannot hire on the same
  -- row, which would make the refusal a statement about the row and not the
  -- role. (This line named `procedure or trust_rule` until the fix round —
  -- both of them route now, and naming kinds here is the same staleness the
  -- loop below was built to remove.)
  ------------------------------------------------------------------------
  begin
    -- 753: nothing to drive if every admitted kind now routes. The fixtures
    -- block has already reported that as a FINDING naming what to rebuild, and
    -- this probe not completing is what drops probes_completed below 18.
    if coalesce(array_length(v_unrouted, 1), 0) = 0 then
      raise exception using errcode = 'P0001', message = '__undo_probe__';
    end if;

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    -- ⚠ EVERY unrouted kind, in a loop, rather than two named ones. There is
    -- one today; there were two before this migration and there will be none
    -- after the next. A loop is the only construction that stays honest across
    -- all three, and it removes the "repoint by rename" step entirely.
    -- The payload is a UNION of every kind's required shape, because the router
    -- refuses at the `else` arm BEFORE reading a payload at all — so what it
    -- carries cannot change the answer, and carrying a plausible one means a
    -- kind that gains a branch tomorrow fails on its own merits here rather
    -- than on a missing field.
    foreach v_k in array v_unrouted loop
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
        values (v_session, v_tenant, v_k,
                jsonb_build_object('vddp', '1',
                                   'label', 'vddp probe unrouted ' || v_k,
                                   'owner_ref', 'archetype:' || v_arch_key,
                                   'de_ref', 'archetype:' || v_arch_key,
                                   'action_category', 'answer_dock',
                                   'cap', 80),
                'probe', v_dim, 'pending')
        returning id into v_p14_unr_prop;

      perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
      set local role authenticated;
      v_res := public.decide_discovery_proposal(v_p14_unr_prop, 'accepted', 'route it', null);
      execute format('set local role %I', v_caller);
      v_p14_unr_ok  := (v_res ->> 'ok')::boolean;
      v_p14_unr_err := v_res ->> 'error';
      select state, last_error into v_p14_unr_state, v_p14_unr_last
        from public.discovery_proposals where id = v_p14_unr_prop;

      if coalesce(v_p14_unr_ok, true) or coalesce(v_p14_unr_err, '') not like 'kind not yet routable%' then
        v_p14_unr_bad := array_append(v_p14_unr_bad, format(
          '%L was ACCEPTED by a router that has no `when %L then` arm (ok=%L error=%L)',
          v_k, v_k, coalesce(v_p14_unr_ok::text, 'NULL'), coalesce(v_p14_unr_err, 'NULL')));
      end if;
      if v_p14_unr_state is distinct from 'pending' or v_p14_unr_last is null then
        v_p14_unr_bad := array_append(v_p14_unr_bad, format(
          '%L was refused but sits at %L with last_error=%L — a card that will not become a thing must say why, and still say why tomorrow',
          v_k, coalesce(v_p14_unr_state, 'NULL'), coalesce(v_p14_unr_last, 'NULL')));
      end if;
      v_p14_unr_n := v_p14_unr_n + 1;
    end loop;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', v_arch_key,
                                 'name', 'vddp probe employee role-bar'),
              'probe', v_dim, 'pending')
      returning id into v_prop_other;

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
      v_bad := array_append(v_bad, format('PROBE 14 ABORTED before it could finish (%s: %s) — "every kind the CHECK admits and the router does not route still refuses" and "a tenant_user cannot hire" were NOT compared this run', sqlstate, sqlerrm));
      v_d14 := false;
    end if;
  end;

  if v_d14 then
    v_probes_done := v_probes_done + 1;

    -- ⚠ THE DENOMINATOR FIRST. "No kind was wrongly accepted" is satisfied by
    -- having driven no kinds at all, which is exactly what a silently-emptied
    -- derivation would produce. This arm is what stops that: the loop must have
    -- driven EVERY kind the derivation returned, and the derivation must have
    -- returned at least one.
    v_checks := v_checks + 1;
    if coalesce(array_length(v_unrouted, 1), 0) = 0
       or v_p14_unr_n <> coalesce(array_length(v_unrouted, 1), 0) then
      v_bad := array_append(v_bad, format(
        'the router-still-shut arm drove %s of %s unrouted kind(s) (%s). Zero comparisons look exactly like a clean result, and this probe''s whole subject is derived — so if the derivation came back empty or the loop stopped early, nothing below is a statement about anything.',
        v_p14_unr_n, coalesce(array_length(v_unrouted, 1), 0),
        array_to_string(coalesce(v_unrouted, '{}'::text[]), ', ')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(array_length(v_p14_unr_bad, 1), 0) > 0 then
      v_bad := array_append(v_bad, format(
        'THE ROUTER SWUNG OPEN FURTHER THAN INTENDED — %s finding(s) across the kinds discovery_proposals_kind_check admits and decide_discovery_proposal does not route: %s. Adding a `when` branch to a CASE is one line away from adding two, and a kind that is accepted with no writer behind it is a no-op wearing an accept button.',
        array_length(v_p14_unr_bad, 1), array_to_string(v_p14_unr_bad, ' | ')));
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
    -- ⚠ A FRESH SESSION, because production can only ever hold ONE guardrail
    -- proposal per interview. Migration 740's unique (session_id, kind,
    -- identity_key) generates identity_key as `source_dimension` for every kind
    -- except employee and connector, so two guardrail proposals in one session
    -- collide on 23505 — which is exactly what aborted this probe on its first
    -- apply, 14 of 15 probes done and 138 of 169 assertions compared.
    -- The INDEX is right and the probe was wrong: discoveryProposals.ts's
    -- DIMENSION_STRUCTURAL_KINDS maps exactly one dimension to guardrail
    -- (must_never_happen) and emits exactly one draft for it. Giving each case
    -- its own source_dimension would also dodge the index, but it would model a
    -- shape the writer cannot emit; a separate session is the true one.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
    -- a fresh session — see the note at the first of these
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
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
  -- PROBE 16 (752) — THE PROCEDURE PATH.
  --
  -- The drafter's half is performed HERE as the CALLER (service_role), because
  -- that is the role that really writes these two rows: `playbook-draft`
  -- authenticates the JWT and then inserts the definition and upserts the study
  -- with its SERVICE-ROLE client. The BROWSER's half is one update — `key` and
  -- `name` — and that one is performed as the real runtime role `authenticated`
  -- with a real owner's uid, so the table grant and
  -- `playbook_definitions_tenant_write` are exercised rather than assumed.
  -- (What is NOT exercised is the edge function: the compile, the validator
  -- loop, the budget gate. It is Deno and needs a live model; this migration's
  -- header says so before the probes rather than after.)
  --
  -- ⚠ THE INVERSION IS FIRST, and everything else is paired against it. One
  -- accept SUCCEEDS — same owner, same workspace — so "the procedure branch
  -- refuses everything" and "the procedure branch checks what it is handed" are
  -- distinguishable. Sixteen refusals follow, each differing from that success
  -- in exactly ONE respect:
  --     a draft still under the drafter's random key   (the anti-duplication pin)
  --     a draft under the compiling model's own name   (the card named it)
  --     a draft already published                      (the card's one promise)
  --     a draft already archived                       (the same arm, other side)
  --     a draft whose steps make it an `sop`           (the other engine)
  --     a draft already assigned to an employee        (it is nobody's work yet)
  --     a draft with no steps                          (nothing to review)
  --     a draft with no study row                      (provenance)
  --     a draft whose study text is somebody else's    (§11b, byte for byte)
  --     a draft in ANOTHER workspace                   (id != authorisation)
  --     a good payload with nothing drafted            (Path B's own shape)
  --     a payload with no name / no trigger / no steps (nothing to draft from)
  --     a payload too short to draft from              (the drafter's own floor)
  --     a 228-CHARACTER PROCEDURE NAME                 (the refusal must survive
  --                                                     `left(v_err, 500)` whole)
  --     a tenant_user                                  (the role bar)
  -- and a second accept on the decided row (the compare-and-swap).
  --
  -- ⚠ THE EXPECTED SOP TEXT IS A LITERAL HERE, NOT A RE-COMPOSITION. If this
  -- probe built it with the same expression the branch uses, the two would move
  -- together and the provenance check would be comparing the composer with
  -- itself — exam-vs-production evidence, green through any change of shape.
  -- Written out, this probe is an INDEPENDENT ORACLE for the composer: change
  -- the labels, the bullet, the blank lines or the trim set and 16(a) goes red.
  --
  -- ⚠ AND REACHABILITY IS MEASURED, NOT ASSERTED. 16(b) runs THREE of the
  -- header's eight published gates as selectors against the row this accept
  -- created and requires 0 from each — then PUBLISHES the row and requires 1,
  -- because a zero from a selector that returns zero for everything proves
  -- nothing at all. The other five gates (playbook-execute:655, :2952, and the
  -- three SQL arms in dispatch_due_triggers and emit_tenant_event) read the
  -- same column with the same predicate and are not driven here.
  --
  -- ⚠ AND THE CUSTOMER CAN TAKE IT BACK OFF. 16(c) archives the draft through
  -- the same plain update `updateDefinition` makes, as the owner under RLS.
  -- There is no pack key and no system flag on this table to refuse — 751's
  -- `compliance_pack_key is null` has no analogue here — so the removal is
  -- driven rather than argued from a column. It is driven as the OWNER; that
  -- `playbook_definitions_tenant_write` also admits a tenant_manager — a wider
  -- set than this function's accept bar — is read off the policy in the header
  -- and not run here.
  --
  -- ⚠ AND THE 740 UNIQUE INDEX IS DRIVEN IN BOTH DIRECTIONS. `identity_key` is
  -- `source_dimension` for procedure, and DIMENSION_STRUCTURAL_KINDS maps THREE
  -- dimensions to it (money_in, how_work_gets_delivered, repetitive_work), each
  -- emitting one draft. So three procedure proposals in one session is the REAL
  -- shape and must be admitted; a fourth repeating a dimension must collide.
  -- Modelling only the first half would have hidden the index; modelling only
  -- the second would have described a session the emitter cannot produce.
  --
  -- Red if: a procedure accept refuses everything; or any of the sixteen is
  -- accepted; or the stamped draft is anything other than the unassigned,
  -- unpublished, correctly-keyed and correctly-named `procedure` draft carrying
  -- the customer's own words; or a refusal leaves no reason on the row; or the
  -- longest refusal loses its closing sentence to `left(v_err, 500)`; or a
  -- playbook appears in the workspace that this probe did not insert (the leak
  -- arm, whose expected set is enumerated rather than counted by hand).
  ------------------------------------------------------------------------
  begin
    -- The baseline is taken as BOTH a count and a set of ids: the count says
    -- how far the number moved, the ids say WHICH rows are new, and only the
    -- second can name a row that appeared behind the probe's back.
    select count(*), coalesce(array_agg(d.id), '{}'::uuid[])
      into v_p16_pb_pre, v_p16_pb_pre_ids
      from public.playbook_definitions d where d.tenant_id = v_tenant;

    -- ── (a) THE INVERSION ────────────────────────────────────────────────
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop;

    -- the drafter's two writes, as the CALLER — the role playbook-draft uses.
    -- The key is the `<slug>_<random6>` shape playbook-draft mints (:623) and
    -- the name is the COMPILING MODEL's own title (:622), which is exactly the
    -- pair the browser then has to stamp over.
    insert into public.playbook_definitions
      (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'vddp_probe_chase_overdue_a1b2c3', 'vddp probe — the model''s own title',
              'vddp probe procedure', 1, 'draft',
              '[{"key":"check_account"},{"key":"instruction","label":"Send the reminder","params":{"title":"Send it","body_md":"send"}},{"key":"complete"}]'::jsonb,
              'manual', null)
      returning id into v_pb_def;
    insert into public.playbook_studies
      (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_def, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- ── THE BROWSER'S ONE WRITE, under RLS, as the signed-in owner ───────
    -- `steps` is deliberately untouched: playbook_steps_guard returns early
    -- when it is, so this update neither trips invalid_step_shape nor writes a
    -- second steps-changed audit event.
    v_p16_key := 'discovery_' || replace(v_prop::text, '-', '');
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    update public.playbook_definitions
       set key = v_p16_key, name = 'Chase an overdue invoice'
     where id = v_pb_def and tenant_id = v_tenant;
    get diagnostics v_p16_stamp_n = row_count;
    execute format('set local role %I', v_caller);
    v_p16_stamp_ok := coalesce(v_p16_stamp_n, 0) = 1;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'draft it', v_pb_def);
    execute format('set local role %I', v_caller);
    v_p16_ok  := (v_res ->> 'ok')::boolean;
    v_p16_err := v_res ->> 'error';
    select state, created_object_id, last_error into v_p16_state, v_p16_obj, v_p16_lasterr
      from public.discovery_proposals where id = v_prop;
    select status, kind, de_id, key, name
      into v_p16_status, v_p16_kind, v_p16_deid, v_p16_defkey, v_p16_defname
      from public.playbook_definitions where id = v_pb_def;
    select a.detail into v_p16_detail
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc limit 1;

    -- ── (b) REACHABILITY, MEASURED IN BOTH DIRECTIONS ───────────────────
    -- THREE of the header's eight published gates, transcribed as selectors
    -- from the live callers. The other five (playbook-execute:655's
    -- sub-playbook child, :2952's sync_knowledge, and the three SQL arms in
    -- dispatch_due_triggers and emit_tenant_event) read the same column with
    -- the same predicate and are not driven here — said plainly in the header's
    -- "does not prove" list rather than implied by their absence.
    --   playbook-execute:2428        status must be 'published'
    --   de-work:213-216              de_id + status published + kind sop
    --   de-mission:108               de_id + status published
    select count(*) into v_p16_run_n from public.playbook_definitions d
      where d.id = v_pb_def and d.tenant_id = v_tenant and d.status = 'published';
    select count(*) into v_p16_dework_n from public.playbook_definitions d
      where d.id = v_pb_def and d.tenant_id = v_tenant
        and d.de_id is not null and d.status = 'published' and d.kind = 'sop';
    select count(*) into v_p16_demiss_n from public.playbook_definitions d
      where d.id = v_pb_def and d.tenant_id = v_tenant
        and d.de_id is not null and d.status = 'published';
    -- THE INVERSION FOR THE ZEROES. A selector that returns 0 for everything
    -- would satisfy all three above while proving nothing. Publish the row and
    -- the first one must find it.
    update public.playbook_definitions set status = 'published' where id = v_pb_def;
    select count(*) into v_p16_run_pub_n from public.playbook_definitions d
      where d.id = v_pb_def and d.tenant_id = v_tenant and d.status = 'published';
    update public.playbook_definitions set status = 'draft' where id = v_pb_def;

    -- ── (c) …AND THE CUSTOMER CAN TAKE IT BACK OFF ──────────────────────
    -- The same plain update updateDefinition (src/lib/playbookBuilderApi.ts)
    -- makes, as the owner under RLS. Nothing on this table can refuse it.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    update public.playbook_definitions set status = 'archived'
     where id = v_pb_def and tenant_id = v_tenant;
    get diagnostics v_p16_arch_n = row_count;
    execute format('set local role %I', v_caller);
    select status into v_p16_arch_status from public.playbook_definitions where id = v_pb_def;
    update public.playbook_definitions set status = 'draft' where id = v_pb_def;

    -- ── (d) a second accept on the decided row ──────────────────────────
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'again', v_pb_def);
    execute format('set local role %I', v_caller);
    v_p16_again_ok  := (v_res ->> 'ok')::boolean;
    v_p16_again_err := v_res ->> 'error';

    -- ── (e) THE DRAFT DECOYS. One proposal each, one fresh session each ──
    -- ⚠ EVERY decoy is stamped with ITS OWN proposal's deterministic key and
    -- the agreed name FIRST, and only then mutated in the one respect under
    -- test. Without that they would all trip the key arm and every check below
    -- it would be comparing nothing — the vacuity that cost 751 a round.
    -- The one exception is (e1), whose whole subject IS the key.
    -- The employee for (e6) is hired through the ordinary writer; it is tagged
    -- for the standing leak check and rolled back with everything else.
    v_p16_de := public.instantiate_role_archetype(
                  v_tenant, v_arch_key, 'vddp probe employee for a procedure', null);

    -- (e1) still under the drafter's random key
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_b;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'vddp_probe_unstamped_key_9f9f9f', 'Chase an overdue invoice', 'vddp probe procedure', 1, 'draft',
              '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_key_bad;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_key_bad, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- (e2) the compiling model's own name, correct key
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_c;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_c::text, '-', ''),
              'vddp probe — Overdue Invoice Collections Workflow', 'vddp probe procedure', 1, 'draft',
              '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_name_bad;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_name_bad, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- (e3) already published  (e4) already archived  (e5) an `sop`
    -- (e6) assigned to an employee  (e7) no steps  (e8) no study
    -- (e9) somebody else's study text  (e10) another workspace
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_d;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_d::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'published', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_pub;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_pub, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_e;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_e::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'archived', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_arch;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_arch, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- `kind` is DERIVED by trigger from the steps: a step carrying
    -- kind='use_tool' makes this an 'sop', which de-work owns and
    -- playbook-execute refuses. The column is never written directly.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_f;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_f::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft',
              '[{"key":"do_the_thing","kind":"use_tool"},{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_sop;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_sop, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_g;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_g::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', v_p16_de)
      returning id into v_pb_deid;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_deid, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_h;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_h::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[]'::jsonb, 'manual', null)
      returning id into v_pb_nosteps;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_nosteps, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- no study row at all — the shape a discarded upsert error leaves behind
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_i;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_i::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_nostudy;

    -- a study whose text is a DIFFERENT customer's description — everything the
    -- browser controls is right and the draft was compiled from other words
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_j;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_j::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_wrongstudy;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_wrongstudy,
              'Something else entirely, long enough to clear the forty-character floor on its own.',
              '{}'::jsonb, 'vddp-probe', 0, 0);

    -- ANOTHER WORKSPACE. Right key, right name, right study — and not this
    -- customer's. A created-object id is not its own authorisation.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_k;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_other_tenant, 'discovery_' || replace(v_prop_k::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_other;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_other_tenant, v_pb_other, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    -- (e11) A 228-CHARACTER NAME, driven through the PROVENANCE refusal — the
    -- longest message this branch can write and the one that has to survive
    -- whole. The draft carries the right key and the full name (byte-identical,
    -- or the accept would stop at the name check instead) and no study row, so
    -- the refusal fires with a real draft sitting in the workspace. What is
    -- asserted below is that the closing sentence is still on the row.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp','1','name', v_p16_long_name,
                                 'trigger','an invoice goes 14 days past due',
                                 'steps', jsonb_build_array('Check the account')),
              'probe', v_dim, 'pending')
      returning id into v_prop_r;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_r::text, '-', ''), v_p16_long_name,
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_longname;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_b, 'accepted', 'unstamped key', v_pb_key_bad);
    v_p16_badkey_ok  := (v_res ->> 'ok')::boolean;
    v_p16_badkey_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_c, 'accepted', 'model renamed it', v_pb_name_bad);
    v_p16_badname_ok  := (v_res ->> 'ok')::boolean;
    v_p16_badname_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_d, 'accepted', 'already published', v_pb_pub);
    v_p16_pub_ok  := (v_res ->> 'ok')::boolean;
    v_p16_pub_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_e, 'accepted', 'already archived', v_pb_arch);
    v_p16_archd_ok  := (v_res ->> 'ok')::boolean;
    v_p16_archd_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_f, 'accepted', 'it is an sop', v_pb_sop);
    v_p16_sopk_ok  := (v_res ->> 'ok')::boolean;
    v_p16_sopk_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_g, 'accepted', 'already assigned', v_pb_deid);
    v_p16_deid_ok  := (v_res ->> 'ok')::boolean;
    v_p16_deid_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_h, 'accepted', 'no steps', v_pb_nosteps);
    v_p16_nosteps_ok  := (v_res ->> 'ok')::boolean;
    v_p16_nosteps_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_i, 'accepted', 'no study', v_pb_nostudy);
    v_p16_nostudy_ok  := (v_res ->> 'ok')::boolean;
    v_p16_nostudy_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_j, 'accepted', 'wrong study', v_pb_wrongstudy);
    v_p16_badsop_ok  := (v_res ->> 'ok')::boolean;
    v_p16_badsop_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_k, 'accepted', 'another workspace', v_pb_other);
    v_p16_other_ok  := (v_res ->> 'ok')::boolean;
    v_p16_other_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_r, 'accepted', 'a very long name', v_pb_longname);
    v_p16_long_ok  := (v_res ->> 'ok')::boolean;
    v_p16_long_err := v_res ->> 'error';
    execute format('set local role %I', v_caller);
    select last_error into v_p16_badkey_last from public.discovery_proposals where id = v_prop_b;
    select last_error into v_p16_nostudy_last from public.discovery_proposals where id = v_prop_i;
    select last_error into v_p16_long_last  from public.discovery_proposals where id = v_prop_r;

    -- ── (f) THE PAYLOAD REFUSALS. Nothing is drafted for any of these, so the
    -- object id is null and the refusal is the branch's own. ───────────────
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp','1','name',null,'trigger','an invoice goes 14 days past due',
                                 'steps', jsonb_build_array('Check the account')),
              'probe', v_dim, 'pending')
      returning id into v_prop_l;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp','1','name','Chase an overdue invoice','trigger',null,
                                 'steps', jsonb_build_array('Check the account')),
              'probe', v_dim, 'pending')
      returning id into v_prop_m;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp','1','name','Chase an overdue invoice',
                                 'trigger','an invoice goes 14 days past due',
                                 'steps', jsonb_build_array('   ', '')),
              'probe', v_dim, 'pending')
      returning id into v_prop_n;
    -- 34 characters composed, against the drafter's floor of 40
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure',
              jsonb_build_object('vddp','1','name','Do it','trigger','now',
                                 'steps', jsonb_build_array('go')),
              'probe', v_dim, 'pending')
      returning id into v_prop_o;
    -- a GOOD payload with nothing drafted — Path B's own shape
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_p;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_l, 'accepted', 'no name', null);
    v_p16_noname_ok  := (v_res ->> 'ok')::boolean;
    v_p16_noname_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_m, 'accepted', 'no trigger', null);
    v_p16_notrig_ok  := (v_res ->> 'ok')::boolean;
    v_p16_notrig_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_n, 'accepted', 'no steps in the payload', null);
    v_p16_nopsteps_ok  := (v_res ->> 'ok')::boolean;
    v_p16_nopsteps_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_o, 'accepted', 'too short', null);
    v_p16_short_ok  := (v_res ->> 'ok')::boolean;
    v_p16_short_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_p, 'accepted', 'nothing drafted', null);
    v_p16_nullid_ok  := (v_res ->> 'ok')::boolean;
    v_p16_nullid_err := v_res ->> 'error';
    execute format('set local role %I', v_caller);
    select state, last_error, attempts into v_p16_short_state, v_p16_short_last, v_p16_short_att
      from public.discovery_proposals where id = v_prop_o;

    -- ── (g) the role bar, and its inversion on the SAME row ─────────────
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', v_dim, 'pending')
      returning id into v_prop_q;
    insert into public.playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
      values (v_tenant, 'discovery_' || replace(v_prop_q::text, '-', ''), 'Chase an overdue invoice',
              'vddp probe procedure', 1, 'draft', '[{"key":"complete"}]'::jsonb, 'manual', null)
      returning id into v_pb_rolebar;
    insert into public.playbook_studies (tenant_id, definition_id, sop_text, report, model_id, input_tokens, output_tokens)
      values (v_tenant, v_pb_rolebar, v_p16_sop, '{}'::jsonb, 'vddp-probe', 0, 0);

    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_q, 'accepted', 'can I?', v_pb_rolebar);
    exception when others then
      v_p16_user_ref := true;
      v_p16_user_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    -- THE INVERSION, same row, same draft id: only the actor changed.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_q, 'accepted', 'the owner can', v_pb_rolebar);
    execute format('set local role %I', v_caller);
    select state into v_p16_user_state from public.discovery_proposals where id = v_prop_q;

    -- ── (h) THE 740 INDEX, BOTH DIRECTIONS ──────────────────────────────
    -- identity_key is source_dimension for procedure, and three dimensions
    -- emit one procedure draft each. Three in one session is the real shape.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', 'money_in', 'pending');
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', 'how_work_gets_delivered', 'pending');
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', 'repetitive_work', 'pending');
    select count(*) into v_p16_three_n from public.discovery_proposals
     where session_id = v_session and kind = 'procedure';
    -- ...and a FOURTH repeating a dimension must collide. Nested, because a
    -- 23505 reaching the probe's own handler would abort it — which is exactly
    -- how this trap took down probe 15 on its first apply.
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
        values (v_session, v_tenant, 'procedure', v_p16_payload, 'probe', 'money_in', 'pending');
    exception when unique_violation then
      v_p16_dup_refused := true;
      v_p16_dup_state   := sqlstate;
    end;

    -- ⚠ THE EXPECTED NUMBER IS ENUMERATED, NOT COUNTED BY HAND. This arm first
    -- carried the literal 10 — the ten (e) decoys, added up by reading the
    -- section headings — and missed (g)'s role-bar draft at the bottom of the
    -- probe. The probe's own eleventh insert therefore read as
    -- decide_discovery_proposal having drafted a playbook, and the migration
    -- would not apply. Bumping 10 to 11 would have made the number right by
    -- coincidence, which is the thing this arm exists to prevent — so the
    -- expected count is now read off THESE ROWS. Every id the probe inserts is
    -- named here once, in both workspaces; `v_pb_other` is the one that lands
    -- in v_other_tenant, and the arm below counts how many are in v_tenant
    -- rather than assuming.
    v_p16_pb_own := array[v_pb_def, v_pb_key_bad, v_pb_name_bad, v_pb_pub,
                          v_pb_arch, v_pb_sop, v_pb_deid, v_pb_nosteps,
                          v_pb_nostudy, v_pb_wrongstudy, v_pb_other,
                          v_pb_longname, v_pb_rolebar];
    select count(*) - v_p16_pb_pre into v_p16_pb_delta
      from public.playbook_definitions where tenant_id = v_tenant;
    -- `array_remove(…, null)`, because `id = any(array[…, null])` is NULL for a
    -- non-matching row, and `not NULL` would drop that row out of the extras
    -- query — a null slot would hide exactly the row it caused.
    select count(*) into v_p16_pb_own_n from public.playbook_definitions d
     where d.tenant_id = v_tenant and d.id = any(array_remove(v_p16_pb_own, null));
    select count(*) into v_p16_pb_seen from public.playbook_definitions d
     where d.id = any(array_remove(v_p16_pb_own, null));
    -- ...and anything that appeared that the probe did not insert, NAMED with
    -- its key. A decoy added later and not listed above lands here rather than
    -- being folded into a number, so the message says which row moved it.
    select count(*), string_agg(format('%s (key=%L, status=%L)', d.id, d.key, d.status), '; ')
      into v_p16_pb_extra_n, v_p16_pb_extra
      from public.playbook_definitions d
     where d.tenant_id = v_tenant
       and not (d.id = any(v_p16_pb_pre_ids))
       and not (d.id = any(array_remove(v_p16_pb_own, null)));

    v_d16 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 16 ABORTED before it could finish (%s: %s) — the procedure accept, the reachability of what it creates, its removability, the sixteen refusals and the 740 identity-key model were NOT compared this run', sqlstate, sqlerrm));
      v_d16 := false;
    end if;
  end;

  if v_d16 then
    v_probes_done := v_probes_done + 1;

    -- askability first: if the browser's one write could not land, nothing
    -- below is about anything.
    v_checks := v_checks + 1;
    if not v_p16_stamp_ok then
      v_bad := array_append(v_bad, format('the browser''s key+name stamp on the draft did not land as `authenticated` under RLS (%s row(s) updated). That single update is the whole of the browser''s write on this path — the deterministic key and the agreed name both ride on it — so if it fails here it fails there, and every assertion below is about a row that was never stamped.', coalesce(v_p16_stamp_n::text, 'NULL')));
    end if;

    v_checks := v_checks + 1;
    if not coalesce(v_p16_ok, false) or v_p16_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: a well-formed procedure was not accepted (ok=%L state=%L error=%L). Every refusal below is then a statement about a branch that refuses everything, which is not a gate.', coalesce(v_p16_ok::text,'NULL'), coalesce(v_p16_state,'NULL'), coalesce(v_p16_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p16_obj is distinct from v_pb_def or v_p16_lasterr is not null then
      v_bad := array_append(v_bad, format('the accepted procedure links created_object_id=%L (expected the draft %L) with last_error=%L — state and the link commit together or neither is observable', coalesce(v_p16_obj::text,'NULL'), v_pb_def::text, coalesce(v_p16_lasterr,'NULL')));
    end if;
    -- the accept must not have touched the draft it linked
    v_checks := v_checks + 1;
    if v_p16_status is distinct from 'draft' or v_p16_kind is distinct from 'procedure'
       or v_p16_deid is not null or v_p16_defkey is distinct from v_p16_key
       or v_p16_defname is distinct from 'Chase an overdue invoice' then
      v_bad := array_append(v_bad, format('after the accept the draft reads status=%L kind=%L de_id=%L key=%L name=%L — it must still be the unassigned, unpublished, correctly-keyed `procedure` draft the card described. An accept that publishes or assigns what it links has made the card''s one promise false at the moment of the click.',
        coalesce(v_p16_status,'NULL'), coalesce(v_p16_kind,'NULL'), coalesce(v_p16_deid::text,'null'),
        coalesce(v_p16_defkey,'NULL'), coalesce(v_p16_defname,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_detail ->> 'created_object_table', '') <> 'playbook_definitions'
       or (v_p16_detail ->> 'playbook_key') is distinct from v_p16_key
       or coalesce((v_p16_detail ->> 'steps_drafted')::integer, -1) <> 3 then
      v_bad := array_append(v_bad, format('the audit detail for the accepted procedure reads table=%L key=%L steps_drafted=%L — the screen''s answer and the ledger''s are built from ONE object so they cannot disagree, and a bare uuid with no table name is not reconstructable later',
        coalesce(v_p16_detail ->> 'created_object_table','NULL'), coalesce(v_p16_detail ->> 'playbook_key','NULL'), coalesce(v_p16_detail ->> 'steps_drafted','NULL')));
    end if;

    -- (b) reachability, and the inversion that stops the zeroes being vacuous
    v_checks := v_checks + 1;
    if coalesce(v_p16_run_n, -1) <> 0 or coalesce(v_p16_dework_n, -1) <> 0 or coalesce(v_p16_demiss_n, -1) <> 0 then
      v_bad := array_append(v_bad, format('THE DRAFT THIS ACCEPT CREATED IS REACHABLE BY AN EXECUTOR — playbook-execute''s published filter matched %s, de-work''s SOP selector matched %s, de-mission''s playbook list matched %s (expected 0, 0, 0). The card says "nothing runs until you publish it", and the whole reason this kind ships before trust_rule is that the thing it creates does not act.',
        coalesce(v_p16_run_n::text,'NULL'), coalesce(v_p16_dework_n::text,'NULL'), coalesce(v_p16_demiss_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_run_pub_n, -1) <> 1 then
      v_bad := array_append(v_bad, format('THE REACHABILITY INVERSION FAILED: publishing the very same row and re-running playbook-execute''s own selector matched %L, expected 1. The three zeroes above are then a statement about a selector that finds nothing rather than about a draft that runs nothing.', coalesce(v_p16_run_pub_n::text,'NULL')));
    end if;

    -- (c) removability, driven
    v_checks := v_checks + 1;
    if coalesce(v_p16_arch_n, 0) <> 1 or v_p16_arch_status is distinct from 'archived' then
      v_bad := array_append(v_bad, format('THE CUSTOMER COULD NOT TAKE IT BACK OFF: archiving the accepted draft as the workspace owner, through the same plain update updateDefinition makes, changed %s row(s) and left status=%L. A procedure somebody accepted and cannot remove is the defect migration 747 spent itself fixing on the other side of guardrail_rules.',
        coalesce(v_p16_arch_n::text,'NULL'), coalesce(v_p16_arch_status,'NULL')));
    end if;

    -- (d) the compare-and-swap
    v_checks := v_checks + 1;
    if coalesce(v_p16_again_ok, true) or coalesce(v_p16_again_err, '') <> 'already_decided' then
      v_bad := array_append(v_bad, format('a second accept on the decided procedure returned ok=%L error=%L, expected already_decided — the compare-and-swap is the double-click guard and it is what stops a second draft', coalesce(v_p16_again_ok::text,'NULL'), coalesce(v_p16_again_err,'NULL')));
    end if;

    -- (e) the ten draft decoys
    v_checks := v_checks + 1;
    if coalesce(v_p16_badkey_ok, true) or coalesce(v_p16_badkey_err, '') not like '%two copies of the same procedure%' then
      v_bad := array_append(v_bad, format('a draft still under the DRAFTER''S OWN random key was stamped (ok=%L error=%L). That key is what makes a retry re-use the first draft instead of minting a twin — without this refusal, an accept that crashed after drafting and was clicked again leaves the customer with two identical procedures and no way to tell which one is theirs.', coalesce(v_p16_badkey_ok::text,'NULL'), coalesce(v_p16_badkey_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p16_badkey_last is null then
      v_bad := array_append(v_bad, 'the refused procedure carries no last_error — a card that will not become a thing must say why, and still say why tomorrow');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_badname_ok, true) or coalesce(v_p16_badname_err, '') not like '%by the name it was agreed under%' then
      v_bad := array_append(v_bad, format('a draft carrying the COMPILING MODEL''S OWN title was stamped (ok=%L error=%L). playbook-draft:622 prefers `compiled.name` over what it was asked for, so without this the card says Draft the "X" procedure and the customer gets one called something else.', coalesce(v_p16_badname_ok::text,'NULL'), coalesce(v_p16_badname_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_pub_ok, true) or coalesce(v_p16_pub_err, '') not like '%not a draft%' then
      v_bad := array_append(v_bad, format('an ALREADY-PUBLISHED playbook was stamped as this recommendation''s draft (ok=%L error=%L). Published is the one state every executor admits, so this is the card''s single promise — "nothing runs until you publish it" — failing at the moment of the click.', coalesce(v_p16_pub_ok::text,'NULL'), coalesce(v_p16_pub_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_archd_ok, true) or coalesce(v_p16_archd_err, '') not like '%not a draft%' then
      v_bad := array_append(v_bad, format('an ARCHIVED playbook was stamped (ok=%L error=%L) — the customer would be told a procedure was drafted for them against a row they had already thrown away', coalesce(v_p16_archd_ok::text,'NULL'), coalesce(v_p16_archd_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_sopk_ok, true) or coalesce(v_p16_sopk_err, '') not like '%standing instruction%' then
      v_bad := array_append(v_bad, format('a draft whose steps make it an `sop` was stamped (ok=%L error=%L). `kind` is derived from the steps by trigger and decides WHICH ENGINE owns the row — de-work compiles an sop into work items, playbook-execute refuses it outright with definition_is_an_sop — so the card describing "publish it and it runs" would be describing the wrong engine.', coalesce(v_p16_sopk_ok::text,'NULL'), coalesce(v_p16_sopk_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_deid_ok, true) or coalesce(v_p16_deid_err, '') not like '%already assigned to one of your digital employees%' then
      v_bad := array_append(v_bad, format('a draft ALREADY ASSIGNED to a digital employee was stamped (ok=%L error=%L). de-work and de-mission both select on de_id, so that row is one publish away from being somebody''s queue, and the card offered a draft to read.', coalesce(v_p16_deid_ok::text,'NULL'), coalesce(v_p16_deid_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_nosteps_ok, true) or coalesce(v_p16_nosteps_err, '') not like '%no steps in it%' then
      v_bad := array_append(v_bad, format('an EMPTY draft was stamped (ok=%L error=%L) — the card promised something to read over and publish, and an empty draft is nothing a person can review, approve or decline', coalesce(v_p16_nosteps_ok::text,'NULL'), coalesce(v_p16_nosteps_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_nostudy_ok, true) or coalesce(v_p16_nostudy_err, '') not like '%could not confirm that this draft was written from what you described%' then
      v_bad := array_append(v_bad, format('a draft with NO STUDY ROW was stamped (ok=%L error=%L). The study is the only field on this path the browser cannot choose — `key` and `name` are both written by it — so without this arm the function is verifying the caller''s own claims and "a created-object id is not its own authorisation" means nothing here.', coalesce(v_p16_nostudy_ok::text,'NULL'), coalesce(v_p16_nostudy_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p16_nostudy_last is null or v_p16_nostudy_last not like '%it runs nothing%' then
      v_bad := array_append(v_bad, format('the provenance refusal left last_error=%L. This is the ONE refusal that fires with a real draft sitting in the workspace, so its sentence has to tell the customer the draft exists, that it runs nothing, and that they can archive it — otherwise they are left to infer all three from silence.', coalesce(v_p16_nostudy_last,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_badsop_ok, true) or coalesce(v_p16_badsop_err, '') not like '%could not confirm that this draft was written from what you described%' then
      v_bad := array_append(v_bad, format('a draft compiled from SOMEBODY ELSE''S words was stamped (ok=%L error=%L) — every field the browser controls was correct on that row, which is exactly why the study text is the one that has to be checked', coalesce(v_p16_badsop_ok::text,'NULL'), coalesce(v_p16_badsop_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_other_ok, true) or coalesce(v_p16_other_err, '') not like '%not its own authorisation%' then
      v_bad := array_append(v_bad, format('a draft in ANOTHER WORKSPACE was stamped (ok=%L error=%L) — right key, right name, right study text, wrong customer', coalesce(v_p16_other_ok::text,'NULL'), coalesce(v_p16_other_err,'NULL')));
    end if;

    -- (e11) A LONG NAME MUST NOT CUT THE REFUSAL IN HALF. Four things, in one
    -- arm, because any one of them alone would pass on the wrong reason:
    --   · the accept was still refused, and by the PROVENANCE arm;
    --   · the row's `last_error` is inside the 500-character bound this
    --     function writes — it is `left(v_err, 500)`, so this is the shape the
    --     customer actually reads rather than the string that was raised;
    --   · THE CLOSING SENTENCE SURVIVED. That is the whole point: it is the one
    --     that tells the customer a draft exists, runs nothing, and can be
    --     archived, and with an uncapped 228-character name it was the part
    --     that got cut;
    --   · and the name really WAS truncated — the capped form is present and
    --     the whole name is not. Without this last one the arm would pass just
    --     as happily on a short name, which is the vacuity that would let the
    --     cap be deleted and nothing notice.
    v_checks := v_checks + 1;
    if coalesce(v_p16_long_ok, true)
       or coalesce(v_p16_long_err, '') not like '%could not confirm that this draft was written from what you described%'
       or v_p16_long_last is null
       or length(v_p16_long_last) > 500
       or position('This recommendation is still here waiting for you.' in v_p16_long_last) = 0
       or position(left(v_p16_long_name, 140) || '…' in v_p16_long_last) = 0
       or position(v_p16_long_name in v_p16_long_last) <> 0 then
      v_bad := array_append(v_bad, format('the long-name provenance refusal came back ok=%L error=%L and left last_error=%L (%s characters, against the 500 this function writes). The name was %s characters; the message is 326 before it goes in, so uncapped it ran past the bound and the closing sentence — the one telling the customer the draft exists, runs nothing, and can be archived — was the part that got cut. That sentence has to be there, the capped name has to be there, and the whole name must NOT be.',
        coalesce(v_p16_long_ok::text,'NULL'), coalesce(v_p16_long_err,'NULL'),
        coalesce(v_p16_long_last,'NULL'), coalesce(length(v_p16_long_last)::text,'NULL'),
        length(v_p16_long_name)));
    end if;

    -- (f) the five payload refusals
    v_checks := v_checks + 1;
    if coalesce(v_p16_noname_ok, true) or coalesce(v_p16_noname_err, '') not like '%what the procedure is called%' then
      v_bad := array_append(v_bad, format('a procedure with NO NAME was accepted (ok=%L error=%L)', coalesce(v_p16_noname_ok::text,'NULL'), coalesce(v_p16_noname_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_notrig_ok, true) or coalesce(v_p16_notrig_err, '') not like '%should run%' then
      v_bad := array_append(v_bad, format('a procedure with NO TRIGGER was accepted (ok=%L error=%L)', coalesce(v_p16_notrig_ok::text,'NULL'), coalesce(v_p16_notrig_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_nopsteps_ok, true) or coalesce(v_p16_nopsteps_err, '') not like '%no steps written down%' then
      v_bad := array_append(v_bad, format('a procedure whose steps are all blank was accepted (ok=%L error=%L). They are dropped rather than kept, on both sides, so an array of empty strings is an array of nothing.', coalesce(v_p16_nopsteps_ok::text,'NULL'), coalesce(v_p16_nopsteps_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_short_ok, true) or coalesce(v_p16_short_err, '') not like '%at least 40%' then
      v_bad := array_append(v_bad, format('a description too short for the drafter was accepted (ok=%L error=%L). playbook-draft:364 refuses under 40 characters with an HTTP 400; restating it here is what turns that into a sentence the customer can act on rather than a transport error.', coalesce(v_p16_short_ok::text,'NULL'), coalesce(v_p16_short_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p16_short_state is distinct from 'pending' or v_p16_short_last is null or coalesce(v_p16_short_att, 0) < 1 then
      v_bad := array_append(v_bad, format('the refused short procedure sits at %L with last_error=%L attempts=%L — a refusal must return the row to pending WITH its reason and move the counter', coalesce(v_p16_short_state,'NULL'), coalesce(v_p16_short_last,'NULL'), coalesce(v_p16_short_att::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p16_nullid_ok, true) or coalesce(v_p16_nullid_err, '') not like '%drafted first and linked second%' then
      v_bad := array_append(v_bad, format('a GOOD procedure payload with nothing drafted was accepted (ok=%L error=%L) — Path B''s own shape: there is no writer in SQL for this kind, so an accept with no object id has nothing to link', coalesce(v_p16_nullid_ok::text,'NULL'), coalesce(v_p16_nullid_err,'NULL')));
    end if;

    -- (g) the role bar and its inversion
    v_checks := v_checks + 1;
    if not v_p16_user_ref then
      v_bad := array_append(v_bad, 'a TENANT_USER accepted a procedure proposal — and on this kind the browser has already spent a model call and created a draft by the time the bar is reached, so a hole here is a member with no authority filling a workspace with drafts');
    elsif coalesce(v_p16_user_msg, '') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but NOT by the role bar: %L. A refusal from somewhere else means Zone 1 passed and something further in stopped it, which is a different guarantee with a different blast radius.', coalesce(v_p16_user_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p16_user_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME procedure row, with the SAME draft id, that the tenant_user was refused (state=%L). The refusal above is then about the row and says nothing about the role.', coalesce(v_p16_user_state,'NULL')));
    end if;

    -- (h) the 740 identity-key model, both directions
    v_checks := v_checks + 1;
    if coalesce(v_p16_three_n, -1) <> 3 then
      v_bad := array_append(v_bad, format('THREE procedure proposals in ONE session — one each from money_in, how_work_gets_delivered and repetitive_work — did not all land (%L of 3). That is the shape DIMENSION_STRUCTURAL_KINDS actually emits, and an index that refused it would make a real interview fail at emission rather than here.', coalesce(v_p16_three_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p16_dup_refused or coalesce(v_p16_dup_state, '') <> '23505' then
      v_bad := array_append(v_bad, format('a FOURTH procedure proposal repeating a source_dimension already in the session was ADMITTED (refused=%L sqlstate=%L, expected 23505). identity_key is source_dimension for this kind, so the unique index is the only thing stopping one dimension proposing the same procedure twice — and the arm above would then be proving nothing, because everything would be admitted.', coalesce(v_p16_dup_refused::text,'NULL'), coalesce(v_p16_dup_state,'NULL')));
    end if;

    -- the delta: this function drafts nothing of its own.
    -- THREE COMPARISONS IN ONE ARM, in this order for a reason:
    --   · every id the probe listed still EXISTS (`seen` equals the list's own
    --     length). This one is first because it is what stops the second being
    --     vacuous: a null slot or a vanished row would otherwise shrink the
    --     expectation to meet the measurement and the count would agree with
    --     itself;
    --   · the workspace's count moved by exactly the number of listed rows that
    --     landed IN it — no hand-counted literal on either side;
    --   · and nothing appeared that the probe did not insert. That one NAMES the
    --     rows, because "the number moved" is not a diagnosis and the fix for
    --     this arm's first failure was invisible without one.
    v_checks := v_checks + 1;
    if coalesce(v_p16_pb_seen, -1) <> coalesce(array_length(v_p16_pb_own, 1), 0)
       or coalesce(v_p16_pb_delta, -1) <> coalesce(v_p16_pb_own_n, -1)
       or coalesce(v_p16_pb_extra_n, -1) <> 0 then
      v_bad := array_append(v_bad, format('the playbook count in this workspace moved by %L; the probe lists %L row(s) it inserted, %L of which are still present and %L of which are in this workspace, and %L row(s) nobody listed appeared during it: %s. decide_discovery_proposal cannot have drafted one — `net.http_post` returns a request id, not a reply, so a SQL function that appeared to have drafted a playbook has done something other than call the drafter. If a row is named above, its key says what made it.',
        coalesce(v_p16_pb_delta::text,'NULL'),
        coalesce(array_length(v_p16_pb_own, 1)::text,'0'),
        coalesce(v_p16_pb_seen::text,'NULL'),
        coalesce(v_p16_pb_own_n::text,'NULL'),
        coalesce(v_p16_pb_extra_n::text,'NULL'),
        coalesce(v_p16_pb_extra,'none')));
    end if;
  end if;

  ------------------------------------------------------------------------
  -- PROBE 17 (753) — THE TRUST_RULE PATH, AND THE ONE CLAIM IT HAS TO PROVE
  -- IS A NEGATIVE: NOTHING THIS EMPLOYEE DOES CHANGES.
  --
  -- Path A, so there is no browser half to perform: the whole accept is one
  -- call, driven as the real runtime role `authenticated` with a real owner's
  -- uid. The employee it governs is hired through the ORDINARY accept first —
  -- an employee proposal decided by the same owner in the same session — so the
  -- sibling-resolution the branch depends on is exercised rather than modelled.
  --
  -- ⚠ THE INVERSION IS FIRST, and everything else is paired against it. One
  -- accept SUCCEEDS, so "the trust_rule branch refuses everything" and "the
  -- trust_rule branch checks what it is handed" are distinguishable. FOURTEEN
  -- refusals follow, each differing from that success in exactly ONE respect:
  --     the employee is proposed but NOT accepted   (§11b requirement 4)
  --     de_ref is "unassigned"                      (the literal the old prompt asked for)
  --     de_ref is free text                         (not a reference at all)
  --     no action_category                          (nothing to record it against)
  --     no cap                                      (no cap is no decision)
  --     a prose cap                                 (isNumericLiteral, mirrored)
  --     a NEGATIVE cap                              (stricter than the client, and safe)
  --     a CONFIDENCE cap of 500                     (stricter than the client too; the
  --                                                  accept above, at 80 on the SAME
  --                                                  category, is its inversion)
  --     a created-object id was passed              (Path A's own shape)
  --     the policy is ALREADY above level 0         (⚠ THE INERTNESS PIN)
  --     the policy ALREADY carries a ladder         (⚠ the other half of it)
  --     a capability not on this employee's surface (a dial that cannot exist)
  --     the sibling points at ANOTHER workspace     (an id is not authorisation)
  --     a tenant_user                               (the role bar)
  -- and a second accept on the decided row (the compare-and-swap).
  --
  -- ⚠⚠ AND THE TWO MEASUREMENTS THAT ARE THE WHOLE MIGRATION, BOTH INVERTED.
  --   (b) NO DIAL APPEARS. `de_autonomy` is the table resolve_de_autonomy reads
  --       and the four enforcement paths read through it; `trust_apply_level`
  --       is the only thing that writes one from a policy. The count for this
  --       exact scope is 0 before the accept and 0 after. THE INVERSION: the
  --       same trust_apply_level is then called at level 1 on the same scope
  --       and a row MUST appear — because a zero from a selector that returns
  --       zero for everything proves nothing at all.
  --   (c) THE ACCEPT CANNOT CHANGE WHAT A FUTURE PROMOTION MEANS.
  --       trust_ladder_settings(<the accepted policy>, 1) must equal
  --       trust_level_settings(<category>, 1) — the built-in defaults a
  --       workspace that never ran an interview would get. THE INVERSION: a
  --       ladder is then written onto the very same policy through the ONE
  --       door (set_trust_ladder, as the owner under RLS) and the two MUST
  --       diverge — because two expressions that always agree prove nothing
  --       either. And then it is CLEARED through the same door and the row must
  --       return to `ladder is null`, which is this kind's removability answer:
  --       whatever a human deliberately switches on later, a human can switch
  --       off again.
  --
  -- ⚠ AND PROVENANCE IS DRIVEN BOTH WAYS. A future enforcement layer has to be
  -- able to tell "the customer said this in an interview" from a default. The
  -- accepted proposal pointing at the policy IS that record — it carries the
  -- payload, the session, the source dimension, the decider and the date — so
  -- the round-trip query is run against the accepted policy (must find AT LEAST
  -- one, carrying the stated cap) AND against a policy the interview never
  -- touched (must find 0).
  -- ⚠ AT LEAST one, not exactly one, and the probe measured why: 17(e13) records
  -- a SECOND consent against the same policy while proving the role bar, and
  -- seed_de_trust_policy is idempotent on the live unique index, so both accepts
  -- link the same row. That is correct — two decisions, two dates, two deciders,
  -- both kept — and a probe demanding exactly one would have been demanding that
  -- the newer consent overwrite the older.
  --
  -- Red if: a trust_rule accept refuses everything; or any of the fourteen is
  -- accepted; or the linked policy is anything but a level-0, ladder-free,
  -- active, per-employee policy for the stated category; or a dial appears; or
  -- the automatic widening detector gains a candidate for this employee (or the
  -- policy count that makes that zero a comparison does not move 0 -> 1); or
  -- the accept moved what level 1 means; or a policy appears in the workspace
  -- that this probe did not create.
  ------------------------------------------------------------------------
  begin
    select count(*), coalesce(array_agg(t.id), '{}'::uuid[])
      into v_p17_pol_pre, v_p17_pol_pre_ids
      from public.trust_policies t where t.tenant_id = v_tenant;

    v_p17_payload := jsonb_build_object(
      'vddp', '1',
      'de_ref', 'archetype:' || v_arch_key,
      'action_category', v_p17_cat,
      'cap', v_p17_cap,
      'above_cap', 'Above that it stops and asks you first.');

    -- ── (a) THE INVERSION ────────────────────────────────────────────────
    -- The employee is hired through the ORDINARY accept, by the same owner, in
    -- the session this trust rule belongs to. Nothing here fabricates the link
    -- the branch resolves through.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp', '1', 'archetype_key', v_arch_key,
                                 'name', 'vddp probe employee for a trust rule'),
              'probe', v_dim, 'pending')
      returning id into v_p17_prop_emp;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p17_prop_emp, 'accepted', 'hire them', null);
    execute format('set local role %I', v_caller);
    v_p17_de := (v_res ->> 'created_object_id')::uuid;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop;

    -- the dial count for THIS EXACT SCOPE, before anything
    select count(*) into v_p17_dial_pre from public.de_autonomy a
     where a.tenant_id = v_tenant and a.de_id = v_p17_de
       and a.action_type = v_p17_cat and a.source_category is null;

    -- ── THE AUTOMATIC WIDENING CHAIN, BEFORE. Nothing in this file measured it
    -- until now, and the accept sits at the top of it: the detector
    -- LATERAL-JOINS a trust_policies row, so an employee with no policy cannot
    -- become a candidate however it behaves. Both halves are asked OF THIS
    -- EMPLOYEE rather than of the tenant, so a candidate belonging to somebody
    -- else's employee cannot mask or manufacture the result.
    select count(*) into v_p17_widen_pre
      from public.detect_trust_widening_patterns(v_tenant) w where w.de_id = v_p17_de;
    select count(*) into v_p17_empol_pre
      from public.trust_policies t where t.tenant_id = v_tenant and t.de_id = v_p17_de;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'record it', null);
    execute format('set local role %I', v_caller);
    v_p17_ok  := (v_res ->> 'ok')::boolean;
    v_p17_err := v_res ->> 'error';
    select state, created_object_id, last_error into v_p17_state, v_p17_obj, v_p17_lasterr
      from public.discovery_proposals where id = v_prop;
    v_p17_pol := v_p17_obj;
    select t.current_level, t.baseline_level, t.ladder, t.status, t.de_id,
           t.action_category, t.source_category
      into v_p17_lvl, v_p17_base, v_p17_ladder, v_p17_status, v_p17_polde,
           v_p17_polcat, v_p17_polsrc
      from public.trust_policies t where t.id = v_p17_pol;
    select a.detail into v_p17_detail
      from public.audit_events a
     where a.tenant_id = v_tenant and a.detail ->> 'proposal_id' = v_prop::text
     order by a.created_at desc limit 1;

    -- ── (b) NOTHING IS ENFORCED, MEASURED — AND THE INVERSION ────────────
    select count(*) into v_p17_dial_post from public.de_autonomy a
     where a.tenant_id = v_tenant and a.de_id = v_p17_de
       and a.action_type = v_p17_cat and a.source_category is null;

    -- ...AND THE WIDENING CHAIN, AFTER. Taken HERE, before (c) writes a ladder
    -- and before (f) inserts the decoy policy, so the only thing between the two
    -- readings is the accept itself.
    select count(*) into v_p17_widen_post
      from public.detect_trust_widening_patterns(v_tenant) w where w.de_id = v_p17_de;
    select count(*) into v_p17_empol_post
      from public.trust_policies t where t.tenant_id = v_tenant and t.de_id = v_p17_de;

    -- what a FUTURE promotion to level 1 would mean, with the row as it stands
    select public.trust_ladder_settings(t, 1) into v_p17_set_null
      from public.trust_policies t where t.id = v_p17_pol;
    select public.trust_level_settings(v_p17_cat, 1) into v_p17_set_dflt;

    -- THE INVERSION FOR THE ZERO. trust_apply_level is what turns a policy into
    -- an enforced dial; run it at level 1 on the SAME scope and a row must
    -- appear, or the zero above is a statement about a selector.
    perform public.trust_apply_level(v_tenant, v_p17_cat, 1, v_admin_uid, null, v_p17_de);
    select count(*) into v_p17_dial_inv from public.de_autonomy a
     where a.tenant_id = v_tenant and a.de_id = v_p17_de
       and a.action_type = v_p17_cat and a.source_category is null;
    delete from public.de_autonomy a
     where a.tenant_id = v_tenant and a.de_id = v_p17_de
       and a.action_type = v_p17_cat and a.source_category is null;

    -- ── (c) THE ONE DOOR, DRIVEN IN BOTH DIRECTIONS ─────────────────────
    -- set_trust_ladder is the ONLY function in this database that assigns
    -- trust_policies.ladder (measured live across pg_proc). It is called here
    -- as the OWNER under RLS — the same call the ladder editor makes — which is
    -- what "making it live is a deliberate act" means concretely. Then it is
    -- called again with p_clear_ladder to take it off.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_p17_lad_set := public.set_trust_ladder(
      v_p17_pol,
      '[{"level":1,"name":"Answers on its own","mode":"act_within_limits","settings":{"min_confidence":80}}]'::jsonb,
      null, null, false);
    execute format('set local role %I', v_caller);
    select t.ladder into v_p17_lad_after from public.trust_policies t where t.id = v_p17_pol;
    select public.trust_ladder_settings(t, 1) into v_p17_set_lad
      from public.trust_policies t where t.id = v_p17_pol;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_p17_lad_clear := public.set_trust_ladder(v_p17_pol, null, null, null, true);
    execute format('set local role %I', v_caller);
    select t.ladder into v_p17_lad_final from public.trust_policies t where t.id = v_p17_pol;

    -- ── (d) a second accept on the decided row ──────────────────────────
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop, 'accepted', 'again', null);
    execute format('set local role %I', v_caller);
    v_p17_again_ok  := (v_res ->> 'ok')::boolean;
    v_p17_again_err := v_res ->> 'error';

    -- ── (e) THE REFUSALS. One fresh session each, because identity_key is
    -- `source_dimension` for this kind and who_signs_off is its only source, so
    -- a real session holds AT MOST ONE trust_rule — proven at (g) below.
    --
    -- ⚠ Each decoy session carries a FIXTURE employee proposal already at
    -- 'accepted' rather than hiring another employee through the RPC. That is
    -- deliberate and it is also the honest model: `created_object_id` on a
    -- sibling row is written by this same function but the row can be edited by
    -- anything holding UPDATE, which is exactly why the branch re-reads the
    -- employee instead of trusting it. (e12) is that re-read, fired.
    --
    -- (e1) the employee was proposed and NOT accepted
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee unaccepted'),
              'probe', v_dim, 'pending');
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_s;

    -- (e2) de_ref is the literal the old prompt used to ask for
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('de_ref', 'unassigned'), 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_t;

    -- (e3) de_ref is free text
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('de_ref', 'the person who does the billing'), 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_u;

    -- (e4) no action_category  (e5) no cap  (e6) a prose cap  (e7) a negative cap
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload - 'action_category', 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_v;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload - 'cap', 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_w;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('cap', 'as appropriate'), 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_x;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('cap', '-500'), 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_y;

    -- (e14) a CONFIDENCE cap of 500. v_p17_cat is 'answer_dock', which is on
    -- set_trust_ladder's confidence side, so this payload is consent to "500%
    -- confidence" — a number validate_trust_ladder refuses outright (0-100,
    -- read live) and a sentence nobody can mean.
    --
    -- ⚠ THIS SESSION CARRIES AN ACCEPTED EMPLOYEE SIBLING, unlike (e4)-(e7)
    -- which are refused in the cap/category zone before a sibling is ever
    -- looked for. That is deliberate and it is what makes this a real
    -- inversion: with the range check gone, this payload would run the WHOLE
    -- branch and be ACCEPTED, so the arm fails on ok=true rather than on a
    -- different refusal reason. It therefore differs from (a) in exactly the
    -- cap — same session shape, same employee, same category, 500 instead of
    -- 80 — and (a) succeeding at 80 is the other half of the inversion: the
    -- branch must refuse the out-of-range value and accept the in-range one, or
    -- the check is either vacuous or a blanket refusal of confidence caps.
    -- ⚠ Being accepted would link this proposal to the policy (a) already
    -- opened rather than seeding a second one — seed_de_trust_policy is
    -- idempotent on the live unique index — so the leak arm's expected-id list
    -- does not move.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee confidence cap'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('cap', v_p17_cap_bad), 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_af;

    -- (e8) a GOOD payload, with an object id handed in — Path A's own shape
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee sibling'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_z;

    -- (e11) a capability that is NOT on this employee's trust surface.
    -- 'action_execute' is the most common category in the live namespace (41 of
    -- 90 rows, measured) and de_trust_surface_candidates does not emit it at
    -- all — it emits answer_dock, answer_widget, invoice_auto_send,
    -- 'action:<category>', an action_key, and 'writeback:<category>'. So it
    -- passes validatePayload's namespace check and is still not a dial this
    -- employee can have, which is exactly the gap the branch's own check fills.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee surface'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule',
              v_p17_payload || jsonb_build_object('action_category', 'action_execute'),
              'probe', 'who_signs_off', 'pending')
      returning id into v_prop_ab;

    -- (e12) the sibling points at an employee in ANOTHER workspace
    select d.id into v_p17_de_other from public.digital_employees d
     where d.tenant_id = v_other_tenant
       and coalesce(d.is_workforce_assistant, false) = false
     order by d.created_at limit 1;
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee cross tenant'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de_other
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_ac;

    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_s, 'accepted', 'not hired yet', null);
    v_p17_nohire_ok  := (v_res ->> 'ok')::boolean;
    v_p17_nohire_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_t, 'accepted', 'unassigned', null);
    v_p17_unassign_ok := (v_res ->> 'ok')::boolean;
    v_p17_unassign_er := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_u, 'accepted', 'free text', null);
    v_p17_freetext_ok := (v_res ->> 'ok')::boolean;
    v_p17_freetext_er := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_v, 'accepted', 'no category', null);
    v_p17_nocat_ok  := (v_res ->> 'ok')::boolean;
    v_p17_nocat_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_w, 'accepted', 'no cap', null);
    v_p17_nocap_ok  := (v_res ->> 'ok')::boolean;
    v_p17_nocap_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_x, 'accepted', 'prose cap', null);
    v_p17_prose_ok  := (v_res ->> 'ok')::boolean;
    v_p17_prose_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_y, 'accepted', 'negative cap', null);
    v_p17_neg_ok  := (v_res ->> 'ok')::boolean;
    v_p17_neg_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_af, 'accepted', 'confidence over 100', null);
    v_p17_conf_ok  := (v_res ->> 'ok')::boolean;
    v_p17_conf_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_z, 'accepted', 'here is an id', v_p17_pol);
    v_p17_objid_ok  := (v_res ->> 'ok')::boolean;
    v_p17_objid_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_ab, 'accepted', 'not on the surface', null);
    v_p17_surf_ok  := (v_res ->> 'ok')::boolean;
    v_p17_surf_err := v_res ->> 'error';
    v_res := public.decide_discovery_proposal(v_prop_ac, 'accepted', 'another workspace', null);
    v_p17_cross_ok  := (v_res ->> 'ok')::boolean;
    v_p17_cross_err := v_res ->> 'error';
    execute format('set local role %I', v_caller);
    select last_error into v_p17_nohire_last from public.discovery_proposals where id = v_prop_s;

    -- ── (e9) ALREADY ABOVE LEVEL 0, and (e10) ALREADY CARRYING A LADDER.
    -- Both mutate the policy the accept created, one field at a time, and both
    -- restore it — so the two refusals differ from (a) in exactly the field
    -- under test and nothing else.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee promoted'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_aa;
    update public.trust_policies set current_level = 1 where id = v_p17_pol;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_aa, 'accepted', 'already promoted', null);
    execute format('set local role %I', v_caller);
    v_p17_lvl_ok  := (v_res ->> 'ok')::boolean;
    v_p17_lvl_err := v_res ->> 'error';
    select last_error into v_p17_lvl_last from public.discovery_proposals where id = v_prop_aa;
    update public.trust_policies set current_level = 0 where id = v_p17_pol;

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee laddered'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_ad;
    update public.trust_policies
       set ladder = '[{"level":1,"name":"Set by somebody else","mode":"act_within_limits","settings":{"min_confidence":70}}]'::jsonb
     where id = v_p17_pol;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_ad, 'accepted', 'already laddered', null);
    execute format('set local role %I', v_caller);
    v_p17_lad_ok  := (v_res ->> 'ok')::boolean;
    v_p17_lad_err := v_res ->> 'error';
    update public.trust_policies set ladder = null where id = v_p17_pol;

    -- ── (e13) the role bar, and its inversion on the SAME row ───────────
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'employee',
              jsonb_build_object('vddp','1','archetype_key', v_arch_key, 'name','vddp probe employee role bar'),
              'probe', v_dim, 'accepted');
    update public.discovery_proposals set created_object_id = v_p17_de
     where session_id = v_session and kind = 'employee';
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending')
      returning id into v_prop_ae;

    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_prop_ae, 'accepted', 'can I?', null);
    exception when others then
      v_p17_user_ref := true;
      v_p17_user_msg := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_prop_ae, 'accepted', 'the owner can', null);
    execute format('set local role %I', v_caller);
    select state into v_p17_user_state from public.discovery_proposals where id = v_prop_ae;

    -- ── (f) PROVENANCE, BOTH DIRECTIONS ─────────────────────────────────
    -- The decoy is a policy the interview never touched: same employee, a
    -- different capability, inserted directly. If the round trip found it too,
    -- "the customer said this in an interview" would not be answerable.
    insert into public.trust_policies (tenant_id, de_id, action_category, display_name)
      values (v_tenant, v_p17_de, 'vddp_probe_decoy_category', 'vddp probe decoy')
      returning id into v_p17_pol_decoy;

    select count(*), max(p.payload ->> 'cap') into v_p17_prov_hit, v_p17_prov_cap
      from public.discovery_proposals p
     where p.tenant_id = v_tenant and p.kind = 'trust_rule'
       and p.state = 'accepted' and p.created_object_id = v_p17_pol;
    select count(*) into v_p17_prov_miss
      from public.discovery_proposals p
     where p.tenant_id = v_tenant and p.kind = 'trust_rule'
       and p.state = 'accepted' and p.created_object_id = v_p17_pol_decoy;

    -- ── (g) THE 740 INDEX, BOTH DIRECTIONS ──────────────────────────────
    -- identity_key is `source_dimension` for trust_rule, and
    -- DIMENSION_STRUCTURAL_KINDS maps exactly ONE dimension to this kind —
    -- who_signs_off — emitting exactly one draft. So a REAL session holds AT
    -- MOST ONE trust_rule, like guardrail and unlike procedure, and a second
    -- from the same dimension must collide.
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending');
    select count(*) into v_p17_one_n from public.discovery_proposals
     where session_id = v_session and kind = 'trust_rule';
    -- Nested, because a 23505 reaching this probe's own handler would abort it
    -- — the trap that took down probe 15 on its first apply.
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
        values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'who_signs_off', 'pending');
    exception when unique_violation then
      v_p17_dup_refused := true;
      v_p17_dup_state   := sqlstate;
    end;
    -- ...and the INVERSION, which models the INDEX rather than the interview:
    -- a second trust_rule from a DIFFERENT dimension is admitted. Said plainly
    -- because it matters: today's emitter cannot produce that shape (only
    -- who_signs_off maps to this kind), so this arm proves the index keys on
    -- source_dimension and NOT that a session can legitimately hold two.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session, v_tenant, 'trust_rule', v_p17_payload, 'probe', 'money_out', 'pending');
    select count(*) into v_p17_two_dims_n from public.discovery_proposals
     where session_id = v_session and kind = 'trust_rule';

    -- ⚠ THE EXPECTED SET IS ENUMERATED, NOT COUNTED BY HAND. 752's own leak arm
    -- shipped the literal 10 for eleven rows and blocked the migration; the fix
    -- was to stop counting section headings and read the ids. Every
    -- trust_policies row this probe brings into existence is named here once —
    -- the one the accept opened and the decoy — and the arm below counts how
    -- many of THOSE landed in this workspace rather than assuming.
    -- ⚠ Rows the hire itself creates are NOT in this list and must not be: the
    -- extras query is what would name them, and instantiate_role_archetype
    -- creating a trust policy would be a fact this migration's header asserts
    -- it does not (measured: the only inserters are provision_starter_de_internal
    -- and seed_trust_policies).
    v_p17_pol_own := array[v_p17_pol, v_p17_pol_decoy];
    select count(*) - v_p17_pol_pre into v_p17_pol_delta
      from public.trust_policies where tenant_id = v_tenant;
    select count(*) into v_p17_pol_own_n from public.trust_policies t
     where t.tenant_id = v_tenant and t.id = any(array_remove(v_p17_pol_own, null));
    select count(*) into v_p17_pol_seen from public.trust_policies t
     where t.id = any(array_remove(v_p17_pol_own, null));
    select count(*), string_agg(format('%s (de=%L, category=%L, level=%s)', t.id, t.de_id, t.action_category, t.current_level), '; ')
      into v_p17_pol_extra_n, v_p17_pol_extra
      from public.trust_policies t
     where t.tenant_id = v_tenant
       and not (t.id = any(v_p17_pol_pre_ids))
       and not (t.id = any(array_remove(v_p17_pol_own, null)));

    v_d17 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 17 ABORTED before it could finish (%s: %s) — the trust_rule accept, the two measurements that say nothing changes today, the automatic-widening candidate measurement, the provenance round trip, the fourteen refusals and the 740 identity-key model were NOT compared this run', sqlstate, sqlerrm));
      v_d17 := false;
    end if;
  end;

  if v_d17 then
    v_probes_done := v_probes_done + 1;

    -- the fixture the whole probe rests on: the employee really was hired
    v_checks := v_checks + 1;
    if v_p17_de is null then
      v_bad := array_append(v_bad, 'the employee this trust rule governs was not hired by the ordinary accept, so the sibling the branch resolves through does not exist and every assertion below is about a session with nobody in it');
    end if;

    v_checks := v_checks + 1;
    if not coalesce(v_p17_ok, false) or v_p17_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: a well-formed trust rule, on an employee hired in the same session by the same owner, was not accepted (ok=%L state=%L error=%L). Every refusal below is then a statement about a branch that refuses everything, which is not a gate.',
        coalesce(v_p17_ok::text,'NULL'), coalesce(v_p17_state,'NULL'), coalesce(v_p17_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p17_obj is null or v_p17_lasterr is not null then
      v_bad := array_append(v_bad, format('the accepted trust rule links created_object_id=%L with last_error=%L — state and the link commit together or neither is observable',
        coalesce(v_p17_obj::text,'NULL'), coalesce(v_p17_lasterr,'NULL')));
    end if;

    -- ⚠ THE CARD'S CENTRAL PROMISE, READ OFF THE ROW THAT NOW EXISTS.
    v_checks := v_checks + 1;
    if coalesce(v_p17_lvl, -1) <> 0 or coalesce(v_p17_base, -1) <> 0
       or v_p17_ladder is not null or v_p17_status is distinct from 'active'
       or v_p17_polde is distinct from v_p17_de
       or v_p17_polcat is distinct from v_p17_cat
       or v_p17_polsrc is not null then
      v_bad := array_append(v_bad, format('the policy this accept linked reads level=%L baseline=%L ladder=%L status=%L de_id=%L category=%L source_category=%L. The card says the limit is written down and nothing changes today; level 0 with NO ladder is the whole of that promise — level 0 because trust_ladder_settings returns {enabled:false} before it reads a ladder at all, and no ladder because that is what makes a future promotion fall back to the built-in defaults instead of to a number nobody re-asked about.',
        coalesce(v_p17_lvl::text,'NULL'), coalesce(v_p17_base::text,'NULL'),
        coalesce(v_p17_ladder::text,'null'), coalesce(v_p17_status,'NULL'),
        coalesce(v_p17_polde::text,'NULL'), coalesce(v_p17_polcat,'NULL'),
        coalesce(v_p17_polsrc,'null')));
    end if;

    -- the audit detail carries the consent, because the policy row does not
    v_checks := v_checks + 1;
    if coalesce(v_p17_detail ->> 'created_object_table', '') <> 'trust_policies'
       or coalesce(v_p17_detail ->> 'stated_cap', '') <> v_p17_cap
       or coalesce(v_p17_detail ->> 'stated_cap_unit', '') <> 'confidence'
       or coalesce(v_p17_detail ->> 'ladder_written', '') <> 'false'
       or coalesce(v_p17_detail ->> 'enforces_today', '') <> 'false' then
      v_bad := array_append(v_bad, format('the audit detail for the accepted trust rule reads table=%L stated_cap=%L unit=%L ladder_written=%L enforces_today=%L. THE POLICY ROW DOES NOT CARRY THE CAP — deliberately, because `cap` has no unit and ladder settings read CENTS — so the audit detail and the proposal payload are the only places the number the customer agreed to exists. A missing or wrong one here is the consent record failing, not a decoration.',
        coalesce(v_p17_detail ->> 'created_object_table','NULL'), coalesce(v_p17_detail ->> 'stated_cap','NULL'),
        coalesce(v_p17_detail ->> 'stated_cap_unit','NULL'), coalesce(v_p17_detail ->> 'ladder_written','NULL'),
        coalesce(v_p17_detail ->> 'enforces_today','NULL')));
    end if;

    -- (b) NOTHING IS ENFORCED — and the inversion that stops the zero being vacuous
    v_checks := v_checks + 1;
    if coalesce(v_p17_dial_pre, -1) <> 0 or coalesce(v_p17_dial_post, -1) <> 0 then
      v_bad := array_append(v_bad, format('A DIAL EXISTS FOR THIS SCOPE — de_autonomy held %L row(s) before the accept and %L after (expected 0 and 0). de_autonomy is what resolve_de_autonomy reads and what decide_action_execution, playbook-execute, de-answer and widget-ask enforce through it. The card says nothing changes today; a row here means something does.',
        coalesce(v_p17_dial_pre::text,'NULL'), coalesce(v_p17_dial_post::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_dial_inv, -1) <> 1 then
      v_bad := array_append(v_bad, format('THE ENFORCEMENT INVERSION FAILED: calling trust_apply_level at level 1 on the very same scope left %L dial row(s), expected 1. The two zeroes above are then a statement about a selector that finds nothing rather than about an accept that enforces nothing.',
        coalesce(v_p17_dial_inv::text,'NULL')));
    end if;

    -- ── (b2) THE AUTOMATIC WIDENING CHAIN, WHICH THE FIRST VERSION OF THIS
    -- MIGRATION DID NOT MEASURE AT ALL. detect_trust_widening_patterns ->
    -- raise_trust_widening_proposals -> de_governance_sweep_internal -> cron
    -- `de-governance-sweep-daily` (45 6 * * *, active) is a THIRD reader of
    -- trust_policies, it fires on a daily timer, and it has already run in this
    -- database (3 trust_promotion tasks, 1 pending, 2 policies carrying a
    -- pending_task_id). It does not enforce and it does not promote on its own —
    -- but it INSERTs a pending human task, and the row it needs in order to see
    -- an employee at all is exactly the row this accept creates.
    --
    -- ⚠ THE TWO ARMS ARE ONE ARGUMENT. On its own, "the detector returns 0 after
    -- the accept" would be satisfied by a detector that returns 0 for
    -- everything — and today, live, it does return 0 platform-wide. The SECOND
    -- arm is what makes the first a comparison: the policy count for this
    -- employee moves 0 -> 1, so the thing the detector's lateral join was
    -- missing now exists and the remaining zero is about the detector's OTHER
    -- conditions (three landed approvals in the window, evidence eligible)
    -- rather than about an employee it cannot see.
    -- ⚠ SAID PLAINLY: this does NOT drive the detector to a positive. Building
    -- three landed action approvals is not done here, and the header's "what
    -- this migration does not prove" says so.
    v_checks := v_checks + 1;
    if coalesce(v_p17_widen_pre, -1) <> 0 or coalesce(v_p17_widen_post, -1) <> 0 then
      v_bad := array_append(v_bad, format('THE ACCEPT PUT THIS EMPLOYEE IN FRONT OF THE AUTOMATIC WIDENING DETECTOR: detect_trust_widening_patterns returned %L candidate(s) for it before the accept and %L after (expected 0 and 0). A candidate becomes a pending trust_promotion human task on the next de-governance-sweep-daily run, which is a change on a timer the card does not describe.',
        coalesce(v_p17_widen_pre::text,'NULL'), coalesce(v_p17_widen_post::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_empol_pre, -1) <> 0 or coalesce(v_p17_empol_post, -1) <> 1 then
      v_bad := array_append(v_bad, format('the trust_policies row count for this employee went %L -> %L, expected 0 -> 1. Both halves matter: 0 before is the hire creating no policy (this header asserts only provision_starter_de_internal and seed_trust_policies insert), and 1 after is THE ROW THE DETECTOR LATERAL-JOINS now existing — which is what makes the two detector zeroes above a comparison rather than a selector that never finds anything.',
        coalesce(v_p17_empol_pre::text,'NULL'), coalesce(v_p17_empol_post::text,'NULL')));
    end if;

    -- (c) THE ACCEPT CANNOT CHANGE WHAT A FUTURE PROMOTION MEANS — and its inversion
    v_checks := v_checks + 1;
    if v_p17_set_null is distinct from v_p17_set_dflt then
      v_bad := array_append(v_bad, format('THE ACCEPT MOVED WHAT LEVEL 1 MEANS: with the policy as this accept left it, a promotion to level 1 would apply %L, while the built-in defaults for this capability are %L. A workspace that never ran an interview gets the second one, and the customer agreed to a limit taking effect LATER and only when they say so — not to the interview quietly redefining the next rung.',
        coalesce(v_p17_set_null::text,'NULL'), coalesce(v_p17_set_dflt::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p17_set_lad is not distinct from v_p17_set_dflt then
      v_bad := array_append(v_bad, format('THE LADDER INVERSION FAILED: writing a real ladder onto the SAME policy through set_trust_ladder left trust_ladder_settings still answering %L, the same as the built-in defaults. The equality asserted above is then two expressions that always agree rather than a statement about the ladder this accept did not write.',
        coalesce(v_p17_set_lad::text,'NULL')));
    end if;

    -- (c) THE ONE DOOR IS TWO-WAY — this kind's removability answer
    v_checks := v_checks + 1;
    if v_p17_lad_after is null then
      v_bad := array_append(v_bad, 'set_trust_ladder, called as the workspace OWNER under RLS — the same call the ladder editor makes — did not put a ladder on the policy. That call is the ONE door between a recorded limit and an enforced one; if it does not work, "making it live is a deliberate act you take later" describes an act nobody can take.');
    end if;
    v_checks := v_checks + 1;
    if v_p17_lad_final is not null then
      v_bad := array_append(v_bad, format('the owner could not take the ladder back off through the same door (p_clear_ladder), and the policy still reads %L. A limit somebody switched on and cannot switch off is the defect migration 747 spent itself fixing on the other side of guardrail_rules.',
        coalesce(v_p17_lad_final::text,'NULL')));
    end if;

    -- (f) PROVENANCE, BOTH DIRECTIONS
    v_checks := v_checks + 1;
    if coalesce(v_p17_prov_hit, 0) < 1 or v_p17_prov_cap is distinct from v_p17_cap then
      v_bad := array_append(v_bad, format('the accepted policy cannot be traced back to the interview that produced it: the round-trip query found %L accepted trust_rule proposal(s) pointing at it and recovered cap=%L (expected at least 1, carrying %L). The policy row carries no marker of its own, by design — so this link IS the provenance, and a future enforcement layer asking "did a customer state a limit here?" has nothing else to ask. ⚠ AT LEAST one, not exactly one: a policy can legitimately carry several accepted trust rules, because a second session recording the same limit is a second consent with its own date and decider, and collapsing them would throw away the one that is not the newest.',
        coalesce(v_p17_prov_hit::text,'NULL'), coalesce(v_p17_prov_cap,'NULL'), v_p17_cap));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_prov_miss, -1) <> 0 then
      v_bad := array_append(v_bad, format('THE PROVENANCE INVERSION FAILED: a policy the interview never touched was also matched by the round-trip query (%L rows, expected 0). A test that says yes to everything cannot tell an interview-agreed limit from a default, which is the whole question.',
        coalesce(v_p17_prov_miss::text,'NULL')));
    end if;

    -- (d) the compare-and-swap
    v_checks := v_checks + 1;
    if coalesce(v_p17_again_ok, true) or coalesce(v_p17_again_err, '') <> 'already_decided' then
      v_bad := array_append(v_bad, format('a second accept on the decided trust rule returned ok=%L error=%L, expected already_decided', coalesce(v_p17_again_ok::text,'NULL'), coalesce(v_p17_again_err,'NULL')));
    end if;

    -- (e) the fourteen refusals
    v_checks := v_checks + 1;
    if coalesce(v_p17_nohire_ok, true) or coalesce(v_p17_nohire_err, '') not like '%have not set up the employee%' then
      v_bad := array_append(v_bad, format('a trust rule was recorded for an employee that had only been PROPOSED, not accepted (ok=%L error=%L). §11b requirement 4 — a trust rule cannot exist without the employee it governs — is enforced by the browser''s trustRuleBlockReason and by this branch; without this arm the server half is decoration.',
        coalesce(v_p17_nohire_ok::text,'NULL'), coalesce(v_p17_nohire_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p17_nohire_last is null then
      v_bad := array_append(v_bad, 'the refused trust rule carries no last_error — a card that will not become a thing must say why, and still say why tomorrow');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_unassign_ok, true) or coalesce(v_p17_unassign_er, '') not like '%rather than at one of the employees%' then
      v_bad := array_append(v_bad, format('de_ref "unassigned" was accepted (ok=%L error=%L). fillProposalLiterals'' own prompt used to tell the model to write exactly that literal when no employee fit, and §11b calls this the one proposal that removes a human — one naming nobody is not something a person can approve.',
        coalesce(v_p17_unassign_ok::text,'NULL'), coalesce(v_p17_unassign_er,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_freetext_ok, true) or coalesce(v_p17_freetext_er, '') not like '%rather than at one of the employees%' then
      v_bad := array_append(v_bad, format('a free-text de_ref was accepted (ok=%L error=%L) — "the person who does the billing" is not a reference anything can resolve, and a limit recorded against it names nobody',
        coalesce(v_p17_freetext_ok::text,'NULL'), coalesce(v_p17_freetext_er,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_nocat_ok, true) or coalesce(v_p17_nocat_err, '') not like '%what kind of work the limit is for%' then
      v_bad := array_append(v_bad, format('a trust rule with NO action_category was accepted (ok=%L error=%L)', coalesce(v_p17_nocat_ok::text,'NULL'), coalesce(v_p17_nocat_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_nocap_ok, true) or coalesce(v_p17_nocap_err, '') not like '%does not carry a limit we can read%' then
      v_bad := array_append(v_bad, format('a trust rule with NO cap was accepted (ok=%L error=%L). validatePayload''s own words: this is the one proposal that removes a human, and no cap is no decision.',
        coalesce(v_p17_nocap_ok::text,'NULL'), coalesce(v_p17_nocap_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_prose_ok, true) or coalesce(v_p17_prose_err, '') not like '%does not carry a limit we can read%' then
      v_bad := array_append(v_bad, format('a PROSE cap ("as appropriate") was accepted (ok=%L error=%L). isNumericLiteral is mirrored here character for character — leading $, all commas, trailing %% stripped, then /^-?\d+(\.\d+)?$/ — because a payload can reach this branch from before that validator existed and this function is the only thing that can write a reason onto the row.',
        coalesce(v_p17_prose_ok::text,'NULL'), coalesce(v_p17_prose_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_neg_ok, true) or coalesce(v_p17_neg_err, '') not like '%below zero%' then
      v_bad := array_append(v_bad, format('a NEGATIVE cap was accepted (ok=%L error=%L). This check is STRICTER than the client''s — validatePayload admits "-500" — and on Path A that is safe in both drift directions, because the browser has created nothing by the time this refuses.',
        coalesce(v_p17_neg_ok::text,'NULL'), coalesce(v_p17_neg_err,'NULL')));
    end if;
    -- (e14) A CONFIDENCE CAP OF 500, on a session carrying an ACCEPTED employee
    -- sibling — so with the range check removed this payload runs the whole
    -- branch and is accepted, and this arm fails on ok=true rather than on some
    -- other refusal getting there first. (a), the same category at 80, is the
    -- other half: it is asserted at the top of this block, where the accept that
    -- must succeed is checked. Without that pairing this arm would be satisfied
    -- by a branch that refuses every confidence cap, which is the opposite
    -- defect.
    v_checks := v_checks + 1;
    if coalesce(v_p17_conf_ok, true) or coalesce(v_p17_conf_err, '') not like '%confidence runs from 0 to 100%' then
      v_bad := array_append(v_bad, format('a CONFIDENCE cap of %L was accepted (ok=%L error=%L). This category is on set_trust_ladder''s confidence side, so the accept would have written stated_cap=%L beside stated_cap_unit="confidence" — consent to %s%% confidence, a value validate_trust_ladder refuses outright (0-100, read live). It is inert today, and that is exactly why it matters: stated_cap exists nowhere else, and the whole provenance argument in this header is that a future enforcement layer is meant to find it and read it.',
        v_p17_cap_bad, coalesce(v_p17_conf_ok::text,'NULL'), coalesce(v_p17_conf_err,'NULL'),
        v_p17_cap_bad, v_p17_cap_bad));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_objid_ok, true) or coalesce(v_p17_objid_err, '') not like '%not created first and linked after%' then
      v_bad := array_append(v_bad, format('a trust rule accept was handed a created-object id and took it (ok=%L error=%L). This is Path A: `authenticated` holds SELECT and nothing else on trust_policies, so there is no browser half — an id arriving here means something upstream believes this kind works the other way round, and accepting it would let a caller name the row its decision is recorded against.',
        coalesce(v_p17_objid_ok::text,'NULL'), coalesce(v_p17_objid_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_lvl_ok, true) or coalesce(v_p17_lvl_err, '') not like '%already earned some independence%' then
      v_bad := array_append(v_bad, format('⚠ THE INERTNESS PIN FAILED: a trust rule was recorded against a policy ALREADY ABOVE LEVEL 0 (ok=%L error=%L). "Nothing changes today" is true because THIS employee is at level 0 on THIS capability, where trust_ladder_settings returns disabled before it reads a ladder — not because no policy anywhere is above 0, which is a fact about the 90 rows that exist today and stops being true the first time anybody approves a promotion.',
        coalesce(v_p17_lvl_ok::text,'NULL'), coalesce(v_p17_lvl_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p17_lvl_last is null then
      v_bad := array_append(v_bad, 'the inertness refusal left no last_error on the row — this is the one refusal a customer is most likely to meet months after the interview, and it has to still explain itself then');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_lad_ok, true) or coalesce(v_p17_lad_err, '') not like '%already set out what each level of trust means%' then
      v_bad := array_append(v_bad, format('a trust rule was recorded against a policy that ALREADY CARRIES A LADDER (ok=%L error=%L). Somebody set that deliberately through the one door; recording a second number beside it would leave two limits on the record and no way to tell which one the customer meant.',
        coalesce(v_p17_lad_ok::text,'NULL'), coalesce(v_p17_lad_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_surf_ok, true) or coalesce(v_p17_surf_err, '') not like '%cannot yet let%' then
      v_bad := array_append(v_bad, format('a trust rule was recorded for a capability that is NOT on this employee''s trust surface (ok=%L error=%L). de_trust_surface_candidates decides what an employee can be dialled on at all and does not emit `action_execute`, yet 41 of the 90 live policies carry it — so it passes validatePayload''s namespace check and is still not a dial this employee can have. A limit recorded against one is a limit nothing will ever read.',
        coalesce(v_p17_surf_ok::text,'NULL'), coalesce(v_p17_surf_err,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_cross_ok, true) or coalesce(v_p17_cross_err, '') not like '%not one of yours any more%' then
      v_bad := array_append(v_bad, format('a trust rule was recorded against an employee in ANOTHER WORKSPACE (ok=%L error=%L). The employee id comes off a sibling proposal rather than off the caller, which is what makes "an id is not its own authorisation" hold by construction — but a sibling row can be edited by anything holding UPDATE, so the employee is re-read against this proposal''s own tenant.',
        coalesce(v_p17_cross_ok::text,'NULL'), coalesce(v_p17_cross_err,'NULL')));
    end if;

    -- (e13) the role bar and its inversion
    v_checks := v_checks + 1;
    if not v_p17_user_ref then
      v_bad := array_append(v_bad, 'a TENANT_USER accepted a trust rule — the one proposal on this screen that subtracts oversight rather than adding a capability, and the one where a hole in the bar means a member with no authority recording what somebody may do without asking');
    elsif coalesce(v_p17_user_msg, '') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but NOT by the role bar: %L. A refusal from somewhere else means Zone 1 passed and something further in stopped it, which is a different guarantee with a different blast radius.', coalesce(v_p17_user_msg,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p17_user_state is distinct from 'accepted' then
      v_bad := array_append(v_bad, format('THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME trust_rule row the tenant_user was refused (state=%L). The refusal above is then about the row and says nothing about the role.', coalesce(v_p17_user_state,'NULL')));
    end if;

    -- (g) the 740 identity-key model, both directions
    v_checks := v_checks + 1;
    if coalesce(v_p17_one_n, -1) <> 1 then
      v_bad := array_append(v_bad, format('the single trust_rule a real session holds did not land (%L of 1). who_signs_off is the SOLE trust_rule source in DIMENSION_STRUCTURAL_KINDS, so one is the whole shape the emitter can produce and an index that refused it would make a real interview fail at emission rather than here.',
        coalesce(v_p17_one_n::text,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p17_dup_refused or coalesce(v_p17_dup_state, '') <> '23505' then
      v_bad := array_append(v_bad, format('a SECOND trust_rule repeating the same source_dimension in one session was ADMITTED (refused=%L sqlstate=%L, expected 23505). identity_key is source_dimension for this kind, so migration 740''s unique index is the only thing stopping one dimension proposing the same limit twice — and the arm above would then be proving nothing, because everything would be admitted.',
        coalesce(v_p17_dup_refused::text,'NULL'), coalesce(v_p17_dup_state,'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p17_two_dims_n, -1) <> 2 then
      v_bad := array_append(v_bad, format('a trust_rule from a DIFFERENT source_dimension in the same session was refused (%L rows, expected 2). The index keys on (session_id, kind, identity_key) and identity_key is source_dimension here, so this is what says the collision above is about the DIMENSION and not about the kind. ⚠ It models the INDEX, not the interview: only who_signs_off maps to trust_rule today, so no real session can produce this shape.',
        coalesce(v_p17_two_dims_n::text,'NULL')));
    end if;

    -- the delta: this accept opens ONE policy and nothing else creates one.
    -- Three comparisons in one arm, in this order and for 752's reasons: the
    -- listed ids must still EXIST (or the expectation would shrink to meet the
    -- measurement); the workspace count must have moved by exactly the number
    -- of listed rows that landed in it, with no hand-counted literal on either
    -- side; and nothing may have appeared that the probe did not create — NAMED,
    -- because "the number moved" is not a diagnosis.
    v_checks := v_checks + 1;
    if coalesce(v_p17_pol_seen, -1) <> coalesce(array_length(v_p17_pol_own, 1), 0)
       or coalesce(v_p17_pol_delta, -1) <> coalesce(v_p17_pol_own_n, -1)
       or coalesce(v_p17_pol_extra_n, -1) <> 0 then
      v_bad := array_append(v_bad, format('the trust-policy count in this workspace moved by %L; the probe lists %L row(s) it created, %L of which are still present and %L of which are in this workspace, and %L row(s) nobody listed appeared during it: %s. A hire does not create a trust policy — the only inserters are provision_starter_de_internal and seed_trust_policies, measured — so an unlisted row means something on this path opened a setting nobody agreed to.',
        coalesce(v_p17_pol_delta::text,'NULL'),
        coalesce(array_length(v_p17_pol_own, 1)::text,'0'),
        coalesce(v_p17_pol_seen::text,'NULL'),
        coalesce(v_p17_pol_own_n::text,'NULL'),
        coalesce(v_p17_pol_extra_n::text,'NULL'),
        coalesce(v_p17_pol_extra,'none')));
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
  ------------------------------------------------------------------------
  -- PROBE 18 (754) — THE CONVERSATION-TOPIC PATH, AND THE "TEN THINGS" CASE.
  --
  -- The founder's instruction for this kind was, verbatim: "do the conversation
  -- topics and make sure it's not addressing just one thing as a customer might
  -- ask for 10 different things." So MANY-IN-ONE-SESSION is a REQUIREMENT and it
  -- is driven here, not asserted about in a comment: ten topics are proposed in
  -- ONE session, all ten are accepted, and the probe counts ten rules with ten
  -- distinct categories and ten distinct ids. The count is ENUMERATED from the
  -- fixture array rather than written as the literal 10 — 752 blocked on a probe
  -- that said 10 when it made 11.
  --
  -- ⚠ AND THE COLLISION THIS KIND WOULD HAVE HIT. Migration 740's unique index
  -- is (session_id, kind, identity_key), and before this migration identity_key
  -- fell to `source_dimension` for every kind but employee and connector. Only
  -- ONE dimension emits conversation_type, so ten topics in one session all
  -- carried the SAME identity_key and the second insert died on 23505 — "ten
  -- different things" was mechanically impossible. This file gives the kind its
  -- own arm (payload->>'set_category'), and (d) below drives BOTH directions:
  -- ten distinct categories are ADMITTED, and a repeat of one already in the
  -- session is REFUSED with 23505. Without the second half the first proves
  -- nothing — an index that admits everything admits ten things too.
  --
  -- Red if: an accept reports success while the rule is unlinked, inactive,
  -- carries a different literal from the card, or sits where
  -- classify_support_text will never reach it; or ten topics cannot coexist; or
  -- the same topic can be minted twice; or an accepted rule cannot be removed;
  -- or the rule is indistinguishable from the eleven baseline rules every
  -- workspace already has; or the topic it files under is not the one the
  -- classifier actually returns for the words on the card.
  ------------------------------------------------------------------------
  begin
    -- THE TEN TOPICS, from ONE array, so the denominator below is enumerated
    -- rather than typed. Each is (label, category, pattern) and every pattern is
    -- deliberately unlike the ten baseline patterns measured live in all 18
    -- tenants (safety/security/legal/outage/data/billing/access/complaint/
    -- feature_request/how_to), so a match below is this rule firing and not one
    -- of theirs.
    v_p18_topics := array[
      array['vddp probe topic — delivery',    'vddp_delivery',    'where is my parcel|late delivery|parcel stuck'],
      array['vddp probe topic — returns',     'vddp_returns',     'send it back|return label|swap it for'],
      array['vddp probe topic — sizing',      'vddp_sizing',      'what size|runs small|size guide'],
      array['vddp probe topic — warranty',    'vddp_warranty',    'still under warranty|warranty claim'],
      array['vddp probe topic — installation','vddp_installation','who installs|fitting appointment'],
      array['vddp probe topic — spares',      'vddp_spares',      'spare part|replacement part'],
      array['vddp probe topic — trade',       'vddp_trade',       'trade account|bulk order'],
      array['vddp probe topic — quote',       'vddp_quote',       'can you quote|send me a quote'],
      array['vddp probe topic — appointment', 'vddp_appointment', 'move my appointment|reschedule the visit'],
      array['vddp probe topic — damaged',     'vddp_damaged',     'arrived damaged|broken on arrival']
    ];
    v_p18_expected := array_length(v_p18_topics, 1);

    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    -- ── (a) TEN PROPOSALS IN ONE SESSION. Every insert here is a direct test of
    -- the rebuilt identity_key: the tenth would have been refused before today.
    v_p18_inserted := 0;
    for v_i in 1 .. v_p18_expected loop
      begin
        insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
          values (v_session, v_tenant, 'conversation_type',
                  jsonb_build_object('vddp', '1',
                                     'label',         v_p18_topics[v_i][1],
                                     'set_category',  v_p18_topics[v_i][2],
                                     'match_pattern', v_p18_topics[v_i][3]),
                  'probe', v_dim, 'pending')
          returning id into v_p18_prop;
        v_p18_props := array_append(v_p18_props, v_p18_prop);
        v_p18_inserted := v_p18_inserted + 1;
      exception when unique_violation then
        v_p18_ins_err := array_append(v_p18_ins_err, format('%s (%s)', v_p18_topics[v_i][2], sqlstate));
      end;
    end loop;

    -- ── (b) ACCEPT ALL TEN, through the ordinary Path B shape: the browser
    -- creates the rule under RLS as the signed-in owner, then the RPC verifies
    -- and stamps. `set local role authenticated` is what makes the insert go
    -- through support_triage_rules_admin_write rather than through postgres.
    v_p18_accepted := 0;
    for v_i in 1 .. coalesce(array_length(v_p18_props, 1), 0) loop
      perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
      set local role authenticated;
      insert into public.support_triage_rules
        (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
        values (v_tenant, 200 + v_i, v_p18_topics[v_i][1], v_p18_topics[v_i][3],
                v_p18_topics[v_i][2], 'normal', 'sev3', true, v_p18_props[v_i])
        returning id into v_p18_rule;
      v_res := public.decide_discovery_proposal(v_p18_props[v_i], 'accepted', 'ten topics', v_p18_rule);
      execute format('set local role %I', v_caller);

      if coalesce((v_res ->> 'ok')::boolean, false) then
        v_p18_accepted := v_p18_accepted + 1;
        v_p18_rules := array_append(v_p18_rules, v_p18_rule);
      else
        v_p18_acc_err := array_append(v_p18_acc_err, format('%s -> %s', v_p18_topics[v_i][2], coalesce(v_res ->> 'error', 'NULL')));
      end if;
      -- the first accept is also the one whose counters are read in full
      if v_i = 1 then v_p18_first := v_res; end if;
    end loop;

    -- what actually landed, counted off the table rather than off the loop
    select count(*), count(distinct set_category), count(distinct id), count(distinct rule_order)
      into v_p18_rows, v_p18_cats, v_p18_ids, v_p18_orders
      from public.support_triage_rules t
     where t.tenant_id = v_tenant
       and t.source_proposal_id = any(v_p18_props);

    -- ── (c) DOES IT ACTUALLY LABEL ANYTHING? The whole point of routing the
    -- kind at all. classify_support_text is the ONLY reader of
    -- support_triage_rules, and trg_triage_support_conversation is the only
    -- writer of de_conversations.category from it. Driving the classifier is the
    -- closest this probe can get to the product without inserting a customer
    -- conversation; the trigger side is named in the honest-limits note.
    -- ⚠ BOTH DIRECTIONS. The positive alone would pass on a classifier that
    -- returned the first rule's category for every input.
    -- ⚠⚠ THE POSITIVE TEXT CARRIES "late delivery" AND NOT "where is my parcel",
    -- AND THE FIRST VERSION OF THIS PROBE USED THE SECOND AND WENT RED. That red
    -- was CORRECT and it is the whole ordering argument firing: the baseline
    -- "How-to" rule sits at rule_order 100 and its pattern contains the fragment
    -- `where is`, so "where is my parcel" is classified how_to and the topic the
    -- customer named at 201 never sees it. Moving the probe text is NOT how that
    -- is answered — (c3) below drives that exact collision and ASSERTS the
    -- baseline wins, because that is the designed behaviour of the 200..9998
    -- band and the card says so out loud. This arm asks the different question:
    -- does the rule fire AT ALL, on words only it matches. Checked against all
    -- ten live baseline patterns: "late delivery" appears in none of them.
    v_p18_cls_hit  := public.classify_support_text(v_tenant, 'We had a late delivery again this week') ->> 'category';
    v_p18_cls_miss := public.classify_support_text(v_tenant, 'Please reset my password, I am locked out') ->> 'category';
    -- (c3) THE SHADOW. Text matching BOTH the baseline How-to pattern (`where
    -- is`) and this topic's own (`where is my parcel`). classify_support_text
    -- returns on the FIRST match ordered by rule_order, so the baseline at 100
    -- must win over the topic at 201.
    v_p18_cls_shadow := public.classify_support_text(v_tenant, 'Hi — where is my parcel, it was due Tuesday') ->> 'category';

    -- ── (d) THE IDENTITY INDEX, BOTH WAYS. A SECOND proposal repeating a
    -- set_category already in this session must be refused by 740's unique
    -- index; an ELEVENTH with a NEW category must be admitted. The second arm is
    -- what says the first is about the CATEGORY and not about the kind.
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
        values (v_session, v_tenant, 'conversation_type',
                jsonb_build_object('vddp','1','label','vddp probe topic — delivery again',
                                   'set_category','vddp_delivery','match_pattern','parcel again'),
                'probe', v_dim, 'pending');
      v_p18_dup_refused := false;
    exception when unique_violation then
      v_p18_dup_refused := true;
      v_p18_dup_state   := sqlstate;
    end;
    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
        values (v_session, v_tenant, 'conversation_type',
                jsonb_build_object('vddp','1','label','vddp probe topic — eleventh',
                                   'set_category','vddp_eleventh','match_pattern','something else entirely'),
                'probe', v_dim, 'pending');
      v_p18_new_ok := true;
    exception when others then
      v_p18_new_ok  := false;
      v_p18_new_err := sqlerrm;
    end;

    -- ── (d2) THE IDEMPOTENCY INDEX ITSELF, WHICH NOTHING PINNED. This file
    -- calls support_triage_rules_source_proposal_uq "the guarantee … enforced
    -- by the database rather than by the browser not clicking twice", and a
    -- reviewer dropped it and got 18/18 probes, 262 assertions and ZERO
    -- findings. Every other arm about that column reads it through the RPC —
    -- the STAMP checking a column — which is a different claim entirely: the
    -- index is the only thing that stops TWO CONCURRENT ACCEPTS both inserting,
    -- and createTriageRuleFromProposal's find-first is explicitly documented as
    -- a courtesy that turns the resulting 23505 into a re-use.
    --
    -- Driven as the signed-in OWNER under RLS, exactly as (b) does, so the row
    -- reaching the index is the row a browser really sends. A refusal for any
    -- OTHER sqlstate (42501 from RLS, 23503 from the FK) is a different fact and
    -- the assertion below says which it got.
    --
    -- ⚠ AND THE PARTIAL PREDICATE, which is the inversion. `where
    -- source_proposal_id is not null` is what lets the 198 hand-written and
    -- seeded rules keep sharing NULL. A non-partial index would refuse the
    -- SECOND rule in every workspace on this platform, and the positive arm
    -- above would pass on it — so a NULL-carrying insert is driven here too.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      insert into public.support_triage_rules
        (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
        values (v_tenant, 260, 'vddp race — same proposal twice', 'race two', 'vddp_race', 'normal', 'sev3', true, v_p18_props[2])
        returning id into v_p18_race_rule;
      v_p18_race_refused := false;
    exception when others then
      v_p18_race_refused := true;
      v_p18_race_state   := sqlstate;
      v_p18_race_msg     := sqlerrm;
    end;
    begin
      insert into public.support_triage_rules
        (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
        values (v_tenant, 261, 'vddp race — no proposal at all', 'race three', 'vddp_race_null', 'normal', 'sev3', true, null);
      v_p18_null_ok := true;
    exception when others then
      v_p18_null_ok  := false;
      v_p18_null_err := format('%s: %s', sqlstate, sqlerrm);
    end;
    execute format('set local role %I', v_caller);
    -- The count, because "the insert errored" and "only one rule owns that
    -- proposal" are two different statements and the second is the one the
    -- accept's re-use behaviour rests on.
    select count(*) into v_p18_own_n
      from public.support_triage_rules
     where source_proposal_id = v_p18_props[2];

    -- ── (e) CAN THE CUSTOMER TAKE ONE OFF? 751 kept the guardrail retire path
    -- working and 752 verified archive; this is the same question for a topic.
    -- Driven as the SIGNED-IN OWNER under RLS, through the same DELETE the
    -- triage-rules editor uses (supportInboxApi.ts:356) — not as postgres, which
    -- would prove nothing about what a customer can do.
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    begin
      delete from public.support_triage_rules
       where id = v_p18_rules[1] and tenant_id = v_tenant;
      v_p18_del_n := 0;
      get diagnostics v_p18_del_n = row_count;
    exception when others then
      v_p18_del_err := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    select count(*) into v_p18_still
      from public.support_triage_rules where id = v_p18_rules[1];

    -- ── (f) IS AN ACCEPTED RULE DISTINGUISHABLE FROM THE ONES ALREADY THERE?
    -- Measured 2026-08-17: 198 baseline rules across 18 tenants, 11 per tenant,
    -- none of which can carry a source_proposal_id because the column did not
    -- exist. Counted in this workspace rather than claimed.
    select count(*) filter (where source_proposal_id is not null),
           count(*) filter (where source_proposal_id is null)
      into v_p18_tagged, v_p18_untagged
      from public.support_triage_rules where tenant_id = v_tenant;

    -- ── (g) THE REFUSALS. Each one gets its OWN session, because identity_key
    -- is set_category for this kind and two probes sharing a category in one
    -- session would collide on the index instead of reaching the router.
    -- Every one of these must leave the proposal PENDING with a reason on it.

    -- g1: no created object id at all
    insert into public.discovery_sessions (tenant_id) values (v_tenant) returning id into v_session_b;
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g1','set_category','vddp_g1','match_pattern','g one'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'no object', null);
    execute format('set local role %I', v_caller);
    v_p18_g1 := coalesce(v_res ->> 'error', '');

    -- g2: a rule that exists but is NOT linked to this proposal — the
    -- idempotency column asked as a question rather than assumed
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g2','set_category','vddp_g2','match_pattern','g two'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_tenant, 250, 'vddp g2', 'g two', 'vddp_g2', 'normal', 'sev3', true, null)
      returning id into v_p18_rule;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'unlinked', v_p18_rule);
    execute format('set local role %I', v_caller);
    v_p18_g2 := coalesce(v_res ->> 'error', '');

    -- g3: the rule carries a DIFFERENT pattern from the card
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g3','set_category','vddp_g3','match_pattern','the words on the card'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_tenant, 251, 'vddp g3', 'entirely different words', 'vddp_g3', 'normal', 'sev3', true, v_p18_prop)
      returning id into v_p18_rule;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'wrong pattern', v_p18_rule);
    execute format('set local role %I', v_caller);
    v_p18_g3 := coalesce(v_res ->> 'error', '');

    -- g4: the rule is SWITCHED OFF — classify_support_text filters `active`
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g4','set_category','vddp_g4','match_pattern','g four'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_tenant, 252, 'vddp g4', 'g four', 'vddp_g4', 'normal', 'sev3', false, v_p18_prop)
      returning id into v_p18_rule;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'inactive', v_p18_rule);
    execute format('set local role %I', v_caller);
    v_p18_g4 := coalesce(v_res ->> 'error', '');

    -- g5: THE ORDERING PIN. A rule left at the column default (100) ties with
    -- the baseline "How-to" rule every one of the 18 live tenants carries at
    -- exactly 100, and loses the tie on created_at — invisibly, forever.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g5','set_category','vddp_g5','match_pattern','g five'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_tenant, 'vddp g5', 'g five', 'vddp_g5', 'normal', 'sev3', true, v_p18_prop)
      returning id into v_p18_rule;
    select rule_order into v_p18_g5_order from public.support_triage_rules where id = v_p18_rule;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'default order', v_p18_rule);
    execute format('set local role %I', v_caller);
    v_p18_g5 := coalesce(v_res ->> 'error', '');

    -- g6: a CATCH-ALL. A null pattern returns immediately for every message and
    -- would swallow everything below it — all 18 tenants already have exactly
    -- one, at 9999, and an interview must never mint a second.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g6','set_category','vddp_g6'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'catch all', null);
    execute format('set local role %I', v_caller);
    v_p18_g6 := coalesce(v_res ->> 'error', '');

    -- g7: a category token the inbox filter and the report label cannot use
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g7','set_category','Delivery Delay!','match_pattern','g seven'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'bad token', null);
    execute format('set local role %I', v_caller);
    v_p18_g7 := coalesce(v_res ->> 'error', '');

    -- g8: ANOTHER WORKSPACE'S RULE ID — an id is not its own authorisation
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp g8','set_category','vddp_g8','match_pattern','g eight'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_other_tenant, 253, 'vddp g8', 'g eight', 'vddp_g8', 'normal', 'sev3', true, v_p18_prop)
      returning id into v_p18_rule_other;
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'foreign rule', v_p18_rule_other);
    execute format('set local role %I', v_caller);
    v_p18_g8 := coalesce(v_res ->> 'error', '');

    -- ── (h) THE ROLE BAR, and its inversion on the SAME ROW. A tenant_user must
    -- not be able to accept; the workspace's own owner must, or the refusal is
    -- about the row rather than about the role.
    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, rationale, source_dimension, state)
      values (v_session_b, v_tenant, 'conversation_type',
              jsonb_build_object('vddp','1','label','vddp h','set_category','vddp_h','match_pattern','h one'),
              'probe', v_dim, 'pending')
      returning id into v_p18_prop;
    insert into public.support_triage_rules
      (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active, source_proposal_id)
      values (v_tenant, 254, 'vddp h', 'h one', 'vddp_h', 'normal', 'sev3', true, v_p18_prop)
      returning id into v_p18_rule;
    perform set_config('request.jwt.claim.sub', v_user_uid::text, true);
    set local role authenticated;
    begin
      v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'can I?', v_p18_rule);
    exception when others then
      v_p18_user_refused := true;
      v_p18_user_msg     := sqlerrm;
    end;
    execute format('set local role %I', v_caller);
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    set local role authenticated;
    v_res := public.decide_discovery_proposal(v_p18_prop, 'accepted', 'the owner can', v_p18_rule);
    execute format('set local role %I', v_caller);
    v_p18_owner_ok := coalesce((v_res ->> 'ok')::boolean, false);

    v_d18 := true;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    execute format('set local role %I', v_caller);
    if sqlerrm <> '__undo_probe__' then
      v_bad := array_append(v_bad, format('PROBE 18 ABORTED before it could finish (%s: %s) — the conversation-topic accept, the TEN-TOPICS-IN-ONE-SESSION case, the eight refusals, the removability of what it creates and the classifier''s own answer were NOT compared this run', sqlstate, sqlerrm));
      v_d18 := false;
    end if;
  end;

  if v_d18 then
    v_probes_done := v_probes_done + 1;

    -- ⚠ THE DENOMINATOR FIRST, for the reason probe 14 states: "ten topics
    -- coexisted" is satisfied by having proposed none. The expected count is
    -- read off the fixture array, never typed — 752 blocked on a probe that
    -- said 10 when it made 11.
    v_checks := v_checks + 1;
    if v_p18_inserted <> v_p18_expected then
      v_bad := array_append(v_bad, format(
        'THE TEN-THINGS CASE DID NOT EVEN GET PROPOSED: %s of %s conversation_type proposals were admitted into ONE session (%s). identity_key for this kind is payload->>''set_category'' as of migration 754; if that arm is missing, every topic in a session collides on migration 740''s unique index and the customer can be offered exactly one. Nothing below is a statement about anything.',
        v_p18_inserted, v_p18_expected, array_to_string(coalesce(v_p18_ins_err, '{}'::text[]), ' | ')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_accepted <> v_p18_expected then
      v_bad := array_append(v_bad, format(
        'only %s of %s conversation topics were ACCEPTED (%s). The founder''s instruction for this kind was that a customer may name ten different things; one accept working is not that.',
        v_p18_accepted, v_p18_expected, array_to_string(coalesce(v_p18_acc_err, '{}'::text[]), ' | ')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_rows <> v_p18_expected or v_p18_cats <> v_p18_expected
       or v_p18_ids <> v_p18_expected or v_p18_orders <> v_p18_expected then
      v_bad := array_append(v_bad, format(
        'the ten accepts produced %s rule(s) with %s distinct categor(ies), %s distinct id(s) and %s distinct position(s), expected %s of each. Equal counts of rows and categories is what says ten cards became ten DIFFERENT rules rather than one rule overwritten ten times; equal positions is what says no two of them are separated only by a created_at nobody can see.',
        v_p18_rows, v_p18_cats, v_p18_ids, v_p18_orders, v_p18_expected));
    end if;

    -- the counters the card and the audit line both read
    v_checks := v_checks + 1;
    if coalesce(v_p18_first ->> 'created_object_table', '') <> 'support_triage_rules'
       or (v_p18_first ->> 'set_category') is distinct from v_p18_topics[1][2]
       or (v_p18_first ->> 'match_pattern') is distinct from v_p18_topics[1][3]
       or coalesce((v_p18_first ->> 'routes_to_employee')::boolean, true)
       or not coalesce((v_p18_first ->> 'labels_conversations')::boolean, false) then
      v_bad := array_append(v_bad, format(
        'the accept returned %L. The audit line and the screen are built from the SAME object, so a counter missing here is a sentence the customer is shown that nothing can be checked against — and routes_to_employee=false is in there deliberately: nothing on this platform reads de_conversations.category to choose an employee, and an absence is how the previous version of this card came to promise routing.',
        left(coalesce(v_p18_first::text, 'NULL'), 400)));
    end if;

    -- (c) the classifier, both ways
    v_checks := v_checks + 1;
    if v_p18_cls_hit is distinct from v_p18_topics[1][2] then
      v_bad := array_append(v_bad, format(
        'classify_support_text returned %L for text carrying the first topic''s own words, expected %L. The card says conversations about this get filed under that topic; classify_support_text is the only reader of support_triage_rules, so if it does not say so the card is describing something that does not happen.',
        coalesce(v_p18_cls_hit, 'NULL'), v_p18_topics[1][2]));
    end if;
    v_checks := v_checks + 1;
    if v_p18_cls_miss = v_p18_topics[1][2] then
      v_bad := array_append(v_bad, format(
        'THE INVERSION FAILED: text about a locked account ALSO came back as %L. A classifier that answers the same thing for everything makes the positive arm above meaningless — and it would mean this rule had taken over the workspace''s existing triage.',
        v_p18_cls_miss));
    end if;

    -- (c3) THE SHADOW, ASSERTED RATHER THAN AVOIDED. This is the arm that makes
    -- the band a decision instead of a number: a topic from an interview sits
    -- BEHIND every built-in category, so where the two patterns overlap the
    -- built-in one wins. That is deliberate — "someone is hurt" must not be
    -- re-filed as a delivery question — and it is also the honest limit of what
    -- the card may claim, which is why the accept counts rules_ahead_of_it and
    -- the card prints it. If this ever comes back as the topic's own category,
    -- the band has been inverted and an interview can now outrank Safety.
    v_checks := v_checks + 1;
    if v_p18_cls_shadow is distinct from 'how_to' then
      v_bad := array_append(v_bad, format(
        'text matching BOTH the baseline "How-to" pattern and the accepted topic''s came back as %L, expected %L. classify_support_text returns on the FIRST match ordered by rule_order, the baseline sits at 100 and an accepted topic at 200..9998, so the baseline has to win — that ordering is what keeps Safety (10) and Security (20) ahead of anything an interview proposes. If the baseline seed has moved, re-measure before changing the band.',
        coalesce(v_p18_cls_shadow, 'NULL'), 'how_to'));
    end if;

    -- (d) the identity index, both ways
    v_checks := v_checks + 1;
    if not coalesce(v_p18_dup_refused, false) or coalesce(v_p18_dup_state, '') <> '23505' then
      v_bad := array_append(v_bad, format(
        'a SECOND conversation_type repeating a set_category already in the session was ADMITTED (refused=%L sqlstate=%L, expected 23505). identity_key is payload->>''set_category'' for this kind, so migration 740''s unique index is the only thing stopping one interview offering the same topic twice under two names.',
        coalesce(v_p18_dup_refused::text, 'NULL'), coalesce(v_p18_dup_state, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p18_new_ok, false) then
      v_bad := array_append(v_bad, format(
        'an ELEVENTH conversation_type with a NEW set_category in the same session was REFUSED (%L). This is the arm that says the refusal above is about the CATEGORY and not about the kind — without it, an index that refused every conversation_type after the first would pass.',
        coalesce(v_p18_new_err, 'NULL')));
    end if;

    -- (d2) THE IDEMPOTENCY INDEX, DRIVEN RATHER THAN DESCRIBED
    v_checks := v_checks + 1;
    if not coalesce(v_p18_race_refused, false) or coalesce(v_p18_race_state, '') <> '23505' then
      v_bad := array_append(v_bad, format(
        'A SECOND support_triage_rules row claiming the SAME source_proposal_id was ADMITTED (refused=%L sqlstate=%L msg=%L, expected 23505). support_triage_rules_source_proposal_uq is the ONLY thing making a conversation-topic accept idempotent under a race — this table carried no unique index of any kind before migration 754, and createTriageRuleFromProposal''s find-first is a courtesy that turns this exact 23505 into a re-use, not the guarantee. Without the index two concurrent accepts of one card both insert, one proposal owns two live rules, and the customer''s inbox is filed under a topic twice.',
        coalesce(v_p18_race_refused::text, 'NULL'), coalesce(v_p18_race_state, 'NULL'), left(coalesce(v_p18_race_msg, 'NULL'), 200)));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p18_own_n, -1) <> 1 then
      v_bad := array_append(v_bad, format(
        'proposal %L owns %s support_triage_rules row(s), expected exactly 1. "One proposal owns at most one rule" is the sentence this migration''s idempotency argument is built on, and it is a COUNT, not the fact that an insert raised.',
        coalesce(v_p18_props[2]::text, 'NULL'), coalesce(v_p18_own_n::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not coalesce(v_p18_null_ok, false) then
      v_bad := array_append(v_bad, format(
        'THE INVERSION FAILED: a rule carrying NO source_proposal_id was REFUSED (%L). The index is PARTIAL (`where source_proposal_id is not null`) precisely so the 198 seeded and hand-written rules across 18 workspaces can all share NULL; if this arm is red the index has been rebuilt without its predicate and the ordinary triage-rules editor is now refusing the second rule in every workspace on the platform. It also makes the arm above a statement about the PROPOSAL ID rather than about inserting twice.',
        coalesce(v_p18_null_err, 'NULL')));
    end if;

    -- (e) removability
    v_checks := v_checks + 1;
    if coalesce(v_p18_del_n, 0) <> 1 or coalesce(v_p18_still, 1) <> 0 then
      v_bad := array_append(v_bad, format(
        'an accepted topic rule could NOT be removed by the workspace owner under RLS (%s row(s) deleted, %s still there, error %L). 751 kept the guardrail retire path working and 752 verified archive; a topic a customer agreed to here has to be one they can take off here, through the same editor that manages the eleven they already had.',
        coalesce(v_p18_del_n::text, 'NULL'), coalesce(v_p18_still::text, 'NULL'), coalesce(v_p18_del_err, 'none')));
    end if;

    -- (f) distinguishable from the baseline
    v_checks := v_checks + 1;
    if coalesce(v_p18_tagged, 0) < 1 or coalesce(v_p18_untagged, 0) < 1 then
      v_bad := array_append(v_bad, format(
        'this workspace holds %s rule(s) carrying a source_proposal_id and %s without one. Both have to be non-zero for the column to be doing its job: it is the ONLY thing that tells a rule the interview wrote from the eleven every workspace is seeded with, and it is also the unique key that stops a retry minting a second rule.',
        coalesce(v_p18_tagged::text, 'NULL'), coalesce(v_p18_untagged::text, 'NULL')));
    end if;

    -- (g) the eight refusals, each with its own sentence
    v_checks := v_checks + 1;
    if v_p18_g1 not like '%creating the rule first%' then
      v_bad := array_append(v_bad, format('a conversation_type accepted with NO created-object id did not meet the Path B refusal: %L', coalesce(v_p18_g1, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g2 not like '%not linked to this recommendation%' then
      v_bad := array_append(v_bad, format('a rule NOT carrying this proposal''s id was not refused for that reason: %L. source_proposal_id is the idempotency key; if the stamp does not check it, one proposal can adopt any rule in the workspace and a retry mints a second.', coalesce(v_p18_g2, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g3 not like '%looks for%' then
      v_bad := array_append(v_bad, format('a rule whose match_pattern differs from the card''s was ACCEPTED or refused for another reason: %L. The words on the card are the whole of what was agreed to.', coalesce(v_p18_g3, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g4 not like '%switched off%' then
      v_bad := array_append(v_bad, format('an INACTIVE rule was accepted or refused for another reason: %L. classify_support_text filters `active`, so an inactive rule is a card claiming a topic is tracked while nothing looks for it.', coalesce(v_p18_g4, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_p18_g5_order, -1) <> 100 then
      v_bad := array_append(v_bad, format(
        'the rule_order column defaulted to %L, not 100 — the ordering argument in this branch and on the card is built on that default colliding with the baseline "How-to" rule every one of the 18 live tenants carries at exactly 100. If the default moved, re-measure before trusting either.',
        coalesce(v_p18_g5_order::text, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g5 not like '%between 200 and 9998%' then
      v_bad := array_append(v_bad, format('a rule left at the DEFAULT position was accepted or refused for another reason: %L. classify_support_text returns on the FIRST match ordered by rule_order then created_at, so a rule at 100 ties with the baseline How-to rule and loses on a timestamp no screen shows.', coalesce(v_p18_g5, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g6 not like '%no words to look for%' then
      v_bad := array_append(v_bad, format('a CATCH-ALL topic (no match_pattern) was accepted or refused for another reason: %L. A pattern-less rule returns immediately for every message and would swallow every topic below it.', coalesce(v_p18_g6, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g7 not like '%plain lower-case words%' then
      v_bad := array_append(v_bad, format('a set_category the inbox filter cannot use was accepted or refused for another reason: %L', coalesce(v_p18_g7, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if v_p18_g8 not like '%not its own authorisation%' then
      v_bad := array_append(v_bad, format('ANOTHER WORKSPACE''S rule id was accepted or refused for another reason: %L', coalesce(v_p18_g8, 'NULL')));
    end if;

    -- (h) the role bar and its inversion
    v_checks := v_checks + 1;
    if not coalesce(v_p18_user_refused, false) then
      v_bad := array_append(v_bad, 'a TENANT_USER accepted a conversation topic — the rule is workspace-wide triage configuration, and the accept gate is owner/admin');
    elsif coalesce(v_p18_user_msg, '') not like '%owners and admins%' then
      v_bad := array_append(v_bad, format('the tenant_user was refused, but NOT by the role bar: %L', coalesce(v_p18_user_msg, 'NULL')));
    end if;
    v_checks := v_checks + 1;
    if not v_p18_owner_ok then
      v_bad := array_append(v_bad, 'THE INVERSION FAILED: the workspace''s OWN owner could not accept the SAME topic row the tenant_user was refused, so the refusal above is about the row and says nothing about the role');
    end if;
  end if;

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
  select count(*) into v_tp_after from public.trust_policies
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_da_after from public.de_autonomy
   where tenant_id in (v_tenant, v_other_tenant);
  select count(*) into v_str_after from public.support_triage_rules
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
  -- ── added by 752. Probe 16 inserts ELEVEN playbook definitions across the
  -- two probe tenants. A survivor is inert — it is a draft, and all four
  -- executors filter on `published` — but it consumes one of the workspace's
  -- 100-playbook quota and appears on the customer's Playbooks screen as a
  -- procedure nobody wrote, once per certify run. Tagged by DESCRIPTION
  -- rather than by name or key: the name is deliberately the customer-facing
  -- 'Chase an overdue invoice' on nine of them (that is what the name check
  -- is testing) and the keys are derived from proposal ids, so neither is a
  -- tag. Unqualified by tenant on purpose — ten are in one and one in the
  -- other, and a leak check that looked only where it expected the leak
  -- would be looking with the same assumption that produced it.
  select count(*) into v_leak_pb from public.playbook_definitions
   where description = 'vddp probe procedure';
  -- ── added by 753. trust_policies has no description column and its
  -- display_name is customer-facing, so the tag is the EMPLOYEE: every policy
  -- probe 17 opens belongs to a 'vddp probe employee…' row, plus the decoy,
  -- which is named directly. Unqualified by tenant on purpose — a leak check
  -- that looked only where it expected the leak would be looking with the same
  -- assumption that produced it.
  -- ⚠ The Workspace Assistant exclusion rides on the employee join for the
  -- reason it rides on every other count in this function: no assistant is
  -- named 'vddp probe employee…', and a predicate that reads assistant rows to
  -- prove they were not touched is the shape this file may not have.
  select count(*) into v_leak_tp from public.trust_policies t
   where t.display_name like 'vddp probe%'
      or t.action_category = 'vddp_probe_decoy_category'
      or exists (select 1 from public.digital_employees d
                  where d.id = t.de_id and d.name like 'vddp probe employee%'
                    and coalesce(d.is_workforce_assistant, false) = false);
  -- ⚠ AND THE DIAL IS THE ONE THAT WOULD ACTUALLY DO SOMETHING. probe 17
  -- writes a de_autonomy row on purpose, to invert its own zero. A surviving
  -- one is not an inert orphan: resolve_de_autonomy reads that table and
  -- decide_action_execution, playbook-execute, de-answer and widget-ask enforce
  -- through it, so it would be a real employee acting on its own at a level
  -- nobody approved — the exact thing this whole migration refuses to do.
  select count(*) into v_leak_da from public.de_autonomy a
   where exists (select 1 from public.digital_employees d
                  where d.id = a.de_id and d.name like 'vddp probe employee%'
                    and coalesce(d.is_workforce_assistant, false) = false);

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
     or coalesce(v_leak_gr, 0) <> 0 or coalesce(v_leak_pb, 0) <> 0 then
    v_bad := array_append(v_bad, format(
      'PROBE ROWS SURVIVED — %s connector(s) named "vddp probe connector…", %s discovery proposal(s) carrying the vddp payload tag, %s digital employee(s) named "vddp probe employee…", %s role archetype(s) keyed "vddp_…" %s guardrail rule(s) named "vddp probe…" and %s playbook definition(s) described "vddp probe procedure" are in production. The archetype count is PLATFORM-WIDE: a surviving one appears in every workspace''s hire wizard. A surviving guardrail rule is worse than an orphan row — it is a BLOCKING, workspace-wide rule nobody agreed to, and it would start withholding real answers.',
      v_leak_conn, v_leak_prop, coalesce(v_leak_emp, 0), coalesce(v_leak_arch, 0), coalesce(v_leak_gr, 0), coalesce(v_leak_pb, 0)));
  end if;
  v_checks := v_checks + 1;
  if v_tp_after <> v_tp_before or v_da_after <> v_da_before then
    v_bad := array_append(v_bad, format(
      'A TRUST PROBE ROLLBACK IS BROKEN — trust_policies %s -> %s, de_autonomy %s -> %s (counts scoped to tenants %s and %s). The second of those is the serious one: de_autonomy is what the four enforcement paths read, so a surviving row is an employee acting on its own at a level nobody approved. Stop running this until it is fixed: it runs on every certify.',
      v_tp_before, v_tp_after, v_da_before, v_da_after, v_tenant::text, v_other_tenant::text));
  end if;

  -- ── added by 754. Probe 18's own table, asserted separately so its message
  -- can say what a survivor would DO rather than only that a count moved.
  v_checks := v_checks + 1;
  if v_str_after <> v_str_before then
    v_bad := array_append(v_bad, format(
      'A CONVERSATION-TOPIC PROBE ROLLBACK IS BROKEN — support_triage_rules %s -> %s (counts scoped to tenants %s and %s). A surviving probe rule is not a dormant row: classify_support_text reads every active rule in the workspace on the first user message of every support conversation, so real customer traffic would be filed under a probe category, and the inbox filter and the history report would both show it. Stop running this until it is fixed: it runs on every certify.',
      v_str_before, v_str_after, v_tenant, v_other_tenant));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_leak_tp, 0) <> 0 or coalesce(v_leak_da, 0) <> 0 then
    v_bad := array_append(v_bad, format(
      'TRUST PROBE ROWS SURVIVED — %s trust polic(ies) belonging to a "vddp probe employee…" (or the probe decoy) and %s autonomy dial(s) on one are in production. A level-0 policy is inert; a de_autonomy row is NOT — it is read by resolve_de_autonomy and enforced by decide_action_execution, playbook-execute, de-answer and widget-ask.',
      coalesce(v_leak_tp, 0), coalesce(v_leak_da, 0)));
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
    'note: probes_completed=%s probes_attempted=18 assertions=%s caller=%s role=authenticated tenants=%s,%s archetype=%s — EIGHTEEN accepts driven to SUCCESS so the refusals mean something (probe 1 owner+routable kind; 4 a parked proposal after a second Park was refused; 5d the owner on the row a tenant_user was refused; 6 the other tenant''s owner in their OWN workspace; 7 the routable sibling; 7e the twice-failed row once routable; 9 the row an unidentified caller was refused on; 10b the same owner with a connector that IS theirs; 11c the workspace''s own owner on the row a platform operator was refused on; 12 the employee hire itself; 13a the hire whose systems step raised 22023 and survived; 14 the owner on the employee row a tenant_user was refused; 15a a pattern-bearing guardrail, created under RLS by the owner and stamped; 15e5 the SAME accept on a whitespace-padded payload, which is the inversion that proves the trim; 15l the owner on the guardrail row a tenant_user was refused; 16a a procedure, drafted and key-stamped under RLS by the owner and stamped here; 16g the owner on the procedure row a tenant_user was refused; 17a a trust rule, on an employee hired through the ordinary accept in the SAME session, recorded at level 0 with NO ladder; 17e13 the owner on the trust_rule row a tenant_user was refused; 18b TEN conversation topics in ONE session, each created under RLS by the owner and stamped here; 18h the owner on the topic row a tenant_user was refused). Rows unchanged in the two probe tenants: %s proposals, %s sessions, %s connectors, %s decision audit events, %s employees (excluding the Workspace Assistant), %s playbook definitions, %s guardrail rules, %s trust policies, %s autonomy dials, %s triage rules; %s tagged connector(s), %s tagged proposal(s), %s tagged employee(s), %s tagged archetype(s), %s tagged guardrail rule(s), %s tagged playbook definition(s), %s tagged trust polic(ies) and %s tagged autonomy dial(s) survive. NOT proven here: PostgREST''s JWT transport (the probes set request.jwt.claim.sub themselves), CONCURRENT as opposed to sequential double-click, whether the four edge-function enforcement paths actually withhold an answer, THE TRUST LADDER ACTUALLY ENFORCING ANYTHING (no policy on this platform is above level 0, so probe 17 proves what a level-0 policy does NOT do and inverts it by calling trust_apply_level directly — it does not prove what a PROMOTED policy would do end to end through decide_action_execution), WHETHER A REAL CONVERSATION IS EVER LABELLED (probe 18 drives classify_support_text directly; trg_triage_support_conversation is an AFTER INSERT trigger on de_messages and firing it would mean putting a fake customer message into a real workspace), WHETHER ANYTHING ROUTES ON A TOPIC (nothing does — de_conversations.de_id is stamped at INSERT by widget-ask and email-inbound, before the first message exists, and no reader of de_conversations.category selects an employee; the card says so and probe 18 pins routes_to_employee=false), and THE PLAYBOOK DRAFTER ITSELF — playbook-draft is Deno and needs a live model, so probe 16 performs the two writes it makes rather than calling it (they are all Deno; what is proven is that the rows these accepts create are the shape those readers select for, and for a procedure that means the shape THREE of the eight published gates were driven against here, and the shape the other five read for too).',
    v_probes_done, v_checks, v_caller, v_tenant::text, v_other_tenant::text, v_arch_key,
    v_prop_after, v_sess_after, v_conn_after, v_audit_after,
    v_emp_after, v_pb_after, v_gr_after, v_tp_after, v_da_after, v_str_after,
    coalesce(v_leak_conn, 0), coalesce(v_leak_prop, 0),
    coalesce(v_leak_emp, 0), coalesce(v_leak_arch, 0), coalesce(v_leak_gr, 0), coalesce(v_leak_pb, 0),
    coalesce(v_leak_tp, 0), coalesce(v_leak_da, 0)));

  if v_probes_done < 18 then
    v_bad := array_append(v_bad, format(
      'only %s of 18 probes completed. The ones that did not are named above with their SQLSTATE; a probe that cannot run is a failure, never a skip, because its assertions did not compare anything this run.',
      v_probes_done));
  end if;

  return array_cat(v_bad, v_notes);
end;
$function$
;

comment on function public.verify_decide_discovery_proposal() is
  'Behavioural probe over decide_discovery_proposal, run by certify. EIGHTEEN probes as of migration 754. Returns findings plus a `note:` line carrying probes_completed, probes_attempted and the assertion count, so zero comparisons can never look like a clean result. '
  'Every probe drives real calls inside a sub-block that always aborts, so nothing it writes survives; the rollback section re-counts discovery_proposals, discovery_sessions, connectors, decision audit events, digital_employees, playbook_definitions, guardrail_rules, trust_policies, de_autonomy and — since 754 — support_triage_rules, scoped to the two probe tenants, and names survivors rather than only counting them. '
  'Probe 18 (754) drives the conversation_type path: TEN topics in ONE session, each created under RLS by the workspace owner and stamped here, because the founder''s instruction for this kind was that a customer may name ten different things and migration 740''s unique index made that impossible until 754 gave the kind its own identity_key arm. It also drives classify_support_text in both directions, the identity index in both directions, support_triage_rules_source_proposal_uq itself under a same-proposal double insert (with the NULL-carrying inversion that proves the predicate is still partial), the DELETE a customer would use to take a topic off, and eight refusals. '
  'Probes 7 and 14 derive their subject — the kinds discovery_proposals_kind_check admits minus the `when` arms really present in the router''s comment-stripped body — and 754 keeps them drivable with the `__unrouted_probe__` sentinel now that all six product kinds route. Do not delete them to silence a red: they are the only place proving a refusal leaves a reason on the row, that `attempts` increments rather than being set, and that the router opened for exactly the kinds intended.';


-- ---------------------------------------------------------------------------
-- PERIMETER, restated, so the intended surface is explicit rather than
-- inherited. This function manipulates request.jwt.claim.sub to impersonate
-- real people and switches role to `authenticated`. anon and authenticated must
-- never hold EXECUTE on it.
-- ---------------------------------------------------------------------------
revoke all on function public.verify_decide_discovery_proposal()
  from public, anon, authenticated, service_role;
grant execute on function public.verify_decide_discovery_proposal()
  to service_role;


-- ===========================================================================
-- PART 6 — THE MIGRATION VERIFIES ITSELF, AND ROLLS BACK IF IT CANNOT.
--
-- This migration calls the checker it just extended and asserts
-- the result is clean, so a defect rolls the WHOLE FILE back rather than
-- shipping beside a red probe.
--
-- ⚠⚠ THIS BLOCK DID NOT EXIST WHEN 754 WAS WRITTEN, AND THAT IS THE DEFECT IT
-- CLOSES. 751, 752 and 753 each end with one; 751's caught its own defect at
-- apply time (14 of 15 probes, 138 of 169 assertions) and rolled back with the
-- ledger untouched. Counting calls to verify_decide_discovery_proposal() across
-- the four files measured 751 -> 9, 752 -> 8, 753 -> 8, 754 -> 4 — and all four
-- of 754's were the CREATE, the COMMENT, the REVOKE and the GRANT. It never
-- called the function. A migration that ships eighteen probes and runs none of
-- them at apply time would apply silently no matter what they say, which is the
-- same class of defect as a gate that has never fired.
--
-- Same shape as 753's block, with the denominators moved to the new totals, the
-- static ratchet re-aimed at the conversation_type branch, and the live pins
-- that are specific to this kind:
--   · the SENTINEL derivation — the set of kinds the CHECK admits minus the
--     `when` arms really in the router must be EXACTLY {__unrouted_probe__}.
--     One arm, three failure modes: PART 3 not landing, somebody giving the
--     sentinel a branch, and a product kind losing one. Probes 7 and 14 drive
--     whatever that set returns, so it is their precondition.
--   · PATH B, WHICH IS THE MIRROR OF 753's PIN. 753 asserts `authenticated`
--     CANNOT write trust_policies, because Path A rests on there being no
--     browser write path. This kind is Path B and rests on the opposite: the
--     browser DOES write support_triage_rules, as the signed-in human under
--     RLS, and this RPC only verifies and stamps. Both are assumptions, and an
--     assumption that is remembered rather than asserted is the one that goes
--     stale.
--   · the band's premise, MEASURED rather than quoted from the header.
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
  v_router    text;
  v_kindchk   text;
  v_kinds     text[];
  v_unrouted  text[];
  v_idkey     text;
  v_idgen     text;
  v_uqdef     text;
  v_cls       text;
  v_rules_n   integer;
  v_max_ord   integer;
  v_min_catch integer;
  v_in_band   integer;
begin
  -- Vacuity guard: the thing under test must exist before we claim anything
  -- about what it found.
  if to_regprocedure(v_sig) is null then
    raise exception '754: verify_decide_discovery_proposal() does not exist after this migration created it';
  end if;

  -- ── kept from 746, 751, 752 and 753. This migration rewrote the whole
  -- function body, so "I only added a branch" is a claim about a 1,600-line
  -- replacement and has to be checked like one: the branches that were already
  -- there must still be there, or probes 12/13/15/16/17 would be ABORTING
  -- rather than failing.
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
       and p.prosrc like '%when ''employee'' then%'
       and p.prosrc like '%install_role_systems%') then
    v_bad := array_append(v_bad, '754: decide_discovery_proposal carries no `employee` branch calling install_role_systems — 746''s work was dropped by this replacement');
  end if;
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
       and p.prosrc like '%when ''guardrail'' then%') then
    v_bad := array_append(v_bad, '754: decide_discovery_proposal carries no `guardrail` branch — 751''s work was dropped by this replacement, and probe 15 would be aborting rather than failing');
  end if;
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
       and p.prosrc like '%when ''procedure'' then%'
       and p.prosrc like '%playbook_studies%') then
    v_bad := array_append(v_bad, '754: decide_discovery_proposal carries no `procedure` branch reading playbook_studies — 752''s work was dropped by this replacement, and probe 16 would be aborting rather than failing');
  end if;
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal'
       and p.prosrc like '%when ''trust_rule'' then%'
       and p.prosrc like '%seed_de_trust_policy%') then
    v_bad := array_append(v_bad, '754: decide_discovery_proposal carries no `trust_rule` branch calling seed_de_trust_policy — 753''s work was dropped by this replacement, and probe 17 would be aborting rather than failing');
  end if;

  -- ══ THE SENTINEL, AND IT IS PROBES 7 AND 14'S ENTIRE PRECONDITION ═════════
  -- Derived exactly as the verifier's own fixtures block derives it — the kinds
  -- discovery_proposals_kind_check admits, minus the `when '<kind>' then` arms
  -- really present in the router's COMMENT-STRIPPED body — and asserted to be
  -- exactly the sentinel.
  --
  -- ⚠ Not three separate arms, because it is one question with three ways of
  -- going wrong, and each of them ends the same way: probes 7 and 14 drive
  -- nothing.
  --   · PART 3 did not land          -> the set is EMPTY, both probes abort
  --   · somebody gave the sentinel a `when` arm -> the set is EMPTY, ditto
  --   · a product kind lost its arm  -> the set gains a REAL kind, and both
  --     probes would then be asserting that a live branch refuses its own kind
  --     — fifteen assertions still running and comparing nothing, which is the
  --     exact trap 751 and 752 each walked into by renaming rather than
  --     deriving.
  -- ⚠ `position`, not `like`: `_` is LIKE's single-character wildcard and every
  -- kind here contains one, so `%when 'trust_rule' then%` would also be
  -- satisfied by `when 'trustXrule' then`.
  v_checks := v_checks + 1;
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_router
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';
  select pg_get_constraintdef(c.oid) into v_kindchk
    from pg_constraint c
   where c.conrelid = 'public.discovery_proposals'::regclass
     and c.conname  = 'discovery_proposals_kind_check';
  if v_router is null or length(v_router) < 5000
     or position('case v_p.kind' in v_router) = 0 or v_kindchk is null then
    v_bad := array_append(v_bad, format('754: the unroutable-kind derivation could not read what it needs — the router''s comment-stripped body came back %s character(s) and %s the `case v_p.kind` dispatch, and discovery_proposals_kind_check came back %L. UNREADABLE IS NOT EMPTY, and this arm refuses to answer rather than reporting a clean derivation it could not perform.',
      coalesce(length(v_router)::text, 'NULL'),
      case when coalesce(v_router, '') like '%case v_p.kind%' then 'contains' else 'does NOT contain' end,
      coalesce(left(coalesce(v_kindchk, ''), 120), 'NULL')));
  else
    select coalesce(array_agg(m[1] order by m[1]), '{}'::text[]) into v_kinds
      from regexp_matches(v_kindchk, '''([a-z_]+)''::text', 'g') m;
    select coalesce(array_agg(k order by k), '{}'::text[]) into v_unrouted
      from unnest(coalesce(v_kinds, '{}'::text[])) k
     where position('when ''' || k || ''' then' in v_router) = 0;
    if v_unrouted is distinct from array['__unrouted_probe__'] then
      v_bad := array_append(v_bad, format('754: the kinds discovery_proposals_kind_check admits minus the `when` arms really in the router derive to {%s}, not {__unrouted_probe__}. The CHECK admits {%s}. Probes 7 and 14 drive exactly that set: empty means NEITHER RUNS — MEASURED by deleting the sentinel from the CHECK in an aborting copy, which took probes_completed to 16 and the assertion count to 243, a collapse of 22 — and a REAL kind in it means both probes are asserting that a live branch refuses its own kind, fifteen assertions still running and comparing nothing, which is this repo''s oldest mistake and the reason the sentinel exists rather than a fifth rename.',
        array_to_string(coalesce(v_unrouted, '{}'::text[]), ', '),
        array_to_string(coalesce(v_kinds, '{}'::text[]), ', ')));
    end if;
  end if;

  -- ══ THE REBUILT identity_key, READ FROM THE CATALOG ═══════════════════════
  -- BLOCKER 1 of this file: without the conversation_type arm every topic in a
  -- session shares `source_dimension`, they all carry the same identity_key,
  -- and the second insert dies on 23505 — the founder's "ten different things"
  -- is mechanically impossible. Probe 18(a) drives ten inserts and would report
  -- it, but this reads the DEFINITION rather than the symptom, so a finding
  -- names the cause.
  v_checks := v_checks + 1;
  select a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid)
    into v_idgen, v_idkey
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.discovery_proposals'::regclass
     and a.attname = 'identity_key';
  if coalesce(v_idgen, '') <> 's'
     or position('''conversation_type''::text' in coalesce(v_idkey, '')) = 0
     or position('''set_category''::text' in coalesce(v_idkey, '')) = 0 then
    v_bad := array_append(v_bad, format('754: discovery_proposals.identity_key is attgenerated=%L and generates %L. It must be a STORED generated column whose expression carries the `when ''conversation_type'' then payload ->> ''set_category''` arm PART 1 rebuilt it for. Without that arm every conversation_type in one session collapses onto source_dimension, the second insert raises 23505, and a customer who names ten topics is offered one.',
      coalesce(v_idgen, 'NULL'), coalesce(left(v_idkey, 300), 'NULL')));
  end if;
  -- ...and the index the expression exists to be the right-hand column of. A
  -- generated column cannot be ALTERed, so PART 1 is DROP + ADD and takes the
  -- index with it; leaving it dropped would make the emitter's onConflict
  -- upsert raise 42P10 on every interview.
  v_checks := v_checks + 1;
  if not exists (
    select 1 from pg_indexes i
     where i.schemaname = 'public' and i.tablename = 'discovery_proposals'
       and i.indexname = 'discovery_proposals_identity_uq'
       and i.indexdef like '%UNIQUE%'
       and i.indexdef like '%session_id%'
       and i.indexdef like '%kind%'
       and i.indexdef like '%identity_key%') then
    v_bad := array_append(v_bad, '754: discovery_proposals_identity_uq is missing or is no longer a UNIQUE index over (session_id, kind, identity_key). PART 1 drops it with the column and recreates it; discovery-interview/index.ts upserts `onConflict: session_id,kind,identity_key` and would raise 42P10 on every interview without it, and probe 18(d) would have no index to drive in either direction.');
  end if;

  -- ══ THE IDEMPOTENCY MECHANISM, AND IT IS AN INDEX, NOT A CONVENTION ═══════
  -- support_triage_rules carried NO unique index of any kind before this file
  -- (measured 2026-08-17: primary key, the set_priority CHECK, the tenant FK,
  -- nothing else), so a browser dying between the insert and the stamp left an
  -- orphan and a retry minted a second LIVE rule. The client's find-first is a
  -- courtesy that turns the 23505 into a re-use; this is the guarantee.
  --
  -- ⚠ It is pinned here as well as by probe 18(d2) because the two claims are
  -- different: (d2) drives a second row and watches it raise, which is the
  -- BEHAVIOUR; this reads the definition, which is what a person reading the
  -- header is being told. Dropping the index left the whole verifier at 18/18
  -- probes, 262 assertions and zero findings until (d2) existed.
  v_checks := v_checks + 1;
  select i.indexdef into v_uqdef
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'support_triage_rules'
     and i.indexname = 'support_triage_rules_source_proposal_uq';
  if v_uqdef is null or v_uqdef not like '%UNIQUE%' or v_uqdef not like '%source_proposal_id%' then
    v_bad := array_append(v_bad, format('754: support_triage_rules_source_proposal_uq is missing or is not a UNIQUE index over source_proposal_id (indexdef=%L). It is the ONLY thing making a conversation-topic accept idempotent under a race, and this table had no unique index of any kind before this migration.',
      coalesce(v_uqdef, 'NULL')));
  end if;
  -- ⚠ AND IT MUST BE PARTIAL. The 198 rules that exist today carry NULL in this
  -- column, and every workspace's eleven seeded rules always will. This is
  -- separate from the arm above on purpose: a non-partial index over the same
  -- column would satisfy that one, and the header's claim is specifically about
  -- the predicate. Probe 18(d2) inverts it live by inserting a NULL-carrying
  -- rule and requiring it to SUCCEED.
  v_checks := v_checks + 1;
  if coalesce(v_uqdef, '') not like '%WHERE (source_proposal_id IS NOT NULL)%' then
    v_bad := array_append(v_bad, format('754: support_triage_rules_source_proposal_uq is not the PARTIAL index this file documents — indexdef=%L, expected a `WHERE (source_proposal_id IS NOT NULL)` predicate. The predicate is what the header calls "the whole point": it is what lets the rules that carry NULL keep existing while two rules claiming the SAME proposal collide.',
      coalesce(v_uqdef, 'NULL')));
  end if;

  -- ══ PATH B'S OWN ARGUMENT, PINNED LIVE — THE MIRROR OF 753's ═════════════
  -- 753 asserts `authenticated` CANNOT write trust_policies, because Path A
  -- (write from inside the SECURITY DEFINER body) is only defensible while
  -- there is no browser write path to preserve. This kind is the opposite case
  -- and rests on the opposite fact: there IS one, so the browser creates the
  -- rule as the signed-in human under RLS and this RPC verifies and stamps.
  --
  -- The day `authenticated` loses this grant, Path B stops being reachable at
  -- all — createTriageRuleFromProposal would fail, no id would ever be passed,
  -- and EVERY accept of this kind would refuse at "no topic rule % in this
  -- workspace" with a message about authorisation, which is not what happened.
  -- The kind would have to be re-decided as Path A. Asserted rather than
  -- remembered, for the same reason 753 gives.
  v_checks := v_checks + 1;
  if not has_table_privilege('authenticated', 'public.support_triage_rules', 'INSERT') then
    v_bad := array_append(v_bad, '754: `authenticated` can no longer INSERT into support_triage_rules. Path B for this kind rests on the browser being the writer — the rule is created by the signed-in person under RLS (support_triage_rules_admin_write) and this RPC only verifies the literals and stamps the id. Without the grant there is no writer at all: every accept refuses at the created-object read-back, with a message about a missing rule rather than about a missing permission, and the kind needs re-deciding as Path A.');
  end if;

  -- ── the objects this branch routes at must exist. `to_regclass` and
  -- pg_attribute, not a stored marker: migration `applied_at` lies, and a
  -- branch pointing at a dropped table would refuse every accept with a 42P01
  -- nobody could read.
  v_checks := v_checks + 1;
  if to_regclass('public.support_triage_rules') is null
     or not exists (select 1 from pg_attribute
                     where attrelid = 'public.support_triage_rules'::regclass
                       and attname = 'source_proposal_id' and not attisdropped) then
    v_bad := array_append(v_bad, '754: support_triage_rules is missing, or PART 2''s source_proposal_id column is not on it. The branch reads that column to decide whether the rule the caller named belongs to this proposal, so without it every accept raises 42703 and probe 18 has nothing to measure.');
  end if;

  -- ══ THE MATCHER, READ FROM THE FUNCTION RATHER THAN ASSUMED ══════════════
  -- The branch deliberately does NOT copy 751's regex-metacharacter screen, and
  -- the header's justification is measured from classify_support_text itself:
  -- it matches with `position`, so every character in a triage pattern means
  -- itself and 751's screen would be refusing safe input. If that function ever
  -- became regex-based, this accept would be admitting patterns that mean
  -- something other than what the card showed — the §11b failure this whole
  -- programme exists to prevent.
  -- The other two fragments are the two facts the branch REFUSES on: rules are
  -- walked in rule_order and return on the FIRST match (the band), and a rule
  -- with no pattern returns IMMEDIATELY for every message (the catch-all).
  v_checks := v_checks + 1;
  if to_regprocedure('public.classify_support_text(uuid, text)') is null then
    v_bad := array_append(v_bad, '754: classify_support_text(uuid, text) is missing at the signature probe 18 calls. Full-signature form on purpose: an unresolvable name ERRORs 42883 rather than quietly returning false. Nothing labels a conversation without it, and the entire card copy for this kind describes what it does.');
  else
    select lower(p.prosrc) into v_cls
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'classify_support_text';
    v_checks := v_checks + 1;
    if v_cls is null or length(v_cls) < 300
       or position('position(frag in v_low) > 0' in v_cls) = 0
       or position('order by rule_order, created_at' in v_cls) = 0
       or position('r.match_pattern is null or btrim(r.match_pattern) = ''''' in v_cls) = 0 then
      v_bad := array_append(v_bad, format('754: classify_support_text no longer matches the way this branch''s refusals are justified (body %s character(s); position-matcher %s, rule_order walk %s, empty-pattern catch-all %s). All three are load-bearing: `position` is why the branch does NOT screen regex metacharacters (751''s screen would refuse safe input here), the ordered walk with a first-match return is why the accept confines a topic to the 200..9998 band, and the catch-all return is why a NULL pattern is refused outright rather than stored.',
        coalesce(length(v_cls)::text, 'NULL'),
        case when position('position(frag in v_low) > 0' in coalesce(v_cls,'')) > 0 then 'present' else 'GONE' end,
        case when position('order by rule_order, created_at' in coalesce(v_cls,'')) > 0 then 'present' else 'GONE' end,
        case when position('r.match_pattern is null or btrim(r.match_pattern) = ''''' in coalesce(v_cls,'')) > 0 then 'present' else 'GONE' end));
    end if;
  end if;

  -- ══ THE BAND'S PREMISE, MEASURED — NOT QUOTED FROM THE HEADER ════════════
  -- The accept confines a topic to rule_order 200..9998, and both halves of
  -- that band are claims about rules that already exist:
  --   · ABOVE 100 — an interview topic must never outrank Safety (10) or
  --     Security (20). True only while every built-in sits BELOW 200.
  --   · BELOW 9999 — it must still be consulted before the catch-all. True
  --     only while the catch-all sits ABOVE 9998.
  -- ⚠ THE DENOMINATOR IS ASSERTED FIRST. `max(...) < 200` over an empty table
  -- is NULL and would sail through; zero findings from zero rows looks exactly
  -- like a clean result. The count is reported in the notice either way.
  select count(*),
         max(rule_order) filter (where rule_order < 9999),
         min(rule_order) filter (where rule_order >= 9999),
         count(*) filter (where rule_order between 200 and 9998)
    into v_rules_n, v_max_ord, v_min_catch, v_in_band
    from public.support_triage_rules
   where active and source_proposal_id is null;
  v_checks := v_checks + 1;
  if coalesce(v_rules_n, 0) < 11 then
    v_bad := array_append(v_bad, format('754: only %s active triage rule(s) that predate this migration were found, and every workspace is seeded with eleven. The band assertion below compares against them, so with fewer than one workspace''s worth it would be reporting a clean result about nothing.',
      coalesce(v_rules_n::text, 'NULL')));
  end if;
  v_checks := v_checks + 1;
  if coalesce(v_max_ord, 0) >= 200 or coalesce(v_min_catch, 0) <= 9998 or coalesce(v_in_band, 0) <> 0 then
    v_bad := array_append(v_bad, format('754: the 200..9998 band is no longer the thing this file says it is. Measured over %s active rule(s) carrying no source_proposal_id: the highest non-catch-all sits at %s (must be < 200, or an accepted topic could outrank Safety and Security), the lowest catch-all at %s (must be > 9998, or an accepted topic could never be reached at all), and %s already sit INSIDE the band. The card promises a customer that their topic runs after the built-in urgent categories and before the catch-all, and that promise is about these rows.',
      coalesce(v_rules_n::text, 'NULL'), coalesce(v_max_ord::text, 'NONE'),
      coalesce(v_min_catch::text, 'NONE'), coalesce(v_in_band::text, 'NULL')));
  end if;

  -- ── added by 754. THE STATIC RATCHET, WITH ITS LINE COMMENTS STRIPPED, A
  -- VACUITY GUARD, AND EVERY PIN UNIQUE TO WHAT IT CHECKS. All three are
  -- load-bearing and none is optional; 751 shipped this arm with a conjunct
  -- that was ALREADY TRUE of the pre-existing body, so deleting the protection
  -- it guarded would have left it green.
  --
  --  · STRIPPED, because prosrc includes comments and this branch's prose
  --    quotes its own checks at length.
  --  · GUARDED, because a regexp that ate more than it should would return a
  --    short body, every branch test would answer false, and this arm would
  --    report "the branch is missing" about a branch that is present.
  --  · AND EACH PIN IS A FRAGMENT OF THIS BRANCH'S OWN COMPARISON OR REFUSAL,
  --    chosen so it appears NOWHERE ELSE in the function — verified by counting
  --    below rather than by reading. ⚠ `if p_created_object_id is null then`
  --    was the obvious pin for Path B's shape and it was MEASURED AT FOUR
  --    OCCURRENCES (guardrail, procedure, connector and this kind all use it),
  --    and the shared refusal sentence "add it as the signed-in person…" at
  --    TWO. Both were replaced rather than kept: a pin that occurs more than
  --    once is satisfied by code that has nothing to do with what it guards.
  v_checks := v_checks + 1;
  declare
    v_src     text;
    v_missing text[] := '{}';
  begin
    select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';

    if v_src is null or length(v_src) < 6000 or v_src not like '%case v_p.kind%' then
      v_bad := array_append(v_bad, format('754: the comment-stripped body of decide_discovery_proposal came back %s characters long and %s the `case v_p.kind` dispatch. The ratchet below cannot tell a missing branch from an unreadable body, so it is refusing to answer rather than guessing.',
        coalesce(length(v_src)::text, 'NULL'),
        case when coalesce(v_src,'') like '%case v_p.kind%' then 'contains' else 'does NOT contain' end));
    else
      -- ⚠ `position(… in v_src) = 0`, NOT `not like '%…%'`, and 752's header
      -- explains the two reasons: `_` is LIKE's single-character wildcard and
      -- every identifier here carries one, and `\` is LIKE's escape character
      -- so a pin containing `\|` would ask for a literal `|`. `position` does
      -- no pattern interpretation at all — which is what lets the empty-
      -- alternative screen below be pinned as the regex it literally is.
      if position('when ''conversation_type'' then' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the `when ''conversation_type'' then` branch');
      end if;
      -- THE THREE TRIMS, each by its SECOND argument. One-argument btrim strips
      -- SPACES ONLY and the client composes with JS .trim(); all three of these
      -- literals are compared BYTE FOR BYTE against what the browser wrote, so
      -- a lone tab surviving here and not there is a permanently stuck proposal
      -- sitting beside a live rule.
      if position('payload ->> ''label'',         E''' in v_src) = 0
         or position('payload ->> ''set_category'',  E''' in v_src) = 0
         or position('payload ->> ''match_pattern'', E''' in v_src) = 0 then
        v_missing := array_append(v_missing, 'one of the three explicit whitespace sets on the label/set_category/match_pattern trims — one-argument btrim strips spaces only, and all three literals are compared byte for byte against what the browser wrote');
      end if;
      -- THE CATEGORY TOKEN SHAPE. de_conversations.category is read back by the
      -- inbox filter as an EXACT string and rendered by the History report, so
      -- the shape is fixed here rather than left to whatever a model wrote.
      if position('v_ct_cat !~ ''^[a-z0-9]+(_[a-z0-9]+)*$''' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the category-token shape test (`^[a-z0-9]+(_[a-z0-9]+)*$`), without which a model''s free text becomes a category the inbox filter compares exactly and the History report renders raw');
      end if;
      -- ⚠⚠ THE SHARPEST EDGE ON THIS KIND. A rule with no pattern is a
      -- CATCH-ALL: classify_support_text returns IMMEDIATELY for every message
      -- reaching it, so every topic below it would silently stop being used.
      if position('if v_ct_pattern is null then' in v_src) = 0 then
        v_missing := array_append(v_missing, '⚠ THE CATCH-ALL REFUSAL (`if v_ct_pattern is null then`) — a rule with no pattern returns immediately for EVERY message, so accepting one would silently swallow every conversation the rules below it were written for. All 18 live tenants carry exactly one such rule, at 9999, called "Default"; an interview must never mint a second');
      end if;
      if position('v_ct_pattern ~ ''(^\||\|\||\|$)''' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the empty-alternative screen (`(^\||\|\||\|$)`) — an empty fragment is SKIPPED by classify_support_text rather than matching everything, so this is refused because the card would be showing a phrase that is never looked at, not because it is dangerous');
      end if;
      -- PATH B'S OWN SHAPE, pinned by this kind's own sentence because the
      -- shared one occurs twice and the `if` occurs four times.
      if position('''a conversation topic is accepted by creating the rule first' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the Path B requirement (this kind''s own "a conversation topic is accepted by creating the rule first" refusal), without which the accept would proceed with no rule to verify');
      end if;
      -- THE RE-READ. An id a caller hands us is not its own authorisation, and
      -- the whole row is read back so every literal below can be compared.
      if position('select * into v_ct_rule' in v_src) = 0
         or position('no topic rule % in this workspace' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the created-object re-read against THIS proposal''s tenant (`select * into v_ct_rule` / "no topic rule % in this workspace") — a created-object id is not its own authorisation, and every comparison below reads that row');
      end if;
      -- ⚠⚠ THE IDEMPOTENCY CHECK. Without it one proposal can be linked to a
      -- rule that belongs to another, and the customer ends with two rules
      -- where they agreed to one.
      if position('v_ct_rule.source_proposal_id is distinct from v_p.id' in v_src) = 0 then
        v_missing := array_append(v_missing, '⚠ THE PROVENANCE CHECK (`v_ct_rule.source_proposal_id is distinct from v_p.id`) — this column plus its partial unique index IS the idempotency mechanism for this kind, and without the comparison the stamp would accept a rule created for a different card');
      end if;
      -- THE CONSENTED LITERALS, all three, byte for byte. §11b applied to a
      -- topic rule: the card rendered the name, the words and the token.
      if position('v_ct_rule.set_category is distinct from v_ct_cat' in v_src) = 0
         or position('v_ct_rule.match_pattern is distinct from v_ct_pattern' in v_src) = 0
         or position('v_ct_rule.name is distinct from v_ct_label' in v_src) = 0 then
        v_missing := array_append(v_missing, 'one of the three consented-literal comparisons (set_category / match_pattern / name) — the card showed exactly these three strings, and without all three a customer can agree to one rule and get another with no later reader able to tell');
      end if;
      -- ...and it has to actually be CONSULTED. classify_support_text filters
      -- `WHERE tenant_id = ... AND active`.
      if position('not coalesce(v_ct_rule.active, false)' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the active check (`not coalesce(v_ct_rule.active, false)`) — an inactive rule is a card saying a topic is being tracked while nothing looks at it');
      end if;
      -- ⚠⚠ THE BAND, BOTH HALVES. Above 100 so a topic never outranks Safety
      -- or Security; below 9999 so it is still reached at all.
      if position('coalesce(v_ct_rule.rule_order, 100) < 200' in v_src) = 0
         or position('coalesce(v_ct_rule.rule_order, 100) > 9998' in v_src) = 0 then
        v_missing := array_append(v_missing, '⚠ ONE OR BOTH HALVES OF THE 200..9998 BAND — below 200 an interview topic can outrank Safety (10) and Security (20), which is "someone is hurt" being re-filed as a delivery delay; above 9998 it sits behind the catch-all and can never fire. The column DEFAULTS to 100 and every live tenant carries a baseline rule at exactly 100, so a defaulted row ties with it and loses on a timestamp no screen shows');
      end if;
      -- THE TWO COUNTS THAT MAKE THE CARD HONEST rather than reassuring.
      if position('into v_ct_ties' in v_src) = 0 or position('into v_ct_ahead' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the tie and ahead-of-it counts (`into v_ct_ties` / `into v_ct_ahead`) — ties break on created_at, which no screen shows, so an uncounted tie is a routing decision made invisibly');
      end if;
      -- THE COUNTERS THAT STATE THE NEGATIVE. An absent fact and a false one
      -- read identically to a later auditor, and the previous version of this
      -- card promised routing by saying nothing.
      if position('''routes_to_employee'', false' in v_src) = 0
         or position('''labels_conversations'', true' in v_src) = 0 then
        v_missing := array_append(v_missing, 'the counters that state the negative (`routes_to_employee` literally false and `labels_conversations` literally true) — a false absence is exactly how the previous version of this card came to promise routing');
      end if;

      -- ⚠⚠ THE NEGATIVE PINS, AND THEY ARE THE MOST IMPORTANT ARM IN THIS
      -- BLOCK, for the same reason 753 gives. Everything this file says about
      -- Path B is a promise that this function does NOT write the rule itself.
      -- A positive pin can be satisfied by code that also does something else;
      -- only these can say the something else is absent.
      if position('insert into public.support_triage_rules' in v_src) > 0
         or position('update public.support_triage_rules' in v_src) > 0
         or position('delete from public.support_triage_rules' in v_src) > 0 then
        v_missing := array_append(v_missing, '⚠ NEGATIVE PIN FIRED: decide_discovery_proposal now writes public.support_triage_rules directly. It must not. This RPC is SECURITY DEFINER and runs as postgres, so a write here bypasses support_triage_rules_admin_write entirely and is the second creation engine contract §8.3 forbids — the rule is created by the SIGNED-IN PERSON under RLS and this function only verifies the literals and stamps the id. It would also silently widen the role bar: RLS admits tenant_manager and the accept gate does not');
      end if;
      if position('update public.de_conversations' in v_src) > 0
         or position('insert into public.de_conversations' in v_src) > 0 then
        v_missing := array_append(v_missing, '⚠ NEGATIVE PIN FIRED: decide_discovery_proposal now writes public.de_conversations. It must not — accepting a topic creates a RULE for conversations that have not happened yet. Touching that table would re-file conversations the customer never agreed to re-file, and `de_id` lives there, which would turn "it labels, it does not route" into a lie');
      end if;

      if coalesce(array_length(v_missing, 1), 0) > 0 then
        v_bad := array_append(v_bad, format('754: decide_discovery_proposal''s CODE (comments stripped, %s characters) is missing %s of the conversation_type branch''s load-bearing parts, or gained one it must not have: %s. Probe 18 would be aborting or answering about something else rather than failing.',
          length(v_src), array_length(v_missing, 1), array_to_string(v_missing, '; ')));
      end if;
    end if;
  end;

  -- ⚠ AND EVERY PIN ABOVE IS UNIQUE TO WHAT IT CHECKS, verified by COUNTING
  -- rather than by reading. 751's ratchet pinned `compliance_pack_key is not
  -- null`, which the EMPLOYEE branch's pack counting already satisfied — so
  -- deleting the guardrail protection it guarded left the check green. A pin
  -- that occurs twice is not a pin, it is a coincidence.
  v_checks := v_checks + 1;
  declare
    v_src2  text;
    v_dupes text[] := '{}';
    v_pin   text;
  begin
    select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src2
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'decide_discovery_proposal';
    foreach v_pin in array array[
      'when ''conversation_type'' then',
      'payload ->> ''label'',         E''',
      'payload ->> ''set_category'',  E''',
      'payload ->> ''match_pattern'', E''',
      'v_ct_cat !~ ''^[a-z0-9]+(_[a-z0-9]+)*$''',
      'if v_ct_pattern is null then',
      'v_ct_pattern ~ ''(^\||\|\||\|$)''',
      '''a conversation topic is accepted by creating the rule first',
      'select * into v_ct_rule',
      'no topic rule % in this workspace',
      'v_ct_rule.source_proposal_id is distinct from v_p.id',
      'v_ct_rule.set_category is distinct from v_ct_cat',
      'v_ct_rule.match_pattern is distinct from v_ct_pattern',
      'v_ct_rule.name is distinct from v_ct_label',
      'not coalesce(v_ct_rule.active, false)',
      'coalesce(v_ct_rule.rule_order, 100) < 200',
      'coalesce(v_ct_rule.rule_order, 100) > 9998',
      'into v_ct_ties',
      'into v_ct_ahead',
      '''routes_to_employee'', false',
      '''labels_conversations'', true'
    ] loop
      if (length(coalesce(v_src2, '')) - length(replace(coalesce(v_src2, ''), v_pin, ''))) / greatest(length(v_pin), 1) <> 1 then
        v_dupes := array_append(v_dupes, format('%L occurs %s time(s)', v_pin,
          (length(coalesce(v_src2, '')) - length(replace(coalesce(v_src2, ''), v_pin, ''))) / greatest(length(v_pin), 1)));
      end if;
    end loop;
    if coalesce(array_length(v_dupes, 1), 0) > 0 then
      v_bad := array_append(v_bad, format('754: %s ratchet pin(s) do not occur EXACTLY ONCE in the comment-stripped body: %s. A pin that also matches somewhere else is satisfied by code that has nothing to do with what it guards — which is precisely how 751''s `compliance_pack_key is not null` stayed green while the protection behind it could have been deleted. A count of 0 means the pin is GONE, which the ratchet above reports separately.',
        array_length(v_dupes, 1), array_to_string(v_dupes, '; ')));
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

  v_checks := v_checks + 1;
  if coalesce(array_length(v_notes, 1), 0) <> 1 then
    v_bad := array_append(v_bad, format('the function returned %s note line(s), expected exactly 1 carrying the denominators', coalesce(array_length(v_notes,1),0)::text));
  end if;

  v_probes  := (substring(coalesce(v_notes[1], '') from 'probes_completed=(\d+)'))::integer;
  v_asserts := (substring(coalesce(v_notes[1], '') from 'assertions=(\d+)'))::integer;

  -- ⚠ EQUALITY, NOT A FLOOR. A probe count that MOVED is as bad as one that
  -- fell: 19 means somebody added a probe without moving probes_attempted or
  -- certify's EXPECTED_PROBES, and 17 means one of them stopped running.
  v_checks := v_checks + 1;
  if coalesce(v_probes, 0) <> 18 then
    v_bad := array_append(v_bad, format('the function reported probes_completed=%L, expected 18. Zero findings from zero probes looks exactly like a clean result, which is the whole reason this number is printed. ⚠ If probes 7 and 14 are the missing ones, read the sentinel finding above BEFORE moving this number: with every product kind routed, the `__unrouted_probe__` sentinel added in PART 3 is the only thing keeping them drivable, and the fix is to restore it rather than to lower the denominator.', coalesce(v_probes::text, 'ABSENT')));
  end if;

  -- ⚠ NOT a pinned constant. Pinning the assertion count would go red every
  -- time a probe legitimately gains a check, and someone would then edit the
  -- pin rather than read it. What must never happen is the number COLLAPSING,
  -- which is what a silently-skipped probe looks like.
  v_checks := v_checks + 1;
  if coalesce(v_asserts, 0) < 265 then
    v_bad := array_append(v_bad, format('the function compared only %L assertion(s). 741 carried 95, 745 carried 98, 746 carried 138, 751 carried 169, 752 carried 202, 753 carried 239, and this carries 265. THE DECOMPOSITION, COUNTED STRUCTURALLY RATHER THAN ESTIMATED — by the method 752 established (counting `v_checks := v_checks + 1` in the shipped verifier BODY) and by splitting that body at the probe boundaries rather than at a character offset: probes 1-17 contribute 233 in BOTH files and are untouched by this migration; PROBE 18 contributes 25 (22 as first written, plus 3 from the fix round''s (d2) arm pinning support_triage_rules_source_proposal_uq itself); the ROLLBACK section goes 6 -> 7, the one new arm being support_triage_rules. 233 + 25 + 7 = 265, and the same split run against 753''s body returns 233 + 6 = 239, which is exactly what 753''s own note reports — that agreement is what makes the method a measurement rather than an assertion. ⚠ A RAW GREP OF THIS FILE IS NOT THIS NUMBER AND NEVER WAS. It also counts THIS DO BLOCK''s own 27 — a different variable in a different scope, reported separately as the second number in the failure line above — and every occurrence sitting in prose, including the one in this very sentence, which is why the total moves when a comment is rewrapped. Before PART 6 existed that grep read 266 against a header claiming 265, and the extra one was a `--` comment; nobody had reconciled the two. Count the span from `CREATE OR REPLACE FUNCTION public.verify_decide_discovery_proposal()` to its `$function$` and nothing else. A collapse means probes are being skipped rather than run. scripts/certify.mjs carries the same floor and must move with it.', coalesce(v_asserts::text, 'ABSENT')));
  end if;

  v_checks := v_checks + 1;
  if coalesce(array_length(v_findings, 1), 0) > 0 then
    v_bad := array_append(v_bad, format('%s finding(s) from the live run: %s',
      array_length(v_findings, 1)::text, array_to_string(v_findings, ' | ')));
  end if;

  ------------------------------------------------------------------------
  -- PERIMETER on the verifier ITSELF. It impersonates real people through
  -- request.jwt.claim.sub and switches role; a browser must never reach it.
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

  v_checks := v_checks + 1;
  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'verify_decide_discovery_proposal') then
    v_bad := array_append(v_bad, 'verify_decide_discovery_proposal is SECURITY DEFINER — `set local role` raises 42501 inside a security-definer body, so every probe would abort and the check would report zero probes. It must stay INVOKER; see 751''s header.');
  end if;
  v_checks := v_checks + 1;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'verify_decide_discovery_proposal'
                    and 'search_path=public' = any(coalesce(p.proconfig, '{}'::text[]))) then
    v_bad := array_append(v_bad, 'verify_decide_discovery_proposal has no pinned search_path');
  end if;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '754: % of % assertion(s) failed: %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '754: conversation topics the customer named — verify_decide_discovery_proposal() returned CLEAN on its first run after the conversation_type branch landed: % probe(s) completed, % assertion(s) compared, 0 findings, and % assertion(s) about the migration and the verifier itself passed. The accept verifies a rule the SIGNED-IN PERSON created under RLS and stamps it — it writes support_triage_rules nowhere itself, it touches de_conversations nowhere, and the rule it stamps is confined to rule_order 200..9998, measured live against % baseline rule(s) whose highest non-catch-all sits at % and whose catch-all sits at %. identity_key now carries the conversation_type arm, so ten topics fit in one session; support_triage_rules_source_proposal_uq is PARTIAL, so one proposal owns at most one rule and the % rule(s) carrying NULL keep existing. %',
    v_probes, v_asserts, v_checks, v_rules_n, v_max_ord, v_min_catch, v_rules_n, coalesce(v_notes[1], '(no note)');
end $$;

commit;
