-- 736_a_role_for_hr_and_a_home_for_the_ceiling.sql
-- ==========================================================================
-- WHY: round 3 of the same review. Three findings, all from re-reading the
-- fix diff itself rather than the original derivation. 733, 734 and 735 are
-- applied and stay untouched.
--
-- ITEM 1 — FOUNDER RULING: declare planned_hr. Round 2 left
-- the_workforce_itself with serves_archetypes = '{}' because I judged, on my
-- own initiative, that inventing a fourth planned_ key (procurement/legal/QA
-- were the three the founder actually named) was not mine to decide. Correct
-- call to defer it; the founder was then asked directly, and the ruling is:
-- apply the SAME gap ruling here that procurement and legal already get.
-- the_workforce_itself now carries {planned_hr}, exactly like
-- how_work_gets_delivered carries {planned_procurement, planned_qa} and
-- money_out carries {planned_legal} — same mechanism, same customer promise,
-- same platform demand-flag, for a role this product also does not have.
--
-- This closes a real conceptual gap in what '{}' meant. Before this
-- migration, '{}' was doing two different jobs: on five dimensions
-- (what_we_do, must_never_happen, who_signs_off, who_is_who,
-- what_good_looks_like) it meant "this topic produces settings, not a role,
-- by its own nature" — a permanent design fact. On the_workforce_itself it
-- meant something else entirely — "this topic needs a role, we have none,
-- and none is declared" — a temporary gap in the product's role catalog that
-- happened to render identically to the first case. After this migration
-- '{}' means only the first thing, which is what the original 733 prose
-- always claimed ("Four dimensions produce configuration rather than
-- roles") — round 1 made it five when what_we_do joined them, and this
-- migration is what makes the boundary actually clean rather than
-- coincidentally the same array value for two unrelated reasons.
--
-- Re-examined all five remaining '{}' dimensions against that clarified
-- rule (full reasoning in the task report): what_we_do (produces vocabulary
-- and pipeline stages — spec row 1, not a role), must_never_happen and
-- who_signs_off (extract constraints on the AI's OWN behavior — guardrails,
-- approval thresholds — not a request for additional headcount),
-- who_is_who (maps EXISTING people, does not discover missing ones),
-- what_good_looks_like (defines success criteria for judging work, not a
-- capability). All five checked out as correctly config-only; none needed
-- to move.
--
-- ITEM 2 — the vitest assertion at tests/discovery-spine.test.ts:116-121
-- ("dimensions with empty serves_archetypes never appear as gaps") cannot
-- fail. Proven empirically before writing this migration: a one-off SELECT
-- reproducing discovery_capability_gaps WITHOUT its `gaps.planned_archetypes
-- is not null` guard returns all 14 active dimensions, including every
-- empty-array one — meaning the guarantee lives entirely in that one WHERE
-- clause in the VIEW, and no query over discovery_dimensions/
-- discovery_capability_gaps DATA can ever exercise its failure, because an
-- empty array structurally cannot contain a planned_-prefixed element. The
-- vitest assertion is deleted (tests/discovery-spine.test.ts, same commit)
-- and replaced with two things that CAN fail: a data-level check that the
-- five now-correctly-identified config-only dimensions have not silently
-- gained an archetype (a real regression a future migration could cause),
-- and — here, where write access actually exists to test it — a THIRD probe
-- case added to the existing rolled-back two-directional probe: an
-- EMPTY-array row, asserted absent from the gap view. That probe is what
-- actually exercises the mutation the coordinator asked for: drop the
-- `is not null` guard from the view, and this specific check (not the old
-- vitest one) is what goes red.
--
-- ITEM 3 — a content regression from Critical 2 (round 1). money_out was
-- correctly re-derived away from ad-spend caps toward AP/vendor-renewal/
-- legal-review, but nothing else picked up google_ads.budget_caps ("e.g.
-- $500/day, $12,000/month — hard limits") on the way out. who_signs_off
-- mentions "ad spend" only as one label in a list of role categories where
-- approval thresholds recur — it never asks for the actual ceiling.
-- winning_business asks about channels and qualification, not spend.
-- Result: no dimension in the corpus elicited a hard number for the one
-- kind of limit this product can mechanically enforce.
--
-- Given a home to winning_business, not back to money_out: a business is a
-- vendor to somebody (money_out) as a completely separate fact from how it
-- spends on paid acquisition (winning_business) — forcing both into
-- money_out's guidance would mean asking in the same breath about AP
-- reconciliation cadence and daily ad-spend caps, two different mental
-- models, which is exactly the "vague" risk flagged when this choice was
-- posed. winning_business already discusses google_ads for its
-- conversion_goals fact (round 1); a real conversation about a paid channel
-- naturally covers both what it is trying to achieve AND its spend ceiling
-- in the same breath, which money_out's AP-and-vendor-contracts narrative
-- does not share. Guidance rewritten to require an actual dollar figure —
-- "$500 a day" is covered, "we keep an eye on ad spend" is not — checked
-- below by asserting the guidance text itself contains a dollar-amount
-- pattern, not just prose about budgets.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- ITEM 1 — the_workforce_itself gets planned_hr.
-- ---------------------------------------------------------------------------
update public.discovery_dimensions
   set guidance =
     'Find out how this business runs its own people, separate from how it runs customers: hiring, '
     || 'payroll, rotas or shift schedules, and time off. "We run payroll through Gusto biweekly; '
     || 'the manager builds the roster a week ahead in a shared spreadsheet; PTO requests go through '
     || 'the same manager" is covered; "HR handles that" is not. Nothing in this product today '
     || 'configures a role around this topic — name what exists anyway, because that is exactly the '
     || 'kind of gap this platform should flag as something we would build, not something to quietly '
     || 'drop. Silence is not coverage: this dimension counts as heard only once at least one real '
     || 'fact about paying, scheduling or giving staff time off has actually been named — not merely '
     || 'once whatever was said (if anything) sounds complete. If the interview is closing and '
     || 'nothing has surfaced, ask directly rather than assuming there is only one person to manage.',
       serves_archetypes = array['planned_hr'],
       produces = array['workforce profile','rota/shift procedure','payroll-cadence note','HR-capability flag']
 where key = 'the_workforce_itself';

-- ---------------------------------------------------------------------------
-- ITEM 3 — winning_business regains the hard spend ceiling, as a number.
-- ---------------------------------------------------------------------------
update public.discovery_dimensions
   set guidance =
     'Learn how this business actually gets its next customer: which accounts, segments or search '
     || 'terms it goes after, through which paid, organic and social channels, what makes a lead '
     || 'worth pursuing rather than a waste of time, and — for any paid channel — the hard spend '
     || 'ceiling, in an actual number. "We run outbound email and LinkedIn at mid-market '
     || 'manufacturers, plus Google Ads capped at $500 a day and $12,000 a month; qualified means '
     || 'budget plus an active project" is covered; "we do sales" and "we keep an eye on ad spend" '
     || 'are not — a ceiling is a number, not a sentiment. Cover every channel that brings in a new '
     || 'customer, not only the ones with a person dialling a phone — organic search and social '
     || 'presence count exactly as much as outbound, and a channel with real money behind it needs '
     || 'its ceiling named before this counts as heard. Silence is not coverage: this dimension '
     || 'counts as heard only once at least one real acquisition channel and its qualification '
     || 'criteria have actually been named, with a spend ceiling if the channel is paid — not merely '
     || 'once every channel mentioned so far, which could be none, turns out specific enough. If the '
     || 'interview is closing and no channel — or no ceiling for a paid one — has surfaced, ask '
     || 'directly rather than assuming there is none.',
       produces = array['sdr role','bdr role','qualification criteria','seo/content role','social-media role','ad-spend-ceiling guardrail']
 where key = 'winning_business';

-- ---------------------------------------------------------------------------
-- Verification. Every check fails for a specific, distinct reason.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int; v_thin int; v_orphan int; v_silent int;
  v_workforce_has_hr boolean; v_gap_keys text[]; v_wb_has_number boolean;
begin
  select count(*) into v_n from public.discovery_dimensions where active;
  if v_n <> 14 then raise exception '736: expected 14 active dimensions, found %', v_n; end if;

  select count(*) into v_thin from public.discovery_dimensions
   where active and length(coalesce(guidance,'')) < 120;
  if v_thin > 0 then raise exception '736: % dimension(s) have guidance too thin to act on', v_thin; end if;

  select count(*) into v_orphan
    from public.discovery_dimensions d
    cross join lateral unnest(d.serves_archetypes) a
   where d.active and a !~ '^planned_'
     and not exists (select 1 from public.role_archetypes r where r.key = a);
  if v_orphan > 0 then
    raise exception '736: % dimension→archetype reference(s) point at nothing and are not planned_', v_orphan;
  end if;

  select count(*) into v_silent
    from public.discovery_dimensions
   where active and guidance !~* 'silence is not coverage';
  if v_silent > 0 then
    raise exception '736: % dimension(s) can still be closed by a transcript that said nothing', v_silent;
  end if;

  -- ITEM 1: the_workforce_itself carries planned_hr, same mechanism as
  -- procurement/QA/legal.
  select ('planned_hr' = any(serves_archetypes)) into v_workforce_has_hr
    from public.discovery_dimensions where key = 'the_workforce_itself' and active;
  if not coalesce(v_workforce_has_hr, false) then
    raise exception '736: the_workforce_itself should carry planned_hr and does not';
  end if;

  -- The gap view's own logic is untouched since 734 — this proves the DATA
  -- change lands, on the real committed spine, as exactly the expected
  -- three-member set (not a rolled-back probe: that is the separate check
  -- below, which tests a case this assertion cannot — see ITEM 2).
  select array_agg(dimension_key order by dimension_key) into v_gap_keys
    from public.discovery_capability_gaps;
  if v_gap_keys is distinct from array['how_work_gets_delivered', 'money_out', 'the_workforce_itself'] then
    raise exception '736: expected gaps exactly {how_work_gets_delivered, money_out, the_workforce_itself}, found %', v_gap_keys;
  end if;

  -- ITEM 3: winning_business must elicit an actual dollar figure, not just
  -- talk about budgets in the abstract.
  select (guidance ~ '\$[0-9]') into v_wb_has_number
    from public.discovery_dimensions where key = 'winning_business' and active;
  if not coalesce(v_wb_has_number, false) then
    raise exception '736: winning_business guidance does not contain a concrete dollar figure';
  end if;

  -- ITEM 2: the probe the vitest assertion could never be, because vitest
  -- has no write access. Three cases: a planned_ archetype MUST appear in
  -- the gap view; a real-only archetype MUST NOT; an EMPTY array MUST NOT —
  -- the specific case round 3 found untestable at the data-query level.
  -- Insert, measure into variables, then unconditionally raise a sentinel to
  -- undo the insert — verdicts are read from the variables AFTER the block,
  -- never from inside it.
  declare
    v_seen_planned boolean := null; v_seen_real boolean := null; v_seen_empty boolean := null;
  begin
    begin
      insert into public.discovery_dimensions (key, ordinal, title, guidance, serves_archetypes, produces)
      values ('__probe_planned', 9997, 'probe', repeat('x', 130), array['planned_test_probe'], array['nothing']),
             ('__probe_real',    9998, 'probe', repeat('x', 130), array['support_agent'],       array['nothing']),
             ('__probe_empty',   9999, 'probe', repeat('x', 130), array[]::text[],               array['nothing']);

      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_planned') into v_seen_planned;
      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_real')    into v_seen_real;
      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_empty')   into v_seen_empty;

      raise exception using errcode = 'P0001', message = '__undo_probe__';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> '__undo_probe__' then raise; end if;   -- a real P0001 still propagates
    end;

    if v_seen_planned is not true then
      raise exception '736: the gap view did NOT report a dimension carrying a planned_ archetype';
    end if;
    if v_seen_real is not false then
      raise exception '736: the gap view reported a dimension with only real archetypes — not discriminating';
    end if;
    if v_seen_empty is not false then
      raise exception '736: the gap view reported a dimension with an EMPTY serves_archetypes array — this is exactly the defect round 3 found the vitest suite could never catch';
    end if;
  end;
end $$;

commit;
