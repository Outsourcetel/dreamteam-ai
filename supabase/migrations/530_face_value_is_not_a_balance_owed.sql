-- 530_face_value_is_not_a_balance_owed.sql
-- ============================================================================
-- Migration 529 built the reconciliation model. This makes the employee USE it.
--
-- Without this, the collection summary keeps saying "ACC-SINV-2026-00006 -
-- $45,000 - urgent follow-up" when $45,000 is the invoice FACE VALUE and no
-- payment has ever been reconciled against it. If that customer part-paid, the
-- employee chases money already received.
--
-- Every ERP-sourced row in the receivables books now carries still_owed:
--   a number   - payments were reconciled; this is what is genuinely left
--   UNVERIFIED - nobody has ever reconciled a payment against this invoice, so
--                the face value is all anyone knows and must not be presented
--                as a balance owed
--
-- The employee is told the difference in words rather than given a number it
-- has to interpret, because the failure being prevented is exactly a confident
-- restatement of an unverified figure.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_de_worklists(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(worklist_key text, label text, row_count bigint, sample jsonb, book_is_empty boolean, source_table text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_arch text;
  v_src_any boolean;
  v_templates jsonb;
  t jsonb;
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if not (is_platform_admin()
            or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
      raise exception 'not authorized to view this workspace';
    end if;
  end if;
  if not (auth.role() is null or auth.role() = 'service_role' or public.can_access_de(p_de_id)) then
    raise exception 'not authorized to view this employee';
  end if;

  select d.archetype_key into v_arch from digital_employees d
   where d.id = p_de_id and d.tenant_id = p_tenant_id;
  if v_arch is null then return; end if;

  select a.worklist_templates into v_templates from role_archetypes a where a.key = v_arch;
  if v_templates is null or v_templates = '[]'::jsonb then return; end if;

  for t in select * from jsonb_array_elements(v_templates) loop
    worklist_key := t->>'key';
    label        := t->>'label';
    row_count    := 0;
    sample       := '[]'::jsonb;
    source_table := null;

    -- CLOSED LIBRARY. Every predicate is written here; nothing comes from data.
    case worklist_key

      when 'overdue_invoices' then
        source_table := 'invoices';
        select count(*), coalesce(jsonb_agg(x order by x->>'due_date') filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', i.invoice_number, 'due', i.due_date,
                                      'amount', i.amount, 'status', i.status, 'source', 'invoices') as x,
                   i.due_date as ord
              from invoices i
             where i.tenant_id = p_tenant_id
               and i.due_date < current_date
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
            union all
            -- The ERP ingest (mig 517) lands real invoices in renewal_invoices,
            -- which this book did not read: 8 invoices worth $478k, two of them
            -- overdue, were invisible while the sweep reported "all accounts
            -- current". Same book, both sources.
            select jsonb_build_object('invoice', coalesce(r.source_external_ref, r.id::text), 'due', r.due_date,
                                      'amount', (r.amount_cents / 100.0), 'status', r.status,
                                      'still_owed', case when r.outstanding_cents is not null
                                                         then (r.outstanding_cents / 100.0)::text
                                                         else 'UNVERIFIED - no payment has ever been reconciled against this invoice; the amount shown is the face value, not a confirmed balance' end,
                                      'source', coalesce(r.source_provider, 'renewal_invoices')) as x,
                   r.due_date as ord
              from renewal_invoices r
             where r.tenant_id = p_tenant_id
               and r.due_date < current_date
               and coalesce(r.status, '') not in ('paid', 'void', 'cancelled')
             order by ord limit 25
          ) s;

      when 'unpaid_invoices' then
        source_table := 'invoices';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', i.invoice_number, 'due', i.due_date,
                                      'amount', i.amount, 'paid', i.amount_paid, 'status', i.status,
                                      'source', 'invoices') as x,
                   i.due_date as ord
              from invoices i
             where i.tenant_id = p_tenant_id
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
            union all
            select jsonb_build_object('invoice', coalesce(r.source_external_ref, r.id::text), 'due', r.due_date,
                                      'amount', (r.amount_cents / 100.0), 'status', r.status,
                                      'still_owed', case when r.outstanding_cents is not null
                                                         then (r.outstanding_cents / 100.0)::text
                                                         else 'UNVERIFIED - no payment has ever been reconciled against this invoice; the amount shown is the face value, not a confirmed balance' end,
                                      'source', coalesce(r.source_provider, 'renewal_invoices')) as x,
                   r.due_date as ord
              from renewal_invoices r
             where r.tenant_id = p_tenant_id
               and coalesce(r.status, '') not in ('paid', 'void', 'cancelled')
             order by ord nulls last limit 25
          ) s;

      when 'unreconciled_entries' then
        source_table := 'journal_entries';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('date', j.entry_date, 'memo', left(coalesce(j.memo, ''), 120),
                                      'debit', j.debit, 'credit', j.credit, 'source', j.source) as x
              from journal_entries j
             where j.tenant_id = p_tenant_id
               and j.entry_date >= date_trunc('month', current_date)
             order by j.entry_date desc limit 25
          ) s;

      when 'stalled_onboarding' then
        source_table := 'onboarding_projects';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('project', o.name, 'status', o.status,
                                      'progress_pct', o.progress_pct, 'target_golive', o.target_golive,
                                      'days_since_update', (current_date - o.updated_at::date)) as x
              from onboarding_projects o
             where o.tenant_id = p_tenant_id
               and o.completed_at is null
             order by o.updated_at limit 25
          ) s;

      when 'at_risk_accounts' then
        source_table := 'customer_accounts';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('account', c.name, 'health', c.health_score,
                                      'status', c.status, 'renews', c.renewal_date) as x
              from customer_accounts c
             where c.tenant_id = p_tenant_id
               and (coalesce(c.status, '') = 'at_risk' or coalesce(c.health_score, 100) < 50)
             order by c.health_score nulls last limit 25
          ) s;

      when 'accounts_book' then
        source_table := 'customer_accounts';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('account', c.name, 'health', c.health_score,
                                      'status', c.status, 'renews', c.renewal_date) as x
              from customer_accounts c
             where c.tenant_id = p_tenant_id
               and coalesce(c.status, '') <> 'churned'
             order by c.name limit 25
          ) s;

      else
        -- A template naming a book the library does not implement. Say so
        -- rather than returning an empty list that reads as "nothing to do".
        label := coalesce(label, worklist_key) || ' (not available)';
        source_table := null;
    end case;

    -- THE DISTINCTION THIS WHOLE DESK RESTS ON.
    -- "0 invoices past due" finishes an AR sweep honestly. "I am pointed at a
    -- source that holds nothing for this tenant" does NOT — but until now both
    -- returned book_is_empty = true, and the SOP's "if the book is empty you are
    -- finished" rule turned the second into a confident all-clear. That is how a
    -- polished Daily AR Sweep Summary came to say "All accounts current, total
    -- invoices reviewed: 0" over $431k of live receivables.
    --
    -- NULL is the third answer, exactly as mig 491 made a rate with no
    -- denominator NULL rather than 0: not empty, not populated — unknown.
    if coalesce(row_count, 0) > 0 then
      book_is_empty := false;
    else
      v_src_any := case source_table
        -- Closed library, same as the predicates above: nothing here comes from data.
        when 'invoices'            then (exists (select 1 from invoices            where tenant_id = p_tenant_id)
                                      or exists (select 1 from renewal_invoices    where tenant_id = p_tenant_id))
        when 'journal_entries'     then  exists (select 1 from journal_entries     where tenant_id = p_tenant_id)
        when 'onboarding_projects' then  exists (select 1 from onboarding_projects where tenant_id = p_tenant_id)
        when 'customer_accounts'   then  exists (select 1 from customer_accounts   where tenant_id = p_tenant_id)
        else null
      end;
      -- Populated source, nothing matching the filter -> genuinely empty.
      -- Nothing there at all (or a book with no source) -> we cannot say.
      book_is_empty := case when v_src_any then true else null end;
    end if;
    return next;
  end loop;
