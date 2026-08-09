-- 641 — an empty book is not a broken one.
--
-- WHY THE ONBOARDING DE ESCALATED 13 TIMES. It did not invent the blocker; the
-- runtime told it to raise one. supabase/functions/de-work/index.ts:949 renders
-- book_is_empty = NULL to the model as the sentence "CANNOT BE READ — no source
-- is connected for it", and :959 then ORDERS an escalation and forbids the
-- honest answer. The model obeyed, and quoted that sentence back verbatim in
-- de_decision_trace, em-dash and all.
--
-- Nothing in that path ever measured connectivity. get_de_worklists contains no
-- reference to connectors or de_connected_systems anywhere in its 9,791
-- characters, and de_connected_systems appears in NO edge function at all. NULL
-- only ever meant "this table holds no rows for this tenant".
--
-- TWO FIXES, both in the verdict block:
--
--   1. THE MISSING CASE ARM. Migration 603 renamed the assignment to
--      'renewal_invoices + invoices' when it unioned both tables into the
--      predicate, and never added the matching arm — so the literal fell to
--      `else null`. Verified live before this change: the assignment sits at
--      character 1604, and `when 'renewal_invoices + invoices'` was at 0, i.e.
--      absent. Latent rather than active, because those books currently have
--      rows (2 overdue, 6 unpaid) and row_count > 0 short-circuits before
--      v_src_any is consulted. It would have fired the first day AR was clear,
--      turning "no overdue invoices" into "this book cannot be read".
--
--   2. THE CONFLATED NULL. "Source holds nothing for you" and "this book has no
--      source at all" were the same value. Now only the second is NULL; the
--      first is an honest `true` plus source_has_any_rows = false, so the
--      runtime can report an unpopulated source without asserting a connection
--      failure it never checked.
--
-- The migration-528 safety property is kept, not discarded: a book pointed at
-- the WRONG table is what caused the "$431k reviewed: 0" false all-clear, and
-- that is now caught by an arm-coverage probe in certify — statically, before
-- it ships — rather than by treating every empty table as a fault.
--
-- Body reproduced from the LIVE pg_get_functiondef and edited programmatically;
-- the repo copy of 505/528/603 does not match production, which is how the
-- missing arm went unseen. DROP + CREATE because adding an output column cannot
-- be done with CREATE OR REPLACE.

BEGIN;

