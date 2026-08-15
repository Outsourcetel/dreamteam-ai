-- 743_a_connector_without_a_credential_is_not_a_source.sql
-- ==========================================================================
-- WHY: `pending_credentials` is about to exist for the first time, and two
-- pollers on a cron would treat it as a system they can call.
--
-- The discovery accept path stages a connector at `status='pending_credentials'`
-- — a row that names a system the customer described but holds no secret. The
-- card's promise is *"You still enter the credential yourself."* Nothing has
-- ever held that status: live counts are `connected 24, disconnected 2`. The
-- front-end deploy is what creates the first one.
--
-- Every "a connector we can actually call" selector in this codebase is a
-- DENY-LIST — `status <> 'disconnected'` — so a new status is admitted by
-- default. That is the wrong polarity for a question whose answer should be
-- "only the ones that work", and it is invisible: nothing fails, the row is
-- simply selected and then cannot be used.
--
-- WHAT WOULD ACTUALLY HAPPEN. A workspace with no CRM accepts "Connect
-- HubSpot" from its discovery interview. A step that previously recorded an
-- honest *"skipped: no connected crm system for this workspace"* now selects
-- the staged row, calls it, gets `no_credentials`, and records a FAILURE. An
-- honest skip becomes a fault report, on work the customer never asked for.
-- Worse where a real system already exists: with Zendesk live in `helpdesk`
-- and a Freshdesk card accepted, the TypeScript selectors' `.limit(1)` with no
-- ORDER BY can return either row, so a working automation starts failing
-- intermittently.
--
-- ⚠ WHY THIS IS NOT ALREADY HARMLESS. Both functions below join
-- `data_access_grants`, and the discovery accept deliberately does NOT create
-- one — that omission is what makes "the credential step is the second gate"
-- true. So today the grant is the thing holding the line. But that is
-- two-paths-one-counted: the status filter LOOKS like the guard, the grant
-- actually IS, and the next person to add a grant for an unrelated reason
-- silently re-opens this. A guard that is correct only because a different
-- guard is doing the work is not a guard.
--
-- ==========================================================================
-- WHY `in ('connected','error')` AND NOT `= 'connected'`
--
-- The CHECK admits four values: connected, error, disconnected,
-- pending_credentials. Narrowing to `= 'connected'` is the tidier-looking
-- change and it is WRONG — it would silently stop polling every connector in
-- `error`, which is a system that has real credentials and failed. Polling it
-- again is a retry, and retries are how an errored connector recovers. That
-- would be a behaviour change dressed as a cleanup, on a cron, discovered
-- weeks later by whoever noticed a connector never came back.
--
-- So the change is exactly one value wide: exclude the status that has never
-- held a credential, keep the one that has.
--
-- Both bodies are carried forward verbatim from the live definitions with a
-- single altered predicate each, marked below. Both are `language sql`,
-- STABLE, SECURITY DEFINER; `poll_support_inbox_targets` carries
-- `search_path = public, extensions` and it is preserved.
-- ==========================================================================

create or replace function public.poll_de_work_sources_targets(p_tenant_id uuid default null)
returns table(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
              category text, subject_kind text, subject_id uuid, subject_name text,
              last_seen_external_ref text, last_seen_timestamp timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select c.tenant_id, c.id, c.provider, c.display_name, c.category, g.subject_kind, g.subject_id,
    coalesce(sub.name, 'DE'), w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id) or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join digital_employees sub on sub.id = g.subject_id
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  -- mig 743: was `c.status <> 'disconnected'`, a deny-list that admitted the
  -- new pending_credentials status by default. Allow-list now: 'error' stays
  -- in on purpose (real credentials, failed call, retrying is the recovery
  -- path), 'pending_credentials' is out (never had a credential, so calling it
  -- turns an honest skip into a recorded failure).
  where c.status in ('connected', 'error')
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and tenant_is_operational(c.tenant_id)
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active' and de_is_available(de.availability)))
    and not (
      g.subject_kind = 'de'
      and exists (
        select 1 from workforce_team_members me
        join workforce_teams t on t.id = me.team_id and t.status = 'active'
        join workforce_team_members peer on peer.team_id = me.team_id and peer.fallback_rank < me.fallback_rank
        join digital_employees pde on pde.id = peer.de_id
        where me.de_id = g.subject_id and t.tenant_id = c.tenant_id
          and pde.lifecycle_status in ('assigned', 'active', 'improving') and pde.status = 'active' and de_is_available(pde.availability)
          and exists (select 1 from data_access_grants pg where pg.tenant_id = c.tenant_id and pg.subject_kind = 'de' and pg.subject_id = pde.id
              and ((pg.resource_kind = 'connector' and pg.resource_id = c.id) or (pg.resource_kind = 'category' and pg.resource_category = c.category))
              and access_permission_level(pg.permission) >= access_permission_level('search'))
      )
    )
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2 join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status in ('assigned', 'active', 'improving') and de2.status = 'active' and de_is_available(de2.availability)
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id) or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$fn$;

create or replace function public.poll_support_inbox_targets(p_tenant_id uuid default null)
returns table(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
              subject_kind text, subject_id uuid, subject_name text,
              last_seen_external_ref text, last_seen_timestamp timestamptz)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select c.tenant_id, c.id, c.provider, c.display_name, g.subject_kind, g.subject_id,
    coalesce(de.name, 'DE'), w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id) or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join digital_employees de on de.id = g.subject_id
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  -- mig 743: see the note in poll_de_work_sources_targets above.
  where c.category = 'helpdesk' and c.status in ('connected', 'error')
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and is_feature_enabled_internal(c.tenant_id, 'proactive_triage');
$fn$;