end;
$function$
;

notify pgrst, 'reload schema';

DO $a$
DECLARE v_tenant uuid; v_de uuid; v_sample jsonb; n_unverified int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug='outsourcetel-hq';
  SELECT d.id INTO v_de FROM digital_employees d
   WHERE d.tenant_id=v_tenant AND d.archetype_key='billing_ar' LIMIT 1;

  SELECT w.sample INTO v_sample FROM get_de_worklists(v_tenant, v_de) w
   WHERE w.worklist_key='overdue_invoices';

  IF v_sample IS NULL OR jsonb_array_length(v_sample)=0 THEN
    RAISE EXCEPTION '530: the overdue book is empty — cannot prove the labelling';
  END IF;

  -- Nothing has been reconciled yet, so EVERY row must say so. Would this pass
  -- if the change were a no-op? No: the key would not exist at all.
  SELECT count(*) INTO n_unverified
    FROM jsonb_array_elements(v_sample) e WHERE e->>'still_owed' LIKE 'UNVERIFIED%';
  IF n_unverified <> jsonb_array_length(v_sample) THEN
    RAISE EXCEPTION '530: % of % overdue rows present a face value as a confirmed balance',
      jsonb_array_length(v_sample) - n_unverified, jsonb_array_length(v_sample);
  END IF;

  RAISE NOTICE '530: all % overdue row(s) correctly labelled unverified until payments are reconciled', n_unverified;
END $a$;