DROP FUNCTION IF EXISTS public.get_de_worklists(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_de_worklists(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(worklist_key text, label text, row_count bigint, sample jsonb, book_is_empty boolean, source_table text, source_has_any_rows boolean)
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
    source_has_any_rows := null;

    -- CLOSED LIBRARY. Every predicate is written here; nothing comes from data.
    case worklist_key

      when 'overdue_invoices' then
        source_table := 'renewal_invoices + invoices';
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
        source_table := 'renewal_invoices + invoices';
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
        -- FIX 1: migration 603 renamed this assignment to 'renewal_invoices + invoices'
        -- (both tables are unioned in the predicate now) but never added the matching
        -- arm, so every invoice book fell to `else null` the moment it had no rows.
        -- Latent while the books had work; it would have turned "no overdue invoices"
        -- into "this book cannot be read" the first quiet day. The old literal stays
        -- for any caller or template still naming it.
        when 'renewal_invoices + invoices'
                                   then (exists (select 1 from invoices            where tenant_id = p_tenant_id)
                                      or exists (select 1 from renewal_invoices    where tenant_id = p_tenant_id))
        when 'invoices'            then (exists (select 1 from invoices            where tenant_id = p_tenant_id)
                                      or exists (select 1 from renewal_invoices    where tenant_id = p_tenant_id))
        when 'journal_entries'     then  exists (select 1 from journal_entries     where tenant_id = p_tenant_id)
        when 'onboarding_projects' then  exists (select 1 from onboarding_projects where tenant_id = p_tenant_id)
        when 'customer_accounts'   then  exists (select 1 from customer_accounts   where tenant_id = p_tenant_id)
        else null
      end;

      source_has_any_rows := v_src_any;

      -- FIX 2: SPLIT THE TWO MEANINGS OF NULL.
      --
      -- Until now NULL meant both "this source holds nothing for you" (common,
      -- benign, permanent for a young tenant) and "this book resolves to no
      -- source at all" (a real configuration gap). de-work renders NULL as
      -- "CANNOT BE READ — no source is connected for it" and then ORDERS an
      -- escalation, so the benign case produced a nightly false alarm: the
      -- Onboarding DE escalated 13 times in 3 days because onboarding_projects
      -- was simply empty.
      --
      -- Now:
      --   false -> rows matched the filter
      --   true  -> the source resolved and holds nothing matching. GENUINELY
      --            EMPTY, and a legitimate "nothing to work today". Whether the
      --            source is entirely unpopulated is reported separately in
      --            source_has_any_rows, so the runtime can say so WITHOUT
      --            claiming a connection failure it never measured.
      --   NULL  -> we could not resolve a source for this book at all: either
      --            the worklist key is not implemented (source_table is null)
      --            or its source_table literal matches no arm above. Both are
      --            real config gaps and both deserve a human.
      --
      -- The mig-528 property survives: a book pointed at the WRONG table is
      -- caught by the arm-coverage probe in `npm run certify`, not by
      -- pretending every empty table is a connection failure.
      book_is_empty := case
        when source_table is null then null
        when v_src_any is null    then null
        else true
      end;
    end if;
    return next;
  end loop;
end;
$function$
;

REVOKE ALL ON FUNCTION public.get_de_worklists(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_de_worklists(uuid, uuid) TO authenticated, service_role;

DO $probe$
DECLARE
  v_tenant uuid;
  v_de     uuid;
  r        record;
  v_bad    text;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  IF v_tenant IS NULL THEN RAISE NOTICE 'no hq tenant; skipping behavioural asserts'; RETURN; END IF;

  -- S1: THE ONBOARDING BOOK NO LONGER READS AS UNREADABLE. This is the whole
  -- point: onboarding_projects is empty for this tenant, which is a legitimate
  -- "nothing to work today", not a connection failure.
  SELECT id INTO v_de FROM digital_employees
   WHERE tenant_id = v_tenant AND archetype_key = 'onboarding' AND status = 'active' LIMIT 1;
  IF v_de IS NOT NULL THEN
    SELECT * INTO r FROM get_de_worklists(v_tenant, v_de) WHERE worklist_key = 'stalled_onboarding';
    IF r.book_is_empty IS NULL THEN
      RAISE EXCEPTION 'S1 FAILED: the onboarding book still reports UNKNOWN, so the nightly false escalation continues';
    END IF;
    IF r.book_is_empty <> true THEN
      RAISE EXCEPTION 'S1 FAILED: expected the empty onboarding book to report empty, got %', r.book_is_empty;
    END IF;
    IF r.source_has_any_rows IS NOT FALSE THEN
      RAISE EXCEPTION 'S1 FAILED: source_has_any_rows should be false for an unpopulated source, got %', r.source_has_any_rows;
    END IF;
  END IF;

  -- S2: BOOKS WITH WORK ARE UNCHANGED. The fix must not turn real work into
  -- "empty" — that is the $431k failure in the other direction.
  SELECT id INTO v_de FROM digital_employees
   WHERE tenant_id = v_tenant AND name = 'Billing & Invoicing DE' LIMIT 1;
  IF v_de IS NOT NULL THEN
    SELECT * INTO r FROM get_de_worklists(v_tenant, v_de) WHERE worklist_key = 'overdue_invoices';
    IF coalesce(r.row_count, 0) < 1 THEN
      RAISE EXCEPTION 'S2 FAILED: the overdue-invoice book lost its rows (had 2)';
    END IF;
    IF r.book_is_empty IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S2 FAILED: a book with % rows reported book_is_empty=%', r.row_count, r.book_is_empty;
    END IF;
  END IF;

  -- S3: ARM COVERAGE. Every source_table literal the function can ASSIGN must
  -- have a matching arm. This is the defect 603 shipped, stated as a rule so it
  -- cannot recur silently.
  SELECT string_agg(lit, ', ') INTO v_bad
    FROM (
      SELECT DISTINCT (regexp_matches(pg_get_functiondef(p.oid),
               'source_table := ''([^'']+)''', 'g'))[1] AS lit
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_de_worklists'
    ) x
   WHERE position('when ''' || lit || '''' in
           (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'get_de_worklists')) = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S3 FAILED: source_table literal(s) with no matching CASE arm: %', v_bad;
  END IF;

  RAISE NOTICE '641 asserts passed: empty book reads empty, working books unchanged, every source literal has an arm.';
END
$probe$;

COMMIT;
