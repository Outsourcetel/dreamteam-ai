-- ============================================================
-- Migration 085: checks in the exact live bodies of 3 functions that
-- have existed in production with NO corresponding CREATE FUNCTION
-- anywhere in supabase/migrations/*.sql — first flagged during the
-- anon-grant sweep (migration 079's own header comment), re-confirmed
-- with zero new instances found during the 2026-07-08 pre-launch
-- readiness review. Bodies pulled verbatim via pg_get_functiondef and
-- checked in byte-for-byte (CREATE OR REPLACE is a no-op against the
-- live definition — this migration changes zero behavior).
--
-- Why this matters: without this, a from-scratch replay of
-- supabase/migrations/*.sql against an empty database would NOT
-- recreate these three functions, even though several later
-- migrations (e.g. 080's grant sweep) already reference and depend on
-- them existing. This closes that specific disaster-recovery gap.
--
-- Grants match what migration 080 already set for these three (revoke
-- from public, explicit grant to authenticated + service_role) — this
-- migration does not change grants, only adds the missing DDL.
-- ============================================================

create or replace function public.detect_exceptions(p_tenant_id uuid, p_workspace_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller uuid;
  v_period_end date;
  v_count int := 0;
begin
  v_caller := auth_tenant_id();
  if v_caller is distinct from p_tenant_id and not is_platform_admin() then
    raise exception 'tenant mismatch';
  end if;

  select period_end into v_period_end from public.close_workspaces where id = p_workspace_id and tenant_id = p_tenant_id;

  delete from public.exceptions where tenant_id = p_tenant_id and workspace_id = p_workspace_id and status = 'open';

  -- 1) UNMATCHED BANK TRANSACTIONS
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'unmatched_bank_txn',
    case when abs(bt.amount) >= 10000 then 'high' when abs(bt.amount) >= 1000 then 'medium' else 'low' end,
    'Unmatched bank transaction: '||left(bt.description,40),
    'Bank line of '||bt.amount||' on '||bt.txn_date||' has no matching payment record.',
    bt.amount, bt.account_id, 'bank_transactions', bt.id,
    'No payment row links to this bank line; it is uncleared in the ledger.',
    0.82, 'Investigate and match to a payment, or create an adjusting entry.', false, 'open'
  from public.bank_transactions bt
  where bt.tenant_id = p_tenant_id and bt.workspace_id = p_workspace_id and bt.is_matched = false and bt.matched_payment_id is null;

  -- 2) DUPLICATE BILLS (same vendor + amount; flag the later one only)
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'duplicate_invoice', 'high',
    'Possible duplicate bill: '||b.bill_number,
    'Another bill with the same vendor and amount ('||b.amount||') exists in this period.',
    b.amount, b.account_id, 'bills', b.id,
    'Two bills share vendor_id and amount within the same close window, a strong duplicate signal.',
    0.88, 'Confirm whether this is a true duplicate before payment; void if confirmed.', true, 'open'
  from public.bills b
  where b.tenant_id = p_tenant_id and b.workspace_id = p_workspace_id
    and exists (
      select 1 from public.bills b2 where b2.tenant_id = b.tenant_id and b2.workspace_id = b.workspace_id
        and b2.id <> b.id and b2.vendor_id = b.vendor_id and b2.amount = b.amount
        and b2.id::text < b.id::text
    );

  -- 3) MISSING RECEIPTS
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'missing_receipt',
    case when b.amount >= 5000 then 'high' else 'medium' end,
    'Missing receipt: '||b.bill_number,
    'Bill of '||b.amount||' has no supporting receipt attached.',
    b.amount, b.account_id, 'bills', b.id,
    'has_receipt is false; audit evidence is incomplete for this expense.',
    0.79, 'Request and attach the receipt before close.', false, 'open'
  from public.bills b
  where b.tenant_id = p_tenant_id and b.workspace_id = p_workspace_id and b.has_receipt = false;

  -- 4) UNUSUAL SPEND
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'unusual_spend', 'high',
    'Unusual spend: '||left(bt.description,40),
    'Large outbound transfer of '||bt.amount||' on '||bt.txn_date||
      case when extract(dow from bt.txn_date) in (0,6) then ' (weekend)' else '' end||
      case when (abs(bt.amount)::numeric % 1000) = 0 then ' (round-number)' else '' end||'.',
    bt.amount, bt.account_id, 'bank_transactions', bt.id,
    'Outbound amount far exceeds typical spend'||
      case when extract(dow from bt.txn_date) in (0,6) then '; posted on a weekend' else '' end||
      case when (abs(bt.amount)::numeric % 1000) = 0 then '; exact round number' else '' end||
      ', elevating fraud/error risk.',
    case when extract(dow from bt.txn_date) in (0,6) or (abs(bt.amount)::numeric % 1000)=0 then 0.86 else 0.74 end,
    'Verify authorization and supporting documentation; do not auto-clear.', true, 'open'
  from public.bank_transactions bt
  where bt.tenant_id = p_tenant_id and bt.workspace_id = p_workspace_id
    and bt.amount <= -10000;

  -- 5) LATE CUSTOMER PAYMENTS
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'late_customer_payment',
    case when (coalesce(v_period_end, current_date) - i.due_date) >= 60 then 'high'
         when (coalesce(v_period_end, current_date) - i.due_date) >= 30 then 'medium' else 'low' end,
    'Overdue receivable: '||i.invoice_number,
    'Invoice '||i.invoice_number||' of '||(i.amount - i.amount_paid)||' is '||
      (coalesce(v_period_end, current_date) - i.due_date)||' days past due.',
    (i.amount - i.amount_paid), null, 'invoices', i.id,
    'Due date passed with outstanding balance; aging increases collection risk.',
    0.9, 'Send dunning reminder / escalate to collections.', false, 'open'
  from public.invoices i
  where i.tenant_id = p_tenant_id and i.workspace_id = p_workspace_id
    and i.status in ('open','partial','overdue')
    and i.amount_paid < i.amount
    and i.due_date < coalesce(v_period_end, current_date);

  -- 6) UNCATEGORIZED
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'uncategorized_txn', 'low',
    'Uncategorized transaction: '||left(bt.description,40),
    'Bank line of '||bt.amount||' on '||bt.txn_date||' has no category assigned.',
    bt.amount, bt.account_id, 'bank_transactions', bt.id,
    'category is null; cannot be posted to the correct GL account without coding.',
    0.7, 'Assign a GL category for proper classification.', false, 'open'
  from public.bank_transactions bt
  where bt.tenant_id = p_tenant_id and bt.workspace_id = p_workspace_id and bt.category is null;

  -- 7) REVENUE / PAYMENT MISMATCH
  insert into public.exceptions(tenant_id, workspace_id, exception_type, severity, title, detail, amount, account_id, ref_table, ref_id, ai_reasoning, confidence, proposed_action, is_risky, status)
  select p_tenant_id, p_workspace_id, 'revenue_payment_mismatch', 'medium',
    'Revenue/payment mismatch: '||i.invoice_number,
    'Invoice '||i.invoice_number||' status is '''||i.status||''' but amount_paid ('||i.amount_paid||') does not reconcile to amount ('||i.amount||').',
    (i.amount - i.amount_paid), null, 'invoices', i.id,
    'Status/paid amount inconsistency indicates a posting drift between AR and cash.',
    0.81, 'Reconcile the applied payments against the invoice balance.', false, 'open'
  from public.invoices i
  where i.tenant_id = p_tenant_id and i.workspace_id = p_workspace_id
    and ((i.status = 'paid' and i.amount_paid <> i.amount) or (i.amount_paid > i.amount));

  select count(*) into v_count from public.exceptions
    where tenant_id = p_tenant_id and workspace_id = p_workspace_id and status = 'open';
  return v_count;
end;
$function$;

create or replace function public.ingest_document(p_tenant_id uuid, p_workspace_id uuid, p_doc_type text, p_filename text, p_rows jsonb, p_uploaded_by uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_doc_id uuid;
  v_row jsonb;
  v_ingested int := 0;
  v_total int := 0;
  v_status text := 'ingested';
  v_acct uuid;
begin
  v_caller_tenant := auth_tenant_id();
  if v_caller_tenant is distinct from p_tenant_id and not is_platform_admin() then
    raise exception 'tenant mismatch: caller % cannot ingest for %', v_caller_tenant, p_tenant_id;
  end if;

  v_total := coalesce(jsonb_array_length(p_rows), 0);

  if p_doc_type in ('invoice_pdf','receipt_pdf') then
    v_status := 'needs_review';
  end if;

  insert into public.fin_documents(tenant_id, workspace_id, doc_type, filename, status, row_count, uploaded_by)
  values (p_tenant_id, p_workspace_id, p_doc_type, p_filename, v_status, v_total, p_uploaded_by)
  returning id into v_doc_id;

  if v_status = 'needs_review' then
    update public.fin_documents set parse_summary = 'PDF stored for manual review (no automated extraction)' where id = v_doc_id;
    return jsonb_build_object('document_id', v_doc_id, 'status', v_status, 'ingested', 0, 'total', v_total);
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      if p_doc_type = 'bank_statement' then
        select id into v_acct from public.fin_accounts
          where tenant_id = p_tenant_id and is_bank = true order by code limit 1;
        insert into public.bank_transactions(tenant_id, workspace_id, account_id, txn_date, description, amount, category, is_matched, external_ref)
        values (p_tenant_id, p_workspace_id, v_acct,
          (v_row->>'date')::date, coalesce(v_row->>'description',''),
          (v_row->>'amount')::numeric, nullif(v_row->>'category',''), false, nullif(v_row->>'ref',''));
        v_ingested := v_ingested + 1;
      elsif p_doc_type = 'ar_aging' then
        insert into public.invoices(tenant_id, workspace_id, invoice_number, issue_date, due_date, amount, amount_paid, status, has_pdf)
        values (p_tenant_id, p_workspace_id,
          coalesce(v_row->>'invoice_number', 'IMP-'||substr(md5(random()::text),1,6)),
          (v_row->>'issue_date')::date, (v_row->>'due_date')::date,
          (v_row->>'amount')::numeric, coalesce((v_row->>'amount_paid')::numeric, 0),
          coalesce(nullif(v_row->>'status',''),'open'), false);
        v_ingested := v_ingested + 1;
      elsif p_doc_type = 'ap_aging' then
        insert into public.bills(tenant_id, workspace_id, bill_number, issue_date, due_date, amount, amount_paid, status, has_receipt)
        values (p_tenant_id, p_workspace_id,
          coalesce(v_row->>'bill_number', 'BIMP-'||substr(md5(random()::text),1,6)),
          (v_row->>'issue_date')::date, (v_row->>'due_date')::date,
          (v_row->>'amount')::numeric, coalesce((v_row->>'amount_paid')::numeric, 0),
          coalesce(nullif(v_row->>'status',''),'open'), coalesce((v_row->>'has_receipt')::boolean, false));
        v_ingested := v_ingested + 1;
      elsif p_doc_type = 'stripe_export' then
        insert into public.payments(tenant_id, workspace_id, direction, source, amount, paid_date, external_ref)
        values (p_tenant_id, p_workspace_id, 'inbound', 'stripe',
          (v_row->>'amount')::numeric, (v_row->>'date')::date, nullif(v_row->>'ref',''));
        v_ingested := v_ingested + 1;
      elsif p_doc_type = 'general_ledger' then
        select id into v_acct from public.fin_accounts
          where tenant_id = p_tenant_id and code = (v_row->>'account_code') limit 1;
        insert into public.journal_entries(tenant_id, workspace_id, account_id, entry_date, memo, debit, credit, source)
        values (p_tenant_id, p_workspace_id, v_acct,
          (v_row->>'date')::date, coalesce(v_row->>'memo',''),
          coalesce((v_row->>'debit')::numeric, 0), coalesce((v_row->>'credit')::numeric, 0), 'import');
        v_ingested := v_ingested + 1;
      elsif p_doc_type = 'payroll_summary' then
        select id into v_acct from public.fin_accounts
          where tenant_id = p_tenant_id and type = 'expense' order by code limit 1;
        insert into public.journal_entries(tenant_id, workspace_id, account_id, entry_date, memo, debit, credit, source)
        values (p_tenant_id, p_workspace_id, v_acct,
          (v_row->>'date')::date, 'Payroll: '||coalesce(v_row->>'memo','run'),
          coalesce((v_row->>'amount')::numeric, 0), 0, 'payroll');
        v_ingested := v_ingested + 1;
      end if;
    exception when others then
      null;
    end;
  end loop;

  update public.fin_documents
    set status = 'ingested', ingested_count = v_ingested,
        parse_summary = v_ingested||' of '||v_total||' rows normalized into finance objects'
    where id = v_doc_id;

  return jsonb_build_object('document_id', v_doc_id, 'status', 'ingested', 'ingested', v_ingested, 'total', v_total);
end;
$function$;

create or replace function public.resolve_exception(p_exception_id uuid, p_decision text, p_final_treatment text, p_approver uuid, p_approver_name text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ex      public.exceptions%rowtype;
  v_caller_tenant uuid;
  v_evidence_id uuid;
  v_source  text;
  v_new_status text;
begin
  if p_decision not in ('approved','rejected') then
    raise exception 'invalid decision %', p_decision;
  end if;

  select * into v_ex from public.exceptions where id = p_exception_id;
  if not found then raise exception 'exception not found'; end if;

  -- Tenant guard: caller must belong to the exception's tenant (or be platform admin).
  v_caller_tenant := public.auth_tenant_id();
  if v_caller_tenant is distinct from v_ex.tenant_id and not public.is_platform_admin() then
    raise exception 'cross-tenant access denied';
  end if;

  if v_ex.status <> 'open' then
    raise exception 'exception already %', v_ex.status;
  end if;

  -- Build source-evidence pointer string from the offending object
  v_source := coalesce(v_ex.ref_table,'n/a')||':'||coalesce(v_ex.ref_id::text,'n/a')
              ||' | type='||v_ex.exception_type||' | amount='||coalesce(v_ex.amount::text,'n/a');

  v_new_status := case when p_decision='approved' then 'approved' else 'rejected' end;

  update public.exceptions
     set status = v_new_status,
         resolved_by = p_approver,
         resolved_at = now(),
         final_treatment = p_final_treatment
   where id = p_exception_id;

  insert into public.audit_evidence
    (tenant_id, workspace_id, exception_id, action, source_evidence, ai_reasoning, confidence, approver, approver_name, final_treatment)
  values
    (v_ex.tenant_id, v_ex.workspace_id, v_ex.id, p_decision, v_source, v_ex.ai_reasoning, v_ex.confidence, p_approver, p_approver_name, p_final_treatment)
  returning id into v_evidence_id;

  return v_evidence_id;
end;
$function$;
