-- 806_reviews_that_recur_and_never_pile_up.sql
-- ==========================================================================
-- WHY: C1 of the practical-work program (spec 2026-08-11). The founder's
-- list names three recurring customer deliverables — health-check reviews,
-- lifecycle reviews, churn reviews — and none had a pipe: the health engine
-- (compute_account_health_core) writes a score nobody is asked to look at,
-- the continuity machine has zero cases, and the renewal_manager archetype
-- ships with an EMPTY worklist (a desk with no books).
--
-- What lands, mirroring the dunning driver's anatomy (migs 589/590):
--   1. account_reviews — the cadence ledger. UNIQUE(tenant, account, kind,
--      period) — the dedupe is ENFORCED BY THE INDEX, not by a recorded key
--      nothing checks (the 589 lesson: action_executions' dedupe idx is a
--      plain btree, so its sweep must re-check by hand; this one cannot).
--      A review proposed once this period is never proposed again this
--      period, whatever the human decided — a declined review was still
--      reviewed. That is what "never pile up" means.
--   2. review_de_for — the desk picker, by archetype_key (renewal_manager
--      first, cs_manager second), deterministic so the audit trail reads as
--      one desk doing the work.
--   3. account_review_draft — the grounded draft. The words the approver
--      reads ARE the deliverable (the 590 lesson: drafted text rides ON the
--      proposal). Honest to the mig-510 rule: an unmeasured health score
--      says so, it does not impersonate a number.
--   4. run_account_review_sweep — health_check monthly, lifecycle quarterly,
--      churn_risk monthly WHILE the account is at_risk. Refreshes health
--      before drafting so the review carries today's evidence.
--   5. Cron account-review-daily 07:20 UTC (after dunning's 07:10): a daily
--      run of a per-period sweep is idempotent by construction — day two
--      raises nothing new, and a mid-month account gets its first review
--      the morning after it appears.
--   6. human_tasks.type gains 'account_review' (CHECK widened — the 797
--      lesson: widen the constraint in the same migration as the first row
--      or the row bounces). decide_human_task is type-agnostic and the UI
--      decide flow's hooks are type-guarded, so deciding an account_review
--      records the decision and runs no execution re-entry — correct, since
--      the decision IS the completion.
--   7. renewal_manager's worklist gains the two EXISTING account books
--      (at_risk_accounts, accounts_book) — arms already in get_de_worklists'
--      closed library; only the templates were missing.
-- ==========================================================================

begin;

-- ── 1. The cadence ledger ─────────────────────────────────────────────────
create table if not exists public.account_reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  account_id  uuid not null references public.customer_accounts(id) on delete cascade,
  review_kind text not null check (review_kind in ('health_check', 'lifecycle', 'churn_risk')),
  period_key  text not null,
  task_id     uuid references public.human_tasks(id) on delete set null,
  de_id       uuid,
  -- What the desk SAW at review time. health_components on the account is
  -- overwritten by the next recompute; this is the snapshot of record.
  findings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (tenant_id, account_id, review_kind, period_key)
);

create index if not exists account_reviews_tenant_account_idx
  on public.account_reviews (tenant_id, account_id, created_at desc);

alter table public.account_reviews enable row level security;

drop policy if exists account_reviews_tenant_read on public.account_reviews;
create policy account_reviews_tenant_read on public.account_reviews
  for select using (tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()));

-- Client-side is read-only: the only writer is the sweep below.
revoke all on table public.account_reviews from public, anon, authenticated;
grant select on table public.account_reviews to authenticated;

-- ── 2. The desk picker ────────────────────────────────────────────────────
create or replace function public.review_de_for(p_tenant_id uuid)
returns uuid
language sql
stable security definer
set search_path to 'public'
as $fn$
  select de.id
  from digital_employees de
  where de.tenant_id = p_tenant_id
    and de.status = 'active'
    and de.archetype_key in ('renewal_manager', 'cs_manager')
  -- Deterministic: the same employee every period, so the review history
  -- reads as one desk's work rather than a rota nobody chose.
  order by (de.archetype_key = 'renewal_manager') desc, de.created_at asc
  limit 1;
