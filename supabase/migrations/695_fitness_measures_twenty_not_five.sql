-- 695 — fitness measures twenty questions, not five (G-E rigor follow-up).
--
-- The amendment-fitness harness (310/312/313 + de-fitness-measure, repaired in
-- 690) measured on 5 golden questions — de-simulate's per-call ceiling. A 4/5
-- vs 4/5 verdict is directional, not evidential. Forty sequential LLM calls
-- cannot fit one edge invocation, so the measurement becomes RESUMABLE:
--
--   * The question list is FROZEN at claim time (this table) — a golden set
--     edited mid-run can no longer poison the comparison.
--   * Each chunk runs the SAME questions under BOTH personas back-to-back
--     (interleaved), preserving mig 310's no-time-separation property
--     per-question even when the run spans cron ticks.
--   * Progress accumulates here; the driver resumes an in-flight run before
--     claiming new work. A driver death mid-run self-heals on the next tick —
--     record_amendment_fitness has been an idempotent UPSERT since 310, so a
--     resumed finalize updates rather than duplicates.
--   * Fail-closed unchanged: any chunk whose either side did not genuinely
--     complete finalizes the whole run NULL/NULL. Partial scores are never
--     promoted to verdicts.
--
-- Sample size is platform_config 'amendment_fitness.sample_size' (default 20,
-- driver-clamped to 40); tenants with fewer active golden rows measure on
-- what exists, and golden_count in the recorded metrics says so honestly.

create table if not exists fitness_run_progress (
  amendment_id  uuid primary key references workforce_entity_amendments(id) on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  de_id         uuid not null,
  frozen_ids    jsonb not null,                    -- ordered golden_qa ids, fixed at claim
  sample_target integer not null check (sample_target between 1 and 40),
  next_offset   integer not null default 0 check (next_offset >= 0),
  before_passed integer not null default 0 check (before_passed >= 0),
  after_passed  integer not null default 0 check (after_passed >= 0),
  chunks        jsonb not null default '[]'::jsonb, -- per-chunk log, for the audit trail
  status        text not null default 'running' check (status in ('running')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists fitness_run_progress_tenant_idx on fitness_run_progress(tenant_id, updated_at);
alter table fitness_run_progress enable row level security;
drop policy if exists fitness_run_progress_read on fitness_run_progress;
create policy fitness_run_progress_read on fitness_run_progress for select using (
  tenant_id = public.auth_tenant_id()
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
revoke insert, update, delete on fitness_run_progress from anon, authenticated;

insert into platform_config (key, value) values ('amendment_fitness.sample_size', '20')
  on conflict (key) do nothing;

-- ── Prove the schema's rails (the chunk state-machine itself lives in the
--    driver and is exercised there; these prove what SQL can prove) ─────────
do $$
declare
  v_t uuid; v_amend uuid := gen_random_uuid(); v_de uuid := gen_random_uuid();
begin
  select id into v_t from tenants order by created_at limit 1;
  insert into workforce_entity_amendments (id, tenant_id, entity_kind, entity_id,
      trigger_reason, current_config, proposed_config, status)
  values (v_amend, v_t, 'de', v_de, '695 probe', '{}'::jsonb, '{}'::jsonb, 'applied');

  -- A progress row inserts, advances, and refuses a bad offset.
  insert into fitness_run_progress (amendment_id, tenant_id, de_id, frozen_ids, sample_target)
  values (v_amend, v_t, v_de, '["a","b","c"]'::jsonb, 3);
  update fitness_run_progress set next_offset = 2, before_passed = 2, after_passed = 1,
         chunks = chunks || '[{"o":0,"n":2}]'::jsonb, updated_at = now()
   where amendment_id = v_amend;
  begin
    update fitness_run_progress set next_offset = -1 where amendment_id = v_amend;
    raise exception '695: a negative offset was accepted';
  exception when check_violation then null; end;

  -- Cascade: deleting the amendment removes its progress (no orphaned runs).
  delete from workforce_entity_amendments where id = v_amend;
  perform 1 from fitness_run_progress where amendment_id = v_amend;
  if found then raise exception '695: progress row survived its amendment'; end if;

  -- The sample-size knob exists.
  perform 1 from platform_config where key = 'amendment_fitness.sample_size';
  if not found then raise exception '695: sample_size config missing'; end if;
end $$;
