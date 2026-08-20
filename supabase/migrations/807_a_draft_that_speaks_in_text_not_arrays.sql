-- 807_a_draft_that_speaks_in_text_not_arrays.sql
-- ==========================================================================
-- WHY: 806's first live run failed inside account_review_draft with
-- "malformed array literal". The dry-run could not catch it: no statement in
-- the migration exercised the draft on real data. The defect: in plpgsql,
--     v_lines := v_lines || 'a bare string literal';
-- lets Postgres resolve the UNKNOWN-typed literal against the
-- anyarray||anyarray overload — it tries to parse the sentence AS AN ARRAY.
-- Appends built with format() were safe (format returns text); the three
-- bare literals and the one CASE whose every branch is a literal were not.
-- Fix: an explicit ::text on each, choosing anyarray||anyelement. Function
-- reissued whole from 806's definition with only those four casts changed —
-- 806 itself is applied and its file is never edited (ledger law).
-- ==========================================================================

begin;

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
    v_lines := v_lines || 'Approve to file this review. Reject with a note if something here needs a different owner or a correction first.'::text;
  elsif p_kind = 'lifecycle' then
    v_title := format('Quarterly lifecycle review — %s', v_acct.name);
    v_lines := array_prepend(format('Quarterly lifecycle review for %s. Customer for %s month(s), tier %s%s.',
      v_acct.name, v_tenure_months, coalesce(nullif(v_acct.tier, ''), 'not recorded'),
      case when v_acct.arr_cents is not null then format(', ARR %s', to_char(v_acct.arr_cents / 100.0, 'FM999,999,990')) else '' end), v_lines);
    if v_days_to_renewal is not null and v_days_to_renewal between 0 and 90 and v_case.stage_key is null then
      v_lines := v_lines || 'The renewal is inside 90 days and no continuity case is open — opening one is the concrete next step.'::text;
    end if;
    v_lines := v_lines || 'No score history is kept yet; this review records today''s position so next quarter has something to compare against.'::text;
  elsif p_kind = 'churn_risk' then
    v_title := format('Churn-risk review — %s', v_acct.name);
    v_lines := array_prepend(format('Churn-risk review for %s — this account is marked AT RISK.', v_acct.name), v_lines);
    v_lines := v_lines || case
      when v_case.stage_key is null then 'A save plan needs a continuity case with a named next step and a date. There is none open — that is the gap to close first.'
      when v_case.next_step is null then 'The open continuity case has NO NEXT STEP recorded — a save plan without a next step is a label, not a plan.'
      else 'Keep the open case''s next step honest: if it has slipped, re-date it and say why.' end::text;
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

do $$
begin
  -- The four casts are present (each CAN fail if a future edit drops one).
  if (select count(*) from regexp_matches(
        pg_get_functiondef('public.account_review_draft(text,uuid)'::regprocedure),
        '::text', 'g')) < 4 then
    raise exception 'expected at least 4 ::text casts in account_review_draft';
  end if;
end $$;

commit;
