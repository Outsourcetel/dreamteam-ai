-- 824_a_writer_with_no_caller_is_still_the_only_writer.sql
-- ==========================================================================
-- ⚠⚠⚠ THIS UNDOES THREE OF THE FOUR DROPS IN MIGRATION 809. I applied 809
-- while its own adversarial review was still running, and the review was
-- right.
--
-- 809 dropped four tenant-admin functions on the evidence that nothing calls
-- them. That evidence was correct and it was not sufficient. A caller census
-- answers "is it called?"; retirement also requires "is it needed?", and for
-- three of the four the answer was yes:
--
--   update_tenant_billing  was the ONLY writer of tenant_billing_config
--   update_tenant_features was the ONLY writer of tenant_feature_toggles
--
-- Measured after the drop, with controls so the zero is not vacuous:
--     writers of tenant_billing_config    0
--     writers of tenant_feature_toggles   0
--     writers of de_messages (control)    2
--     writers of a nonsense table         0
-- and `authenticated` holds SELECT ONLY on both tables (migration 716 revoked
-- the writes), so a SECURITY DEFINER function was the only path that remained.
-- Dropping it did not remove a caller. It removed the capability.
--
-- get_tenant_details is restored for the same reason one level along: it is
-- the only reader that renders what those two writers write.
--
-- == WHY THE SUPERSESSION ARGUMENT WAS TRUE AND STILL WRONG ================
-- Migration 200 says it replaced this surface with one overview RPC. That is
-- true of get_all_tenants_with_summary — get_platform_tenant_overview() has 77
-- measured executions in pg_stat_statements and is named in 200's header. The
-- claim was proven for ONE function and silently extended to four. I read the
-- successor's body: it returns tenant_id, admin_name, admin_email, de_count,
-- user_count, last_activity, and reads NEITHER tenant_feature_toggles NOR
-- tenant_billing_config. It replaced the LIST. Nothing replaced the per-tenant
-- detail read, and nothing replaced either writer.
--
-- 809's drop of get_all_tenants_with_summary STANDS and is not undone here.
--
-- == RESTORED HARDENED, NOT RESTORED AS FOUND =============================
-- The originals are SECURITY DEFINER with NO search_path, reachable by
-- `authenticated`. That exposure is the thing 809 was really reaching for, and
-- putting the functions back unchanged would put it back too. So each is
-- recreated with `SET search_path = public`, and EXECUTE is REVOKED from
-- public/anon/authenticated and granted to NOBODY.
--
-- That is the TIER B the rebuild should have produced: the capability survives,
-- the perimeter closes, and one GRANT revives it the day a console needs it.
-- A DROP would have required re-authoring money-writing definer code from
-- scratch.
--
-- ⚠ The bodies below are lifted VERBATIM from 20260720_tenant_management.sql
-- by script, not retyped, so a transcription slip cannot change what a
-- money-writing function does. Only the terminator is rewritten, to add
-- search_path.
--
-- ⚠ migration 614 deliberately preserves and asserts tenant_billing_config's
-- unique index, which update_tenant_billing's ON CONFLICT (tenant_id) is an
-- interface to. That is a second written record that this writer was expected
-- to exist.
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION get_tenant_details(p_tenant_id UUID)
RETURNS json AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN (
    SELECT json_build_object(
      'tenant_id', t.id,
      'name', t.name,
      'slug', t.slug,
      'status', t.status,
      'plan', t.plan,
      'industry', t.industry,
      'admin_name', t.admin_name,
      'admin_email', t.admin_email,
      'billing_email', t.billing_email,
      'contact_name', t.billing_contact_name,
      'adoption_score', t.adoption_score,
      'created_at', t.created_at::text,
      'features', json_build_object(
        'sophie_config_enabled', COALESCE(tft.sophie_config_enabled, true),
        'amendment_journeys_enabled', COALESCE(tft.amendment_journeys_enabled, true),
        'metrics_tracking_enabled', COALESCE(tft.metrics_tracking_enabled, true),
        'reply_mode_enabled', COALESCE(tft.reply_mode_enabled, true),
        'hosted_chat_enabled', COALESCE(tft.hosted_chat_enabled, true),
        'replay_testing', COALESCE(tft.amendment_replay_testing, false),
        'trust_adaptive', COALESCE(tft.trust_adaptive_execution, false),
        'playbook_mining', COALESCE(tft.playbook_mining, false)
      ),
      'limits', json_build_object(
        'monthly_cost_limit', tft.monthly_cost_limit,
        'soft_limit_alert_percent', tft.soft_limit_alert_percent,
        'hard_limit_behavior', tft.hard_limit_behavior,
        'max_de_count', tft.max_de_count,
        'max_monthly_responses', tft.max_monthly_responses,
        'max_monthly_amendments', tft.max_monthly_amendments
      ),
      'billing', json_build_object(
        'sophie_config_cost', COALESCE(tbc.sophie_config_cost, 100),
        'amendment_cost', COALESCE(tbc.amendment_journeys_cost, 50),
        'metrics_cost', COALESCE(tbc.metrics_tracking_cost, 75),
        'reply_mode_cost', COALESCE(tbc.reply_mode_cost, 150),
        'hosted_chat_cost', COALESCE(tbc.hosted_chat_cost, 200),
        'cost_per_1k_responses', COALESCE(tbc.cost_per_1k_responses, 0.50),
        'cost_per_amendment', COALESCE(tbc.cost_per_amendment, 5),
        'cost_per_de', COALESCE(tbc.cost_per_de, 20)
      ),
      'usage', json_build_object(
        'de_using_sophie_config', COALESCE(tum.de_using_sophie_config, 0),
        'de_using_amendments', COALESCE(tum.de_using_amendments, 0),
        'total_responses_this_month', COALESCE(tum.total_responses_this_month, 0),
        'total_amendments_created', COALESCE(tum.total_amendments_created, 0),
        'avg_response_confidence', COALESCE(tum.avg_response_confidence, 0),
        'adoption_score', COALESCE(tum.adoption_score, 0)
      )
    )
    FROM tenants t
    LEFT JOIN tenant_feature_toggles tft ON tft.tenant_id = t.id
    LEFT JOIN tenant_billing_config tbc ON tbc.tenant_id = t.id
    LEFT JOIN tenant_usage_metrics tum ON tum.tenant_id = t.id
      AND tum.month_year = to_char(now(), 'YYYY-MM')
    WHERE t.id = p_tenant_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION update_tenant_features(
  p_tenant_id UUID,
  p_features JSONB
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_user_id := auth.uid();

  INSERT INTO tenant_feature_toggles (
    tenant_id, sophie_config_enabled, amendment_journeys_enabled,
    metrics_tracking_enabled, reply_mode_enabled, hosted_chat_enabled,
    amendment_replay_testing, trust_adaptive_execution, playbook_mining,
    updated_by
  ) VALUES (
    p_tenant_id,
    COALESCE(p_features->>'sophie_config_enabled', 'true')::boolean,
    COALESCE(p_features->>'amendment_journeys_enabled', 'true')::boolean,
    COALESCE(p_features->>'metrics_tracking_enabled', 'true')::boolean,
    COALESCE(p_features->>'reply_mode_enabled', 'true')::boolean,
    COALESCE(p_features->>'hosted_chat_enabled', 'true')::boolean,
    COALESCE(p_features->>'replay_testing', 'false')::boolean,
    COALESCE(p_features->>'trust_adaptive', 'false')::boolean,
    COALESCE(p_features->>'playbook_mining', 'false')::boolean,
    v_user_id
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    sophie_config_enabled = EXCLUDED.sophie_config_enabled,
    amendment_journeys_enabled = EXCLUDED.amendment_journeys_enabled,
    metrics_tracking_enabled = EXCLUDED.metrics_tracking_enabled,
    reply_mode_enabled = EXCLUDED.reply_mode_enabled,
    hosted_chat_enabled = EXCLUDED.hosted_chat_enabled,
    amendment_replay_testing = EXCLUDED.amendment_replay_testing,
    trust_adaptive_execution = EXCLUDED.trust_adaptive_execution,
    playbook_mining = EXCLUDED.playbook_mining,
    updated_at = now(),
    updated_by = v_user_id;

  RETURN json_build_object('ok', true, 'updated_at', now()::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION update_tenant_billing(
  p_tenant_id UUID,
  p_billing_config JSONB
)
RETURNS json AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO tenant_billing_config (
    tenant_id, sophie_config_cost, amendment_journeys_cost,
    metrics_tracking_cost, reply_mode_cost, hosted_chat_cost,
    cost_per_1k_responses, cost_per_amendment, cost_per_de,
    billing_email, payment_method
  ) VALUES (
    p_tenant_id,
    COALESCE((p_billing_config->>'sophie_config_cost')::numeric, 100),
    COALESCE((p_billing_config->>'amendment_cost')::numeric, 50),
    COALESCE((p_billing_config->>'metrics_cost')::numeric, 75),
    COALESCE((p_billing_config->>'reply_mode_cost')::numeric, 150),
    COALESCE((p_billing_config->>'hosted_chat_cost')::numeric, 200),
    COALESCE((p_billing_config->>'cost_per_1k_responses')::numeric, 0.50),
    COALESCE((p_billing_config->>'cost_per_amendment')::numeric, 5),
    COALESCE((p_billing_config->>'cost_per_de')::numeric, 20),
    p_billing_config->>'billing_email',
    COALESCE(p_billing_config->>'payment_method', 'invoice')
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    sophie_config_cost = EXCLUDED.sophie_config_cost,
    amendment_journeys_cost = EXCLUDED.amendment_journeys_cost,
    metrics_tracking_cost = EXCLUDED.metrics_tracking_cost,
    reply_mode_cost = EXCLUDED.reply_mode_cost,
    hosted_chat_cost = EXCLUDED.hosted_chat_cost,
    cost_per_1k_responses = EXCLUDED.cost_per_1k_responses,
    cost_per_amendment = EXCLUDED.cost_per_amendment,
    cost_per_de = EXCLUDED.cost_per_de,
    billing_email = EXCLUDED.billing_email,
    payment_method = EXCLUDED.payment_method,
    updated_at = now();

  RETURN json_build_object('ok', true, 'updated_at', now()::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ⚠ REVOKED, NOT GRANTED. Tier B: reachable by nobody until somebody decides
-- otherwise. This is the perimeter half of 809, kept.
revoke all on function public.get_tenant_details(uuid) from public, anon, authenticated;
revoke all on function public.update_tenant_features(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.update_tenant_billing(uuid, jsonb) from public, anon, authenticated;

do $verify$
declare
  v_bad     text[] := '{}';
  v_checks  int := 0;
  v_probes  int := 0;
  v_bw      int;
  v_fw      int;
  v_ctrl    int;
  v_zero    int;
  v_grants  int;
  v_nosp    int;
begin
  ----------------------------------------------------------------------
  -- PROBE 1 -- the capability is back: each table has a writer again.
  -- Controls first, so a zero cannot be vacuous.
  ----------------------------------------------------------------------
  with b as (
    select regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') as code
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  )
  select
    (select count(*) from b where code ~* 'insert into[[:space:]]+(public\.)?tenant_billing_config'),
    (select count(*) from b where code ~* 'insert into[[:space:]]+(public\.)?tenant_feature_toggles'),
    (select count(*) from b where code ~* 'insert into[[:space:]]+(public\.)?de_messages'),
    (select count(*) from b where code ~* 'insert into[[:space:]]+(public\.)?zzz_no_such_table')
  into v_bw, v_fw, v_ctrl, v_zero;

  v_checks := v_checks + 1;
  if v_ctrl < 1 then
    v_bad := array_append(v_bad, 'CONTROL FAILED: de_messages has no writer, so this probe is not measuring anything');
  end if;

  v_checks := v_checks + 1;
  if v_zero <> 0 then
    v_bad := array_append(v_bad, 'CONTROL FAILED: a nonsense table reported a writer, so the pattern matches too much');
  end if;

  v_checks := v_checks + 1;
  if v_bw < 1 then
    v_bad := array_append(v_bad, 'tenant_billing_config still has NO writer -- the restore did not take');
  end if;

  v_checks := v_checks + 1;
  if v_fw < 1 then
    v_bad := array_append(v_bad, 'tenant_feature_toggles still has NO writer -- the restore did not take');
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 2 -- the perimeter half of 809 is KEPT: nobody can call them.
  ----------------------------------------------------------------------
  select count(*) into v_grants
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public',
       lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  join pg_roles r on r.oid = a.grantee
  where p.proname in ('get_tenant_details', 'update_tenant_features', 'update_tenant_billing')
    and r.rolname in ('public', 'anon', 'authenticated');

  v_checks := v_checks + 1;
  if v_grants <> 0 then
    v_bad := array_append(v_bad, format('%s browser-reachable EXECUTE grant(s) survive -- 824 restores the capability but must NOT restore the exposure', v_grants));
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 3 -- hardened, not restored as found. Each carries search_path.
  ----------------------------------------------------------------------
  select count(*) into v_nosp
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_tenant_details', 'update_tenant_features', 'update_tenant_billing')
    and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

  v_checks := v_checks + 1;
  if v_nosp <> 0 then
    v_bad := array_append(v_bad, format('%s restored function(s) are SECURITY DEFINER with no search_path -- the defect 809 was reaching for is back', v_nosp));
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  -- PROBE 4 -- 809's one CORRECT drop is not undone.
  ----------------------------------------------------------------------
  v_checks := v_checks + 1;
  if to_regprocedure('public.get_all_tenants_with_summary()') is not null then
    v_bad := array_append(v_bad, 'get_all_tenants_with_summary is back -- 809 was RIGHT about that one and 824 must not resurrect it');
  end if;
  v_probes := v_probes + 1;

  ----------------------------------------------------------------------
  if array_length(v_bad, 1) > 0 then
    raise exception E'824 VERIFICATION FAILED (% assertions across % probes):\n  %',
      v_checks, v_probes, array_to_string(v_bad, E'\n  ');
  end if;

  raise notice '824: % assertions across % probes, 0 findings. billing writers=%, feature writers=%, browser-reachable grants=%, definer-without-search_path=%.',
    v_checks, v_probes, v_bw, v_fw, v_grants, v_nosp;
end;
$verify$;

commit;
