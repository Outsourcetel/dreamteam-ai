-- 562 — three drains stop waking an edge function to look at an empty queue.
--
-- WHICH ONES, DECIDED BY EVIDENCE RATHER THAN BY READING CODE. Seven days of
-- cron runs vs actual HTTP posts:
--     reembed-drain          5,031 ran / 5,031 posted   1:1  → ungated
--     embed-backfill         5,029 ran / 5,029 posted   1:1  → ungated
--     conflict-probe-drain   3,353 ran / 3,353 posted   1:1  → ungated
--     knowledge-ingest-drain 5,040 ran /     0 posted        → ALREADY GATED
-- (A grep-based check had told me 8 of 10 dispatchers were ungated. It was
-- wrong: invoke_knowledge_ingest_drain gates on a variable my pattern did not
-- match. Run-count vs post-count cannot be fooled that way.)
--
-- THE INGEST DRAIN IS THE TEMPLATE. It already does exactly this, in production,
-- successfully, and its own comment gives the reason: "Don't wake the edge
-- function for an empty queue." This migration copies a proven local pattern
-- rather than inventing one.
--
-- ⚠ THE RISK, NAMED. A wrong gate skips work SILENTLY AND FOREVER, and this
-- system has already lost a workforce to a wake-starvation regression that read
-- as healthy. Two things contain that:
--
--   1. EACH PREDICATE IS AN EXACT MIRROR of the edge function's own SELECT —
--      not a paraphrase, not a proxy:
--        embed-backfill        knowledge_doc_chunks WHERE embedding IS NULL
--        reembed-drain         knowledge_doc_chunks WHERE reembed_pending
--        conflict-probe-drain  knowledge_conflict_probe_queue WHERE probed_at IS NULL
--      If the function would find nothing, the predicate is false. Same row set.
--
--   2. AN HOURLY ESCAPE HATCH. Even with the queue judged empty, each dispatcher
--      fires anyway if it has not dispatched within the hour. A gate that is
--      wrong therefore costs AT MOST an hour of delay instead of forever. That
--      cheap 24-dispatches-a-day floor is the price of never repeating the
--      starvation bug, and it is worth paying.
--
-- The predicates are SEPARATE, PURE functions so the asserts below can prove
-- them in both directions without firing a single HTTP request.

BEGIN;

-- ── Predicates: pure, side-effect free, exactly mirroring the workers ───────
CREATE OR REPLACE FUNCTION public._pending_embed_backfill() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM knowledge_doc_chunks WHERE embedding IS NULL) $$;

CREATE OR REPLACE FUNCTION public._pending_reembed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM knowledge_doc_chunks WHERE reembed_pending) $$;

CREATE OR REPLACE FUNCTION public._pending_conflict_probe() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM knowledge_conflict_probe_queue WHERE probed_at IS NULL) $$;

-- ── The escape hatch ───────────────────────────────────────────────────────
-- TRUE when this function has NOT been dispatched inside the window, i.e. when
-- we should fire regardless of what the predicate thinks. dispatch_log is
-- written by a trigger on net.http_post, so it is the record of what actually
-- went out rather than what we believe went out.
CREATE OR REPLACE FUNCTION public._dispatch_overdue(p_fn text, p_window interval DEFAULT interval '1 hour')
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM dispatch_log
     WHERE fn = p_fn AND created_at > now() - p_window
  )
$$;

REVOKE ALL ON FUNCTION public._pending_embed_backfill()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pending_reembed()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pending_conflict_probe()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._dispatch_overdue(text, interval) FROM PUBLIC, anon, authenticated;

-- ── The three dispatchers, now gated ───────────────────────────────────────
-- Bodies reproduced from the LIVE definitions; only the early return is new.
CREATE OR REPLACE FUNCTION public.invoke_embed_backfill()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_req_id bigint;
BEGIN
  IF NOT public._pending_embed_backfill()
     AND NOT public._dispatch_overdue('embed-backfill') THEN
    RETURN 'idle';
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.invoke_reembed_drain()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_req_id bigint;
BEGIN
  IF NOT public._pending_reembed()
     AND NOT public._dispatch_overdue('reembed-drain') THEN
    RETURN 'idle';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — the re-embedding drain is doing nothing.',
      jsonb_build_object('cron', 'invoke_reembed_drain'));
    RETURN 'no_secret';
  END IF;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/reembed-drain'),
    body := jsonb_build_object('limit', 8),
    headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invoke_conflict_probe_drain()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_req_id bigint;
