-- 783_a_workspace_can_write_an_authority_rule.sql
-- ==========================================================================
-- WHY: authority_rules (mig 770) shipped with NO write policy, deliberately —
-- writes go through this RPC so there is exactly one path to that state. A
-- permissive write policy plus a table grant would be a second path to the
-- same rows, which this repo has paid for before.
--
-- The RPC deliberately does NOT re-implement the guarantees 770 already
-- enforces in the schema. The composite FK still rejects an illegal
-- (dimension, comparator) pairing, and the trigger still rejects a dimension
-- with no live reader and a threshold that could never fire. This function
-- adds only what a CHECK cannot see: WHO is asking, and whether the actor
-- they named is theirs.
-- ==========================================================================

begin;

create or replace function public.set_authority_rule(
  p_actor_kind text,
  p_dimension  text,
  p_comparator text,
  p_threshold  numeric,
  p_outcome    text,
  p_category   text  default null,
  p_actor_id   uuid  default null,
  p_actor_role text  default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'insufficient_role';
  end if;

  -- The shape CHECK in 770 would catch these, but its message names a
  -- constraint. These name the mistake.
  if p_actor_kind = 'role' and coalesce(btrim(p_actor_role), '') = '' then
    raise exception 'actor_role_required: a rule scoped to a role must name the role';
  end if;
  if p_actor_kind in ('user','org_unit','de') and p_actor_id is null then
    raise exception 'actor_id_required: a rule scoped to % must name which one', p_actor_kind;
  end if;

  -- ⛔ AN ACTOR ID SUPPLIED BY A CALLER IS AN ASSERTION, NOT AUTHORISATION.
  -- Without these, an owner could scope a rule onto another workspace's
  -- employee or org unit — the tenant-id-param trap, one level down.
  if p_actor_kind = 'user' and not exists (
       select 1 from profiles where user_id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no profile for that user here';
  end if;
  if p_actor_kind = 'de' and not exists (
       select 1 from digital_employees where id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no digital employee with that id here';
  end if;
  if p_actor_kind = 'org_unit' and not exists (
       select 1 from org_units where id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no org unit with that id here';
  end if;

  insert into authority_rules
    (tenant_id, actor_kind, actor_id, actor_role, category,
     dimension, comparator, threshold, outcome, created_by)
  values
    (v_tenant, p_actor_kind,
     case when p_actor_kind in ('user','org_unit','de') then p_actor_id end,
     case when p_actor_kind = 'role' then btrim(p_actor_role) end,
     nullif(btrim(coalesce(p_category, '')), ''),
     p_dimension, p_comparator, p_threshold, p_outcome, auth.uid())
  returning id into v_id;

  return v_id;
end
$fn$;

revoke all on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) from public;
revoke all on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) from anon;
grant execute on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) to authenticated;

commit;
