-- ============================================================================
-- 261 — DEDICATED WORK-PRODUCT BY ROLE (founder: "never a mix-up")
--
-- A finance DE's work-product (payment reminders, reconciliations) is NOT a
-- support DE's (cases, tickets). The Employee File must show each employee's
-- OWN domain output, framed in its domain's language — never one hardcoded
-- layout. This resolves both generically, off the category-contract layer the
-- whole platform already speaks (crm / helpdesk / erp_financials / …):
--
--   get_de_role_context — what domain(s) this employee operates, resolved
--     from the system CATEGORIES it's granted (data_access_grants) + its
--     certified archetype (role_certifications → role_archetypes). No
--     hardcoded department strings.
--   get_de_work_product — what it has actually PRODUCED, from the two
--     domain-agnostic capture layers: de_conversations (conversational work)
--     and action_executions×action_definitions (system actions, already
--     tagged with a category + human label). Generalizes to ANY vertical:
--     a new archetype's actions appear here with zero code changes.
-- ============================================================================

create or replace function public.get_de_role_context(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_de record; v_arch record; v_domains jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  select id, category, department, is_specialist, specialist_key
    into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('ok', false, 'error', 'de_not_found'); end if;

  -- Domains it operates = the system categories it's actually granted.
  select coalesce(jsonb_agg(distinct g.resource_category), '[]'::jsonb) into v_domains
    from data_access_grants g
   where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
     and g.resource_category is not null;

  -- Certified archetype (if any) supplies the canonical role name + domain.
  select ra.key, ra.name, ra.domain, ra.required_connector_categories
    into v_arch
    from role_certifications rc
    join role_archetypes ra on ra.key = rc.archetype_key
   where rc.tenant_id = v_tenant and rc.de_id = p_de_id and rc.archetype_key is not null
   order by rc.evaluated_at desc nulls last limit 1;

  return jsonb_build_object(
    'ok', true,
    'department', v_de.department,
    'category', v_de.category,
    'is_specialist', v_de.is_specialist,
    'domains', v_domains,
    'archetype_key', v_arch.key,
    'archetype_name', v_arch.name,
    'archetype_domain', v_arch.domain,
    'archetype_categories', coalesce(to_jsonb(v_arch.required_connector_categories), '[]'::jsonb)
  );
end $function$;
revoke all on function public.get_de_role_context(uuid) from public, anon;
grant execute on function public.get_de_role_context(uuid) to authenticated, service_role;

create or replace function public.get_de_work_product(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_conv jsonb; v_actions jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;

  -- Conversational work-product (support/CRM/product domains).
  select jsonb_build_object(
      'total', count(*),
      'resolved', count(*) filter (where status = 'resolved'),
      'open', count(*) filter (where status in ('needs_human', 'human_owned', 'ai_handling')),
      'by_channel', coalesce((select jsonb_object_agg(ch, n) from (
          select channel ch, count(*) n from de_conversations
           where tenant_id = v_tenant and de_id = p_de_id group by channel) c), '{}'::jsonb)
    ) into v_conv
    from de_conversations where tenant_id = v_tenant and de_id = p_de_id;

  -- System-action work-product, grouped by category + human label. Each row
  -- already carries its domain category — this is the generic bit.
  select coalesce(jsonb_agg(row_to_json(x) order by x.n desc), '[]'::jsonb) into v_actions from (
    select ad.category, ad.label,
           count(*) as n,
           count(*) filter (where ae.decision = 'auto_executed') as auto_n,
           count(*) filter (where ae.decision like 'human_gated%') as gated_n,
           max(ae.created_at) as last_at
      from action_executions ae
      join action_definitions ad on ad.id = ae.action_definition_id
     where ae.tenant_id = v_tenant and ae.subject_kind = 'de' and ae.subject_id = p_de_id
       and ae.rollback_of is null
     group by ad.category, ad.label
  ) x;

  return jsonb_build_object('ok', true, 'conversations', v_conv, 'actions', v_actions);
end $function$;
revoke all on function public.get_de_work_product(uuid) from public, anon;
grant execute on function public.get_de_work_product(uuid) to authenticated, service_role;

NOTIFY pgrst, 'reload schema';
