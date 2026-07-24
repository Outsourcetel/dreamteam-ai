-- 307_gi4_incident_and_metric_gates.sql
-- ============================================================================
-- GI-4 (Governance Integrity) — fold OPEN-CRITICAL-INCIDENT + DEGRADED-ERROR-RATE
-- into the SYNCHRONOUS records gate so they clamp answers AND actions immediately.
--
-- Today public.de_records_gate (mig 258) only considers certifications; incidents
-- lag a 15-min reply-mode cron and NEVER clamp actions. resolve_de_autonomy
-- (mig 258) already reads .gated on every precedence branch, so widening the
-- gate's SIGNAL SET is a single-point change: every live answer + action path
-- inherits it with no caller changes.
--
-- Body reproduced VERBATIM from mig 258:36-76; only branches (c),(d) + their two
-- declared vars are added before the final `return query`. resolve_de_autonomy
-- and get_de_gate_status are unchanged (not reproduced here).
--
-- DELIBERATE DEVIATION (verified deadlock — do NOT gate escalation_rate here):
-- a latched gate forces resolve_de_autonomy enabled=false → decide_work_item_
-- triage / decide_inquiry_triage return needs_review → record_inquiry_decision
-- persists that into evidence_run_decisions → get_de_performance_metrics
-- escalation_rate = needs_review share. So a synchronous escalation clamp
-- MANUFACTURES ITS OWN sustaining numerator with no operator un-gate path — a
-- permanent autonomy trap. error_rate reads evidence_runs.status='failed'; a
-- gated DE still COMPLETES evidence runs successfully (the gate changes the
-- decision, not the run status), so error_rate self-clears honestly as new runs
-- succeed. Escalation stays ONLY in the soft, reversible async reply-mode sweep.
--
-- Pre-deploy census (2026-07-24): 0 DEs clamp on error-rate, 0 have an open
-- critical incident → this lands as a pure forward-looking safety net. GLOBAL.
-- ============================================================================

create or replace function public.de_records_gate(p_tenant_id uuid, p_de_id uuid)
returns table(gated boolean, reasons text[])
language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_reasons text[] := '{}';
  v_cert record;
  v_fp text;
  v_n bigint;       -- GI-4: this DE's 56d evidence-run volume
  v_failed bigint;  -- GI-4: this DE's 56d failed-run count
begin
  -- (a) Exam certifications (role_certifications): latest row decides.
  select rc.status, rc.config_fingerprint into v_cert
    from role_certifications rc
   where rc.tenant_id = p_tenant_id and rc.de_id = p_de_id
   order by rc.evaluated_at desc nulls last, rc.created_at desc limit 1;
  if found then
    if v_cert.status = 'failed' then
      v_reasons := array_append(v_reasons, 'failed_certification');
    elsif v_cert.status = 'passed' and v_cert.config_fingerprint is not null then
      v_fp := public.de_config_fingerprint(p_de_id);
      if v_fp is not null and v_fp <> v_cert.config_fingerprint then
        v_reasons := array_append(v_reasons, 'stale_certification');
      end if;
    end if;
  end if;

  -- (b) Governance certifications (de_certifications): an expired cert not
  --     superseded by a newer active one of the same type gates.
  if exists (
    select 1 from de_certifications c
     where c.tenant_id = p_tenant_id and c.de_id = p_de_id and c.status = 'expired'
       and not exists (
         select 1 from de_certifications c2
          where c2.tenant_id = p_tenant_id and c2.de_id = p_de_id
            and c2.cert_type = c.cert_type and c2.status = 'active'
            and c2.created_at > c.created_at)
  ) then
    v_reasons := array_append(v_reasons, 'expired_certification');
  end if;

  -- (c) GI-4: an OPEN CRITICAL incident on THIS employee gates. de_id is
  --     required so a tenant-level (null-de_id) incident never over-gates one
  --     employee. Self-clears the moment the incident moves off 'open'.
  if exists (
    select 1 from de_incidents i
     where i.tenant_id = p_tenant_id and i.de_id = p_de_id
       and i.status = 'open' and i.severity = 'critical'
  ) then
    v_reasons := array_append(v_reasons, 'open_critical_incident');
  end if;

  -- (d) GI-4: degraded performance gates on ERROR RATE ONLY (never escalation —
  --     escalation self-manufactures under gating; see header). Scoped to this
  --     employee, 56-day recoverable window, >=10-run sample floor so a DE with
  --     little/no run volume is never gated. Div-by-zero guarded. The inner
  --     block fails CLOSED with a distinct diagnosable reason so a throwing
  --     metric query can never bubble up and silently un-gate a fail-open path.
  begin
    select count(*)::bigint,
           count(*) filter (where er.status = 'failed')::bigint
      into v_n, v_failed
      from evidence_runs er
     where er.tenant_id = p_tenant_id and er.de_id = p_de_id
       and er.created_at > now() - interval '56 days';
    if coalesce(v_n, 0) >= 10
       and (100.0 * coalesce(v_failed, 0) / nullif(v_n, 0)) > 15 then
      v_reasons := array_append(v_reasons, 'degraded_metrics');
    end if;
  exception when others then
    v_reasons := array_append(v_reasons, 'metrics_check_unavailable');
  end;

  return query select coalesce(array_length(v_reasons, 1), 0) > 0, v_reasons;
