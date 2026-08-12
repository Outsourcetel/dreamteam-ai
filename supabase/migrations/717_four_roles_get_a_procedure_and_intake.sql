-- ═══════════════════════════════════════════════════════════════
-- 717 — Four roles get a procedure, and something to do it about.
--
-- Migs 509 and 511 gave six roles a compilable procedure. These are the
-- other four in the Outsourcetel roster — bdr, marketing, front_desk and
-- it_helpdesk — authored the same way, which is the point: a row of
-- config per role, not a code change.
--
-- ── WHY THESE FOUR WERE THE ONLY INERT ONES ────────────────────
-- Measured 2026-08-12. Their definitions were never SOPs at all: they
-- carried playbook-execute's label+params shape, missing params.title and
-- a trailing `complete`, so they could not run there either. Ten
-- definitions were mislabelled "published"; six were live SOPs already
-- compiling work (Accounting 38 items, Billing 36, Onboarding 50). These
-- four had zero work items between them, and their DEs had zero
-- objectives. Mig 715 typed the rows; this one gives these four something
-- worth compiling.
--
-- ── AUTHORING WAS NOT ENOUGH, AND THE CONTROL PROVES IT ────────
-- compileSopToWorkItems only runs inside planObjective, so an objective
-- must exist, and objectives come from watchers. RENEWAL DE is the
-- control: it already holds mig 509's own converted SOP AND six active
-- watchers that all ran on 2026-08-12 — and has 0 objectives and 0 work
-- items, because its date_horizon/state_condition watchers look at
-- commercial_agreements and customer_accounts and nothing sits in the
-- horizon. The roles that produce work are the ones with `schedule`
-- watchers, which fire on a clock regardless of data.
--
-- ── ⚠ AND `inbox` WATCHERS NEVER PRODUCE AN OBJECTIVE ──────────
-- run_work_watchers has carried `WHERE active AND kind <> 'inbox'` in
-- every version since mig 213 (still there at mig 430:375). Mig 232 says
-- why in its own words: the inbox watcher is registered "so the book of
-- work is complete in one place; intake is served by the proactive
-- poller." It is a REGISTRATION, not a producer.
--
-- front_desk and it_helpdesk are exactly the two archetypes whose ONLY
-- watcher template is `inbox`. So installing their kit gives them a row
-- that can never fire. it_helpdesk is rescued by install_role_watchers
-- (mig 606), which matches on role NAME — 'helpdesk' hits its
-- de_conversations status='human_owned' branch, and that source is
-- grounded here (160 conversations, 1 already human_owned).
--
-- front_desk matches NO branch in install_role_watchers and is counted
-- `skipped_no_catalogued_source`. So it gets a `schedule` template below,
-- the same shape as bdr's. FOUNDER, THIS IS THE ONE INTERPRETED CHOICE
-- IN THIS MIGRATION: without it, activating Front Desk is activation into
-- an intake that cannot fire, and its number stays zero however good its
-- SOP is. Revert this hunk alone and the other three are unaffected.
--
-- ── THE TWO CONSTRAINTS CARRIED FORWARD, UNCHANGED ─────────────
-- 1. NOTHING HERE SENDS. Channels are closed under founder decision N5.
--    Every motion that would end in contact ends at a prepared document
--    plus an escalation naming who should send it, and the step says so
--    in its own text so the employee stops deliberately rather than
--    discovering a wall.
-- 2. AN EMPTY BOOK IS A FINISHED SHIFT. Every schedule-driven SOP says
--    so explicitly, or the employee escalates asking for access it
--    already has — the exact failure mig 505 fixed.
--
-- Every step names a tool the role is genuinely offered: the shared set
-- (search_knowledge, compute, run_analytics, remember, draft_outreach,
-- escalate_to_human, mark_done) plus produce_deliverable, which de-work
-- offers whenever the work item belongs to an objective. tool:'none'
-- means the step is desk-reading or judgment, not a missing capability.
--
-- Ships global via role_archetypes (platform-level; the pattern of migs
-- 497, 502, 505, 509 and 511) and re-materialises the tenant copies.
-- ═══════════════════════════════════════════════════════════════