BEGIN
  IF NOT public._pending_conflict_probe()
     AND NOT public._dispatch_overdue('conflict-probe-drain') THEN
    RETURN 'idle';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — the conflict probe drain is doing nothing.',
      jsonb_build_object('cron', 'invoke_conflict_probe_drain'));
    RETURN 'no_secret';
  END IF;

  SELECT net.http_post(
    url := platform_fn_url('/functions/v1/conflict-probe-drain'),
    body := jsonb_build_object('limit', 8),
    headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret',v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$function$;

-- ── Asserts ────────────────────────────────────────────────────────────────
-- THE ONLY ASSERT THAT MATTERS IS THE POSITIVE ONE. Proving a gate says "skip"
-- on an empty queue proves it saves money; proving it says "go" the moment real
-- work exists is what proves it will not starve the workforce. Both directions,
-- for all three, against REAL rows flipped inside a sub-transaction that is then
-- rolled back — so no HTTP is fired and nothing is left behind.
DO $probe$
DECLARE
  v_chunk uuid;    -- knowledge_doc_chunks.id
  v_probe bigint;  -- knowledge_conflict_probe_queue.id is a bigint, not a uuid
BEGIN
  SELECT id INTO v_chunk FROM knowledge_doc_chunks LIMIT 1;
  SELECT id INTO v_probe FROM knowledge_conflict_probe_queue LIMIT 1;
  IF v_chunk IS NULL OR v_probe IS NULL THEN
    RAISE EXCEPTION 'ASSERT SETUP FAILED: need at least one chunk and one probe row to test against';
  END IF;

  -- G1 (negative): all three queues are empty right now, so all three must skip.
  -- If any of these is true today, the gate would never save anything and the
  -- measurement that motivated this migration was wrong.
  IF public._pending_embed_backfill() THEN
    RAISE EXCEPTION 'G1 FAILED: embed-backfill predicate is TRUE on an empty queue';
  END IF;
  IF public._pending_reembed() THEN
    RAISE EXCEPTION 'G1 FAILED: reembed predicate is TRUE on an empty queue';
  END IF;
  IF public._pending_conflict_probe() THEN
    RAISE EXCEPTION 'G1 FAILED: conflict-probe predicate is TRUE on an empty queue';
  END IF;

  -- G2 (positive): make ONE real row pending and the predicate must flip. This
  -- is the anti-starvation proof. Rolled back immediately.
  BEGIN
    UPDATE knowledge_doc_chunks SET embedding = NULL WHERE id = v_chunk;
    IF NOT public._pending_embed_backfill() THEN
      RAISE EXCEPTION 'G2 FAILED: a chunk with no embedding did NOT wake embed-backfill — this gate would starve it';
    END IF;
    RAISE EXCEPTION 'rollback_g2a';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_g2a' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE knowledge_doc_chunks SET reembed_pending = true WHERE id = v_chunk;
    IF NOT public._pending_reembed() THEN
      RAISE EXCEPTION 'G2 FAILED: a chunk marked reembed_pending did NOT wake the re-embed drain';
    END IF;
    RAISE EXCEPTION 'rollback_g2b';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_g2b' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE knowledge_conflict_probe_queue SET probed_at = NULL WHERE id = v_probe;
    IF NOT public._pending_conflict_probe() THEN
      RAISE EXCEPTION 'G2 FAILED: an unprobed queue row did NOT wake the conflict drain';
    END IF;
    RAISE EXCEPTION 'rollback_g2c';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_g2c' THEN RAISE; END IF;
  END;

  -- G3: the probe left nothing behind. If a rollback leaked, later ticks would
  -- dispatch on phantom work and the saving would silently not happen.
  IF public._pending_embed_backfill() OR public._pending_reembed()
     OR public._pending_conflict_probe() THEN
    RAISE EXCEPTION 'G3 FAILED: a probe write survived its rollback';
  END IF;

  -- G4: the escape hatch is live. These three have all dispatched within the
  -- hour (they were ungated until a moment ago), so "overdue" must be FALSE —
  -- proving the check reads real history rather than always returning true,
  -- which would make the gate a no-op.
  IF public._dispatch_overdue('embed-backfill')
     OR public._dispatch_overdue('reembed-drain')
     OR public._dispatch_overdue('conflict-probe-drain') THEN
    RAISE EXCEPTION 'G4 FAILED: escape hatch reports overdue for a function that dispatched minutes ago';
  END IF;

  RAISE NOTICE '562 asserts passed: all three skip when idle, all three wake on one real pending row, escape hatch live.';
END
$probe$;

COMMIT;
