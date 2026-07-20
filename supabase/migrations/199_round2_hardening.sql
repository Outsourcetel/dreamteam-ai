-- ════════════════════════════════════════════════════════════════
-- 199: ROUND-2 HARDENING (review deferred items)
-- ════════════════════════════════════════════════════════════════
--   A. Server-authoritative audit writes: a browser JWT can no longer
--      forge actor identity ("Practice Engine", "system", another user)
--      in the hash-chained audit log.
--   B. Cron/dispatch operational safety: function base URL + anon key
--      move to a runtime-config table (environment clones stop calling
--      prod), and a missing dispatch secret now RAISES AN OPS ALERT
--      instead of silently no-oping while automation is dead.
--   C. PKCE: oauth_connect_states carries a code_verifier.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- A. append_audit_event — server-derived identity for user callers
-- ────────────────────────────────────────────────────────────────
-- Service-role callers (edge functions) keep full freedom: they already
-- authenticated the real actor themselves. A user JWT caller keeps the
-- tenant-membership requirement but the actor fields are now derived
-- from the caller's own profile — p_actor/p_actor_type are recorded
-- inside detail as a CLAIM, never as the attested identity.
CREATE OR REPLACE FUNCTION append_audit_event(
  p_tenant_id  uuid,
  p_actor      text,
  p_actor_type text,
  p_action     text,
  p_category   text,
  p_detail     jsonb DEFAULT '{}'::jsonb
) RETURNS audit_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_prev  text;
  v_now   timestamptz := clock_timestamp();
  v_hash  text;
  v_row   audit_events;
  v_actor text := coalesce(nullif(p_actor, ''), 'system');
  v_type  text := coalesce(nullif(p_actor_type, ''), 'system');
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'not a member of this tenant';
    END IF;
    -- Server-attested identity: whoever holds this JWT is a USER; what
    -- they claimed to be is preserved in detail for transparency.
    IF v_actor IS DISTINCT FROM '' AND (p_actor IS DISTINCT FROM null) THEN
      v_detail := v_detail || jsonb_build_object('claimed_actor', p_actor, 'claimed_actor_type', p_actor_type);
    END IF;
    SELECT coalesce(nullif(trim(full_name), ''), 'user') INTO v_actor
    FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id LIMIT 1;
    v_type := 'user';
    v_detail := v_detail || jsonb_build_object('_user_submitted', true, '_submitted_by', auth.uid());
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  SELECT hash INTO v_prev
  FROM audit_events
  WHERE tenant_id = p_tenant_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  v_prev := coalesce(v_prev, '');

  v_hash := encode(digest(
    v_prev || p_tenant_id::text || coalesce(p_action, '') ||
    coalesce(v_detail::text, '{}') || v_now::text,
    'sha256'), 'hex');

  INSERT INTO audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  VALUES (p_tenant_id, v_actor, v_type, p_action, p_category, v_detail, v_prev, v_hash, v_now)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ────────────────────────────────────────────────────────────────
-- B1. Runtime config (environment-scoped values, NOT secrets)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_runtime_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_runtime_config ENABLE ROW LEVEL SECURITY;
-- RLS on + zero policies = service-role only.

INSERT INTO platform_runtime_config (key, value) VALUES
  ('function_base_url', 'https://rfsvmhcqeiyrxivbmpel.supabase.co'),
  ('supabase_anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.platform_fn_url(p_path text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT value FROM platform_runtime_config WHERE key = 'function_base_url'),
    'https://rfsvmhcqeiyrxivbmpel.supabase.co'
  ) || p_path;
$$;

CREATE OR REPLACE FUNCTION public.platform_anon_key()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT value FROM platform_runtime_config WHERE key = 'supabase_anon_key'),
    ''
  );
$$;

