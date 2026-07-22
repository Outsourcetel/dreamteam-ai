-- ============================================================================
-- 258 — RECORDS BECOME GATES (docs/19 G6: governance that actually bites)
--
-- The record-writers already run on cron: KPI misses spawn development items
-- daily (mig 125), cert expiry flips status + files incidents (governance
-- sweep), exams write role_certifications with a config fingerprint. But per
-- the Employee-File truth audit (docs/15), these are Layer-B RECORDS — the
-- live answer/action paths never read them. This migration closes the loop:
--
--   1) de_records_gate         — ONE place that reads the records and says
--                                "this employee's autonomy is gated" + why.
--   2) resolve_de_autonomy     — the resolver every live path already calls
--                                (answer_dock, answer_widget, action gate)
--                                now clamps enabled=false when gated. Same
--                                signature — zero caller changes.
--   3) get_de_gate_status      — member-readable "why is autonomy off"
--                                for the Employee File / UI.
--   4) run_reply_mode_gate_internal — 15-min cron: an auto-answering DE that
--                                is cert-gated, has an open critical
--                                incident, or shows degraded 8-week metrics
--                                is demoted to draft-for-approval, with an
--                                audit event + a trust_demotion_notice task
--                                explaining exactly why and how to restore.
--                                Demotion is automatic; restoration is a
--                                deliberate human act (mig 150) — demote
--                                fast, promote deliberately.
--
-- Gate philosophy (deliberate): an employee with NO certification history is
-- NOT gated — certification is opt-in machinery, and gating every uncertified
-- DE would flip whole tenants to supervised overnight. Once a certificate
-- EXISTS, it matters: failed, stale (config changed since the exam), or
-- expired ⇒ supervised until re-certified.
-- ============================================================================

-- ── 1) The gate reader ──
create or replace function public.de_records_gate(p_tenant_id uuid, p_de_id uuid)
returns table(gated boolean, reasons text[])
language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_reasons text[] := '{}';
  v_cert record;
  v_fp text;
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

  return query select coalesce(array_length(v_reasons, 1), 0) > 0, v_reasons;
end;
$function$;
revoke all on function public.de_records_gate(uuid, uuid) from public, anon, authenticated;
grant execute on function public.de_records_gate(uuid, uuid) to service_role;

-- ── 2) The resolver clamps. Same signature; callers unchanged. ──
create or replace function public.resolve_de_autonomy(p_tenant_id uuid, p_action_type text, p_de_id uuid default null::uuid, p_source_category text default null::text)
returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_row de_autonomy;
  v_gated boolean := false;
begin
  -- Records gate (mig 258): a gated employee is supervised regardless of
  -- what the trust dial says — chat drafts to a human, actions block to a
  -- human. Checked first so every precedence branch below inherits it.
  if p_de_id is not null then
    select g.gated into v_gated from public.de_records_gate(p_tenant_id, p_de_id) g;
  end if;

  if p_de_id is not null and p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and source_category = p_source_category
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  if p_de_id is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id = p_de_id and source_category is null
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  if p_source_category is not null then
    select * into v_row from de_autonomy
    where tenant_id = p_tenant_id and action_type = p_action_type
      and de_id is null and source_category = p_source_category
    limit 1;
    if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;
  end if;

  select * into v_row from de_autonomy
  where tenant_id = p_tenant_id and action_type = p_action_type
    and de_id is null and source_category is null
  limit 1;
  if found then return query select (v_row.enabled and not v_gated), v_row.max_amount_cents, v_row.min_confidence; return; end if;

  return query select false, null::bigint, null::integer;
end;
$function$;

-- ── 3) Member-readable gate status for the Employee File. ──
create or replace function public.get_de_gate_status(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_tenant uuid;
  v_g record;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  select * into v_g from public.de_records_gate(v_tenant, p_de_id);
  return jsonb_build_object('ok', true, 'gated', v_g.gated, 'reasons', to_jsonb(v_g.reasons));
end;
$function$;
revoke all on function public.get_de_gate_status(uuid) from public, anon;
grant execute on function public.get_de_gate_status(uuid) to authenticated, service_role;

-- ── 4) The reply-mode demotion sweep. ──
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
       -- A suspended workspace's employees can't answer anyway — sweeping
       -- them just makes noise for nobody.
       and t.status in ('active', 'trial')
  loop
    v_reason := null;

    select * into v_g from public.de_records_gate(v_de.tenant_id, v_de.id);
    if v_g.gated then
      v_reason := 'certification gate: ' || array_to_string(v_g.reasons, ', ');
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

    -- Anti-flap: one demotion conversation per employee per 7 days. If a
    -- human deliberately restored auto mode, we do not re-demote them the
    -- next tick — the standing notice stays the record of our objection.
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

    -- event_type must be on the activity_events allowlist; 'config_change'
    -- is the accurate one here (reply mode is DE config).
    insert into activity_events (tenant_id, actor, actor_type, event_type, text)
    values (v_de.tenant_id, v_de.name, 'de', 'config_change',
      format('Moved to draft-for-approval by the records gate — %s', v_reason));

    v_demoted := v_demoted + 1;
  end loop;

  return jsonb_build_object('demoted', v_demoted);
end;
$function$;
revoke all on function public.run_reply_mode_gate_internal() from public, anon, authenticated;

select cron.schedule('de-reply-mode-gate-15min', '*/15 * * * *', 'select public.run_reply_mode_gate_internal()');

NOTIFY pgrst, 'reload schema';
