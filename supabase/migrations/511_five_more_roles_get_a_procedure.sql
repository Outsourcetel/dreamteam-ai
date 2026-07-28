-- 511_five_more_roles_get_a_procedure.sql
-- ============================================================================
-- The renewal role proved the mechanism (mig 509 + the SOP compiler). These are
-- the other five, authored the same way — which is the point: this is a row of
-- config per role, not a code change.
--
-- ── AUTHORED AGAINST TWO DIFFERENT ENVELOPES, NOT ONE ──────────────────────
-- The roles split by what their work is ABOUT, and the SOPs must respect it:
--
--   RECORD-DRIVEN (cs_manager, onboarding) — their cases carry a customer
--   account, so the desk resolves the record and they get read_contacts and
--   write_back_to_record. They can name a person and update the account.
--
--   SCHEDULE-DRIVEN (billing_ar, accounting, fpa) — their work is a shift, not
--   a case. The desk has no record to resolve; they get their role's WORKLISTS
--   instead (mig 505). They must NOT be told to write back to a record that
--   does not exist for them, and every one of their SOPs states explicitly that
--   an empty book is a finished shift — otherwise they escalate for access they
--   already have, which is the exact failure 505 fixed.
--
-- ── AND THE HONEST STOPS ───────────────────────────────────────────────────
-- Nothing here drafts or sends a customer message: channels are closed under
-- founder decision N5, so every motion that would end in contact ends instead
-- at a prepared document plus an escalation naming who should send it. Each SOP
-- says so in the step itself, so the employee stops deliberately rather than
-- discovering a wall.
--
-- Ships global via role_archetypes (platform-level; the pattern of migs 497,
-- 502, 505 and 509) and re-materialises the tenant copies below.
-- ============================================================================

-- ── ACCOUNT SUCCESS (record-driven) ─────────────────────────────────────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Account Health SOP',
  'steps', jsonb_build_array(
    jsonb_build_object('key','confirm_the_account','kind','use_tool','work_kind','check',
      'title','Confirm the account on the desk','tool','none',
      'detail','Your desk holds this account: name, tier, value, health, status and renewal date. State them. If the health score is marked not measured, say so — it means nothing has been recorded to compute it from, NOT that the account is fine. If the record is not on your desk, escalate rather than proceeding.'),
    jsonb_build_object('key','read_the_signals','kind','use_tool','work_kind','check',
      'title','Work out what the health actually reflects','tool','search_knowledge',
      'detail','Explain what is driving this account state in plain terms. If there is no ticket, invoice or activity history behind the score, say that plainly — an account with no history is unknown, not healthy. Do not invent a cause.'),
    jsonb_build_object('key','find_the_relationship','kind','use_tool','work_kind','check',
      'title','Find who holds the relationship','tool','read_contacts',
      'detail','Call read_contacts and name the executive sponsor and the day-to-day contact: person, title, email. If nobody is recorded, escalate to ask who owns this relationship. Never invent a name.'),
    jsonb_build_object('key','record_the_position','kind','use_tool','work_kind','act',
      'title','Record the position on the account','tool','write_back_to_record',
      'detail','Call write_back_to_record with op log_activity and a factual summary of where this account stands and why. Then call it again with op set_next_step, giving a next step and a date. If either comes back gated, report that and move on — it is a normal outcome, not a failure.'),
    jsonb_build_object('key','prepare_the_check_in','kind','use_tool','work_kind','act',
      'title','Prepare the check-in for a person to send','tool','produce_deliverable',
      'detail','Write a short check-in addressed to the named contact: what you observed, what you propose, and what you need from them. Real figures only, no placeholders.'),
    jsonb_build_object('key','hand_it_over','kind','use_tool','work_kind','follow_up',
      'title','Hand it to a person','tool','escalate_to_human',
      'detail','This workspace does not send customer messages automatically. Escalate with the recipient, what you prepared and why it matters now. This is a successful end to the case, not a failure.')
  )) where key = 'cs_manager';

