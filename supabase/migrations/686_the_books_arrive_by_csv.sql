-- 686_the_books_arrive_by_csv.sql
-- ============================================================================
-- WHY (founder 2026-08-11): the real books live OUTSIDE ERPNext, so the first
-- load arrives by CSV — invoices, commercial agreements (the renewal book:
-- 0 rows in every tenant today), and customer contacts (0 primary contacts →
-- every chase is an internal note instead of an email). The ERPNext connector
-- path stays untouched for system sync; this is the parallel front door.
--
-- ONE gated RPC, import_books_rows(p_kind, p_rows):
--   • tenant from auth_tenant_id() — NEVER a parameter (cross-tenant rule);
--     owner/admin only, same gate style as set_tenant_brand_identity.
--   • p_rows = jsonb array the UI parsed from CSV (≤ 500 per call; the card
--     batches). Every row is validated; a bad row is a LOUD per-row error in
--     the result, never a silent skip and never a poisoned batch.
--   • Idempotent: invoices upsert on the existing (tenant, source_provider,
--     source_external_ref) unique key with source_provider='csv'; contacts on
--     their (tenant, source, external_ref) key; agreements have no natural
--     unique key so the RPC matches (tenant, account, lower(title)) and
--     updates instead of duplicating.
--   • Accounts are resolved by name (case-insensitive) and created when
--     absent — a books load must not require pre-registering every customer.
--   • RECONCILIATION DISCIPLINE HONORED: outstanding_cents is NEVER written.
--     NULL means "never reconciled" and only evidence-fed
--     reconcile_invoice_payments may change that ([[de-time-saving-gap]]).
-- ============================================================================

begin;

