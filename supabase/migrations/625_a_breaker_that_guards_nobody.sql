-- 625 — a breaker that guards nobody.
--
-- 624 shipped the circuit breaker and its first live run said:
--
--     {"checked": 0, "tripped": 0}
--
-- ⚠⚠ It iterates `workforce_trust_posture` — and that table is EMPTY, because a
-- row is only created when somebody pauses or configures thresholds. So the
-- breaker protected exactly zero workspaces, on a fifteen-minute schedule,
-- reporting success every time.
--
-- That is the built-but-unfed pattern this codebase keeps producing, committed
-- by me in the migration whose entire purpose was to add a safety net: a
-- watcher whose source is empty can never fire ([[install_role_watchers]] hit
-- the same wall, and 606 solved it by checking source rows first).
--
-- Protection must be the DEFAULT, not something a workspace opts into by
-- clicking. The breaker now walks every operational tenant and treats a missing
-- posture row as "protected with the standard thresholds" — the row becomes an
-- override, not a prerequisite.
--
-- ⚠ Deliberately NOT backfilling a row per tenant. That would look like
-- configuration somebody chose, and would drift the moment the defaults change.
-- Absent means default, and default means guarded.

begin;

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
    -- ⚠ TENANTS FIRST, posture second. 624 had this the other way round and so
    -- guarded only workspaces that already had a row — which was none of them.
    select
      t.id                                        as tenant_id,
      coalesce(p.breaker_enabled, true)           as breaker_enabled,
      coalesce(p.autonomy_paused, false)          as autonomy_paused,
      coalesce(p.breaker_window_hours, 24)        as breaker_window_hours,
      coalesce(p.breaker_min_actions, 10)         as breaker_min_actions,
      coalesce(p.breaker_incident_pct, 20)        as breaker_incident_pct,
      coalesce(p.breaker_block_pct, 30)           as breaker_block_pct
    from tenants t
    left join workforce_trust_posture p on p.tenant_id = t.id
    where tenant_is_operational(t.id)
      and coalesce(p.breaker_enabled, true)      -- a workspace may opt OUT
      and not coalesce(p.autonomy_paused, false) -- already stopped; nothing to trip
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
      -- The row is created HERE if it did not exist — the trip is what makes a
      -- workspace's posture explicit, not a prerequisite for being guarded.
      insert into workforce_trust_posture (tenant_id, autonomy_paused, paused_at,
                                           paused_reason, breaker_tripped_at, breaker_tripped_why)
      values (r.tenant_id, true, now(), 'Stopped automatically: ' || v_why, now(), v_why)
      on conflict (tenant_id) do update set
        autonomy_paused = true, paused_at = now(), paused_by = null,
        paused_reason = 'Stopped automatically: ' || v_why,
        breaker_tripped_at = now(), breaker_tripped_why = v_why, updated_at = now();

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

do $verify$
declare
  v_r          jsonb;
  v_operational int;
begin
  select count(*) into v_operational from tenants t where tenant_is_operational(t.id);

  v_r := check_workforce_circuit_breaker();

  -- The whole point: it must now guard every operational workspace, with an
  -- empty posture table.
  if (v_r->>'checked')::int <> v_operational then
    raise exception 'breaker checked % workspace(s) but % are operational — it is still guarding a subset',
      v_r->>'checked', v_operational;
  end if;
  if (v_r->>'checked')::int = 0 then
    raise exception 'breaker checked nothing — the same defect 624 shipped';
  end if;
  -- Nothing should trip on today's quiet history; a trip here would mean the
  -- thresholds are wrong, not that the workforce misbehaved.
  if (v_r->>'tripped')::int > 0 then
    raise exception 'breaker tripped % workspace(s) on existing history — thresholds are too tight',
      v_r->>'tripped';
  end if;

  raise notice 'breaker now guards all % operational workspace(s) by default, 0 tripped', v_operational;
end;
$verify$;

commit;
