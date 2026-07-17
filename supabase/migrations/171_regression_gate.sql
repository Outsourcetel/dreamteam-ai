-- ═══════════════════════════════════════════════════════════════
-- 171 — Golden-set regression gate (Frontier-20 #4)
--
-- The certification gate (mig 162) blocks a DE from going customer-facing
-- until it PASSES its role eval. But a passing cert is forever: once a DE
-- is certified, an operator can quietly change its model, loosen its trust
-- level, rewrite its persona, or swap its playbook — and the old cert keeps
-- vouching for behaviour that no longer exists. That's the regression hole.
--
-- This migration makes a certification vouch for a SPECIFIC configuration.
--   • de_config_fingerprint(de) — a deterministic md5 over the DE's config
--     columns + its DE-scoped guardrails + its own published playbooks.
--   • certify_* stamp the fingerprint at certification time.
--   • A cert is "fresh" iff its stored fingerprint == the live fingerprint.
--   • The go-live gate now requires a FRESH passing cert (not any historical
--     pass) — so after a config change the stale cert no longer satisfies it,
--     and re-advancing a DE forces re-certification against the new config.
--   • An AFTER-UPDATE alert surfaces staleness (activity_event) the moment a
--     certified DE's config changes — WITHOUT breaking live service (the gate,
--     like mig 162, bites on the next lifecycle transition, not retroactively).
--
-- HONEST SCOPE: the fingerprint covers CONFIG the operator authors directly.
-- Knowledge-corpus drift is deliberately NOT fingerprinted here — it is
-- already covered by continuous online evals (mig 168/169), which catch
-- KB-induced regressions on live traffic. The regression gate's distinct job
-- is catching pre-serving CONFIG edits that online evals cannot see yet.
-- Together they cover both change vectors.
-- ═══════════════════════════════════════════════════════════════

alter table role_certifications
  add column if not exists config_fingerprint text,
  add column if not exists stale_alerted      boolean not null default false;

-- The regression alert (below) writes activity_events.event_type='certification_stale',
-- which the existing CHECK forbids. Widen it to a SUPERSET of the current values —
-- also adding 'quality_drift' (emitted by the shipped online-eval alert, mig 168/169,
-- which the old CHECK would have rejected: a latent bug fixed here in passing).
alter table activity_events drop constraint if exists activity_events_event_type_check;
alter table activity_events add constraint activity_events_event_type_check
  check (event_type = any (array[
    'resolved','escalated','kb_gap','error','config_change','approval',
    'quality_drift','certification_stale'
  ]));

-- ── the fingerprint: a deterministic digest of everything a cert vouches for ──
-- SECURITY DEFINER so the gate/alert (which run as the updating user) can read
-- guardrails/playbooks regardless of the caller's RLS. Reads COMMITTED state:
-- callers stamp it right after a config write; the gate reads it on a lifecycle
-- transition (config columns are not themselves changing in that statement).
create or replace function public.de_config_fingerprint(p_de_id uuid)
returns text
language plpgsql security definer set search_path to 'public' stable as $function$
declare
  v_de   digital_employees;
  v_guard text;
  v_pb    text;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return null; end if;

  -- DE-scoped guardrails (CompliancePage writes scope='employee', scope_ref=de_id).
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(updated_at)::text, '')
    into v_guard
    from guardrail_rules
   where tenant_id = v_de.tenant_id and active
     and scope = 'employee' and scope_ref = p_de_id::text;

  -- The DE's own published playbooks (behaviour it can execute).
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(version)::text, '')
         || '|' || coalesce(max(updated_at)::text, '')
    into v_pb
    from playbook_definitions
   where tenant_id = v_de.tenant_id and de_id = p_de_id and status = 'published';

  return md5(concat_ws('~',
    coalesce(v_de.persona_name, ''),
    coalesce(v_de.description, ''),
    coalesce(v_de.model_provider, ''),
    coalesce(v_de.model_id, ''),
    coalesce(v_de.escalation_model_id, ''),
    coalesce(v_de.escalation_threshold::text, ''),
    coalesce(v_de.confidence_threshold::text, ''),
    coalesce(v_de.trust_level, ''),
    coalesce(v_de.required_approval::text, ''),
    coalesce(v_de.task_type, ''),
    coalesce(v_de.external_reply_mode, ''),
    coalesce(v_de.capabilities::text, ''),
    coalesce(v_de.responsibilities::text, ''),
    coalesce(v_de.channels::text, ''),
    coalesce(v_de.knowledge_sources::text, ''),
    coalesce(v_de.skills::text, ''),
    coalesce(v_de.model_config::text, ''),
    coalesce(v_de.attributes::text, ''),
    v_guard,
    v_pb
  ));
