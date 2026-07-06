-- Migration 050: Foundational multi-level tenant hierarchy
-- =====================================================================
-- Founder's explicit "fix this once and for all" request: a parent
-- platform, tenants underneath it, and tenants able to have sub-tenants
-- (arbitrary depth — "four levels is a possibility"), each sub-tenant
-- granted only limited, customer-centric access by its parent. Creation
-- is HYBRID: self-serve where a tenant is trusted to do so
-- (allow_self_serve_subtenants = true), otherwise a creation request
-- routes to the PLATFORM (not the parent tenant) for approval — matching
-- the "requires approval by default, earned" pattern already used
-- throughout this codebase (trust dial, action execution, etc.).
--
-- CRITICAL ARCHITECTURAL FRAMING — read before touching anything else:
-- every one of the ~87 existing SECURITY DEFINER functions and every
-- existing RLS policy isolates tenants strictly by tenant_id with zero
-- knowledge of hierarchy. A sub-tenant is just a tenants row with a
-- parent_tenant_id pointer. NONE of that existing isolation is touched,
-- modified, or made "hierarchy aware" by this migration — that is
-- explicitly out of scope. This migration is 100% additive: the tree
-- structure itself (parent_tenant_id + a maintained closure/ancestry
-- table), the provisioning/approval workflow, NEW opt-in rollup
-- read-only helper functions (a genuinely new capability, not a
-- modification of existing isolation), and a feature-flag control panel.
--
-- Research grounding: hierarchical tenant isolation at scale uses a
-- MAINTAINED CLOSURE TABLE (tenant_id, ancestor_id, depth) updated via
-- trigger, not a recursive CTE evaluated per-row-check — closure-table
-- lookups are simple indexed equality scans, recursive CTEs recompute the
-- walk on every call and don't scale. Each user belongs to exactly ONE
-- tenant (profiles.tenant_id stays a single FK, never multi-membership),
-- per standard B2B provisioning practice.
--
-- The demo tenant (a0000000-0000-0000-0000-000000000001) is NEVER
-- written by this migration and must never be assignable as anyone's
-- parent_tenant_id — it stays a flat, isolated demo island exactly as it
-- is today. Enforced below by extending guard_against_demo_tenant_assignment's
-- sibling guard on tenants.parent_tenant_id.

-- =====================================================================
-- SECTION 1: Core hierarchy schema
-- =====================================================================

alter table tenants
  add column if not exists parent_tenant_id uuid references tenants(id),
  add column if not exists allow_self_serve_subtenants boolean not null default false;

comment on column tenants.parent_tenant_id is
  'Nullable pointer to the parent tenant in the hierarchy. NULL = top-level tenant. A sub-tenant is otherwise an ordinary tenants row -- every existing tenant_id-scoped RLS policy and SECURITY DEFINER function isolates it exactly as strictly as any flat tenant, with zero special-casing.';
comment on column tenants.allow_self_serve_subtenants is
  'Governs whether creating a CHILD under THIS tenant can skip platform approval. Default false: sub-tenant creation requires platform approval by default, matching the earned-trust pattern used elsewhere in this codebase (trust dial, action execution). A tenant owner/admin can flip this on for their own tenant to let their own trusted org self-serve sub-tenant creation.';

-- Defense against cycles: a tenant can never be its own ancestor. This is
-- a fast, cheap direct-parent self-reference guard; the trigger-maintained
-- ancestry table below additionally caps chain walks at a sane max depth
-- to catch any cycle that slipped past this check (e.g. via a race).
alter table tenants
  add constraint tenants_not_self_parent check (id is distinct from parent_tenant_id);

create index if not exists idx_tenants_parent_tenant_id on tenants(parent_tenant_id);

