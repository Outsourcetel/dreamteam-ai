-- 778_a_blocked_employee_says_what_it_is_blocked_on.sql
-- ==========================================================================
-- WHY: the decision queue is ILLEGIBLE **and** REPETITIVE.
--
-- Measured on outsourcetel-hq at 2026-08-19: 75 pending DE escalations,
-- oldest 2026-08-05. FORTY-SEVEN of them carry a headline that says nothing
-- about the decision being asked for.
--
-- ⚠⚠ CORRECTION TO THIS FILE'S OWN FIRST DRAFT, AND TO THE REPORT THAT
--    SHIPPED WITH IT. Both said: "those 42 rows carry 42 DISTINCT detail
--    texts and 42 distinct related_ids — the repetition is in the LABEL only,
--    there is genuinely nothing to collapse." THAT WAS WRONG, and wrong in
--    precisely the way this repo has already paid for once: `related_id` is a
--    NON-SUBJECT KEY. de-work mints a FRESH de_work_item on every daily run,
--    so the ids differ BY CONSTRUCTION and counting them measures the loop,
--    not the problem. Grouped on the OBJECTIVE instead, the same 75 rows are:
--
--        Ledger reconciliation sweep       18   2026-08-05 -> 08-19
--        Daily AR sweep                    15   2026-08-05 -> 08-19
--        Daily onboarding progress review   5
--        Financial reporting cadence        2
--
--    The eighteen ledger rows restate a handful of facts once a day for
--    fourteen days. The repetition was never in the label alone. This file's
--    own closing notice already contradicted its header, and the header was
--    the wrong half. THE LESSON GENERALISES: before claiming "nothing to
--    collapse", name the key you grouped on and ask whether the WRITER
--    controls it. A key the writer mints per run can only ever look distinct.
--
-- So this migration does two things, and the second is the larger one:
--   (legibility) rebuild the illegible titles from the employee's own words —
--                BOTH generic shapes, not just the one the first sweep saw;
--   (repetition) stop the pile forming: when an escalation would be raised
--                and an OPEN task already covers the same problem, REFRESH
--                that task instead of inserting another.
--
-- ── ROOT CAUSE OF THE ILLEGIBLE TITLES, enumerated to the writer ─────────
-- public.open_de_escalation (mig 483) ended its title resolution with
--     v_title := coalesce(v_de_name, 'An employee') || ' needs a decision';
-- It has FOUR callers, all in supabase/functions/de-work/index.ts. Three pass
-- a real title (:1108 onboarding-failed-twice, :1189 onboarding-needs-answers,
-- :2053 the question path). The fourth, :1301 `escalate_to_human`, passed
--     p_title: entityName ? `Needs a decision — <entity>` : null
-- and BOTH ARMS produced an unreadable row:
--     null arm       -> the generic fallback, 42 rows, identical sentence;
--     entityName arm -> "Needs a decision — <entity>", 5 rows that name the
--                       customer and never say what the ask is.
--
-- ⚠ HOW THE FIVE WERE MISSED, because the lesson generalises. The first sweep
-- asked `title like '%needs a decision%'` — case-SENSITIVE — and that arm
-- title-cases the N. A case-sensitive match for a phrase the sibling branch
-- capitalises cannot find it. Measured, both ways, on the same corpus:
--       like  '%needs a decision%'  ->  42
--       ilike '%needs a decision%'  ->  47      (+5, all of them arm two)
-- The backfill below therefore has TWO arms and rebuilds 47, and PROBE 18
-- prints both counts so the difference stays visible instead of being a
-- number somebody once checked.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────
--   1. de_escalation_headline(text,int) — ONE derivation of a headline from
--      an employee's own account of why it stopped.
--   2. de_blocker_signature(text) — ONE derivation of WHAT KIND OF BLOCKAGE
--      that account describes. This is the sameness test (see below).
--   3. de_escalation_title(...) — the fallback LADDER, lifted out of
--      open_de_escalation so every rung can be tested without writing a row,
--      and now able to keep an entity name alongside the problem.
--   4. human_tasks gains blocker_signature / blocker_scope / repeat_count /
--      last_raised_at — what the guard matches on and what it shows.
--   5. open_de_escalation — calls the ladder, and REFRESHES an open task that
--      already covers the same problem instead of adding another.
--   6. A BACKFILL of the rows already written (both arms), and of the
--      signature/scope columns so the guard is armed against the queue that
--      already exists rather than only against tomorrow's.
--
-- ── THE SAMENESS TEST, AND THE RULE THAT OUTRANKS IT ─────────────────────
-- ⚠⚠⚠ THIS SECTION REPLACES THE FIRST DRAFT'S GUARD, WHICH WAS REJECTED ON
-- REVIEW. The first draft deduped by folding a repeat into an open task and
-- writing NOTHING — no second exceptions row, and `detail` deliberately left
-- alone. A reviewer drove it on live data through this very function and
-- proved what that costs:
--
--   F2  A NARROWER NEW PROBLEM WAS ABSORBED AND ITS WORDS WERE DESTROYED.
--       Supplier invoice SI-8891, dated 2027, unrelated to the journal
--       import, signature {out_of_range}, folded onto the day-1 row whose
--       signature was {blocked_input, inconsistent, out_of_range}. Then:
--           "SI-8891 text present in human_tasks.detail  ->  0"
--       The second problem existed NOWHERE A PERSON COULD REACH.
--   F3  ON THE LIVE QUEUE THE FACTS DO NOT STAY SEPARATE. Measured here,
--       independently, 2026-08-20: of 28 folds over the pending corpus, NINE
--       were strictly-narrower reports joining a broader row —
--           inconsistent  -> blocked_input+inconsistent+overdue
--           out_of_range  -> blocked_input+inconsistent+out_of_range
--       "the books do not balance" filed behind a row that says the source
--       cannot be read. Containment is ASYMMETRIC and this queue was seeded
--       broad-first, so the asymmetry is not hypothetical.
--   F4  NULL MATCHED NULL. de_escalation_scope returns NULL when there is no
--       objective, the guard compared with `is not distinct from`, and 140 of
--       189 pending escalations carry no objective at all. Two DIFFERENT
--       CUSTOMERS merged through the real writer. Measured here: the old rule
--       folded 189 escalations into 147 rows, the rule below into 161 — the
--       14-row gap IS the set of merges made across a separator that was not
--       there.
--   F1  THE FAIL-OPEN GUARD WAS UNPINNED. Deleting it was invisible to all
--       21 probes and 150 assertions.
--
-- ── THE RULE: COLLAPSE THE ROW, NEVER THE REPORT ─────────────────────────
-- The founder ruled one row, not eighteen — "do not re-ask, update the open
-- one" — and that ruling stands. What loses information is not sharing a row;
-- it is folding a report into a row and recording it nowhere. So the fold is
-- kept and the LOSS is removed:
--
--   1. THE LEDGER ROW IS ALWAYS WRITTEN. Every call writes its own
--      de_exceptions row, deduped or not, cross-linked to whichever
--      human_task the report landed on. This is not "the same pile in another
--      table" — de_exceptions is the employee's exception LOG, rendered on
--      the DE Workbench Exceptions tab (src/pages/tenant/DeWorkbench.tsx ->
--      getDeExceptions), one row per thing the employee reported. The pile
--      the founder objected to is the DECISION QUEUE, and that is the only
--      place this file collapses. NOTE THIS IS ALSO A NO-OP AGAINST TODAY:
--      production writes one exceptions row per escalation right now, so
--      nothing downstream of de_exceptions sees a number it did not see
--      yesterday. The first draft would have SUPPRESSED those rows.
--   2. THE WORDS LAND ON THE CARD THE DECISION IS MADE FROM. On a fold the
--      new reason is APPENDED to human_tasks.detail — never overwritten —
--      unless that text is already there. `detail` is rendered in full in the
--      decision panel (HumanTasksPage.tsx, the selected-task paragraph), so
--      the person deciding reads every distinct report on the card in front
--      of them. IN FULL AND WITH NO CAP — see the writer for why a cap was
--      written, measured and then taken back out.
--   3. THE READER IS TOLD THERE IS MORE INSIDE. The title suffix gains
--      " · N different reports inside" as soon as a row holds more than one.
--      Words a person cannot see they should look for are only half-reachable.
--
-- ⚠ THE INVARIANT, STATED SO IT CAN BE FALSIFIED: after open_de_escalation
-- returns, the reason it was called with is a substring of the task's detail
-- AND is recorded in de_exceptions.situation, cross-linked to that task. No
-- exception, no cap, no branch where it stops holding. PROBE 22 drives it on
-- four shapes; PROBE 13 pins it in the source; every pin is inverted below.
--
-- The one truncation anywhere near this path is NOT introduced here and is
-- named rather than hidden: de_exceptions.situation has been `left(…, 4000)`
-- since mig 483, on the new-row path exactly as on the fold path. A report
-- longer than 4000 characters is clipped in the LEDGER by that pre-existing
-- cap; the card carries it whole either way.
--
-- ── THE OPERATOR, STATED IN FULL ─────────────────────────────────────────
--   FOLD(new -> open)  iff   open.tenant_id = new.tenant_id
--                      and   open.de_id     = new.de_id
--                      and   open.type = 'escalation' and open.status = 'pending'
--                      and   new.scope IS NOT NULL          <- F4
--                      and   open.blocker_scope = new.scope <- SQL `=`, so a
--                              missing separator can never match another
--                      and   new.signature is NOT EMPTY     <- F1
--                      and   open.blocker_signature CONTAINS new.signature
--   ties broken by (created_at, id); FOLD writes the ledger row and the detail
--   append described above and touches neither created_at nor sla_due_at.
--
-- WHY CONTAINMENT SURVIVED THE RECONSIDERATION, MEASURED NOT ASSUMED. All
-- five candidates were replayed over the live pending corpus, 2026-08-20,
-- chronologically, through the same fail-open preconditions (189 raised):
--
--       equality              167 rows      ledger pile 18 -> 9
--       containment           161 rows      ledger pile 18 -> 4
--       containment, tightest 161 rows      ledger pile 18 -> 4
--       overlap               158 rows      (a row absorbs kinds it never
--       containment + union   157 rows       reported; see below)
--
--   * EQUALITY leaves the founder's eighteen at nine. It is not a fix; it is
--     the same complaint with a smaller number, because the model's emphasis
--     wobbles from day to day and each wobble is a new set.
--   * OVERLAP and UNION-GROWTH both let a row absorb kinds it never reported,
--     which destroys the one property worth having (below).
--   * TIGHTEST-COVER — prefer the open row with the SMALLEST containing
--     signature, so a report lands on the most specific row that covers it —
--     is theoretically better and was MEASURED: it moves ZERO of the 189
--     reports on this corpus. A rule that changes nothing is a rule nobody
--     exercises, so it is not shipped. Named here so the next reader does not
--     have to re-derive it.
--
-- CONTAINMENT'S ONE PROPERTY, and it is why the direction is load-bearing:
-- A ROW CAN ONLY EVER ABSORB A REPORT WHOSE BLOCKER KINDS ARE ALL ALREADY ON
-- IT. The first report naming a kind the row does not carry opens a NEW row.
-- A row's signature therefore never changes after it is written and always
-- means exactly what its first report said. PROBE 17 case (4) drives the
-- superset and pins that it is NOT absorbed.
--
-- ── WHAT NO OPERATOR OVER THIS TAXONOMY CAN DO, SAID PLAINLY ─────────────
-- de_blocker_signature throws the SUBJECT away on purpose — that is what
-- makes it department-neutral. So "invoice SI-8891 is dated 2027" and "the
-- journal entries are dated 2027" map to the SAME POINT, {out_of_range}, and
-- NO test over these sets — containment, equality, overlap or any other — can
-- tell them apart. There is no safe sameness test over free text here, and
-- this file does not pretend to have found one. What it does instead is stop
-- depending on the test being safe: the test now decides only WHICH ROW a
-- report's text lands on, never WHETHER it is recorded. Getting the row wrong
-- costs a person one extra paragraph to read. Getting it wrong under the
-- first draft cost them the paragraph.
--
-- AN EMPTY SIGNATURE NEVER DEDUPES, AND NEITHER DOES A MISSING SEPARATOR.
-- Both fail OPEN into their own row. 121 of the 189 pending escalations
-- classify to nothing and 140 carry no separator; all of them are untouched
-- by this guard. That is a real limit, stated rather than hidden: this fixes
-- the repeating daily sweeps, which is where the founder's pile is.
--
-- MEASURED ON THE LIVE CORPUS, and PROBE 16 re-measures at apply time rather
-- than trusting this comment:
--   COLLAPSE   43 scoped, classified escalations occupy 21 rows; the ledger
--              sweep 18 -> 4, the AR sweep 15 -> 4. 189 -> 161 overall.
--   FAIL OPEN  the same replay under the OLD `is not distinct from` rule
--              gives 147. PROBE 16 asserts the new number is STRICTLY LARGER:
--              a guard that stopped failing open would show up as a smaller
--              queue, which is exactly what it would look like if it were
--              swallowing reports again.
--   SEPARATION the three facts the reviewer read out of the eighteen ledger
--              rows produce three signatures, none containing another, so
--              raised alone they produce THREE rows (PROBE 15, both ways).
--
-- ⚠ AND WHAT HAPPENS TO THOSE THREE FACTS ON THE REAL QUEUE IS NOT THAT.
-- Raised against tomorrow morning's armed state, where four broad rows
-- already sit on that scope, all three FOLD. PROBE 22 case C drives exactly
-- that against the live rows and reports, per fact, which row it landed on
-- and where a person finds its words. The honest sentence is: on this queue
-- the three facts do not get three rows — they get one row each pointing at
-- an existing card, with their text on that card and on the exceptions log.
--
-- ⚠ IT IS 4, NOT 3, AND THE DIFFERENCE IS NOT A ROUNDING ERROR. Fourteen of
-- the eighteen ledger rows name MORE THAN ONE of those three facts in a
-- single paragraph. They are not a partition. Any test that forced them into
-- three groups would have to treat "mentions the imbalance" as sufficient
-- while ignoring that the same row also reports a truncation.
--
-- ── WHAT A REFRESH DOES, AND WHAT IT DELIBERATELY DOES NOT ───────────────
--   RECORDS THE REPORT. Its own de_exceptions row, and its text appended to
--     the task detail. This is the whole of this round's change and it is the
--     reason a fold is now allowed at all.
--   SHOWS THE AGE. created_at is NOT moved, so the card's "Waiting 14 days"
--     stays true, and the title gains a visible " · asked 15× since 5 Aug".
--     An open task silently updated fourteen times looks identical to one
--     raised today; the age is the very thing that makes it urgent, so it is
--     written where a person already reads — the title, rendered in full by
--     DecisionCard — and not only into a column with no reader.
--   DOES NOT TOUCH THE SLA CLOCK. Re-arming sla_due_at on every repeat would
--     mean a permanently blocked item can NEVER expire: the event that proves
--     the wait is continuing would be the event granting more time, and the
--     stalled badge — the only pressure this queue applies — could never
--     fire. Leaving it measures the right thing: how long a PERSON has had
--     this decision, counted from the first ask. After fourteen refreshes the
--     row is thirteen days past due and says so. Dedupe removes duplicates of
--     the alarm, never the alarm. PROBE 17 pins sla_due_at byte-identical
--     across a refresh, and pins that it is NOT null to begin with.
--   NEVER OVERWRITES `detail`. The first account stays exactly where it was
--     and the new one goes after it. Overwriting would destroy the text the
--     title was derived from; appending destroys nothing.
--   DOES NOT PING A DEVICE. human_tasks_push_ping is AFTER INSERT only, so a
--     refresh is silent by construction. Measured, not assumed (PROBE 17).
--
-- ── THE RESIDUAL RISK, NAMED ─────────────────────────────────────────────
-- Within ONE employee and ONE piece of work, two genuinely different problems
-- whose blocker kinds coincide SHARE A ROW. That is unavoidable (see "what no
-- operator can do" above) and it is now a legibility cost, not a data loss:
-- both texts are on the card and both are on the exceptions log. The sharper
-- residual is a DECISION one, and it is not fixed here: resolving a task
-- resolves every de_exceptions row hanging off it (mig 483's
-- `where human_task_id = p_task_id and status = 'proposed'`), so one human
-- answer stamps an outcome on reports it may not have been written about.
-- Bounding that means changing how a decision closes, which is four other
-- migrations' worth of surface, and it is left alone deliberately rather than
-- half-done. It is the first thing to look at if folds start being wrong.
--
-- The third residual is size, and it is stated because the cap that would have
-- hidden it was removed on purpose. A card's detail grows by one paragraph per
-- DISTINCT report — restatements already on the card add nothing — so its size
-- is bounded by how long a person leaves the card undecided. Measured today:
-- the largest pile on this database is 18 reports averaging ~400 characters,
-- about 7KB on one row. A card large enough to matter is a card ignored for
-- months, and the answer to that is the stalled badge, not silent truncation.
--
-- ── THE TRUNCATION RULE, AND WHY NOT split_part(detail, '.', 1) ──────────
-- The obvious rule — first sentence, split on '.' — breaks numbers. Measured
-- against the live corpus it produces:
--     "Ledger does not balance (debits PKR 322k vs"          (cut at "vs.")
--     "Journal entries do not balance (Debits PKR 322,000 vs"
--     "...and both exceed the $10,000"                (cut inside $10,000.00)
--     "...specifically concerned about quality vs"
-- A punctuation cut lands inside "439.3k", "$10,000.00" and "vs.". So:
--
--   THE RULE, two branches, both of which cut only where a WORD ends.
--   (a) FIRST COMPLETE SENTENCE, if one ends inside the budget. A terminator
--       counts only when at least three alphanumerics run up to it (through
--       one optional closing bracket or quote) AND whitespace or end-of-text
--       follows. Three alphanumerics is what rejects "vs.", "e.g." and "No.";
--       the whitespace requirement is what rejects every decimal point,
--       because "439.3k" has no space after its dot.
--   (b) OTHERWISE TRUNCATE ON A SPACE, never on punctuation. No figure in
--       this corpus contains a space, so a space cut cannot land inside one.
--       A dangling list marker "(2)" and trailing joining punctuation are
--       dropped, and an ellipsis says there is more.
--
-- The budget is 120 characters. Measured at 100 the rule drops "$10,000.00"
-- and an account id off the end of two live rows; at 140 the headline wraps
-- to two lines in the card and competes with the two lines of `detail`
-- already rendered beneath it (HumanTasksPage.tsx -> DecisionCard).
--
-- ── SAFETY OF THE BACKFILL ───────────────────────────────────────────────
--   * TITLE ONLY. `detail` is never written, so nothing is destroyed and the
--     text the title was derived from stays on the row. The signature and
--     scope columns are new and were null on every row before this file.
--   * ONLY THE TWO GENERIC SHAPES. Arm A is matched against the row's OWN
--     employee's name; arm B against the exact machine prefix
--     "Needs a decision — " plus a non-empty entity. A title a human or any
--     other caller wrote is never touched, and neither is a generic-looking
--     title naming a different employee.
--   * PENDING ONLY. Migration 596 settled this for this table: "a task that
--     has already been decided is left exactly as it was: rewriting the text
--     a person actually approved would falsify the record of what they agreed
--     to". One approved row in hq therefore keeps its generic title.
--   * NEVER A WORKFORCE ASSISTANT'S TASK.
--   * NO EXISTING ROW IS MERGED OR CANCELLED. The guard is forward-looking:
--     the columns are backfilled so tomorrow's run REFRESHES the row already
--     sitting there, but the 47 rows in the queue today stay 47 rows. Closing
--     an undecided task is a person's decision, never a migration's.
--   * IDEMPOTENT by construction: after the write the title is no longer the
--     generic sentence, so the predicate cannot match the row again. Proven
--     below by running the backfill twice.
--
-- ── ALL TENANTS, NOT AN ALLOW-LIST ───────────────────────────────────────
-- Measured: every row carrying a generic title platform-wide is in
-- outsourcetel-hq. acme-telecom's pending tasks contain none, and neither do
-- the other eleven workspaces. A tenant filter would therefore change nothing
-- today while hard-coding one workspace's identity into a migration and
-- leaving any workspace that grows one later silently illegible. This ships
-- globally.
--
-- ⚠ AND THE DISCLOSURE OF THAT COUNT SURVIVES THE APPLY PATH NOW. The first
-- draft raised the per-tenant count with `raise notice` and called that the
-- disclosure. It reaches nobody: this repo applies migrations through
-- scripts/db-query.mjs -> the Supabase Management API /database/query
-- endpoint, which returns ROWS from the last statement and discards NOTICE
-- traffic entirely. Proven:
--     node scripts/db-query.mjs --sql "do \$\$ begin raise notice 'CANARY 42';
--       end \$\$; select 1"    ->    [{"?column?":1}]     -- the canary is gone
-- The notices below are kept for a psql operator, but they are NOT the
-- disclosure. THE DISCLOSURE IS THE SELECT AT THE VERY END OF THIS FILE,
-- which is the statement whose rows the apply command actually prints.
-- ==========================================================================

begin;

-- ── 1. THE HEADLINE ──────────────────────────────────────────────────────
create or replace function public.de_escalation_headline(
  p_text  text,
  p_limit integer default 120
) returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  s    text;
  sent text;
  head text;
  cut  text;
  lim  integer := greatest(24, least(coalesce(p_limit, 120), 300));
begin
  s := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  if s = '' then
    return null;                    -- nothing to derive from; the caller decides
  end if;

  -- (a) a COMPLETE first sentence, if one ends inside the budget.
  --     >= 3 alphanumerics before the terminator rejects "vs." / "e.g." / "No.";
  --     the trailing-whitespace requirement rejects every decimal point.
  sent := (regexp_match(s, '^(.{20,}?[[:alnum:]]{3}[])"'']?)[.!?](\s|$)'))[1];
  if sent is not null and char_length(sent) <= lim then
    return sent;
  end if;

  -- (b) otherwise cut on a SPACE. Never on punctuation — that is what put
  --     "debits PKR 322k vs" and "exceed the $10,000" in front of a human.
  if char_length(s) <= lim then
    return s;
  end if;
  head := left(s, lim);
  cut  := regexp_replace(head, '\s+\S*$', '');                 -- partial word off
  if btrim(cut) = '' then
    cut := head;                                               -- one word > lim
  end if;
  cut := regexp_replace(cut, '\s*\((\d{1,2}|[a-z])\)$', '');   -- no dangling "(2)"
  cut := regexp_replace(cut, '[[:space:],;:./&(…–—-]+$', '');  -- no dangling joiner
  if btrim(cut) = '' then
    return null;
  end if;
  return cut || '…';
end;
$function$;

revoke all on function public.de_escalation_headline(text, integer) from public, anon, authenticated;

comment on function public.de_escalation_headline(text, integer) is
  '778: the one derivation of a scannable headline from an employee''s own account of why it stopped. Cuts only at a complete sentence or a word boundary — never on punctuation, because a punctuation cut lands inside "439.3k", "$10,000.00" and "vs.".';

-- ── 2. THE SAMENESS TEST ─────────────────────────────────────────────────
-- The blocker KINDS an account describes. Department-neutral on purpose: the
-- catalog names how work stops, never what the work was about, so it applies
-- to a support employee that cannot read a knowledge base exactly as it does
-- to an accounting employee that cannot read a ledger.
--
-- Returns a SORTED, DEDUPED set so `@>` containment is a stable test, and an
-- EMPTY array when it recognises nothing — which the writer treats as "never
-- dedupe this", so an unrecognised blocker always gets its own row.
create or replace function public.de_blocker_signature(
  p_text text
) returns text[]
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  s   text;
  acc text[] := '{}';
  r   record;
begin
  s := lower(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')));
  if s = '' then
    return '{}'::text[];
  end if;

  for r in
    select * from (values
      ('blocked_input',
       '(no source( is)? connected|not connected|cannot( be)? read|can ?not be read|cannot access|inaccessible|not readable|unable to (access|read|open)|no access|access issue|permission denied|not authori[sz]ed|truncat|incomplete|partial(ly)? |cuts? off|only [0-9]+ [a-z ]{0,20}(of|entries|rows|items)|[0-9]+ of [0-9]+ (entries|rows|items)|missing|not provided|full [a-z ]{0,20}required|no data|empty)'),
      ('inconsistent',
       '(does not balance|do not balance|out of balance|imbalance|discrepan|mismatch|variance|shortfall|does not match|do not match|exceed debits|credits exceed|conflict|inconsisten|disagree)'),
      ('out_of_range',
       '(future[- ]dated|forward[- ]dated|dated in [0-9]{4}|dated [0-9]{4}|out of period|period mismatch|date anomaly|period allocation|future dates|exceeds? the [a-z ]{0,20}threshold|above the limit|over the limit|outside the)'),
      ('overdue',
       '(overdue|past due|days? past|aged[- ]receivable|final[- ]notice|collections referral|breached the sla|sla breach)'),
      ('missing_owner',
       '(no (executive )?sponsor|no day[- ]to[- ]day contact|no contact|contact[^.]{0,40}not recorded|no owner|owner is not|unassigned|nobody is)')
    ) as t(k, re)
  loop
    if s ~ r.re then
      acc := array_append(acc, r.k);
    end if;
  end loop;

  return (select coalesce(array_agg(distinct u order by u), '{}'::text[]) from unnest(acc) as u);
end;
$function$;

revoke all on function public.de_blocker_signature(text) from public, anon, authenticated;

comment on function public.de_blocker_signature(text) is
  '778: the sameness test. Maps an employee''s account of a blockage onto a fixed, department-neutral set of blocker KINDS, sorted and deduped, so an open task can absorb a repeat via `@>` containment. Returns an EMPTY array when it recognises nothing, and the writer treats empty as never-dedupe — the guard fails OPEN.';

-- ── 2b. THE SCOPE KEY, AND THE TRAP IT WALKED INTO ───────────────────────
-- ⚠⚠⚠ THE OBJECTIVE **ID** IS ALSO A PER-RUN KEY. This file's own header
-- teaches that `related_id` differs by construction because de-work mints a
-- fresh de_work_item every run. The first draft of the guard then scoped
-- itself by `objective_id` and walked into the identical trap one level up.
-- MEASURED on the same corpus, 2026-08-19:
--
--     Ledger reconciliation sweep   18 escalations   15 distinct objective_ids
--     Daily AR sweep                15 escalations   15 distinct objective_ids
--     Daily onboarding review        5 escalations    5 distinct objective_ids
--
-- A new de_objectives ROW is created for each day's sweep. Scoped by id, the
-- guard would have found a "pile" of at most two and collapsed essentially
-- nothing, while every probe about containment still passed. THE LESSON DOES
-- NOT STOP AT ONE TABLE: ask of EVERY key whether the writer mints it per run.
--
-- The stable subject is the objective's TITLE. "Ledger reconciliation sweep"
-- is the same recurring piece of work on Tuesday as on Monday; the id is only
-- which run it was. And the title still separates what must stay separate:
-- the three "Invoice coming due (14/7/1 day) — RenewalInvoice 867e396a"
-- objectives carry three different titles and therefore three scopes, which
-- is precisely the cross-objective swallow measured at (tenant, employee)
-- alone — a specific renewal invoice absorbed by the daily AR sweep, three
-- separate times.
--
-- An objective with no title falls back to its id, so it separates rather
-- than joining the no-objective bucket. Failing toward MORE rows is the only
-- acceptable direction here.
--
-- ⚠⚠ AND NULL IS NOT A SCOPE. With no objective at all this returns NULL, and
-- NULL means "I cannot tell this piece of work from any other". The writer
-- treats that as never-dedupe. It did not before: it compared with
-- `is not distinct from`, so NULL matched NULL and two different customers
-- were merged into one row through the real writer on live data. 140 of the
-- 189 pending escalations reach this function with no objective, so that was
-- the common path, not an edge. Replayed over the corpus, the old rule folded
-- 189 into 147 rows and the current one folds them into 161: the 14-row gap
-- is exactly the merges made across a separator that did not exist.
create or replace function public.de_escalation_scope(
  p_tenant_id    uuid,
  p_objective_id uuid
) returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v text;
begin
  if p_objective_id is null then
    return null;
  end if;
  select nullif(btrim(lower(regexp_replace(coalesce(o.title, ''), '\s+', ' ', 'g'))), '')
    into v
    from de_objectives o
   where o.id = p_objective_id
     and (p_tenant_id is null or o.tenant_id = p_tenant_id);
  return coalesce(left(v, 200), 'objective:' || p_objective_id::text);
end;
$function$;

revoke all on function public.de_escalation_scope(uuid, uuid) from public, anon, authenticated;

comment on function public.de_escalation_scope(uuid, uuid) is
  '778: the dedupe SEPARATOR — a stable name for the piece of work an escalation belongs to. Deliberately the objective TITLE and not its id: de-work mints a fresh de_objectives row per run (18 ledger escalations spanned 15 ids), so the id is a per-run key and scoping by it would collapse nothing. Untitled objectives fall back to their id, which separates rather than merges.';

-- ── 3. THE LADDER ────────────────────────────────────────────────────────
-- Lifted out of open_de_escalation so the fallback can be tested without
-- writing a human_task, and so exactly one place decides what an escalation
-- is called. p_entity is 778's second half: KEEP THE NAME, ADD THE PROBLEM.
create or replace function public.de_escalation_title(
  p_tenant_id    uuid,
  p_title        text,
  p_reason       text,
  p_de_name      text,
  p_work_item_id uuid default null,
  p_objective_id uuid default null,
  p_entity       text default null
) returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_title  text;
  v_named  text;
  v_entity text;
begin
  -- (1) what the caller said, if it said anything.
  v_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_title is not null then
    return v_title;
  end if;

  v_entity := nullif(btrim(regexp_replace(coalesce(p_entity, ''), '\s+', ' ', 'g')), '');

  -- (2) what the EMPLOYEE said. This is the rung that matters: p_reason is
  --     the employee's own account and is present on every live call. The
  --     entity, when there is one, is kept in front of it — literally, with
  --     no "the headline already mentions it, so drop the prefix" shortcut,
  --     because that shortcut is how the NAME gets lost.
  v_title := public.de_escalation_headline(p_reason, 120);
  if v_title is not null then
    return case when v_entity is null then v_title else v_entity || ' — ' || v_title end;
  end if;

  -- (3) no reason at all. Name the work it stopped on — the row points at it.
  if p_work_item_id is not null then
    select nullif(btrim(w.title), '') into v_named
      from de_work_items w
     where w.id = p_work_item_id
       and (p_tenant_id is null or w.tenant_id = p_tenant_id);
    if v_named is not null then
      return case when v_entity is null then 'Stopped on: ' || v_named
                  else v_entity || ' — stopped on: ' || v_named end;
    end if;
  end if;
  if p_objective_id is not null then
    select nullif(btrim(o.title), '') into v_named
      from de_objectives o
     where o.id = p_objective_id
       and (p_tenant_id is null or o.tenant_id = p_tenant_id);
    if v_named is not null then
      return case when v_entity is null then 'Stopped on: ' || v_named
                  else v_entity || ' — stopped on: ' || v_named end;
    end if;
  end if;

  -- (3b) nothing to say about the problem, but we do know WHO it is about.
  --      The name alone beats a sentence that is true of every row.
  if v_entity is not null then
    return v_entity;
  end if;

  -- (4) THE GENUINE LAST RESORT: it knows nothing. Say that, rather than the
  --     old sentence, which said only that a decision was wanted — true of
  --     every row in the queue and therefore information in none of them.
  return coalesce(nullif(btrim(coalesce(p_de_name, '')), ''), 'An employee')
         || ' stopped and gave no reason';
end;
$function$;

revoke all on function public.de_escalation_title(uuid, text, text, text, uuid, uuid, text) from public, anon, authenticated;

comment on function public.de_escalation_title(uuid, text, text, text, uuid, uuid, text) is
  '778: the escalation-title ladder — the caller''s title, else the entity plus the employee''s own reason, else the work it stopped on, else the entity alone, else a statement that it gave no reason. Replaces mig 483''s "<name> needs a decision", which was true of every row in the queue and so told a human nothing.';

-- ── 4. WHAT THE GUARD MATCHES ON, AND WHAT IT SHOWS ──────────────────────
-- blocker_signature  the problem, as blocker KINDS         (the TEST)
-- blocker_scope      the objective this escalation is for  (the SEPARATOR)
-- repeat_count       how many times it has now been asked
-- last_raised_at     when it was last re-asked  (created_at stays the FIRST)
--
-- ⚠ These carry NO authority. human_tasks already grants SELECT/UPDATE to
-- `authenticated` at TABLE level (relacl: authenticated=arwxtm), so new
-- columns inherit that perimeter — this migration neither widens nor narrows
-- it. Nothing gates on these columns: guard_human_task_decision still refuses
-- a direct write to status/decided_by/decided_at, so forging a repeat count
-- changes a label and never a decision. PROBE 20 pins that anon gained no
-- write.
alter table public.human_tasks
  add column if not exists blocker_signature text[],
  add column if not exists blocker_scope     text,
  add column if not exists repeat_count      integer not null default 1,
  add column if not exists distinct_reports  integer not null default 1,
  add column if not exists last_raised_at    timestamptz;

comment on column public.human_tasks.blocker_signature is
  '778: the blocker KINDS this escalation reported, sorted+deduped (de_blocker_signature). An open task absorbs a repeat only when this CONTAINS the new escalation''s signature. Null or empty means never dedupe.';
comment on column public.human_tasks.blocker_scope is
  '778: a stable name for the piece of work this escalation belongs to (de_escalation_scope: the objective TITLE, never its per-run id). A SEPARATOR only — it can create rows, never merge them; the sameness test is the signature. NULL means "no separator could be derived", which never matches anything — the writer compares with `=`, not `is not distinct from`, because NULL joining NULL merged two different customers on live data.';
comment on column public.human_tasks.distinct_reports is
  '778: how many DIFFERENT reports this one card carries. 1 means the detail holds exactly the account it was opened with. Above 1 the title says so, because a fold that a reader cannot see is a fold that hid something.';
comment on column public.human_tasks.repeat_count is
  '778: how many times this exact blocker has been raised. 1 means raised once. Rendered into the title so the age is visible without a UI change.';
comment on column public.human_tasks.last_raised_at is
  '778: when the blocker was last re-reported. created_at deliberately stays at the FIRST ask — that is the age that makes it urgent.';

-- an index so the guard's lookup is not a per-escalation seq scan
create index if not exists human_tasks_blocker_lookup_idx
  on public.human_tasks (tenant_id, de_id, blocker_scope)
  where type = 'escalation' and status = 'pending';

-- ── 5. THE WRITER ────────────────────────────────────────────────────────
-- Same signature, same cross-link, same proposal sentinel, same SLA clock.
-- Three changes: the title comes from the ladder; an open task covering the
-- same problem is REFRESHED instead of duplicated; and — the whole of this
-- round — a refresh RECORDS THE REPORT rather than discarding it.
--
-- ⚠ THE GUARD BELONGS HERE, and de-work said so before this file existed.
-- de-work/index.ts:1101 already carries an escalate-once guard whose comment
-- reads: "open_de_escalation does not dedupe, so the guard has to be here or
-- every shift adds another identical task to the pile." That guard was never
-- added to :1301, the site that wrote these 47 rows. Putting it in the RPC
-- covers all four callers and every caller added later, rather than asking
-- each one to remember.
create or replace function public.open_de_escalation(
  p_tenant_id uuid,
  p_de_id uuid,
  p_work_item_id uuid,
  p_objective_id uuid,
  p_title text,
  p_reason text,
  p_proposed_action text default null,
  p_justification text default null,
  p_needs_input boolean default false,
  p_sla_hours integer default 24
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task uuid;
  v_exc uuid;
  v_de_name text;
  v_proposal text;
  v_title text;
  v_sig text[];
  v_scope text;
  v_open_id uuid;
  v_open_title text;
  v_open_first timestamptz;
  v_rep integer;
  v_distinct integer;
  v_suffix text;
  v_base text;
  v_detail text;
  v_norm text;
  v_added boolean := false;
begin
  if p_tenant_id is null or p_de_id is null then
    raise exception 'open_de_escalation: tenant and de are required';
  end if;
  select name into v_de_name from digital_employees where id = p_de_id;

  -- The sentinel is deliberate and readable on the surface: a human must be
  -- able to decide even when the employee proposed nothing. Computed BEFORE
  -- the branch, because BOTH paths now write an exception row with it.
  v_proposal := nullif(btrim(coalesce(p_proposed_action, '')), '');
  if v_proposal is null then
    v_proposal := case when p_needs_input
      then 'No proposal — the employee stopped and asked a question instead of finishing. Answer it, or cancel the task with a reason.'
      else 'No proposal — the employee reported a blocker without proposing an action. Give it an instruction, or cancel the task with a reason.' end;
  end if;

  -- 778: the sameness test, derived from the employee's own account, and the
  -- separator, derived from the NAME of the work rather than from this run's
  -- id — see de_escalation_scope for why the id could not be used.
  v_sig   := public.de_blocker_signature(p_reason);
  -- ⚠ THE TWO WRITERS OF blocker_scope MUST AGREE. The backfill below derives
  -- the objective through the work item (related_id -> de_work_items ->
  -- objective_id); this path is handed p_objective_id directly. Nothing forces
  -- a caller to pass both, and a caller that passed only the work item would
  -- store NULL here while the backfill stored the work's name — after which
  -- the guard silently stops matching the very rows it just armed. Measured
  -- 2026-08-19: 51 exceptions carry a work item, 0 of them diverge today. The
  -- coalesce is here so that stays true when a caller changes.
  v_scope := public.de_escalation_scope(p_tenant_id,
               coalesce(p_objective_id,
                        (select w.objective_id from de_work_items w
                          where w.id = p_work_item_id and w.tenant_id = p_tenant_id)));

  -- ⚠⚠ THE FAIL-OPEN GUARD, AND BOTH HALVES OF IT ARE LOAD-BEARING.
  --   NO SEPARATOR (v_scope is null) means "I cannot tell this piece of work
  --     from any other", and the honest answer to that is a new row. The
  --     previous draft compared `is not distinct from`, so NULL joined NULL
  --     and two DIFFERENT CUSTOMERS merged through this function on live
  --     data. 140 of 189 pending escalations carry no separator, so this is
  --     the common case, not the corner.
  --   NO SIGNATURE (array_length(v_sig,1) is null) means the catalog
  --     recognised nothing, and a blocker nobody can classify must never
  --     disappear behind one somebody could.
  -- Deleting either half must go RED: PROBE 13 pins both strings, PROBE 22
  -- drives both, and both pins are inverted.
  if v_scope is not null and array_length(v_sig, 1) is not null then
    select ht.id, ht.title, ht.created_at, ht.repeat_count, ht.distinct_reports, ht.detail
      into v_open_id, v_open_title, v_open_first, v_rep, v_distinct, v_detail
      from human_tasks ht
     where ht.tenant_id = p_tenant_id
       and ht.de_id = p_de_id
       and ht.type = 'escalation'
       and ht.status = 'pending'
       -- the SEPARATOR: a different piece of work is different work, even
       -- when it stops for the same reason. Plain `=` on purpose — NULL is
       -- excluded above and must never be re-admitted here by an operator
       -- that treats "unknown" as "the same unknown".
       and ht.blocker_scope = v_scope
       -- the TEST: everything the new escalation is blocked on is already on
       -- this task. One new KIND of blockage and containment fails, so a new
       -- row is written rather than a new failure hidden behind an old one.
       and ht.blocker_signature is not null
       and ht.blocker_signature @> v_sig
     order by ht.created_at, ht.id
     limit 1;
  end if;

  if v_open_id is not null then
    v_rep := coalesce(v_rep, 1) + 1;

    -- ⚠⚠⚠ COLLAPSE THE ROW, NEVER THE REPORT. The row is shared; the words
    -- are not thrown away. `detail` is APPENDED TO, never overwritten, so the
    -- first account stays exactly where the title was derived from and the
    -- new one goes after it. Skipped only when the text is ALREADY THERE,
    -- which is the one case where appending would add nothing.
    v_norm := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
    if v_norm <> ''
       and position(v_norm in regexp_replace(coalesce(v_detail, ''), '\s+', ' ', 'g')) = 0 then
      v_added   := true;
      v_distinct := coalesce(v_distinct, 1) + 1;
      -- ⚠ IN FULL, AND WITH NO CAP. A first draft of THIS round degraded the
      -- append to a dated pointer past 8000 characters. That was wrong twice:
      -- it was a branch no probe exercised, and it lost words — de_exceptions
      -- truncates `situation` at 4000 (mig 483), so a long report past the cap
      -- would have existed in full in NEITHER place. A cap in the middle of a
      -- rule called "never lose the report" is where the rule quietly stops
      -- being true. The growth it was guarding against is named as a residual
      -- below and measured: the largest pile on this database is 18 reports of
      -- roughly 400 characters, so about 7KB on one card.
      v_detail  := coalesce(v_detail, '')
                || chr(10) || chr(10)
                || '— also reported ' || to_char(now(), 'FMDD Mon') || ': '
                || v_norm;
    end if;

    -- SHOW THE REPETITION WHERE A PERSON READS. Stripped-then-appended, so a
    -- task refreshed fourteen times carries ONE suffix, not fourteen. The
    -- second clause is what tells a reader the card holds more than the
    -- headline: words nobody knows to look for are only half-reachable.
    v_suffix := ' · asked ' || v_rep::text || '× since ' || to_char(v_open_first, 'FMDD Mon')
             || case when coalesce(v_distinct, 1) > 1
                     then ' · ' || coalesce(v_distinct, 1)::text || ' different reports inside'
                     else '' end;
    v_base   := regexp_replace(coalesce(v_open_title, ''), ' · asked [0-9]+× since .*$', '');
    update human_tasks
       set title            = left(v_base, greatest(1, 300 - char_length(v_suffix))) || v_suffix,
           detail           = v_detail,
           repeat_count     = v_rep,
           distinct_reports = coalesce(v_distinct, 1),
           last_raised_at   = now()
           -- ⚠ sla_due_at is DELIBERATELY ABSENT. Re-arming it here would mean
           -- a permanently blocked item can never expire. created_at is absent
           -- for the same reason: it is the age, and the age is the point.
     where id = v_open_id;

    -- ⚠⚠ AND THE REPORT GETS ITS OWN LEDGER ROW, cross-linked to the task it
    -- landed on. The first draft skipped this and called a second row "the
    -- same pile in another table"; it is not. de_exceptions is the
    -- employee's exception LOG — one row per thing it reported, rendered on
    -- the DE Workbench — and suppressing it is how "SI-8891 text present in
    -- human_tasks.detail -> 0" became true. Production writes this row on
    -- every escalation today, so this is also the no-change path for every
    -- reader downstream of de_exceptions.
    insert into de_exceptions (
      tenant_id, de_id, objective_id, work_item_id,
      situation, proposed_action, justification, human_task_id
    ) values (
      p_tenant_id, p_de_id, p_objective_id, p_work_item_id,
      left(coalesce(p_reason, ''), 4000), left(v_proposal, 4000),
      left(coalesce(p_justification, ''), 4000), v_open_id
    ) returning id into v_exc;

    return jsonb_build_object(
      'ok', true, 'task_id', v_open_id, 'exception_id', v_exc,
      'deduped', true, 'repeat_count', v_rep,
      'distinct_reports', coalesce(v_distinct, 1),
      'report_appended', v_added, 'first_raised_at', v_open_first);
  end if;

  -- 778: the last line of defence is no longer a generic sentence. It has
  -- p_reason and p_work_item_id in hand and now uses them.
  v_title := public.de_escalation_title(
    p_tenant_id, p_title, p_reason, v_de_name, p_work_item_id, p_objective_id);

  insert into human_tasks (
    tenant_id, de_id, type, title, detail, source, priority,
    related_table, related_id, handoff_summary, sla_due_at,
    blocker_signature, blocker_scope, repeat_count, distinct_reports, last_raised_at
  ) values (
    p_tenant_id, p_de_id, 'escalation', left(v_title, 300), coalesce(p_reason, ''), 'de', 'high',
    case when p_work_item_id is not null then 'de_work_items' else null end,
    p_work_item_id,
    left(v_proposal, 1000),
    now() + make_interval(hours => greatest(1, coalesce(p_sla_hours, 24))),
    v_sig, v_scope, 1, 1, now()
  ) returning id into v_task;

  insert into de_exceptions (
    tenant_id, de_id, objective_id, work_item_id,
    situation, proposed_action, justification, human_task_id
  ) values (
    p_tenant_id, p_de_id, p_objective_id, p_work_item_id,
    left(coalesce(p_reason, ''), 4000), left(v_proposal, 4000),
    left(coalesce(p_justification, ''), 4000), v_task
  ) returning id into v_exc;

  return jsonb_build_object('ok', true, 'task_id', v_task, 'exception_id', v_exc,
    'deduped', false, 'distinct_reports', 1, 'report_appended', true);
end;
$function$;

revoke all on function public.open_de_escalation(uuid, uuid, uuid, uuid, text, text, text, text, boolean, integer) from public, anon, authenticated;

-- ── 6. ONE PREDICATE, DEFINED ONCE ───────────────────────────────────────
-- The rows to rebuild, BOTH arms. This exists as a view and not as SQL typed
-- twice because the verification below runs the SAME predicate a second time
-- against planted control rows — and two copies of a predicate is how a
-- checker ends up proving something about a statement that is not the one
-- that ran.
--
-- Arm A: the generic fallback, matched against the row's OWN employee's name.
-- Arm B: the machine prefix "Needs a decision — " (19 chars) plus a non-empty
--        entity. Matched ILIKE, because that arm title-cases the N and a
--        case-sensitive sweep is exactly what missed these five.
create temp view _778_generic as
  with base as (
    select ht.id, ht.tenant_id, ht.title as old_title, ht.detail, de.name as de_name
      from human_tasks ht
      left join digital_employees de
             on de.id = ht.de_id
            and coalesce(de.is_workforce_assistant, false) = false
     where ht.type = 'escalation'
       and ht.source = 'de'
       and ht.status = 'pending'
       -- never a workforce assistant's task: if the row carries a de_id and the
       -- assistant-excluding join found nothing, the row is skipped entirely.
       and (ht.de_id is null or de.id is not null)
       and btrim(coalesce(ht.detail, '')) <> ''
  ),
  armed as (
    select b.id, b.tenant_id, b.old_title, b.detail,
           case
             when b.old_title = left(coalesce(b.de_name, 'An employee') || ' needs a decision', 300) then 'A'
             when b.old_title ilike 'Needs a decision — %'
                  and btrim(coalesce(substring(b.old_title from 20), '')) <> ''                      then 'B'
             else null
           end as arm,
           btrim(coalesce(substring(b.old_title from 20), '')) as entity,
           public.de_escalation_headline(b.detail, 120)        as head
      from base b
  )
  select a.id, a.tenant_id, a.old_title, a.arm, a.entity, a.detail,
         left(case when a.arm = 'B' then a.entity || ' — ' || a.head else a.head end, 300) as new_title
    from armed a
   where a.arm is not null
     and a.head is not null
     and left(case when a.arm = 'B' then a.entity || ' — ' || a.head else a.head end, 300) <> a.old_title;

-- ── 7. THE BACKFILL, AND THE BLOCK THAT PROVES IT ────────────────────────
-- ⚠ EVERY APPEND BELOW USES array_append. `v_bad := v_bad || 'a sentence'`
-- resolves to anyarray||anyarray and raises 22P02 exactly when a branch
-- fires — a verification block that cannot speak at the moment it has
-- something to say. scripts/migration-append-check.mjs refuses this file if
-- it happens.
do $verify$
declare
  v_bad        text[] := '{}';
  v_checks     integer := 0;
  v_probes_ok  integer := 0;
  v_probes_try constant integer := 22;
  v_report     text[] := '{}';

  v_pred_total integer := 0;
  v_pred_break text;
  v_arm_a      integer;
  v_arm_b      integer;
  v_cs         integer;
  v_ci         integer;
  v_n1         integer;
  v_n2         integer;
  v_n3         integer;
  v_ids        uuid[];
  v_detail_before text;
  v_detail_after  text;
  v_residual   integer;
  v_distinct   integer;
  v_long       integer;

  v_ctl_tenant uuid;
  v_ctl_de1    uuid;
  v_ctl_de2    uuid;
  v_ctl_name1  text;
  v_ctl_name2  text;
  v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid; v_c5 uuid;
  v_t1 text; v_t2 text; v_t3 text; v_t4 text; v_t5 text;
  v_q_before bigint; v_q_inside bigint; v_q_after bigint;
  v_ctl_ok   boolean := false;
  v_survivor integer;

  v_wi_id     uuid;
  v_wi_tenant uuid;
  v_wi_title  text;

  v_src      text;
  v_stripped text;
  v_selftest text;
  v_got      text;
  v_sig1 text[]; v_sig2 text[]; v_sig3 text[];

  -- the guard, end to end
  v_g1 jsonb; v_g2 jsonb; v_g3 jsonb;
  v_g_task uuid; v_g_task3 uuid;
  v_g_sla_before timestamptz; v_g_sla_after timestamptz;
  v_g_created_before timestamptz; v_g_created_after timestamptz;
  v_g_title text; v_g_detail text; v_g_rep integer; v_g_exc integer;
  v_g_detail_after text; v_g_dist integer;
  -- PROBE 22 — the three driven cases
  v_w1 jsonb; v_w2 jsonb; v_w3 jsonb; v_w4 jsonb; v_w5 jsonb; v_w6 jsonb;
  v_d_task1 uuid; v_d_task2 uuid; v_d_detail text;
  v_w_task uuid; v_w_task2 uuid; v_w_detail text; v_w_exc integer;
  v_c_obj uuid; v_c_obj2 uuid; v_c_de uuid;
  v_cust_detail text; v_cust_exc integer; v_cust_t1 uuid; v_cust_t2 uuid;
  v_f_sig text[]; v_f_task uuid; v_f_detail text; v_f_title text;
  v_f_deduped boolean; v_f_lines text[] := '{}';
  v_live_t uuid; v_live_d uuid; v_live_s text; v_live_n integer;
  v_probe22_ok boolean := false;
  h record;
  v_g_rows integer;
  v_g_ok boolean := false;
  v_g4 jsonb; v_g_task4 uuid;
  v_g5 jsonb; v_g_task5 uuid; v_wi2 uuid; v_wi2_title text; v_g_scope5 text;
  v_obj_id uuid; v_obj_title text; v_g_scope text;

  -- the live-corpus simulation
  v_sim_raised integer; v_sim_open integer; v_sim_open_noscope integer;
  v_big_raised integer; v_big_open integer; v_big_label text;
  v_big_t uuid; v_big_d uuid; v_big_s text;
  v_scope_keys integer; v_obj_ids integer;

  f          record;
  g          record;
begin
  ------------------------------------------------------------------------
  -- PROBE 1 — the headline rule, against the exact inputs that broke the
  -- obvious rule. INVERTED: each fixture also asserts what split_part on '.'
  -- does with the same input, so a fixture that has stopped discriminating
  -- goes red instead of passing quietly. A fixture both rules pass proves
  -- nothing about either.
  ------------------------------------------------------------------------
  begin
    for f in
      select * from (values
        ('Ledger does not balance (debits PKR 322k vs. credits PKR 439.3k = shortfall of PKR 117.3k); journal entry data is incomplete (24 entries stated but only 10 partial rows provided).',
         'Ledger does not balance (debits PKR 322k vs. credits PKR 439.3k = shortfall of PKR 117.3k); journal entry data is…', true),
        ('Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails with 10-day cure window before collections referral.',
         'Two invoices are 38–42 days overdue totalling $85,000', false),
        ('Cannot read book: "Onboarding projects not yet live" — no source is connected. This is not the same as an empty book.',
         'Cannot read book: "Onboarding projects not yet live" — no source is connected', false),
        ('Unable to access a critical data source required to open the onboarding book',
         'Unable to access a critical data source required to open the onboarding book', false),
        ('Two invoices are significantly overdue (47 and 43 days past due date) and both exceed the $10,000.00 escalation threshold. Both require approval.',
         'Two invoices are significantly overdue (47 and 43 days past due date) and both exceed the $10,000.00 escalation…', true),
        ('Customer is asking for general platform overview and positioning — specifically concerned about quality vs. cost ("another cheap agent?"). This is not a product-specific support issue.',
         'Customer is asking for general platform overview and positioning — specifically concerned about quality vs. cost…', true),
        ('Journal entries do not balance (Debits PKR 322,000 vs. Credits PKR 439,300; imbalance of PKR 117,300). Additionally, entries are dated in 2027.',
         'Journal entries do not balance (Debits PKR 322,000 vs. Credits PKR 439,300; imbalance of PKR 117,300)', true)
      ) as t(inp, want, must_differ)
    loop
      v_got := public.de_escalation_headline(f.inp, 120);
      v_checks := v_checks + 1;
      if v_got is distinct from f.want then
        v_bad := array_append(v_bad, format('headline fixture mismatch: got %L, wanted %L', v_got, f.want));
      end if;
      v_checks := v_checks + 1;
      if f.must_differ and split_part(f.inp, '.', 1) = v_got then
        v_bad := array_append(v_bad, format(
          'fixture no longer discriminates — split_part(detail, ''.'', 1) now agrees with the rule on %L, so this fixture proves nothing about either.', left(f.inp, 60)));
      end if;
      v_checks := v_checks + 1;
      if (not f.must_differ) and split_part(f.inp, '.', 1) is distinct from v_got then
        v_bad := array_append(v_bad, format(
          'a fixture recorded as agreeing with split_part no longer does: %L gives %L vs %L', left(f.inp, 60), split_part(f.inp, '.', 1), v_got));
      end if;
    end loop;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 1 (headline fixtures) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 2 — nothing in, nothing out. The LADDER, not the headline, owns
  -- the decision about what to call an escalation that said nothing.
  ------------------------------------------------------------------------
  begin
    v_checks := v_checks + 1;
    if public.de_escalation_headline(null, 120) is not null then
      v_bad := array_append(v_bad, 'headline(null) is not null');
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_headline('   ', 120) is not null then
      v_bad := array_append(v_bad, 'headline(whitespace) is not null');
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_headline('', 120) is not null then
      v_bad := array_append(v_bad, 'headline(empty string) is not null');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 2 (empty input) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 3 — the budget holds over EVERY escalation detail on the
  -- platform, not over a sample. Counted, so a zero-row corpus is visible.
  ------------------------------------------------------------------------
  begin
    select count(*) filter (where char_length(coalesce(public.de_escalation_headline(ht.detail, 120), '')) > 121),
           count(*)
      into v_long, v_residual
      from human_tasks ht
     where ht.type = 'escalation' and btrim(coalesce(ht.detail, '')) <> '';
    v_checks := v_checks + 1;
    if v_long <> 0 then
      v_bad := array_append(v_bad, format('%s escalation detail(s) produce a headline longer than 121 chars', v_long::text));
    end if;
    v_checks := v_checks + 1;
    if v_residual = 0 then
      v_bad := array_append(v_bad, 'the length ceiling was checked against ZERO escalation details — it compared nothing');
    end if;
    v_report := array_append(v_report, format('length ceiling checked over %s escalation detail(s)', v_residual::text));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 3 (length ceiling) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 4 — SAY THE COUNT BEFORE COMMITTING TO IT, per tenant and per arm.
  ------------------------------------------------------------------------
  create temp table if not exists _778_targets (
    id uuid primary key, tenant_id uuid, old_title text, arm text, entity text, new_title text, detail text
  );
  delete from _778_targets;
  insert into _778_targets (id, tenant_id, old_title, arm, entity, new_title, detail)
  select id, tenant_id, old_title, arm, entity, new_title, detail from _778_generic;

  select count(*) into v_pred_total from _778_targets;
  select count(*) filter (where arm = 'A'), count(*) filter (where arm = 'B')
    into v_arm_a, v_arm_b from _778_targets;
  select coalesce(string_agg(x.slug || '=' || x.n::text, ', ' order by x.n desc, x.slug), '(none)')
    into v_pred_break
    from (select tn.slug, count(*) as n
            from _778_targets t join tenants tn on tn.id = t.tenant_id
           group by tn.slug) x;
  v_report := array_append(v_report, format('PREDICTED rows to rewrite: %s  (arm A generic-fallback=%s, arm B entity-named=%s)  [per tenant: %s]',
    v_pred_total::text, v_arm_a::text, v_arm_b::text, v_pred_break));
  raise notice '778: about to rewrite % escalation title(s) — arm A=%, arm B=% — per tenant: %', v_pred_total, v_arm_a, v_arm_b, v_pred_break;

  select array_agg(id order by id) into v_ids from _778_targets;
  select md5(coalesce(string_agg(t.id::text || ':' || t.detail, '|' order by t.id), ''))
    into v_detail_before from _778_targets t;

  -- VACUITY GUARD. Zero rewritten and zero rows to rewrite look identical
  -- from the far side; if there is genuinely nothing left, every assertion
  -- about the write below compares nothing and that must be SAID.
  v_checks := v_checks + 1;
  if v_pred_total = 0 then
    v_report := array_append(v_report, 'note: predicted=0 — the backfill assertions compared nothing on this run');
  end if;
  v_probes_ok := v_probes_ok + 1;

  ------------------------------------------------------------------------
  -- PROBE 5 — THE WRITE, and the count it actually changed.
  ------------------------------------------------------------------------
  begin
    update human_tasks ht
       set title = t.new_title
      from _778_targets t
     where ht.id = t.id
       and ht.title = t.old_title;
    get diagnostics v_n1 = row_count;
    v_checks := v_checks + 1;
    if v_n1 <> v_pred_total then
      v_bad := array_append(v_bad, format(
        'the backfill changed %s row(s) but predicted %s. A number that moves between the prediction and the write is the one thing this block exists to catch.',
        v_n1::text, v_pred_total::text));
    end if;
    v_report := array_append(v_report, format('ACTUALLY rewritten: %s', v_n1::text));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 5 (the write) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 6 — IDEMPOTENCE, proven on the real rows rather than asserted.
  ------------------------------------------------------------------------
  begin
    update human_tasks ht
       set title = t.new_title
      from _778_targets t
     where ht.id = t.id
       and ht.title = t.old_title;
    get diagnostics v_n2 = row_count;
    v_checks := v_checks + 1;
    if v_n2 <> 0 then
      v_bad := array_append(v_bad, format('running the backfill twice changed %s row(s) the second time', v_n2::text));
    end if;
    -- and the PREDICATE itself must now be empty, not merely the update
    select count(*) into v_residual from _778_generic;
    v_checks := v_checks + 1;
    if v_residual <> 0 then
      v_bad := array_append(v_bad, format('the backfill predicate still selects %s row(s) after the write — it is not idempotent, the update was merely a no-op', v_residual::text));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 6 (idempotence) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 7 — `detail` IS NOT TOUCHED. A byte comparison over the same ids,
  -- because "we only wrote title" is a claim about the statement and this is
  -- a claim about the rows.
  ------------------------------------------------------------------------
  begin
    select md5(coalesce(string_agg(ht.id::text || ':' || ht.detail, '|' order by ht.id), ''))
      into v_detail_after
      from human_tasks ht where ht.id = any(coalesce(v_ids, '{}'::uuid[]));
    v_checks := v_checks + 1;
    if v_detail_after is distinct from v_detail_before then
      v_bad := array_append(v_bad, format('`detail` changed across the backfill (%s -> %s)', v_detail_before, v_detail_after));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 7 (detail integrity) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 8 — NOTHING GENERIC IS LEFT among pending rows that had something
  -- to rebuild from, in EITHER shape. Deliberately NOT the same query as the
  -- view: this one omits the "a new title exists and differs" clause, so a
  -- rule that silently returned the old title would be caught here rather
  -- than hidden by the very filter that skipped it. And it asks ILIKE, so
  -- the case-sensitivity defect cannot come back unnoticed.
  ------------------------------------------------------------------------
  begin
    select count(*) into v_residual
      from human_tasks ht
      left join digital_employees de
             on de.id = ht.de_id and coalesce(de.is_workforce_assistant, false) = false
     where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
       and (ht.de_id is null or de.id is not null)
       and (ht.title = left(coalesce(de.name, 'An employee') || ' needs a decision', 300)
            or ht.title ilike 'needs a decision — %')
       and btrim(coalesce(ht.detail, '')) <> '';
    v_checks := v_checks + 1;
    if v_residual <> 0 then
      v_bad := array_append(v_bad, format('%s pending escalation(s) still carry a generic title with a usable detail', v_residual::text));
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 8 (residual) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 9 — how much legibility was actually bought. REPORTED, not
  -- asserted: rebuilding does not promise a unique sentence per row, and a
  -- pin on uniqueness would tempt a later author to disambiguate titles that
  -- genuinely describe the same blockage — manufacturing distinctions is the
  -- same defect as manufacturing clusters.
  ------------------------------------------------------------------------
  begin
    select count(distinct new_title) into v_distinct from _778_targets;
    v_report := array_append(v_report, format('distinct rebuilt titles: %s of %s', v_distinct::text, v_pred_total::text));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 9 (distinctness report) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 10 — THE CONTROLS, run against the REAL table through the SAME
  -- view, then rolled back by a deliberate raise. Five planted rows:
  --   C1 a HUMAN-written title                                -> must NOT change
  --   C2 the generic sentence naming a DIFFERENT employee      -> must NOT change
  --   C3 the generic sentence with an EMPTY detail             -> must NOT change
  --   C4 the generic sentence with a real detail               -> MUST change
  --   C5 the ENTITY-NAMED shape with a real detail (arm B)     -> MUST change
  -- net.http_request_queue is counted on both sides of the rollback, because
  -- inserting a pending human_task fires the push trigger and "the rollback
  -- also unqueued the ping" is otherwise an inference about pg_net.
  ------------------------------------------------------------------------
  begin
    select d1.tenant_id, d1.id, d2.id, d1.name, d2.name
      into v_ctl_tenant, v_ctl_de1, v_ctl_de2, v_ctl_name1, v_ctl_name2
      from digital_employees d1
      join digital_employees d2
        on d2.tenant_id = d1.tenant_id and d2.id <> d1.id
       and coalesce(d2.is_workforce_assistant, false) = false
       and btrim(coalesce(d2.name, '')) <> ''
       and d2.name is distinct from d1.name
     where coalesce(d1.is_workforce_assistant, false) = false
       and btrim(coalesce(d1.name, '')) <> ''
       -- and it must own an objective, or PROBE 17 cannot prove that the
       -- stored separator is the work's NAME rather than this run's id.
       and exists (select 1 from de_objectives o
                    where o.tenant_id = d1.tenant_id and btrim(coalesce(o.title, '')) <> '')
     order by d1.tenant_id, d1.id, d2.id
     limit 1;

    if v_ctl_tenant is null then
      v_bad := array_append(v_bad, 'PROBE 10 (controls) found no tenant with two distinctly named non-assistant employees — the controls compared nothing');
    else
      begin
        v_q_before := case when to_regclass('net.http_request_queue') is null
                        then null else (select count(*) from net.http_request_queue) end;

        insert into human_tasks (tenant_id, de_id, type, title, detail, source, priority, status)
        values (v_ctl_tenant, v_ctl_de1, 'escalation',
                'Approve the refund for Grant Plastics before Friday',
                'A human wrote this title and it must survive the backfill untouched.',
                'de', 'high', 'pending')
        returning id into v_c1;

        insert into human_tasks (tenant_id, de_id, type, title, detail, source, priority, status)
        values (v_ctl_tenant, v_ctl_de1, 'escalation',
                v_ctl_name2 || ' needs a decision',
                'Generic sentence, but it names the OTHER employee. The predicate is per-own-employee and must not match this row.',
                'de', 'high', 'pending')
        returning id into v_c2;

        insert into human_tasks (tenant_id, de_id, type, title, detail, source, priority, status)
        values (v_ctl_tenant, v_ctl_de1, 'escalation',
                v_ctl_name1 || ' needs a decision', '   ',
                'de', 'high', 'pending')
        returning id into v_c3;

        insert into human_tasks (tenant_id, de_id, type, title, detail, source, priority, status)
        values (v_ctl_tenant, v_ctl_de1, 'escalation',
                v_ctl_name1 || ' needs a decision',
                'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails.',
                'de', 'high', 'pending')
        returning id into v_c4;

        insert into human_tasks (tenant_id, de_id, type, title, detail, source, priority, status)
        values (v_ctl_tenant, v_ctl_de1, 'escalation',
                'Needs a decision — Grant Plastics Ltd.',
                'No executive sponsor or day-to-day contact is recorded for Grant Plastics Ltd. Cannot proceed without knowing who holds the relationship.',
                'de', 'high', 'pending')
        returning id into v_c5;

        v_q_inside := case when to_regclass('net.http_request_queue') is null
                        then null else (select count(*) from net.http_request_queue) end;

        -- THE SAME PREDICATE AND THE SAME UPDATE, re-derived from the view.
        delete from _778_targets;
        insert into _778_targets (id, tenant_id, old_title, arm, entity, new_title, detail)
        select id, tenant_id, old_title, arm, entity, new_title, detail from _778_generic;
        update human_tasks ht
           set title = t.new_title
          from _778_targets t
         where ht.id = t.id
           and ht.title = t.old_title;
        get diagnostics v_n3 = row_count;

        select title into v_t1 from human_tasks where id = v_c1;
        select title into v_t2 from human_tasks where id = v_c2;
        select title into v_t3 from human_tasks where id = v_c3;
        select title into v_t4 from human_tasks where id = v_c4;
        select title into v_t5 from human_tasks where id = v_c5;
        v_ctl_ok := true;
        raise exception using errcode = 'ZZ778', message = 'controls: deliberate rollback';
      exception
        when sqlstate 'ZZ778' then null;   -- the rows are gone; the variables remain
        when others then
          v_bad := array_append(v_bad, format('PROBE 10 (controls) aborted: %s %s', sqlstate, sqlerrm));
      end;

      if v_ctl_ok then
        v_checks := v_checks + 1;
        if v_n3 <> 2 then
          v_bad := array_append(v_bad, format(
            'the controls run rewrote %s row(s); exactly 2 — the two positive controls, one per arm — were expected. More means the predicate reaches rows it must not; fewer means it reached nothing and the three negative controls proved nothing.', v_n3::text));
        end if;
        v_checks := v_checks + 1;
        if v_t1 is distinct from 'Approve the refund for Grant Plastics before Friday' then
          v_bad := array_append(v_bad, format('a HUMAN-written title was rewritten by the backfill: it now reads %L', v_t1));
        end if;
        v_checks := v_checks + 1;
        if v_t2 is distinct from (v_ctl_name2 || ' needs a decision') then
          v_bad := array_append(v_bad, format('a generic title naming a DIFFERENT employee was rewritten: it now reads %L', v_t2));
        end if;
        v_checks := v_checks + 1;
        if v_t3 is distinct from (v_ctl_name1 || ' needs a decision') then
          v_bad := array_append(v_bad, format('a generic title with an EMPTY detail was rewritten to %L — there was nothing to derive it from', v_t3));
        end if;
        v_checks := v_checks + 1;
        if v_t4 is distinct from 'Two invoices are 38–42 days overdue totalling $85,000' then
          v_bad := array_append(v_bad, format('the arm-A POSITIVE control was not rebuilt as expected: %L', v_t4));
        end if;
        -- ⚠ ARM B: KEEP THE NAME, ADD THE PROBLEM. Both halves are asserted,
        -- because a rebuild that kept only the problem would look like a win
        -- right up until somebody asked which customer it was about.
        v_checks := v_checks + 1;
        if v_t5 is distinct from 'Grant Plastics Ltd. — No executive sponsor or day-to-day contact is recorded for Grant Plastics Ltd' then
          v_bad := array_append(v_bad, format('the arm-B POSITIVE control was not rebuilt as expected: %L', v_t5));
        end if;
        v_checks := v_checks + 1;
        if coalesce(v_t5, '') not like '%Grant Plastics Ltd.%' then
          v_bad := array_append(v_bad, format('the arm-B rebuild LOST THE CUSTOMER NAME: %L', v_t5));
        end if;

        v_q_after := case when to_regclass('net.http_request_queue') is null
                       then null else (select count(*) from net.http_request_queue) end;
        -- ⚠ VACUITY GUARD ON THE INSTRUMENT. If the push trigger never queued
        -- anything, "after equals before" is true of a queue nothing touched
        -- and proves nothing about rollback. The number must MOVE first.
        v_checks := v_checks + 1;
        if v_q_before is not null and v_q_inside = v_q_before then
          v_bad := array_append(v_bad, format(
            'the push queue never moved (%s -> %s) while five pending human_tasks were inserted, so "the rollback unqueued the ping" compared nothing.',
            v_q_before::text, v_q_inside::text));
        end if;
        v_checks := v_checks + 1;
        if v_q_before is null then
          v_bad := array_append(v_bad, 'net.http_request_queue is not readable, so "the rolled-back controls queued no push" was NOT measured');
        elsif v_q_after <> v_q_before then
          v_bad := array_append(v_bad, format('the control inserts left %s row(s) in net.http_request_queue after rollback — a probe queued a push to a real device',
            (v_q_after - v_q_before)::text));
        end if;
        v_report := array_append(v_report, format('controls: push queue %s -> %s inside -> %s after rollback',
          coalesce(v_q_before::text, 'unreadable'), coalesce(v_q_inside::text, 'unreadable'), coalesce(v_q_after::text, 'unreadable')));

        select count(*) into v_survivor from human_tasks where id in (v_c1, v_c2, v_c3, v_c4, v_c5);
        v_checks := v_checks + 1;
        if v_survivor <> 0 then
          v_bad := array_append(v_bad, format('%s control row(s) survived the rollback and are sitting in a real workspace''s queue', v_survivor::text));
        end if;

        -- and the real targets must be back exactly as PROBE 4 found them
        select count(*) into v_survivor from _778_targets;
        v_checks := v_checks + 1;
        if v_survivor <> v_pred_total then
          v_bad := array_append(v_bad, format('the target set did not survive the control rollback: %s rows now, %s before', v_survivor::text, v_pred_total::text));
        end if;
        v_probes_ok := v_probes_ok + 1;
      end if;
    end if;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 10 (controls) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 11 — THE LADDER, every rung, with no row written anywhere.
  ------------------------------------------------------------------------
  begin
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, 'A title the caller supplied', 'a reason', 'Billing DE')
       is distinct from 'A title the caller supplied' then
      v_bad := array_append(v_bad, 'ladder rung 1: an explicit title was not honoured');
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null,
         'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails.', 'Billing DE')
       is distinct from 'Two invoices are 38–42 days overdue totalling $85,000' then
      v_bad := array_append(v_bad, 'ladder rung 2: a real reason did not become the title');
    end if;
    -- rung 2 WITH an entity: KEEP THE NAME, ADD THE PROBLEM.
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null,
         'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails.', 'Billing DE', null, null, 'Grant Plastics Ltd.')
       is distinct from 'Grant Plastics Ltd. — Two invoices are 38–42 days overdue totalling $85,000' then
      v_bad := array_append(v_bad, format('ladder rung 2 with an entity produced %L',
        public.de_escalation_title(null, null, 'Two invoices are 38–42 days overdue totalling $85,000. Both require final-notice emails.', 'Billing DE', null, null, 'Grant Plastics Ltd.')));
    end if;
    -- rung 3b: an entity and NOTHING else still keeps the name.
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null, '  ', 'Billing DE', null, null, 'Grant Plastics Ltd.')
       is distinct from 'Grant Plastics Ltd.' then
      v_bad := array_append(v_bad, 'ladder rung 3b: an entity with no reason lost the name');
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, '   ', '  ', 'Billing DE') is distinct from 'Billing DE stopped and gave no reason' then
      v_bad := array_append(v_bad, format('ladder rung 4: the last resort reads %L', public.de_escalation_title(null, '   ', '  ', 'Billing DE')));
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null, null, null) is distinct from 'An employee stopped and gave no reason' then
      v_bad := array_append(v_bad, 'ladder rung 4: an unnamed employee did not fall back cleanly');
    end if;
    -- ⚠ THE POINT OF THE WHOLE MIGRATION: no rung may produce the old sentence.
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null, null, 'Billing DE') ilike '%needs a decision%' then
      v_bad := array_append(v_bad, 'the ladder can still produce "needs a decision"');
    end if;
    v_checks := v_checks + 1;
    if public.de_escalation_title(null, null, null, 'Billing DE', null, null, 'Grant Plastics Ltd.') ilike '%needs a decision%' then
      v_bad := array_append(v_bad, 'the ladder can still produce "needs a decision" on the entity arm');
    end if;
    -- rung 3 needs a real work item. Find one rather than assume one exists.
    select w.id, w.tenant_id, btrim(w.title) into v_wi_id, v_wi_tenant, v_wi_title
      from de_work_items w where btrim(coalesce(w.title, '')) <> '' limit 1;
    v_checks := v_checks + 1;
    if v_wi_id is null then
      v_bad := array_append(v_bad, 'ladder rung 3 compared nothing — no de_work_items row with a title exists to test it against');
    elsif public.de_escalation_title(v_wi_tenant, null, null, 'Billing DE', v_wi_id, null)
          is distinct from ('Stopped on: ' || v_wi_title) then
      v_bad := array_append(v_bad, format('ladder rung 3: the work-item fallback produced %L',
        public.de_escalation_title(v_wi_tenant, null, null, 'Billing DE', v_wi_id, null)));
    end if;
    -- and rung 3 must be tenant-scoped: the wrong tenant must not read it.
    v_checks := v_checks + 1;
    if v_wi_id is not null
       and public.de_escalation_title('00000000-0000-0000-0000-000000000000'::uuid, null, null, 'Billing DE', v_wi_id, null)
           is distinct from 'Billing DE stopped and gave no reason' then
      v_bad := array_append(v_bad, 'ladder rung 3 read a work item belonging to another tenant');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 11 (the ladder) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 12 — GRANTS. Helpers reachable by a browser is a habit this repo
  -- has already paid for. The full-signature form ERRORs rather than quietly
  -- returning false if a name ever stops resolving.
  ------------------------------------------------------------------------
  begin
    for g in
      select unnest(array[
        'public.de_escalation_headline(text,integer)',
        'public.de_blocker_signature(text)',
        'public.de_escalation_scope(uuid,uuid)',
        'public.de_escalation_title(uuid,text,text,text,uuid,uuid,text)',
        'public.open_de_escalation(uuid,uuid,uuid,uuid,text,text,text,text,boolean,integer)'
      ]) as sig
    loop
      v_checks := v_checks + 1;
      if to_regprocedure(g.sig) is null then
        v_bad := array_append(v_bad, format('%s does not exist after this migration created it', g.sig));
      else
        v_checks := v_checks + 1;
        if has_function_privilege('anon', g.sig, 'execute') then
          v_bad := array_append(v_bad, format('anon can execute %s', g.sig));
        end if;
        v_checks := v_checks + 1;
        if has_function_privilege('authenticated', g.sig, 'execute') then
          v_bad := array_append(v_bad, format('authenticated can execute %s', g.sig));
        end if;
        v_checks := v_checks + 1;
        if has_function_privilege('public', g.sig, 'execute') then
          v_bad := array_append(v_bad, format('PUBLIC can execute %s', g.sig));
        end if;
      end if;
    end loop;
    -- and the OLD 6-argument ladder must be gone, or two ladders exist and
    -- callers silently pick one. (778 is unapplied, so this should never have
    -- been created; the pin is here because an overload is invisible.)
    v_checks := v_checks + 1;
    if to_regprocedure('public.de_escalation_title(uuid,text,text,text,uuid,uuid)') is not null then
      v_bad := array_append(v_bad, 'a 6-argument de_escalation_title still exists alongside the 7-argument one — two ladders, and nothing says which a caller gets');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 12 (grants) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 13 — THE RATCHET on open_de_escalation, read from pg_proc with
  -- LINE COMMENTS STRIPPED so a comment can never satisfy or trip a pin. The
  -- stripper is self-tested first, in both directions: a checker whose own
  -- instrument is broken reports whatever the instrument says.
  ------------------------------------------------------------------------
  begin
    v_selftest := regexp_replace('keep this -- needs a decision' || chr(10) || 'and this',
                                 '--[^' || chr(10) || ']*', '', 'g');
    v_checks := v_checks + 1;
    if v_selftest like '%needs a decision%' then
      v_bad := array_append(v_bad, 'the comment stripper does not strip line comments — every pin below would be reading comments');
    end if;
    v_checks := v_checks + 1;
    if v_selftest not like '%keep this%' or v_selftest not like '%and this%' then
      v_bad := array_append(v_bad, format('the comment stripper ate real code: %L', v_selftest));
    end if;

    select p.prosrc into v_src from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'open_de_escalation';
    v_checks := v_checks + 1;
    if v_src is null then
      v_bad := array_append(v_bad, 'open_de_escalation has no source to ratchet against');
    else
      v_stripped := regexp_replace(v_src, '--[^' || chr(10) || ']*', '', 'g');
      -- VACUITY GUARD: the stripped body must still be the writer we think it
      -- is, or "the generic sentence is absent" is also true of an empty string.
      v_checks := v_checks + 1;
      if v_stripped not like '%insert into human_tasks%' then
        v_bad := array_append(v_bad, 'the stripped body of open_de_escalation no longer inserts a human_task — the pins below would be reading nothing');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%de_escalation_title(%' then
        v_bad := array_append(v_bad, 'open_de_escalation does not call de_escalation_title — its fallback is not going through the ladder');
      end if;
      v_checks := v_checks + 1;
      if v_stripped ilike '%needs a decision%' then
        v_bad := array_append(v_bad, 'open_de_escalation still contains the generic sentence "needs a decision" outside its comments');
      end if;
      -- ⚠ THE GUARD'S OWN RATCHET. Each pin names a string unique to the thing
      -- it is checking, so a body that lost the guard cannot pass by accident.
      v_checks := v_checks + 1;
      if v_stripped not like '%de_blocker_signature(%' then
        v_bad := array_append(v_bad, 'open_de_escalation does not call de_blocker_signature — there is no sameness test, so every shift adds another row');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%blocker_signature @> v_sig%' then
        v_bad := array_append(v_bad, 'open_de_escalation no longer matches an open task by signature CONTAINMENT — the dedupe is gone or has changed shape');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%ht.blocker_scope = v_scope%' then
        v_bad := array_append(v_bad, 'open_de_escalation no longer separates by the work''s name — a new problem on another piece of work can now be swallowed by an old one');
      end if;
      -- ⚠⚠⚠ F4, PINNED AS A NEGATIVE. `is not distinct from` makes NULL match
      -- NULL, and 140 of 189 pending escalations have no separator at all.
      -- That operator merged two DIFFERENT CUSTOMERS through this function on
      -- live data. It must never come back.
      v_checks := v_checks + 1;
      if v_stripped ~ 'blocker_scope\s+is\s+not\s+distinct\s+from' then
        v_bad := array_append(v_bad, 'open_de_escalation compares blocker_scope with `is not distinct from` — NULL then matches NULL, and a missing separator merges unrelated work. Two different customers were merged this way on live data.');
      end if;
      -- ⚠⚠⚠ F1, PINNED. THE FAIL-OPEN GUARD ITSELF. Deleting this line was
      -- invisible to all 21 probes and 150 assertions of the first draft: the
      -- one property the whole safety argument rests on was not checked.
      v_checks := v_checks + 1;
      if v_stripped not like '%if v_scope is not null and array_length(v_sig, 1) is not null then%' then
        v_bad := array_append(v_bad, 'the FAIL-OPEN GUARD is gone from open_de_escalation. Without `v_scope is not null and array_length(v_sig, 1) is not null` an unclassifiable blocker, or one on work the writer cannot name, is matched against whatever it happens to sit beside. This is the single line the entire safety argument rests on.');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%de_escalation_scope(p_tenant_id,%' then
        v_bad := array_append(v_bad, 'open_de_escalation no longer derives its separator through de_escalation_scope');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%coalesce(p_objective_id,%' then
        v_bad := array_append(v_bad, 'open_de_escalation no longer falls back to the work item''s objective — a caller passing only a work item would store a NULL separator while the backfill stored the work''s name, and the guard would stop matching the rows it armed');
      end if;
      -- ⚠ AND THE NEGATIVE PIN, because this is the trap that was walked into
      -- once already: the raw objective_id is a PER-RUN key.
      v_checks := v_checks + 1;
      if v_stripped like '%blocker_scope is not distinct from p_objective_id%' then
        v_bad := array_append(v_bad, 'open_de_escalation is scoping by the raw p_objective_id — de-work mints a fresh objective every run, so this is the non-subject-key trap a second time and the guard would collapse nothing');
      end if;
      v_checks := v_checks + 1;
      if v_stripped !~ 'last_raised_at\s*=\s*now\(\)' then
        v_bad := array_append(v_bad, 'open_de_escalation does not record last_raised_at on a refresh — a repeat leaves no trace');
      end if;
      -- ⚠⚠ THE SLA PIN, AND IT IS A NEGATIVE ONE. The refresh UPDATE must not
      -- name sla_due_at: re-arming the clock on every repeat is what makes a
      -- stalled item look permanently fresh.
      v_checks := v_checks + 1;
      if v_stripped ~ 'update human_tasks[^;]*set[^;]*sla_due_at' then
        v_bad := array_append(v_bad, 'the refresh UPDATE writes sla_due_at — re-arming the clock on every repeat means the SLA can never expire and a permanently blocked item looks permanently fresh');
      end if;
      v_checks := v_checks + 1;
      if v_stripped ~ 'update human_tasks[^;]*set[^;]*created_at' then
        v_bad := array_append(v_bad, 'the refresh UPDATE writes created_at — that is the age of the ask and the one thing the refresh must preserve');
      end if;

      -- ⚠⚠⚠ THE NEVER-LOSE-WORDS RULE, PINNED IN THREE PLACES, because it is
      -- the rule this round exists to satisfy: COLLAPSE THE ROW, NEVER THE
      -- REPORT. Each pin names a string unique to the thing it checks.
      --
      -- (a) the fold writes the report's text onto the card a person decides
      --     from. The marker is unique to the append and appears nowhere else.
      v_checks := v_checks + 1;
      if v_stripped not like '%— also reported %' then
        v_bad := array_append(v_bad, 'the refresh no longer appends the new report to the task detail. A folded escalation would exist nowhere on the card a person decides from — this is exactly the state in which "SI-8891 text present in human_tasks.detail -> 0" was true.');
      end if;
      v_checks := v_checks + 1;
      if v_stripped !~ 'update human_tasks[^;]*set[^;]*detail\s*=' then
        v_bad := array_append(v_bad, 'the refresh UPDATE does not write detail at all — the appended report never reaches the row');
      end if;
      -- (b) and it APPENDS. An assignment that does not build on the old value
      --     is an overwrite, which destroys the account the title came from.
      v_checks := v_checks + 1;
      if v_stripped !~ 'v_detail\s*:=\s*coalesce\(v_detail,' then
        v_bad := array_append(v_bad, 'the refresh no longer builds detail from its own previous value — it is overwriting the first account rather than appending to it');
      end if;
      -- (c) the already-present test, so fourteen identical restatements do
      --     not stack fourteen identical paragraphs.
      v_checks := v_checks + 1;
      if v_stripped not like '%position(v_norm in %' then
        v_bad := array_append(v_bad, 'the refresh no longer checks whether the report is already on the card — either it appends duplicates forever, or it stopped appending');
      end if;
      -- (d) ⚠⚠ THE LEDGER ROW. Both paths must insert one, so the report
      --     survives even if the detail append is ever capped or removed.
      --     COUNTED, not merely detected: one occurrence means the fold path
      --     lost its insert and only the new-row path still writes.
      v_checks := v_checks + 1;
      if (char_length(v_stripped) - char_length(replace(v_stripped, 'insert into de_exceptions', '')))
         / char_length('insert into de_exceptions') <> 2 then
        v_bad := array_append(v_bad, format(
          'open_de_escalation contains %s `insert into de_exceptions` statement(s), expected 2 — one for a new row and one for a fold. A fold that writes no exception row is a report that exists nowhere a person can reach.',
          ((char_length(v_stripped) - char_length(replace(v_stripped, 'insert into de_exceptions', ''))) / char_length('insert into de_exceptions'))::text));
      end if;
      -- (e) and the folded report's exception row must hang off the OPEN task,
      --     or it is an orphan nothing joins back to the decision.
      v_checks := v_checks + 1;
      if v_stripped not like '%left(coalesce(p_justification, ''''), 4000), v_open_id%' then
        v_bad := array_append(v_bad, 'the fold path''s exception row is not cross-linked to the open task (v_open_id) — the report would not appear against the decision it belongs to');
      end if;
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 13 (ratchet) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 14 — the helpers are declared as what they are. All are called
  -- per row inside a writer; a VOLATILE helper there is a different function
  -- from the one every probe above tested.
  ------------------------------------------------------------------------
  begin
    v_checks := v_checks + 1;
    if (select provolatile from pg_proc where pronamespace = 'public'::regnamespace
         and proname = 'de_escalation_headline') <> 'i' then
      v_bad := array_append(v_bad, 'de_escalation_headline is not IMMUTABLE');
    end if;
    v_checks := v_checks + 1;
    if (select provolatile from pg_proc where pronamespace = 'public'::regnamespace
         and proname = 'de_blocker_signature') <> 'i' then
      v_bad := array_append(v_bad, 'de_blocker_signature is not IMMUTABLE — the sameness test would not be stable across calls');
    end if;
    v_checks := v_checks + 1;
    if (select provolatile from pg_proc where pronamespace = 'public'::regnamespace
         and proname = 'de_escalation_title') not in ('s', 'i') then
      v_bad := array_append(v_bad, 'de_escalation_title is VOLATILE — it only reads');
    end if;
    v_checks := v_checks + 1;
    if (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('de_escalation_headline', 'de_escalation_title', 'de_blocker_signature', 'de_escalation_scope')
           and 'search_path=public' = any(coalesce(p.proconfig, '{}'::text[]))) <> 4 then
      v_bad := array_append(v_bad, 'one of the four helpers has no pinned search_path');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 14 (volatility) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 15 — THE SAMENESS TEST, BOTH WAYS, at the unit. This is the whole
  -- design, so it is asserted in the direction that collapses AND in the
  -- direction that must not.
  ------------------------------------------------------------------------
  begin
    -- the three facts the reviewer read out of the eighteen ledger rows,
    -- each stated ALONE, in the employee's own words.
    v_sig1 := public.de_blocker_signature('Journal entries for this month cannot be read — no source is connected.');
    v_sig2 := public.de_blocker_signature('Journal entries do not balance: debits PKR 322,000 against credits PKR 439,300.');
    v_sig3 := public.de_blocker_signature('All 24 journal entries are dated 2027, not the 2026-08 period being closed.');

    v_checks := v_checks + 1;
    if v_sig1 is distinct from array['blocked_input']::text[] then
      v_bad := array_append(v_bad, format('fact 1 (unreadable source) classified as %L, expected {blocked_input}', v_sig1::text));
    end if;
    v_checks := v_checks + 1;
    if v_sig2 is distinct from array['inconsistent']::text[] then
      v_bad := array_append(v_bad, format('fact 2 (debits <> credits) classified as %L, expected {inconsistent}', v_sig2::text));
    end if;
    v_checks := v_checks + 1;
    if v_sig3 is distinct from array['out_of_range']::text[] then
      v_bad := array_append(v_bad, format('fact 3 (wrong period) classified as %L, expected {out_of_range}', v_sig3::text));
    end if;

    -- ⚠⚠ THE SEPARATION. None of the three may contain another, or the guard
    -- would file two genuinely different problems under one row — the single
    -- failure this design exists to avoid.
    v_checks := v_checks + 1;
    if v_sig1 @> v_sig2 or v_sig2 @> v_sig1 then
      v_bad := array_append(v_bad, 'facts 1 and 2 collapse into one another — an unreadable source and an imbalance would share a row');
    end if;
    v_checks := v_checks + 1;
    if v_sig1 @> v_sig3 or v_sig3 @> v_sig1 then
      v_bad := array_append(v_bad, 'facts 1 and 3 collapse into one another');
    end if;
    v_checks := v_checks + 1;
    if v_sig2 @> v_sig3 or v_sig3 @> v_sig2 then
      v_bad := array_append(v_bad, 'facts 2 and 3 collapse into one another');
    end if;

    -- ⚠ THE COLLAPSE, in the other direction. A restatement of the SAME
    -- blockage in different words must be absorbed, or the guard collapses
    -- nothing and this whole migration is theatre.
    v_checks := v_checks + 1;
    if not (public.de_blocker_signature(
              'Journal entries ledger (this month) is inaccessible — no source is connected. This is not an empty book; it is unread.')
            @> v_sig1) then
      v_bad := array_append(v_bad, 'a restatement of the SAME unreadable-source blockage was NOT absorbed — the guard would collapse nothing');
    end if;
    -- and a row that adds a NEW fact must NOT be absorbed by the old one.
    v_checks := v_checks + 1;
    if v_sig1 @> public.de_blocker_signature(
         'Journal entries cannot be read, and the visible debits do not balance against credits.') then
      v_bad := array_append(v_bad, 'a row reporting a NEW second blocker was absorbed by the older single-blocker row — this is the swallow the design forbids');
    end if;

    -- FAIL OPEN: an account the catalog does not recognise dedupes never.
    v_checks := v_checks + 1;
    if public.de_blocker_signature('Please confirm whether to proceed to the next phase.') <> '{}'::text[] then
      v_bad := array_append(v_bad, format('an unrecognised account was classified as %L instead of the empty set — it would dedupe against something',
        public.de_blocker_signature('Please confirm whether to proceed to the next phase.')::text));
    end if;
    v_checks := v_checks + 1;
    if array_length(public.de_blocker_signature(null), 1) is not null
       or array_length(public.de_blocker_signature('   '), 1) is not null then
      v_bad := array_append(v_bad, 'de_blocker_signature(null/whitespace) did not return the empty set');
    end if;
    -- sorted + deduped, or `@>` is comparing two different orderings
    v_checks := v_checks + 1;
    if public.de_blocker_signature('Overdue invoices cannot be read; the feed is truncated and the totals do not balance.')
       is distinct from array['blocked_input','inconsistent','overdue']::text[] then
      v_bad := array_append(v_bad, format('a multi-kind account did not come back sorted and deduped: %L',
        public.de_blocker_signature('Overdue invoices cannot be read; the feed is truncated and the totals do not balance.')::text));
    end if;
    -- GENERICITY: the same blockage in a NON-accounting department must
    -- classify identically, or the catalog has quietly become domain-specific.
    v_checks := v_checks + 1;
    if not (public.de_blocker_signature('The knowledge base cannot be read — no source is connected.') @> array['blocked_input']::text[]) then
      v_bad := array_append(v_bad, 'a support-shaped "cannot read the knowledge base" did not classify as blocked_input — the catalog has become department-specific');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 15 (sameness test, both ways) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 16 — THE SAMENESS TEST OVER THE LIVE CORPUS. The unit fixtures
  -- above prove the rule agrees with itself. This replays the guard's exact
  -- algorithm, in date order, over every pending escalation actually in the
  -- database — because a rule that classifies three hand-written sentences
  -- correctly and collapses nothing real would pass PROBE 15 and be useless.
  ------------------------------------------------------------------------
  begin
    -- arm the columns first: this is also the backfill the guard needs.
    update human_tasks ht
       set blocker_signature = public.de_blocker_signature(ht.detail),
           blocker_scope     = public.de_escalation_scope(
                                 ht.tenant_id,
                                 (select w.objective_id from de_work_items w
                                   where w.id = ht.related_id
                                     and ht.related_table = 'de_work_items'
                                     and w.tenant_id = ht.tenant_id))
      from digital_employees de
     where de.id = ht.de_id
       and coalesce(de.is_workforce_assistant, false) = false
       and ht.type = 'escalation' and ht.status = 'pending'
       and ht.blocker_signature is null;
    get diagnostics v_n2 = row_count;
    v_report := array_append(v_report, format('blocker_signature/blocker_scope armed on %s pending escalation(s)', v_n2::text));

    create temp table if not exists _778_sim (
      k integer generated always as identity,
      grp_tenant uuid, grp_de uuid, grp_scope text, use_scope boolean,
      sig text[], first_at timestamptz, hits integer
    );
    delete from _778_sim;

    v_sim_raised := 0;
    -- ⚠⚠ RUN THE SAME REPLAY TWICE, AND THE SECOND ARM IS THE REJECTED RULE.
    -- Arm TRUE is what ships: a NULL separator never matches, so an escalation
    -- on work the writer cannot name keeps its own row. Arm FALSE is the first
    -- draft's `is not distinct from`, under which NULL matched NULL — the rule
    -- that merged two different customers on live data.
    --
    -- The pin below asserts arm TRUE produces STRICTLY MORE rows. That is the
    -- right direction to assert and the right way round to read it: a guard
    -- that stopped failing open would show up here as a SHORTER queue, which
    -- is exactly what swallowing reports looks like from the outside. If the
    -- two numbers ever match, either no pending escalation lacks a separator
    -- (so the fix was never exercised) or the fix is gone.
    for g in select unnest(array[true, false]) as with_scope loop
      for f in
        select ht.id, ht.tenant_id, ht.de_id, ht.blocker_scope, ht.blocker_signature, ht.created_at
          from human_tasks ht
          left join digital_employees de on de.id = ht.de_id
         where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
           and (ht.de_id is null or coalesce(de.is_workforce_assistant, false) = false)
         order by ht.tenant_id, ht.de_id, ht.created_at, ht.id
      loop
        if g.with_scope then v_sim_raised := v_sim_raised + 1; end if;
        if array_length(f.blocker_signature, 1) is null then
          insert into _778_sim (grp_tenant, grp_de, grp_scope, use_scope, sig, first_at, hits)
          values (f.tenant_id, f.de_id, f.blocker_scope, g.with_scope, null, f.created_at, 1);
        else
          select s.k into v_n3 from _778_sim s
           where s.use_scope = g.with_scope
             and s.grp_tenant = f.tenant_id
             and s.grp_de is not distinct from f.de_id
             -- arm TRUE  = the shipped rule: `=`, so a NULL scope matches nothing.
             -- arm FALSE = the rejected rule: `is not distinct from`, NULL = NULL.
             and (case when g.with_scope then s.grp_scope = f.blocker_scope
                       else s.grp_scope is not distinct from f.blocker_scope end)
             and s.sig is not null
             and s.sig @> f.blocker_signature
           order by s.first_at, s.k
           limit 1;
          if v_n3 is not null then
            update _778_sim set hits = hits + 1 where k = v_n3;
          else
            insert into _778_sim (grp_tenant, grp_de, grp_scope, use_scope, sig, first_at, hits)
            values (f.tenant_id, f.de_id, f.blocker_scope, g.with_scope, f.blocker_signature, f.created_at, 1);
          end if;
          v_n3 := null;
        end if;
      end loop;
    end loop;

    select count(*) filter (where use_scope), count(*) filter (where not use_scope)
      into v_sim_open, v_sim_open_noscope from _778_sim;

    -- VACUITY GUARD on the corpus itself.
    v_checks := v_checks + 1;
    if v_sim_raised = 0 then
      v_bad := array_append(v_bad, 'the live-corpus replay saw ZERO pending escalations — every number below compared nothing');
    end if;

    -- ⚠⚠⚠ F4, AT CORPUS SCALE. The shipped rule must produce STRICTLY MORE
    -- rows than the rejected one. Equal numbers mean NULL is matching NULL
    -- again, or that no pending escalation lacks a separator — in which case
    -- the fix was never exercised and this comparison proved nothing either.
    v_checks := v_checks + 1;
    if v_sim_raised > 0 and v_sim_open <= v_sim_open_noscope then
      v_bad := array_append(v_bad, format(
        'the missing-separator rule changed nothing on the live corpus (%s open rows under `=`, %s under `is not distinct from`). Either NULL is matching NULL again — the rule that merged two different customers through the real writer — or nothing in this queue lacks a separator, in which case the fix was never exercised.',
        v_sim_open::text, v_sim_open_noscope::text));
    end if;
    -- ... and the corpus must actually CONTAIN the case, or the pin above is
    -- comparing two numbers that were never allowed to differ.
    select count(*) into v_n3
      from human_tasks ht
      left join digital_employees de on de.id = ht.de_id
     where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
       and (ht.de_id is null or coalesce(de.is_workforce_assistant, false) = false)
       and ht.blocker_scope is null
       and array_length(ht.blocker_signature, 1) is not null;
    v_checks := v_checks + 1;
    if v_n3 = 0 then
      v_bad := array_append(v_bad, 'no pending escalation carries a signature with NO separator, so "a missing separator never matches" compared nothing on this corpus');
    end if;
    v_report := array_append(v_report, format(
      'missing separator: %s classified escalation(s) carry no scope at all; each keeps its own row (%s rows under `=` vs %s under the rejected `is not distinct from`)',
      v_n3::text, v_sim_open::text, v_sim_open_noscope::text));
    v_n3 := null;

    -- The biggest repeat pile: whatever it is today, never a hardcoded one.
    --
    -- ⚠ THE KEY IS COMPARED WITH IS NOT DISTINCT FROM, one column at a time.
    -- A row-comparison `(a,b,c) = (...)` reads NULL when the objective is
    -- null, so the count came back 0 and the collapse assertion fired on a
    -- pile it had never actually looked at — a checker reading nothing.
    --
    -- ⚠⚠ AND THE PILE IS RANKED BY CLASSIFIED ROWS, NOT BY ROWS. The first
    -- draft ranked by row count and selected a 20-row workspace whose
    -- escalations classify to nothing at all. It then reported "20 raised ->
    -- 20 open, the sameness test is not recognising restatements" — which was
    -- the checker demanding a BUG. An unclassified escalation is supposed to
    -- keep its own row; that is the fail-open half of this design, and it is
    -- asserted separately below. The collapse claim is only ever a claim
    -- about rows the guard can act on, so that is what it is measured over.
    --
    -- ⚠⚠⚠ AND SINCE THIS ROUND, A NULL SCOPE IS EXCLUDED FROM THE RANKING.
    -- A group with no separator can no longer collapse AT ALL — that is the
    -- F4 fix, deliberate and asserted above. Ranking it here would point the
    -- collapse assertion at a pile that is supposed to stay long, and the
    -- checker would then be DEMANDING THE BUG, which is the same mistake the
    -- previous draft made one paragraph up with unclassified rows.
    select ht.tenant_id, ht.de_id, ht.blocker_scope,
           count(*) filter (where array_length(ht.blocker_signature, 1) is not null),
           coalesce(max(tn.slug || '/' || coalesce(de.name, '?')), '?')
      into v_big_t, v_big_d, v_big_s, v_big_raised, v_big_label
      from human_tasks ht
      join tenants tn on tn.id = ht.tenant_id
      left join digital_employees de on de.id = ht.de_id
     where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
       and (ht.de_id is null or coalesce(de.is_workforce_assistant, false) = false)
       and ht.blocker_scope is not null
     group by ht.tenant_id, ht.de_id, ht.blocker_scope
     order by count(*) filter (where array_length(ht.blocker_signature, 1) is not null) desc,
              ht.tenant_id, ht.de_id
     limit 1;

    select count(*) into v_big_open
      from _778_sim s
     where s.use_scope
       and s.sig is not null                       -- classified survivors only
       and s.grp_tenant is not distinct from v_big_t
       and s.grp_de     is not distinct from v_big_d
       and s.grp_scope  is not distinct from v_big_s;

    v_report := array_append(v_report, format(
      'LIVE REPLAY: %s pending escalation(s) -> %s open row(s) with the objective separator, %s without it. Biggest single pile [%s]: %s raised -> %s open.',
      v_sim_raised::text, v_sim_open::text, v_sim_open_noscope::text, v_big_label, v_big_raised::text, v_big_open::text));

    -- VACUITY GUARD on the collapse claim: a "pile" of two proves nothing.
    v_checks := v_checks + 1;
    if v_big_raised < 10 then
      v_bad := array_append(v_bad, format(
        'the biggest repeat pile on this database is only %s escalation(s) — the collapse claim compared nothing worth calling a pile.', v_big_raised::text));
    else
      -- IT MUST COLLAPSE ...
      v_checks := v_checks + 1;
      if v_big_open * 2 > v_big_raised then
        v_bad := array_append(v_bad, format(
          'the biggest pile barely collapsed: %s raised -> %s open. The sameness test is not recognising restatements of one blockage.',
          v_big_raised::text, v_big_open::text));
      end if;
      -- ... AND IT MUST NOT COLLAPSE TO ONE. A single survivor would mean
      -- every distinct problem on that objective had been filed behind the
      -- first one, which is the failure this design forbids.
      v_checks := v_checks + 1;
      if v_big_open < 2 then
        v_bad := array_append(v_bad, format(
          'the biggest pile collapsed to %s row(s). Everything on that objective was filed behind the first escalation — a new failure is now invisible behind an old one.',
          v_big_open::text));
      end if;
    end if;

    -- ⚠ FAIL OPEN, PROVEN AT CORPUS SCALE. Every pending escalation the
    -- catalog does not recognise must still occupy its own row. If these ever
    -- start merging, an unrecognised blocker is disappearing behind another
    -- unrecognised blocker — the worst version of the failure this design
    -- forbids, because neither row says what it is.
    select count(*) into v_residual
      from human_tasks ht
      left join digital_employees de on de.id = ht.de_id
     where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
       and (ht.de_id is null or coalesce(de.is_workforce_assistant, false) = false)
       and array_length(ht.blocker_signature, 1) is null;
    select count(*) into v_n3 from _778_sim where use_scope and sig is null;
    v_checks := v_checks + 1;
    if v_residual = 0 then
      v_bad := array_append(v_bad, 'no pending escalation classifies to the empty set, so "an unrecognised blocker keeps its own row" compared nothing');
    end if;
    v_checks := v_checks + 1;
    if v_n3 <> v_residual then
      v_bad := array_append(v_bad, format(
        '%s unrecognised escalation(s) occupy only %s row(s) in the replay — the guard is merging blockers it cannot even classify.',
        v_residual::text, v_n3::text));
    end if;
    v_report := array_append(v_report, format(
      'fail-open: %s of %s pending escalation(s) classify to nothing and each keeps its own row — this guard does not touch them',
      v_residual::text, coalesce(v_sim_raised, 0)::text));
    v_n3 := null;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 16 (live-corpus replay) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 17 — THE GUARD, END TO END, THROUGH THE REAL WRITER, on planted
  -- rows in a real workspace, rolled back by a deliberate raise. PROBE 16
  -- replays the algorithm; this one runs open_de_escalation itself, because
  -- a simulation of a function is not the function.
  ------------------------------------------------------------------------
  begin
    if v_ctl_tenant is null then
      v_bad := array_append(v_bad, 'PROBE 17 (the guard) had no control tenant — it compared nothing');
    else
      begin
        v_q_before := case when to_regclass('net.http_request_queue') is null
                        then null else (select count(*) from net.http_request_queue) end;
        select count(*) into v_g_rows from human_tasks
         where tenant_id = v_ctl_tenant and de_id = v_ctl_de1 and type = 'escalation' and status = 'pending';
        select o.id, btrim(o.title) into v_obj_id, v_obj_title
          from de_objectives o
         where o.tenant_id = v_ctl_tenant and btrim(coalesce(o.title, '')) <> ''
         order by o.id limit 1;

        -- (1) the first ask
        v_g1 := public.open_de_escalation(v_ctl_tenant, v_ctl_de1, null, v_obj_id, null,
          'Journal entries for this month cannot be read — no source is connected.', null, null, false, 24);
        v_g_task := (v_g1 ->> 'task_id')::uuid;
        select sla_due_at, created_at, detail into v_g_sla_before, v_g_created_before, v_g_detail
          from human_tasks where id = v_g_task;
        v_q_inside := case when to_regclass('net.http_request_queue') is null
                        then null else (select count(*) from net.http_request_queue) end;

        -- (2) the SAME blockage, restated the way a model restates it
        v_g2 := public.open_de_escalation(v_ctl_tenant, v_ctl_de1, null, v_obj_id, null,
          'Journal entries ledger (this month) is inaccessible — no source is connected. This is not an empty book; it is unread.', null, null, false, 24);
        select title, sla_due_at, created_at, repeat_count, detail, distinct_reports
          into v_g_title, v_g_sla_after, v_g_created_after, v_g_rep, v_g_detail_after, v_g_dist
          from human_tasks where id = v_g_task;

        -- (3) a DIFFERENT problem on the same objective — must open its own row
        v_g3 := public.open_de_escalation(v_ctl_tenant, v_ctl_de1, null, v_obj_id, null,
          'Journal entries do not balance: debits PKR 322,000 against credits PKR 439,300.', null, null, false, 24);
        v_g_task3 := (v_g3 ->> 'task_id')::uuid;

        -- (4) ⚠⚠ THE SWALLOW ORDERING. The open row reports ONE blocker; this
        -- one reports that blocker AND A SECOND. It must NOT be absorbed.
        -- Reversing the containment operator passes every other assertion in
        -- this probe and fails only here, which is why this case exists: the
        -- source-text ratchet alone would be one reformat away from silence.
        v_g4 := public.open_de_escalation(v_ctl_tenant, v_ctl_de1, null, v_obj_id, null,
          'Journal entries cannot be read — no source is connected — and the visible debits do not balance against credits.', null, null, false, 24);
        v_g_task4 := (v_g4 ->> 'task_id')::uuid;
        select blocker_scope into v_g_scope from human_tasks where id = v_g_task;

        -- (5) ⚠ THE OTHER WRITER OF THE SEPARATOR. Called with a WORK ITEM and
        -- NO objective — the shape the backfill resolves through de_work_items.
        -- If the writer does not do the same, the two disagree and the guard
        -- stops matching rows it armed itself.
        select w.id, btrim(o.title) into v_wi2, v_wi2_title
          from de_work_items w
          join de_objectives o on o.id = w.objective_id
         where w.tenant_id = v_ctl_tenant and btrim(coalesce(o.title, '')) <> ''
           and o.id is distinct from v_obj_id
         order by w.id limit 1;
        if v_wi2 is not null then
          v_g5 := public.open_de_escalation(v_ctl_tenant, v_ctl_de1, v_wi2, null, null,
            'No day-to-day contact is recorded for this account, so nobody can be asked.', null, null, false, 24);
          v_g_task5 := (v_g5 ->> 'task_id')::uuid;
          select blocker_scope into v_g_scope5 from human_tasks where id = v_g_task5;
        end if;

        select count(*) into v_g_exc from de_exceptions where human_task_id = v_g_task;
        v_q_after := case when to_regclass('net.http_request_queue') is null
                        then null else (select count(*) from net.http_request_queue) end;
        v_g_ok := true;
        raise exception using errcode = 'ZZ779', message = 'guard probe: deliberate rollback';
      exception
        when sqlstate 'ZZ779' then null;
        when others then
          v_bad := array_append(v_bad, format('PROBE 17 (the guard) aborted: %s %s', sqlstate, sqlerrm));
      end;

      if v_g_ok then
        v_checks := v_checks + 1;
        if coalesce((v_g1 ->> 'deduped')::boolean, true) then
          v_bad := array_append(v_bad, 'the FIRST escalation reported deduped=true — it deduped against something that was not there');
        end if;
        v_checks := v_checks + 1;
        if not coalesce((v_g2 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'a restatement of the SAME blockage was NOT deduped — the guard did not fire on the case it exists for');
        end if;
        v_checks := v_checks + 1;
        if (v_g2 ->> 'task_id')::uuid is distinct from v_g_task then
          v_bad := array_append(v_bad, 'the refresh returned a DIFFERENT task id — it wrote a new row instead of refreshing the open one');
        end if;
        v_checks := v_checks + 1;
        if v_g_rep is distinct from 2 then
          v_bad := array_append(v_bad, format('repeat_count is %s after one refresh, expected 2', coalesce(v_g_rep::text, 'null')));
        end if;
        -- ⚠ THE AGE MUST SHOW. A row silently updated is indistinguishable
        -- from a row raised today, and the age is what makes it urgent.
        v_checks := v_checks + 1;
        if coalesce(v_g_title, '') not like '% · asked 2× since %' then
          v_bad := array_append(v_bad, format('the refreshed title does not say it has been asked twice and since when: %L', v_g_title));
        end if;
        -- and the suffix must not accumulate
        v_checks := v_checks + 1;
        if (char_length(coalesce(v_g_title, '')) - char_length(replace(coalesce(v_g_title, ''), ' · asked ', ''))) <> char_length(' · asked ') then
          v_bad := array_append(v_bad, format('the refresh suffix appears more than once — a task refreshed fourteen times would carry fourteen: %L', v_g_title));
        end if;
        -- ⚠⚠ THE SLA CLOCK IS NOT RE-ARMED, and it was running to begin with.
        v_checks := v_checks + 1;
        if v_g_sla_before is null then
          v_bad := array_append(v_bad, 'sla_due_at was null on the first escalation, so "the refresh did not re-arm it" compared nothing');
        end if;
        v_checks := v_checks + 1;
        if v_g_sla_after is distinct from v_g_sla_before then
          v_bad := array_append(v_bad, format('the refresh moved sla_due_at (%s -> %s) — a stalled item would look permanently fresh and could never expire',
            v_g_sla_before::text, v_g_sla_after::text));
        end if;
        v_checks := v_checks + 1;
        if v_g_created_after is distinct from v_g_created_before then
          v_bad := array_append(v_bad, 'the refresh moved created_at — the card would report "Waiting 0 minutes" on a blocker fourteen days old');
        end if;
        -- the planted row is GONE after the deliberate rollback
        v_checks := v_checks + 1;
        if (select detail from human_tasks where id = v_g_task) is not null then
          v_bad := array_append(v_bad, 'the guard-probe task survived the rollback');
        end if;
        -- ⚠⚠⚠ COLLAPSE THE ROW, NEVER THE REPORT — the whole of this round,
        -- asserted through the real writer rather than argued in a comment.
        --
        -- (i) THE FIRST ACCOUNT IS STILL THERE. Appending, never overwriting.
        v_checks := v_checks + 1;
        if position('no source is connected' in coalesce(v_g_detail_after, '')) = 0
           or coalesce(v_g_detail_after, '') not like 'Journal entries for this month cannot be read%' then
          v_bad := array_append(v_bad, format('the refresh did not preserve the FIRST account at the front of detail — the text the title was derived from was overwritten: %L', left(coalesce(v_g_detail_after, ''), 200)));
        end if;
        -- (ii) AND THE SECOND REPORT IS ON THE CARD. This is the assertion the
        --      first draft could not have passed: it left detail alone, so a
        --      folded report existed nowhere a person could read it.
        v_checks := v_checks + 1;
        if position('This is not an empty book; it is unread.' in coalesce(v_g_detail_after, '')) = 0 then
          v_bad := array_append(v_bad, format('the folded report is NOT in the task detail. A repeat was collapsed into an open row and its words went nowhere — the exact failure this round exists to remove. detail=%L', left(coalesce(v_g_detail_after, ''), 400)));
        end if;
        -- (iii) and the reader is TOLD there is more than one report inside.
        v_checks := v_checks + 1;
        if coalesce(v_g_dist, 0) <> 2 then
          v_bad := array_append(v_bad, format('distinct_reports is %s after one folded report, expected 2', coalesce(v_g_dist::text, 'null')));
        end if;
        v_checks := v_checks + 1;
        if coalesce(v_g_title, '') not like '%2 different reports inside%' then
          v_bad := array_append(v_bad, format('the title does not say the card holds more than one report, so a reader has no reason to scroll: %L', v_g_title));
        end if;
        -- (iv) ⚠⚠ AND THE LEDGER ROW. A fold writes its own de_exceptions row,
        --      cross-linked to the task it landed on. The first draft asserted
        --      the OPPOSITE here — "no second exception row" — and that single
        --      assertion is what made the report unreachable. Reversed on
        --      purpose, and stated so the reversal is impossible to miss.
        v_checks := v_checks + 1;
        if v_g_exc <> 2 then
          v_bad := array_append(v_bad, format('one ask plus one folded repeat produced %s de_exceptions row(s), expected 2. A fold that writes no ledger row is a report that exists in no table.', v_g_exc::text));
        end if;
        v_checks := v_checks + 1;
        if coalesce((v_g2 ->> 'report_appended')::boolean, false) is not true then
          v_bad := array_append(v_bad, 'the writer did not report that it appended the folded account — report_appended was not true');
        end if;
        -- ⚠ THE OTHER DIRECTION: a genuinely different problem still gets a row.
        v_checks := v_checks + 1;
        if coalesce((v_g3 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'a DIFFERENT problem (an imbalance, not an unreadable source) was swallowed by the open task — this is the exact failure the design forbids');
        end if;
        v_checks := v_checks + 1;
        if v_g_task3 is null or v_g_task3 = v_g_task then
          v_bad := array_append(v_bad, 'the different problem did not get its own task row');
        end if;
        -- ⚠⚠ A SUPERSET IS A NEW FAILURE, NOT A REPEAT.
        v_checks := v_checks + 1;
        if coalesce((v_g4 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'an escalation reporting the open blocker PLUS A SECOND ONE was absorbed by the narrower open task. The containment is running backwards: a new failure is now invisible behind an old one, which is the single outcome this design exists to prevent.');
        end if;
        v_checks := v_checks + 1;
        if v_g_task4 is null or v_g_task4 in (v_g_task, v_g_task3) then
          v_bad := array_append(v_bad, 'the escalation carrying a second blocker did not get its own task row');
        end if;
        -- ⚠ THE WORK-ITEM-ONLY PATH STORES THE SAME SEPARATOR.
        v_checks := v_checks + 1;
        if v_wi2 is null then
          v_bad := array_append(v_bad, 'PROBE 17 found no work item under a titled objective in the control tenant, so the writer''s work-item fallback for the separator was NOT measured');
        else
          v_checks := v_checks + 1;
          if v_g_scope5 is distinct from lower(v_wi2_title) then
            v_bad := array_append(v_bad, format('called with a work item and no objective, the writer stored blocker_scope=%L; the backfill would have stored %L for the same row. The two writers of this column disagree, so the guard would not match the rows it armed.', v_g_scope5, lower(v_wi2_title)));
          end if;
        end if;

        -- ⚠ AND THE STORED SEPARATOR IS THE WORK'S NAME, NOT THIS RUN'S ID.
        v_checks := v_checks + 1;
        if v_obj_id is null then
          v_bad := array_append(v_bad, 'PROBE 17 found no titled objective in the control tenant, so nothing was proven about the separator the writer stores');
        else
          v_checks := v_checks + 1;
          if v_g_scope is distinct from lower(v_obj_title) then
            v_bad := array_append(v_bad, format('the writer stored blocker_scope=%L for an objective titled %L — the separator is not the name of the work', v_g_scope, v_obj_title));
          end if;
          v_checks := v_checks + 1;
          if v_g_scope = v_obj_id::text then
            v_bad := array_append(v_bad, 'the writer stored the raw objective id as the separator — de-work mints a fresh objective every run, so the guard would collapse nothing');
          end if;
        end if;
        -- the push queue moved on the INSERT and came back after rollback
        v_checks := v_checks + 1;
        if v_q_before is not null and v_q_inside = v_q_before then
          v_bad := array_append(v_bad, format('the push queue never moved (%s -> %s) when the guard probe inserted a pending task, so nothing about pings was measured', v_q_before::text, v_q_inside::text));
        end if;
        v_checks := v_checks + 1;
        if v_q_before is not null and v_q_after is not null
           and (select count(*) from net.http_request_queue) <> v_q_before then
          v_bad := array_append(v_bad, 'the guard probe left rows in net.http_request_queue after rollback — it pinged a real device');
        end if;
        v_checks := v_checks + 1;
        if (select count(*) from human_tasks
             where tenant_id = v_ctl_tenant and de_id = v_ctl_de1 and type = 'escalation' and status = 'pending') <> v_g_rows then
          v_bad := array_append(v_bad, 'the guard probe left escalations behind in a real workspace''s queue');
        end if;
        v_report := array_append(v_report, format('guard probe: ask -> new row; restated -> deduped (repeat_count=%s, sla unmoved); different problem -> its own row', v_g_rep::text));
        v_probes_ok := v_probes_ok + 1;
      end if;
    end if;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 17 (the guard) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 18 — THE CASE-SENSITIVITY DEFECT, counted BOTH WAYS so the
  -- difference is a number on the apply log rather than a claim in a comment.
  -- Run against a fixed corpus of planted titles, because the live rows have
  -- just been rewritten and would report 0 = 0 — which is exactly what a
  -- vacuous check looks like.
  ------------------------------------------------------------------------
  begin
    select count(*) filter (where t like '%needs a decision%'),
           count(*) filter (where t ilike '%needs a decision%')
      into v_cs, v_ci
      from (values
        ('Accounting DE needs a decision'),
        ('Billing & Invoicing DE needs a decision'),
        ('Needs a decision — Grant Plastics Ltd.'),
        ('Needs a decision — West View Software Ltd.'),
        ('Approve the refund for Grant Plastics before Friday')
      ) as x(t);
    v_checks := v_checks + 1;
    if v_ci <= v_cs then
      v_bad := array_append(v_bad, format(
        'the case-insensitive sweep found no more than the case-sensitive one (%s vs %s) — the fixture no longer contains a title-cased instance, so it can no longer demonstrate the defect that hid five live rows.',
        v_ci::text, v_cs::text));
    end if;
    v_report := array_append(v_report, format(
      'case-sensitivity, on a fixed 5-title fixture: like=%s ilike=%s (the gap is the entityName arm). On the LIVE queue before this run: like=42 ilike=47.',
      v_cs::text, v_ci::text));
    -- and the shipped predicate must be the case-insensitive one
    -- ⚠ pg_get_viewdef RENDERS `ilike` AS THE OPERATOR `~~*`. The first
    -- draft of this pin searched for the word "ilike" and went red against a
    -- predicate that is case-insensitive — a checker that fails on the
    -- correct code is as useless as one that passes on the wrong code, and it
    -- is why this pin accepts either spelling and self-tests below.
    v_src := (select pg_get_viewdef('_778_generic'::regclass));
    v_checks := v_checks + 1;
    if v_src is null or char_length(v_src) < 100 then
      v_bad := array_append(v_bad, 'the backfill view definition could not be read, so nothing was pinned about its case sensitivity');
    end if;
    v_checks := v_checks + 1;
    if coalesce(v_src, '') not ilike '%ilike%' and coalesce(v_src, '') not like '%~~*%' then
      v_bad := array_append(v_bad, format('the backfill predicate is case-SENSITIVE — the five title-cased rows would be missed again. viewdef: %s', left(coalesce(v_src, ''), 200)));
    end if;
    -- INVERSION: the same instrument must be able to SEE a case-sensitive
    -- predicate, or "it uses ilike" is true of every string it ever reads.
    v_checks := v_checks + 1;
    if ('where t like ''%x%''' ilike '%ilike%') or ('where t like ''%x%''' like '%~~*%') then
      v_bad := array_append(v_bad, 'the case-sensitivity instrument reports a plain LIKE predicate as case-insensitive — it cannot tell the two apart');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 18 (case sensitivity) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 19 — the TS twin still exists on the client side of the same rule.
  -- Checked from SQL only as far as SQL can see it: the writer must not have
  -- become the ONLY place a title is composed, or de-work's :1301 ternary is
  -- back. This is a weak pin and is labelled as one; tests/escalation-headline
  -- .test.ts is the real one, and it runs in vitest.
  ------------------------------------------------------------------------
  begin
    select p.prosrc into v_src from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'de_escalation_title';
    v_checks := v_checks + 1;
    if v_src is null then
      v_bad := array_append(v_bad, 'de_escalation_title has no source to ratchet against');
    else
      v_stripped := regexp_replace(v_src, '--[^' || chr(10) || ']*', '', 'g');
      v_checks := v_checks + 1;
      if v_stripped not like '%de_escalation_headline(p_reason%' then
        v_bad := array_append(v_bad, 'the ladder no longer derives rung 2 from the employee''s own reason');
      end if;
      v_checks := v_checks + 1;
      if v_stripped not like '%v_entity || '' — '' || v_title%' then
        v_bad := array_append(v_bad, 'the ladder no longer composes <entity> — <headline>: KEEP THE NAME, ADD THE PROBLEM is not implemented');
      end if;
      v_checks := v_checks + 1;
      if v_stripped ilike '%needs a decision%' then
        v_bad := array_append(v_bad, 'the ladder body contains the generic sentence outside its comments');
      end if;
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 19 (ladder ratchet) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 20 — the new columns exist, and they did NOT open a write surface.
  -- human_tasks already grants at table level, so the pin is that anon gained
  -- nothing and that the decision guard still refuses a direct status write.
  ------------------------------------------------------------------------
  begin
    v_checks := v_checks + 1;
    if (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'human_tasks'
           and column_name in ('blocker_signature', 'blocker_scope', 'repeat_count',
                               'distinct_reports', 'last_raised_at')) <> 5 then
      v_bad := array_append(v_bad, 'one of the five guard columns is missing from human_tasks');
    end if;
    v_checks := v_checks + 1;
    if has_table_privilege('anon', 'public.human_tasks', 'UPDATE') then
      v_bad := array_append(v_bad, 'anon can UPDATE human_tasks — the guard columns are writable from an unauthenticated session');
    end if;
    v_checks := v_checks + 1;
    if to_regclass('public.human_tasks_blocker_lookup_idx') is null then
      v_bad := array_append(v_bad, 'the guard''s lookup index was not created — every escalation would seq-scan the queue');
    end if;
    -- the decision guard that keeps these columns non-authoritative
    v_checks := v_checks + 1;
    if not exists (select 1 from pg_trigger t
                    where t.tgrelid = 'public.human_tasks'::regclass
                      and t.tgname = 'trg_guard_human_task_decision' and not t.tgisinternal) then
      v_bad := array_append(v_bad, 'trg_guard_human_task_decision is gone — status/decided_by are no longer protected, so these new columns are no longer the harmless half');
    end if;
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 20 (columns and perimeter) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 21 — THE SEPARATOR IS NOT ITSELF A PER-RUN KEY.
  --
  -- ⚠⚠⚠ THIS PROBE EXISTS BECAUSE THE FIRST DRAFT FAILED IT. The guard was
  -- scoped by objective_id, which reads like the subject and is not: de-work
  -- creates a fresh de_objectives row for each day's sweep, so 18 ledger
  -- escalations carried 15 different objective ids. Every containment probe
  -- still passed. The guard simply collapsed nothing, and nothing said so.
  --
  -- The pin: over the pending corpus, the number of distinct SCOPE keys must
  -- be strictly smaller than the number of distinct objective ids. If they
  -- are equal, the separator is once again minted per run and this migration
  -- is decorative.
  ------------------------------------------------------------------------
  begin
    select count(distinct ht.blocker_scope), count(distinct w.objective_id), count(*)
      into v_scope_keys, v_obj_ids, v_residual
      from human_tasks ht
      left join digital_employees de on de.id = ht.de_id
      join de_work_items w on w.id = ht.related_id and ht.related_table = 'de_work_items'
     where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
       and (ht.de_id is null or coalesce(de.is_workforce_assistant, false) = false)
       and ht.blocker_scope is not null
       and w.objective_id is not null;

    -- VACUITY GUARDS, both of them: zero scopes and zero objectives compare
    -- nothing, and 'fewer' is meaningless on a corpus with no repeats.
    v_checks := v_checks + 1;
    if v_residual < 10 then
      v_bad := array_append(v_bad, format(
        'only %s pending escalation(s) carry both a scope and an objective — too few to tell a per-run key from a stable one, so this pin compared nothing.',
        v_residual::text));
    else
      v_checks := v_checks + 1;
      if v_obj_ids = 0 or v_scope_keys = 0 then
        v_bad := array_append(v_bad, 'the scope/objective comparison read zero of one of them');
      end if;
      v_checks := v_checks + 1;
      if v_scope_keys >= v_obj_ids then
        v_bad := array_append(v_bad, format(
          'the separator is a PER-RUN KEY: %s distinct scope key(s) across %s distinct objective id(s) over %s escalation(s). A key the writer mints per run can only ever look distinct — this is the trap related_id set, one level up, and the guard would collapse nothing.',
          v_scope_keys::text, v_obj_ids::text, v_residual::text));
      end if;
    end if;
    v_report := array_append(v_report, format(
      'separator: %s distinct scope key(s) over %s distinct objective id(s) on %s pending escalation(s) — the gap IS the per-run churn the scope absorbs',
      coalesce(v_scope_keys, 0)::text, coalesce(v_obj_ids, 0)::text, coalesce(v_residual, 0)::text));
    v_probes_ok := v_probes_ok + 1;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 21 (per-run separator) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- PROBE 22 — COLLAPSE THE ROW, NEVER THE REPORT: the three cases a
  -- reviewer drove against the FIRST DRAFT and found reports missing. Each
  -- one is driven again here, through the real open_de_escalation, on a real
  -- workspace, rolled back by a deliberate raise — and each now has to end
  -- with the words REACHABLE, at a named address.
  --
  --   A  SI-8891, a narrower NEW problem absorbed by a broader open row.
  --      Against the first draft: "SI-8891 text present in detail -> 0".
  --   B  two DIFFERENT CUSTOMERS, in both of the shapes the queue actually
  --      contains: with no separator at all (140 of 189 pending rows), and
  --      with the SAME separator.
  --   C  the three ledger facts against the REAL, ARMED queue — tomorrow
  --      morning's state, after PROBE 16's backfill — not in isolation.
  ------------------------------------------------------------------------
  begin
    if v_ctl_tenant is null then
      v_bad := array_append(v_bad, 'PROBE 22 (never lose the report) had no control tenant — it compared nothing');
    else
      begin
        select o.id into v_c_obj
          from de_objectives o
         where o.tenant_id = v_ctl_tenant and btrim(coalesce(o.title, '')) <> ''
         order by o.id limit 1;
        v_c_de := v_ctl_de1;

        -- ── CASE A ────────────────────────────────────────────────────────
        -- (1) the broad day-1 row: three kinds in one paragraph, which is
        --     what fourteen of the eighteen live ledger rows look like.
        v_w1 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'The journal import cannot be read — no source is connected — the debits do not balance against the credits, and the entries that are visible are dated 2027.',
          null, null, false, 24);
        v_w_task := (v_w1 ->> 'task_id')::uuid;
        -- (2) a NARROWER, GENUINELY DIFFERENT problem: one supplier invoice,
        --     nothing to do with the journal import. {out_of_range} alone is
        --     a strict subset of the row above, so containment folds it.
        v_w2 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'Supplier invoice SI-8891 is dated 2027, outside the period being closed.',
          null, null, false, 24);
        v_w_task2 := (v_w2 ->> 'task_id')::uuid;
        select detail into v_w_detail from human_tasks where id = v_w_task;
        select count(*) into v_w_exc from de_exceptions
         where human_task_id = v_w_task and situation like '%SI-8891%';

        -- ── CASE B ────────────────────────────────────────────────────────
        -- B1: no objective and no work item — so no separator at all. This is
        --     the shape 140 of 189 pending escalations are in, and the shape
        --     in which the first draft merged Grant Plastics with Meridian
        --     Foods. NULL must not match NULL: two rows.
        v_w3 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, null, null,
          'No day-to-day contact is recorded for Grant Plastics Ltd., so nobody can be asked.',
          null, null, false, 24);
        v_cust_t1 := (v_w3 ->> 'task_id')::uuid;
        v_w4 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, null, null,
          'No day-to-day contact is recorded for Meridian Foods, so nobody can be asked.',
          null, null, false, 24);
        v_cust_t2 := (v_w4 ->> 'task_id')::uuid;

        -- B2: the SAME separator, two customers, same blocker kind. Here the
        --     fold is correct by the founder's ruling — one piece of work,
        --     one row — and the test is that BOTH customers stay readable.
        perform public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'No day-to-day contact is recorded for Grant Plastics Ltd. on this account.',
          null, null, false, 24);
        select ht.id into v_f_task from human_tasks ht
         where ht.tenant_id = v_ctl_tenant and ht.de_id = v_c_de and ht.type = 'escalation'
           and ht.status = 'pending' and ht.blocker_signature = array['missing_owner']::text[]
           and ht.blocker_scope is not null
         order by ht.created_at desc, ht.id desc limit 1;
        perform public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'No day-to-day contact is recorded for Meridian Foods on this account.',
          null, null, false, 24);
        select detail into v_cust_detail from human_tasks where id = v_f_task;
        select count(*) into v_cust_exc from de_exceptions
         where human_task_id = v_f_task and situation like '%Meridian Foods%';

        -- ── CASE C ────────────────────────────────────────────────────────
        -- The three facts, raised INDIVIDUALLY against the REAL queue in the
        -- state tomorrow morning's run will meet: PROBE 16 has already armed
        -- blocker_signature/blocker_scope on every pending escalation, and the
        -- broad rows the reviewer found are sitting there. Whatever happens
        -- here is REPORTED, not asserted away.
        select ht.tenant_id, ht.de_id, ht.blocker_scope, count(*)
          into v_live_t, v_live_d, v_live_s, v_live_n
          from human_tasks ht
          join digital_employees de on de.id = ht.de_id
         where ht.type = 'escalation' and ht.source = 'de' and ht.status = 'pending'
           and coalesce(de.is_workforce_assistant, false) = false
           and ht.blocker_scope is not null
           and array_length(ht.blocker_signature, 1) is not null
         group by ht.tenant_id, ht.de_id, ht.blocker_scope
         order by count(*) desc, ht.tenant_id, ht.de_id limit 1;

        -- ⚠ AND IT HAS TO BE RAISED ONTO THAT PILE'S OWN SCOPE, or this case
        -- proves nothing. The writer takes an OBJECTIVE, not a scope string,
        -- and derives the scope from the objective's TITLE — so any objective
        -- carrying that title lands on the same pile. Raising with a null
        -- objective would fail open by construction and the three facts would
        -- trivially get three rows: a case C that could not fail.
        if v_live_t is not null then
          select o.id into v_c_obj2
            from de_objectives o
           where o.tenant_id = v_live_t
             and nullif(btrim(lower(regexp_replace(coalesce(o.title, ''), '\s+', ' ', 'g'))), '') = v_live_s
           order by o.id limit 1;
        end if;
        v_checks := v_checks + 1;
        if v_live_t is not null and v_c_obj2 is null then
          v_bad := array_append(v_bad, format('case C could not find an objective titled %L to raise the three facts onto, so it would have measured them in isolation', v_live_s));
        end if;

        if v_live_t is not null and v_c_obj2 is not null then
          for h in
            select * from (values
              (1, 'The journal entries for this period cannot be read — no source is connected.'),
              (2, 'The books do not balance: debits PKR 322,000 against credits PKR 439,300.'),
              (3, 'Every journal entry in this batch is dated 2027, not the period being closed.')
            ) as t(n, txt)
          loop
            v_w1 := public.open_de_escalation(v_live_t, v_live_d, null, v_c_obj2, null, h.txt, null, null, false, 24);
            v_f_deduped := coalesce((v_w1 ->> 'deduped')::boolean, false);
            v_f_task := (v_w1 ->> 'task_id')::uuid;
            select title, detail into v_f_title, v_f_detail from human_tasks where id = v_f_task;
            v_f_lines := array_append(v_f_lines, format(
              'fact %s -> %s; lands on card %L; its own words present on that card: %s; own exceptions row: %s',
              h.n::text,
              case when v_f_deduped then 'FOLDED into an open card' else 'ITS OWN NEW CARD' end,
              left(coalesce(v_f_title, '(no title)'), 90),
              case when position(btrim(h.txt) in coalesce(v_f_detail, '')) > 0 then 'YES' else 'NO' end,
              (select count(*)::text from de_exceptions
                where human_task_id = v_f_task and situation = h.txt)));
            -- ⚠ THE ONE THING THAT IS ASSERTED, NOT MERELY REPORTED: wherever
            -- the fact landed, its words are on that card and in the ledger.
            v_checks := v_checks + 1;
            if position(btrim(h.txt) in coalesce(v_f_detail, '')) = 0 then
              v_bad := array_append(v_bad, format(
                'live queue, fact %s: the report was %s and its text is NOT on the card it landed on. This is F2/F3 unfixed.',
                h.n::text, case when v_f_deduped then 'folded' else 'given its own row' end));
            end if;
            v_checks := v_checks + 1;
            if (select count(*) from de_exceptions
                 where human_task_id = v_f_task and situation = h.txt) <> 1 then
              v_bad := array_append(v_bad, format(
                'live queue, fact %s: no de_exceptions row carries this report against the task it landed on', h.n::text));
            end if;
          end loop;
        end if;

        -- ── CASE D ────────────────────────────────────────────────────────
        -- ⚠⚠⚠ THE FAIL-OPEN GUARD, DRIVEN — AND THIS CASE EXISTS BECAUSE THE
        -- SOURCE RATCHET FOR IT WAS PROVEN WORTHLESS. PROBE 13 pins the line
        -- `if v_scope is not null and array_length(v_sig, 1) is not null then`
        -- by looking for that exact string in pg_proc. But the pin's own
        -- literal IS that string, so a mutation that rewrites the guard
        -- rewrites the pin with it and the ratchet stays green. Measured, not
        -- feared: deleting the guard and re-running this block gave
        -- "22 of 22 probes, 183 assertions, 0 findings".
        --
        -- And the hole it leaves is not cosmetic. `anyarray @> '{}'` is TRUE
        -- for every array, so with the guard gone an escalation the catalog
        -- cannot classify matches ANY open row sharing its scope — the
        -- unrecognised blocker disappearing behind a recognised one, which is
        -- the worst failure available here because neither row says what it is.
        --
        -- (The scope half of the same guard is structurally safe: `=` against
        -- a NULL v_scope matches nothing whatever the branch does. Case B1
        -- above drives it anyway. It is the SIGNATURE half that needed this.)
        v_w5 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'Please confirm whether to proceed to the next phase.', null, null, false, 24);
        v_d_task1 := (v_w5 ->> 'task_id')::uuid;
        v_w6 := public.open_de_escalation(v_ctl_tenant, v_c_de, null, v_c_obj, null,
          'Please confirm which of the two quotes the client should be sent.', null, null, false, 24);
        v_d_task2 := (v_w6 ->> 'task_id')::uuid;
        select detail into v_d_detail from human_tasks where id = v_d_task2;

        v_probe22_ok := true;
        raise exception using errcode = 'ZZ780', message = 'never-lose-words probe: deliberate rollback';
      exception
        when sqlstate 'ZZ780' then null;
        when others then
          v_bad := array_append(v_bad, format('PROBE 22 (never lose the report) aborted: %s %s', sqlstate, sqlerrm));
      end;

      if v_probe22_ok then
        -- ── CASE A assertions ────────────────────────────────────────────
        v_checks := v_checks + 1;
        if v_c_obj is null then
          v_bad := array_append(v_bad, 'PROBE 22 found no titled objective in the control tenant, so the separator half of every case below compared nothing');
        end if;
        -- The fold itself is EXPECTED — {out_of_range} is a strict subset, and
        -- no test over blocker kinds can tell one invoice from another. What
        -- is not acceptable is the words going missing, so that is the pin.
        v_checks := v_checks + 1;
        if not coalesce((v_w2 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'the narrower report did NOT fold — this case was meant to exercise the fold, so the reachability assertions below proved nothing about a folded report');
        end if;
        v_checks := v_checks + 1;
        if v_w_task2 is distinct from v_w_task then
          v_bad := array_append(v_bad, 'the narrower report opened a different task, so nothing was folded and the reachability assertions below compared nothing');
        end if;
        v_checks := v_checks + 1;
        if position('SI-8891' in coalesce(v_w_detail, '')) = 0 then
          v_bad := array_append(v_bad, format(
            'SI-8891 TEXT PRESENT IN human_tasks.detail -> 0. A narrower new problem was absorbed and its words were destroyed — the finding this round exists to close. detail=%L',
            left(coalesce(v_w_detail, ''), 300)));
        end if;
        v_checks := v_checks + 1;
        if coalesce(v_w_exc, 0) <> 1 then
          v_bad := array_append(v_bad, format('SI-8891 has %s de_exceptions row(s) against the card it was folded into, expected 1', coalesce(v_w_exc, 0)::text));
        end if;
        v_report := array_append(v_report, format(
          'CASE A (SI-8891, narrower new problem): folded=%s; its text on the card it joined: %s; its own exceptions row: %s',
          coalesce((v_w2 ->> 'deduped'), '?'),
          case when position('SI-8891' in coalesce(v_w_detail, '')) > 0 then 'YES' else 'NO' end,
          coalesce(v_w_exc, 0)::text));

        -- ── CASE B assertions ────────────────────────────────────────────
        -- B1: no separator -> two customers, two rows. NULL never matches NULL.
        v_checks := v_checks + 1;
        if coalesce((v_w4 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'two DIFFERENT CUSTOMERS with no separator were merged into one row. NULL is matching NULL again — this is the live-data finding F4, and 140 of 189 pending escalations are in exactly this shape.');
        end if;
        v_checks := v_checks + 1;
        if v_cust_t2 is null or v_cust_t2 = v_cust_t1 then
          v_bad := array_append(v_bad, 'the second customer did not get its own card when no separator could be derived');
        end if;
        -- B2: same separator -> one row, and BOTH customers readable on it.
        v_checks := v_checks + 1;
        if position('Grant Plastics' in coalesce(v_cust_detail, '')) = 0 then
          v_bad := array_append(v_bad, format('Grant Plastics is not readable on the shared card: %L', left(coalesce(v_cust_detail, ''), 300)));
        end if;
        v_checks := v_checks + 1;
        if position('Meridian Foods' in coalesce(v_cust_detail, '')) = 0 then
          v_bad := array_append(v_bad, format(
            'Meridian Foods TEXT PRESENT IN detail -> 0. Two customers share a card and only one of them can be read on it. detail=%L',
            left(coalesce(v_cust_detail, ''), 300)));
        end if;
        v_checks := v_checks + 1;
        if coalesce(v_cust_exc, 0) <> 1 then
          v_bad := array_append(v_bad, format('the second customer has %s de_exceptions row(s) against the shared card, expected 1', coalesce(v_cust_exc, 0)::text));
        end if;
        v_report := array_append(v_report, format(
          'CASE B (two customers): no separator -> %s cards; same separator -> one card carrying both names (Grant Plastics: %s, Meridian Foods: %s)',
          case when v_cust_t2 is distinct from v_cust_t1 then '2' else '1' end,
          case when position('Grant Plastics' in coalesce(v_cust_detail, '')) > 0 then 'readable' else 'MISSING' end,
          case when position('Meridian Foods' in coalesce(v_cust_detail, '')) > 0 then 'readable' else 'MISSING' end));

        -- ── CASE C report ────────────────────────────────────────────────
        -- VACUITY GUARD: no live pile means the three facts were raised into
        -- an empty queue, where everything trivially gets its own row.
        v_checks := v_checks + 1;
        if v_live_t is null or coalesce(v_live_n, 0) < 2 then
          v_bad := array_append(v_bad, format(
            'the live queue offered no armed pile of 2 or more to raise the three ledger facts against (%s row(s)), so case C measured them in isolation — which is exactly the mistake the reviewer caught.',
            coalesce(v_live_n, 0)::text));
        end if;
        v_checks := v_checks + 1;
        if coalesce(array_length(v_f_lines, 1), 0) <> 3 then
          v_bad := array_append(v_bad, format('case C raised %s of 3 facts against the live queue', coalesce(array_length(v_f_lines, 1), 0)::text));
        end if;
        v_report := array_append(v_report, format(
          'CASE C (three ledger facts vs the REAL armed queue, biggest pile = %s row(s)):', coalesce(v_live_n, 0)::text));
        v_report := array_cat(v_report, v_f_lines);

        -- ── CASE D assertions ────────────────────────────────────────────
        -- VACUITY FIRST: these two reasons must genuinely classify to nothing,
        -- or "an unclassifiable blocker keeps its own row" is a sentence about
        -- two rows that were classifiable all along.
        v_checks := v_checks + 1;
        if public.de_blocker_signature('Please confirm whether to proceed to the next phase.') <> '{}'::text[]
           or public.de_blocker_signature('Please confirm which of the two quotes the client should be sent.') <> '{}'::text[] then
          v_bad := array_append(v_bad, 'case D''s fixtures are no longer unclassifiable, so the fail-open drive below tested the wrong thing');
        end if;
        v_checks := v_checks + 1;
        if coalesce((v_w5 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'an UNCLASSIFIABLE escalation folded into an open row. `anyarray @> ''{}''` is true for every array, so with the fail-open guard gone a blocker nobody can name disappears behind one somebody can — and neither row then says what it is.');
        end if;
        v_checks := v_checks + 1;
        if coalesce((v_w6 ->> 'deduped')::boolean, false) then
          v_bad := array_append(v_bad, 'a second UNCLASSIFIABLE escalation folded into an open row — the fail-open guard on the signature is gone');
        end if;
        v_checks := v_checks + 1;
        if v_d_task1 is null or v_d_task2 is null or v_d_task1 = v_d_task2 then
          v_bad := array_append(v_bad, 'two different unclassifiable blockers share one card — the guard is matching on the empty set');
        end if;
        v_checks := v_checks + 1;
        if position('which of the two quotes' in coalesce(v_d_detail, '')) = 0 then
          v_bad := array_append(v_bad, format('the second unclassifiable report is not readable on its own card: %L', left(coalesce(v_d_detail, ''), 200)));
        end if;
        v_report := array_append(v_report, format(
          'CASE D (fail open on an unclassifiable blocker): folded=%s / %s — each keeps its own card',
          coalesce((v_w5 ->> 'deduped'), '?'), coalesce((v_w6 ->> 'deduped'), '?')));
        v_probes_ok := v_probes_ok + 1;
      end if;
    end if;
  exception when others then
    v_bad := array_append(v_bad, format('PROBE 22 (never lose the report) could not run: %s %s', sqlstate, sqlerrm));
  end;

  ------------------------------------------------------------------------
  -- THE FLOOR. Zero findings from zero comparisons looks exactly like a
  -- clean result, so the denominators are ASSERTED, not merely printed.
  ------------------------------------------------------------------------
  if v_probes_ok <> v_probes_try then
    v_bad := array_append(v_bad, format(
      'only %s of %s probes completed. A probe that cannot run is a failure, never a skip — its assertions compared nothing this run.',
      v_probes_ok::text, v_probes_try::text));
  end if;
  -- ⚠ RATCHETED 80 -> 165 when the dedupe guard was replaced. The block was
  -- measuring 150 against a floor of 80, which is a floor that could have been
  -- halved without anyone noticing; it measures 183 now. 165 keeps ~18 of
  -- slack for corpus variation while still being a number a collapse cannot
  -- slip under.
  if v_checks < 165 then
    v_bad := array_append(v_bad, format(
      'only %s assertion(s) were evaluated; this block carries at least 165. A collapse means branches were skipped rather than run.',
      v_checks::text));
  end if;

  create temp table if not exists _778_report (k text, v text);
  delete from _778_report;
  insert into _778_report (k, v)
  values ('note', format('probes_completed=%s probes_attempted=%s assertions=%s findings=%s',
                         v_probes_ok::text, v_probes_try::text, v_checks::text,
                         coalesce(array_length(v_bad, 1), 0)::text));
  insert into _778_report (k, v)
  values ('rewritten', format('%s titles rewritten (arm A=%s, arm B=%s) — per tenant: %s',
                              coalesce(v_n1, 0)::text, coalesce(v_arm_a, 0)::text, coalesce(v_arm_b, 0)::text, coalesce(v_pred_break, '(none)')));
  insert into _778_report (k, v)
  values ('dedupe', format('live replay: %s pending escalation(s) would occupy %s row(s) under this guard — %s under the REJECTED rule where a missing separator matched another missing separator, and the gap is the merges that rule made across work it could not name; biggest pile %s -> %s. Every folded report keeps its own de_exceptions row and its text is appended to the card it joined.',
                           coalesce(v_sim_raised, 0)::text, coalesce(v_sim_open, 0)::text,
                           coalesce(v_sim_open_noscope, 0)::text, coalesce(v_big_raised, 0)::text, coalesce(v_big_open, 0)::text));
  insert into _778_report (k, v) select 'report',  u from unnest(v_report) u;
  insert into _778_report (k, v) select 'finding', u from unnest(v_bad) u;
  insert into _778_report (k, v)
  select 'sample', format('%s  ->  %s', t.old_title, t.new_title)
    from _778_targets t order by t.new_title limit 10;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '778: % of % assertion(s) failed across % of % probes: %',
      array_length(v_bad, 1), v_checks, v_probes_ok, v_probes_try, array_to_string(v_bad, ' | ');
  end if;

  raise notice '778: CLEAN — % of % probes completed, % assertion(s) compared, 0 findings. % title(s) rewritten [%].',
    v_probes_ok, v_probes_try, v_checks, v_n1, v_pred_break;
end
$verify$;

drop view if exists _778_generic;

-- ── 8. THE DISCLOSURE ────────────────────────────────────────────────────
-- ⚠ THIS SELECT IS THE DISCLOSURE, not the notices above. scripts/db-query.mjs
-- posts this file to the Management API's /database/query endpoint, which
-- returns the ROWS of the last statement and throws NOTICE traffic away —
-- proven with a canary that never came back. So the counts this migration
-- committed to are placed where the person running it will actually read
-- them: in the command's own output.
select k as what, v as detail
  from _778_report
 order by case k when 'note' then 0 when 'rewritten' then 1 when 'dedupe' then 2
                 when 'report' then 3 when 'finding' then 4 else 5 end, v;

commit;