REVOKE ALL ON FUNCTION public.platform_fn_url(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_anon_key() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_fn_url(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_anon_key() TO service_role;

-- ────────────────────────────────────────────────────────────────
-- B2. Ops alerts — automation failures must be VISIBLE
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,
  message     text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_open ON ops_alerts(kind) WHERE resolved_at IS NULL;
ALTER TABLE ops_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins can view ops alerts"
ON ops_alerts FOR SELECT
USING (public.is_platform_admin());

CREATE OR REPLACE FUNCTION public.raise_ops_alert(p_kind text, p_message text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Dedup: one open alert per kind per hour keeps a 5-minute cron from
  -- flooding the table while the condition persists.
  IF EXISTS (
    SELECT 1 FROM ops_alerts
    WHERE kind = p_kind AND resolved_at IS NULL AND created_at > now() - interval '1 hour'
  ) THEN RETURN; END IF;
  INSERT INTO ops_alerts (kind, message, detail) VALUES (p_kind, p_message, coalesce(p_detail, '{}'::jsonb));
END$$;
REVOKE ALL ON FUNCTION public.raise_ops_alert(text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_ops_alert(text, text, jsonb) TO service_role;

-- ────────────────────────────────────────────────────────────────
-- B3. Cron wrappers — config-driven URLs + alert on missing secret
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.invoke_playbook_dispatch()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $fn$
DECLARE
  v_secret  text;
  v_anon    text := platform_anon_key();
  v_req_id  bigint; v_req_id2 bigint; v_req_id3 bigint; v_req_id4 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
BEGIN
  FOR v_t IN
    SELECT DISTINCT ca.tenant_id
    FROM customer_accounts ca
    LEFT JOIN health_score_config c ON c.tenant_id = ca.tenant_id
    WHERE c.last_computed_at IS NULL OR c.last_computed_at < now() - interval '24 hours'
  LOOP
    PERFORM compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  END LOOP;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — the 5-minute dispatch cron (playbooks, polling, gap/learn detection) is doing NOTHING.',
      jsonb_build_object('cron', 'invoke_playbook_dispatch'));
    RETURN format('health:%s no_secret', v_health);
  END IF;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/playbook-execute'),
    body := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
    timeout_milliseconds := 30000
  ) INTO v_req_id;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/specialist-consult'),
    body := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
    timeout_milliseconds := 30000
  ) INTO v_req_id2;

  BEGIN
    v_stale := check_staleness();
  EXCEPTION WHEN OTHERS THEN
    v_stale := jsonb_build_object('error', sqlerrm);
  END;

  BEGIN
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/knowledge-gap-detect'),
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
      timeout_milliseconds := 30000
    ) INTO v_req_id3;
  EXCEPTION WHEN OTHERS THEN v_req_id3 := NULL; END;

  BEGIN
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/learned-behavior-detect'),
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'apikey',v_anon,'x-dispatch-secret',v_secret),
      timeout_milliseconds := 30000
    ) INTO v_req_id4;
  EXCEPTION WHEN OTHERS THEN v_req_id4 := NULL; END;

  RETURN format('health:%s dispatch:%s poll:%s gap:%s learn:%s stale:%s',
    v_health, v_req_id, v_req_id2, coalesce(v_req_id3::text, 'err'), coalesce(v_req_id4::text, 'err'),
    coalesce(v_stale->>'checked', '0'));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dispatch_de_work_internal()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $fn$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  v_req_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM de_work_items WHERE status = 'queued' AND scheduled_for <= now())
     AND NOT EXISTS (SELECT 1 FROM de_objectives WHERE status IN ('open','in_progress')
                       AND ( (next_wake_at IS NOT NULL AND next_wake_at <= now())
                             OR NOT EXISTS (SELECT 1 FROM de_work_items w WHERE w.objective_id = de_objectives.id) ))
  THEN
    RETURN 'idle — nothing due';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — de-work items are queued but the work engine cron cannot run them.',
      jsonb_build_object('cron', 'dispatch_de_work_internal'));
    RETURN 'no dispatch secret';
  END IF;
  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/de-work'),
    body := '{"action":"run","max_items":3}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'x-dispatch-secret',v_secret)
  ) INTO v_req_id;
  RETURN 'de-work dispatched, req ' || v_req_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dispatch_online_eval_internal()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $fn$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  v_req_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — online eval cron is doing nothing.',
      jsonb_build_object('cron', 'dispatch_online_eval_internal'));
    RETURN 'no dispatch secret';
  END IF;
  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/de-eval-online'),
    body := '{"limit":8,"window_minutes":90}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_anon,'x-dispatch-secret',v_secret)
  ) INTO v_req_id;
  RETURN 'online-eval dispatched, req ' || v_req_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.invoke_embed_backfill()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $fn$
DECLARE
  v_secret text;
  v_req_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — embedding backfill cron is doing nothing.',
      jsonb_build_object('cron', 'invoke_embed_backfill'));
    RETURN 'no_secret';
  END IF;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/embed-backfill'),
    body := jsonb_build_object('limit', 8),
    headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.invoke_workforce_practice_review()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $fn$
DECLARE v_secret text; v_de record; v_fired int := 0; v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — weekly workforce practice review is doing nothing.',
      jsonb_build_object('cron', 'invoke_workforce_practice_review'));
    RETURN 'no_secret';
  END IF;

  FOR v_de IN
    SELECT c.de_id, c.tenant_id, count(*) AS refusals
    FROM de_messages m
    JOIN de_conversations c ON c.id = m.conversation_id
    WHERE m.role = 'assistant'
      AND m.content ILIKE '%outside my guardrails%'
      AND m.created_at > now() - interval '14 days'
    GROUP BY c.de_id, c.tenant_id
    HAVING count(*) >= 3
       AND NOT EXISTS (
         SELECT 1 FROM workforce_entity_amendments a
         WHERE a.entity_kind = 'de' AND a.entity_id = c.de_id AND a.status = 'review_pending')
    ORDER BY count(*) DESC
    LIMIT 5
  LOOP
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/entity-amend'),
      body := jsonb_build_object('tenant_id', v_de.tenant_id, 'entity_kind', 'de', 'entity_id', v_de.de_id),
      headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),
      timeout_milliseconds := 120000
    ) INTO v_req;
    v_fired := v_fired + 1;
  END LOOP;
  RETURN 'practice_review_fired:' || v_fired;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────
-- C. PKCE — the state row carries the code_verifier
-- ────────────────────────────────────────────────────────────────
ALTER TABLE oauth_connect_states ADD COLUMN IF NOT EXISTS code_verifier text;
