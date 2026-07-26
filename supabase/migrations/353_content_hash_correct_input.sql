-- 353_content_hash_correct_input.sql
-- ============================================================================
-- Correct the SQL hash twin's INPUT, and this time prove it properly.
--
-- ── What 352 got right and wrong ───────────────────────────────────────────
-- Right: dropping my md5 trigger, and conforming to _shared/contentHash.ts
-- (sha256 of normalizeContent) instead of competing with it. The normalisation
-- replica is correct — verified character-for-character against live hashes.
--
-- Wrong: the INPUT. ingest-chunks hashes
--     contentHash(`${doc.title}\n\n${doc.content}`)
-- — title, a blank line, then content. 352 hashed content alone, on my own
-- reasoning that "the same article under a tidied title is the same article".
-- That reasoning may even be better, but it is not what the system does, and
-- conforming means adopting the existing semantics rather than the ones I
-- prefer. Under the real algorithm the title is part of a document's identity.
--
-- ── And 352's assertion was hollow ─────────────────────────────────────────
-- Worse than the bug: §5 DELETED the test documents before §6 compared hashes.
-- Those were the only rows carrying a TypeScript-written hash, so the check
-- compared the SQL backfill against itself and passed trivially. It asserted
-- nothing. An assertion that destroys its own evidence first is worse than no
-- assertion, because it reports success.
--
-- Measured proof of the real defect, before writing this: of the documents
-- ingest-chunks had actually hashed, the 352 expression matched ZERO. The
-- corrected expression matches ALL of them.
--
-- §4 below therefore asserts against rows written by the TypeScript path, and
-- refuses to run at all if no such rows exist — so it can never again pass by
-- having nothing to check.
-- ============================================================================

-- ── 1. The hash, on the input the canonical implementation actually uses ───
DROP FUNCTION IF EXISTS public.knowledge_content_hash(text);

