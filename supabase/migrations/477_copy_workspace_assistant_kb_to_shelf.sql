-- 477_copy_workspace_assistant_kb_to_shelf.sql               [DRAFT — do not
-- apply without founder approval; renumber 477 to 476+1, after the ingest
-- migration AND the embed script have both succeeded]
-- ============================================================================
-- PART 2 of 2 — put the three Workspace Assistant articles on the platform
-- knowledge shelf, so the Workforce Assistant in EVERY workspace (all tenants,
-- current and future) is taught what it itself is.
--
-- Same pattern as mig 336: copy docs + chunks + EMBEDDINGS verbatim from the
-- outsourcetel-hq tenant copy, keyed on source_doc_path — zero embedding
-- spend, retrieval quality identical to the tenant copy by construction.
-- The three docs were ingested by migration 476 and chunked+embedded by
-- embed-workspace-assistant-kb-articles.mjs (this migration REFUSES to copy a
-- doc whose chunks are not all embedded — see the pre-check).
--
-- Deliberately NOT re-running 336's global asserts (61 docs / 260 chunks —
-- those counts are stale by design); every assert here is scoped to the three
-- new paths, plus one END-TO-END retrievability assert: the shelf is only
-- fixed if platform_match_knowledge — the exact function the assistant's
-- answer path calls — actually RETURNS one of the new articles for the words
-- the real users typed. A doc the retrieval join cannot see would be the
-- quiet version of the original bug; that assert fails on it.
--
-- Idempotent: matched on source_doc_path / (doc_id, chunk_index).
-- ============================================================================

