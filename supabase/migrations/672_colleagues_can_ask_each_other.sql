-- 672_colleagues_can_ask_each_other.sql
-- ============================================================================
-- WHY: Founder decision #2 (2026-08-10; docs/31 Q6, re-read post-mig-611):
-- every WORKING digital employee holds consultation grants to its working
-- colleagues, maintained automatically at hire — the single change that takes
-- DE→DE consultation from dark (1 grant total) to live everywhere.
--
-- de_consultation_grants is read by three live paths, none of which change:
--   • de-work — delegate_to_colleague tool offer + execution gate
--   • de-orchestrate — the supervisor's routing graph
--   • specialist-consult runResolveInquiry — inquiry-time consult
-- Budget, trust and guardrail gates on those paths are untouched; a grant is
-- membership, and its category is audit-only ('other' here — nothing branches
-- on it).
--
-- Design points:
--   • WORKING = lifecycle_status in ('active','published','improving') — the
--     same set the census counts. Designed drafts and retired employees get
--     nothing.
--   • Both directions: the new hire may ask its colleagues, and they may ask
--     the new hire.
--   • ON CONFLICT DO NOTHING against the (tenant, requester, target, category)
--     unique key — an existing row a human has deactivated stays deactivated;
--     the auto-grant never overrides a human's deny.
--   • Backfill for the CURRENT workforce of every tenant (always live to all
--     tenants), then the trigger keeps it current.
-- ============================================================================

begin;

create or replace function public.sync_colleague_consultation_grants()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lifecycle_status not in ('active','published','improving') then
    return new;
  end if;

  -- The (re)activated employee may consult every working colleague…
  insert into de_consultation_grants (tenant_id, requester_de_id, target_de_id, category, active)
  select new.tenant_id, new.id, d.id, 'other', true
  from digital_employees d
  where d.tenant_id = new.tenant_id and d.id <> new.id
    and d.lifecycle_status in ('active','published','improving')
  on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;

  -- …and every working colleague may consult them.
  insert into de_consultation_grants (tenant_id, requester_de_id, target_de_id, category, active)
  select new.tenant_id, d.id, new.id, 'other', true
  from digital_employees d
  where d.tenant_id = new.tenant_id and d.id <> new.id
    and d.lifecycle_status in ('active','published','improving')
  on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;

  return new;
end; $$;

-- Migs 610+630 rule: strip BOTH default-grant mechanisms. Only the trigger
-- (owner context) and service_role ever call this.
revoke all on function public.sync_colleague_consultation_grants() from public, anon, authenticated;

drop trigger if exists trg_colleague_consultation_grants on digital_employees;
create trigger trg_colleague_consultation_grants
  after insert or update of lifecycle_status on digital_employees
  for each row execute function public.sync_colleague_consultation_grants();

-- ── Backfill: the full mesh for every tenant's current working workforce ──
insert into de_consultation_grants (tenant_id, requester_de_id, target_de_id, category, active)
select a.tenant_id, a.id, b.id, 'other', true
from digital_employees a
join digital_employees b
  on b.tenant_id = a.tenant_id and b.id <> a.id
where a.lifecycle_status in ('active','published','improving')
  and b.lifecycle_status in ('active','published','improving')
on conflict (tenant_id, requester_de_id, target_de_id, category) do nothing;

-- ── Verify: no working pair may be missing a grant in either direction.
-- (Deactivated rows count as PRESENT — a human deny is not a gap.)
do $$
declare
  v_missing int;
  v_pairs int;
begin
  select count(*) into v_missing
  from digital_employees a
  join digital_employees b
    on b.tenant_id = a.tenant_id and b.id <> a.id
  where a.lifecycle_status in ('active','published','improving')
    and b.lifecycle_status in ('active','published','improving')
    and not exists (
      select 1 from de_consultation_grants g
      where g.tenant_id = a.tenant_id
        and g.requester_de_id = a.id and g.target_de_id = b.id
    );
  select count(*) into v_pairs
  from digital_employees a
  join digital_employees b
    on b.tenant_id = a.tenant_id and b.id <> a.id
  where a.lifecycle_status in ('active','published','improving')
    and b.lifecycle_status in ('active','published','improving');
  if v_pairs = 0 then
    raise exception 'verify is vacuous: zero working pairs found — census query wrong or no workforce';
  end if;
  if v_missing > 0 then
    raise exception 'colleague mesh incomplete: % of % ordered pairs missing a grant', v_missing, v_pairs;
  end if;
  raise notice 'colleague mesh complete: % ordered pairs covered', v_pairs;
end $$;

commit;
