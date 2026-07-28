-- 532_the_erp_already_told_us_what_is_owed.sql
-- ============================================================================
-- Migrations 529/530 established that an invoice's FACE VALUE is not a balance
-- owed, and made every unreconciled invoice say "UNVERIFIED" rather than let a
-- collections employee chase a number nobody had checked. Correct — and it
-- turns out the answer was already arriving and being thrown away.
--
-- The ERPNext adapter fetches these fields on every read:
--   name, customer, customer_name, posting_date, due_date, currency,
--   grand_total, OUTSTANDING_AMOUNT, status, docstatus
--
-- It even FILTERS on outstanding_amount > 0 to build the dunning queue. But
-- syncFinancials maps only `grand_total -> amount_cents`, and
-- upsert_external_ar_record has no parameter for the balance at all. So the one
-- number a collections agent most needs — what is actually still owed, computed
-- by the accounting system itself — crossed the wire and was dropped.
--
-- ── WHY THIS IS THE RIGHT FIRST STEP FOR COLLECTIONS ───────────────────────
-- You cannot chase what you cannot verify. Every downstream capability —
-- a dunning ladder, a promise-to-pay, a payment plan, an escalation to credit
-- hold — is arithmetic on top of "how much is still owed". Getting that number
-- from the ledger that computes it beats deriving it from payments we have not
-- ingested, and it is available today.
--
-- ── THE NULL DISCIPLINE IS PRESERVED, NOT WEAKENED ─────────────────────────
-- p_outstanding_cents DEFAULTS TO NULL and a NULL is written through as NULL.
-- A provider that does not report a balance leaves the invoice UNVERIFIED
-- exactly as before — this widens the pipe, it does not invent a number. Only
-- a figure the source system actually stated is stored.
--
-- Note the two now mean different things and both are kept:
--   amount_cents      what the invoice was raised for (the face value)
--   outstanding_cents what is still owed on it (the ledger's own figure)
-- A part-paid $45,000 invoice is a $45,000 invoice with $15,000 outstanding,
-- and a collections employee must quote the second.
-- ============================================================================

-- Adding a DEFAULTed parameter creates a second overload rather than replacing
-- the first, and a nine-argument call then matches both. Drop the old signature
-- so there is exactly one candidate; callers passing nine named arguments (the
-- deployed connector-hub does) resolve to this one and get NULL for the tenth,
-- which is the correct "the source said nothing about the balance" answer.
DROP FUNCTION IF EXISTS public.upsert_external_ar_record(uuid,text,text,text,text,bigint,date,text,text);

CREATE OR REPLACE FUNCTION public.upsert_external_ar_record(
  p_tenant_id uuid, p_provider text, p_customer_external_ref text, p_customer_name text,
  p_invoice_external_ref text, p_amount_cents bigint, p_due_date date, p_status text, p_currency text,
  p_outstanding_cents bigint DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                                outstanding_cents, payments_reconciled_at)
  values (p_tenant_id, v_account_id, coalesce(p_amount_cents, 0), v_status, p_due_date, 0,
          p_provider, p_invoice_external_ref, p_currency,
          p_outstanding_cents,
          -- Only stamp "we know the balance" when the source actually said so.
          case when p_outstanding_cents is not null then now() end)
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
                updated_at = now()
  returning id into v_invoice_id;

  return jsonb_build_object('account_id', v_account_id, 'invoice_id', v_invoice_id,
                            'outstanding_known', p_outstanding_cents is not null);
end;
$function$;

COMMENT ON FUNCTION public.upsert_external_ar_record(uuid,text,text,text,text,bigint,date,text,text,bigint) IS
  'Idempotent upsert of one external AR record. p_outstanding_cents is what the source ledger says is STILL OWED and defaults to NULL — a provider that does not report it leaves the invoice unverified rather than having a balance invented for it. A sync that omits the balance never erases one already known.';

notify pgrst, 'reload schema';

DO $a$
DECLARE v_tenant uuid; v_res jsonb; v_out bigint; v_face bigint; v_ref text; v_stamp timestamptz;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT source_external_ref, amount_cents INTO v_ref, v_face
    FROM renewal_invoices WHERE tenant_id = v_tenant AND source_provider = 'erpnext'
     ORDER BY due_date LIMIT 1;
  IF v_ref IS NULL THEN RAISE EXCEPTION '532: no ERP invoice to test against'; END IF;

  -- ── a stated balance is stored, and marks the invoice as known ───────────
  -- Would this pass if the parameter were ignored? No: outstanding was NULL.
  v_res := upsert_external_ar_record(v_tenant, 'erpnext', 'PROBE-CUST', 'Probe Customer',
             v_ref, v_face, current_date, 'sent', 'USD', (v_face / 3));
  SELECT outstanding_cents, payments_reconciled_at INTO v_out, v_stamp
    FROM renewal_invoices WHERE tenant_id = v_tenant AND source_external_ref = v_ref;
  IF v_out IS DISTINCT FROM (v_face / 3) THEN
    RAISE EXCEPTION '532: the stated balance was not stored (got %, expected %)', v_out, v_face / 3;
  END IF;
  IF v_stamp IS NULL THEN RAISE EXCEPTION '532: balance stored without recording that it is known'; END IF;

  -- ── a later sync that OMITS the balance must not erase it ───────────────
  PERFORM upsert_external_ar_record(v_tenant, 'erpnext', 'PROBE-CUST', 'Probe Customer',
            v_ref, v_face, current_date, 'sent', 'USD');
  SELECT outstanding_cents INTO v_out FROM renewal_invoices
   WHERE tenant_id = v_tenant AND source_external_ref = v_ref;
  IF v_out IS DISTINCT FROM (v_face / 3) THEN
    RAISE EXCEPTION '532: a sync that said nothing about the balance wiped it';
  END IF;

  -- ── and NULL must still mean unknown for an invoice never reported ──────
  IF NOT EXISTS (SELECT 1 FROM renewal_invoices
                  WHERE tenant_id = v_tenant AND outstanding_cents IS NULL) THEN
    RAISE EXCEPTION '532: every invoice acquired a balance — the NULL default was not preserved';
  END IF;

  -- Restore: this was a probe, not a sync.
  UPDATE renewal_invoices SET outstanding_cents = NULL, payments_reconciled_at = NULL
   WHERE tenant_id = v_tenant AND source_external_ref = v_ref;
  DELETE FROM customer_accounts WHERE tenant_id = v_tenant AND source_external_ref = 'PROBE-CUST'
     AND NOT EXISTS (SELECT 1 FROM renewal_invoices ri WHERE ri.account_id = customer_accounts.id);

  RAISE NOTICE '532: the ledger''s own outstanding balance is now stored, never invented, and never erased by a quieter sync';
END $a$;
