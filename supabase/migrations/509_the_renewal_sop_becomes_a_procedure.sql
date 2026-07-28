-- 509_the_renewal_sop_becomes_a_procedure.sql
-- ============================================================================
-- A playbook stops being something an employee READS and becomes something it
-- FOLLOWS.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
-- Two engines that never spoke. playbook-execute owns a genuine 20-primitive
-- interpreter — validated, versioned, audited — but knows nothing about
-- objectives, cases, agreements, contacts or work items: grep it for
-- entity_kind, continuity or commercial_agreement and there are no matches. Its
-- whole run context is ONE field, account_id. Meanwhile de-work owns the
-- grounded desk, the tools and the gates, but consumed the SOP only as
-- FLATTENED PROSE inside a planner prompt and then invented its own steps with
-- an LLM.
--
-- So no step in any published playbook could ever cause an employee to call a
-- tool. Across all 12 role archetypes: 61 SOP steps, ZERO executable. Every
-- case got a plan improvised on the spot, which is why two identical renewals
-- ran differently and stalled in different places. And 8 of the tenant's 11
-- published SOPs could not even START — the validator requires a final
-- 'complete' step and every role SOP ends in prose, so a fire is rejected 422
-- before a run row exists.
--
-- ── THE FIX, AND WHY IT IS THIS ONE ────────────────────────────────────────
-- Not "give the playbook engine a desk" — that would rebuild what de-work
-- already has. Instead the SOP COMPILES INTO WORK ITEMS that the already-
-- grounded engine executes (de-work compileSopToWorkItems). A step marked
-- kind:'use_tool' becomes one de_work_item with the SOP's own order and
-- dependencies; prose steps stay prose and still reach the employee through
-- its briefing. Where a role has no executable SOP the LLM planner remains the
-- fallback, so nothing regresses for the eleven archetypes not yet authored.
--
-- Ships global: role_archetypes is platform-level, the pattern migrations 497,
-- 502 and 505 established. Tenants already holding the prose copy are
-- re-materialised below.
--
-- ── WRITTEN AGAINST THE REAL CAPABILITY ENVELOPE ───────────────────────────
-- Every step below names a tool a renewal case genuinely has TODAY: the desk
-- resolves the agreement and its continuity facet; read_contacts is new in this
-- wave and reads the contact book seeded in 508; write_back_to_case
-- log_activity and set_next_step AUTO-EXECUTE under founder decision D4 while
-- advance_stage still stops at the destructive floor; produce_deliverable and
-- escalate_to_human are ungated. Nothing here assumes a connector this tenant
-- does not have.
--
-- ── AND THE HONEST STOP ────────────────────────────────────────────────────
-- The motion deliberately ENDS at a priced, drafted notice plus an escalation
-- naming the recipient and the date. It does not send: channels are closed by
-- founder decision N5. Step 6 says so in its own instruction, so the employee
-- stops on purpose rather than discovering it as a failure.
-- ============================================================================

update public.role_archetypes
   set sop_playbook = jsonb_build_object(
     'name', 'Commercial Continuity SOP',
     'steps', jsonb_build_array(

       jsonb_build_object(
         'key', 'confirm_the_record', 'kind', 'use_tool', 'work_kind', 'check',
         'title', 'Confirm the agreement on the desk',
         'tool', 'none',
         'detail', 'Your desk already holds this agreement, its dates rendered as days from today, and its case facet. State the counterparty, the annual value, the motion, which date is driving this case and how many days remain. Use the figures as given — never recompute a date yourself. If the record is not on your desk, do NOT proceed: escalate with escalate_to_human saying the record could not be resolved.'),

       jsonb_build_object(
         'key', 'read_the_terms', 'kind', 'use_tool', 'work_kind', 'check',
         'title', 'Read the terms that decide the position',
         'tool', 'compute',
         'detail', 'From the agreement: does it auto-renew, what is the notice period, and is there a contractual increase? If there is, use compute to work out the uplift in money from the baseline value and the percentage — do not do the arithmetic in your head. State the renewal value with the uplift applied.'),

       jsonb_build_object(
         'key', 'find_the_recipient', 'kind', 'use_tool', 'work_kind', 'check',
         'title', 'Find who this goes to',
         'tool', 'read_contacts',
         'detail', 'Call read_contacts for this customer and identify who should receive the renewal notice — normally the decision maker, with the billing contact for anything about money. Name them: person, title, email. If nobody suitable is recorded, escalate to ask who it should be. Never invent a name or an address.'),

       jsonb_build_object(
         'key', 'record_the_position', 'kind', 'use_tool', 'work_kind', 'act',
         'title', 'Record the position on the case',
         'tool', 'write_back_to_case',
         'detail', 'Call write_back_to_case with op log_activity and a short factual summary of the position: value, uplift, driving date, days remaining, and the named recipient. Then call it again with op set_next_step and a next step with a date that falls BEFORE the driving deadline. These run without approval; if either comes back gated or blocked, report that and move on.'),

       jsonb_build_object(
         'key', 'prepare_the_notice', 'kind', 'use_tool', 'work_kind', 'act',
         'title', 'Prepare the renewal notice',
         'tool', 'produce_deliverable',
         'detail', 'Use produce_deliverable to write the renewal notice for a person to review: address it to the named recipient, state the renewal date, the value with any contractual increase applied, and what happens if no action is taken. Put real figures in it — no placeholders, and never a bracketed date.'),

       jsonb_build_object(
         'key', 'hand_it_over', 'kind', 'use_tool', 'work_kind', 'follow_up',
         'title', 'Hand it to a person to send',
         'tool', 'escalate_to_human',
         'detail', 'This workspace does not send customer messages automatically, so the motion ends with a person. Call escalate_to_human with the recipient, the deadline, the days remaining and where the drafted notice is, and propose that it be sent. This is a normal, successful end to the case — not a failure.'),

       jsonb_build_object(
         'key', 'sop_notes', 'kind', 'instruction',
         'title', 'Standing rules',
         'detail', 'Never commit to pricing or contract terms in writing. Escalate anything contentious or above your approval threshold. The case is not done until the record reflects it.')
     ))
 where key = 'renewal_manager';

