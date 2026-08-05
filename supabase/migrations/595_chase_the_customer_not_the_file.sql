-- 595 — chase the customer, not the file.
--
-- Collections runs end to end for Stripe, Xero and QuickBooks: each has a
-- one-call "send this invoice" endpoint and the customer receives an email.
-- ERPNext was the exception. Its only executor posted an internal Comment on
-- the Sales Invoice — staff can read it, the customer never sees it. So in an
-- ERPNext workspace the whole chain could run to completion, a human could
-- approve a chase, a receipt could be written, and the person who owes the
-- money would hear nothing.
--
-- Every invoice in this workspace is ERPNext-sourced.
--
-- ── Three things this had to get right ─────────────────────────────────────
--
-- 1. THE NOTE TEXT IS NOT AN EMAIL. `dunning_note_text` (mig 590) is written
--    FOR A COLLEAGUE — "Restate the amount and the age, ask for a specific
--    payment date, and copy the account owner." Those are instructions to a
--    writer. Sending them to a customer would be embarrassing, and it is the
--    obvious mistake here: the text was sitting in a `note` param that the new
--    executor could have taken as a body. Customer-facing copy is written
--    separately below, and the two never share a field.
--
-- 2. THE CREDIT-HOLD RUNG MUST NEVER EMAIL. Rung 4's own recorded tone begins
--    "Do not contact the customer" — it is a recommendation put to a human with
--    the payment history, not an approach. It stays on the internal-note path
--    permanently, chosen by action_key rather than by whether an address
--    happens to exist.
--
-- 3. NO ADDRESS MEANS NO EMAIL, SAID OUT LOUD. `customer_account_contacts` has
--    an email column and zero rows, and neither `renewal_invoices` nor
--    `customer_accounts` carried one — there was no recipient anywhere in the
--    platform. It now syncs from the invoice's own `contact_email`. Where that
--    is still empty the chase falls back to the internal note and the approval
--    SAYS which of the two it is, because "approve" must not sometimes mean
--    "email a customer" and sometimes mean "write a note nobody sees".
--
-- Nothing here sends anything on its own. Every rung is `requires_approval`,
-- the gate marks these destructive, and a human sees the recipient, the
-- subject and the exact body before deciding.

begin;

-- ── Somewhere to keep the addressee ────────────────────────────────────────

alter table renewal_invoices add column if not exists contact_email text;

