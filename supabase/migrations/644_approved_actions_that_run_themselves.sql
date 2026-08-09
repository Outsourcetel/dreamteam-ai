-- 644_approved_actions_that_run_themselves.sql
-- ============================================================================
-- An approved action only runs when a person clicks in the web app
-- (src/lib/connectorApi.ts resolveActionExecution is the ONLY caller). So a
-- decision made on a phone, by email, or at 2am sits there until somebody opens
-- a browser tab. That is why six approvals from July had never executed.
--
-- This adds the server-side driver. It ships INERT, and inert in the DATA, not
-- merely in the schedule:
--
--   · `approved_action_driver.enabled_at` is NULL ⇒ due_approved_actions()
--     returns ZERO ROWS. Even if the cron were switched on by accident, or the
--     endpoint called by hand, nothing executes. A schedule you can flip is one
--     mistake away; a query that returns nothing is two.
--   · The WATERMARK is that same timestamp: only approvals decided AT OR AFTER
--     the driver was switched on are eligible. Historical approvals can never
--     fire, which is the specific accident this design exists to prevent — the
--     16 stale ones (really 6, see mig 642) would otherwise have gone out on
--     tick one.
--   · An ALLOWLIST of tenant slugs. Empty ⇒ nothing. Opt-in per workspace, so
--     the pilot cannot leak into the other eleven.
--   · Suspended tenants are excluded, and `expired` tasks (mig 642) are not
--     'approved' so they are already out.
--
-- NO SECOND EXECUTION PATH. The driver does not execute anything itself. It
-- finds due work and POSTs to connector-hub's existing `execute_action` with
-- `approved_execution_id` — the same entry point the browser uses, which
-- already accepts `x-dispatch-secret` + explicit tenant_id for headless flows.
-- Every real control stays where it is: the action/connector binding check, the
-- forged-approval refusal, and claim_gated_action_execution's exactly-once
-- claim. This function only decides WHEN, never WHETHER.
-- ============================================================================

begin;

-- ── 1. The two dials. Both default to "off". ──────────────────────────────
insert into platform_config (key, value)
values ('approved_action_driver.enabled_at', ''),
       ('approved_action_driver.tenant_allowlist', '')
on conflict (key) do nothing;

comment on table public.platform_config is
  'Platform-wide settings. approved_action_driver.enabled_at: ISO timestamp; empty = driver disabled AND the watermark below which no approval is eligible. approved_action_driver.tenant_allowlist: comma-separated tenant slugs; empty = no workspace opted in.';

-- ── 2. What is due. Reading is the whole safety surface. ──────────────────
create or replace function public.due_approved_actions(p_limit int default 25)
returns table (
  tenant_id      uuid,
  tenant_slug    text,
  task_id        uuid,
  execution_id   uuid,
  connector_id   uuid,
  action_key     text,
  action_label   text,
  params         jsonb,
  decided_at     timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_enabled_at timestamptz;
  v_allow      text[];
begin
  -- Empty or unparseable ⇒ disabled. Never "assume on".
  select nullif(btrim(value), '')::timestamptz into v_enabled_at
    from platform_config where key = 'approved_action_driver.enabled_at';
  if v_enabled_at is null then
    return;                                     -- disabled: zero rows
  end if;

  select coalesce(
           array(select btrim(s) from unnest(string_to_array(coalesce(value, ''), ',')) s
                  where btrim(s) <> ''), '{}')
    into v_allow
    from platform_config where key = 'approved_action_driver.tenant_allowlist';
  if coalesce(array_length(v_allow, 1), 0) = 0 then
    return;                                     -- nobody opted in: zero rows
  end if;

  return query
  select t.id, t.slug, ht.id, ae.id, ae.connector_id, ad.action_key, ad.label,
         ae.params, ht.decided_at
    from human_tasks ht
    join tenants t             on t.id = ht.tenant_id
    join action_executions ae  on ae.task_id = ht.id
    join action_definitions ad on ad.id = ae.action_definition_id
   where ht.type = 'action_approval'
     and ht.status = 'approved'                 -- 'expired' (mig 642) excluded
     and t.status = 'active'                    -- never act in a suspended workspace
     and t.slug = any(v_allow)
     and ht.decided_at >= v_enabled_at          -- THE WATERMARK
     and ae.decision like 'human_gated%'
     and ae.connector_id is not null
     -- Not already carried out. From mig 642 onward the linkage is reliable:
     -- claim_gated_action_execution sets resolves_task_id on every claim.
     and not exists (
       select 1 from action_executions x
        where x.resolves_task_id = ht.id
          and x.decision <> 'failed')
   order by ht.decided_at
   limit greatest(1, least(coalesce(p_limit, 25), 100));
end;
$function$;

revoke all on function public.due_approved_actions(int) from public, anon, authenticated;

-- ── 3. The schedule, created INACTIVE. ────────────────────────────────────
-- cron.alter_job, not `update cron.job` — the table is not writable by the
-- migration role on every project (dev refuses it outright), and a raw UPDATE
-- would make this migration un-replayable there. The data lock in §1 is the
-- real safety anyway; the schedule is the second line, not the first.
do $$
declare v_job bigint;
begin
  perform cron.unschedule('approved-action-driver-5min')
   where exists (select 1 from cron.job where jobname = 'approved-action-driver-5min');

  select cron.schedule('approved-action-driver-5min', '*/5 * * * *',
    $cron$select public._dispatch_fn('/functions/v1/approved-action-driver')$cron$)
    into v_job;
  perform cron.alter_job(v_job, active := false);

  raise notice '644: schedule created and immediately deactivated (job %)', v_job;
exception
  when insufficient_privilege or undefined_function or undefined_table or invalid_schema_name then
    -- No pg_cron here (dev/replay). The driver is still installed and still
    -- inert; there is simply nothing to schedule it with.
    raise notice '644: pg_cron unavailable — schedule skipped. The driver remains inert via approved_action_driver.enabled_at.';
end $$;

-- ── 4. Prove it is inert, three independent ways. ─────────────────────────
do $$
declare
  v_active  boolean;
  v_rows    int;
  v_stale   int;
begin
  -- Where pg_cron exists the schedule MUST be off. Where it does not, there is
  -- no schedule to be wrong about — but never silently treat "cannot see it" as
  -- "it is fine".
  begin
    select active into v_active from cron.job where jobname = 'approved-action-driver-5min';
    if v_active is null then
      raise notice '644: no schedule row (pg_cron unavailable here) — data lock is the only gate, and it is asserted below';
    elsif v_active then
      raise exception '644: the driver schedule is ACTIVE — it must ship switched off';
    end if;
  exception
    when insufficient_privilege or undefined_table or invalid_schema_name then
      raise notice '644: cron.job not readable here — skipping the schedule assertion';
  end;

  -- With enabled_at empty, the query itself returns nothing. This is the lock
  -- that does not depend on anyone remembering the cron is off.
  select count(*) into v_rows from due_approved_actions(100);
  if v_rows <> 0 then
    raise exception '644: driver disabled but % rows are due — the off switch does not hold', v_rows;
  end if;

  -- And the historical approvals must be unreachable even once it IS enabled,
  -- because every one of them predates any possible watermark.
  select count(*) into v_stale
    from human_tasks
   where type = 'action_approval' and status = 'approved'
     and decided_at < now();
  raise notice '644: driver installed INERT. schedule active=false, 0 rows due, % historical approvals sit below any future watermark', v_stale;
end $$;

commit;
