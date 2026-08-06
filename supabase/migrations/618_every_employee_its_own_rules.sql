-- 618 — every employee its own rules, and every playbook its own.
--
-- Founder, 2026-08-06: rules must sit at EMPLOYEE level, because each employee
-- does a different job; no default should apply to all of them; with no rule an
-- employee does nothing automatically; and a playbook layer on top.
--
-- ⚠ ALMOST ALL OF THIS ALREADY EXISTED AND WAS UNREACHABLE. `de_autonomy`
-- already carries de_id, source_category, max_amount_cents and min_confidence,
-- and resolve_de_autonomy already walks DE+category → DE → workspace+category →
-- workspace → deny. Three things kept it from ever being used:
--
-- 1. ⚠⚠ THE KEY LADDER WAS ORDERED GENERIC-FIRST. decide_action_execution asks
--    resolve_de_autonomy_chain for array['action_execute', 'action:'||category]
--    — and the chain returns on the FIRST key that has any row in the tenant.
--    With 31 workspace `action_execute` rows, the generic key always matched and
--    'action:<category>' was NEVER REACHED. That single ordering is why only
--    three dial types exist across the whole platform and why a per-category
--    rule has never once been consulted.
--
-- 2. The workspace tiers (de_id IS NULL) meant one row governed everybody. A
--    Finance employee reaching nine system categories and a Growth employee
--    reaching two were held to the same blanket rule.
--
-- 3. There was no playbook dimension at all.
--
-- After this migration the precedence is, most specific first:
--
--      playbook + employee + category
--      playbook + employee
--      employee + category
--      employee
--      DENY
--
-- No workspace tier. No default. An employee with no rule does nothing
-- automatically — which is what the chain already promised ("deny, one explicit
-- row — never empty") and could not deliver while defaults existed.
--
-- ⚠ SAFE TO DO NOW: every employee is frozen at `supervised` trust and
-- de_records_gate supervises on top, so nothing is executing autonomously today
-- regardless. This changes the POSTURE, not today's behaviour.

begin;

-- ── 1. The playbook dimension ────────────────────────────────────────────
alter table de_autonomy
  add column if not exists playbook_id uuid references playbook_definitions(id) on delete cascade;

-- ⚠ THE OLD UNIQUENESS MADE THE PLAYBOOK LAYER IMPOSSIBLE.
-- de_autonomy_tenant_action_category_de_uq covered
-- (tenant, action_type, source_category, de_id) and knew nothing about
-- playbooks — so a playbook rule collided with the employee rule it is meant
-- to override, and the two could never coexist. Caught by this migration's own
-- verify block on the first dry run, not by reading. It has to go before the
-- replacement can be created.
--
-- ⚠ It is a unique INDEX, not a table constraint — `alter table ... drop
-- constraint if exists` on it is a SILENT NO-OP, which is exactly what happened
-- on the second dry run. Same shape as dropping a function with the wrong
-- argument types. Drop the index, and assert it is actually gone.
drop index if exists de_autonomy_tenant_action_category_de_uq;

do $guard$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'i'
      and c.relname = 'de_autonomy_tenant_action_category_de_uq'
  ) then
    raise exception 'the playbook-blind unique index survived the drop';
  end if;
end;
$guard$;

-- One rule per (employee, playbook, action, category). Partial-unique so the
-- NULL combinations stay distinct rather than colliding.
create unique index if not exists idx_de_autonomy_one_rule_per_scope
  on de_autonomy (tenant_id, action_type,
                  coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(source_category, ''));

-- ── 2. Precedence: specific wins, and there is no default ────────────────
create or replace function resolve_de_autonomy(
  p_tenant_id uuid, p_action_type text, p_de_id uuid default null,
  p_source_category text default null, p_playbook_id uuid default null
) returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_row   de_autonomy;
  v_gated boolean := false;
begin
  -- Records gate (mig 258): a gated employee is supervised whatever the dial
  -- says. Checked first so every branch below inherits it.
  if p_de_id is not null then
    select g.gated into v_gated from public.de_records_gate(p_tenant_id, p_de_id) g;
  end if;

  -- playbook + employee + category
  if p_playbook_id is not null and p_de_id is not null and p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and playbook_id = p_playbook_id and source_category = p_source_category
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  -- playbook + employee
  if p_playbook_id is not null and p_de_id is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and playbook_id = p_playbook_id and source_category is null
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  -- employee + category
  if p_de_id is not null and p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and playbook_id is null and source_category = p_source_category
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  -- employee
  if p_de_id is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and playbook_id is null and source_category is null
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  -- ⚠ NO WORKSPACE TIER. The two branches that used to read de_id IS NULL rows
  -- are gone on purpose: a default that applies to every employee is exactly
  -- what the founder ruled out. Reaching here means this employee has no rule
  -- for this action, and the answer to that is no.
  return query select false, null::bigint, null::integer;
end;
$$;