-- A migration is a service actor. playbook_steps_guard writes the audit
-- chain on every UPDATE of `steps`, and append_audit_event refuses a
-- caller that is neither service_role nor a tenant member — the same wall
-- mig 715's probe hit. Transaction-local; the audit event is still written.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 1. BUSINESS DEVELOPMENT (schedule-driven, no case record) ──
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Target Account Development SOP',
  'description', 'Standard operating procedure for working the target-account list and preparing approaches for a human to send.',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_list','kind','use_tool','work_kind','check','tool','none',
      'title','Open your target list',
      'detail','Your worklist is in front of you: the accounts and opportunities assigned to you. State how many there are. IF THE LIST IS EMPTY, that is a complete answer — record that there was nothing to work today and finish. Never escalate asking for a list you have been shown.'),
    jsonb_build_object('key','read_what_is_known','kind','use_tool','work_kind','check','tool','search_knowledge',
      'title','Read what is already known',
      'detail','Search what the business already knows about these accounts and their segment, and cite it. If there is no history for an account, say plainly that it is unknown — an account with no record is not a warm one. Never invent a fact about a company.'),
    jsonb_build_object('key','pick_the_next_move','kind','use_tool','work_kind','check','tool','none',
      'title','Decide which account is worth an approach',
      'detail','Name the one or two accounts that genuinely warrant contact now, and state the evidence for each. If none of them do, say that — a shift that correctly decides not to contact anyone is a finished shift, not a failed one.'),
    jsonb_build_object('key','prepare_the_approach','kind','use_tool','work_kind','act','tool','draft_outreach',
      'title','Draft the approach',
      'detail','Draft the outreach for the account you picked, grounded in what you actually found. THIS IS NOT SENT: it goes to a person for review, and sending is not yours to do. Say nothing about pricing, terms or dates you have not read. Skip this step and say so if nothing warranted contact.'),
    jsonb_build_object('key','hand_it_over','kind','use_tool','work_kind','follow_up','tool','escalate_to_human',
      'title','Hand the draft to whoever should send it',
      'detail','Escalate with the account, the draft, and why now. Name who should send it if you know. If nothing warranted contact today, do NOT escalate — finish and report that.')
  )) where key = 'bdr';

-- ── 2. MARKETING (schedule-driven, weekly) ─────────────────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Marketing Review SOP',
  'description', 'Standard operating procedure for reviewing campaigns and content in flight and preparing the weekly position.',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_week','kind','use_tool','work_kind','check','tool','none',
      'title','Open the week',
      'detail','Your worklist holds the campaigns and content currently in flight. State how many, and which. IF THERE ARE NONE, that is a complete answer — record that there was nothing in flight this week and finish. Never escalate asking for access to a board you have been shown.'),
    jsonb_build_object('key','read_the_numbers','kind','use_tool','work_kind','check','tool','run_analytics',
      'title','Read whatever performance is actually recorded',
      'detail','Pull the figures that exist. If a campaign has no recorded performance, say that its performance is UNKNOWN — not that it is doing fine. A missing number is missing, never zero and never good.'),
    jsonb_build_object('key','compute_the_position','kind','use_tool','work_kind','check','tool','compute',
      'title','Work out the position',
      'detail','Do the arithmetic with compute, never in your head — spend against plan, and change versus the last period where both figures exist. State which comparisons you could not make because a figure was missing.'),
    jsonb_build_object('key','prepare_the_summary','kind','use_tool','work_kind','act','tool','produce_deliverable',
      'title','Prepare the weekly note',
      'detail','Write the note: what ran, what the figures say, what is unknown and why. Real figures only, and label every estimate as an estimate. Skip this step and say so if nothing was in flight.'),
    jsonb_build_object('key','flag_what_needs_a_decision','kind','use_tool','work_kind','follow_up','tool','escalate_to_human',
      'title','Flag anything that needs a person to decide',
      'detail','Escalate only the things a human must actually decide — budget, a campaign to stop, a claim you cannot substantiate. If the week was clean, do not escalate; finish and report it.')
  )) where key = 'marketing';

