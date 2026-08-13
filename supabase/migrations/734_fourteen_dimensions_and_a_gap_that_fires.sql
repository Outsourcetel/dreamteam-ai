-- 734_fourteen_dimensions_and_a_gap_that_fires.sql
-- ==========================================================================
-- WHY: round-1 review of 733 came back spec-fail — mechanics clean, every
-- defect in the authored content. Three Criticals, four Importants, two
-- founder rulings that change the design. 733 is already applied and stays
-- untouched; this migration corrects it forward.
--
-- FOUNDER RULING A — the capability-gap view was unreachable BY CONSTRUCTION,
-- and the proof is airtight: 733's verification block raised if ANY
-- dimension named ANY missing archetype, while the view only fired if ALL of
-- a dimension's archetypes were missing. "all missing" is a subset of "any
-- missing", so every row that would make the view fire was exactly a row the
-- migration refused to ever commit. "gaps -> []" in the Task 1 report was
-- reported as a clean result when it was actually a checker that could not
-- fail — the class of defect this repo has now hit five times.
--
-- Fixed by a founder-specified escape hatch: a dimension may name a role we
-- have not built yet, using a `planned_` prefix (planned_procurement,
-- planned_legal, planned_qa). The orphan check exempts that prefix — a
-- genuine typo on a real key is still refused — and the gap view now reports
-- any dimension carrying a planned_ role, together with a canonical
-- customer-facing message ("we don't have a ready-made X yet; we'll build
-- one around what you've described") computed IN THE VIEW so every surface
-- that reads it says the same thing. The per-tenant "a real customer asked
-- for this" demand signal needs interview SESSIONS, which do not exist
-- until Task 2 — deliberately not faked here.
--
-- FOUNDER RULING B — twelve was short two dimensions, both proven from the
-- product's own corpus: "the workforce itself" (hiring, payroll, rotas,
-- shifts, PTO — after_the_sale is CUSTOMER onboarding, who_is_who is a
-- contact map, neither covers running your own staff), and "how the work
-- gets delivered" (dispatch, scheduling, fulfilment, inventory, production —
-- front_desk.routing's own help text says "service requests -> dispatch",
-- and no dimension ever picks that thread up). Both are also where
-- planned_procurement and planned_legal naturally live: this product has no
-- archetype for either today.
--
-- CRITICAL 2 — money_out contradicted the spec, which says it produces
-- "accounting / FP&A roles, approval limits". 733 mapped it to ad-spend caps
-- only ({google_ads, marketing}) and excluded accounting entirely, despite
-- accounting.reconciliations' own help text reading "e.g. bank, AR, AP --
-- monthly" (AP IS money leaving the business). It also missed the only
-- buy-side question in all 93: renewal_manager.party_scope offers "Vendor
-- (buy-side)" against the question "...customer renewals, vendor/supplier
-- renewals, or both?". Re-derived as the buy-side mirror of money_in:
-- {accounting, fpa, renewal_manager}.
--
-- CRITICAL 3 — who_signs_off and must_never_happen closed on silence.
-- "Mark heard once every threshold YOU HAVE HEARD has a value and an
-- approver" is true when nothing was heard at all -- a universal claim over
-- an empty set. The spec says these are exactly the two topics a customer
-- never volunteers, so on a sidetracked transcript they would have
-- self-closed for free, which is the founder's stated fear for the whole
-- spine. Both rewritten so the bar is "something was actually captured", not
-- "whatever was captured is well-formed".
--
-- IMPORTANT — 733's own derivation method was backwards. Its self-imposed
-- rule "every one of the 15 archetypes appears somewhere" GUARANTEES zero
-- gaps; optimising for full catalogue coverage is the cause of the
-- unreachable view, not a virtue alongside it. Dropped. Re-derived by
-- MEANING: systems_of_record widened from the 4 archetypes that spell the
-- field identically to the ~13 that ask the same question under a different
-- key (ledger_system, billing_system, target_system, systems, cms,
-- data_sources, ad_accounts, ...); what_we_do now produces vocabulary and
-- pipeline stages, not roles, per spec row 1; winning_business regained
-- seo/social_media (spec row 5); repetitive_work regained
-- renewal_manager.cadence alongside billing_ar.cadence (same field shape,
-- both missed).
--
-- ALSO: the `required` column was dead (nothing ever read it) -- dropped
-- rather than left to rot. The view gets the same belt-and-braces revoke the
-- table already had. The seed is now a real upsert (ON CONFLICT ... DO
-- UPDATE) so re-running this migration is idempotent, matching what
-- `create table if not exists` already implied for 733.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Dead column. Nothing in the codebase reads `required` — use it or drop it,
-- and there is nothing to use it for yet.
-- ---------------------------------------------------------------------------
alter table public.discovery_dimensions drop column if exists required;

