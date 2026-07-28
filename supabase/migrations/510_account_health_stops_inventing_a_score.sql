-- 510_account_health_stops_inventing_a_score.sql
-- ============================================================================
-- A live defect the WORKFORCE surfaced, not the audit.
--
-- Ten accounts were entered with a real spread of health (38 to 91). One
-- minute after the watcher tick every one of them read exactly 80 and every
-- at-risk flag was gone. Cases had already opened against the entered values,
-- so employees were working at-risk cases on accounts that now read healthy —
-- and one said so: "Task requests at-risk verification for Meridian Group, but
-- account data shows health score 80, above the 60 threshold."
--
-- THE MECHANISM. compute_account_health_core scores from four signals: open
-- tickets, escalations, overdue invoices, activity recency. With none of them
-- present, three penalties are zero and the fourth — activity_recency —
-- charges its FULL weight, because "no activity has ever been recorded" is
-- treated identically to "no activity lately". 100 minus that weight is the
-- same number for every customer with no history. Then the status rule flips
-- anything at_risk back to active for clearing the healthy threshold.
--
-- So the platform was reporting "this customer is brand new" as "this customer
-- is fine", and overwriting a person's judgment to do it. It is migration
-- 491's disease pointed the other way: 491 stopped an unmeasured thing being
-- displayed as 0; this stops one being written as 80 — worse, because it
-- replaces operator input and then drives the automation that opens cases.
--
-- THE FIX. No evidence is not a score. When an account has no tickets, no
-- escalations, no overdue invoices and no activity ever, the function returns
-- without touching health_score or status, and records why in
-- health_components so the surface can say "not measured" rather than showing
-- a blank. Computed scores now carry measured:true so a consumer can tell a
-- real score from an absent one without inferring it from a null.
--
-- Everything else is preserved byte-for-byte from the LIVE definition: the
-- weights and thresholds config, the bucketed penalties, the never-touches-
-- churned status rule, and the audit-only-on-flip discipline.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.compute_account_health_core(p_account uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_acct       customer_accounts;
  v_weights    jsonb;
  v_thresholds jsonb;
  w_tickets    numeric; w_escal numeric; w_overdue numeric; w_activity numeric;
  n_open       integer; n_escal integer; n_overdue integer;
  v_last_act   timestamptz;
  v_days       integer;                  -- null = no activity ever
  p_tickets    numeric; p_escal numeric; p_overdue numeric; p_activity numeric;
  v_score      integer;
  v_components jsonb;
  v_at_risk    integer; v_healthy integer;
  v_new_status text;
begin
  select * into v_acct from customer_accounts where id = p_account;
  if not found then
    return jsonb_build_object('error', 'account_not_found');
  end if;

  select weights, thresholds into v_weights, v_thresholds
  from health_score_config where tenant_id = v_acct.tenant_id;
  v_weights    := coalesce(v_weights,    '{"open_tickets":25,"escalations":25,"overdue_invoices":30,"activity_recency":20}'::jsonb);
  v_thresholds := coalesce(v_thresholds, '{"at_risk_below":50,"healthy_above":75}'::jsonb);

  w_tickets  := coalesce((v_weights->>'open_tickets')::numeric, 25);
  w_escal    := coalesce((v_weights->>'escalations')::numeric, 25);
  w_overdue  := coalesce((v_weights->>'overdue_invoices')::numeric, 30);
  w_activity := coalesce((v_weights->>'activity_recency')::numeric, 20);
  v_at_risk  := coalesce((v_thresholds->>'at_risk_below')::int, 50);
  v_healthy  := coalesce((v_thresholds->>'healthy_above')::int, 75);

  -- ── real signals ──
  select count(*) filter (where status in ('open', 'pending')),
         count(*) filter (where status = 'escalated')
    into n_open, n_escal
  from support_tickets where account_id = p_account;

  select count(*) into n_overdue
  from renewal_invoices
  where account_id = p_account and status = 'sent'
    and due_date is not null and due_date < current_date;

  select max(created_at) into v_last_act
  from activity_events where account_id = p_account;
  v_days := case when v_last_act is null then null
                 else greatest(0, extract(day from now() - v_last_act)::int) end;

  -- ── mig 510: NO EVIDENCE IS NOT A SCORE ────────────────────────────────
  -- The four signals above are the only inputs. When an account has none of
  -- them the arithmetic still produced a confident number: every penalty is
  -- zero except activity_recency, which charges its full weight because
  -- v_days is NULL — so EVERY customer with no history scored exactly the
  -- same, and anything an operator had marked at_risk flipped back to active
  -- for clearing the healthy threshold.
  --
  -- That is "this customer is brand new" being reported as "this customer is
  -- fine", and it OVERWRITES what a person entered. Observed live: ten
  -- accounts entered with a 38-91 spread were rewritten to a uniform 80 one
  -- minute after creation, while cases opened against the entered values were
  -- already running — an employee correctly reported the contradiction.
  --
  -- Same rule as migration 491: an unmeasured thing says so. Return without
  -- touching the score or the status, and record WHY so the surface can be
  -- honest rather than blank.
  if n_open = 0 and n_escal = 0 and n_overdue = 0 and v_last_act is null then
    update customer_accounts
       set health_components = jsonb_build_object(
             'score', null,
             'measured', false,
             'computed_at', now(),
             'reason', 'No tickets, invoices or activity recorded for this account yet — nothing to compute a health score from. The score shown is whatever was entered by hand.')
     where id = p_account;
    return jsonb_build_object(
      'measured', false,
      'score', null,
      'status', v_acct.status,
      'status_changed', false,
      'reason', 'no_evidence');
  end if;

  -- ── bucketed penalties ──
  p_tickets  := case when n_open = 0 then 0 when n_open <= 2 then 0.4 * w_tickets
                     when n_open <= 5 then 0.7 * w_tickets else w_tickets end;
  p_escal    := case when n_escal = 0 then 0 when n_escal = 1 then 0.6 * w_escal else w_escal end;
  p_overdue  := case when n_overdue = 0 then 0 when n_overdue = 1 then 0.7 * w_overdue else w_overdue end;
  p_activity := case when v_days is null then w_activity
                     when v_days <= 7 then 0 when v_days <= 14 then 0.3 * w_activity
                     when v_days <= 30 then 0.6 * w_activity else w_activity end;

  v_score := greatest(0, least(100, round(100 - p_tickets - p_escal - p_overdue - p_activity)::int));

  v_components := jsonb_build_object(
    'score', v_score,
    'measured', true,
    'computed_at', now(),
    'open_tickets',     jsonb_build_object('count', n_open,    'penalty', round(p_tickets, 1),  'weight', w_tickets),
    'escalations',      jsonb_build_object('count', n_escal,   'penalty', round(p_escal, 1),    'weight', w_escal),
    'overdue_invoices', jsonb_build_object('count', n_overdue, 'penalty', round(p_overdue, 1),  'weight', w_overdue),
    'activity_recency', jsonb_build_object('days_since', v_days, 'penalty', round(p_activity, 1), 'weight', w_activity)
  );

  -- ── status flip per thresholds (never touches churned) ──
  v_new_status := v_acct.status;
  if v_acct.status = 'active' and v_score < v_at_risk then
    v_new_status := 'at_risk';
  elsif v_acct.status = 'at_risk' and v_score > v_healthy then
    v_new_status := 'active';
  end if;

  update customer_accounts
    set health_score = v_score, health_components = v_components, status = v_new_status
    where id = p_account;

  -- Audit ONLY on a status change — not on every recompute.
  if v_new_status <> v_acct.status then
    perform append_audit_event_internal(
      v_acct.tenant_id, 'Success DE', 'de',
      format('Account health flip — %s: %s → %s (score %s, at-risk < %s, healthy > %s)',
             v_acct.name, v_acct.status, v_new_status, v_score, v_at_risk, v_healthy),
      'config_change',
      jsonb_build_object('kind', 'health_recompute', 'account_id', p_account,
                         'old_status', v_acct.status, 'new_status', v_new_status,
                         'score', v_score, 'components', v_components));
  end if;

  return v_components || jsonb_build_object('status', v_new_status, 'status_changed', v_new_status <> v_acct.status);
end;
$function$
;

notify pgrst, 'reload schema';

do $a$
declare
  v_def text;
  v_tenant uuid;
  v_acct uuid;
  v_before int;
  v_after int;
  v_res jsonb;
begin
  v_def := pg_get_functiondef('public.compute_account_health_core(uuid)'::regprocedure);
  if v_def not ilike '%no_evidence%' then
    raise exception '510: the evidence gate did not land';
  end if;
  -- The real computation must SURVIVE. Removing the scoring entirely would
  -- "fix" the symptom by making health permanently unmeasurable.
  if v_def not ilike '%bucketed penalties%' or v_def not ilike '%activity_recency%' then
    raise exception '510: the health computation itself was lost';
  end if;
  if v_def not ilike '%churned%' then
    raise exception '510: the never-touch-churned rule was lost';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice '510: no fixture — proof SKIPPED'; return; end if;

  -- BEHAVIOURAL: an account with no evidence must keep the score a person
  -- entered. This is the exact failure observed live.
  select id into v_acct from customer_accounts
   where tenant_id = v_tenant and attributes->>'seed' = 'test_book_v1' limit 1;
  if v_acct is null then raise notice '510: no seeded account — proof SKIPPED'; return; end if;

  update customer_accounts set health_score = 37, status = 'at_risk' where id = v_acct;
  select health_score into v_before from customer_accounts where id = v_acct;

  v_res := compute_account_health_core(v_acct);

  select health_score into v_after from customer_accounts where id = v_acct;
  if v_after is distinct from v_before then
    raise exception '510: an entered score of % was overwritten with % despite no evidence', v_before, v_after;
  end if;
  if coalesce((v_res->>'measured')::boolean, true) is not false then
    raise exception '510: the function still claims to have measured something';
  end if;
  if (select status from customer_accounts where id = v_acct) <> 'at_risk' then
    raise exception '510: the status a person set was flipped on no evidence';
  end if;

  raise notice '510: no evidence no longer manufactures a score — entered values survive';
end $a$;
