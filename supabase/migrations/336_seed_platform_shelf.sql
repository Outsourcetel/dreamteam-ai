-- 336_seed_platform_shelf.sql
-- ============================================================================
-- Seed the platform knowledge shelf from the product KB, and unpause it.
--
-- ── The selection predicate (the thing the review said was missing) ─────────
-- The adversarial review's sharpest finding on this step was that "seed from
-- outsourcetel-hq" has no stated predicate and no column distinguishing product
-- documentation from that workspace's OWN content — so a naive seed would
-- publish one customer's material to every other customer.
--
-- Verified before writing this: outsourcetel-hq holds 72 current documents.
--   61 carry external_ref LIKE 'product-kb/%'  → the product KB
--   11 carry no external_ref at all            → NOT product documentation:
--        "SEO fundamentals", "Google Ads — account structure", "Bookkeeping and
--        reconciliation", "Financial planning — forecasting, cash flow and unit
--        economics", "Business development — pipeline, outreach", "Renewals —
--        cadence, risk and expansion", "Website analytics", "Invoicing basics",
--        "Customer onboarding", "At-risk accounts and dunning", "Landing pages"
-- That second set is generic business-domain training material belonging to
-- that workspace. Seeding all 72 would have pushed it to every tenant. Only the
-- 61 are copied, and the predicate is asserted at the end rather than trusted.
--
-- ── Cost: zero ──────────────────────────────────────────────────────────────
-- Those 61 docs are ALREADY chunked and embedded — 260 chunks, every one with a
-- 384-dimension gte-small vector. The vectors are copied verbatim, so there is
-- no embedding spend and retrieval quality is identical to the tenant copy by
-- construction rather than by hope.
--
-- ── What this does NOT do ───────────────────────────────────────────────────
-- It does NOT retire the originals from outsourcetel-hq. That is a separate
-- founder decision because it drops the PUBLIC /proof document count by 72.
-- Until then outsourcetel-hq keeps its own copies and is the only workspace
-- seeing the same material twice — reversible, and visible to exactly one
-- workspace rather than all of them.
--
-- Idempotent: re-running copies nothing new (matched on source_doc_path).
-- ============================================================================

-- ── 1. Copy the 61 product-KB documents ─────────────────────────────────────
INSERT INTO platform_knowledge_docs (
  title, content, tags, authority, is_current,
  source_doc_path, source_migration, last_verified_at, published_at
)
SELECT d.title, d.content, coalesce(d.tags, '{}'), coalesce(d.authority, 0), true,
       d.external_ref,
       'migration 336',
       coalesce(d.last_verified_at, d.updated_at),
       now()                              -- published: the shelf only serves published docs
  FROM knowledge_docs d
 WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
   AND d.is_current
   AND d.external_ref LIKE 'product-kb/%'
   AND NOT EXISTS (SELECT 1 FROM platform_knowledge_docs p
                    WHERE p.source_doc_path = d.external_ref);

-- ── 2. Copy their chunks, embeddings included — no re-embedding ─────────────
INSERT INTO platform_knowledge_chunks (doc_id, chunk_index, content, embedding)
SELECT p.id, c.chunk_index, c.content, c.embedding
  FROM knowledge_doc_chunks c
  JOIN knowledge_docs d      ON d.id = c.doc_id
  JOIN platform_knowledge_docs p ON p.source_doc_path = d.external_ref
 WHERE d.tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
   AND d.is_current
   AND d.external_ref LIKE 'product-kb/%'
   AND NOT EXISTS (SELECT 1 FROM platform_knowledge_chunks pc
                    WHERE pc.doc_id = p.id AND pc.chunk_index = c.chunk_index);

-- ── 3. Unpause ──────────────────────────────────────────────────────────────
UPDATE platform_knowledge_shelf_state SET paused = false, updated_at = now() WHERE singleton;

-- ── 4. Prove the predicate held and the shelf is serviceable ────────────────
DO $assert$
DECLARE v_docs int; v_chunks int; v_noembed int; v_leak int; v_paused boolean;
BEGIN
  SELECT count(*) INTO v_docs   FROM platform_knowledge_docs;
  SELECT count(*) INTO v_chunks FROM platform_knowledge_chunks;
  IF v_docs <> 61 THEN
    RAISE EXCEPTION '336: expected exactly 61 product-KB documents on the shelf, found %', v_docs;
  END IF;
  IF v_chunks <> 260 THEN
    RAISE EXCEPTION '336: expected 260 chunks, found %', v_chunks;
  END IF;

  SELECT count(*) INTO v_noembed FROM platform_knowledge_chunks WHERE embedding IS NULL;
  IF v_noembed > 0 THEN
    RAISE EXCEPTION '336: % chunk(s) arrived without an embedding — retrieval would be lexical-only', v_noembed;
  END IF;

  -- THE LEAK TEST: nothing on the shelf may trace to a document that was not
  -- product documentation. Asserted, not assumed.
  SELECT count(*) INTO v_leak
    FROM platform_knowledge_docs p
   WHERE p.source_doc_path IS NULL OR p.source_doc_path NOT LIKE 'product-kb/%';
  IF v_leak > 0 THEN
    RAISE EXCEPTION '336: % shelf document(s) are not product documentation', v_leak;
  END IF;

  SELECT paused INTO v_paused FROM platform_knowledge_shelf_state WHERE singleton;
  IF coalesce(v_paused, true) THEN RAISE EXCEPTION '336: shelf is still paused'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
