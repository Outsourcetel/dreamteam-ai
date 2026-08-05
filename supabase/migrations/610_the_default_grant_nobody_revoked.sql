-- 610 — the default grant nobody revoked.
--
-- Found while verifying the contacts panel: checking who could execute
-- set_account_contact showed EXECUTE:PUBLIC and EXECUTE:anon. Postgres grants
-- EXECUTE to PUBLIC on every new function, PUBLIC includes anon, and an
-- explicit `grant ... to service_role` does not remove it. Every migration in
-- this session added functions and none revoked it.
--
-- 650 of the platform's SECURITY DEFINER functions already have anon revoked.
-- 52 did not. Almost all 52 were written in the last two days, by me.
--
-- ⚠ NOT A THEORETICAL FINDING. Assuming the anon role and calling them:
--
--     resolve_external_account   -> CREATED a customer account in a named tenant
--     upsert_external_ticket     -> INSERTED a support ticket in a named tenant
--     list_org_tree              -> READ 13 org units, first = "Head Office",
--                                   including member names, job titles,
--                                   digital-employee names and trust levels
--
-- anon is the key that ships inside the browser bundle. So this was reachable
-- by anyone, unauthenticated, against any tenant id they could name.
--
-- What SAVED the rest was not the grant but `auth_tenant_id()`, which has anon
-- revoked: every function that reaches it failed with "permission denied for
-- function auth_tenant_id". That is the actual rule — a SECURITY DEFINER
-- function is exposed exactly when it never touches auth_tenant_id(). It is
-- also why revoking anon alone would be theatre: PUBLIC includes anon, so the
-- revoke has to name PUBLIC.
--
-- Two of these need more than a grant. `list_org_tree(p_tenant_id)` and
-- `assign_human_task(p_task_id)` take the tenant/task as a PARAMETER and never
-- check it, so even after anon is shut out, any AUTHENTICATED user of any
-- tenant could read another tenant's org chart by passing a different uuid.
-- The grant and the check each close a different door; neither is sufficient.
--
-- `verify_embed_token` is deliberately left anon-callable — it is how an
-- embedded widget authenticates before a session exists. It is the one
-- function in this set where anon is the point.

begin;

-- ── A guard that says which tenant the caller may name ───────────────────
-- ⚠ Returns cleanly when auth_tenant_id() is NULL, which is true for BOTH
-- service_role and anon. That is deliberate but only safe because the EXECUTE
-- grant below shuts anon out. The check handles authenticated-cross-tenant;
-- the grant handles unauthenticated. Removing either re-opens the hole.
create or replace function assert_own_tenant(p_tenant_id uuid)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_mine uuid := auth_tenant_id();
begin
  if v_mine is not null and p_tenant_id is distinct from v_mine then
    raise exception 'that workspace is not yours';
  end if;
  return p_tenant_id;
end;
$$;

revoke execute on function assert_own_tenant(uuid) from public;
grant execute on function assert_own_tenant(uuid) to authenticated, service_role;

-- ── list_org_tree: keep the body, put a door in front of it ──────────────
-- Spliced rather than retyped — the body is 40 lines of recursive CTE and
-- re-transcribing it to add one guard is how a working query acquires a typo.
do $splice$
declare
  v_def text := (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'list_org_tree');
  v_new text;
begin
  if v_def is null then raise exception 'list_org_tree is gone'; end if;
  if (select count(*) from regexp_matches(v_def, 'FUNCTION public\.list_org_tree\(', 'g')) <> 1 then
    raise exception 'expected exactly one name to rewrite';
  end if;

  v_new := replace(v_def, 'FUNCTION public.list_org_tree(',
                          'FUNCTION public.list_org_tree_core(');
  if v_new = v_def then raise exception 'the rename spliced nothing'; end if;
  execute v_new;
end;
$splice$;