-- ---------------------------------------------------------------------------
-- Ordinals are being reshuffled (12 -> 14 dimensions, two new ones inserted
-- mid-sequence). A single multi-row upsert does not guarantee an order where
-- no two rows transiently collide on the UNIQUE(ordinal) index while it
-- still exists. Drop it, upsert, re-add — the re-add is itself a real check:
-- it fails loudly over the FULL resulting table if the renumbering below has
-- a bug, rather than trusting the arithmetic.
-- ---------------------------------------------------------------------------
alter table public.discovery_dimensions drop constraint discovery_dimensions_ordinal_unique;

-- ---------------------------------------------------------------------------
-- The fourteen dimensions. ON CONFLICT (key) DO UPDATE: every row here is
-- the full, current definition, not a diff against 733 — this migration is
-- self-contained and idempotent to re-run.
-- ---------------------------------------------------------------------------
insert into public.discovery_dimensions
  (key, ordinal, title, guidance, serves_archetypes, produces) values

('what_we_do', 1, 'What the business does',
 'Get a plain-English account of what this business actually is and does — the industry, the '
 || 'product or service, who it serves, and the rough shape of how a unit of work moves through '
 || 'it end to end. Concrete beats abstract: "a two-location dental practice — patients book, '
 || 'get treated, get billed" is covered; "we help customers" is not. This is not itself a '
 || 'staffing decision — it produces the shared vocabulary and the outline of the operating '
 || 'pipeline that every later dimension in this interview gets read against, so capture the '
 || 'actual words this business uses for its own stages and its own customers, rather than '
 || 'generic ones. Mark heard only once you could describe both the business and the shape of '
 || 'its work to a stranger in one sentence each.',
 array[]::text[],
 array['business-vocabulary glossary','operating-pipeline stage list']),

('how_customers_reach_us', 2, 'How customers reach us',
 'Find every channel a customer, prospect or employee actually uses to make contact today, and '
 || 'what happens on each one — phone, email, a chat widget, a booking link, walk-ins, social '
 || 'messages, or organic search landing on the website. "They call and email; calls go to the '
 || 'front desk, email sits in a shared inbox" is covered; "we are reachable" is not. Note which '
 || 'channel is busiest and which is neglected, since that gap is often the real problem. Mark '
 || 'heard only once you can say, for every channel in use, where a message lands and who '
 || 'currently sees it.',
 array['front_desk','support_agent','it_helpdesk'],
 array['channel inventory','front-desk routing rules','intake-capture checklist']),

('money_in', 3, 'How money comes in',
 'Find out how this business actually gets paid, end to end: what it bills for, on what '
 || 'cadence, and through which system. Concrete beats abstract — "we invoice monthly out of '
 || 'Xero, net 30" is covered; "we have customers" is not. Cover what happens when an invoice '
 || 'goes unpaid, and who chases it today. If they mention subscriptions or renewals, that '
 || 'counts here too. Mark heard only when you could tell a colleague how the money arrives.',
 array['billing_ar','accounting','renewal_manager'],
 array['billing_ar role','collections role','overdue-invoice procedure','billing connector']),

('money_out', 4, 'Where money goes out',
 'Find out where money leaves the business and who watches it: accounts payable and vendor '
 || 'bills — the AP side of the same ledger that tracks what comes in — recurring vendor or '
 || 'supplier contracts due for renewal, and the spend thresholds that require sign-off before a '
 || 'payment goes out. "AP is reconciled monthly alongside the bank and AR; journal entries over '
 || 'ten thousand dollars need a second approver; the software vendor contracts renew every '
 || 'March and Finance reviews them before they auto-renew" is covered; "we have a budget" is '
 || 'not. This is the buy-side mirror of money_in — a business is a vendor to somebody just as '
 || 'often as it has vendors of its own. Mark heard only once you know what recurring outflow '
 || 'exists, who reconciles it, and what stops an increase from going through unnoticed.',
 array['accounting','fpa','renewal_manager'],
 array['accounts-payable role','FP&A budget-oversight role','spend approval-limit table','vendor-renewal tracking']),

