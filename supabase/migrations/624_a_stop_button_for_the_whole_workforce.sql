-- 623 — a stop button for the whole workforce, and a breaker that pulls it.
--
-- There is no way to stop autonomy across the workforce at once. Every control
-- is per-employee or per-action: you can disable one dial, retire one employee,
-- or reject one approval, but if something is going wrong at 2am the only
-- option is to work through them one at a time.
--
-- ⚠ CHECKED FOR AN EXISTING HOME FIRST. `tenant_feature_toggles` carries a
-- `trust_adaptive_execution` flag that looks like this, but it is read ONLY by
-- get_tenant_details and update_tenant_features — no enforcement path consults
-- it — and the table holds ZERO rows. Another flag nothing honours. A pause
-- also needs provenance (who stopped it, when, why) and the breaker needs
-- thresholds, neither of which a boolean column can carry.
--
-- TWO THINGS, one mechanism:
--   · a PAUSE a human can pull instantly, and
--   · a BREAKER that pulls it automatically when the workforce misbehaves.
--
-- The breaker trips on rates, not counts, so a busy workspace is not punished
-- for being busy — and only after a minimum volume, for the same reason 622
-- withholds a rate on four events.
--
-- ⚠ ENFORCED AT THE TOP OF THE GATE, before the destructive check, because a
-- pause has to stop everything including the things that would otherwise have
-- been allowed. Checked in ONE place — decide_action_execution — so there is no
-- second path that keeps running while the first is stopped.

begin;

create table if not exists workforce_trust_posture (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  autonomy_paused      boolean     not null default false,
  paused_at            timestamptz,
  paused_by            uuid,
  paused_reason        text,
  -- Automatic. On by default: the failure mode of NOT stopping is worse than a
  -- surprising stop, and every stop is loud (ops alert + audit) rather than silent.
  breaker_enabled      boolean     not null default true,
  breaker_window_hours integer     not null default 24,
  breaker_min_actions  integer     not null default 10,   -- no rate below this
  breaker_incident_pct numeric     not null default 20,   -- incidents per 100 performed
  breaker_block_pct    numeric     not null default 30,   -- guardrail blocks per 100 considered
  breaker_tripped_at   timestamptz,
  breaker_tripped_why  text,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);

alter table workforce_trust_posture enable row level security;

drop policy if exists workforce_trust_posture_read on workforce_trust_posture;
create policy workforce_trust_posture_read on workforce_trust_posture
  for select using (tenant_id = auth_tenant_id());

-- Writes go through the RPCs below, never straight at the table: a pause with
-- no reason and no audit entry is not a governance control.

-- ── The read the gate uses ───────────────────────────────────────────────
create or replace function workforce_autonomy_paused(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select autonomy_paused from workforce_trust_posture where tenant_id = p_tenant_id), false);
$$;

revoke execute on function workforce_autonomy_paused(uuid) from public;
grant execute on function workforce_autonomy_paused(uuid) to authenticated, service_role;