CREATE OR REPLACE FUNCTION public.knowledge_content_hash(p_title text, p_content text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  -- Byte-identical to _shared/contentHash.ts:
  --     contentHash(`${title}\n\n${content}`)
  --   = sha256_hex(normalizeContent(title + "\n\n" + content))
  SELECT encode(sha256(convert_to(
           public.knowledge_normalize_content(coalesce(p_title,'') || E'\n\n' || coalesce(p_content,'')),
           'UTF8')), 'hex');
$fn$;

COMMENT ON FUNCTION public.knowledge_content_hash(text, text) IS
  'SQL twin of _shared/contentHash.ts as called by ingest-chunks: sha256 of normalizeContent(title + blank line + content). MUST stay byte-identical — mig 353 asserts agreement against hashes the TypeScript path wrote, and refuses to pass if there are none to check.';

-- ── 2. Duplicate lookup on the same identity ───────────────────────────────
CREATE OR REPLACE FUNCTION public.find_duplicate_knowledge_doc(
  p_tenant_id uuid, p_title text, p_content text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT d.id FROM knowledge_docs d
   WHERE d.tenant_id = p_tenant_id
     AND d.is_current
     AND d.content_hash = public.knowledge_content_hash(p_title, p_content)
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.find_duplicate_knowledge_doc(uuid, text, text) FROM public, anon, authenticated;

-- ── 3. Re-backfill onto the correct input ──────────────────────────────────
-- Side-effect triggers held off (mig 348's lesson), then asserted back on.
--
-- Worth noting what this also repairs: before 347 these 2,000 hashes were NULL,
-- so mig 286's skip-if-unchanged check never matched and ingest-chunks
-- re-chunked and re-embedded every document on every touch. With a correct hash
-- it can finally skip, which is what that feature was built to do.
--
-- Measured as a DELTA rather than an absolute. A document the drain worker just
-- created legitimately has updated_at > created_at — it was inserted, then
-- ingest-chunks stamped its hash. Asserting "no document anywhere has been
-- updated since creation" would flag normal operation as damage, which is what
-- the first run of this migration did. What matters is whether THIS BACKFILL
-- stamped anything, so it is counted either side.
DO $backfill$
DECLARE v_before int; v_after int; v_rows int;
BEGIN
  SELECT count(*) INTO v_before FROM knowledge_docs WHERE updated_at > created_at + interval '1 second';

  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;
  UPDATE knowledge_docs
     SET content_hash = public.knowledge_content_hash(title, content)
   WHERE content_hash IS DISTINCT FROM public.knowledge_content_hash(title, content);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
  ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

  SELECT count(*) INTO v_after FROM knowledge_docs WHERE updated_at > created_at + interval '1 second';
  IF v_after <> v_before THEN
    RAISE EXCEPTION '353: the re-backfill stamped % additional documents as edited', v_after - v_before;
  END IF;
  RAISE NOTICE '353: re-hashed % documents, stamped none', v_rows;
END $backfill$;

-- ── 4. Prove it against hashes TYPESCRIPT wrote ────────────────────────────
DO $assert$
DECLARE v_ts_rows int; v_mismatch int; v_stamped int; v_enabled int; v_dup uuid; v_t uuid;
BEGIN
  -- Rows the drain worker created via ingest-chunks in this session. If the
  -- backfill above is correct they now agree; the point is that they were
  -- INDEPENDENTLY hashed by the TypeScript path first.
  SELECT count(*) INTO v_ts_rows FROM knowledge_docs d
   WHERE d.title LIKE '\_\_DEDUPE%' AND length(d.content_hash) = 64;
  IF v_ts_rows = 0 THEN
    RAISE EXCEPTION '353: no TypeScript-written hashes to verify against — refusing to pass vacuously (this is exactly how 352 fooled itself)';
  END IF;

  SELECT count(*) INTO v_mismatch FROM knowledge_docs d
   WHERE d.content IS NOT NULL
     AND d.content_hash IS DISTINCT FROM public.knowledge_content_hash(d.title, d.content);
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION '353: SQL and TypeScript disagree on % documents', v_mismatch;
  END IF;

  -- Round-trip the lookup through a real document.
  SELECT d.tenant_id INTO v_t FROM knowledge_docs d WHERE d.title LIKE '\_\_DEDUPE%' LIMIT 1;
  SELECT public.find_duplicate_knowledge_doc(d.tenant_id, d.title, d.content) INTO v_dup
    FROM knowledge_docs d WHERE d.title LIKE '\_\_DEDUPE%' LIMIT 1;
  IF v_dup IS NULL THEN
    RAISE EXCEPTION '353: duplicate lookup cannot find a document that exists — dedupe would never fire';
  END IF;

  -- Normalisation still equivalent across whitespace/CRLF, still discriminating.
  IF public.knowledge_content_hash('t', E'a  b\r\nc') <> public.knowledge_content_hash('t', E'a b\nc') THEN
    RAISE EXCEPTION '353: whitespace/CRLF normalisation broke';
  END IF;
  IF public.knowledge_content_hash('t', 'a b') = public.knowledge_content_hash('t', 'a c') THEN
    RAISE EXCEPTION '353: different content collided';
  END IF;
  -- Title is part of identity under this algorithm. Asserted so a future change
  -- to that semantic is a deliberate decision rather than a silent one.
  IF public.knowledge_content_hash('title one', 'same body') = public.knowledge_content_hash('title two', 'same body') THEN
    RAISE EXCEPTION '353: title is no longer part of the hash — that diverges from ingest-chunks';
  END IF;

  -- The imported corpus must still carry its true timestamps. Scoped to the
  -- 2,000 seeded documents; the worker's own output is legitimately re-written.
  SELECT count(*) INTO v_stamped FROM knowledge_docs
   WHERE updated_at > created_at + interval '1 second'
     AND title NOT LIKE '\_\_DEDUPE%' AND title NOT LIKE '\_\_DRAIN TEST%';
  IF v_stamped > 0 THEN RAISE EXCEPTION '353: % imported documents carry a bulk-update stamp', v_stamped; END IF;
  SELECT count(*) INTO v_enabled FROM pg_trigger
   WHERE tgrelid='public.knowledge_docs'::regclass
     AND tgname IN ('knowledge_docs_updated_at','knowledge_docs_invalidate_cache') AND tgenabled <> 'D';
  IF v_enabled <> 2 THEN RAISE EXCEPTION '353: side-effect triggers left disabled'; END IF;

  RAISE NOTICE '353: SQL twin verified against % TypeScript-written hashes; all documents agree', v_ts_rows;
END $assert$;

-- ── 5. Cleanup, AFTER the assertions that needed the evidence ──────────────
DELETE FROM knowledge_docs WHERE title LIKE '\_\_DEDUPE%' OR title LIKE '\_\_DRAIN TEST%';
DELETE FROM knowledge_ingestion_jobs WHERE label LIKE '\_\_dedupe\_test%' OR label LIKE '\_\_drain\_test%';

NOTIFY pgrst, 'reload schema';