('winning_business', 5, 'How we win business',
 'Learn how this business actually gets its next customer: which accounts, segments or search '
 || 'terms it goes after, through which paid, organic and social channels, and what makes a lead '
 || 'worth pursuing rather than a waste of time. "We run outbound email and LinkedIn at '
 || 'mid-market manufacturers, plus a website that ranks for our category and an Instagram '
 || 'account for brand reach; qualified means budget plus an active project" is covered; "we do '
 || 'sales" is not. Cover every channel that brings in a new customer, not only the ones with a '
 || 'person dialling a phone — organic search and social presence count exactly as much as '
 || 'outbound. Mark heard only once the criteria are specific enough that a new hire could use '
 || 'them to recognize a real opportunity, across every channel actually in use.',
 array['sdr','bdr','marketing','google_ads','seo','social_media'],
 array['sdr role','bdr role','qualification criteria','seo/content role','social-media role']),

('after_the_sale', 6, 'What happens after the sale',
 'Find out what happens the moment a deal closes: who sets the customer up in which system, who '
 || 'signs off that they are live, and who owns the relationship afterward — health checks, '
 || 'renewals, signs of risk. "Our onboarding lead configures the product from the signup form, '
 || 'and the account owner watches usage and support tickets for renewal risk starting ninety '
 || 'days out" is covered; "we onboard them" is not. Cover what must never be changed without a '
 || 'person checking first. Mark heard only once you know who owns the customer at every stage '
 || 'from go-live to renewal.',
 array['onboarding','cs_manager','renewal_manager'],
 array['onboarding role','customer-success role','renewal-manager role','at-risk-renewal signal set']),

('how_work_gets_delivered', 7, 'How the work gets delivered',
 'Find out how the actual work gets done once it is agreed to, not just how it gets sold: '
 || 'dispatch, job scheduling, fulfilment, inventory and production. "Service requests get '
 || 'routed to dispatch, who schedules a technician and books parts against the van stock; we '
 || 'reorder a part once inventory drops below five" is covered; "we handle it" is not. This is '
 || 'where a trades, field-service or production business spends most of a real conversation, '
 || 'and today it has no home anywhere else in this spine — a request may get routed here by '
 || 'whoever answers the phone, but the actual scheduling, sourcing and completion of the work '
 || 'belongs to this dimension alone. Mark heard only once you know who schedules the work, what '
 || 'triggers a reorder or a production run, and what "done" looks like before it is billed.',
 array['front_desk','planned_procurement','planned_qa'],
 array['dispatch/scheduling procedure','inventory-reorder rule','production-handoff checklist']),

('repetitive_work', 8, 'The repetitive work',
 'Find the tasks that happen on a fixed, recurring schedule no matter who is busy — the monthly '
 || 'close and its reconciliations, a forecast cycle, a dunning sequence, a renewal cycle that '
 || 'starts counting down from a fixed number of days out, a report that goes to the same people '
 || 'every time. "We close in five business days and reconcile bank and AR monthly; dunning '
 || 'reminders go out at day zero, seven and fourteen; renewals start ninety days before the '
 || 'contract ends" is covered; "we stay busy" is not. These are the tasks most worth automating '
 || 'precisely because they repeat identically. Mark heard only once you can name the cadence, '
 || 'the deadline, and who currently does it by hand.',
 array['accounting','fpa','billing_ar','renewal_manager'],
 array['close-cadence checklist','recurring-report schedule','dunning-cadence procedure','renewal-cadence procedure']),

('systems_of_record', 9, 'Where the record lives',
 'Name the actual system each function runs in — general ledger, billing platform, CRM, help '
 || 'desk, the product being configured for a customer, a CMS, ad or social accounts, a planning '
 || 'spreadsheet — a product, not a category. "Leads and opportunities live in HubSpot; the '
 || 'ledger is in Xero; tickets are in Zendesk" is covered; "we use software for that" is not. '
 || 'Nearly every role this platform can staff asks a version of this question under a different '
 || 'name — ledger_system, billing_system, target_system, systems, cms, data_sources, ad_accounts '
 || '— because every connector this platform will ever build depends on the same fact: which '
 || 'system holds the truth for that function. Mark heard only once every function discussed so '
 || 'far has a named system attached, or an honest admission that nothing holds it yet.',
 array['bdr','sdr','cs_manager','renewal_manager','accounting','billing_ar','onboarding','support_agent','it_helpdesk','seo','fpa','google_ads','social_media'],
 array['systems-of-record map','connector shortlist','integration checklist']),

