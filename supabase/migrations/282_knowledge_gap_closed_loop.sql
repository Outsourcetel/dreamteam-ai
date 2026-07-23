-- 282_knowledge_gap_closed_loop.sql
-- ============================================================================
-- KNOWLEDGE PHASE 2 — WS3: close the gap loop. Gap detection already CLUSTERS
-- unanswered questions (knowledge_gap_clusters + _members over evidence_runs),
-- but publishing a fix was a manual placeholder. This wires clusters into the
-- COMPLETE de-improve organ (mig 278): a high-severity cluster → LLM-drafted KB
-- fix grounded in its real inquiries → fail-closed replay → human-gated review →
-- publish → recurrence measurement. Reuses de-improve entirely; adds only the
-- link columns, the idempotency guard, a loop-closure stamp, and a driver.
--
-- ADVERSARY #2 (wf_0cad73f1-1e5, CRITICAL): a gap-seeded proposal has no
-- judgment_id, so de-improve's judgment_id dedup can't catch it → every 6h tick
-- would re-draft the same cluster = LLM cost runaway. The guard MUST land first:
-- a partial UNIQUE on de_improvements(gap_cluster_id) + a cluster→improvement
-- link set at insert + a driver that skips already-linked clusters.
-- GLOBAL, additive.
-- ============================================================================

-- ── 1. Link + idempotency guard (the hard backstop) ─────────────────────────
ALTER TABLE de_improvements ADD COLUMN IF NOT EXISTS gap_cluster_id uuid
  REFERENCES knowledge_gap_clusters(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS de_improvements_gap_cluster_uidx
  ON de_improvements (gap_cluster_id) WHERE gap_cluster_id IS NOT NULL;

ALTER TABLE knowledge_gap_clusters ADD COLUMN IF NOT EXISTS de_improvement_id uuid
  REFERENCES de_improvements(id) ON DELETE SET NULL;

-- ── 2. Loop-closure: when a gap-seeded fix is APPLIED, stamp the cluster ─────
-- so recurrence tracking (recurred_after_fix / recurrence_count) has its anchor.
-- Only touches fix_applied_at (no status write → no CHECK-constraint risk).
CREATE OR REPLACE FUNCTION public.stamp_gap_cluster_on_apply()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'applied' AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.gap_cluster_id IS NOT NULL THEN
    UPDATE knowledge_gap_clusters
       SET fix_applied_at = coalesce(fix_applied_at, now()), updated_at = now()
     WHERE id = NEW.gap_cluster_id AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stamp_gap_cluster_on_apply ON de_improvements;
CREATE TRIGGER trg_stamp_gap_cluster_on_apply
  AFTER UPDATE ON de_improvements
  FOR EACH ROW EXECUTE FUNCTION public.stamp_gap_cluster_on_apply();

-- ── 3. The driver: dispatch high-severity, unlinked clusters to de-improve ──
-- Same pattern as mig 278 (de-improve-driver): vault secret + anon JWT +
-- x-dispatch-secret, per-iteration isolation, per-tenant backpressure on the
-- human review queue. One highest-severity cluster per tenant per tick. The
-- de_improvement_id link (set by de-improve on insert) makes it idempotent.
CREATE OR REPLACE FUNCTION dispatch_gap_improve_internal()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
DECLARE
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_row    record;
  v_count  int := 0;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN RETURN 'no dispatch secret'; END IF;

  FOR v_row IN
    WITH pending AS (
      SELECT tenant_id, count(*) n FROM de_improvements
       WHERE status = 'review_pending' GROUP BY tenant_id
    )
    SELECT DISTINCT ON (g.tenant_id) g.tenant_id, g.id AS cluster_id
      FROM knowledge_gap_clusters g
      LEFT JOIN pending p ON p.tenant_id = g.tenant_id
     WHERE g.status = 'open'
       AND g.de_improvement_id IS NULL
       AND g.representative_run_id IS NOT NULL
       AND coalesce(p.n, 0) < 3
       AND NOT EXISTS (SELECT 1 FROM de_improvements di WHERE di.gap_cluster_id = g.id)
       -- draftable only: de-improve needs a DE + question from the rep run;
       -- a rep run with no de_id would 422 forever, so never dispatch it.
       AND EXISTS (SELECT 1 FROM evidence_runs r
                    WHERE r.id = g.representative_run_id
                      AND r.de_id IS NOT NULL AND r.inquiry IS NOT NULL)
     ORDER BY g.tenant_id, g.severity_score DESC NULLS LAST, g.member_count DESC
     LIMIT 25
  LOOP
    BEGIN
      PERFORM net.http_post(
        url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-improve',
        body    := jsonb_build_object('tenant_id', v_row.tenant_id, 'gap_cluster_id', v_row.cluster_id),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret)
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'gap-improve dispatch failed for tenant % cluster %: %', v_row.tenant_id, v_row.cluster_id, sqlerrm;
    END;
  END LOOP;

  RETURN 'gap-improve dispatched ' || v_count || ' http_post(s) (async)';
END;
$fn$;

-- Every 6 hours, offset from the judgment de-improve-driver ('20 */6').
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gap-improve-driver') THEN
    PERFORM cron.unschedule('gap-improve-driver');
  END IF;
  PERFORM cron.schedule('gap-improve-driver', '50 */6 * * *', 'select dispatch_gap_improve_internal()');
END $$;

NOTIFY pgrst, 'reload schema';
