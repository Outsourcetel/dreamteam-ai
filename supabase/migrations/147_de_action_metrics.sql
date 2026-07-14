-- ============================================================
-- 147 — get_de_action_metrics: the "what did this employee actually DO"
-- half of the Performance page. The existing get_de_performance_metrics
-- only measures the ANSWERING path (evidence_run_decisions); this
-- measures the DOING path (action_executions) — the real work a DE
-- performs in connected systems.
--
-- IMPORTANT double-row semantics (see connector-hub execute_action): a
-- gated-then-approved action writes TWO action_executions rows — one
-- 'human_gated_*' (routed to a human) and, on approval, one
-- 'executed_after_approval'. They measure DIFFERENT things, so the
-- buckets below are deliberately non-overlapping in meaning:
--   executed        = auto_executed + executed_after_approval  (really happened)
--   sent_to_human   = human_gated_destructive + human_gated_trust (approval load)
--   autonomy_rate   = auto_executed / executed   (of what it completed, how much w/o a human)
-- 'previewed' (dry-run) rows are excluded from all counts.
-- ============================================================
create or replace function public.get_de_action_metrics(p_tenant_id uuid, p_days integer default 30)
returns table(
  de_id uuid,
  total_events bigint,
  executed bigint,
  auto_executed bigint,
  approved_after_gate bigint,
  sent_to_human bigint,
  blocked bigint,
  rejected bigint,
  failed bigint,
  autonomy_rate numeric
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s performance data';
  end if;

  return query
    with ax as (
      select ae.subject_id as d_de_id, ae.decision as dec
      from action_executions ae
      where ae.tenant_id = p_tenant_id
        and ae.subject_kind = 'de'
        and ae.subject_id is not null
        and ae.decision <> 'previewed'
        and ae.created_at >= now() - make_interval(days => p_days)
    )
    select
      ax.d_de_id as de_id,
      count(*)::bigint as total_events,
      count(*) filter (where dec in ('auto_executed', 'executed_after_approval'))::bigint as executed,
      count(*) filter (where dec = 'auto_executed')::bigint as auto_executed,
      count(*) filter (where dec = 'executed_after_approval')::bigint as approved_after_gate,
      count(*) filter (where dec in ('human_gated_destructive', 'human_gated_trust'))::bigint as sent_to_human,
      count(*) filter (where dec in ('guardrail_blocked', 'access_denied'))::bigint as blocked,
      count(*) filter (where dec = 'rejected')::bigint as rejected,
      count(*) filter (where dec = 'failed')::bigint as failed,
      round(
        100.0 * count(*) filter (where dec = 'auto_executed')
        / nullif(count(*) filter (where dec in ('auto_executed', 'executed_after_approval')), 0),
        1
      ) as autonomy_rate
    from ax
    group by ax.d_de_id;
end;
$function$;

grant execute on function public.get_de_action_metrics(uuid, integer) to authenticated;