create or replace function public.import_books_rows(p_kind text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row jsonb;
  v_i int := 0;
  v_created int := 0;
  v_updated int := 0;
  v_accounts_created int := 0;
  v_errors jsonb := '[]'::jsonb;
  -- per-row working vars
  v_account uuid;
  v_customer text;
  v_ref text;
  v_amount numeric;
  v_cents bigint;
  v_currency text;
  v_due date;
  v_status text;
  v_email text;
  v_title text;
  v_type text;
  v_existing uuid;
  v_is_primary boolean;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null or not public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    return jsonb_build_object('ok', false, 'error', 'not_permitted');
  end if;
  if p_kind not in ('invoices','agreements','contacts') then
    return jsonb_build_object('ok', false, 'error', 'unknown_kind', 'kind', p_kind);
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_must_be_array');
  end if;
  if jsonb_array_length(p_rows) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows', 'detail', 'send at most 500 rows per call');
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      -- ── shared: resolve or create the customer account ──
      v_customer := nullif(btrim(v_row->>'customer'), '');
      if v_customer is null then
        raise exception 'customer is required';
      end if;
      select id into v_account from customer_accounts
       where tenant_id = v_tenant and lower(name) = lower(v_customer) limit 1;
      if v_account is null then
        insert into customer_accounts (tenant_id, name, status, source_provider)
        values (v_tenant, v_customer, 'active', 'csv')
        returning id into v_account;
        v_accounts_created := v_accounts_created + 1;
      end if;

      if p_kind = 'invoices' then
        v_ref := nullif(btrim(v_row->>'invoice_ref'), '');
        if v_ref is null then raise exception 'invoice_ref is required'; end if;
        v_amount := (v_row->>'amount')::numeric;
        if v_amount is null or v_amount <= 0 then raise exception 'amount must be a positive number'; end if;
        v_cents := round(v_amount * 100)::bigint;
        v_currency := upper(nullif(btrim(v_row->>'currency'), ''));
        if v_currency is null or v_currency !~ '^[A-Z]{3}$' then raise exception 'currency must be a 3-letter code'; end if;
        v_due := (v_row->>'due_date')::date;
        if v_due is null then raise exception 'due_date is required (YYYY-MM-DD)'; end if;
        v_status := lower(coalesce(nullif(btrim(v_row->>'status'), ''), 'open'));
        if v_status not in ('open','paid','overdue') then raise exception 'status must be open, paid or overdue'; end if;
        v_status := case
          when v_status = 'paid' then 'paid'
          when v_status = 'overdue' or (v_status = 'open' and v_due < current_date) then 'overdue'
          else 'sent' end;
        v_email := nullif(btrim(v_row->>'contact_email'), '');
        if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          raise exception 'contact_email is not a valid email';
        end if;

        insert into renewal_invoices (tenant_id, account_id, amount_cents, status, due_date,
                                      source_provider, source_external_ref, source_currency, contact_email)
        values (v_tenant, v_account, v_cents, v_status, v_due, 'csv', v_ref, v_currency, v_email)
        on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
        do update set account_id = excluded.account_id, amount_cents = excluded.amount_cents,
                      status = excluded.status, due_date = excluded.due_date,
                      source_currency = excluded.source_currency,
                      contact_email = coalesce(excluded.contact_email, renewal_invoices.contact_email),
                      updated_at = now()
        returning (xmax = 0) into strict v_is_primary;  -- true = fresh insert
        if v_is_primary then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
        -- outstanding_cents deliberately untouched: NULL = never reconciled.

      elsif p_kind = 'agreements' then
        v_title := nullif(btrim(v_row->>'title'), '');
        if v_title is null then raise exception 'title is required'; end if;
        v_currency := upper(nullif(btrim(v_row->>'currency'), ''));
        if v_currency is null or v_currency !~ '^[A-Z]{3}$' then raise exception 'currency must be a 3-letter code'; end if;
        v_type := lower(coalesce(nullif(btrim(v_row->>'agreement_type'), ''), 'subscription'));
        if v_type not in ('subscription','maintenance','managed_service','retainer','staff_aug','sow',
                          'purchase','lease','rental','license','warranty','supplier_contract','other') then
          raise exception 'agreement_type % is not in the allowed list', v_type;
        end if;
        v_status := lower(coalesce(nullif(btrim(v_row->>'status'), ''), 'active'));
        if v_status not in ('draft','active','pending','expired','terminated','superseded') then
          raise exception 'status % is not in the allowed list', v_status;
        end if;
        if nullif(btrim(v_row->>'renewal_date'), '') is null and v_status = 'active' then
          raise exception 'renewal_date is required for an active agreement — it IS the renewal book';
        end if;
        v_amount := nullif(btrim(v_row->>'value'), '')::numeric;

        select id into v_existing from commercial_agreements
         where tenant_id = v_tenant and account_id = v_account and lower(title) = lower(v_title) limit 1;
        if v_existing is null then
          insert into commercial_agreements (tenant_id, account_id, party_side, counterparty_name,
            agreement_type, title, status, currency, auto_renew, notice_period_days,
            baseline_value_cents, start_date, end_date, renewal_date, source_document, attributes)
          values (v_tenant, v_account, 'sell', v_customer, v_type, v_title, v_status, v_currency,
            coalesce(lower(v_row->>'auto_renew') in ('true','yes','1'), false),
            nullif(btrim(v_row->>'notice_period_days'), '')::int,
            case when v_amount is not null then round(v_amount * 100)::bigint end,
            nullif(btrim(v_row->>'start_date'), '')::date,
            nullif(btrim(v_row->>'end_date'), '')::date,
            nullif(btrim(v_row->>'renewal_date'), '')::date,
            jsonb_build_object('kind', 'csv_import', 'imported_at', now()),
            '{}'::jsonb);
          v_created := v_created + 1;
        else
          update commercial_agreements set
            agreement_type = v_type, status = v_status, currency = v_currency,
            auto_renew = coalesce(lower(v_row->>'auto_renew') in ('true','yes','1'), auto_renew),
            notice_period_days = coalesce(nullif(btrim(v_row->>'notice_period_days'), '')::int, notice_period_days),
            baseline_value_cents = coalesce(case when v_amount is not null then round(v_amount * 100)::bigint end, baseline_value_cents),
            start_date = coalesce(nullif(btrim(v_row->>'start_date'), '')::date, start_date),
            end_date = coalesce(nullif(btrim(v_row->>'end_date'), '')::date, end_date),
            renewal_date = coalesce(nullif(btrim(v_row->>'renewal_date'), '')::date, renewal_date),
            updated_at = now()
          where id = v_existing;
          v_updated := v_updated + 1;
        end if;

      else -- contacts
        v_email := lower(nullif(btrim(v_row->>'email'), ''));
        if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          raise exception 'a valid email is required';
        end if;
        v_is_primary := coalesce(lower(v_row->>'is_primary') in ('true','yes','1'), false);
        -- The CSV is the founder-authored source of truth for contacts: a new
        -- primary explicitly replaces the old one (unique partial index).
        if v_is_primary then
          update customer_account_contacts set is_primary = false
           where account_id = v_account and is_primary;
        end if;
        insert into customer_account_contacts (tenant_id, account_id, end_user_ref, first_name, last_name,
                                               email, phone, role, is_primary, source, external_ref)
        values (v_tenant, v_account, v_email,
                nullif(btrim(v_row->>'first_name'), ''), nullif(btrim(v_row->>'last_name'), ''),
                v_email, nullif(btrim(v_row->>'phone'), ''),
                nullif(lower(btrim(v_row->>'role')), ''), v_is_primary, 'csv', v_email)
        on conflict (tenant_id, source, external_ref) where external_ref is not null
        do update set first_name = excluded.first_name, last_name = excluded.last_name,
                      phone = coalesce(excluded.phone, customer_account_contacts.phone),
                      role = coalesce(excluded.role, customer_account_contacts.role),
                      is_primary = excluded.is_primary,
                      account_id = excluded.account_id, updated_at = now()
        returning (xmax = 0) into strict v_is_primary;
        if v_is_primary then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
      end if;

    exception when others then
      v_errors := v_errors || jsonb_build_object('row', v_i, 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', true, 'kind', p_kind,
    'created', v_created, 'updated', v_updated,
    'accounts_created', v_accounts_created,
    'error_count', jsonb_array_length(v_errors), 'errors', v_errors);
end; $$;

-- Migs 610+630 rule: strip both default-grant mechanisms, then grant the
-- perimeter deliberately (in-function owner/admin gate does the authz).
revoke all on function public.import_books_rows(text, jsonb) from public, anon, authenticated;
grant execute on function public.import_books_rows(text, jsonb) to authenticated, service_role;

-- ── Verify ──
do $$
declare v_n int;
begin
  -- EXECUTE surface: anon must be out, authenticated in (gate is in-function).
  if has_function_privilege('anon', 'public.import_books_rows(text, jsonb)', 'execute') then
    raise exception '686: anon can execute the importer';
  end if;
  if not has_function_privilege('authenticated', 'public.import_books_rows(text, jsonb)', 'execute') then
    raise exception '686: authenticated cannot execute the importer — the card would 42501';
  end if;
  -- The body must NEVER name outstanding_cents (reconciliation discipline) —
  -- and the check itself must not be vacuous: the fn must exist and name
  -- renewal_invoices at all.
  select count(*) into v_n from pg_proc where proname = 'import_books_rows' and pronamespace = 'public'::regnamespace;
  if v_n <> 1 then raise exception '686: expected exactly 1 importer, found %', v_n; end if;
  if (select pg_get_functiondef(oid) from pg_proc where proname='import_books_rows') not like '%renewal_invoices%' then
    raise exception '686: importer does not touch renewal_invoices — wrong body?';
  end if;
  if (select pg_get_functiondef(oid) from pg_proc where proname='import_books_rows') like '%outstanding_cents = %' then
    raise exception '686: importer WRITES outstanding_cents — reconciliation discipline violated';
  end if;
  -- The idempotency keys this function leans on must exist.
  if not exists (select 1 from pg_indexes where indexname = 'renewal_invoices_source_key') then
    raise exception '686: renewal_invoices source unique key missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'customer_account_contacts_source_ref_uniq') then
    raise exception '686: contacts source unique key missing';
  end if;
  raise notice '686: import_books_rows live — invoices/agreements/contacts by CSV, per-row errors, evidence-only reconciliation untouched';
end $$;

commit;
