-- DE-A4: the inbox belongs to the Digital Employee, not the consult desk.
--
-- poll_de_work_sources_targets made EVERY subject with >= search access
-- an inbox poller. On Acme that meant the read-only Technical
-- Specialist raced the Support DE for each new ticket's ownership
-- claim (migration 109) — and whenever the specialist won, the
-- composed reply could never be proposed ("subject lacks write_back
-- access"), nondeterministically breaking the draft-for-approval flow.
--
-- A specialist's read grant exists so it can SEARCH evidence during
-- consultations — it is a consult desk, not an inbox worker (docs/10
-- Responsibility model; Wave 1.2 ownership design). From now on a
-- specialist only polls a connector when NO Digital Employee is
-- eligible on it — preserving the existing behavior for tenants that
-- genuinely have no DE covering a category.
create or replace function poll_de_work_sources_targets(p_tenant_id uuid default null)
returns table(
  tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
  category text,
  subject_kind text, subject_id uuid, subject_name text,
  last_seen_external_ref text, last_seen_timestamp timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.tenant_id, c.id as connector_id, c.provider, c.display_name,
    c.category,
    g.subject_kind, g.subject_id,
    coalesce(sp.name, de.name, 'DE') as subject_name,
    w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g
    on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id)
        or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join specialist_profiles sp on sp.id = g.subject_id and g.subject_kind = 'specialist'
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    -- The DE owns the inbox: a specialist polls only when no DE is
    -- eligible on this connector.
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2
        join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status <> 'retired'
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id)
               or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$$;