-- ── ONBOARDING (record-driven, with a book for its scheduled sweeps) ────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Onboarding Progress SOP',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_book','kind','use_tool','work_kind','check',
      'title','Open the account or the onboarding book','tool','none',
      'detail','If this is about one account, your desk holds it — state where it stands. If this is a scheduled sweep, your books are listed in front of you. If a book is empty, that is a COMPLETE answer: record that there is nothing to work today and finish. Do not escalate for access you have already been given.'),
    jsonb_build_object('key','assess_progress','kind','use_tool','work_kind','check',
      'title','Assess where onboarding actually stands','tool','compute',
      'detail','For each project or account in scope, state how far along it is and how long it has been since anything moved. Use compute for any elapsed-time arithmetic — never work out dates in your head. Name the ones that have stalled.'),
    jsonb_build_object('key','find_the_owner','kind','use_tool','work_kind','check',
      'title','Find who to chase','tool','read_contacts',
      'detail','Call read_contacts and name the person on the customer side who owns this: person, title, email. If nobody is recorded, escalate to ask. Never invent a name.'),
    jsonb_build_object('key','record_the_status','kind','use_tool','work_kind','act',
      'title','Record the status where it belongs','tool','write_back_to_record',
      'detail','Call write_back_to_record with op log_activity summarising the position, then op set_next_step with a dated next action. If gated, report it and move on.'),
    jsonb_build_object('key','prepare_the_update','kind','use_tool','work_kind','act',
      'title','Prepare the status update','tool','produce_deliverable',
      'detail','Write the onboarding status for a person to review and send: what is done, what is blocked, what you need and by when. Real dates, no placeholders.'),
    jsonb_build_object('key','hand_it_over','kind','use_tool','work_kind','follow_up',
      'title','Hand it to a person','tool','escalate_to_human',
      'detail','Escalate with the recipient and the blockers. Ending here is correct — this workspace does not send customer messages automatically.')
  )) where key = 'onboarding';

-- ── BILLING & AR (schedule-driven) ──────────────────────────────────────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Receivables Sweep SOP',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_book','kind','use_tool','work_kind','check',
      'title','Open the receivables book','tool','none',
      'detail','Your books are listed in front of you: invoices past due, and invoices issued and unpaid. State how many are in each. IF BOTH ARE EMPTY, that is a complete and correct sweep — record that receivables are clear and finish. Do not escalate for access you already have.'),
    jsonb_build_object('key','assess_each_item','kind','use_tool','work_kind','check',
      'title','Assess what each overdue item needs','tool','compute',
      'detail','For each invoice past due, state the customer, the amount and how many days overdue — use compute for the arithmetic, never your own. Group them by how far overdue they are, because that decides the tone of the chase.'),
    jsonb_build_object('key','prepare_the_chase','kind','use_tool','work_kind','act',
      'title','Prepare the collection summary','tool','produce_deliverable',
      'detail','Write the collection summary for a person: who owes what, for how long, and what you propose for each. Real figures only. If the book was empty, skip this step and say so.'),
    jsonb_build_object('key','hand_it_over','kind','use_tool','work_kind','follow_up',
      'title','Hand anything needing a person over','tool','escalate_to_human',
      'detail','Escalate anything that needs a decision or a customer contact — this workspace does not send messages automatically. If nothing is outstanding, do not escalate: simply finish and report the book was clear.')
  )) where key = 'billing_ar';

-- ── ACCOUNTING (schedule-driven) ────────────────────────────────────────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Ledger Reconciliation SOP',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_books','kind','use_tool','work_kind','check',
      'title','Open the ledger books','tool','none',
      'detail','Your books are in front of you: journal entries for this month, and invoices issued and unpaid. State the counts. IF THEY ARE EMPTY, that is a complete answer — record that there was nothing to reconcile and finish. Never escalate asking for access to a book you have been shown.'),
    jsonb_build_object('key','reconcile','kind','use_tool','work_kind','check',
      'title','Reconcile what is there','tool','compute',
      'detail','Total the debits and credits and state whether they balance — use compute, never mental arithmetic. Name any entry that looks unmatched or out of period. If there is nothing to reconcile, say so rather than describing a process.'),
    jsonb_build_object('key','prepare_the_note','kind','use_tool','work_kind','act',
      'title','Prepare the reconciliation note','tool','produce_deliverable',
      'detail','Write the reconciliation note: what was checked, what balanced, and every discrepancy with its amount. Real figures only. Skip this step and say so if there was nothing to check.'),
    jsonb_build_object('key','raise_discrepancies','kind','use_tool','work_kind','follow_up',
      'title','Raise anything that does not balance','tool','escalate_to_human',
      'detail','Escalate any discrepancy with the amount and what you think caused it. If everything balanced or the books were empty, do not escalate — finish and report it.')
  )) where key = 'accounting';

