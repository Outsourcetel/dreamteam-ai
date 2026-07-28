-- 528_an_empty_book_and_an_unread_book_are_not_the_same.sql
-- ============================================================================
-- THE FINANCE EMPLOYEE FILED A CONFIDENT, WELL-FORMATTED, FALSE REPORT.
--
-- Billing & Invoicing is the most productive employee in this tenant: 27 work
-- items completed, 6 deliverables. Its most recent one reads:
--
--     # Daily AR Sweep Summary
--     Status: Complete - Ready for Approval
--     All accounts current. No collection activity required.
--     Total invoices reviewed: 0
--
-- At that moment renewal_invoices held EIGHT real ERPNext invoices for this
-- tenant worth $478,000 — six of them unpaid ($431k), TWO of them overdue since
-- 2 July. Nothing was chased, and the report said there was nothing to chase.
--
-- ── THE CAUSE IS A PIPE, NOT A BRAIN ───────────────────────────────────────
-- get_de_worklists serves the receivables books from table "invoices". The ERP
-- ingest (mig 517) writes to "renewal_invoices". Two tables, both load-bearing
-- (10 and 7 SQL functions respectively), and no connection between them. For
-- this tenant "invoices" holds ZERO rows. So the desk truthfully reported an
-- empty book, and the employee truthfully wrote up an empty book.
--
-- ── WHY THAT BECAME A FALSEHOOD RATHER THAN A BLANK ────────────────────────
-- Migration 505 established that an empty book is a FIRST-CLASS ANSWER — "0
-- invoices past due" is a complete and correct AR sweep — because without it
-- every scheduled role blocked forever asking for access it already had. That
-- rule is right, and it is exactly what converted "I cannot see the data" into
-- "there is no data". de-work says it out loud: "Every book is empty. That is a
-- COMPLETE and correct answer for this shift... Do NOT escalate for access."
--
-- An empty book and an unread book had the same representation, so the most
-- dangerous state in the system was indistinguishable from the safest one.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- 1. Both receivables books now read "invoices" AND "renewal_invoices", tagging
--    each row with its source so the employee can cite where a figure came from.
-- 2. book_is_empty gains a third state. NULL means "this book's source holds
--    nothing at all for this tenant, so I cannot conclude it is empty" — the
--    same discipline mig 491 applied to rates, where a missing denominator is
--    NULL and never 0. Only a book whose source IS populated may report empty
--    and thereby finish a shift.
--
-- Consolidating the two invoice tables is the real debt and is NOT attempted
-- here: 17 functions read one or the other and this is a P0 on live data.
-- Reading both is correct regardless of how that is later resolved.
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
DECLARE
  v_tenant uuid; v_de uuid; r record;
  n_overdue bigint; v_empty boolean; n_unknown int := 0;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT d.id INTO v_de FROM digital_employees d
   WHERE d.tenant_id = v_tenant AND d.archetype_key = 'billing_ar' LIMIT 1;
  IF v_de IS NULL THEN RAISE EXCEPTION '528: no billing employee to test against'; END IF;

  -- ── the overdue book must now actually contain the overdue invoices ──────
  -- Would this pass if the change were a no-op? No: it returned 0 before, which
  -- is precisely what produced the false all-clear.
  SELECT w.row_count, w.book_is_empty INTO n_overdue, v_empty
    FROM get_de_worklists(v_tenant, v_de) w WHERE w.worklist_key = 'overdue_invoices';

  IF coalesce(n_overdue, 0) = 0 THEN
    RAISE EXCEPTION '528: the overdue book is still empty while renewal_invoices holds % overdue',
      (SELECT count(*) FROM renewal_invoices
        WHERE tenant_id = v_tenant AND due_date < current_date
          AND coalesce(status,'') NOT IN ('paid','void','cancelled'));
  END IF;
  IF v_empty IS NOT FALSE THEN
    RAISE EXCEPTION '528: the overdue book has % row(s) but still does not report itself as populated', n_overdue;
  END IF;

  -- ── a book with no source anywhere must report UNKNOWN, never empty ──────
  FOR r IN SELECT * FROM get_de_worklists(v_tenant, v_de) LOOP
    IF r.book_is_empty IS NULL THEN n_unknown := n_unknown + 1; END IF;
    -- The invariant: nothing may claim to be empty while its source is bare.
    IF r.book_is_empty IS TRUE AND r.source_table = 'invoices'
       AND NOT EXISTS (SELECT 1 FROM invoices WHERE tenant_id = v_tenant)
       AND NOT EXISTS (SELECT 1 FROM renewal_invoices WHERE tenant_id = v_tenant) THEN
      RAISE EXCEPTION '528: "%" claims to be empty but no receivables source holds anything', r.label;
    END IF;
  END LOOP;

  RAISE NOTICE '528: overdue book now shows % item(s); % book(s) correctly report unknown rather than empty',
    n_overdue, n_unknown;
END $a$;
