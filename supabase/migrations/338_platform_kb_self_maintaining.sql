-- 338_platform_kb_self_maintaining.sql
-- ============================================================================
-- PART 3 of docs/26 — keep the product KB TRUE as the platform changes.
--
-- A product KB describing July's behaviour is worse than none: the Workforce
-- Assistant states stale behaviour CONFIDENTLY, in every workspace at once,
-- which is the exact failure this product exists to prevent. Part 1 and 2 made
-- the shelf real; this is what stops it rotting.
--
-- ── Why a NEW queue rather than knowledge_revision_requests ─────────────────
-- The instinct is to reuse the existing draft→approve machinery. It cannot be
-- reused: knowledge_revision_requests is tenant-scoped and apply_knowledge_
-- revision writes to knowledge_docs gated on tenant_id. Shelf ids passed
-- through it would match nothing and be dropped WITHOUT an error — precisely
-- the silent-drop bug already found on the citation path in mig 335. Same
-- lesson, applied before it bites rather than after.
--
-- ── The loop ────────────────────────────────────────────────────────────────
--   ship  →  HARVEST     migration headers into platform_kb_changes
--         →  MATCH       lexically against the shelf: which articles does this
--                        change touch?  (deterministic — no model, no
--                        fabrication risk, and it runs on prose we already wrote)
--         →  REVIEW      a human edits the article, or dismisses the change
--         →  PUBLISH     new version + chunks marked reembed_pending
--
-- The harvest source is deliberately the MIGRATION HEADERS. Every migration in
-- this repo carries long prose explaining what changed and WHY, written at the
-- moment of the change — mig 325 explains the judgment layer better than any
-- doc written afterwards would. That is a house habit turned into an asset.
--
-- ── v1 is deliberately NOT generative ───────────────────────────────────────
-- This version tells a human WHICH articles a change affects and WHY, and gives
-- them the change text to edit from. It does not write the prose. That is a
-- choice: a model drafting product documentation that is then served to every
-- customer as authoritative is exactly the surface where a confident invention
-- does most damage. The human-approval gate stays either way; adding drafting
-- later only changes who types the first version.
-- ============================================================================

-- ── 1. The change feed ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_kb_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind   text NOT NULL DEFAULT 'migration'
                  CHECK (source_kind IN ('migration','feature_flag','deploy','manual')),
  source_ref    text NOT NULL,              -- '338_platform_kb_self_maintaining.sql'
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',   -- the header prose, verbatim
  shipped_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','reviewed','dismissed')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  dismiss_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_ref)          -- harvest is idempotent
);

-- Which shelf articles a change appears to touch. One row per (change, doc).
CREATE TABLE IF NOT EXISTS platform_kb_change_impacts (
  change_id  uuid NOT NULL REFERENCES platform_kb_changes(id) ON DELETE CASCADE,
  doc_id     uuid NOT NULL REFERENCES platform_knowledge_docs(id) ON DELETE CASCADE,
  rank       double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (change_id, doc_id)
);

-- Same posture as the rest of the shelf: no client surface at all.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_kb_changes','platform_kb_change_impacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_deny_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (false) WITH CHECK (false)', t || '_deny_all', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM public, anon, authenticated', t);
  END LOOP;
END $rls$;

-- ── 2. Record a change, and immediately work out what it touches ────────────
-- Lexical match against the shelf's own search vector. No model involved, so
-- there is nothing here that can invent a connection that is not in the words.
CREATE OR REPLACE FUNCTION public.record_platform_kb_change(
  p_source_kind text, p_source_ref text, p_title text, p_body text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_id uuid; v_q text;
BEGIN
  INSERT INTO platform_kb_changes (source_kind, source_ref, title, body)
  VALUES (coalesce(p_source_kind,'migration'), p_source_ref, p_title, coalesce(p_body,''))
  ON CONFLICT (source_kind, source_ref) DO UPDATE
    SET title = excluded.title, body = excluded.body
  RETURNING id INTO v_id;

  DELETE FROM platform_kb_change_impacts WHERE change_id = v_id;

  -- websearch_to_tsquery is unforgiving about punctuation; feed it the words.
  v_q := regexp_replace(coalesce(p_title,'') || ' ' || left(coalesce(p_body,''), 4000), '[^a-zA-Z0-9 ]', ' ', 'g');
  v_q := trim(regexp_replace(v_q, '\s+', ' ', 'g'));
  IF v_q = '' THEN RETURN v_id; END IF;

  INSERT INTO platform_kb_change_impacts (change_id, doc_id, rank)
  SELECT v_id, d.id, ts_rank(d.search_tsv, plainto_tsquery('english', v_q))
    FROM platform_knowledge_docs d
   WHERE d.is_current AND d.published_at IS NOT NULL
     AND d.search_tsv @@ plainto_tsquery('english', v_q)
   ORDER BY 3 DESC
   LIMIT 5;                                  -- the few most likely, not a dragnet

  RETURN v_id;
END $fn$;

-- ── 3. What a human needs to look at ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_platform_kb_review_queue()
RETURNS TABLE (
  change_id uuid, source_kind text, source_ref text, title text, body text,
  shipped_at timestamptz, affected jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT c.id, c.source_kind, c.source_ref, c.title, c.body, c.shipped_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'doc_id', d.id, 'title', d.title,
                     'last_verified_at', d.last_verified_at) ORDER BY i.rank DESC)
                     FROM platform_kb_change_impacts i
                     JOIN platform_knowledge_docs d ON d.id = i.doc_id
                    WHERE i.change_id = c.id), '[]'::jsonb)
    FROM platform_kb_changes c
   WHERE c.status = 'new'
   ORDER BY c.shipped_at DESC;
