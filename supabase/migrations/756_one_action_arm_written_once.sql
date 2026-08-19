-- ============================================================================
-- 756 — one action arm, written once.
--
-- docs/54 item 12: "the action-arm SQL is copy-pasted VERBATIM between
-- get_de_kpi_status and snapshot_de_kpi_readings — every new shape must be
-- written twice or they diverge. Extract before extending." Item 12's whole
-- point is to extend exactly this arm (so a tenant-defined metric can be
-- COMPUTED rather than forever `source='manual'`), so the extraction comes
-- first, on its own, with nothing else riding along.
--
-- THIS CHANGES NO BEHAVIOUR. It is a pure move: the same expression, the same
-- 91-day window, the same agg switch, the same category/action_label filters,
-- the same `case when source='action'` wrapper that mig 501 added — now in one
-- place that both callers ask.
--
-- On mig 501, read carefully before touching this. Its wrapper exists because
-- a metric whose source is NOT 'action' must resolve to NULL, not 0: without
-- it the arm counts zero rows, returns 0, and snapshot_de_kpi_readings
-- PERSISTS that zero — which run_work_watchers then reads to open autonomous
-- objectives against a number nobody measured. Both callers already carried
-- that guard; it is preserved here rather than reasoned about again.
--
-- Live traffic on this path today: NONE. All 6 de_kpis rows target `computed`
-- metrics; the two `action` metrics in the catalog (actions_completed,
-- auto_execution_rate) have no goals, and there are 0 manual readings
-- anywhere. So the refactor is verifiable against real data without any live
-- goal depending on the outcome — which is the moment to do it.
--
-- VERIFIED BY DIFFERENTIAL, not by reading: the extracted function is compared
-- against the inline expression for EVERY catalog metric × EVERY digital
-- employee. The count of comparisons is reported, because zero differences out
-- of zero comparisons looks exactly like a clean result.
-- ============================================================================

create or replace function public.de_kpi_action_value(
  p_tenant_id     uuid,
  p_de_id         uuid,
  p_source        text,
  p_source_config jsonb
)
returns table (v numeric, n bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select
    -- ⚠ mig 501's guard. A non-'action' metric MUST come back NULL, never 0.
    case when coalesce(p_source, '') = 'action' then
      case when coalesce(p_source_config->>'agg', 'count') = 'auto_rate'
           then round(100.0 * count(*) filter (where ae.decision = 'auto_executed') / nullif(count(*), 0), 1)
           else count(*)::numeric end
    end                                            as v,
    count(*)                                       as n
    from action_executions ae
    left join action_definitions ad on ad.id = ae.action_definition_id
   where p_source = 'action'
     and ae.tenant_id = p_tenant_id
     and ae.subject_kind = 'de'
     and ae.subject_id = p_de_id
     and ae.rollback_of is null
     and ae.created_at >= now() - interval '91 days'
     and (coalesce(p_source_config->>'category', '')     = '' or ad.category = p_source_config->>'category')
     and (coalesce(p_source_config->>'action_label', '') = '' or ad.label    = p_source_config->>'action_label')
$fn$;

-- Not a customer-facing reader: both callers are SECURITY DEFINER routines
-- that have already established tenant membership. Nothing on the browser
-- perimeter needs it, so nothing on the browser perimeter gets it — the
-- default PUBLIC/anon/authenticated EXECUTE grant (migs 610 + 630) is closed
-- here rather than pinned later.
revoke all on function public.de_kpi_action_value(uuid, uuid, text, jsonb) from public;
revoke all on function public.de_kpi_action_value(uuid, uuid, text, jsonb) from anon;
revoke all on function public.de_kpi_action_value(uuid, uuid, text, jsonb) from authenticated;
