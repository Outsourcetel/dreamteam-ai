-- 733_a_spine_of_things_worth_asking.sql
-- ==========================================================================
-- WHY: a new workspace today answers two questions at signup and is handed
-- a workspace someone else designed. That is being replaced with a plain-
-- English discovery interview: a conversation decides HOW to ask, but a
-- fixed SPINE of business dimensions decides WHAT must be covered before the
-- interview can end. This migration creates the spine. Nothing here talks to
-- a customer yet — that is later work. This is the list the later work is
-- not allowed to wander off of.
--
-- The founder's requirement, verbatim, is why the spine exists at all: "I
-- don't want to lose the depth of the interview or getting side tracked
-- because customer got focused on one thing and forgot other critical
-- pieces." A short interview stays complete only if something outside the
-- conversation itself insists on the twelve topics below, regardless of
-- which one the customer happens to get excited about first.
--
-- The spine is DATA, not code. Adding a thirteenth dimension later (e.g.
-- procurement, once a procurement archetype exists) is an INSERT, not a
-- redeploy of the interview engine.
--
-- WHERE THE TWELVE CAME FROM: public.role_archetypes already carries 93
-- setup_questions authored across its 15 roles — accounting, bdr, billing_ar,
-- cs_manager, fpa, front_desk, google_ads, it_helpdesk, marketing, onboarding,
-- renewal_manager, sdr, seo, social_media, support_agent. Those questions are
-- the product's own working vocabulary for how a business describes itself.
-- The twelve dimensions below are read off that material, not invented
-- separately from it: e.g. "systems_of_record" exists as its own dimension
-- because four unrelated archetypes (bdr, sdr, cs_manager, renewal_manager)
-- independently ask the near-identical question "where do your
-- accounts/leads/customer/contract records live" — that is not a
-- coincidence, it is the same underlying fact every connector setup depends
-- on, surfacing four times.
--
-- serves_archetypes maps a dimension to the role_archetypes.key values whose
-- setup this dimension's discovery would inform or staff. Four dimensions —
-- must_never_happen, who_signs_off, who_is_who, what_good_looks_like —
-- produce CONFIGURATION (guardrails, approval chains, escalation contacts,
-- success metrics), not a role, so they take serves_archetypes = '{}'. That
-- empty array is load-bearing: it is what keeps discovery_capability_gaps
-- from reporting them as unstaffable roles, which they were never meant to
-- be.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
create table if not exists public.discovery_dimensions (
  key               text primary key,
  ordinal           int  not null,
  title             text not null,
  guidance          text not null,
  serves_archetypes text[] not null default '{}',
  produces          text[] not null default '{}',
  required          boolean not null default true,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint discovery_dimensions_ordinal_unique unique (ordinal)
);

alter table public.discovery_dimensions enable row level security;
drop policy if exists discovery_dimensions_read on public.discovery_dimensions;
create policy discovery_dimensions_read on public.discovery_dimensions
  for select to authenticated using (true);

revoke all on public.discovery_dimensions from public, anon;
revoke insert, update, delete on public.discovery_dimensions from authenticated;
grant select on public.discovery_dimensions to authenticated, service_role;
grant insert, update, delete on public.discovery_dimensions to service_role;

-- ---------------------------------------------------------------------------
-- The twelve dimensions, in interview order. Guidance says what "covered"
-- means for that dimension specifically — concrete good/bad examples, not a
-- restatement of the title — because that is the only thing that lets a
-- model decide "heard enough, move on" versus "still vague, stay here".
-- ---------------------------------------------------------------------------
insert into public.discovery_dimensions
  (key, ordinal, title, guidance, serves_archetypes, produces) values

('what_we_do', 1, 'What the business does',
 'Get a plain-English account of what this business actually is and does — the industry, the '
 || 'product or service, and who it serves. Concrete beats abstract: "a two-location dental '
 || 'practice" or "commercial HVAC installation and repair" is covered; "we help customers" is '
 || 'not. If they support or configure a specific product, system or piece of equipment, name '
 || 'it — that name is what a front-desk or support role gets built around. Mark heard only '
 || 'when you could describe the business to a stranger in one sentence.',
 array['front_desk','support_agent','it_helpdesk'],
 array['business profile','front-desk role','support-scope definition']),