$fn$;

-- ── 4. Publish a corrected article — the only write path to shelf content ───
-- Versioned, never destructive: the old row is retired and a new one published,
-- so "what did the assistant know in September?" stays answerable. Chunks are
-- marked reembed_pending rather than silently left stale.
CREATE OR REPLACE FUNCTION public.publish_platform_shelf_doc(
  p_doc_id uuid, p_title text, p_content text, p_source_change_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_old platform_knowledge_docs; v_new uuid; v_mig text;
BEGIN
  SELECT * INTO v_old FROM platform_knowledge_docs WHERE id = p_doc_id AND is_current;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'shelf document not found or not current'; END IF;
  IF p_content IS NULL OR length(btrim(p_content)) = 0 THEN
    RAISE EXCEPTION 'refusing to publish an empty article';
  END IF;

  SELECT source_ref INTO v_mig FROM platform_kb_changes WHERE id = p_source_change_id;

  UPDATE platform_knowledge_docs SET is_current = false, updated_at = now() WHERE id = p_doc_id;

  INSERT INTO platform_knowledge_docs (
    title, content, topic, tags, authority, is_current, version, previous_version_id,
    source_doc_path, source_migration, last_verified_at, published_at)
  VALUES (
    coalesce(nullif(btrim(p_title), ''), v_old.title), p_content, v_old.topic, v_old.tags,
    v_old.authority, true, v_old.version + 1, v_old.id,
    v_old.source_doc_path, coalesce(v_mig, v_old.source_migration), now(), now())
  RETURNING id INTO v_new;

  -- Carry the chunks forward, flagged for re-embedding. Retrieval keeps working
  -- on the old vectors until the drain catches up rather than going blind.
  INSERT INTO platform_knowledge_chunks (doc_id, chunk_index, content, embedding, reembed_pending)
  SELECT v_new, c.chunk_index, c.content, c.embedding, true
    FROM platform_knowledge_chunks c WHERE c.doc_id = p_doc_id;

  IF p_source_change_id IS NOT NULL THEN
    UPDATE platform_kb_changes
       SET status = 'reviewed', reviewed_at = now(), reviewed_by = auth.uid()
     WHERE id = p_source_change_id;
  END IF;

  RETURN v_new;
END $fn$;

CREATE OR REPLACE FUNCTION public.dismiss_platform_kb_change(p_change_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'say why this change needs no documentation update';
  END IF;
  UPDATE platform_kb_changes
     SET status = 'dismissed', dismiss_reason = btrim(p_reason),
         reviewed_at = now(), reviewed_by = auth.uid()
   WHERE id = p_change_id;
END $fn$;

REVOKE ALL ON FUNCTION public.record_platform_kb_change(text, text, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_platform_shelf_doc(uuid, text, text, uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_platform_kb_review_queue() FROM public, anon;
REVOKE ALL ON FUNCTION public.dismiss_platform_kb_change(uuid, text) FROM public, anon;

-- ── 5. Staleness: articles nobody has re-verified since the platform moved ──
CREATE OR REPLACE FUNCTION public.get_platform_kb_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT jsonb_build_object(
    'changes_awaiting_review', (SELECT count(*) FROM platform_kb_changes WHERE status = 'new'),
    'articles_flagged',        (SELECT count(DISTINCT i.doc_id) FROM platform_kb_change_impacts i
                                  JOIN platform_kb_changes c ON c.id = i.change_id WHERE c.status = 'new'),
    'articles_total',          (SELECT count(*) FROM platform_knowledge_docs WHERE is_current AND published_at IS NOT NULL),
    'stalest_verified_at',     (SELECT min(last_verified_at) FROM platform_knowledge_docs WHERE is_current),
    'chunks_awaiting_reembed', (SELECT count(*) FROM platform_knowledge_chunks WHERE reembed_pending));
$fn$;
REVOKE ALL ON FUNCTION public.get_platform_kb_health() FROM public, anon;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name LIKE 'platform_kb%'
                AND grantee IN ('anon','authenticated','PUBLIC'))
  THEN RAISE EXCEPTION '338: a client role holds a grant on a change-feed table'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
