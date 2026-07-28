-- 505_the_worklist_desk.sql
-- ============================================================================
-- THE SECOND DESK. Wave 1 gave a CASE its record; this gives a SHIFT its book.
--
-- ── THE GAP, measured ──────────────────────────────────────────────────────
-- 17 of this tenant's 24 goals have entity_kind='schedule', and a schedule
-- watcher writes a TIMESTAMP as the entity reference, not a record id. So the
-- grounded desk built in wave 1 — which resolves a case to its row — has
-- nothing to resolve. The employee wakes to "Daily AR sweep" holding nothing,
-- and escalates. Verbatim, from four different employees this week:
--   Billing:    "I don't have access to a list of which invoices are currently
--                flagged as needing collection action, nor do I have a tool to
--                query them."
--   Onboarding: "I need access to the working account list with current data to
--                identify stalled accounts."
--   Accounting: "All five steps of the reconciliation playbook were attempted,
--                but none could be completed with real data."
--   Renewal:    (record-driven — already fixed in wave 1)
-- One shape, four employees, one fix.
--
-- ── THE DESIGN DECISION THAT MATTERS MOST ──────────────────────────────────
-- Every book at this tenant is EMPTY today: 0 invoices, 0 journal entries, 0
-- onboarding projects, 0 accounts. A worklist that treats "no rows" as failure
-- would leave all four employees exactly where they are. So an empty worklist
-- is a FIRST-CLASS ANSWER: "0 overdue invoices today" is a complete, correct
-- result for an AR sweep, and the employee should close the shift saying so
-- rather than escalating that it has no access. That single distinction turns
-- four permanently-blocked employees into correctly-idle ones — and, once the
-- books fill, the same code starts producing real work with no further change.
--
-- ── GENERICITY, WITHOUT SQL FROM DATA ──────────────────────────────────────
-- Templates live on role_archetypes (platform-level, no tenant_id — one row
-- reaches every tenant, the pattern migrations 497 and 502 established). They
-- name a worklist KEY; the query for each key is a closed CASE below. So a new
-- role that reuses an existing worklist is one UPDATE, a genuinely new book is
-- one branch plus that UPDATE, and no table or predicate is ever interpolated
-- from data — the same reason watch_source_catalog exists.
-- ============================================================================

alter table public.role_archetypes add column if not exists worklist_templates jsonb not null default '[]'::jsonb;

comment on column public.role_archetypes.worklist_templates is
  'The standing books a scheduled shift works from, as [{key, label}] REFERENCES into the closed worklist library in get_de_worklists. Platform-level. An empty result is a valid answer, not a failure.';

update public.role_archetypes set worklist_templates = '[
  {"key": "overdue_invoices",     "label": "Invoices past due"},
  {"key": "unpaid_invoices",      "label": "Invoices issued and unpaid"}
]'::jsonb where key = 'billing_ar';

update public.role_archetypes set worklist_templates = '[
  {"key": "unreconciled_entries", "label": "Journal entries this month"},
  {"key": "unpaid_invoices",      "label": "Invoices issued and unpaid"}
]'::jsonb where key = 'accounting';

update public.role_archetypes set worklist_templates = '[
  {"key": "stalled_onboarding",   "label": "Onboarding projects not yet live"}
]'::jsonb where key = 'onboarding';

update public.role_archetypes set worklist_templates = '[
  {"key": "at_risk_accounts",     "label": "Accounts flagged at risk"},
  {"key": "accounts_book",        "label": "Active accounts"}
]'::jsonb where key = 'cs_manager';

update public.role_archetypes set worklist_templates = '[
  {"key": "unpaid_invoices",      "label": "Invoices issued and unpaid"},
  {"key": "unreconciled_entries", "label": "Journal entries this month"}
]'::jsonb where key = 'fpa';

-- ── the resolver ────────────────────────────────────────────────────────────
create or replace function public.get_de_worklists(p_tenant_id uuid, p_de_id uuid)
returns table(
  worklist_key text,
  label text,
  row_count bigint,
  sample jsonb,
  book_is_empty boolean,
  source_table text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_arch text;
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
                                      'amount', i.amount, 'status', i.status) as x
              from invoices i
             where i.tenant_id = p_tenant_id
               and i.due_date < current_date
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
             order by i.due_date limit 25
          ) s;

      when 'unpaid_invoices' then
        source_table := 'invoices';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', i.invoice_number, 'due', i.due_date,
                                      'amount', i.amount, 'paid', i.amount_paid, 'status', i.status) as x
              from invoices i
             where i.tenant_id = p_tenant_id
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
             order by i.due_date nulls last limit 25
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

    book_is_empty := coalesce(row_count, 0) = 0;
    return next;
  end loop;
end;
$function$;

revoke all on function public.get_de_worklists(uuid, uuid) from public, anon;
grant execute on function public.get_de_worklists(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; v_de uuid; n int; n_empty int; r record;
begin
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice '505: no fixture — proof SKIPPED'; return; end if;

  -- Each scheduled role must now have a book to open.
  for r in select d.id, d.name, d.archetype_key from digital_employees d
            where d.tenant_id = v_tenant
              and d.archetype_key in ('billing_ar','accounting','onboarding','cs_manager','fpa')
  loop
    select count(*) into n from get_de_worklists(v_tenant, r.id);
    if n = 0 then
      raise exception '505: % (%) still has no worklist — it would wake holding nothing', r.name, r.archetype_key;
    end if;
  end loop;

  -- The books are all empty today, and that must resolve as an ANSWER rather
  -- than an error: book_is_empty true, row_count 0, no exception raised.
  select count(*), count(*) filter (where book_is_empty) into n, n_empty
    from get_de_worklists(v_tenant,
      (select id from digital_employees where tenant_id = v_tenant and archetype_key = 'billing_ar' limit 1));
  if n = 0 then raise exception '505: the billing book returned nothing at all'; end if;
  if n_empty <> n then
    raise notice '505: % of % billing worklists already have rows', n - n_empty, n;
  end if;

  -- An employee with no archetype gets no book rather than a generic one.
  select count(*) into n from get_de_worklists(v_tenant,
    (select id from digital_employees where tenant_id = v_tenant and archetype_key is null limit 1));
  if n <> 0 then
    raise exception '505: an employee with no role was handed a book anyway';
  end if;

  -- And the renewal employee is untouched: its work is record-driven and the
  -- wave-1 desk already serves it.
  select count(*) into n from get_de_worklists(v_tenant, '40d688eb-016d-4f74-8049-1ab2f660182d');
  raise notice '505: worklist desk live — scheduled roles have books (% for renewal, which is record-driven)', n;
end $a$;
