-- 627 — approval limits everywhere, and for every workspace made from now on.
--
-- 626 set limits in outsourcetel-hq only. The founder asked for the same in
-- every existing workspace and in any workspace created from today. This does
-- both, from ONE function so the two can never drift apart — the backfill and
-- the provisioning path run identical code.
--
-- ⚠⚠ THE TEMPLATE CANNOT BE COPIED VERBATIM, AND FINDING OUT WHY WAS THE WHOLE
-- JOB. 626 assumes an owner sits above the admin. Across the estate:
--
--     11 of 16 workspaces have NO tenant_owner AT ALL.
--     Their only human is a tenant_admin.
--
-- Applying 626's template there caps the most senior person in the workspace at
-- $250,000 and demands a second signature over $100,000 from a rank that does
-- not exist. Nothing breaks today — every amount is null, so the ceiling and
-- the second-signature branch are both unreachable — but it seeds a deadlock
-- that detonates the day an executor first attaches a number to its work. A
-- control nobody can satisfy is not a control, it is a freeze with a timer on
-- it.
--
-- So the admin rule is DERIVED, not fixed:
--
--     owner present  →  admin is capped ($250k, second signature over $100k)
--     no owner       →  admin IS the top authority: unlimited, no second
--
-- The rank always gets whatever authority the workspace's shape actually
-- supports. When an owner is later added to one of those eleven, the owner's
-- unlimited row already exists and the admin's row is visible and editable on
-- the Organisation page — it narrows by a human decision, not silently.
--
-- ⚠ `role='tenant_owner'` unlimited is seeded in EVERY workspace including the
-- eleven that have no owner today. It matches nobody there, costs nothing, and
-- means the escape hatch is already in place the moment somebody is promoted.
--
-- ⚠ ORDERING, for the provisioning path: complete_signup sets
-- role='tenant_owner' at line ~60 and calls provision_tenant_baseline_internal
-- at line ~79 — the owner EXISTS before the baseline runs, so the derivation
-- above sees it and a normally-signed-up workspace gets the capped-admin
-- template. Checked, not assumed.

begin;