-- ---------------------------------------------------------------
-- tenant_ancestry: maintained closure table. One row per (tenant_id,
-- ancestor_id) pair reachable by walking parent_tenant_id upward,
-- including the self row (ancestor_id = tenant_id, depth = 0). This is
-- what every hierarchy-aware lookup queries -- an indexed equality scan,
-- never a recursive walk at check time.
-- ---------------------------------------------------------------
create table if not exists tenant_ancestry (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  ancestor_id uuid not null references tenants(id) on delete cascade,
  depth       integer not null,
  primary key (tenant_id, ancestor_id)
);

create index if not exists idx_tenant_ancestry_ancestor on tenant_ancestry(ancestor_id);
create index if not exists idx_tenant_ancestry_tenant on tenant_ancestry(tenant_id);

alter table tenant_ancestry enable row level security;
alter table tenant_ancestry force row level security;
-- No direct client access -- this table is read exclusively through the
-- guarded helper functions below (is_ancestor_of / tenant_descendants /
-- tenant_ancestors), which apply the real authorization check. Deny-all
-- policy is defense in depth, mirroring the platform_config pattern from
-- migration 038.
drop policy if exists tenant_ancestry_deny_all on tenant_ancestry;
create policy tenant_ancestry_deny_all on tenant_ancestry
  for all using (false) with check (false);
revoke all on table tenant_ancestry from anon, authenticated;

-- Max depth a chain walk will traverse before assuming a cycle slipped
-- past the self-parent check (e.g. via a concurrent race) and aborting
-- loudly rather than looping forever.
create or replace function recompute_tenant_ancestry(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_current uuid := p_tenant_id;
  v_depth   integer := 0;
  v_parent  uuid;
  v_max_depth constant integer := 10;
begin
  delete from tenant_ancestry where tenant_id = p_tenant_id;

  loop
    insert into tenant_ancestry (tenant_id, ancestor_id, depth)
    values (p_tenant_id, v_current, v_depth)
    on conflict (tenant_id, ancestor_id) do nothing;

    select parent_tenant_id into v_parent from tenants where id = v_current;
    exit when v_parent is null;

    v_depth := v_depth + 1;
    if v_depth > v_max_depth then
      raise exception 'tenant hierarchy exceeds max depth (%) while walking ancestry for % -- a cycle likely slipped past the self-parent guard',
        v_max_depth, p_tenant_id;
    end if;

    v_current := v_parent;
  end loop;
end;
$function$;

revoke all on function recompute_tenant_ancestry(uuid) from public, anon, authenticated;
-- internal helper, invoked only by the trigger below (as the trigger
-- owner) and by the RPCs in this migration -- never granted directly.

-- Trigger: whenever a tenant's parent_tenant_id changes (or a tenant is
-- newly inserted), recompute that tenant's own ancestry chain. Also
-- recompute every descendant's ancestry, since a change partway up the
-- chain changes the ancestor set for everything below it too.
create or replace function trg_recompute_tenant_ancestry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_descendant uuid;
begin
  perform recompute_tenant_ancestry(NEW.id);

  if TG_OP = 'UPDATE' and NEW.parent_tenant_id is distinct from OLD.parent_tenant_id then
    for v_descendant in
      select tenant_id from tenant_ancestry where ancestor_id = NEW.id and tenant_id <> NEW.id
    loop
      perform recompute_tenant_ancestry(v_descendant);
    end loop;
  end if;

  return NEW;
end;
$function$;

drop trigger if exists trg_tenant_ancestry on tenants;
create trigger trg_tenant_ancestry
  after insert or update of parent_tenant_id on tenants
  for each row
  execute function trg_recompute_tenant_ancestry();

-- Trigger functions get a default PUBLIC EXECUTE grant on CREATE FUNCTION
-- just like any other function -- revoking on a different function name
-- earlier in this file does NOT cover this one. Revoke explicitly.
revoke all on function trg_recompute_tenant_ancestry() from public, anon, authenticated;

-- Backfill: every existing tenant is top-level today (flat model), so
-- give each one its self row (depth 0). Safe/idempotent; demo tenant
-- gets exactly its own self row like everything else, no parent.
insert into tenant_ancestry (tenant_id, ancestor_id, depth)
select id, id, 0 from tenants
on conflict (tenant_id, ancestor_id) do nothing;