-- ── 3. FRONT DESK (reception; routes, never replies) ───────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Front Desk Routing SOP',
  'description', 'Standard operating procedure for reading what has come in and routing it to the right owner.',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_desk','kind','use_tool','work_kind','check','tool','none',
      'title','Open the desk',
      'detail','Look at what has come in and is not yet with an owner. State how many and what they are about. IF THERE IS NOTHING WAITING, that is a complete answer — record an empty desk and finish. Never escalate asking for access to the desk you have been shown.'),
    jsonb_build_object('key','read_what_came_in','kind','use_tool','work_kind','check','tool','search_knowledge',
      'title','Understand what each one is asking for',
      'detail','For each item, state in one line what the person actually wants, and check what the business already knows about it. If you cannot tell what they want, say so — do not guess a topic to make it routable.'),
    jsonb_build_object('key','work_out_where_it_goes','kind','use_tool','work_kind','check','tool','none',
      'title','Work out who it belongs to',
      'detail','Name the right team or role for each item and the reason. If you do not know who owns it, say that rather than naming someone plausible — a confidently wrong routing costs more than an honest question.'),
    jsonb_build_object('key','prepare_the_handover','kind','use_tool','work_kind','act','tool','produce_deliverable',
      'title','Write the handover note',
      'detail','One short note per item: who it is from, what they want, what is already known, and where it should go. YOU DO NOT REPLY TO THE PERSON — outbound contact is closed and is not yours to do. Skip this step and say so if the desk was empty.'),
    jsonb_build_object('key','hand_it_over','kind','use_tool','work_kind','follow_up','tool','escalate_to_human',
      'title','Hand the desk over',
      'detail','Escalate the routed list to a person, naming anything urgent and anything you could not place. If the desk was empty, do not escalate — finish and report it.')
  )) where key = 'front_desk';

-- ── 4. IT HELPDESK (a request has landed on the desk) ──────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'IT Request Triage SOP',
  'description', 'Standard operating procedure for diagnosing an IT request and preparing what a person needs to close it.',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_request','kind','use_tool','work_kind','check','tool','none',
      'title','Open the request',
      'detail','State what has been asked, by whom, and since when. IF THERE IS NO REQUEST ON YOUR DESK, that is a complete answer — record it and finish rather than looking for work you were not given.'),
    jsonb_build_object('key','read_the_history','kind','use_tool','work_kind','check','tool','search_knowledge',
      'title','Read what is already known about this problem',
      'detail','Search the knowledge base and cite what you find. If nothing covers this, say plainly that there is no recorded guidance — that is a real finding and it is how the gap gets filled. Never present your own guess as documented.'),
    jsonb_build_object('key','work_out_the_fix','kind','use_tool','work_kind','check','tool','none',
      'title','Work out what is actually wrong',
      'detail','State the most likely cause and the evidence for it, and name what you would need to confirm it. If the evidence does not support a cause, say it is undiagnosed. Never invent a root cause to close a ticket.'),
    jsonb_build_object('key','record_what_you_found','kind','use_tool','work_kind','act','tool','produce_deliverable',
      'title','Write up the diagnosis and the steps',
      'detail','Write what you checked, what you concluded, and the exact steps to resolve it — enough that a person can act without repeating your work. Say which steps need access or a change you do not have.'),
    jsonb_build_object('key','hand_over_what_you_cannot_do','kind','use_tool','work_kind','follow_up','tool','escalate_to_human',
      'title','Hand over what needs a person',
      'detail','Escalate anything requiring access, a system change or an approval you do not hold, with your diagnosis attached so the person starts where you finished. If you fully resolved it in writing and nothing is outstanding, do not escalate.')
  )) where key = 'it_helpdesk';

-- ── 5. Front Desk gets intake that can actually fire ───────────
-- THE INTERPRETED CHOICE, isolated so it can be reverted alone. Its
-- existing `inbox` template is kept — it is a truthful registration of
-- how work really arrives — and a `schedule` template is ADDED beside it,
-- because only a clock-driven watcher produces an objective today.
update public.role_archetypes
   set watcher_templates = coalesce(watcher_templates, '[]'::jsonb) || jsonb_build_array(
     jsonb_build_object(
       'kind','schedule',
       'label','Daily desk sweep',
       'description','Work out what has come in and route it. An empty desk is a finished shift, not a failure.',
       'config', jsonb_build_object('interval_minutes', 1440,
                 'response_window', jsonb_build_object('unit','days','amount',1))))
 where key = 'front_desk'
   and not exists (
     select 1 from jsonb_array_elements(coalesce(watcher_templates,'[]'::jsonb)) w
      where w->>'kind' = 'schedule');