create or replace function list_org_tree(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_own_tenant(p_tenant_id);
  return list_org_tree_core(p_tenant_id);
end;
$$;

-- ── assign_human_task: the task must be in the caller's workspace ────────
do $splice$
declare
  v_def    text := (select pg_get_functiondef(p.oid) from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'assign_human_task');
  v_anchor text := '  if v_task.assigned_user_id is not null and not p_force then';
  v_guard  text := '  if auth_tenant_id() is not null and v_task.tenant_id <> auth_tenant_id() then'
                || E'\n    raise exception ''that task is not in this workspace'';'
                || E'\n  end if;' || E'\n';
  v_new    text;
  v_before int;
  v_after  int;
begin
  if v_def is null then raise exception 'assign_human_task is gone'; end if;

  v_before := (select count(*) from regexp_matches(v_def, regexp_replace(v_anchor, '([().*+?\[\]{}\\^$|])', '\\\1', 'g'), 'g'));
  if v_before <> 1 then
    raise exception 'anchor appears % times, expected exactly 1 — refusing to splice', v_before;
  end if;

  v_new := replace(v_def, v_anchor, v_guard || v_anchor);
  v_after := (select count(*) from regexp_matches(v_new, 'that task is not in this workspace', 'g'));
  if v_after <> 1 then
    raise exception 'guard landed % times, expected 1', v_after;
  end if;

  execute v_new;
end;
$splice$;

-- ── Shut the default grant on everything it should never have covered ────
-- Dynamic, so it closes what is ACTUALLY open rather than what a hand-written
-- list remembered. Trigger functions are skipped: PostgREST cannot expose them
-- and Postgres refuses to call them directly, so their grant is inert — and
-- revoking on a live trigger is a risk taken for no gain.
do $lock$
declare
  r record;
  v_service text[] := array[
    'resolve_external_account','upsert_external_ar_record','upsert_external_contact',
    'upsert_external_opportunity','upsert_external_ticket','run_dunning_sweep',
    'install_role_watchers','dunning_action_for','dunning_de_for',
    'task_approval_facts','has_approval_authority','list_org_tree_core'
  ];
  v_closed int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef
      and format_type(p.prorettype, null) <> 'trigger'
      -- anon authenticates the embedded widget here; this is the one place
      -- where the public grant is the feature.
      and p.proname <> 'verify_embed_token'
      and exists (
        select 1 from information_schema.routine_privileges a
        where a.specific_name = p.proname || '_' || p.oid and a.grantee = 'anon'
      )
  loop
    execute format('revoke execute on function public.%I(%s) from public, anon',
                   r.proname, r.args);

    if r.proname = any(v_service) then
      execute format('grant execute on function public.%I(%s) to service_role',
                     r.proname, r.args);
    else
      execute format('grant execute on function public.%I(%s) to authenticated, service_role',
                     r.proname, r.args);
    end if;
    v_closed := v_closed + 1;
  end loop;

  raise notice 'closed the default grant on % functions', v_closed;
end;
$lock$;

-- ── Stop it coming back ──────────────────────────────────────────────────
-- The revokes above fix what exists. This fixes the next one somebody writes.
-- ⚠ FOR ANYONE WORKING IN PARALLEL: a new function is no longer executable by
-- default. If a migration adds one for the UI it must now say so explicitly:
--     grant execute on function <name>(<args>) to authenticated;
-- The failure mode is "permission denied for function X" — loud, and closed
-- rather than open, which is the right way round for this to break.
alter default privileges in schema public revoke execute on functions from public;

-- ── Prove it, as anon, against the three that actually got through ───────

do $verify$
declare
  v_t     uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_msg   text;
  v_leak  text[] := '{}';
  v_ok    int := 0;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  set local role anon;

  begin
    perform resolve_external_account(v_t, '__verify__', 'V-1', 'Injected Co');
    v_leak := v_leak || 'resolve_external_account'::text;
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;

  begin
    perform upsert_external_ticket(v_t, '__verify__', 'V-1', 's', 'b', 'Open', 'High', null, null);
    v_leak := v_leak || 'upsert_external_ticket'::text;
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;

  begin
    perform list_org_tree(v_t);
    v_leak := v_leak || 'list_org_tree'::text;
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;

  -- The widget's door must still open, or embedded chat stops working for
  -- every tenant. A security fix that breaks a live feature is not a fix.
  begin
    perform verify_embed_token('not-a-real-token');
    v_ok := v_ok + 1;
  exception
    when insufficient_privilege then
      raise exception 'verify_embed_token lost its anon grant — embedded widgets would break';
    when others then
      -- Any other error means it RAN and rejected a bogus token, which is
      -- exactly right.
      v_ok := v_ok + 1;
  end;

  reset role;

  if array_length(v_leak, 1) is not null then
    raise exception 'STILL REACHABLE BY anon: %', array_to_string(v_leak, ', ');
  end if;
  if v_ok <> 4 then
    raise exception 'only % of 4 checks actually ran', v_ok;
  end if;

  raise notice 'anon is shut out of all three, and the widget door still opens';
end;
$verify$;

-- ── And that a real user can still do their own work ─────────────────────

do $verify$
declare
  v_t    uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_uid  uuid;
  v_tree jsonb;
  v_msg  text;
begin
  select p.user_id into v_uid from profiles p
  where p.tenant_id = v_t and p.role = 'tenant_owner' limit 1;
  if v_uid is null then raise notice 'no owner to verify against'; return; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  v_tree := list_org_tree(v_t);
  if jsonb_array_length(v_tree) = 0 then
    raise exception 'the owner can no longer read their own org tree';
  end if;

  -- ...and still cannot read anybody else's.
  begin
    perform list_org_tree('00000000-0000-0000-0000-000000000001'::uuid);
    raise exception 'an authenticated user read another workspace';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like '%an authenticated user read another workspace%' then raise; end if;
    if v_msg not like '%not yours%' then
      raise exception 'cross-tenant read failed for the wrong reason: %', v_msg;
    end if;
  end;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'owner reads % units of their own tree, and none of anyone elses',
    jsonb_array_length(v_tree);
end;
$verify$;

commit;
