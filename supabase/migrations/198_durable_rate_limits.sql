-- ════════════════════════════════════════════════════════════════
-- 198: DURABLE RATE LIMITS (review deferred item DEF-2)
-- ════════════════════════════════════════════════════════════════
-- The public widget/voice endpoints throttled with per-isolate in-memory
-- Maps, which reset on every deploy and don't hold across horizontally
-- scaled isolates. This adds a DB-backed fixed-window counter the edge
-- functions consult as the AUTHORITATIVE limit (the in-memory check stays
-- as a free first line).

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_counters(window_start);

-- Service-role only — no policies on purpose (RLS on + zero policies =
-- nothing but service role can touch it).
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_bucket_key TEXT,
  p_window_seconds INTEGER,
  p_max_hits INTEGER
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_window TIMESTAMPTZ := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_hits INTEGER;
BEGIN
  INSERT INTO rate_limit_counters (bucket_key, window_start, hits)
  VALUES (p_bucket_key, v_window, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hits = rate_limit_counters.hits + 1
  RETURNING hits INTO v_hits;

  -- Opportunistic GC: ~1% of calls sweep buckets older than an hour.
  IF random() < 0.01 THEN
    DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 hour';
  END IF;

  RETURN jsonb_build_object('allowed', v_hits <= p_max_hits, 'hits', v_hits);
END$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) TO service_role;
