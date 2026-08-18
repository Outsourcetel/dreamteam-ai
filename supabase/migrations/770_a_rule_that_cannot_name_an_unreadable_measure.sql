-- 770_a_rule_that_cannot_name_an_unreadable_measure.sql
-- ==========================================================================
-- WHY: docs/54 item 2. Three classes of illegal rule are made unrepresentable
-- rather than merely validated:
--   · a comparator that does not fit the dimension's type — composite FK to
--     authority_dimension_comparators, so `reversible >= 5` cannot be stored
--   · a dimension nobody can read — the trigger below, which checks the
--     registry's reader_fn with to_regprocedure. `applied_at`-style stored
--     markers lie; asking the catalog does not.
--   · an outcome outside the ladder — a CHECK
-- ==========================================================================

begin;

create table if not exists public.authority_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- who it binds. 'all' means everyone in the workspace.
  actor_kind  text not null check (actor_kind in ('all','role','user','org_unit','de')),
  -- ⚠ TWO columns, not one. A role is TEXT ('tenant_owner'); a user, org unit
  -- and digital employee are uuids. approval_authority already keeps them
  -- apart for this reason, and step 2's differential compares against it — a
  -- single actor_id uuid could not hold a role at all.
  actor_id    uuid,
  actor_role  text,
  -- NULL category = every category
  category    text,
  dimension   text not null,
  comparator  text not null,
  -- booleans are stored as 1/0 so one column serves both value_types
  threshold   numeric not null,
  outcome     text not null check (outcome in ('require_human','require_second_approver','deny')),
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Exactly the right column for the kind, and nothing else. 'all' names
  -- nobody; 'role' names text; the rest name a uuid.
  constraint authority_rules_actor_shape
    check (
      (actor_kind = 'all'  and actor_id is null     and actor_role is null)
   or (actor_kind = 'role' and actor_id is null     and actor_role is not null)
   or (actor_kind in ('user','org_unit','de') and actor_id is not null and actor_role is null)
    ),
  -- The composite FK is the whole point: an illegal pairing cannot be stored.
  constraint authority_rules_dimension_comparator_fk
    foreign key (dimension, comparator)
    references public.authority_dimension_comparators (dimension, comparator)
);

create index if not exists authority_rules_lookup
  on public.authority_rules (tenant_id, is_active, category);

-- A timestamp that never moves is a stored marker that lies (docs/47's
-- stored-marker-as-truth trap, one column over). Same trigger function
-- approval_authority (mig 593) already uses.
drop trigger if exists authority_rules_updated_at on public.authority_rules;
create trigger authority_rules_updated_at before update on public.authority_rules
  for each row execute function update_updated_at();

create or replace function public.authority_rule_requires_a_reader()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare v_reader text; v_active boolean; v_value_type text;
begin
  select reader_fn, is_active, value_type into v_reader, v_active, v_value_type
    from public.authority_dimensions where dimension = new.dimension;
  if not coalesce(v_active, false) then
    raise exception 'dimension_not_active: % is not a measure this platform offers', new.dimension;
  end if;
  if v_reader is null then
    raise exception 'dimension_has_no_reader: nothing reads % yet, so a rule about it would be decoration — the reader ships before the rule becomes declarable', new.dimension;
  end if;
  -- Ask the catalog, never a stored boolean.
  if to_regprocedure(v_reader) is null then
    raise exception 'dimension_reader_missing: % names %, which does not exist', new.dimension, v_reader;
  end if;
  -- ⛔ A STORABLE RULE THAT CAN NEVER FIRE IS A CONFIGURABLE CONTROL THAT
  -- ENFORCES NOTHING — the same disease this whole registry exists to end,
  -- one column over. The composite FK above stops an illegal COMPARATOR from
  -- being stored (`reversible >= 5`); nothing stopped an illegal THRESHOLD:
  -- evaluate_authority maps a boolean measure to 1 or 0, so `reversible is 7`
  -- can never equal either, and confidence is read as a 0..100 score, so
  -- `confidence < -1` can never trip. Both are legal to insert today and dead
  -- on arrival.
  if v_value_type = 'boolean' and new.threshold not in (0, 1) then
    raise exception 'threshold_cannot_fire: % is boolean, stored as 1 or 0, so a threshold of % can never match', new.dimension, new.threshold;
  end if;
  if new.dimension = 'confidence' and (new.threshold < 0 or new.threshold > 100) then
    raise exception 'threshold_cannot_fire: % is scored 0..100, so a threshold of % can never trip a comparison', new.dimension, new.threshold;
  end if;
  return new;
end
$fn$;

drop trigger if exists authority_rules_require_reader on public.authority_rules;
create trigger authority_rules_require_reader
  before insert or update on public.authority_rules
  for each row execute function public.authority_rule_requires_a_reader();

alter table public.authority_rules enable row level security;

drop policy if exists authority_rules_read on public.authority_rules;
create policy authority_rules_read on public.authority_rules
  for select using (tenant_id = public.auth_tenant_id());

-- No write policy: rules are written through an RPC that arrives with the
-- cutover in step 2. A permissive write policy plus a grant would be a second
-- path to the same state.
revoke all on table public.authority_rules from public, anon, authenticated;
grant select on table public.authority_rules to authenticated;

revoke all on function public.authority_rule_requires_a_reader() from public, anon, authenticated;

commit;