('the_workforce_itself', 10, 'The workforce itself',
 'Find out how this business runs its own people, separate from how it runs customers: hiring, '
 || 'payroll, rotas or shift schedules, and time off. "We run payroll through Gusto biweekly; '
 || 'the manager builds the roster a week ahead in a shared spreadsheet; PTO requests go through '
 || 'the same manager" is covered; "HR handles that" is not. Nothing in this product today '
 || 'configures a role around this topic — it sits closer to compliance and employment law than '
 || 'to any customer-facing function, so name what exists even though there is no ready-made '
 || 'role for it yet. Mark heard only once you know how staff are paid, scheduled and given time '
 || 'off, and who currently manages each of those by hand.',
 array['planned_legal'],
 array['workforce profile','rota/shift procedure','payroll-cadence note']),

('must_never_happen', 11, 'What must never happen',
 'Capture the hard lines — actions or statements that must never happen no matter how routine '
 || 'the request sounds: bypassing a control, promising a refund, sharing account details before '
 || 'an identity check, claiming a certification with no evidence behind it, discussing anything '
 || 'legal or safety-related without a person. "Never bypass the period-close cutoff" and "never '
 || 'claim ISO certification unless the certificate is on file" are covered; "be careful" is '
 || 'not. Nobody volunteers a prohibition unprompted — it only surfaces when something adjacent '
 || 'reminds them — so a quiet conversation and a business with no hard lines look identical '
 || 'unless you push. Silence is not coverage: this dimension counts as heard only once at least '
 || 'one specific, nameable prohibition has actually been captured, not merely once whatever was '
 || 'captured (if anything) reads as unambiguous. If none has surfaced by the time the interview '
 || 'is closing, ask directly rather than moving on.',
 array[]::text[],
 array['guardrail rule set','prohibited-claim list']),

('who_signs_off', 12, 'Who signs off',
 'Find the actual dollar thresholds and approval chains that gate action — not a vague sense of '
 || 'seniority, but a number and a named approver. "Journal entries over ten thousand dollars '
 || 'need a second approver; discounts above five percent need Finance" is covered; "we are '
 || 'careful with money" is not. This question recurs almost verbatim across nearly every role '
 || 'this platform can staff — accounting, sales, renewals, ad spend — because every one of them '
 || 'eventually asks a person to approve something. It is also the dimension a rushed '
 || 'conversation skips silently, because nobody volunteers a threshold unprompted. Silence is '
 || 'not coverage: this dimension counts as heard only once at least one concrete '
 || 'number-and-approver pair has actually been named out loud, not merely once whatever was '
 || 'said (if anything) turned out to be well-formed. If the interview is ending and none has '
 || 'surfaced, ask directly before closing it.',
 array[]::text[],
 array['approval-threshold table','sign-off chain']),

('who_is_who', 13, 'Who is who',
 'Build the map of actual people and their roles: who owns which kind of enquiry, who gets an '
 || 'escalation, who owns an account, who has the final say. "New sales go to Ali, billing goes '
 || 'to Accounts, emergencies go to the owner directly" is covered; "the team handles it" is '
 || 'not. This is distinct from approval thresholds: it is about identity, not a dollar figure, '
 || 'and it is what makes an escalation land on an actual inbox instead of nowhere. Mark heard '
 || 'only once every named responsibility discussed so far has a real person or title attached '
 || 'to it.',
 array[]::text[],
 array['escalation-routing table','org-contact map']),

('what_good_looks_like', 14, 'What good looks like',
 'Find out how this business actually judges a job well done — the tone it wants, the metrics '
 || 'leadership watches, and the quality bar for anything customer-facing. "Warm and concise, '
 || 'never over-apologise, cost per lead under eighty dollars, retention and expansion are what '
 || 'leadership actually reviews" is covered; "good service" is not. Without this, a digital '
 || 'employee has no way to tell a strong outcome from a weak one that simply did not error '
 || 'out. Mark heard only once at least one concrete metric or standard exists for each area of '
 || 'work already discussed.',
 array[]::text[],
 array['success-metric list','tone-and-quality standard'])

on conflict (key) do update set
  ordinal           = excluded.ordinal,
  title             = excluded.title,
  guidance          = excluded.guidance,
  serves_archetypes = excluded.serves_archetypes,
  produces          = excluded.produces;

-- Re-add the constraint: fails loudly, over the full table, if the
-- renumbering above left a collision — a real check, not a trusted diff.
alter table public.discovery_dimensions add constraint discovery_dimensions_ordinal_unique unique (ordinal);

