-- 596 — say which kind of chase this is.
--
-- Two collections approvals are already sitting in someone's queue. They were
-- drafted before an email path existed, when there was only one thing a chase
-- could be, so their detail says "What will be written: …" and never states
-- whether approving it reaches the customer or writes a note only staff see.
--
-- That was unambiguous when only one channel existed. It is not any more, and
-- "approve" must never sometimes mean "email a customer" and sometimes mean
-- "write a note nobody outside the company reads". The two tasks are still
-- pending, so nobody has acted on the ambiguity — this closes it before they do.
--
-- Only the wording changes. No decision is made, no params are touched, and a
-- task that has already been decided is left exactly as it was: rewriting the
-- text a person actually approved would falsify the record of what they agreed
-- to, which is the one thing an approval queue must never do.

begin;

do $fix$
declare r record; v_new text;
begin
  for r in
    select h.id, h.detail, ae.params, ri.contact_email, ri.source_external_ref
    from human_tasks h
    join action_executions ae on ae.task_id = h.id
    left join renewal_invoices ri on ri.id = (ae.params->>'invoice_id')::uuid
    where ae.dedupe_key like 'dunning:%'
      and h.status = 'pending'
      and h.detail not like '%THE CUSTOMER%'
      and h.detail not like '%Internal note only%'
  loop
    if r.params ? 'recipient' then
      -- Shouldn't arise for these two, but a chase that DOES email must say so
      -- rather than inherit the note wording by omission.
      v_new := replace(r.detail, 'What will be written:',
                 format('This EMAILS THE CUSTOMER at %s.%sWhat will be written:',
                        r.params->>'recipient', E'\n\n'));
    elsif nullif(btrim(coalesce(r.contact_email, '')), '') is null then
      v_new := replace(r.detail, 'What will be written:',
                 format('⚠ THE CUSTOMER WILL NOT SEE THIS. No email address is recorded for invoice %s, so approving writes an internal note in ERPNext rather than chasing anyone. Set a primary contact with an email on the customer in ERPNext and the next sweep will send a real reminder.%sWhat will be written:',
                        coalesce(r.source_external_ref, 'this invoice'), E'\n\n'));
    else
      v_new := replace(r.detail, 'What will be written:',
                 format('Internal note only — the customer is not contacted at this rung.%sWhat will be written:', E'\n\n'));
    end if;

    if v_new is distinct from r.detail then
      update human_tasks set detail = v_new, updated_at = now() where id = r.id;
    end if;
  end loop;
end;
$fix$;

commit;