-- ⚠ DROP THE OLD ARITY EXPLICITLY. Adding a parameter with a default does NOT
-- replace a function — it creates a SECOND one, both match the old call shape,
-- and PostgREST then refuses to choose between them ("Could not choose the best
-- candidate function"). That is how mig 377 turned an export into a silent
-- rows_exported: 0. The body below is generated from the live definition
-- (pg_get_functiondef), not retyped, so nothing already in it is lost.
drop function if exists upsert_external_ar_record(uuid, text, text, text, text, bigint, date, text, text, bigint);

create or replace function upsert_external_ar_record(
  p_tenant_id uuid, p_provider text, p_customer_external_ref text, p_customer_name text,
  p_invoice_external_ref text, p_amount_cents bigint, p_due_date date, p_status text,
  p_currency text, p_outstanding_cents bigint default null::bigint,
  p_contact_email text default null::text
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_account_id uuid;
  v_invoice_id uuid;
  v_status text;
begin
  if p_tenant_id is null or coalesce(p_provider,'') = ''
     or coalesce(p_invoice_external_ref,'') = '' or coalesce(p_customer_external_ref,'') = '' then
    raise exception 'tenant, provider, customer ref and invoice ref are all required';
  end if;

  v_status := case when p_status in ('pending_generation','awaiting_approval','sent','paid','overdue')
                   then p_status else 'sent' end;

  insert into customer_accounts (tenant_id, name, external_ref, source_provider, source_external_ref)
  values (p_tenant_id,
          coalesce(nullif(p_customer_name,''), p_customer_external_ref),
          p_customer_external_ref, p_provider, p_customer_external_ref)
  on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
  do update set name = excluded.name, external_ref = excluded.external_ref, updated_at = now()
  returning id into v_account_id;

  insert into renewal_invoices (tenant_id, account_id, amount_cents, status, due_date, cadence_stage,
                                source_provider, source_external_ref, source_currency,
                                outstanding_cents, payments_reconciled_at, contact_email)
  values (p_tenant_id, v_account_id, coalesce(p_amount_cents, 0), v_status, p_due_date, 0,
          p_provider, p_invoice_external_ref, p_currency,
          p_outstanding_cents,
          -- Only stamp "we know the balance" when the source actually said so.
          case when p_outstanding_cents is not null then now() end,
          nullif(btrim(p_contact_email), ''))
  on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
  do update set account_id = excluded.account_id, amount_cents = excluded.amount_cents,
                status = excluded.status, due_date = excluded.due_date,
                source_currency = excluded.source_currency,
                -- A later sync that omits the balance must not ERASE a balance
                -- we already knew — but a sync that states one always wins,
                -- because the ledger is the authority on what is owed.
                outstanding_cents = coalesce(excluded.outstanding_cents, renewal_invoices.outstanding_cents),
                payments_reconciled_at = case
                  when excluded.outstanding_cents is not null then now()
                  else renewal_invoices.payments_reconciled_at end,
                -- Same rule for the addressee: a sync that did not mention it
                -- must not silently downgrade the next chase from an email to
                -- an internal note.
                contact_email = coalesce(excluded.contact_email, renewal_invoices.contact_email),
                updated_at = now()
  returning id into v_invoice_id;

  return jsonb_build_object('account_id', v_account_id, 'invoice_id', v_invoice_id,
                            'outstanding_known', p_outstanding_cents is not null,
                            'can_email', nullif(btrim(coalesce(p_contact_email,'')), '') is not null);
end;
$function$;

grant execute on function upsert_external_ar_record(uuid, text, text, text, text, bigint, date, text, text, bigint, text) to service_role;

do $a$
begin
  -- One function, one arity. Two would make every caller ambiguous.
  if (select count(*) from pg_proc where proname = 'upsert_external_ar_record') <> 1 then
    raise exception 'upsert_external_ar_record exists at % arities — callers will break',
      (select count(*) from pg_proc where proname = 'upsert_external_ar_record');
  end if;
end;
$a$;

-- ── What the customer actually reads ───────────────────────────────────────
-- Deliberately plain. No threats, no apology, no invented account manager, and
-- no promise the platform cannot keep. Each stage states the same facts and
-- changes only in firmness.

create or replace function dunning_email(
  p_stage integer, p_customer text, p_invoice_ref text, p_days_overdue integer,
  p_outstanding_cents bigint, p_currency text, p_due_date date, p_from_org text
) returns jsonb
language sql immutable set search_path = public as $$
  select case coalesce(p_stage, 1)
    when 1 then jsonb_build_object(
      'subject', format('Invoice %s — payment reminder', p_invoice_ref),
      'body', format(E'Dear %s,\n\nThis is a reminder that invoice %s for %s was due on %s and is showing as unpaid on our records.\n\nIf payment is already on its way, please ignore this message. If not, we would be grateful if you could let us know when we can expect it — or tell us if something about the invoice needs resolving.\n\nThank you,\n%s',
        p_customer, p_invoice_ref, money_text(p_outstanding_cents, p_currency),
        to_char(p_due_date, 'FMDD FMMonth YYYY'), p_from_org))
    when 2 then jsonb_build_object(
      'subject', format('Invoice %s — now %s days overdue', p_invoice_ref, p_days_overdue),
      'body', format(E'Dear %s,\n\nWe are following up on invoice %s, which was due on %s and is now %s days past due. %s remains outstanding.\n\nCould you confirm the date on which payment will be made? If there is a problem with the invoice, please tell us so that we can put it right.\n\nThank you,\n%s',
        p_customer, p_invoice_ref, to_char(p_due_date, 'FMDD FMMonth YYYY'), p_days_overdue,
        money_text(p_outstanding_cents, p_currency), p_from_org))
    when 3 then jsonb_build_object(
      'subject', format('Final notice — invoice %s', p_invoice_ref),
      'body', format(E'Dear %s,\n\nInvoice %s was due on %s and is now %s days past due. %s remains outstanding, and our earlier reminders have not been answered.\n\nPlease arrange payment within 7 days of this message. If payment is not received we will place the account on hold while the matter is resolved.\n\nIf you believe this notice is in error, please contact us straight away and we will look into it.\n\nRegards,\n%s',
        p_customer, p_invoice_ref, to_char(p_due_date, 'FMDD FMMonth YYYY'), p_days_overdue,
        money_text(p_outstanding_cents, p_currency), p_from_org))
    -- Stage 4 is a credit-hold recommendation put to a human. There is no
    -- customer-facing message for it, and returning null here is what makes
    -- accidentally emailing it impossible rather than merely unlikely.
    else null
  end;
$$;

grant execute on function dunning_email(integer, text, text, integer, bigint, text, date, text) to authenticated, service_role;

-- ── Register the send ──────────────────────────────────────────────────────

-- ⚠ destructive = TRUE, unlike the internal-note definitions it sits beside
-- (which are correctly `false` — a note can be deleted and nobody outside the
-- company ever saw it). An email cannot be recalled. `decide_action_execution`
-- treats destructive as a platform safety floor that ALWAYS gates to a human
-- regardless of the employee's trust level, which is the behaviour this needs.
--
-- Every param is REQUIRED. An optional param in a binding fails 100% of the
-- time it is omitted, and the executor refuses without all four — better to be
-- rejected by the schema than to be approved and then fail on send.
insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, execution, status, risk, param_schema, reversible)
select 'platform', null, 'erp_financials', k.action_key, k.label,
       'Emails the customer about this invoice through ERPNext and files the message against the invoice, so the chase appears on the document''s own timeline.',
       'erpnext',
       jsonb_build_object('execution_key', 'erpnext_send_invoice_email'),
       'active',
       jsonb_build_object('destructive', true, 'idempotent', false),
       jsonb_build_array(
         jsonb_build_object('name','external_ref','type','string','required',true,'help','The invoice number in the ERP'),
         jsonb_build_object('name','recipient','type','string','required',true,'help','The customer email address the chase is sent to'),
         jsonb_build_object('name','subject','type','string','required',true,'help','Subject line'),
         jsonb_build_object('name','body','type','string','required',true,'help','The message the customer reads')),
       false
from (values
  ('send_payment_reminder', 'Email the customer a payment reminder'),
  ('send_final_notice',     'Email the customer a final notice')
) as k(action_key, label)
where not exists (
  select 1 from action_definitions ad
  where ad.action_key = k.action_key and ad.tenant_id is null
    and ad.execution->>'execution_key' = 'erpnext_send_invoice_email');

-- ── Choosing the channel ───────────────────────────────────────────────────
-- 589's resolver prefix-matched the provider (`execution_key like 'erpnext%'`).
-- That was unambiguous when ERPNext had one executor. It now has two, and a
-- prefix match would pick whichever was created first — which is exactly the
-- class of bug where a chase silently becomes a note. The channel is now
-- decided explicitly and the executor is matched exactly.

create or replace function dunning_execution_key(
  p_provider text, p_action_key text, p_has_recipient boolean
) returns text
language sql immutable set search_path = public as $$
  select case
    -- Chosen by RUNG, not by whether an address happens to exist. The
    -- credit-hold rung's own tone says "Do not contact the customer", and that
    -- must not become negotiable the day a contact_email turns up.
    when p_action_key = 'flag_for_collections' then p_provider || '_invoice_comment'
    when p_provider = 'erpnext' and coalesce(p_has_recipient, false) then 'erpnext_send_invoice_email'
    when p_provider = 'erpnext' then 'erpnext_invoice_comment'
    -- Stripe, Xero and QuickBooks already email on their reminder endpoint.
    when p_action_key = 'send_payment_reminder' then p_provider || '_send_invoice_reminder'
    -- Anything else has no executor for this provider. Returning null makes
    -- the sweep report `no_executor` rather than raise an approval nothing can
    -- carry out.
    else null
  end;
$$;

grant execute on function dunning_execution_key(text, text, boolean) to authenticated, service_role;

drop function if exists dunning_action_for(uuid, text, text);

create or replace function dunning_action_for(
  p_tenant_id uuid, p_action_key text, p_execution_key text
) returns uuid
language sql stable security definer set search_path = public as $$
  select ad.id
  from action_definitions ad
  where ad.action_key = p_action_key
    and ad.status = 'active'
    and (ad.tenant_id = p_tenant_id or ad.tenant_id is null)
    -- An empty `execution` means nothing happens when a human approves it.
    and coalesce(ad.execution->>'execution_key', '') = coalesce(p_execution_key, '')
    and coalesce(p_execution_key, '') <> ''
  order by (ad.tenant_id is not null) desc, ad.created_at asc
  limit 1;
$$;

grant execute on function dunning_action_for(uuid, text, text) to authenticated, service_role;

-- ── The sweep, now channel-aware ───────────────────────────────────────────

create or replace function run_dunning_sweep(
  p_tenant_id uuid default null,
  p_limit     integer default 200
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t          record;
  inv        record;
  v_de       uuid;
  v_ad       uuid;
  v_provider text;
  v_exec     text;
  v_dedupe   text;
  v_note     text;
  v_mail     jsonb;
  v_emails   boolean;
  v_org      text;
  v_params   jsonb;
  v_gate     jsonb;
  v_decision text;
  v_content  text;
  v_detail_txt text;
  v_raised   int := 0;
  v_skipped  int := 0;
  v_noexec   int := 0;
  v_nodesk   int := 0;
  v_emailed  int := 0;
  v_noaddr   int := 0;
  v_tenants  int := 0;
  v_detail   jsonb := '[]'::jsonb;
begin
  for t in
    select tn.id, tn.slug, tn.name from tenants tn
    where (p_tenant_id is null or tn.id = p_tenant_id)
      and tenant_is_operational(tn.id)
  loop
    v_de := dunning_de_for(t.id);
    if v_de is null then
      v_nodesk := v_nodesk + 1;
      continue;
    end if;
    v_tenants := v_tenants + 1;
    v_org := coalesce(nullif(t.name, ''), 'Accounts Receivable');

    for inv in
      select d.*, ri.source_provider, ri.source_currency, ri.due_date, ri.contact_email
      from dunning_position(t.id) d
      join renewal_invoices ri on ri.id = d.invoice_id
      where d.actionable
      order by d.days_overdue desc
      limit p_limit
    loop
      v_provider := coalesce(nullif(inv.source_provider, ''), 'erpnext');
      v_dedupe   := format('dunning:%s:%s', inv.invoice_id, inv.due_stage);

      if exists (
        select 1 from action_executions ae
        where ae.tenant_id = t.id and ae.dedupe_key = v_dedupe and ae.decision <> 'failed'
      ) then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_exec := dunning_execution_key(v_provider, inv.action_key,
                                      nullif(btrim(coalesce(inv.contact_email,'')), '') is not null);
      v_ad   := dunning_action_for(t.id, inv.action_key, v_exec);
      if v_ad is null then
        v_noexec := v_noexec + 1;
        v_detail := v_detail || jsonb_build_object(
          'tenant', t.slug, 'invoice', inv.invoice_ref, 'skipped', 'no_executor',
          'wanted', inv.action_key, 'provider', v_provider, 'execution_key', v_exec);
        continue;
      end if;

      v_emails := (v_exec = 'erpnext_send_invoice_email'
                   or v_exec like '%_send_invoice_reminder');
      v_note   := dunning_note_text(inv.due_stage, inv.customer, inv.invoice_ref,
                                    inv.days_overdue, inv.outstanding_cents, inv.source_currency);
      v_mail   := dunning_email(inv.due_stage, inv.customer, inv.invoice_ref, inv.days_overdue,
                                inv.outstanding_cents, inv.source_currency, inv.due_date, v_org);

      -- The internal note and the customer email are built from the same facts
      -- but are never the same string. The note tells a colleague how to pitch
      -- it; the email is what a customer reads.
      if v_emails and v_mail is not null then
        v_params := jsonb_build_object(
          'external_ref', inv.invoice_ref,
          'recipient',    inv.contact_email,
          'subject',      v_mail->>'subject',
          'body',         v_mail->>'body',
          'invoice_id',   inv.invoice_id, 'stage', inv.due_stage,
          'days_overdue', inv.days_overdue, 'outstanding_cents', inv.outstanding_cents);
        v_content := v_mail->>'body';
        v_detail_txt := format(E'%s\n\nThis EMAILS THE CUSTOMER at %s.\n\nSubject: %s\n\n%s',
                          inv.why, inv.contact_email, v_mail->>'subject', v_mail->>'body');
        v_emailed := v_emailed + 1;
      else
        -- No address, or a rung that must not reach the customer.
        v_params := jsonb_build_object(
          'external_ref', inv.invoice_ref, 'note', v_note,
          'invoice_id',   inv.invoice_id, 'stage', inv.due_stage,
          'days_overdue', inv.days_overdue, 'outstanding_cents', inv.outstanding_cents,
          'tone', inv.tone);
        v_content := v_note;
        if inv.action_key <> 'flag_for_collections'
           and nullif(btrim(coalesce(inv.contact_email,'')), '') is null then
          v_noaddr := v_noaddr + 1;
          v_detail_txt := format(E'%s\n\n⚠ THE CUSTOMER WILL NOT SEE THIS. No email address is recorded on invoice %s, so this writes an internal note in ERPNext instead of chasing anyone. Add a contact email to the invoice and re-run to send a real reminder.\n\nWhat will be written:\n%s',
                            inv.why, inv.invoice_ref, v_note);
        else
          v_detail_txt := format(E'%s\n\nInternal note only — the customer is not contacted at this stage.\n\nWhat will be written:\n%s',
                            inv.why, v_note);
        end if;
      end if;

      v_gate := decide_action_execution(
        t.id,
        format('%s — %s', inv.rung_label, inv.customer),
        'erp_financials',
        coalesce(inv.requires_approval, true),
        v_de,
        inv.outstanding_cents,
        inv.action_key,
        -- Guardrails scan the CONTENT, so they must see the words that will
        -- actually leave the building, not a summary of them.
        v_content
      );
      v_decision := coalesce(v_gate->>'decision', 'human_gated_destructive');

      perform record_action_execution(
        p_tenant_id            => t.id,
        p_action_definition_id => v_ad,
        p_connector_id         => null,
        p_subject_kind         => 'de',
        p_subject_id           => v_de,
        p_mode                 => 'execute',
        p_params               => v_params,
        p_decision      => v_decision,
        p_destructive   => coalesce(inv.requires_approval, true),
        p_idempotent    => false,
        p_dedupe_key    => v_dedupe,
        p_request_summary => format('%s for %s — invoice %s, %s day(s) overdue.%s',
                              inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue,
                              case when v_emails and v_mail is not null
                                   then ' Emails the customer.' else ' Internal note only.' end),
        p_receipt   => null,
        p_result    => null,
        p_task_title  => format('%s%s: %s — %s, %s days overdue',
                           case when v_emails and v_mail is not null then 'Email ' else '' end,
                           inv.rung_label, inv.customer, inv.invoice_ref, inv.days_overdue),
        p_task_detail => v_detail_txt,
        p_create_task => true,
        p_origin_kind => 'dunning_sweep',
        p_origin_id   => inv.invoice_id
      );

      v_raised := v_raised + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'tenants_swept',      v_tenants,
    'raised',             v_raised,
    'emails_drafted',     v_emailed,
    'notes_only_no_address', v_noaddr,
    'already_proposed',   v_skipped,
    'no_executor',        v_noexec,
    'tenants_without_a_finance_employee', v_nodesk,
    'detail',             v_detail
  );
end;
$$;

grant execute on function run_dunning_sweep(uuid, integer) to service_role;

commit;