-- Re-materialise for tenants already holding the prose copy. The published
-- version is what the compiler reads, so leaving the old snapshot in place
-- would mean the archetype changed and nothing did.
do $m$
declare r record; n int := 0;
begin
  for r in
    select pd.id as def_id, pd.tenant_id, a.sop_playbook
      from playbook_definitions pd
      join digital_employees d on d.id = pd.de_id
      join role_archetypes a on a.key = d.archetype_key
     where a.key = 'renewal_manager' and pd.status = 'published'
  loop
    update playbook_definitions
       set steps = r.sop_playbook->'steps', updated_at = now()
     where id = r.def_id;
    n := n + 1;
  end loop;
  raise notice '509: re-materialised % published renewal playbook(s)', n;
end $m$;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_steps jsonb; n_exec int; n_total int; n_def int;
begin
  select a.sop_playbook->'steps' into v_steps from role_archetypes a where a.key = 'renewal_manager';
  if v_steps is null then raise exception '509: the renewal SOP has no steps'; end if;

  select count(*), count(*) filter (where s->>'kind' = 'use_tool')
    into n_total, n_exec from jsonb_array_elements(v_steps) s;
  if n_exec = 0 then
    raise exception '509: the SOP is still 100%% prose — nothing would compile';
  end if;
  raise notice '509: renewal SOP is % executable of % steps', n_exec, n_total;

  -- Every executable step must name a tool the employee actually has. A step
  -- naming a tool that does not exist would compile into work the employee
  -- cannot finish — worse than prose, because it looks executable.
  if exists (
    select 1 from jsonb_array_elements(v_steps) s
     where s->>'kind' = 'use_tool'
       and coalesce(s->>'tool', '') not in
         ('none', 'compute', 'read_contacts', 'write_back_to_case',
          'produce_deliverable', 'escalate_to_human', 'search_knowledge', 'draft_outreach')
  ) then
    raise exception '509: a step names a tool outside the capability envelope';
  end if;

  -- Keys must be unique — the compiler builds its idempotency key from them,
  -- so a duplicate would silently drop a step.
  select count(*) into n_total from (
    select s->>'key' as k from jsonb_array_elements(v_steps) s where s->>'kind' = 'use_tool'
  ) x;
  select count(distinct k) into n_exec from (
    select s->>'key' as k from jsonb_array_elements(v_steps) s where s->>'kind' = 'use_tool'
  ) y;
  if n_total <> n_exec then
    raise exception '509: duplicate step keys — the compiler would drop steps silently';
  end if;

  -- And the tenant copy must actually carry the executable steps, or the
  -- archetype changed and the runtime did not.
  select count(*) into n_def
    from playbook_definitions pd
    join digital_employees d on d.id = pd.de_id
   where d.archetype_key = 'renewal_manager' and pd.status = 'published'
     and exists (select 1 from jsonb_array_elements(pd.steps) s where s->>'kind' = 'use_tool');
  if n_def = 0 then
    raise notice '509: archetype updated, but no published tenant copy carries it yet';
  else
    raise notice '509: % published tenant playbook(s) now hold executable steps', n_def;
  end if;
end $a$;