-- ── 0. Pre-check: refuse to copy half-embedded docs ─────────────────────────
DO $pre$
DECLARE v_bad int; v_docs int;
BEGIN
  SELECT count(*) INTO v_docs
    FROM knowledge_docs d
   WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND d.is_current
     AND d.external_ref IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows');
  IF v_docs <> 3 THEN
    RAISE EXCEPTION '477: expected 3 tenant source docs, found % — run migration 476 first', v_docs;
  END IF;

  SELECT count(*) INTO v_bad
    FROM knowledge_doc_chunks c
    JOIN knowledge_docs d ON d.id = c.doc_id
   WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND d.is_current
     AND d.external_ref IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows')
     AND c.embedding IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '477: % source chunk(s) still unembedded — run the embed script until it reports ready', v_bad;
  END IF;

  -- And each doc must actually HAVE chunks (a chunkless doc is lexical-only
  -- at doc level and invisible to the semantic branch entirely).
  SELECT count(*) INTO v_bad
    FROM knowledge_docs d
   WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND d.is_current
     AND d.external_ref IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows')
     AND NOT EXISTS (SELECT 1 FROM knowledge_doc_chunks c WHERE c.doc_id = d.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '477: % source doc(s) have no chunks — run the embed script first', v_bad;
  END IF;
END $pre$;

-- ── 1. Copy the three documents to the shelf ────────────────────────────────
INSERT INTO platform_knowledge_docs (
  title, content, tags, authority, is_current,
  source_doc_path, source_migration, last_verified_at, published_at
)
SELECT d.title, d.content, coalesce(d.tags, '{}'), coalesce(d.authority, 0), true,
       d.external_ref,
       'migration 477',
       coalesce(d.last_verified_at, d.updated_at),
       now()
  FROM knowledge_docs d
 WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
   AND d.is_current
   AND d.external_ref IN (
     'product-kb/getting-started/meet-your-workspace-assistant',
     'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
     'product-kb/knowledge/what-your-workforce-assistant-knows')
   AND NOT EXISTS (SELECT 1 FROM platform_knowledge_docs p
                    WHERE p.source_doc_path = d.external_ref);

-- ── 2. Copy their chunks, embeddings included ───────────────────────────────
INSERT INTO platform_knowledge_chunks (doc_id, chunk_index, content, embedding)
SELECT p.id, c.chunk_index, c.content, c.embedding
  FROM knowledge_doc_chunks c
  JOIN knowledge_docs d          ON d.id = c.doc_id
  JOIN platform_knowledge_docs p ON p.source_doc_path = d.external_ref AND p.is_current
 WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
   AND d.is_current
   AND d.external_ref IN (
     'product-kb/getting-started/meet-your-workspace-assistant',
     'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
     'product-kb/knowledge/what-your-workforce-assistant-knows')
   AND NOT EXISTS (SELECT 1 FROM platform_knowledge_chunks pc
                    WHERE pc.doc_id = p.id AND pc.chunk_index = c.chunk_index);

-- ── 3. Prove it landed AND is retrievable ───────────────────────────────────
DO $assert$
DECLARE
  v_docs int; v_noembed int; v_nochunks int; v_leak int; v_paused boolean;
  v_hit int;
BEGIN
  -- (a) The three shelf docs exist, current + published (the exact predicate
  --     platform_match_knowledge's visible_shelf_docs choke point uses).
  SELECT count(*) INTO v_docs
    FROM platform_knowledge_docs p
   WHERE p.is_current AND p.published_at IS NOT NULL
     AND p.source_doc_path IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows');
  IF v_docs <> 3 THEN
    RAISE EXCEPTION '477: expected 3 published shelf docs, found %', v_docs;
  END IF;

  -- (b) Every new doc has chunks and every chunk has a vector — the semantic
  --     branch must see them, not just the lexical one.
  SELECT count(*) INTO v_nochunks
    FROM platform_knowledge_docs p
   WHERE p.is_current
     AND p.source_doc_path IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows')
     AND NOT EXISTS (SELECT 1 FROM platform_knowledge_chunks c WHERE c.doc_id = p.id);
  IF v_nochunks > 0 THEN
    RAISE EXCEPTION '477: % new shelf doc(s) have no chunks', v_nochunks;
  END IF;

  SELECT count(*) INTO v_noembed
    FROM platform_knowledge_chunks c
    JOIN platform_knowledge_docs p ON p.id = c.doc_id
   WHERE p.source_doc_path IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows')
     AND c.embedding IS NULL;
  IF v_noembed > 0 THEN
    RAISE EXCEPTION '477: % new shelf chunk(s) have NULL embeddings — semantic retrieval dead and nothing drains shelf reembeds', v_noembed;
  END IF;

  -- (c) The 336 leak invariant still holds shelf-wide.
  SELECT count(*) INTO v_leak
    FROM platform_knowledge_docs p
   WHERE p.source_doc_path IS NULL OR p.source_doc_path NOT LIKE 'product-kb/%';
  IF v_leak > 0 THEN
    RAISE EXCEPTION '477: % shelf document(s) are not product documentation', v_leak;
  END IF;

  -- (d) Shelf must be serving (fail-closed check in platform_match_knowledge).
  SELECT paused INTO v_paused FROM platform_knowledge_shelf_state WHERE singleton;
  IF coalesce(v_paused, true) THEN
    RAISE EXCEPTION '477: shelf is paused — nothing is retrievable';
  END IF;

  -- (e) END-TO-END: the words the real failed users typed must now surface a
  --     new article through the SAME function the assistant's answer path
  --     calls. This is the assert that fails if the article landed but the
  --     retrieval join cannot see it.
  SELECT count(*) INTO v_hit
    FROM platform_match_knowledge('workforce assistance', NULL, 5) m
    JOIN platform_knowledge_docs p ON p.id = m.doc_id
   WHERE p.source_doc_path IN (
       'product-kb/getting-started/meet-your-workspace-assistant',
       'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes',
       'product-kb/knowledge/what-your-workforce-assistant-knows');
  IF v_hit = 0 THEN
    RAISE EXCEPTION '477: platform_match_knowledge(''workforce assistance'') returns none of the new articles — published but UNRETRIEVABLE';
  END IF;

  SELECT count(*) INTO v_hit
    FROM platform_match_knowledge('what is the workspace assistant', NULL, 5) m
    JOIN platform_knowledge_docs p ON p.id = m.doc_id
   WHERE p.source_doc_path = 'product-kb/getting-started/meet-your-workspace-assistant';
  IF v_hit = 0 THEN
    RAISE EXCEPTION '477: lead article not retrievable for ''what is the workspace assistant''';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
