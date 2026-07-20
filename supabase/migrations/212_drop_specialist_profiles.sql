-- 212_drop_specialist_profiles.sql
-- ============================================================================
-- Retire specialist_profiles — step 2 of 2: the irreversible hard drop.
--
-- Preconditions (all verified before this migration was applied):
--   • Migration 211 repointed every SQL function onto digital_employees, and
--     migrated all subject_kind='specialist' data (grants, scopes, experience,
--     action_executions) from the old profile id to the DE id.
--   • All 7 edge functions + 5 frontend files were repointed onto specialist_de_id
--     / digital_employees and deployed. A grep confirms zero remaining readers.
--   • specialist_de_id is fully backfilled (0 nulls) on every dependent table
--     and its FKs point to digital_employees.
--   • A row snapshot of specialist_profiles + specialist_de_map + the migrated
--     grants was taken and stored off-box before running this.
--
-- This drops the auto-sync triggers (they read the columns we remove), promotes
-- specialist_de_id to the primary link, drops the vestigial old FK columns, and
-- drops specialist_de_map + specialist_profiles. Specialists live entirely in
-- digital_employees (is_specialist) from here on.
-- GLOBAL — every tenant.
-- ============================================================================

-- 1. Drop the backfill triggers + their functions (they reference the old
--    columns; CASCADE removes the trg_sync_specialist_de trigger on all 6 tables).
DROP FUNCTION IF EXISTS public.sync_specialist_de_from_specialist_id() CASCADE;
DROP FUNCTION IF EXISTS public.sync_specialist_de_from_profile_id() CASCADE;

-- 2. Promote specialist_de_id to NOT NULL where the old column was mandatory
--    (all rows already backfilled). evidence_runs + media_assets stay nullable
--    (a DE-owned evidence run legitimately has no specialist).
ALTER TABLE de_specialist_assignments ALTER COLUMN specialist_de_id SET NOT NULL;
ALTER TABLE spec_consultations       ALTER COLUMN specialist_de_id SET NOT NULL;
ALTER TABLE scribe_requests          ALTER COLUMN specialist_de_id SET NOT NULL;
ALTER TABLE specialist_sources       ALTER COLUMN specialist_de_id SET NOT NULL;

-- 2b. specialist_sources' RLS policy isolates by profile_id → specialist_profiles.
--     Rewrite it to isolate by specialist_de_id → digital_employees before the
--     column it depends on is dropped.
DROP POLICY IF EXISTS specialist_sources_tenant_isolation ON specialist_sources;
CREATE POLICY specialist_sources_tenant_isolation ON specialist_sources
  USING (specialist_de_id IN (
    SELECT d.id FROM digital_employees d JOIN profiles p ON p.tenant_id = d.tenant_id
    WHERE p.user_id = auth.uid()))
  WITH CHECK (specialist_de_id IN (
    SELECT d.id FROM digital_employees d JOIN profiles p ON p.tenant_id = d.tenant_id
    WHERE p.user_id = auth.uid()));

-- 3. Drop the old FK columns (each FK referenced specialist_profiles).
ALTER TABLE de_specialist_assignments DROP COLUMN IF EXISTS specialist_id;
ALTER TABLE evidence_runs            DROP COLUMN IF EXISTS specialist_id;
ALTER TABLE media_assets             DROP COLUMN IF EXISTS profile_id;
ALTER TABLE scribe_requests          DROP COLUMN IF EXISTS profile_id;
ALTER TABLE spec_consultations       DROP COLUMN IF EXISTS profile_id;
ALTER TABLE specialist_sources       DROP COLUMN IF EXISTS profile_id;

-- 4. resolve_specialist_de referenced the map; old specialist ids no longer
--    exist, so it collapses to "is this an is_specialist DE?". Rewrite it off
--    the map so the (currently uncalled) helper stays valid after the drop.
CREATE OR REPLACE FUNCTION public.resolve_specialist_de(p_ref uuid)
 RETURNS uuid LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT id FROM digital_employees WHERE id = p_ref AND is_specialist;
$function$;

-- 5. The mapping table is vestigial once the source table is gone.
DROP TABLE IF EXISTS specialist_de_map;

-- 5. The hard drop. Nothing reads it anymore.
DROP TABLE IF EXISTS specialist_profiles;
