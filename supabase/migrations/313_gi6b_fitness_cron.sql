-- 313_gi6b_fitness_cron.sql
-- ============================================================================
-- GI-6b — cron dispatcher for de-fitness-measure. The driver fn self-selects ONE
-- applied 'de' amendment per invocation and is itself gated on the
-- 'amendment_fitness.enabled' platform_config flag (default OFF), so this whole
-- feature is INERT until the founder flips that flag. To avoid even a wasted
-- http_post while off, the dispatcher ALSO checks the flag before posting.
-- Dispatch idiom = mig 278 (vault 'playbook_dispatch_secret' + net.http_post +
-- hardcoded anon JWT so the new verify_jwt=true fn clears the gateway). GLOBAL.
-- ============================================================================

-- Seed the gate OFF (explicit row so it is flippable from platform_config).
INSERT INTO platform_config (key, value) VALUES ('amendment_fitness.enabled', 'false')
  ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION dispatch_de_fitness_measure_internal()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
begin
  -- Gate: no work + no wasted post while the feature is off.
  if coalesce((select value from platform_config where key = 'amendment_fitness.enabled'), 'false') <> 'true' then
    return 'amendment_fitness disabled';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  -- One amendment per tick (the fn picks the oldest unmeasured applied 'de').
  perform net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-fitness-measure',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_anon,
                 'x-dispatch-secret', v_secret
               )
  );
  return 'de-fitness-measure dispatched (async)';
end;
$fn$;
REVOKE ALL ON FUNCTION dispatch_de_fitness_measure_internal() FROM public, anon, authenticated;

-- Every 30 min, one amendment/tick — conservative; self-limiting (the fn returns
-- immediately when the flag is off or nothing is unmeasured).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'de-fitness-measure-driver') THEN
    PERFORM cron.unschedule('de-fitness-measure-driver');
  END IF;
  PERFORM cron.schedule('de-fitness-measure-driver', '*/30 * * * *', 'select dispatch_de_fitness_measure_internal()');
END $$;