revoke execute on function resolve_de_autonomy(uuid, text, uuid, text, uuid) from public;
grant execute on function resolve_de_autonomy(uuid, text, uuid, text, uuid) to authenticated, service_role;

-- ── 3. The chain must look for THIS employee's rule ──────────────────────
-- It used to accept a key if ANY row existed for that action_type anywhere in
-- the tenant, then resolve. With workspace rows gone that becomes a real bug:
-- another employee's row on an earlier key would satisfy the check, the chain
-- would return that key's deny, and this employee's own rule on a later key
-- would never be tried.
create or replace function resolve_de_autonomy_chain(
  p_tenant_id uuid, p_keys text[], p_de_id uuid default null,
  p_source_category text default null, p_playbook_id uuid default null
) returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_key text;
begin
  foreach v_key in array coalesce(p_keys, array[]::text[]) loop
    if v_key is null or v_key = '' then continue; end if;
    if exists (
      select 1 from de_autonomy a
      where a.tenant_id = p_tenant_id
        and a.action_type = v_key
        and a.de_id is not distinct from p_de_id
        and (p_playbook_id is null or a.playbook_id is not distinct from p_playbook_id
             or a.playbook_id is null)
    ) then
      return query select * from resolve_de_autonomy(p_tenant_id, v_key, p_de_id, p_source_category, p_playbook_id);
      return;
    end if;
  end loop;
  -- No key has a rule for this employee: deny, one explicit row — never empty.
  return query select false, null::bigint, null::integer;
end;
$$;

revoke execute on function resolve_de_autonomy_chain(uuid, text[], uuid, text, uuid) from public;
grant execute on function resolve_de_autonomy_chain(uuid, text[], uuid, text, uuid) to authenticated, service_role;

-- ── 4. Ask the SPECIFIC key first ────────────────────────────────────────
-- Spliced rather than retyped: decide_action_execution is long and the only
-- thing wrong with it is the order of two array elements.
do $splice$
declare
  v_def text;
  v_old text := E'      nullif(p_action_type, \'\'),\n      case when nullif(p_category, \'\') is not null then \'action:\' || p_category end,';
  v_new text := E'      -- ⚠ SPECIFIC FIRST (mig 618). Reversed, the generic key matched\n'
             || E'      -- whenever any row existed and \'action:<category>\' was never reached,\n'
             || E'      -- which is why a per-category rule had never once been consulted.\n'
             || E'      case when nullif(p_category, \'\') is not null then \'action:\' || p_category end,\n'
             || E'      nullif(p_action_type, \'\'),';
  v_out text;
  v_n   int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'decide_action_execution';
  if v_def is null then raise exception 'decide_action_execution is missing'; end if;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / nullif(length(v_old), 0);
  if coalesce(v_n, 0) <> 1 then
    raise exception 'key-ladder anchor appears % times, expected 1 — refusing to splice', coalesce(v_n, 0);
  end if;

  v_out := replace(v_def, v_old, v_new);
  if v_out = v_def then raise exception 'the ladder splice was a silent no-op'; end if;
  execute v_out;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'decide_action_execution';
  if position('SPECIFIC FIRST' in v_def) = 0 then
    raise exception 'the reordered ladder did not land';
  end if;
end;
$splice$;

-- ── 5. The defaults go ───────────────────────────────────────────────────
-- Recorded before deleting so the count is in the migration log, not folklore.
do $cleanup$
declare v_n int;
begin
  select count(*) into v_n from de_autonomy where de_id is null;
  delete from de_autonomy where de_id is null;
  raise notice 'removed % workspace-default rule(s) — no rule now applies to every employee', v_n;
end;
$cleanup$;

-- ── 6. What dials should THIS employee even have? ────────────────────────
-- Derived from the system categories it actually holds a grant to, so a Finance
-- employee reaching nine categories gets nine rows to decide and a Growth
-- employee reaching two gets two. Never a fixed list: a dial for work an
-- employee cannot do is noise, and a missing dial is an ungoverned action.
create or replace function derive_de_autonomy_dials(p_de_id uuid)
returns table(action_type text, source_category text, label text,
              configured boolean, enabled boolean,
              max_amount_cents bigint, min_confidence integer)
language sql stable security definer set search_path = public as $$
  with de as (
    select d.id, d.tenant_id from digital_employees d
    where d.id = p_de_id and d.tenant_id = auth_tenant_id()
  ),
  cats as (
    select distinct g.resource_category as cat
    from data_access_grants g join de on g.subject_id = de.id
    where g.subject_kind = 'de' and g.resource_category is not null
  )
  select
    ('action:' || c.cat)::text                              as action_type,
    c.cat::text                                             as source_category,
    (replace(initcap(replace(c.cat, '_', ' ')), ' ', ' ') || ' actions')::text as label,
    (a.id is not null)                                      as configured,
    coalesce(a.enabled, false)                              as enabled,
    a.max_amount_cents,
    a.min_confidence
  from cats c
  cross join de
  left join de_autonomy a
    on a.tenant_id = de.tenant_id and a.de_id = de.id
   and a.action_type = 'action:' || c.cat
   and a.playbook_id is null
  order by 1;