end;
$function$;
revoke all on function public.de_config_fingerprint(uuid) from public, anon;
grant execute on function public.de_config_fingerprint(uuid) to authenticated, service_role;

-- ── certification status: fresh / stale / uncertified / failed ──
create or replace function public.de_certification_status(p_de_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' stable as $function$
declare
  v_tenant uuid;
  v_current text;
  v_fresh boolean;
  v_has_pass boolean;
  v_disp role_certifications;   -- the cert to DISPLAY (prefer a fresh one)
  v_any  role_certifications;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return jsonb_build_object('state', 'unknown'); end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  v_current := public.de_config_fingerprint(p_de_id);

  -- Freshness is decided the SAME way the go-live gate decides it: does ANY
  -- passing cert match the current config fingerprint? (Not "is the newest
  -- passing cert fresh" — two passing certs can share a timestamp.)
  v_fresh := exists (
    select 1 from role_certifications
     where de_id = p_de_id and status = 'passed'
       and config_fingerprint is not distinct from v_current);
  v_has_pass := exists (
    select 1 from role_certifications where de_id = p_de_id and status = 'passed');

  -- Display cert: the matching fresh one if present, else the newest passing.
  select * into v_disp from role_certifications
    where de_id = p_de_id and status = 'passed'
    order by (config_fingerprint is not distinct from v_current) desc,
             evaluated_at desc nulls last, created_at desc limit 1;
  select * into v_any from role_certifications
    where de_id = p_de_id
    order by evaluated_at desc nulls last, created_at desc limit 1;

  return jsonb_build_object(
    'state', case
      when not v_has_pass and v_any.id is null then 'uncertified'
      when not v_has_pass then 'failed'
      when v_fresh then 'certified'
      else 'stale'
    end,
    'fresh', v_fresh,
    'latest_passed', case when v_disp.id is null then null else jsonb_build_object(
      'id', v_disp.id, 'score_pct', v_disp.score_pct, 'threshold_pct', v_disp.threshold_pct,
      'evaluated_at', v_disp.evaluated_at, 'archetype_key', v_disp.archetype_key,
      'certified_fingerprint', v_disp.config_fingerprint) end,
    'current_fingerprint', v_current,
    'latest_status', v_any.status
  );
end;
$function$;
revoke all on function public.de_certification_status(uuid) from public, anon;
grant execute on function public.de_certification_status(uuid) to authenticated, service_role;

-- ── recreate certify_de_from_eval: stamp the fingerprint at cert time ──
create or replace function public.certify_de_from_eval(
  p_de_id uuid, p_archetype_key text, p_eval_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select total, passed into v_total, v_passed from eval_runs where id = p_eval_run_id and tenant_id = v_tenant;
  if v_total is null or v_total = 0 then raise exception 'eval run has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= p_threshold_pct then 'passed' else 'failed' end;

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, p_eval_run_id, v_pct, p_threshold_pct, v_status, now(), public.de_config_fingerprint(p_de_id));

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', p_threshold_pct, 'passed', v_passed, 'total', v_total);
end;
$function$;

-- ── recreate certify_de_from_sim: stamp the fingerprint at cert time ──
create or replace function public.certify_de_from_sim(
  p_de_id uuid, p_archetype_key text, p_sim_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select total, passed into v_total, v_passed from sim_runs
    where id = p_sim_run_id and tenant_id = v_tenant and de_id = p_de_id and status in ('passed', 'failed');
  if v_total is null or v_total = 0 then raise exception 'simulation has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= p_threshold_pct then 'passed' else 'failed' end;

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, null, v_pct, p_threshold_pct, v_status, now(), public.de_config_fingerprint(p_de_id));

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', p_threshold_pct, 'passed', v_passed, 'total', v_total, 'from', 'simulation');
end;
$function$;

-- ── tighten the go-live gate: require a FRESH passing cert ──
-- Same transition semantics as mig 162 (fires only on the transition INTO a
-- customer-facing stage from a non-gated one), but the qualifying cert must
-- match the DE's CURRENT config fingerprint. A config change since the last
-- pass makes every cert stale → re-advancing forces re-certification.
create or replace function public.gate_de_certification() returns trigger
language plpgsql as $function$
declare v_gated text[] := array['certified','published','assigned','active']; v_fp text;
begin
  if NEW.lifecycle_status = any(v_gated) and OLD.lifecycle_status is distinct from NEW.lifecycle_status
     and OLD.lifecycle_status <> all(v_gated) then
    v_fp := public.de_config_fingerprint(NEW.id);
    if not exists (
      select 1 from role_certifications c
       where c.de_id = NEW.id and c.status = 'passed'
         and c.config_fingerprint is not distinct from v_fp
    ) then
      if exists (select 1 from role_certifications c where c.de_id = NEW.id and c.status = 'passed') then
        raise exception 'DE % cannot advance to "%": its passing certification is STALE — the configuration changed since it was certified. Re-run its eval/simulation and re-certify the current config first.', NEW.id, NEW.lifecycle_status;
      else
        raise exception 'DE % cannot advance to "%": it has not passed role certification. Run its eval/simulation and certify it first.', NEW.id, NEW.lifecycle_status;
      end if;
    end if;
  end if;
  return NEW;
end;
$function$;
-- (trigger trg_gate_de_certification from mig 162 already points at this function)

-- ── alert when a certified DE's config changes (stale, but service unbroken) ──
-- Exactly-once per staleness episode via stale_alerted (reset by the next
-- fresh cert row). Fires only on real config-column edits.
create or replace function public.alert_cert_regression() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_fp text; v_pass role_certifications; v_name text;
begin
  select * into v_pass from role_certifications
    where de_id = NEW.id and status = 'passed'
    order by evaluated_at desc nulls last, created_at desc limit 1;
  if v_pass.id is null then return NEW; end if;                 -- never certified → nothing to invalidate

  v_fp := public.de_config_fingerprint(NEW.id);
  if v_pass.config_fingerprint is not distinct from v_fp then
    -- config unchanged, or edited back to the certified state → fresh again.
    -- Clear the alert latch so a future divergence re-alerts.
    if v_pass.stale_alerted then
      update role_certifications set stale_alerted = false where id = v_pass.id;
    end if;
    return NEW;
  end if;
  if v_pass.stale_alerted then return NEW; end if;              -- already alerted this episode

  v_name := coalesce(NEW.persona_name, NEW.name, 'this employee');
  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  values (NEW.tenant_id, coalesce(NEW.persona_name, NEW.name, 'DE'), 'system', 'certification_stale',
    format('Configuration changed for %s after it was certified (%s%% on %s). Its certification is now STALE and no longer vouches for the current setup — re-run its evaluation or simulation and re-certify before relying on it or promoting it again.',
           v_name, v_pass.score_pct, coalesce(v_pass.evaluated_at::date::text, 'a prior run')),
    coalesce(v_pass.score_pct, 0));
  update role_certifications set stale_alerted = true where id = v_pass.id;
  return NEW;
end;
$function$;

drop trigger if exists trg_alert_cert_regression on digital_employees;
create trigger trg_alert_cert_regression
  after update of persona_name, description, model_provider, model_id, escalation_model_id,
    escalation_threshold, confidence_threshold, trust_level, required_approval, task_type,
    external_reply_mode, capabilities, responsibilities, channels, knowledge_sources,
    skills, model_config, attributes
  on digital_employees
  for each row execute function public.alert_cert_regression();