('how_customers_reach_us', 2, 'How customers reach us',
 'Find every channel a customer, prospect or employee actually uses to make contact today, and '
 || 'what happens on each one — phone, email, a chat widget, a booking link, walk-ins, social '
 || 'messages, or organic search landing on the website. "They call and email; calls go to the '
 || 'front desk, email sits in a shared inbox" is covered; "we are reachable" is not. Note which '
 || 'channel is busiest and which is neglected, since that gap is often the real problem. Mark '
 || 'heard only once you can say, for every channel in use, where a message lands and who '
 || 'currently sees it.',
 array['front_desk','support_agent','it_helpdesk','seo','social_media'],
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
 'Find out where money leaves the business on a recurring basis, and who is allowed to commit '
 || 'it — ad spend, marketing budget, vendor bills, subscriptions. "Google Ads is capped at five '
 || 'hundred dollars a day, and Marketing needs sign-off above five thousand" is covered; "we '
 || 'have a budget" is not. Capture the hard ceiling, not the soft intention, and name who gets '
 || 'notified when a cap is close to being hit. Mark heard only once you know both the ceiling '
 || 'and who answers for it if it is breached.',
 array['google_ads','marketing'],
 array['ad-budget guardrail','marketing-spend approval rule']),

('winning_business', 5, 'How we win business',
 'Learn how this business actually gets its next customer: which accounts, segments or search '
 || 'terms it goes after, through which channels, and what makes a lead worth pursuing rather '
 || 'than a waste of time. "We run outbound email and LinkedIn at mid-market manufacturers; '
 || 'qualified means budget plus an active project" is covered; "we do sales" is not. Cover paid '
 || 'channels too if they run them, and what a good result looks like there. Mark heard only '
 || 'once the criteria are specific enough that a new hire could use them to recognize a real '
 || 'opportunity.',
 array['sdr','bdr','marketing','google_ads'],
 array['sdr role','bdr role','qualification criteria','ad-conversion goal']),

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

('repetitive_work', 7, 'The repetitive work',
 'Find the tasks that happen on a fixed, recurring schedule no matter who is busy — the monthly '
 || 'close and its reconciliations, a forecast cycle, a dunning sequence, a report that goes to '
 || 'the same people every time. "We close in five business days and reconcile bank and AR '
 || 'monthly; reminders go out at day zero, seven and fourteen" is covered; "we stay busy" is '
 || 'not. These are the tasks most worth automating precisely because they repeat identically. '
 || 'Mark heard only once you can name the cadence, the deadline, and who currently does it by '
 || 'hand.',
 array['accounting','fpa','billing_ar'],
 array['close-cadence checklist','recurring-report schedule','dunning-cadence procedure']),

('systems_of_record', 8, 'Where the record lives',
 'Name the actual system each function runs in — CRM, help desk, general ledger, billing '
 || 'platform, ad accounts — a product, not a category. "Leads and opportunities live in '
 || 'HubSpot; contracts live in a spreadsheet" is covered; "we use software for that" is not. '
 || 'This same question recurs in nearly identical wording across roles, because every '
 || 'connector this platform will ever build depends on the same fact: which system holds the '
 || 'truth. Mark heard only once every function discussed so far has a named system attached, '
 || 'or an honest admission that nothing holds it yet.',
 array['bdr','sdr','cs_manager','renewal_manager'],
 array['CRM connector','systems-of-record map','integration checklist']),

('must_never_happen', 9, 'What must never happen',
 'Capture the hard lines — actions or statements that must never happen no matter how routine '
 || 'the request sounds: bypassing a control, promising a refund, sharing account details before '
 || 'an identity check, claiming a certification with no evidence behind it, discussing anything '
 || 'legal or safety-related without a person. "Never bypass the period-close cutoff" and "never '
 || 'claim ISO certification unless the certificate is on file" are covered; "be careful" is '
 || 'not. These become guardrails rather than judgment calls, so phrase each one as a bright '
 || 'line, not a preference. Mark heard only once a violation of the rule would be unambiguous '
 || 'to anyone reading it.',
 array[]::text[],
 array['guardrail rule set','prohibited-claim list']),

('who_signs_off', 10, 'Who signs off',
 'Find the actual dollar thresholds and approval chains that gate action — not a vague sense of '
 || 'seniority, but a number and a named approver. "Journal entries over ten thousand dollars '
 || 'need a second approver; discounts above five percent need Finance" is covered; "we are '
 || 'careful with money" is not. This question recurs almost verbatim across nearly every role '
 || 'this platform can staff, because every one of them eventually asks a person to approve '
 || 'something — capture the number every time it comes up, even when the same person approves '
 || 'everything. Mark heard only once every threshold you have heard has both a value and an '
 || 'approver attached to it.',
 array[]::text[],
 array['approval-threshold table','sign-off chain']),

