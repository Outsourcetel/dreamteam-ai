-- ════════════════════════════════════════════════════════════════
-- 209: keep specialist_de_id in sync automatically (Wave 4)
-- ════════════════════════════════════════════════════════════════
-- Migration 208 backfilled specialist_de_id on the six dependent tables
-- from the historical rows. But new rows are still written by code that
-- only knows the old specialist_id / profile_id (the specialist-consult
-- edge function, the specialist APIs). Rather than rewrite a 1700-line
-- edge function and risk the working consult path, a BEFORE INSERT/UPDATE
-- trigger resolves specialist_de_id from the old id whenever it is left
-- null. Every future consult, source, media asset, scribe request and
-- consultation therefore lands on the new DE rails with no app change.
--
-- This is the safe way to satisfy "consult on the de_id path": correctness
-- is enforced at the database boundary, not scattered across callers.
-- ════════════════════════════════════════════════════════════════

-- Two shapes: tables keyed by specialist_id, and tables keyed by profile_id.
CREATE OR REPLACE FUNCTION public.sync_specialist_de_from_specialist_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.specialist_de_id IS NULL AND NEW.specialist_id IS NOT NULL THEN
    NEW.specialist_de_id := (SELECT de_id FROM specialist_de_map WHERE specialist_id = NEW.specialist_id);
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.sync_specialist_de_from_profile_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.specialist_de_id IS NULL AND NEW.profile_id IS NOT NULL THEN
    NEW.specialist_de_id := (SELECT de_id FROM specialist_de_map WHERE specialist_id = NEW.profile_id);
  END IF;
  RETURN NEW;
END$$;

-- specialist_id-keyed
DROP TRIGGER IF EXISTS trg_sync_specialist_de ON de_specialist_assignments;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF specialist_id ON de_specialist_assignments
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_specialist_id();

DROP TRIGGER IF EXISTS trg_sync_specialist_de ON evidence_runs;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF specialist_id ON evidence_runs
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_specialist_id();

-- profile_id-keyed
DROP TRIGGER IF EXISTS trg_sync_specialist_de ON media_assets;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF profile_id ON media_assets
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_profile_id();

DROP TRIGGER IF EXISTS trg_sync_specialist_de ON scribe_requests;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF profile_id ON scribe_requests
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_profile_id();

DROP TRIGGER IF EXISTS trg_sync_specialist_de ON spec_consultations;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF profile_id ON spec_consultations
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_profile_id();

DROP TRIGGER IF EXISTS trg_sync_specialist_de ON specialist_sources;
CREATE TRIGGER trg_sync_specialist_de BEFORE INSERT OR UPDATE OF profile_id ON specialist_sources
  FOR EACH ROW EXECUTE FUNCTION public.sync_specialist_de_from_profile_id();