$fn$;

revoke execute on function public.review_de_for(uuid) from public, anon, authenticated;
grant execute on function public.review_de_for(uuid) to service_role;

-- ── 3. The grounded draft ─────────────────────────────────────────────────
create or replace function public.account_review_draft(p_kind text, p_account uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_acct      customer_accounts;
  v_h         jsonb;
  v_measured  boolean;
  v_score     text;
  n_open_inv  int; v_known_out bigint; n_unverified int; n_overdue int;
  n_tickets   int; n_escal int;
  v_last_act  timestamptz;
  v_case      record;
  v_title     text;
  v_lines     text[] := '{}';
  v_findings  jsonb;
  v_days_to_renewal int;
  v_tenure_months int;
begin
  select * into v_acct from customer_accounts where id = p_account;
  if not found then return jsonb_build_object('error', 'account_not_found'); end if;

  v_h        := coalesce(v_acct.health_components, '{}'::jsonb);
  v_measured := coalesce((v_h->>'measured')::boolean, false);
  v_score    := case when v_measured then coalesce(v_acct.health_score::text, '?') || '/100'
                     else null end;

  select count(*) filter (where lower(coalesce(ri.status, '')) not in ('paid', 'void', 'cancelled')),
         coalesce(sum(ri.outstanding_cents) filter (where ri.outstanding_cents is not null
                    and lower(coalesce(ri.status, '')) not in ('paid', 'void', 'cancelled')), 0),
         count(*) filter (where ri.outstanding_cents is null
                    and lower(coalesce(ri.status, '')) not in ('paid', 'void', 'cancelled')),
         count(*) filter (where ri.due_date is not null and ri.due_date < current_date
                    and lower(coalesce(ri.status, '')) not in ('paid', 'void', 'cancelled'))
    into n_open_inv, v_known_out, n_unverified, n_overdue
    from renewal_invoices ri where ri.account_id = p_account;

  select count(*) filter (where st.status in ('open', 'pending')),
         count(*) filter (where st.status = 'escalated')
    into n_tickets, n_escal
    from support_tickets st where st.account_id = p_account;

  select max(ae.created_at) into v_last_act from activity_events ae where ae.account_id = p_account;

  select cc.stage_key, cc.risk_level, cc.next_step, cc.next_step_date
    into v_case
    from continuity_cases cc
   where cc.account_id = p_account and cc.outcome is null
   order by cc.updated_at desc limit 1;

  v_days_to_renewal := case when v_acct.renewal_date is null then null
                            else (v_acct.renewal_date - current_date) end;
  v_tenure_months := greatest(0, (extract(year from age(now(), v_acct.created_at)) * 12
                                  + extract(month from age(now(), v_acct.created_at)))::int);

  -- ── shared facts, in the approver's language ──
  if v_measured then
    v_lines := v_lines || format('Health: %s (%s). Penalties — open tickets %s, escalations %s, overdue invoices %s, activity recency %s.',
      v_score, coalesce(v_acct.status, 'active'),
      coalesce(v_h#>>'{open_tickets,count}', '0'), coalesce(v_h#>>'{escalations,count}', '0'),
      coalesce(v_h#>>'{overdue_invoices,count}', '0'),
      case when v_h#>>'{activity_recency,days_since}' is null then 'no activity ever recorded'
           else v_h#>>'{activity_recency,days_since}' || ' day(s) since last activity' end);
  else
    v_lines := v_lines || format('Health: NOT MEASURED — no tickets, invoices or activity are recorded for this account yet, so there is nothing to compute a score from. The score on file (%s) is whatever was entered by hand.',
      coalesce(v_acct.health_score::text, 'none'));
  end if;

  v_lines := v_lines || format('Receivables: %s open invoice(s)%s%s.',
    n_open_inv,
    case when v_known_out > 0 then format(', %s confirmed outstanding', to_char(v_known_out / 100.0, 'FM999,999,990.00')) else '' end,
    case when n_unverified > 0 then format(', %s with no reconciled balance (face value only)', n_unverified) else '' end)
    || case when n_overdue > 0 then format(' %s of them past due.', n_overdue) else '' end;

  v_lines := v_lines || case
    when v_acct.renewal_date is null then 'Renewal: no renewal date is recorded for this account.'
    when v_days_to_renewal < 0 then format('Renewal: %s — %s day(s) PAST.', to_char(v_acct.renewal_date, 'FMDD FMMonth YYYY'), -v_days_to_renewal)
    else format('Renewal: %s (in %s day(s)).', to_char(v_acct.renewal_date, 'FMDD FMMonth YYYY'), v_days_to_renewal) end;

  v_lines := v_lines || case
    when v_case.stage_key is not null then format('Continuity case: open at stage %s%s%s.',
      v_case.stage_key,
      case when v_case.next_step is not null then ', next step: ' || v_case.next_step else ', NO NEXT STEP recorded' end,
      case when v_case.next_step_date is not null then ' by ' || to_char(v_case.next_step_date, 'FMDD FMMonth YYYY') else '' end)
    else 'Continuity case: none open.' end;

  -- ── kind-specific framing ──
  if p_kind = 'health_check' then
    v_title := format('Monthly health check — %s', v_acct.name);
    v_lines := array_prepend(format('Monthly health check for %s (%s%s).',
      v_acct.name, coalesce(nullif(v_acct.tier, ''), 'no tier recorded'),
      case when v_acct.arr_cents is not null then format(', ARR %s', to_char(v_acct.arr_cents / 100.0, 'FM999,999,990')) else '' end), v_lines);
    v_lines := v_lines || 'Approve to file this review. Reject with a note if something here needs a different owner or a correction first.';
  elsif p_kind = 'lifecycle' then
    v_title := format('Quarterly lifecycle review — %s', v_acct.name);
    v_lines := array_prepend(format('Quarterly lifecycle review for %s. Customer for %s month(s), tier %s%s.',
      v_acct.name, v_tenure_months, coalesce(nullif(v_acct.tier, ''), 'not recorded'),
      case when v_acct.arr_cents is not null then format(', ARR %s', to_char(v_acct.arr_cents / 100.0, 'FM999,999,990')) else '' end), v_lines);
    if v_days_to_renewal is not null and v_days_to_renewal between 0 and 90 and v_case.stage_key is null then
      v_lines := v_lines || 'The renewal is inside 90 days and no continuity case is open — opening one is the concrete next step.';
    end if;
    v_lines := v_lines || 'No score history is kept yet; this review records today''s position so next quarter has something to compare against.';
  elsif p_kind = 'churn_risk' then
    v_title := format('Churn-risk review — %s', v_acct.name);
    v_lines := array_prepend(format('Churn-risk review for %s — this account is marked AT RISK.', v_acct.name), v_lines);
    v_lines := v_lines || case
      when v_case.stage_key is null then 'A save plan needs a continuity case with a named next step and a date. There is none open — that is the gap to close first.'
      when v_case.next_step is null then 'The open continuity case has NO NEXT STEP recorded — a save plan without a next step is a label, not a plan.'
      else 'Keep the open case''s next step honest: if it has slipped, re-date it and say why.' end;
  else
    return jsonb_build_object('error', 'unknown_review_kind', 'kind', p_kind);
  end if;

  v_findings := jsonb_build_object(
    'health', v_h,
    'status', v_acct.status,
    'arr_cents', v_acct.arr_cents,
    'tier', v_acct.tier,
    'renewal_date', v_acct.renewal_date,
    'days_to_renewal', v_days_to_renewal,
    'tenure_months', v_tenure_months,
    'open_invoices', n_open_inv,
    'overdue_invoices', n_overdue,
    'known_outstanding_cents', v_known_out,
    'unverified_balance_invoices', n_unverified,
    'open_tickets', n_tickets,
    'escalated_tickets', n_escal,
    'last_activity_at', v_last_act,
    'continuity_case', case when v_case.stage_key is null then null
                            else jsonb_build_object('stage', v_case.stage_key, 'risk', v_case.risk_level,
                                                    'next_step', v_case.next_step, 'next_step_date', v_case.next_step_date) end);

  return jsonb_build_object('title', v_title,
                            'detail', array_to_string(v_lines, E'\n\n'),
                            'findings', v_findings);
end;
$fn$;

revoke execute on function public.account_review_draft(text, uuid) from public, anon, authenticated;
grant execute on function public.account_review_draft(text, uuid) to service_role;

-- ── the new task type, CHECK widened in the same migration as its first row ──
alter table public.human_tasks drop constraint human_tasks_type_check;
alter table public.human_tasks add constraint human_tasks_type_check
  check (type = any (array['approval_gate', 'review_gate', 'escalation', 'override',
                           'training_feedback', 'trust_promotion', 'trust_demotion_notice',
                           'checklist', 'knowledge_revision', 'inquiry_review',
                           'action_approval', 'account_review']));

-- ── 4. The driver ─────────────────────────────────────────────────────────
create or replace function public.run_account_review_sweep(p_tenant_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  t          record;
  acct       record;
  k          record;
  v_de       uuid;
  v_draft    jsonb;
  v_review   uuid;
  v_task     uuid;
  v_raised_t int;
  v_tenants  int := 0;
  v_nodesk   int := 0;
  v_seen     int := 0;
  v_raised   int := 0;
  v_current  int := 0;
  v_detail   jsonb := '[]'::jsonb;
begin
  for t in
    select tn.id, tn.slug from tenants tn
    where (p_tenant_id is null or tn.id = p_tenant_id)
      and tenant_is_operational(tn.id)
  loop
    v_de := review_de_for(t.id);
    if v_de is null then
      v_nodesk := v_nodesk + 1;
      continue;
    end if;
    v_tenants := v_tenants + 1;
    v_raised_t := 0;

    for acct in
      select ca.id, ca.name from customer_accounts ca
      where ca.tenant_id = t.id and coalesce(ca.status, '') <> 'churned'
      order by ca.renewal_date asc nulls last, ca.created_at asc
    loop
      exit when v_raised_t >= p_limit;
      v_seen := v_seen + 1;

      -- Today's evidence, not last month's: refresh before drafting. The
      -- core function is mig-510-honest — an unmeasured account stays
      -- unmeasured and the draft says so.
      perform compute_account_health_core(acct.id);

      for k in
        select * from (values
          ('health_check', to_char(current_date, 'YYYY-MM')),
          ('lifecycle',    to_char(current_date, 'YYYY-"Q"Q')),
          ('churn_risk',   to_char(current_date, 'YYYY-MM'))
        ) as kinds(kind, period)
      loop
        exit when v_raised_t >= p_limit;

        -- churn_risk is due only while the account IS at risk — evaluated
        -- AFTER the refresh, so a flip this morning counts this morning.
        if k.kind = 'churn_risk' and not exists (
          select 1 from customer_accounts ca2 where ca2.id = acct.id and ca2.status = 'at_risk'
        ) then continue; end if;

        -- THE dedupe: the unique index decides, not a marker. Losing the
        -- race or repeating the period both land here as "already current".
        insert into account_reviews (tenant_id, account_id, review_kind, period_key, de_id)
        values (t.id, acct.id, k.kind, k.period, v_de)
        on conflict (tenant_id, account_id, review_kind, period_key) do nothing
        returning id into v_review;

        if v_review is null then
          v_current := v_current + 1;
          continue;
        end if;

        v_draft := account_review_draft(k.kind, acct.id);
        if v_draft ? 'error' then
          -- The review row exists but no task can carry it: say so loudly in
          -- the return rather than leaving a silent ledger row.
          v_detail := v_detail || jsonb_build_object('tenant', t.slug, 'account', acct.name,
                                                     'kind', k.kind, 'error', v_draft->>'error');
          continue;
        end if;

        insert into human_tasks (tenant_id, type, source, origin, title, detail,
                                 related_table, related_id, de_id, account_id)
        values (t.id, 'account_review', 'de', 'production',
                v_draft->>'title', v_draft->>'detail',
                'account_reviews', v_review, v_de, acct.id)
        returning id into v_task;

        update account_reviews
           set task_id = v_task, findings = coalesce(v_draft->'findings', '{}'::jsonb)
         where id = v_review;

        v_raised := v_raised + 1;
        v_raised_t := v_raised_t + 1;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'tenants_swept', v_tenants,
    'tenants_without_a_review_desk', v_nodesk,
    'accounts_seen', v_seen,
    'raised', v_raised,
    'already_current', v_current,
    'detail', v_detail);
end;
$fn$;

revoke execute on function public.run_account_review_sweep(uuid, integer) from public, anon, authenticated;
grant execute on function public.run_account_review_sweep(uuid, integer) to service_role;

-- ── 5. The cadence ────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'account-review-daily') then
    perform cron.unschedule('account-review-daily');
  end if;
  perform cron.schedule('account-review-daily', '20 7 * * *', 'select run_account_review_sweep()');
end $$;

-- ── 7. The renewal desk gets its books (existing arms, missing templates) ──
update role_archetypes
   set worklist_templates = worklist_templates || '[{"key":"at_risk_accounts","label":"Accounts flagged at risk"}]'::jsonb
 where key = 'renewal_manager'
   and not exists (select 1 from jsonb_array_elements(worklist_templates) e where e->>'key' = 'at_risk_accounts');

update role_archetypes
   set worklist_templates = worklist_templates || '[{"key":"accounts_book","label":"Active accounts"}]'::jsonb
 where key = 'renewal_manager'
   and not exists (select 1 from jsonb_array_elements(worklist_templates) e where e->>'key' = 'accounts_book');

-- ── Self-checks (each one CAN fail) ───────────────────────────────────────
do $$
declare n int;
begin
  if to_regclass('public.account_reviews') is null then
    raise exception 'account_reviews table missing';
  end if;

  if position('account_review' in (
    select pg_get_constraintdef(oid) from pg_constraint
     where conrelid = 'human_tasks'::regclass and conname = 'human_tasks_type_check')) = 0 then
    raise exception 'human_tasks_type_check does not admit account_review';
  end if;

  if not exists (select 1 from cron.job where jobname = 'account-review-daily') then
    raise exception 'cron account-review-daily missing';
  end if;

  select count(*) into n
    from role_archetypes a, lateral jsonb_array_elements(a.worklist_templates) e
   where a.key = 'renewal_manager' and e->>'key' in ('at_risk_accounts', 'accounts_book');
  if n <> 2 then raise exception 'renewal_manager should carry 2 account books, has %', n; end if;

  -- Perimeter: the internet holds nothing on the review machinery.
  if has_function_privilege('authenticated', 'public.run_account_review_sweep(uuid,integer)', 'execute')
     or has_function_privilege('anon', 'public.run_account_review_sweep(uuid,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.account_review_draft(text,uuid)', 'execute')
     or has_function_privilege('anon', 'public.account_review_draft(text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.review_de_for(uuid)', 'execute')
     or has_function_privilege('anon', 'public.review_de_for(uuid)', 'execute') then
    raise exception 'review machinery reachable from the internet - perimeter breach';
  end if;
end $$;

commit;
