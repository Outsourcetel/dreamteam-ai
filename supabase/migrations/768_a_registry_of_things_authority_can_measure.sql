-- 768_a_registry_of_things_authority_can_measure.sql
-- ==========================================================================
-- WHY: docs/54 item 2. A dimension that can be written into a rule but has no
-- reader is exactly max_discount_pct — configurable, enforced by asking a
-- model nicely, zero readers. The registry exists so that combination is
-- unrepresentable rather than merely discouraged.
--
-- value_type + the comparator table together make `reversible >= 5`
-- impossible to store, via a composite foreign key rather than a trigger:
-- declarative, and it cannot be forgotten by a later writer.
-- ==========================================================================

begin;

create table if not exists public.authority_dimensions (
  dimension   text primary key,
  value_type  text    not null check (value_type in ('integer','boolean')),
  -- NULL means "no reader exists yet". A rule may not name such a dimension
  -- (enforced in the next migration). Stored as a signature so it can be
  -- checked with to_regprocedure, never as a boolean somebody sets by hand —
  -- a stored marker of truth is not truth.
  reader_fn   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.authority_dimension_comparators (
  dimension  text not null references public.authority_dimensions(dimension) on delete cascade,
  comparator text not null,
  primary key (dimension, comparator)
);

insert into public.authority_dimensions (dimension, value_type, reader_fn) values
  ('amount_cents',  'integer', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)'),
  ('confidence',    'integer', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)'),
  ('subject_count', 'integer', null),
  ('reversible',    'boolean', null),
  ('rate_per_hour', 'integer', null)
on conflict (dimension) do nothing;

insert into public.authority_dimension_comparators (dimension, comparator) values
  ('amount_cents',  '>'),  ('amount_cents',  '>='),
  ('subject_count', '>'),  ('subject_count', '>='),
  ('rate_per_hour', '>'),  ('rate_per_hour', '>='),
  ('confidence',    '<'),  ('confidence',    '<='),
  ('reversible',    'is')
on conflict do nothing;

alter table public.authority_dimensions            enable row level security;
alter table public.authority_dimension_comparators enable row level security;

-- Platform vocabulary, not tenant data: readable by any signed-in user so a
-- rule editor can offer the legal choices, writable by nobody through the API.
drop policy if exists authority_dimensions_read on public.authority_dimensions;
create policy authority_dimensions_read on public.authority_dimensions
  for select using (auth_tenant_id() is not null);
drop policy if exists authority_dimension_comparators_read on public.authority_dimension_comparators;
create policy authority_dimension_comparators_read on public.authority_dimension_comparators
  for select using (auth_tenant_id() is not null);

revoke all on table public.authority_dimensions            from public, anon;
revoke all on table public.authority_dimension_comparators from public, anon;
grant select on table public.authority_dimensions            to authenticated;
grant select on table public.authority_dimension_comparators to authenticated;

commit;