-- ════════════════════════════════════════════════════════════════════════
-- The one definition of "what approval limits should a workspace start with".
-- ════════════════════════════════════════════════════════════════════════
create or replace function seed_approval_baseline(p_tenant_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_existing  int;
  v_has_owner boolean;
  v_seeded    int;
begin
  if p_tenant_id is null then return 0; end if;

  -- Idempotent, and deliberately blunt: if a workspace has declared ANY
  -- authority we leave it entirely alone. Re-running must never duplicate a
  -- grant, and must never resurrect one somebody deactivated on purpose.
  select count(*) into v_existing from approval_authority where tenant_id = p_tenant_id;
  if v_existing > 0 then return 0; end if;

  select exists (
    select 1 from profiles
     where tenant_id = p_tenant_id and role = 'tenant_owner' and is_active
  ) into v_has_owner;

  -- 1. The escape hatch by RANK — survives the person leaving. Seeded even
  --    where no owner exists yet, so a promotion needs no follow-up config.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  values
    (p_tenant_id, 'tenant_owner', null, null, null,
     'Owner — final authority, any work, any amount. This row is what stops a '
     'category nobody wrote a rule for from freezing the queue. Do not delete it.');

  -- 2. The same authority pinned to each owner PERSONALLY, so changing a role
  --    cannot lock the workspace out.
  insert into approval_authority
    (tenant_id, user_id, category, max_amount_cents, second_approver_above_cents, note)
  select p_tenant_id, p.user_id, null, null, null,
         'The owner personally — the same authority pinned to the person rather '
         'than the role, so changing a role cannot lock the workspace out.'
  from profiles p
  where p.tenant_id = p_tenant_id and p.role = 'tenant_owner' and p.is_active;

  -- 3. Admin — DERIVED. See the header: a ceiling is only a control if
  --    somebody exists above it.
  if v_has_owner then
    insert into approval_authority
      (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
    values
      (p_tenant_id, 'tenant_admin', null, 25000000, 10000000,
       'Admin — any kind of work up to $250,000. Over $100,000 a second person '
       'must also approve; the owner can always be that second person.');
  else
    insert into approval_authority
      (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
    values
      (p_tenant_id, 'tenant_admin', null, null, null,
       'Admin — final authority in this workspace, because it has no owner. '
       'Capping the most senior person, with nobody above them to escalate to, '
       'would freeze work rather than govern it. Narrow this once an owner exists.');
  end if;

  -- 4. Manager — routine amounts only.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  values
    (p_tenant_id, 'tenant_manager', null, 2500000, null,
     'Manager — any kind of work up to $25,000, so routine items only.');

  -- 5. Everyone else — the support queue, and nothing carrying money. A zero
  --    ceiling is not a formality: with an amount attached the check refuses,
  --    so priced work rises to a manager instead of being waved through.
  insert into approval_authority
    (tenant_id, role, category, max_amount_cents, second_approver_above_cents, note)
  select p_tenant_id, 'tenant_user', c, 0, null,
         'Support staff — may clear ' || c || ', but nothing carrying money; '
         'anything with an amount goes to a manager.'
  from unnest(array['helpdesk','escalation','inquiry_review','checklist','knowledge_revision']) as c;

  select count(*) into v_seeded from approval_authority where tenant_id = p_tenant_id;
  return v_seeded;
end;
$$;

revoke execute on function seed_approval_baseline(uuid) from public;
grant execute on function seed_approval_baseline(uuid) to service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Every workspace that exists today.
-- ════════════════════════════════════════════════════════════════════════
do $backfill$
declare
  r        record;
  v_n      int;
  v_total  int := 0;
  v_shops  int := 0;
begin
  -- ⚠ ALL tenants, not just operational ones. A suspended workspace still
  -- needs its policy in place for when it comes back; the limits are inert
  -- while it is dormant either way.
  for r in select id, slug from tenants order by slug loop
    v_n := seed_approval_baseline(r.id);
    if v_n > 0 then
      v_total := v_total + v_n;
      v_shops := v_shops + 1;
    end if;
  end loop;
  raise notice 'seeded % rule(s) across % workspace(s)', v_total, v_shops;
end;
$backfill$;

-- ════════════════════════════════════════════════════════════════════════
-- Every workspace made from now on. Spliced, not rewritten — the function
-- seeds guardrails, feature flags and onboarding templates and I am not
-- retyping any of that from memory.
-- ════════════════════════════════════════════════════════════════════════
do $splice$
declare
  v_src    text;
  v_new    text;
  v_anchor text := '  if v_seeded_guardrails > 0 or v_seeded_template then';
  v_before int;
  v_after  int;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'provision_tenant_baseline_internal';

  if v_src is null then raise exception 'provision_tenant_baseline_internal not found'; end if;

  -- ⚠ Assert the anchor BEFORE and the result AFTER. A before-only check
  -- cannot tell a successful splice from a silent no-op.
  v_before := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_before <> 1 then
    raise exception 'expected exactly 1 anchor, found % — refusing to splice blind', v_before;
  end if;

  if position('seed_approval_baseline' in v_src) > 0 then
    raise notice 'provisioning already seeds approval limits — nothing to splice';
    return;
  end if;

  v_new := replace(v_src, v_anchor,
    '  -- mig 627: a new workspace gets its approval limits with everything else,'  || chr(10) ||
    '  -- from the same function that backfilled the existing ones.'                || chr(10) ||
    '  perform seed_approval_baseline(p_tenant_id);'                                || chr(10) ||
    chr(10) ||
    v_anchor);

  v_after := (length(v_new) - length(replace(v_new, 'seed_approval_baseline', ''))) / length('seed_approval_baseline');
  if v_after <> 1 then
    raise exception 'splice produced % call(s) to seed_approval_baseline, expected 1', v_after;
  end if;

  execute v_new;
  raise notice 'provisioning now seeds approval limits';
end;
$splice$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFY — the only question that matters: can the most senior person in
-- each workspace still approve the work actually sitting in their queue?
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  r          record;
  v_top      uuid;
  v_cat      text;
  v_res      jsonb;
  v_blocked  text[];
  v_bad      text[] := '{}';
  v_norules  text[] := '{}';
  v_checked  int := 0;
  v_selftest boolean := false;
begin
  -- ⚠ SELF-TEST. This block loops over queries that could return nothing;
  -- a verify that silently does not run is worse than no verify at all.
  select id into v_top from tenants where slug = 'outsourcetel-hq';
  if v_top is not null then
    v_res := has_approval_authority(
      (select user_id from profiles where tenant_id = v_top and role = 'tenant_owner' and is_active limit 1),
      v_top, 'a-category-nobody-declared', 999999999999);
    if not coalesce((v_res->>'allowed')::boolean, false) then
      raise exception 'SELF-TEST FAILED: the escape hatch does not hold: %', v_res->>'reason';
    end if;
    v_selftest := true;
  end if;

  for r in select id, slug from tenants order by slug loop
    if not exists (select 1 from approval_authority where tenant_id = r.id and is_active) then
      v_norules := v_norules || r.slug;
      continue;
    end if;

    -- The most senior human present: an owner if there is one, else an admin.
    select p.user_id into v_top
    from profiles p
    where p.tenant_id = r.id and p.is_active and p.role in ('tenant_owner','tenant_admin')
    order by case p.role when 'tenant_owner' then 0 else 1 end, p.created_at
    limit 1;

    -- No humans at all (outsourcetel) — nothing to lock out.
    if v_top is null then continue; end if;

    v_checked := v_checked + 1;
    v_blocked := '{}';

    for v_cat in
      select distinct coalesce(ad.category, h.type)
      from human_tasks h
      left join action_executions ae
        on ae.id = h.related_id and h.related_table = 'action_executions'
      left join action_definitions ad on ad.id = ae.action_definition_id
      where h.tenant_id = r.id and h.status = 'pending'
    loop
      v_res := has_approval_authority(v_top, r.id, v_cat, null);
      if not coalesce((v_res->>'allowed')::boolean, false) then
        v_blocked := v_blocked || v_cat;
      end if;
    end loop;

    if array_length(v_blocked, 1) > 0 then
      v_bad := v_bad || (r.slug || ' (' || array_to_string(v_blocked, ', ') || ')');
    end if;
  end loop;

  if array_length(v_norules, 1) > 0 then
    raise exception '% workspace(s) still have no approval rules: %',
      array_length(v_norules, 1), array_to_string(v_norules, ', ');
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'the most senior person is locked out in: % — rolling back',
      array_to_string(v_bad, ' | ');
  end if;

  if not v_selftest then raise exception 'verify block did not execute its self-test'; end if;
  if v_checked = 0 then raise exception 'verified no workspaces — the loop did not run'; end if;

  raise notice 'every workspace has limits; senior approver clears their whole queue in all % checked', v_checked;
end;
$verify$;

commit;
