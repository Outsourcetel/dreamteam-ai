-- Migration 066: tenant-level activity log, requested by the founder as a
-- direct follow-up to the Remote Access write-audit log (migrations
-- 062-063). Same idea, inverted audience: not "what did the platform
-- owner change while borrowing access into a tenant," but "what did this
-- tenant's OWN team change," visible to that tenant's own owner/admin.
--
-- Deliberately the exact mirror-image filter of
-- log_remote_access_write(): that function only logs when the writer's
-- own profile has NO home tenant (remote-access fallback). This one only
-- logs when the writer's own profile DOES have a home tenant matching the
-- row being written -- a genuine tenant member, not a platform admin
-- borrowing access. Since auth.uid() reflects the ORIGINAL calling
-- session's JWT even inside a SECURITY DEFINER RPC (elevated privileges
-- don't reset it), a human's own actions are correctly attributed even
-- when they route through an RPC, while cron/edge-function writes made
-- with the service_role key (auth.uid() IS NULL there) are naturally
-- excluded without needing to special-case any table -- this keeps the
-- log a real "who on my team changed what" trail instead of being
-- flooded with background system activity.
-- =====================================================================

create table if not exists public.tenant_activity_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  actor_user_id uuid not null,
  actor_name text,
  actor_role text,
  table_name text not null,
  operation text not null,
  row_pk text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_activity_log_tenant on public.tenant_activity_log (tenant_id, created_at desc);
create index if not exists idx_tenant_activity_log_actor on public.tenant_activity_log (actor_user_id);

alter table public.tenant_activity_log enable row level security;
alter table public.tenant_activity_log force row level security;

-- Owner/admin only, matching the "each tenant admin/owner can see the
-- changes made by their team" scope the founder asked for -- not open to
-- every tenant member the way most tenant-scoped reads are.
create policy tenant_activity_log_select on public.tenant_activity_log
  for select
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin'])
    )
  );

revoke all on public.tenant_activity_log from anon, authenticated;
grant select on public.tenant_activity_log to authenticated;

create or replace function public.log_tenant_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor_tenant uuid;
  v_actor_name text;
  v_actor_role text;
  v_row_tenant_id uuid;
  v_row_pk text;
begin
  begin
    if auth.uid() is null then
      return coalesce(NEW, OLD);
    end if;

    select tenant_id, full_name, role into v_actor_tenant, v_actor_name, v_actor_role
    from profiles where user_id = auth.uid();

    if v_actor_tenant is null then
      return coalesce(NEW, OLD);
    end if;

    v_row_tenant_id := coalesce(
      nullif(to_jsonb(NEW)->>'tenant_id', '')::uuid,
      nullif(to_jsonb(OLD)->>'tenant_id', '')::uuid
    );

    if v_row_tenant_id is null or v_row_tenant_id is distinct from v_actor_tenant then
      return coalesce(NEW, OLD);
    end if;

    v_row_pk := coalesce(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id');

    insert into tenant_activity_log (
      tenant_id, actor_user_id, actor_name, actor_role,
      table_name, operation, row_pk, old_data, new_data
    ) values (
      v_row_tenant_id, auth.uid(), coalesce(v_actor_name, 'Team member'), v_actor_role,
      TG_TABLE_NAME, TG_OP, v_row_pk,
      case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(OLD) else null end,
      case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(NEW) else null end
    );
  exception when others then
    null;
  end;
  return coalesce(NEW, OLD);
end;
$function$;

revoke all on function public.log_tenant_activity() from public, anon, authenticated;
