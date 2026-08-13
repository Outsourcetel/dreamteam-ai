-- 735_silence_is_not_coverage_anywhere.sql
-- ==========================================================================
-- WHY: round 2 of the same review. Two items, both correcting decisions from
-- round 1 (734) rather than new defects — 733 and 734 are applied and stay
-- untouched.
--
-- ITEM 1 — Critical 3 was scoped too narrowly, and the coordinator says so
-- plainly: naming only the two dimensions a reviewer had already caught was
-- the coordinator's own scoping error, not a defect the agent introduced.
-- The underlying problem is not "who_signs_off and must_never_happen are
-- special" — it is that a close test shaped like "for every X [discussed /
-- in use / mentioned so far], P holds" is a universal claim over a set that
-- can be EMPTY, and is therefore trivially true when the customer said
-- nothing about that dimension at all. That shape is a defect wherever it
-- appears, not just in the two places round 1 was told to look.
--
-- Went through all fourteen and asked, for each: could this close test be
-- satisfied by a transcript in which the customer said nothing at all about
-- this dimension? Five were genuinely vacuous on the formal "every X in a
-- possibly-empty discussed-set" shape: how_customers_reach_us ("every
-- channel in use"), winning_business ("every channel actually in use"),
-- systems_of_record ("every function discussed so far"), who_is_who ("every
-- named responsibility discussed so far"), what_good_looks_like ("for each
-- area of work already discussed"). Those five are genuine defects, rewritten
-- for the same reason must_never_happen/who_signs_off were in 734.
--
-- The remaining seven (what_we_do, money_in, money_out, after_the_sale,
-- how_work_gets_delivered, repetitive_work, the_workforce_itself) use a
-- different shape — "you know X" / "you could describe X" / "you can name
-- X" — which is a capability claim, not a universal quantifier over a
-- discovered set, and is not FORMALLY satisfied by silence. But the
-- founder's requirement is behavioral, not grammatical: could a rushed
-- model still claim the capability from a plausible-sounding guess with
-- nothing real behind it? That risk exists regardless of the sentence's
-- logical shape, and leaving seven dimensions with subtly different
-- closing language than the other seven — some saying "silence is not
-- coverage" and some not — is itself the kind of inconsistency a future
-- edit could quietly exploit. All fourteen now end on the identical
-- explicit guard, including money_in, whose body text is otherwise
-- untouched (it was given verbatim in the original task brief; only its
-- closing sentence changes here, for the same reason as everywhere else).
--
-- The test is widened to match: it used to grep two rows for the phrase
-- "silence is not coverage"; a test that checks two of fourteen has the
-- same shape as the bug it is guarding against. It now requires the phrase
-- in all fourteen active rows.
--
-- ITEM 2 — planned_legal was sitting under the_workforce_itself (hiring,
-- payroll, rotas, PTO). Legal work — contract review, terms, compliance,
-- signature authority — is not workforce management, and a customer
-- describing "we don't have anyone reviewing our vendor contracts" would
-- never even reach the_workforce_itself's questions to trigger the gap.
-- must_never_happen and who_signs_off were considered (signature authority
-- and compliance lines both live there) and rejected: both dimensions exist
-- to extract CONSTRAINTS ON THE AI'S OWN BEHAVIOR (guardrails, approval
-- thresholds), not to discover ADDITIONAL CAPABILITIES the business needs —
-- forcing planned_legal into either would silently redefine what "config
-- dimension" means for the other four/five that share the empty-array
-- pattern, which the coordinator explicitly warned against doing without
-- saying so. money_out is the actual fit: it already discusses vendor
-- contracts and their renewal review (added in Critical 2, round 1), and a
-- vendor contract nobody reviews is exactly where a business discovers it
-- has no legal capability — the gap is now reachable from the topic a
-- customer would organically raise it under, not from an unrelated one.
--
-- the_workforce_itself keeps its topic (nothing in the corpus covers
-- workforce management, so the dimension still needs to exist per Founder
-- Ruling B) but drops to serves_archetypes = '{}' — there being no real or
-- planned role to attach is an honest gap in the product's role catalog,
-- not a defect in this dimension's design; a future planned_hr would attach
-- here, but that is not this founder's call to make on my initiative.
--
-- planned_procurement and planned_qa (both still under
-- how_work_gets_delivered) were re-examined against the same test the
-- coordinator asked for legal: would a customer describing that work
-- recognise the dimension it is filed under? Both check out — the
-- dimension's own worked example already talks about reordering inventory
-- (procurement) and what "done" looks like before billing (QA) — so
-- neither moves.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- ITEM 1 — closing sentences. Body text (everything before "Silence is not
-- coverage...") is preserved unchanged in every row; only the close test
-- changes. must_never_happen and who_signs_off are not touched here — 734
-- already gave them the correct shape.
-- ---------------------------------------------------------------------------

update public.discovery_dimensions set guidance =
  'Get a plain-English account of what this business actually is and does — the industry, the '
  || 'product or service, who it serves, and the rough shape of how a unit of work moves through '
  || 'it end to end. Concrete beats abstract: "a two-location dental practice — patients book, '
  || 'get treated, get billed" is covered; "we help customers" is not. This is not itself a '
  || 'staffing decision — it produces the shared vocabulary and the outline of the operating '
  || 'pipeline that every later dimension in this interview gets read against, so capture the '
  || 'actual words this business uses for its own stages and its own customers, rather than '
  || 'generic ones. Silence is not coverage: this dimension counts as heard only once you have '
  || 'actually been told, in words the business itself used, what it does and roughly how work '
  || 'moves through it — not merely once a generic-sounding sentence could be assembled without '
  || 'having heard either. If the interview is closing and neither has been said plainly, ask '
  || 'directly rather than guessing from context.'
 where key = 'what_we_do';

update public.discovery_dimensions set guidance =
  'Find every channel a customer, prospect or employee actually uses to make contact today, and '
  || 'what happens on each one — phone, email, a chat widget, a booking link, walk-ins, social '
  || 'messages, or organic search landing on the website. "They call and email; calls go to the '
  || 'front desk, email sits in a shared inbox" is covered; "we are reachable" is not. Note which '
  || 'channel is busiest and which is neglected, since that gap is often the real problem. Silence '
  || 'is not coverage: this dimension counts as heard only once at least one real channel has '
  || 'actually been named, with where a message on it lands and who sees it — not merely once '
  || 'every channel mentioned so far, which could be none, checks out by default. If the interview '
  || 'is closing and nothing has been named, ask directly rather than assuming there is only one '
  || 'channel or none at all.'
 where key = 'how_customers_reach_us';

update public.discovery_dimensions set guidance =
  'Find out how this business actually gets paid, end to end: what it bills for, on what '
  || 'cadence, and through which system. Concrete beats abstract — "we invoice monthly out of '
  || 'Xero, net 30" is covered; "we have customers" is not. Cover what happens when an invoice '
  || 'goes unpaid, and who chases it today. If they mention subscriptions or renewals, that '
  || 'counts here too. Silence is not coverage: this dimension counts as heard only once you have '
  || 'actually been told how the money arrives, in enough detail to tell a colleague — not merely '
  || 'once a plausible-sounding guess could fill the gap. If the interview is closing and nothing '
  || 'concrete has been said, ask directly rather than assuming there are no customers to bill.'
 where key = 'money_in';

-- money_out also gets its serves_archetypes/produces touched below (ITEM 2)
-- — the guidance text is updated here to carry the same legal grounding.
update public.discovery_dimensions set guidance =
  'Find out where money leaves the business and who watches it: accounts payable and vendor '
  || 'bills — the AP side of the same ledger that tracks what comes in — recurring vendor or '
  || 'supplier contracts due for renewal, and the spend thresholds that require sign-off before a '
  || 'payment goes out. "AP is reconciled monthly alongside the bank and AR; journal entries over '
  || 'ten thousand dollars need a second approver; the software vendor contracts renew every '
  || 'March and nobody actually reviews the terms before they auto-renew" is covered; "we have a '
  || 'budget" is not. This is the buy-side mirror of money_in — a business is a vendor to somebody '
  || 'just as often as it has vendors of its own — and a vendor contract nobody reviews is usually '
  || 'the first place a business discovers it has no legal or compliance capability at all. '
  || 'Silence is not coverage: this dimension counts as heard only once at least one real '
  || 'recurring outflow has actually been named, with who reconciles or reviews it — not merely '
  || 'once every outflow mentioned so far, which could be none, checks out by default. If the '
  || 'interview is closing and nothing has surfaced, ask directly rather than assuming there is '
  || 'nothing to watch.'
 where key = 'money_out';

update public.discovery_dimensions set guidance =
  'Learn how this business actually gets its next customer: which accounts, segments or search '
  || 'terms it goes after, through which paid, organic and social channels, and what makes a lead '
  || 'worth pursuing rather than a waste of time. "We run outbound email and LinkedIn at '
  || 'mid-market manufacturers, plus a website that ranks for our category and an Instagram '
  || 'account for brand reach; qualified means budget plus an active project" is covered; "we do '
  || 'sales" is not. Cover every channel that brings in a new customer, not only the ones with a '
  || 'person dialling a phone — organic search and social presence count exactly as much as '
  || 'outbound. Silence is not coverage: this dimension counts as heard only once at least one '
  || 'real acquisition channel and its qualification criteria have actually been named — not '
  || 'merely once every channel mentioned so far, which could be none, turns out specific enough. '
  || 'If the interview is closing and no channel has surfaced, ask directly rather than assuming '
  || 'there is none.'
 where key = 'winning_business';

update public.discovery_dimensions set guidance =
  'Find out what happens the moment a deal closes: who sets the customer up in which system, who '
  || 'signs off that they are live, and who owns the relationship afterward — health checks, '
  || 'renewals, signs of risk. "Our onboarding lead configures the product from the signup form, '
  || 'and the account owner watches usage and support tickets for renewal risk starting ninety '
  || 'days out" is covered; "we onboard them" is not. Cover what must never be changed without a '
  || 'person checking first. Silence is not coverage: this dimension counts as heard only once at '
  || 'least one real fact about setup, ownership or renewal risk has actually been named — not '
  || 'merely once whatever was said (if anything) seems to cover the whole lifecycle. If the '
  || 'interview is closing and nothing has surfaced, ask directly rather than assuming the '
  || 'relationship ends at the sale.'
 where key = 'after_the_sale';

update public.discovery_dimensions set guidance =
  'Find out how the actual work gets done once it is agreed to, not just how it gets sold: '
  || 'dispatch, job scheduling, fulfilment, inventory and production. "Service requests get '
  || 'routed to dispatch, who schedules a technician and books parts against the van stock; we '
  || 'reorder a part once inventory drops below five" is covered; "we handle it" is not. This is '
  || 'where a trades, field-service or production business spends most of a real conversation, '
  || 'and today it has no home anywhere else in this spine — a request may get routed here by '
  || 'whoever answers the phone, but the actual scheduling, sourcing and completion of the work '
  || 'belongs to this dimension alone. Silence is not coverage: this dimension counts as heard '
  || 'only once at least one real fact about scheduling, sourcing or completing the work has '
  || 'actually been named — not merely once whatever was said (if anything) covers who schedules '
  || 'it, what triggers a reorder, and what done looks like. If the interview is closing and '
  || 'nothing has surfaced, ask directly rather than assuming this business has nothing to '
  || 'deliver.'
 where key = 'how_work_gets_delivered';

update public.discovery_dimensions set guidance =
  'Find the tasks that happen on a fixed, recurring schedule no matter who is busy — the monthly '
  || 'close and its reconciliations, a forecast cycle, a dunning sequence, a renewal cycle that '
  || 'starts counting down from a fixed number of days out, a report that goes to the same people '
  || 'every time. "We close in five business days and reconcile bank and AR monthly; dunning '
  || 'reminders go out at day zero, seven and fourteen; renewals start ninety days before the '
  || 'contract ends" is covered; "we stay busy" is not. These are the tasks most worth automating '
  || 'precisely because they repeat identically. Silence is not coverage: this dimension counts '
  || 'as heard only once at least one real recurring task has actually been named, with its '
  || 'cadence and who does it — not merely once whatever was said (if anything) sounds like it '
  || 'repeats. If the interview is closing and nothing has surfaced, ask directly rather than '
  || 'assuming nothing repeats.'
 where key = 'repetitive_work';

update public.discovery_dimensions set guidance =
  'Name the actual system each function runs in — general ledger, billing platform, CRM, help '
  || 'desk, the product being configured for a customer, a CMS, ad or social accounts, a planning '
  || 'spreadsheet — a product, not a category. "Leads and opportunities live in HubSpot; the '
  || 'ledger is in Xero; tickets are in Zendesk" is covered; "we use software for that" is not. '
  || 'Nearly every role this platform can staff asks a version of this question under a different '
  || 'name — ledger_system, billing_system, target_system, systems, cms, data_sources, ad_accounts '
  || '— because every connector this platform will ever build depends on the same fact: which '
  || 'system holds the truth for that function. Silence is not coverage: this dimension counts as '
  || 'heard only once at least one function has actually been paired with a named system, or an '
  || 'honest admission that nothing holds it yet — not merely once every function mentioned so '
  || 'far, which could be none, checks out by default. If the interview is closing and no '
  || 'function has been discussed, ask directly rather than assuming there is nothing to record.'
 where key = 'systems_of_record';

-- the_workforce_itself also loses the legal-justification clause and its
-- planned_legal archetype below (ITEM 2) — no longer relevant once legal
-- moves to money_out.
update public.discovery_dimensions set guidance =
  'Find out how this business runs its own people, separate from how it runs customers: hiring, '
  || 'payroll, rotas or shift schedules, and time off. "We run payroll through Gusto biweekly; '
  || 'the manager builds the roster a week ahead in a shared spreadsheet; PTO requests go through '
  || 'the same manager" is covered; "HR handles that" is not. Nothing in this product today '
  || 'configures a role around this topic, so name what exists even though there is nowhere for '
  || 'it to go yet. Silence is not coverage: this dimension counts as heard only once at least '
  || 'one real fact about paying, scheduling or giving staff time off has actually been named — '
  || 'not merely once whatever was said (if anything) sounds complete. If the interview is '
  || 'closing and nothing has surfaced, ask directly rather than assuming there is only one '
  || 'person to manage.'
 where key = 'the_workforce_itself';

update public.discovery_dimensions set guidance =
  'Build the map of actual people and their roles: who owns which kind of enquiry, who gets an '
  || 'escalation, who owns an account, who has the final say. "New sales go to Ali, billing goes '
  || 'to Accounts, emergencies go to the owner directly" is covered; "the team handles it" is '
  || 'not. This is distinct from approval thresholds: it is about identity, not a dollar figure, '
  || 'and it is what makes an escalation land on an actual inbox instead of nowhere. Silence is '
  || 'not coverage: this dimension counts as heard only once at least one enquiry type or '
  || 'escalation has actually been paired with a real person or title — not merely once every '
  || 'responsibility mentioned so far, which could be none, checks out by default. If the '
  || 'interview is closing and nobody has been named, ask directly rather than assuming one '
  || 'person handles everything.'
 where key = 'who_is_who';

update public.discovery_dimensions set guidance =
  'Find out how this business actually judges a job well done — the tone it wants, the metrics '
  || 'leadership watches, and the quality bar for anything customer-facing. "Warm and concise, '
  || 'never over-apologise, cost per lead under eighty dollars, retention and expansion are what '
  || 'leadership actually reviews" is covered; "good service" is not. Without this, a digital '
  || 'employee has no way to tell a strong outcome from a weak one that simply did not error '
  || 'out. Silence is not coverage: this dimension counts as heard only once at least one '
  || 'concrete metric or standard has actually been named for the business as a whole — not '
  || 'merely once every area of work already discussed, which could be none, turns out to have '
  || 'one. If the interview is closing and no metric or standard has surfaced, ask directly '
  || 'rather than assuming good is undefined.'
 where key = 'what_good_looks_like';

-- ---------------------------------------------------------------------------
-- ITEM 2 — planned_legal moves from the_workforce_itself to money_out.
-- ---------------------------------------------------------------------------

update public.discovery_dimensions
   set serves_archetypes = array['accounting','fpa','renewal_manager','planned_legal'],
       produces = array['accounts-payable role','FP&A budget-oversight role','spend approval-limit table','vendor-renewal tracking','vendor-contract legal-review flag']
 where key = 'money_out';

update public.discovery_dimensions
   set serves_archetypes = array[]::text[]
 where key = 'the_workforce_itself';

-- ---------------------------------------------------------------------------
-- Verification. Every check below fails for a specific, distinct reason.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int; v_thin int; v_orphan int; v_silent int;
  v_workforce_archetypes int; v_legal_in_money_out boolean;
  v_gap_keys text[];
begin
  select count(*) into v_n from public.discovery_dimensions where active;
  if v_n <> 14 then raise exception '735: expected 14 active dimensions, found %', v_n; end if;

  select count(*) into v_thin from public.discovery_dimensions
   where active and length(coalesce(guidance,'')) < 120;
  if v_thin > 0 then raise exception '735: % dimension(s) have guidance too thin to act on', v_thin; end if;

  select count(*) into v_orphan
    from public.discovery_dimensions d
    cross join lateral unnest(d.serves_archetypes) a
   where d.active and a !~ '^planned_'
     and not exists (select 1 from public.role_archetypes r where r.key = a);
  if v_orphan > 0 then
    raise exception '735: % dimension→archetype reference(s) point at nothing and are not planned_', v_orphan;
  end if;

  -- ITEM 1: the headline check. Every active dimension's guidance must say,
  -- literally, that silence is not coverage — not just the two round 1
  -- fixed. This is the SQL-side mirror of the widened vitest test.
  select count(*) into v_silent
    from public.discovery_dimensions
   where active and guidance !~* 'silence is not coverage';
  if v_silent > 0 then
    raise exception '735: % dimension(s) can still be closed by a transcript that said nothing', v_silent;
  end if;

  -- ITEM 2: legal relocated, not duplicated or dropped. Checked two ways —
  -- the specific column state, and the resulting gap set — so a mistake in
  -- either direction (forgot to remove it from workforce, forgot to add it
  -- to money_out, or accidentally left it in both) is caught.
  select coalesce(array_length(serves_archetypes, 1), 0) into v_workforce_archetypes
    from public.discovery_dimensions where key = 'the_workforce_itself' and active;
  if v_workforce_archetypes <> 0 then
    raise exception '735: the_workforce_itself should carry no archetypes now legal has moved, found %', v_workforce_archetypes;
  end if;

  select ('planned_legal' = any(serves_archetypes)) into v_legal_in_money_out
    from public.discovery_dimensions where key = 'money_out' and active;
  if not coalesce(v_legal_in_money_out, false) then
    raise exception '735: money_out should carry planned_legal and does not';
  end if;

  -- The gap view's own logic (734) is untouched — this proves the DATA move
  -- actually changes what it reports, on the real committed spine, to
  -- exactly the expected set (not a rolled-back probe: the mechanism was
  -- already proven in 734, what changed here is which rows carry a
  -- planned_ role, and that is what this checks).
  select array_agg(dimension_key order by dimension_key) into v_gap_keys
    from public.discovery_capability_gaps;
  if v_gap_keys is distinct from array['how_work_gets_delivered', 'money_out'] then
    raise exception '735: expected gaps exactly {how_work_gets_delivered, money_out}, found %', v_gap_keys;
  end if;
end $$;

commit;
