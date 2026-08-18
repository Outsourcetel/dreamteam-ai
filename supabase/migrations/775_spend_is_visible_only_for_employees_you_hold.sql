-- 775_spend_is_visible_only_for_employees_you_hold.sql
-- ============================================================================
-- Register A-4: get_de_cost_metrics checked that the caller belongs to the
-- workspace and then returned per-employee spend for EVERY employee in it. So
-- any signed-in member of a tenant — approver, knowledge_manager, tenant_user,
-- read_only — could read what each individual digital employee costs, not just
-- the ones they are responsible for.
--
-- ── Why can_access_de and not a role list ──────────────────────────────────
-- The neighbouring organ already had this right. `analytics_de_workload` ANDs
-- `public.can_access_de(p_de_id)` onto its reads, and Workstream C's attack
-- (docs/50) found it holding: a foreign caller got empty aggregates rather than
-- an error, which is the correct shape for a metric. Spelling a fresh role list
-- here would be a second list to keep in step with that one — the defect this
-- repo keeps re-finding, and the exact reason migration 769 exists.
--
-- ── Nobody loses a capability ──────────────────────────────────────────────
-- can_access_de admits, in this order: service_role; platform admins;
-- tenant_owner / tenant_admin / tenant_manager for the WHOLE workforce of their
-- own workspace (mig 663 scoped that to the caller's tenant); and otherwise the
-- employees a caller actually holds. So every role that could legitimately see
-- workspace-wide spend still sees it. What stops is a narrow role reading the
-- per-employee cost of an employee that is nothing to do with them.
--
-- The tenant-membership check above is deliberately kept as well. It answers a
-- different question — "may you look at this workspace at all" — and removing
-- it because a per-row filter now exists would make a foreign tenant's call
-- return an empty set instead of refusing, which is a weaker answer.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_de_cost_metrics(p_tenant_id uuid)
 RETURNS TABLE(de_id uuid, total_calls bigint, total_input_tokens bigint, total_output_tokens bigint, total_cost_usd numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s cost data';
  end if;

  return query
    select
      u.de_id,
      count(*) as total_calls,
      sum(u.input_tokens) as total_input_tokens,
      sum(u.output_tokens) as total_output_tokens,
      round(sum(
        (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
        + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
      ), 4) as total_cost_usd
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
    where u.tenant_id = p_tenant_id and u.de_id is not null
      and evidence_is_production(u.origin)
      -- A-4: and only the employees this caller actually holds. can_access_de
      -- keeps owner/admin/manager on the WHOLE workforce of their own
      -- workspace and platform staff on everything, so no role that could see
      -- this before loses it; it is the narrower roles that stop seeing spend
      -- for employees they are not responsible for.
      and public.can_access_de(u.de_id)   -- 682: exam spend is not a business cost metric
    group by u.de_id;
end;
$function$

;