-- ---------------------------------------------------------------------------
-- The gap view. A dimension is a capability gap if it carries ANY
-- planned_-prefixed archetype — the orphan check below explicitly allows
-- that prefix, so this is the only way for a "missing archetype" to survive
-- into committed data, which is what makes the view reachable at all.
--
-- customer_message is computed HERE, once, so every surface that reads this
-- view — UI, ops dashboard, whatever comes next — says the identical thing.
-- planned_archetypes is also returned so a caller can act on the raw keys.
-- ---------------------------------------------------------------------------
create or replace view public.discovery_capability_gaps as
  select
    d.key as dimension_key,
    d.title,
    d.serves_archetypes,
    gaps.planned_archetypes,
    'We do not have a ready-made ' || array_to_string(gaps.planned_labels, ' / ')
      || ' capability yet — we will build one around what you have described.' as customer_message
    from public.discovery_dimensions d
    cross join lateral (
      select
        array_agg(a order by a) as planned_archetypes,
        array_agg(
          case when regexp_replace(a, '^planned_', '') = 'qa' then 'QA'
               else regexp_replace(a, '^planned_', '')
          end order by a
        ) as planned_labels
        from unnest(d.serves_archetypes) a
       where a ~ '^planned_'
    ) gaps
   where d.active
     and gaps.planned_archetypes is not null;

revoke all on public.discovery_capability_gaps from public, anon;
revoke insert, update, delete on public.discovery_capability_gaps from authenticated;
grant select on public.discovery_capability_gaps to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification. Each check fails for a specific, distinct reason. The
-- headline fix from round 1 gets checked TWICE, two independent ways: once
-- directly against the real committed spine (v_real_gaps — this is the check
-- 733 never had, and its absence is why "gaps -> []" read as clean when it
-- was actually unreachable), and once via a rolled-back probe proving the
-- view discriminates rather than matching everything or nothing.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_min int; v_max int; v_thin int; v_orphan int; v_real_gaps int;
begin
  select count(*), min(ordinal), max(ordinal) into v_n, v_min, v_max
    from public.discovery_dimensions where active;
  if v_n <> 14 then raise exception '734: expected 14 active dimensions, found %', v_n; end if;
  -- 14 distinct ordinals (enforced by the UNIQUE constraint re-added above)
  -- with min=1 and max=14 can only be the contiguous run 1..14.
  if v_min <> 1 or v_max <> 14 then
    raise exception '734: ordinals are not a contiguous 1..14 run (min %, max %)', v_min, v_max;
  end if;

  select count(*) into v_thin from public.discovery_dimensions
   where active and length(coalesce(guidance,'')) < 120;
  if v_thin > 0 then raise exception '734: % dimension(s) have guidance too thin to act on', v_thin; end if;

  -- planned_-prefixed archetypes are the one exemption (founder ruling A): a
  -- dimension may name a role we know we do not have yet. A genuine typo on
  -- a REAL key must still be refused.
  select count(*) into v_orphan
    from public.discovery_dimensions d
    cross join lateral unnest(d.serves_archetypes) a
   where d.active and a !~ '^planned_'
     and not exists (select 1 from public.role_archetypes r where r.key = a);
  if v_orphan > 0 then
    raise exception '734: % dimension→archetype reference(s) point at nothing and are not planned_', v_orphan;
  end if;

  -- THE headline fix. 733's view could only fire when EVERY archetype named
  -- by a dimension was missing, and the orphan check above refused exactly
  -- that state from ever being committed — unreachable by construction, and
  -- nothing in that migration's own verification checked the view actually
  -- returned a row. Checked here directly, against the real, committed
  -- fourteen — not a probe that gets undone before commit.
  select count(*) into v_real_gaps from public.discovery_capability_gaps;
  if v_real_gaps = 0 then
    raise exception '734: the capability-gap view reports zero gaps on the REAL committed spine — still unreachable';
  end if;

  -- Second, independent proof: the view must discriminate, not match
  -- everything or nothing. Insert, measure into variables, then
  -- unconditionally raise a sentinel to undo the insert — verdicts are read
  -- from the variables AFTER the block, never from inside it.
  declare v_seen boolean := null; v_real boolean := null;
  begin
    begin
      insert into public.discovery_dimensions (key, ordinal, title, guidance, serves_archetypes, produces)
      values ('__probe_gap',  9998, 'probe', repeat('x', 130), array['planned_test_probe'], array['nothing']),
             ('__probe_real', 9999, 'probe', repeat('x', 130), array['support_agent'],       array['nothing']);

      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_gap')  into v_seen;
      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_real') into v_real;

      raise exception using errcode = 'P0001', message = '__undo_probe__';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> '__undo_probe__' then raise; end if;   -- a real P0001 still propagates
    end;

    if v_seen is not true then
      raise exception '734: the gap view did NOT report a dimension carrying a planned_ archetype';
    end if;
    if v_real is not false then
      raise exception '734: the gap view reported a dimension with only real archetypes — not discriminating';
    end if;
  end;
end $$;

commit;
