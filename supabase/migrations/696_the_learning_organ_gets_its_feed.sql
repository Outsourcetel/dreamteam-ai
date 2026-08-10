-- 696_the_learning_organ_gets_its_feed.sql
-- ============================================================================
-- WHY (gap G-E, part 1 — found 2026-08-11 while verifying the learning loop):
-- the learned-behavior organ (learned-behavior-detect, cron every 6h) and its
-- two SQL halves iterate `de_learning_policies where enabled = true` — and
-- that table has ZERO rows in every tenant. The organ has run since the day
-- it shipped and never once had a candidate. Built-but-unfed, in the exact
-- shape of the mig-625 circuit breaker: a net that requires a row nobody
-- creates. The UI only LISTS policies (selfLearningApi.listLearningPolicies)
-- — no writer exists anywhere, so this was never an opt-in design.
--
-- Fix, always-live-to-all-tenants: seed ONE default policy per tenant
-- (category NULL = every category; the table's own defaults: 14-day window,
-- min cluster 3, similarity 0.25, enabled) and a trigger so every FUTURE
-- tenant is born with its policy. A tenant that wants the organ off keeps a
-- real off-switch: the seeded row can be disabled, and the
-- de_learned_behavior_detection feature flag still gates the whole pass.
--
-- What the organ then does (unchanged): clusters decided escalations —
-- rejected → 'correction', approved → 'overcaution' — and promotes clusters
-- of ≥3 into human-gated proposals. Part 2 (decision_edit corrections
-- widening the candidate pool) is tracked separately and NOT in this
-- migration.
-- ============================================================================

begin;

-- ── Seed: one default policy for every tenant that has none ──
insert into de_learning_policies (tenant_id, category, enabled)
select t.id, null, true
from tenants t
where not exists (select 1 from de_learning_policies p where p.tenant_id = t.id);

-- ── Future tenants are born fed ──
create or replace function public.seed_default_learning_policy()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into de_learning_policies (tenant_id, category, enabled)
  values (new.id, null, true)
  on conflict do nothing;
  return new;
end; $$;

revoke all on function public.seed_default_learning_policy() from public, anon, authenticated;

drop trigger if exists trg_seed_default_learning_policy on tenants;
create trigger trg_seed_default_learning_policy
  after insert on tenants
  for each row execute function public.seed_default_learning_policy();

-- ── Verify ──
do $$
declare
  v_tenants int;
  v_covered int;
  v_probe record;
begin
  select count(*) into v_tenants from tenants;
  if v_tenants = 0 then raise exception '696: zero tenants — seed is vacuous'; end if;

  select count(distinct tenant_id) into v_covered from de_learning_policies where enabled;
  if v_covered < v_tenants then
    raise exception '696: only % of % tenants carry an enabled learning policy', v_covered, v_tenants;
  end if;

  -- The seeded row must satisfy what the cluster fn actually reads: window,
  -- similarity, min size — all NOT NULL via table defaults. Probe one row.
  select window_days, similarity_threshold, min_cluster_size into v_probe
    from de_learning_policies limit 1;
  if v_probe.window_days is null or v_probe.similarity_threshold is null or v_probe.min_cluster_size is null then
    raise exception '696: seeded policy is missing a tuning value the cluster pass reads';
  end if;

  -- Trigger armed.
  if not exists (select 1 from pg_trigger where tgrelid = 'tenants'::regclass
                  and tgname = 'trg_seed_default_learning_policy' and not tgisinternal) then
    raise exception '696: future-tenant seed trigger missing';
  end if;

  raise notice '696: learning organ fed — % tenant(s) carry an enabled default policy; next 6h tick can finally see candidates', v_covered;
end $$;

commit;