('who_is_who', 11, 'Who is who',
 'Build the map of actual people and their roles: who owns which kind of enquiry, who gets an '
 || 'escalation, who owns an account, who has the final say. "New sales go to Ali, billing goes '
 || 'to Accounts, emergencies go to the owner directly" is covered; "the team handles it" is '
 || 'not. This is distinct from approval thresholds: it is about identity, not a dollar figure, '
 || 'and it is what makes an escalation land on an actual inbox instead of nowhere. Mark heard '
 || 'only once every named responsibility discussed so far has a real person or title attached '
 || 'to it.',
 array[]::text[],
 array['escalation-routing table','org-contact map']),

('what_good_looks_like', 12, 'What good looks like',
 'Find out how this business actually judges a job well done — the tone it wants, the metrics '
 || 'leadership watches, and the quality bar for anything customer-facing. "Warm and concise, '
 || 'never over-apologise, cost per lead under eighty dollars, retention and expansion are what '
 || 'leadership actually reviews" is covered; "good service" is not. Without this, a digital '
 || 'employee has no way to tell a strong outcome from a weak one that simply did not error '
 || 'out. Mark heard only once at least one concrete metric or standard exists for each area of '
 || 'work already discussed.',
 array[]::text[],
 array['success-metric list','tone-and-quality standard']);

-- ---------------------------------------------------------------------------
-- The gap view, derived not stored. A dimension is a capability gap only if
-- it NAMES archetypes and NONE of them exist — a dimension with no
-- serves_archetypes at all (the four config dimensions above) is not a gap,
-- it never claimed a role in the first place.
-- ---------------------------------------------------------------------------
create or replace view public.discovery_capability_gaps as
  select d.key as dimension_key, d.title, d.serves_archetypes
    from public.discovery_dimensions d
   where d.active
     and coalesce(array_length(d.serves_archetypes, 1), 0) > 0
     and not exists (
       select 1 from public.role_archetypes r
        where r.key = any(d.serves_archetypes));

revoke all on public.discovery_capability_gaps from public, anon;
grant select on public.discovery_capability_gaps to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification. Each check is chosen so that breaking the thing it guards
-- makes THAT check fail, not an earlier one — see the gap-view probe below in
-- particular: it has to fail in BOTH directions, because a view that matches
-- everything and a view that matches nothing both pass a one-sided check.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_thin int; v_orphan int;
begin
  select count(*) into v_n from public.discovery_dimensions where active;
  if v_n <> 12 then raise exception '733: expected 12 active dimensions, found %', v_n; end if;

  select count(*) into v_thin from public.discovery_dimensions
   where active and length(coalesce(guidance,'')) < 120;
  if v_thin > 0 then raise exception '733: % dimension(s) have guidance too thin to act on', v_thin; end if;

  -- An archetype key that does not exist would never staff AND never be
  -- reported as a gap — the worst of both. Catch it at apply time.
  select count(*) into v_orphan
    from public.discovery_dimensions d
    cross join lateral unnest(d.serves_archetypes) a
   where d.active and not exists (select 1 from public.role_archetypes r where r.key = a);
  if v_orphan > 0 then raise exception '733: % dimension→archetype reference(s) point at nothing', v_orphan; end if;

  -- Prove the gap view DERIVES rather than reporting a stored fact. Both
  -- directions, because a view that reports everything and a view that reports
  -- nothing both pass a one-sided check.
  --
  -- The probe inserts, measures into variables, then unconditionally raises a
  -- sentinel to undo the insert. Verdicts are read from the variables AFTER
  -- the block, never from inside it — that keeps the control flow readable and
  -- means a genuine error still propagates rather than being swallowed by a
  -- handler trying to be clever.
  declare v_seen boolean := null; v_real boolean := null;
  begin
    begin
      insert into public.discovery_dimensions (key, ordinal, title, guidance, serves_archetypes, produces)
      values ('__probe_gap',  9998, 'probe', repeat('x', 130), array['__no_such_archetype'], array['nothing']),
             ('__probe_real', 9999, 'probe', repeat('x', 130), array['support_agent'],       array['nothing']);

      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_gap')  into v_seen;
      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_real') into v_real;

      raise exception using errcode = 'P0001', message = '__undo_probe__';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> '__undo_probe__' then raise; end if;   -- a real P0001 still propagates
    end;

    if v_seen is not true then
      raise exception '733: the gap view did NOT report a dimension whose archetypes do not exist';
    end if;
    if v_real is not false then
      raise exception '733: the gap view reported a dimension whose archetype DOES exist — it is not deriving, it is matching everything';
    end if;
  end;
end $$;

commit;
