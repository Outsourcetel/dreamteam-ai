-- Migration 062: gap 5 from the 2026-07-07 adversarial pass. Remote Access
-- was found to allow broad, unaudited-at-the-row-level writes -- a
-- platform admin mid-session could silently change real tenant data with
-- no record of what changed. Founder's direction: keep read+write (don't
-- neuter the feature), but log every change made under a remote-access
-- session with who made it.
--
-- Core mechanism (this migration): the audit table and the trigger
-- function every tenant-scoped table's trigger will call. Deliberately
-- signal-based rather than table-specific: fires on every write, but
-- only actually logs when the writer's OWN account has no home tenant
-- (profiles.tenant_id is null) AND is platform-layer -- meaning any
-- successful write under RLS could only have happened via the
-- remote-access fallback branch of auth_tenant_id() (migration 058). An
-- ordinary tenant member's own writes are never logged by this path; they
-- were never routed through the remote-access branch to begin with.
--
-- Wrapped in its own exception handler so a bug in this audit logic can
-- never block the real write it's observing -- this must fail open, the
-- same discipline used for the sign-in/signup Auth Hooks in migration 060.
-- The actual `create trigger ... for each row` attachment to every
-- tenant-scoped table is a separate, mechanical follow-up migration.
-- =====================================================================

create table if not exists public.remote_access_write_log (
  id bigint generated always as identity primary key,
  session_key uuid,
  operator_user_id uuid not null,
  operator_name text,
  tenant_id uuid not null,
  table_name text not null,
  operation text not null,
  row_pk text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_remote_access_write_log_tenant on public.remote_access_write_log (tenant_id, created_at desc);
create index if not exists idx_remote_access_write_log_session on public.remote_access_write_log (session_key);

alter table public.remote_access_write_log enable row level security;
alter table public.remote_access_write_log force row level security;

-- Append-only, platform-admin-readable, matching platform_access_events'
-- own posture: no UPDATE/DELETE policy at all, and no INSERT policy for
-- anon/authenticated either -- only the trigger function (SECURITY
-- DEFINER, runs as its owner) ever writes to this table.
create policy remote_access_write_log_select on public.remote_access_write_log
  for select
  using (is_platform_admin());

revoke all on public.remote_access_write_log from anon, authenticated;
grant select on public.remote_access_write_log to authenticated;

create or replace function public.log_remote_access_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_remote boolean;
  v_full_name text;
  v_session_key uuid;
  v_tenant_id uuid;
  v_row_pk text;
begin
  begin
    select
      (not exists (select 1 from profiles where user_id = auth.uid() and tenant_id is not null))
      and exists (select 1 from profiles where user_id = auth.uid() and layer = 'platform')
    into v_is_remote;

    if not coalesce(v_is_remote, false) then
      return coalesce(NEW, OLD);
    end if;

    v_tenant_id := coalesce(
      nullif(to_jsonb(NEW)->>'tenant_id', '')::uuid,
      nullif(to_jsonb(OLD)->>'tenant_id', '')::uuid
    );
    if v_tenant_id is null then
      return coalesce(NEW, OLD);
    end if;

    select full_name into v_full_name from profiles where user_id = auth.uid();

    select e.session_key into v_session_key
    from platform_access_events e
    where e.operator_user_id = auth.uid()
      and e.event = 'start'
      and e.created_at > now() - interval '12 hours'
      and e.id = (
        select e2.id from platform_access_events e2
        where e2.operator_user_id = auth.uid()
        order by e2.created_at desc limit 1
      )
    limit 1;

    v_row_pk := coalesce(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id');

    insert into remote_access_write_log (
      session_key, operator_user_id, operator_name, tenant_id,
      table_name, operation, row_pk, old_data, new_data
    ) values (
      v_session_key, auth.uid(), coalesce(v_full_name, 'Platform admin'), v_tenant_id,
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

revoke all on function public.log_remote_access_write() from public, anon, authenticated;