-- ── FINANCE / FP&A (schedule-driven) ────────────────────────────────────────
update public.role_archetypes set sop_playbook = jsonb_build_object(
  'name', 'Finance Position SOP',
  'steps', jsonb_build_array(
    jsonb_build_object('key','open_the_books','kind','use_tool','work_kind','check',
      'title','Open the finance books','tool','none',
      'detail','Your books are in front of you: invoices issued and unpaid, and journal entries this month. State the counts. IF THEY ARE EMPTY, record that there is nothing to report this period and finish — that is a complete answer, not a blocked one.'),
    jsonb_build_object('key','compute_the_position','kind','use_tool','work_kind','check',
      'title','Work out the position','tool','compute',
      'detail','State receivables outstanding and the movement in the ledger this period. Use compute for every figure. Where a number cannot be derived from the books in front of you, say it is not available rather than estimating it.'),
    jsonb_build_object('key','prepare_the_summary','kind','use_tool','work_kind','act',
      'title','Prepare the position summary','tool','produce_deliverable',
      'detail','Write the finance summary: the position, what moved, and what is missing to complete the picture. Real figures only — never an illustrative number.'),
    jsonb_build_object('key','flag_what_is_missing','kind','use_tool','work_kind','follow_up',
      'title','Flag what you could not see','tool','escalate_to_human',
      'detail','Escalate naming the specific data you would need to give a complete position. If the books were empty, say that plainly instead — an empty book is an answer, not a blocker.')
  )) where key = 'fpa';

-- ── re-materialise the tenant copies ────────────────────────────────────────
do $m$
declare r record; n int := 0;
begin
  for r in
    select pd.id as def_id, a.sop_playbook
      from playbook_definitions pd
      join digital_employees d on d.id = pd.de_id
      join role_archetypes a on a.key = d.archetype_key
     where a.key in ('cs_manager','onboarding','billing_ar','accounting','fpa')
       and pd.status = 'published'
  loop
    update playbook_definitions set steps = r.sop_playbook->'steps', updated_at = now() where id = r.def_id;
    n := n + 1;
  end loop;
  raise notice '511: re-materialised % published playbook(s)', n;
end $m$;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  r record; n_exec int; n_bad int; n_roles int := 0; n_defs int;
begin
  for r in select key, sop_playbook->'steps' as steps from role_archetypes
            where key in ('cs_manager','onboarding','billing_ar','accounting','fpa')
  loop
    select count(*) filter (where s->>'kind' = 'use_tool') into n_exec
      from jsonb_array_elements(r.steps) s;
    if n_exec = 0 then
      raise exception '511: % is still all prose — nothing would compile', r.key;
    end if;

    -- Every named tool must be inside the capability envelope. A step naming a
    -- tool the employee does not have compiles into work it cannot finish,
    -- which is worse than prose because it looks executable.
    select count(*) into n_bad from jsonb_array_elements(r.steps) s
     where s->>'kind' = 'use_tool'
       and coalesce(s->>'tool','') not in ('none','compute','search_knowledge','read_contacts',
             'write_back_to_record','write_back_to_case','produce_deliverable','escalate_to_human');
    if n_bad > 0 then
      raise exception '511: % names % tool(s) outside the envelope', r.key, n_bad;
    end if;

    -- A SCHEDULE-driven role has no record desk, so telling it to write back to
    -- one would send it looking for something it will never have.
    if r.key in ('billing_ar','accounting','fpa') then
      select count(*) into n_bad from jsonb_array_elements(r.steps) s
       where coalesce(s->>'tool','') like 'write_back%';
      if n_bad > 0 then
        raise exception '511: % is schedule-driven but has % write-back step(s)', r.key, n_bad;
      end if;
      -- ...and it must be told that an empty book is a finished shift, or it
      -- will escalate for access it already has (the failure mig 505 fixed).
      if not exists (select 1 from jsonb_array_elements(r.steps) s
                      where s->>'detail' ilike '%empty%') then
        raise exception '511: % never tells the employee an empty book is an answer', r.key;
      end if;
    end if;

    -- Keys must be unique — the compiler builds its idempotency key from them.
    select count(*) - count(distinct s->>'key') into n_bad from jsonb_array_elements(r.steps) s
     where s->>'kind' = 'use_tool';
    if n_bad <> 0 then
      raise exception '511: % has duplicate step keys — steps would be dropped silently', r.key;
    end if;

    n_roles := n_roles + 1;
  end loop;

  if n_roles <> 5 then raise exception '511: expected 5 roles, checked %', n_roles; end if;

  select count(*) into n_defs
    from playbook_definitions pd join digital_employees d on d.id = pd.de_id
   where d.archetype_key in ('cs_manager','onboarding','billing_ar','accounting','fpa')
     and pd.status = 'published'
     and exists (select 1 from jsonb_array_elements(pd.steps) s where s->>'kind' = 'use_tool');
  raise notice '511: 5 role SOPs are executable; % published tenant copies carry them', n_defs;
end $a$;