revoke all on function public.poll_de_work_sources_targets(uuid) from public, anon, authenticated;
revoke all on function public.poll_support_inbox_targets(uuid) from public, anon, authenticated;
grant execute on function public.poll_de_work_sources_targets(uuid) to service_role;
grant execute on function public.poll_support_inbox_targets(uuid) to service_role;

-- ==========================================================================
-- VERIFICATION — fire the exclusion, then prove it is not simply excluding
-- everything, which is what a one-sided test would miss.
-- ==========================================================================
do $$
declare
  v_tenant       uuid;
  v_conn         uuid;
  v_de           uuid;
  v_before       bigint;
  v_after        bigint;
  v_pending_hits integer;
  v_error_hits   integer;
  v_conn_hits    integer;
  v_bad          text[] := '{}';
begin
  select count(*) into v_before from connectors;

  -- Chosen from live data so the probe exercises the REAL joins — grants,
  -- availability, team fallback, tenant_is_operational — rather than a
  -- synthetic row built to pass whatever we wrote. The tenant must be able to
  -- satisfy every one of them, or the "connected is polled" control cannot be
  -- true and the exclusion below would be measuring an empty query.
  select c.tenant_id, c.id, d.id into v_tenant, v_conn, v_de
    from connectors c
    join digital_employees d
      on d.tenant_id = c.tenant_id
     and not coalesce(d.is_workforce_assistant, false)   -- standing prohibition: never touch that employee
     and d.lifecycle_status in ('assigned','active','improving')
     and d.status = 'active'
     and de_is_available(d.availability)
   where c.status = 'connected'
     and tenant_is_operational(c.tenant_id)
   order by c.created_at, c.id, d.id
   limit 1;
  if v_conn is null then
    raise exception '743 vacuity guard: no connected connector in an operational tenant with an available employee — the probe cannot tell an excluded status apart from an empty result, so passing would prove nothing';
  end if;

  begin
    -- Give the existing connector a grant so it is genuinely pollable, then
    -- measure the SAME row at three statuses. Same row, same grant, same
    -- everything — the only variable is `status`, which is the only way to
    -- attribute the difference to this change.
    if v_de is not null then
      insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
        values (v_tenant, 'de', v_de, 'connector', v_conn, 'search')
        on conflict do nothing;
    end if;

    update connectors set status = 'connected' where id = v_conn;
    select count(*) into v_conn_hits from poll_de_work_sources_targets(v_tenant) t where t.connector_id = v_conn;

    update connectors set status = 'error' where id = v_conn;
    select count(*) into v_error_hits from poll_de_work_sources_targets(v_tenant) t where t.connector_id = v_conn;

    update connectors set status = 'pending_credentials' where id = v_conn;
    select count(*) into v_pending_hits from poll_de_work_sources_targets(v_tenant) t where t.connector_id = v_conn;

    -- THE INVERSION FIRST. If a connected connector is not polled, then
    -- "pending_credentials is not polled" is a statement about a broken query,
    -- not about the fix — and every assertion below would pass for the wrong
    -- reason.
    if v_conn_hits = 0 then
      v_bad := v_bad || 'vacuity: a CONNECTED connector with a search grant was not returned by poll_de_work_sources_targets — the exclusion below proves nothing, because nothing is being returned at all';
    end if;

    if v_pending_hits <> 0 then
      v_bad := v_bad || format('a pending_credentials connector was returned %s time(s) — the poller would call a system that has never held a credential and record a failure where an honest skip belongs', v_pending_hits);
    end if;

    -- The half a tidier change would have broken silently.
    if v_error_hits = 0 then
      v_bad := v_bad || 'a connector in ERROR was excluded — that is a system with real credentials whose retry path this poller IS, and narrowing to status = ''connected'' would have stopped it recovering';
    end if;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  -- The probe mutated a real connector's status. If the rollback failed, a
  -- live workspace is now holding a row this migration broke.
  if exists (select 1 from connectors where id = v_conn and status <> 'connected') then
    v_bad := v_bad || 'the probe connector did not return to connected — this migration has mutated a live workspace';
  end if;
  select count(*) into v_after from connectors;
  if v_before <> v_after then
    v_bad := v_bad || format('connectors moved %s -> %s; the probe did not roll back', v_before, v_after);
  end if;

  -- Neither poller may be reachable by a browser.
  if has_function_privilege('authenticated', 'public.poll_de_work_sources_targets(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.poll_support_inbox_targets(uuid)', 'execute') then
    v_bad := v_bad || 'authenticated can execute a poller — these read across every workspace grant and are service-side only';
  end if;
  if not has_function_privilege('service_role', 'public.poll_de_work_sources_targets(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.poll_support_inbox_targets(uuid)', 'execute') then
    v_bad := v_bad || 'service_role lost EXECUTE on a poller — the cron that drives inbound work is now dead';
  end if;

  -- Both functions must carry the fix. Changing one and not the other is the
  -- divergence this migration exists to prevent.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('poll_de_work_sources_targets','poll_support_inbox_targets')
       and p.prosrc not ilike '%in (''connected'', ''error'')%'
  ) then
    v_bad := v_bad || 'one of the two pollers still carries the old deny-list — they must move together';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '743: % check(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '743: all checks passed — same connector, same grant: connected polled (%), error polled (%), pending_credentials NOT polled (%)',
    v_conn_hits, v_error_hits, v_pending_hits;
end $$;