-- ── 6. Re-materialise the tenant copies ────────────────────────
-- Every tenant already holding one of these four as a definition gets the
-- new steps. mig 715's trigger re-derives `kind` from the steps, so these
-- rows flip 'procedure' → 'sop' by themselves — nothing declares it.
--
-- ⚠ THEIR OLD playbook_versions SNAPSHOTS ARE LEFT EXACTLY AS THEY ARE.
-- They are the pre-509 prose copies, they are immutable by design, and
-- once the definition is an `sop` no engine reads them again. Deleting
-- history to tidy an inventory is how audit trails get rewritten.
update public.playbook_definitions d
   set steps       = a.sop_playbook->'steps',
       name        = coalesce(a.sop_playbook->>'name', d.name),
       description = coalesce(a.sop_playbook->>'description', d.description),
       updated_at  = now()
  from public.role_archetypes a
 where a.key in ('bdr','marketing','front_desk','it_helpdesk')
   and d.key = a.key || '_sop'
   and d.steps is distinct from a.sop_playbook->'steps';

-- ── 7. Assertions — inverted, and counted ──────────────────────
do $$
declare
  v_arch      int;
  v_defs      int;
  v_sop       int;
  v_bad       int;
  v_fd_sched  int;
  v_compiled  int;
  r           record;
begin
  -- A1. All four archetypes now classify as sop — and the classifier is
  -- still capable of saying no (proven against a shape that must not).
  select count(*) into v_arch from role_archetypes
   where key in ('bdr','marketing','front_desk','it_helpdesk')
     and public.playbook_definition_kind(sop_playbook->'steps') = 'sop';
  if v_arch <> 4 then
    raise exception 'ASSERT FAILED: % of 4 archetypes classify as sop', v_arch;
  end if;
  if public.playbook_definition_kind('[{"key":"instruction"}]'::jsonb) <> 'procedure' then
    raise exception 'ASSERT FAILED: the classifier has stopped being able to say procedure';
  end if;

  -- A2. Every step is compilable: compileSopToWorkItems keeps only steps
  -- with kind='use_tool' AND (title or key), so a step missing its title
  -- would silently vanish from the compiled plan rather than fail.
  select count(*) into v_bad
    from role_archetypes a, jsonb_array_elements(a.sop_playbook->'steps') s
   where a.key in ('bdr','marketing','front_desk','it_helpdesk')
     and (s->>'kind' is distinct from 'use_tool'
          or coalesce(btrim(s->>'title'),'') = ''
          or coalesce(btrim(s->>'detail'),'') = ''
          or s->>'work_kind' not in ('act','check','follow_up'));
  if v_bad > 0 then
    raise exception 'ASSERT FAILED: % step(s) across the four SOPs would not compile', v_bad;
  end if;

  -- A3. The tenant copies moved, and moved to 'sop' on their own.
  select count(*), count(*) filter (where kind = 'sop') into v_defs, v_sop
    from playbook_definitions
   where key in ('bdr_sop','marketing_sop','front_desk_sop','it_helpdesk_sop');
  if v_defs = 0 then
    raise exception 'ASSERT FAILED: zero tenant copies compared — an empty comparison proves nothing';
  end if;
  if v_sop <> v_defs then
    raise exception 'ASSERT FAILED: only % of % tenant copies became sop', v_sop, v_defs;
  end if;
  raise notice 'mig 717: % tenant definition(s) re-materialised, all now kind=sop', v_defs;

  -- A4. Front Desk has a watcher template that CAN fire, and still has
  -- the inbox registration it always had.
  select count(*) into v_fd_sched
    from role_archetypes a, jsonb_array_elements(a.watcher_templates) w
   where a.key = 'front_desk' and w->>'kind' = 'schedule';
  if v_fd_sched <> 1 then
    raise exception 'ASSERT FAILED: front_desk has % schedule template(s), expected exactly 1', v_fd_sched;
  end if;
  if not exists (select 1 from role_archetypes a, jsonb_array_elements(a.watcher_templates) w
                  where a.key = 'front_desk' and w->>'kind' = 'inbox') then
    raise exception 'ASSERT FAILED: front_desk lost its inbox registration';
  end if;

  -- A5. THE SIX THAT ALREADY WORKED MUST STILL WORK. This migration must
  -- not have disturbed them; naming them explicitly means a regression
  -- shows up here rather than as a DE that quietly stopped.
  select count(*) into v_compiled
    from playbook_definitions
   where key in ('accounting_sop','billing_ar_sop','cs_manager_sop','fpa_sop','onboarding_sop','renewal_manager_sop')
     and kind = 'sop' and status = 'published';
  if v_compiled = 0 then
    raise exception 'ASSERT FAILED: the six pre-existing SOPs are no longer published sop rows';
  end if;
  raise notice 'mig 717: % pre-existing SOP definition(s) still published and typed sop', v_compiled;

  raise notice 'migration 717 assertions passed';
end $$;