$$;

revoke execute on function derive_de_autonomy_dials(uuid) from public;
grant execute on function derive_de_autonomy_dials(uuid) to authenticated, service_role;

-- ── 7. The writer learns about playbooks ─────────────────────────────────
create or replace function set_de_autonomy(
  p_action_type text, p_enabled boolean, p_max_amount_cents bigint,
  p_min_confidence integer, p_de_id uuid, p_source_category text,
  p_playbook_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may change what an employee may do on its own';
  end if;
  -- ⚠ An employee is REQUIRED. A NULL de_id used to mean "workspace default,
  -- applies to everybody", and that is precisely what 618 removed.
  if p_de_id is null then
    raise exception 'a rule must name the employee it governs — workspace-wide defaults were removed in migration 618';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    raise exception 'that employee is not in this workspace';
  end if;
  if p_playbook_id is not null
     and not exists (select 1 from playbook_definitions where id = p_playbook_id and tenant_id = v_tenant) then
    raise exception 'that playbook is not in this workspace';
  end if;

  insert into de_autonomy (tenant_id, action_type, enabled, max_amount_cents, min_confidence,
                           de_id, source_category, playbook_id, updated_by, updated_at)
  values (v_tenant, p_action_type, coalesce(p_enabled, false), p_max_amount_cents, p_min_confidence,
          p_de_id, nullif(btrim(p_source_category), ''), p_playbook_id, auth.uid(), now())
  on conflict (tenant_id, action_type,
               coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(source_category, ''))
  do update set enabled = excluded.enabled,
                max_amount_cents = excluded.max_amount_cents,
                min_confidence = excluded.min_confidence,
                updated_by = excluded.updated_by,
                updated_at = now()
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid) from public;
grant execute on function set_de_autonomy(text, boolean, bigint, integer, uuid, text, uuid) to authenticated, service_role;

-- ── Prove the precedence, with real rows ─────────────────────────────────
do $verify$
declare
  v_t   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_de  uuid;
  v_de2 uuid;
  v_pb  uuid;
  v_en  boolean;
  v_amt bigint;
  v_left int;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  -- No workspace default may survive.
  select count(*) into v_left from de_autonomy where de_id is null;
  if v_left > 0 then raise exception '% workspace default(s) survived', v_left; end if;

  select id into v_de from digital_employees where tenant_id = v_t and status = 'active' order by created_at limit 1;
  select id into v_de2 from digital_employees where tenant_id = v_t and status = 'active' and id <> v_de order by created_at limit 1;
  if v_de is null then raise notice 'no employee to verify against'; return; end if;

  -- 1. No rule ⇒ DENY.
  select enabled into v_en from resolve_de_autonomy(v_t, 'action:__probe__', v_de, 'billing', null);
  if v_en is not false then raise exception 'an employee with no rule was allowed to act'; end if;

  -- 2. An employee-level rule applies to THAT employee only.
  insert into de_autonomy (tenant_id, action_type, enabled, max_amount_cents, de_id, source_category)
  values (v_t, 'action:__probe__', true, 5000, v_de, 'billing');

  select enabled, max_amount_cents into v_en, v_amt
  from resolve_de_autonomy(v_t, 'action:__probe__', v_de, 'billing', null);
  if v_en is not true or v_amt <> 5000 then
    raise exception 'the employee rule did not apply (enabled=%, amount=%)', v_en, v_amt;
  end if;

  if v_de2 is not null then
    select enabled into v_en from resolve_de_autonomy(v_t, 'action:__probe__', v_de2, 'billing', null);
    if v_en is not false then
      raise exception 'one employee''s rule leaked onto another — that is the default problem again';
    end if;
  end if;

  -- 3. A playbook rule OVERRIDES the employee rule.
  select id into v_pb from playbook_definitions where tenant_id = v_t limit 1;
  if v_pb is not null then
    insert into de_autonomy (tenant_id, action_type, enabled, max_amount_cents, de_id, source_category, playbook_id)
    values (v_t, 'action:__probe__', false, 1, v_de, 'billing', v_pb);

    select enabled into v_en from resolve_de_autonomy(v_t, 'action:__probe__', v_de, 'billing', v_pb);
    if v_en is not false then
      raise exception 'the playbook rule did not override the employee rule';
    end if;
    -- ...and without the playbook, the employee rule still stands.
    select enabled into v_en from resolve_de_autonomy(v_t, 'action:__probe__', v_de, 'billing', null);
    if v_en is not true then
      raise exception 'the playbook rule leaked outside its playbook';
    end if;
  end if;

  delete from de_autonomy where action_type = 'action:__probe__';

  raise notice 'precedence proven: no rule denies, an employee rule is that employee''s alone, a playbook rule overrides it';
end;
$verify$;

commit;