-- ── Stop ─────────────────────────────────────────────────────────────────
create or replace function pause_workforce_autonomy(p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := auth_tenant_id();
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may stop the workforce';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required — a stop with no reason cannot be reviewed later';
  end if;

  insert into workforce_trust_posture (tenant_id, autonomy_paused, paused_at, paused_by, paused_reason, updated_by)
  values (v_tenant, true, now(), auth.uid(), btrim(p_reason), auth.uid())
  on conflict (tenant_id) do update set
    autonomy_paused = true, paused_at = now(), paused_by = auth.uid(),
    paused_reason = btrim(p_reason), updated_at = now(), updated_by = auth.uid();

  perform append_audit_event(v_tenant,
    coalesce((select full_name from profiles where user_id = auth.uid()), 'A workspace admin'),
    'human',
    format('Workforce autonomy STOPPED — %s', btrim(p_reason)),
    'config_change',
    jsonb_build_object('kind', 'workforce_autonomy_paused', 'reason', btrim(p_reason)));

  return jsonb_build_object('ok', true, 'paused', true);
end;
$$;

-- ── Start again ──────────────────────────────────────────────────────────
create or replace function resume_workforce_autonomy(p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := auth_tenant_id();
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'not_allowed: only an owner or admin may restart the workforce';
  end if;

  update workforce_trust_posture set
    autonomy_paused = false, paused_at = null, paused_by = null, paused_reason = null,
    breaker_tripped_at = null, breaker_tripped_why = null,
    updated_at = now(), updated_by = auth.uid()
  where tenant_id = v_tenant;

  perform append_audit_event(v_tenant,
    coalesce((select full_name from profiles where user_id = auth.uid()), 'A workspace admin'),
    'human',
    format('Workforce autonomy RESTARTED%s', case when coalesce(btrim(p_note),'') <> '' then ' — ' || btrim(p_note) else '' end),
    'config_change',
    jsonb_build_object('kind', 'workforce_autonomy_resumed', 'note', nullif(btrim(p_note), '')));

  return jsonb_build_object('ok', true, 'paused', false);
end;
$$;

revoke execute on function pause_workforce_autonomy(text) from public;
revoke execute on function resume_workforce_autonomy(text) from public;
grant execute on function pause_workforce_autonomy(text) to authenticated, service_role;
grant execute on function resume_workforce_autonomy(text) to authenticated, service_role;

-- ── The breaker ──────────────────────────────────────────────────────────
-- Runs on a schedule. Trips on RATES over a window, never counts, and never
-- below a minimum volume — the same discipline 622 applies to the dashboard.
create or replace function check_workforce_circuit_breaker()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r          record;
  v_since    timestamptz;
  v_perf     int; v_considered int; v_blocked int; v_incidents int;
  v_inc_pct  numeric; v_blk_pct numeric;
  v_why      text;
  v_tripped  int := 0;
  v_checked  int := 0;
begin
  for r in
    select p.* from workforce_trust_posture p
    join tenants t on t.id = p.tenant_id
    where p.breaker_enabled and not p.autonomy_paused and tenant_is_operational(p.tenant_id)
  loop
    v_checked := v_checked + 1;
    v_since := now() - make_interval(hours => r.breaker_window_hours);

    select
      count(*) filter (where decision in ('auto_executed','executed_after_approval')),
      count(*) filter (where decision in ('auto_executed','executed_after_approval',
                                          'human_gated_destructive','human_gated_trust','guardrail_blocked')),
      count(*) filter (where decision = 'guardrail_blocked')
    into v_perf, v_considered, v_blocked
    from action_executions
    where tenant_id = r.tenant_id and created_at >= v_since;

    select count(*) into v_incidents
    from de_incidents where tenant_id = r.tenant_id and occurred_at >= v_since;

    v_why := null;

    if v_perf >= r.breaker_min_actions then
      v_inc_pct := round((v_incidents::numeric / v_perf) * 100, 1);
      if v_inc_pct >= r.breaker_incident_pct then
        v_why := format('%s incidents against %s actions in %sh (%s%% — limit %s%%)',
                        v_incidents, v_perf, r.breaker_window_hours, v_inc_pct, r.breaker_incident_pct);
      end if;
    end if;

    if v_why is null and v_considered >= r.breaker_min_actions then
      v_blk_pct := round((v_blocked::numeric / v_considered) * 100, 1);
      if v_blk_pct >= r.breaker_block_pct then
        v_why := format('%s guardrail blocks against %s decisions in %sh (%s%% — limit %s%%)',
                        v_blocked, v_considered, r.breaker_window_hours, v_blk_pct, r.breaker_block_pct);
      end if;
    end if;

    if v_why is not null then
      update workforce_trust_posture set
        autonomy_paused = true, paused_at = now(), paused_by = null,
        paused_reason = 'Stopped automatically: ' || v_why,
        breaker_tripped_at = now(), breaker_tripped_why = v_why, updated_at = now()
      where tenant_id = r.tenant_id;

      -- Loud, never silent: an automatic stop nobody is told about is worse
      -- than no stop, because the workforce looks merely idle.
      perform raise_ops_alert(r.tenant_id, 'workforce_autonomy_breaker',
        'Workforce autonomy stopped automatically', v_why);

      perform append_audit_event(r.tenant_id, 'Circuit breaker', 'system',
        format('Workforce autonomy STOPPED automatically — %s', v_why),
        'config_change',
        jsonb_build_object('kind', 'workforce_autonomy_breaker', 'why', v_why));

      v_tripped := v_tripped + 1;
    end if;
  end loop;

  return jsonb_build_object('checked', v_checked, 'tripped', v_tripped);
end;
$$;

revoke execute on function check_workforce_circuit_breaker() from public;
grant execute on function check_workforce_circuit_breaker() to service_role;

select cron.schedule('workforce-circuit-breaker-15min', '*/15 * * * *',
                     $$select check_workforce_circuit_breaker()$$)
where not exists (select 1 from cron.job where jobname = 'workforce-circuit-breaker-15min');

-- ── The gate honours it, FIRST ───────────────────────────────────────────
do $splice$
declare
  v_def text;
  v_old text := '  if coalesce(p_destructive, true) then';
  v_new text := '  -- ⚠ THE STOP BUTTON, CHECKED BEFORE ANYTHING ELSE (mig 623). A pause has'
             || E'\n  -- to stop everything, including what would otherwise have been allowed, so'
             || E'\n  -- it sits above the destructive floor rather than beside the trust dial.'
             || E'\n  if public.workforce_autonomy_paused(p_tenant_id) then'
             || E'\n    return jsonb_build_object(''decision'', ''human_gated_paused'','
             || E'\n      ''guardrail_rule_id'', null, ''guardrail_rule'', null, ''trust_level'', null,'
             || E'\n      ''reasoning'', format(''Autonomy is stopped for this whole workspace, so "%s" goes to a person. Nothing runs on its own until someone restarts the workforce.'', p_action_label));'
             || E'\n  end if;'
             || E'\n'
             || E'\n' || v_old;
  v_out text;
  v_n   int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'decide_action_execution';
  if v_def is null then raise exception 'decide_action_execution is missing'; end if;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / nullif(length(v_old), 0);
  if coalesce(v_n, 0) <> 1 then
    raise exception 'destructive anchor appears % times, expected 1 — refusing to splice', coalesce(v_n, 0);
  end if;

  v_out := replace(v_def, v_old, v_new);
  if v_out = v_def then raise exception 'the pause splice was a silent no-op'; end if;
  execute v_out;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'decide_action_execution';
  if position('human_gated_paused' in v_def) = 0 then
    raise exception 'the pause check did not land in the gate';
  end if;
end;
$splice$;

-- ── Prove it stops, and prove it starts again ────────────────────────────
do $verify$
declare
  v_t uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_d jsonb;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  -- Baseline: a plainly safe action is not gated as paused.
  v_d := decide_action_execution(v_t, 'a harmless read', 'crm', false, null, null);
  if v_d->>'decision' = 'human_gated_paused' then
    raise exception 'the workspace was already paused before the test';
  end if;

  insert into workforce_trust_posture (tenant_id, autonomy_paused, paused_at, paused_reason)
  values (v_t, true, now(), '__probe623__')
  on conflict (tenant_id) do update set autonomy_paused = true, paused_reason = '__probe623__';

  v_d := decide_action_execution(v_t, 'a harmless read', 'crm', false, null, null);
  if v_d->>'decision' <> 'human_gated_paused' then
    raise exception 'the pause did not stop a non-destructive action (decision=%)', v_d->>'decision';
  end if;

  -- Restart, and the gate must go back to deciding on merit.
  update workforce_trust_posture set autonomy_paused = false, paused_reason = null where tenant_id = v_t;
  v_d := decide_action_execution(v_t, 'a harmless read', 'crm', false, null, null);
  if v_d->>'decision' = 'human_gated_paused' then
    raise exception 'the workspace stayed paused after resuming';
  end if;

  delete from workforce_trust_posture where tenant_id = v_t and paused_reason is null and breaker_tripped_at is null;

  raise notice 'stop button proven: paused halts even a harmless action, resuming restores normal judgement';
end;
$verify$;

commit;