end;
$function$;
revoke all on function public.de_records_gate(uuid, uuid) from public, anon, authenticated;
grant execute on function public.de_records_gate(uuid, uuid) to service_role;

-- Covering index for branch (d) on the hottest synchronous governance path.
create index if not exists evidence_runs_tenant_de_created_idx
  on evidence_runs (tenant_id, de_id, created_at desc);

-- ── Companion: correct the reply-mode sweep's gate LABEL (mig 258:173). ──
-- Reproduced VERBATIM from mig 258:149-234; the ONLY change is line 173's
-- 'certification gate: ' → 'records gate: ' (the gate now carries incident +
-- metric reasons, not only certifications). The sweep's own inline incident +
-- escalation blocks are intentionally LEFT (escalation stays soft/reversible
-- here; the now-duplicated incident check is harmless — the gate wins first).
create or replace function public.run_reply_mode_gate_internal()
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_de record;
  v_g record;
  v_m record;
  v_reason text;
  v_demoted integer := 0;
  v_name text;
begin
  for v_de in
    select d.id, d.tenant_id, coalesce(d.persona_name, d.name) as name
      from digital_employees d
      join tenants t on t.id = d.tenant_id
     where d.external_reply_mode = 'auto'
       and coalesce(d.lifecycle_status, 'active') not in ('paused', 'retired', 'archived')
       and t.status in ('active', 'trial')
  loop
    v_reason := null;

    select * into v_g from public.de_records_gate(v_de.tenant_id, v_de.id);
    if v_g.gated then
      v_reason := 'records gate: ' || array_to_string(v_g.reasons, ', ');
    end if;

    if v_reason is null and exists (
      select 1 from de_incidents i
       where i.tenant_id = v_de.tenant_id and i.de_id = v_de.id
         and i.status = 'open' and i.severity = 'critical'
    ) then
      v_reason := 'an open critical incident';
    end if;

    if v_reason is null then
      select * into v_m from get_de_performance_metrics(v_de.tenant_id, 8) m
       where m.de_id = v_de.id limit 1;
      if found and coalesce(v_m.total_decisions, 0) >= 10
         and (v_m.escalation_rate > 50 or v_m.error_rate > 15) then
        v_reason := format('degraded 8-week metrics (escalation %s%%, errors %s%%)',
                           round(coalesce(v_m.escalation_rate, 0)), round(coalesce(v_m.error_rate, 0)));
      end if;
    end if;

    if v_reason is null then continue; end if;

    if exists (
      select 1 from human_tasks t
       where t.tenant_id = v_de.tenant_id and t.de_id = v_de.id
         and t.type = 'trust_demotion_notice'
         and t.created_at > now() - interval '7 days'
    ) then continue; end if;

    update digital_employees set external_reply_mode = 'draft', updated_at = now()
     where id = v_de.id;

    insert into human_tasks (tenant_id, de_id, type, source, title, detail)
    values (v_de.tenant_id, v_de.id, 'trust_demotion_notice', 'de',
      format('%s moved to draft-for-approval — %s', v_de.name, v_reason),
      format('%s was auto-answering customers, but their employment record no longer supports it: %s. '
             || 'Every reply now waits for your approval. To restore auto-answering, resolve the underlying record '
             || '(re-certify / close the incident / improve the metrics) and flip the mode back on the employee''s Channels settings — '
             || 'that restoration is deliberately a human decision.', v_de.name, v_reason));

    perform append_audit_event_internal(
      v_de.tenant_id, 'Records gate', 'system',
      format('%s demoted from auto-answer to draft-for-approval — %s', v_de.name, v_reason),
      'config_change',
      jsonb_build_object('kind', 'reply_mode_demotion', 'de_id', v_de.id, 'reason', v_reason));

    insert into activity_events (tenant_id, actor, actor_type, event_type, text)
    values (v_de.tenant_id, v_de.name, 'de', 'config_change',
      format('Moved to draft-for-approval by the records gate — %s', v_reason));

    v_demoted := v_demoted + 1;
  end loop;

  return jsonb_build_object('demoted', v_demoted);
end;
$function$;
revoke all on function public.run_reply_mode_gate_internal() from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