-- ---------------------------------------------------------------
-- Guarded helper functions. Each is useful only to a caller who has some
-- legitimate relationship to p_tenant_id: a member of that tenant, a
-- member of one of its ancestors (opt-in rollup visibility), or a
-- platform admin. Anyone else is rejected -- these are NOT open lookups.
-- ---------------------------------------------------------------
create or replace function caller_has_tenant_relationship(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    is_platform_admin()
    or exists (
      select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = p_tenant_id
    )
    or exists (
      -- caller's own tenant is an ancestor of p_tenant_id => opt-in rollup
      -- visibility for a parent looking at a descendant.
      select 1
      from profiles pr
      join tenant_ancestry ta on ta.tenant_id = p_tenant_id and ta.ancestor_id = pr.tenant_id
      where pr.user_id = auth.uid()
    );
$function$;

revoke all on function caller_has_tenant_relationship(uuid) from public, anon, authenticated;
-- internal helper only -- not directly granted, used by the functions below.

create or replace function is_ancestor_of(p_ancestor_id uuid, p_tenant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not caller_has_tenant_relationship(p_tenant_id) and not caller_has_tenant_relationship(p_ancestor_id) then
    raise exception 'not authorized to inspect the relationship between these tenants';
  end if;
  return exists (
    select 1 from tenant_ancestry where tenant_id = p_tenant_id and ancestor_id = p_ancestor_id
  );
end;
$function$;

revoke all on function is_ancestor_of(uuid, uuid) from public, anon, authenticated;
grant execute on function is_ancestor_of(uuid, uuid) to authenticated;

create or replace function tenant_descendants(p_tenant_id uuid)
returns table(tenant_id uuid, depth integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not caller_has_tenant_relationship(p_tenant_id) then
    raise exception 'not authorized to view descendants of this tenant';
  end if;
  return query
    select ta.tenant_id, ta.depth
    from tenant_ancestry ta
    where ta.ancestor_id = p_tenant_id and ta.tenant_id <> p_tenant_id
    order by ta.depth, ta.tenant_id;
end;
$function$;

revoke all on function tenant_descendants(uuid) from public, anon, authenticated;
grant execute on function tenant_descendants(uuid) to authenticated;

create or replace function tenant_ancestors(p_tenant_id uuid)
returns table(tenant_id uuid, depth integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not caller_has_tenant_relationship(p_tenant_id) then
    raise exception 'not authorized to view ancestors of this tenant';
  end if;
  return query
    select ta.ancestor_id, ta.depth
    from tenant_ancestry ta
    where ta.tenant_id = p_tenant_id and ta.ancestor_id <> p_tenant_id
    order by ta.depth, ta.ancestor_id;
end;
$function$;

revoke all on function tenant_ancestors(uuid) from public, anon, authenticated;
grant execute on function tenant_ancestors(uuid) to authenticated;

-- ---------------------------------------------------------------
-- Extend the demo-tenant guard (migration 038) so the demo tenant can
-- never be set as anyone's parent_tenant_id either -- it stays a flat,
-- isolated island exactly as it is today.
-- ---------------------------------------------------------------
create or replace function guard_against_demo_tenant_parent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if NEW.parent_tenant_id = 'a0000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'Cannot set the demo tenant (a0000000-0000-0000-0000-000000000001) as a parent_tenant_id. This tenant is reserved for the seeded product demo only and must remain a flat, isolated island.';
  end if;
  if NEW.id = 'a0000000-0000-0000-0000-000000000001'::uuid and NEW.parent_tenant_id is not null then
    raise exception 'The demo tenant (a0000000-0000-0000-0000-000000000001) can never be given a parent_tenant_id.';
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_guard_demo_tenant_parent on tenants;
create trigger trg_guard_demo_tenant_parent
  before insert or update of parent_tenant_id on tenants
  for each row
  execute function guard_against_demo_tenant_parent();

-- Same default-PUBLIC-grant issue as above -- revoke explicitly.
revoke all on function guard_against_demo_tenant_parent() from public, anon, authenticated;

-- =====================================================================
-- SECTION 2: Provisioning + approval workflow
-- =====================================================================
-- Reuses the established human_tasks/approval-request pattern from
-- trust_promotion (migration 025): a request row + a human_tasks
-- notification + separate approve/reject RPCs gated by an explicit
-- authorization check, all audited via append_audit_event.
--
-- human_tasks.tenant_id is NOT NULL (confirmed against the live schema)
-- -- it is strictly tenant-scoped, with no platform-scoped equivalent.
-- Rather than force a NULL/platform sentinel into a NOT NULL tenant-owned
-- table, tenant_provisioning_requests carries its own status and platform
-- admins are notified by querying pending requests directly in the
-- Platform Console (Section 4) -- a platform-scoped equivalent of the
-- human_tasks inbox, adapted cleanly rather than bent to fit a
-- tenant-shaped table.

create table if not exists tenant_provisioning_requests (
  id                      uuid primary key default gen_random_uuid(),
  requested_by_user_id    uuid not null references profiles(user_id),
  proposed_parent_tenant_id uuid references tenants(id),
  proposed_name           text not null,
  proposed_industry       text,
  status                  text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by             uuid references profiles(user_id),
  decided_at              timestamptz,
  rejection_reason        text,
  created_tenant_id       uuid references tenants(id),
  created_at              timestamptz not null default now()
);

create index if not exists idx_tenant_provisioning_requests_status on tenant_provisioning_requests(status);
create index if not exists idx_tenant_provisioning_requests_parent on tenant_provisioning_requests(proposed_parent_tenant_id);

alter table tenant_provisioning_requests enable row level security;
alter table tenant_provisioning_requests force row level security;

-- Requesting user can see their own requests; a member of the proposed
-- parent tenant can see requests aimed at their tenant; platform admins
-- see everything. No direct INSERT/UPDATE policy -- all writes go through
-- the guarded RPCs below (SECURITY DEFINER, bypasses RLS by design).
drop policy if exists tpr_select on tenant_provisioning_requests;
create policy tpr_select on tenant_provisioning_requests
  for select
  using (
    requested_by_user_id = auth.uid()
    or is_platform_admin()
    or exists (
      select 1 from profiles pr
      where pr.user_id = auth.uid() and pr.tenant_id = tenant_provisioning_requests.proposed_parent_tenant_id
    )
  );

revoke all on table tenant_provisioning_requests from anon;
grant select on table tenant_provisioning_requests to authenticated;

comment on table tenant_provisioning_requests is
  'Pending/decided requests to create a new sub-tenant when the parent does not have allow_self_serve_subtenants enabled. proposed_parent_tenant_id NULL means a brand-new top-level tenant (in practice only ever created by a platform admin, not through self-serve).';

-- ---------------------------------------------------------------
-- request_subtenant: the single entry point for creating a sub-tenant.
-- Caller must be tenant_owner/tenant_admin of p_parent_tenant_id (an
-- ordinary tenant member cannot request a sub-tenant on the org's
-- behalf), OR a platform admin (who may also create a fresh top-level
-- tenant by passing p_parent_tenant_id = NULL).
--
-- If the parent has allow_self_serve_subtenants = true AND the caller is
-- an owner/admin of it: create the tenant IMMEDIATELY (mirrors
-- complete_signup's tenant-creation shape: unique slug via collision
-- suffix, starter/trial defaults, ancestry populated via the trigger),
-- and additionally insert a tenant_provisioning_requests row already
-- marked status='approved' for audit symmetry -- every tenant, self-serve
-- or not, has exactly one traceable provisioning-request record.
--
-- Otherwise: insert a pending tenant_provisioning_requests row. Platform
-- admins see it in the Platform Console's pending-approvals panel.
-- ---------------------------------------------------------------
create or replace function request_subtenant(p_parent_tenant_id uuid, p_name text, p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_role       text;
  v_caller_tenant uuid;
  v_parent     tenants;
  v_is_platform boolean := is_platform_admin();
  v_slug       text;
  v_base_slug  text;
  v_suffix     int := 0;
  v_tenant     tenants;
  v_request_id uuid;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'proposed tenant name is required';
  end if;

  if p_parent_tenant_id is null then
    -- Only platform admins may create a fresh top-level tenant this way.
    if not v_is_platform then
      raise exception 'only a platform admin may create a new top-level tenant';
    end if;
  else
    if p_parent_tenant_id = v_demo_tenant_id then
      raise exception 'the demo tenant cannot be used as a parent tenant';
    end if;

    select * into v_parent from tenants where id = p_parent_tenant_id;
    if not found then
      raise exception 'parent tenant not found';
    end if;

    select role, tenant_id into v_role, v_caller_tenant from profiles where user_id = v_user;

    if not v_is_platform then
      if v_caller_tenant is distinct from p_parent_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
        raise exception 'only an owner or admin of the parent tenant may request a sub-tenant';
      end if;
    end if;
  end if;

  if v_is_platform or (p_parent_tenant_id is not null and v_parent.allow_self_serve_subtenants) then
    v_base_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := trim(both '-' from v_base_slug);
    if coalesce(v_base_slug, '') = '' then
      v_base_slug := 'org';
    end if;
    v_slug := v_base_slug;
    while exists (select 1 from tenants where slug = v_slug) loop
      v_suffix := v_suffix + 1;
      v_slug := v_base_slug || '-' || v_suffix::text;
    end loop;

    insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
    values (btrim(p_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, p_parent_tenant_id)
    returning * into v_tenant;

    insert into tenant_provisioning_requests
      (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status, reviewed_by, decided_at, created_tenant_id)
    values
      (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'approved', v_user, now(), v_tenant.id)
    returning id into v_request_id;

    -- Audit under the PARENT tenant's own trail, but ONLY when the caller
    -- is a genuine member of it -- append_audit_event's guard requires
    -- service_role or tenant membership, and a platform admin taking this
    -- same immediate-creation branch is typically NOT a member of the
    -- parent (or of the brand-new child, which never has the caller as a
    -- member either). When there's no parent (fresh top-level tenant) or
    -- the caller has no membership there (platform admin path), the
    -- tenant_provisioning_requests row itself (status/reviewed_by/decided_at)
    -- is the durable record, matching how platform-only actions elsewhere
    -- in this codebase (e.g. platform_config_set, migration 038) are
    -- recorded without a tenant-scoped audit event.
    if p_parent_tenant_id is not null and exists (
      select 1 from profiles where user_id = v_user and tenant_id = p_parent_tenant_id
    ) then
      perform append_audit_event(
        p_parent_tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'owner'), 'human',
        format('Sub-tenant "%s" self-serve created (new tenant id %s)', v_tenant.name, v_tenant.id),
        'config_change',
        jsonb_build_object('kind', 'tenant_provisioned_self_serve', 'tenant_id', v_tenant.id,
          'parent_tenant_id', p_parent_tenant_id, 'request_id', v_request_id, 'user_id', v_user)
      );
    end if;

    return jsonb_build_object('ok', true, 'path', 'self_serve', 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'request_id', v_request_id);
  end if;

  -- Approval-required path: platform reviews, not the parent tenant.
  insert into tenant_provisioning_requests
    (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status)
  values
    (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'pending')
  returning id into v_request_id;

  -- Same membership consideration as above: only audit under the parent
  -- tenant's trail when there is one and the caller is a member of it. In
  -- practice this branch is only reached when the caller was already
  -- verified above to be owner/admin of p_parent_tenant_id, but the
  -- explicit re-check costs nothing and keeps this call safe against
  -- future edits to the branch above it.
  if p_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = v_user and tenant_id = p_parent_tenant_id
  ) then
    perform append_audit_event(
      p_parent_tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'requester'), 'human',
      format('Sub-tenant creation requested — "%s" — routed to platform for approval', btrim(p_name)),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_requested', 'request_id', v_request_id,
        'proposed_parent_tenant_id', p_parent_tenant_id, 'proposed_name', btrim(p_name), 'user_id', v_user)
    );
  end if;

  return jsonb_build_object('ok', true, 'path', 'pending_platform_approval', 'request_id', v_request_id);
end;
$function$;

revoke all on function request_subtenant(uuid, text, text) from public, anon, authenticated;
grant execute on function request_subtenant(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------
-- approve_subtenant_request / reject_subtenant_request: platform-admin
-- only. Approve creates the real tenant row and, if the requesting user
-- has no tenant yet, links them as owner (mirrors complete_signup's
-- linking step).
-- ---------------------------------------------------------------
create or replace function approve_subtenant_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req      tenant_provisioning_requests;
  v_slug     text;
  v_base_slug text;
  v_suffix   int := 0;
  v_tenant   tenants;
  v_requester_tenant uuid;
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may approve a tenant provisioning request';
  end if;

  select * into v_req from tenant_provisioning_requests where id = p_request_id for update;
  if not found then
    raise exception 'provisioning request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request has already been decided (status=%)', v_req.status;
  end if;

  v_base_slug := lower(regexp_replace(btrim(v_req.proposed_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if coalesce(v_base_slug, '') = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix::text;
  end loop;

  insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
  values (v_req.proposed_name, v_slug, nullif(btrim(coalesce(v_req.proposed_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, v_req.proposed_parent_tenant_id)
  returning * into v_tenant;

  update tenant_provisioning_requests
  set status = 'approved', reviewed_by = auth.uid(), decided_at = now(), created_tenant_id = v_tenant.id
  where id = p_request_id;

  -- Link the requesting user as owner if they don't already have a tenant
  -- (mirrors complete_signup's idempotency guard: never re-point an
  -- already-provisioned account).
  select tenant_id into v_requester_tenant from profiles where user_id = v_req.requested_by_user_id;
  if v_requester_tenant is null then
    update profiles
    set tenant_id = v_tenant.id, role = 'tenant_owner', updated_at = now()
    where user_id = v_req.requested_by_user_id and tenant_id is null;
  end if;

  -- A platform admin approving this request is generally NOT a member of
  -- either the new tenant or its parent, so append_audit_event's
  -- service_role-or-member guard would reject auditing under either id.
  -- Only audit under the parent's trail when the admin happens to also be
  -- a genuine member of it (defense-in-depth, not the common case); the
  -- tenant_provisioning_requests row (status/reviewed_by/decided_at) is
  -- the durable audit record for the platform-admin decision itself,
  -- consistent with how platform-only actions are recorded elsewhere in
  -- this codebase (e.g. platform_config_set, migration 038).
  if v_req.proposed_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_req.proposed_parent_tenant_id
  ) then
    perform append_audit_event(
      v_req.proposed_parent_tenant_id, 'Platform admin', 'human',
      format('Sub-tenant "%s" approved and created (request %s, new tenant id %s)', v_tenant.name, p_request_id, v_tenant.id),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_approved', 'request_id', p_request_id,
        'tenant_id', v_tenant.id, 'parent_tenant_id', v_req.proposed_parent_tenant_id,
        'approved_by', auth.uid(), 'requested_by', v_req.requested_by_user_id)
    );
  end if;

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant.id, 'slug', v_tenant.slug);
end;
$function$;

revoke all on function approve_subtenant_request(uuid) from public, anon, authenticated;
grant execute on function approve_subtenant_request(uuid) to authenticated;

create or replace function reject_subtenant_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req tenant_provisioning_requests;
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may reject a tenant provisioning request';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a rejection reason is required';
  end if;

  select * into v_req from tenant_provisioning_requests where id = p_request_id for update;
  if not found then
    raise exception 'provisioning request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request has already been decided (status=%)', v_req.status;
  end if;

  update tenant_provisioning_requests
  set status = 'rejected', reviewed_by = auth.uid(), decided_at = now(), rejection_reason = btrim(p_reason)
  where id = p_request_id;

  -- Same membership consideration as approve_subtenant_request above: only
  -- audit under the parent's trail if there is one and the admin happens
  -- to be a genuine member of it. The tenant_provisioning_requests row
  -- (status='rejected', reviewed_by, decided_at, rejection_reason) is
  -- itself the durable record of the platform decision either way.
  if v_req.proposed_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_req.proposed_parent_tenant_id
  ) then
    perform append_audit_event(
      v_req.proposed_parent_tenant_id, 'Platform admin', 'human',
      format('Sub-tenant request "%s" rejected — %s', v_req.proposed_name, btrim(p_reason)),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_rejected', 'request_id', p_request_id,
        'proposed_name', v_req.proposed_name, 'reason', btrim(p_reason), 'rejected_by', auth.uid(),
        'requested_by', v_req.requested_by_user_id)
    );
  end if;

  return jsonb_build_object('ok', true, 'rejected', true, 'reason', btrim(p_reason));
end;
$function$;

revoke all on function reject_subtenant_request(uuid, text) from public, anon, authenticated;
grant execute on function reject_subtenant_request(uuid, text) to authenticated;

-- =====================================================================
-- SECTION 3: Feature flag / entitlement registry (the "control panel")
-- =====================================================================

create table if not exists feature_registry (
  key              text primary key,
  label            text not null,
  description      text,
  default_enabled  boolean not null default true,
  category         text,
  created_at       timestamptz not null default now()
);

alter table feature_registry enable row level security;
alter table feature_registry force row level security;
-- Every authenticated user may read the registry (it's not secret --
-- it's the catalogue of feature keys and their platform-wide defaults;
-- needed client-side to render toggle labels). Only platform admins may
-- write to it, via a guarded RPC path (no direct INSERT/UPDATE policy).
drop policy if exists feature_registry_select on feature_registry;
create policy feature_registry_select on feature_registry
  for select using (auth.uid() is not null);
revoke all on table feature_registry from anon;
grant select on table feature_registry to authenticated;

create table if not exists tenant_feature_overrides (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  feature_key text not null references feature_registry(key) on delete cascade,
  enabled     boolean not null,
  set_by      uuid references profiles(user_id),
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, feature_key)
);

alter table tenant_feature_overrides enable row level security;
alter table tenant_feature_overrides force row level security;
-- A tenant member may see their own tenant's overrides; platform admins
-- see all. No direct write policy -- writes go through the guarded RPC.
drop policy if exists tfo_select on tenant_feature_overrides;
create policy tfo_select on tenant_feature_overrides
  for select
  using (
    is_platform_admin()
    or exists (select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = tenant_feature_overrides.tenant_id)
  );
revoke all on table tenant_feature_overrides from anon;
grant select on table tenant_feature_overrides to authenticated;

create or replace function is_feature_enabled(p_tenant_id uuid, p_feature_key text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_override boolean;
  v_default  boolean;
begin
  if not (
    is_platform_admin()
    or exists (select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to check feature flags for this tenant';
  end if;

  select enabled into v_override from tenant_feature_overrides
  where tenant_id = p_tenant_id and feature_key = p_feature_key;
  if found then
    return v_override;
  end if;

  select default_enabled into v_default from feature_registry where key = p_feature_key;
  if not found then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;
  return v_default;
end;
$function$;

revoke all on function is_feature_enabled(uuid, text) from public, anon, authenticated;
grant execute on function is_feature_enabled(uuid, text) to authenticated;

-- set_tenant_feature_override: platform-admin only for now (the "control
-- panel" is platform-operated per the founder's spec: "each tenant has
-- it's own guardrails, security and permission levels" set from above).
-- A tenant self-service toggle UI is a reasonable future extension but
-- explicitly out of scope here -- see final report for what's deferred.
create or replace function set_tenant_feature_override(p_tenant_id uuid, p_feature_key text, p_enabled boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may set a tenant feature override';
  end if;

  if not exists (select 1 from feature_registry where key = p_feature_key) then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;

  insert into tenant_feature_overrides (tenant_id, feature_key, enabled, set_by, note, updated_at)
  values (p_tenant_id, p_feature_key, p_enabled, auth.uid(), p_note, now())
  on conflict (tenant_id, feature_key)
  do update set enabled = excluded.enabled, set_by = excluded.set_by, note = excluded.note, updated_at = now();

  -- A platform admin setting a flag for a tenant they don't personally
  -- belong to is the common case, and append_audit_event's
  -- service_role-or-member guard would reject auditing under p_tenant_id
  -- in that case. Only audit under the tenant's own trail when the admin
  -- happens to be a genuine member of it; tenant_feature_overrides'
  -- own set_by/note/updated_at columns are the durable record of the
  -- platform decision either way (same pattern as the provisioning RPCs
  -- above).
  if exists (select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id) then
    perform append_audit_event(
      p_tenant_id, 'Platform admin', 'human',
      format('Feature "%s" set to %s for this tenant', p_feature_key, case when p_enabled then 'ON' else 'OFF' end),
      'config_change',
      jsonb_build_object('kind', 'tenant_feature_override_set', 'feature_key', p_feature_key,
        'enabled', p_enabled, 'set_by', auth.uid(), 'note', p_note)
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function set_tenant_feature_override(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function set_tenant_feature_override(uuid, text, boolean, text) to authenticated;

-- Seed the registry with a representative starting set of major shipped
-- capabilities. Not exhaustive by design -- new features should add a
-- registry row going forward as a lightweight convention, not a
-- retrofit-everything-today requirement.
insert into feature_registry (key, label, description, default_enabled, category) values
  ('connector_hub', 'Connector Hub', 'Connect external systems (CRM, email, calendars) to feed live data to Digital Employees.', true, 'platform'),
  ('proactive_triage', 'Proactive Inquiry Triage', 'Automatically triages and routes incoming inquiries before a human looks at them.', true, 'automation'),
  ('de_memory', 'Digital Employee Memory', 'Digital Employees retain and recall context across conversations and sessions.', true, 'digital_employees'),
  ('finance_de', 'Finance Digital Employee', 'A Digital Employee specialized in finance operations and reporting.', true, 'digital_employees'),
  ('account_de', 'Account Digital Employee', 'A Digital Employee specialized in account management and customer success.', true, 'digital_employees'),
  ('staleness_watchdog', 'Staleness Watchdog', 'Flags knowledge and data that has gone stale and needs a refresh.', true, 'automation'),
  ('identity_credential_inventory', 'Identity & Credential Inventory', 'Tracks and audits identities and credentials in use across the tenant.', true, 'security')
on conflict (key) do nothing;

-- =====================================================================
-- Grant-check evidence (paste actual results in the final report): every
-- new SECURITY DEFINER function below must show zero rows for
-- anon/PUBLIC grantees.
--   select routine_name, grantee from information_schema.routine_privileges
--   where grantee in ('anon','PUBLIC')
--   and routine_name in (
--     'recompute_tenant_ancestry','trg_recompute_tenant_ancestry',
--     'caller_has_tenant_relationship','is_ancestor_of','tenant_descendants',
--     'tenant_ancestors','guard_against_demo_tenant_parent','request_subtenant',
--     'approve_subtenant_request','reject_subtenant_request','is_feature_enabled',
--     'set_tenant_feature_override'
--   );
-- =====================================================================
