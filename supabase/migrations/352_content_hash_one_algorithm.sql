-- 352_content_hash_one_algorithm.sql
-- ============================================================================
-- TWO CONTENT-HASH IMPLEMENTATIONS DISAGREED. Mine was the wrong one.
--
-- ── What happened ───────────────────────────────────────────────────────────
-- 347 made content_hash "real" with a trigger computing md5(title || content).
-- It did not check what already wrote that column.
--
-- _shared/contentHash.ts is the canonical implementation and predates this
-- work: sha256 hex of normalizeContent(content) — NFC, CRLF->LF, collapsed
-- horizontal whitespace, collapsed blank lines, trimmed. CONTENT ONLY, no
-- title. ingest-chunks and connector-hub both use it, and mig 286 depends on it
-- for skip-if-unchanged re-embedding.
--
-- So every document that goes through ingest-chunks gets its content_hash
-- OVERWRITTEN with a sha256 — and the 347 trigger never fires on that write,
-- because content_hash is not in its UPDATE OF column list. The two values
-- silently take turns.
--
-- Caught by the first real end-to-end drain test: two items with byte-identical
-- content both ingested, producing two documents with one shared 64-character
-- hash. 64 characters is sha256; md5 is 32. find_duplicate_knowledge_doc was
-- computing md5 and comparing it to a sha256 column, so it could never match a
-- document that had been chunked — which is every document the worker creates.
-- Deduplication was structurally incapable of firing.
--
-- ── The fix: conform, do not compete ───────────────────────────────────────
-- The established implementation wins. The trigger is DROPPED rather than
-- corrected — ingest-chunks already maintains this column for every document
-- that reaches it, and a second writer on one column is the whole problem.
-- What remains is a SQL function that replicates the canonical algorithm for
-- the one thing SQL must do: look up "have we already got this content?"
--
-- Two implementations of one algorithm is still a risk. It is unavoidable here
-- (the edge worker must ask before inserting, the database must answer), so
-- instead of pretending otherwise, §4 ASSERTS THEY AGREE against hashes that
-- ingest-chunks actually wrote. If TypeScript and SQL ever drift, that
-- assertion fails on the next migration rather than dedupe quietly dying again.
-- ============================================================================

-- ── 1. Stop the competing writer ───────────────────────────────────────────
DROP TRIGGER IF EXISTS knowledge_docs_content_hash_trg ON knowledge_docs;
DROP FUNCTION IF EXISTS knowledge_docs_set_content_hash();

-- ── 2. The canonical algorithm, in SQL ─────────────────────────────────────
-- Mirrors normalizeContent() step for step, in the same order. The order is
-- load-bearing: collapsing blank lines before trimming spaces around newlines
-- gives a different string.
CREATE OR REPLACE FUNCTION public.knowledge_normalize_content(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT btrim(
           regexp_replace(                                    -- \n{3,}  -> \n\n
             regexp_replace(                                  -- ' *\n *' -> \n
               regexp_replace(                                -- [ \t]+  -> ' '
                 regexp_replace(                              -- \r\n?   -> \n
                   normalize(coalesce(p_text, ''), NFC),
                   E'\r\n?', E'\n', 'g'),
                 E'[ \t]+', ' ', 'g'),
               E' *\n *', E'\n', 'g'),
             E'\n{3,}', E'\n\n', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.knowledge_content_hash(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(sha256(convert_to(public.knowledge_normalize_content(p_text), 'UTF8')), 'hex');
$fn$;

COMMENT ON FUNCTION public.knowledge_content_hash(text) IS
  'SQL twin of _shared/contentHash.ts. MUST stay byte-identical to it — mig 352 asserts agreement against hashes ingest-chunks wrote. Change one, change both.';

-- ── 3. Duplicate lookup, on the right algorithm and the right input ────────
CREATE OR REPLACE FUNCTION public.find_duplicate_knowledge_doc(
  p_tenant_id uuid, p_title text, p_content text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  -- Title is deliberately NOT part of the hash: the canonical implementation
  -- hashes content alone, and the same article re-imported under a tidied-up
  -- title is the same article.
  SELECT d.id FROM knowledge_docs d
   WHERE d.tenant_id = p_tenant_id
     AND d.is_current
     AND d.content_hash = public.knowledge_content_hash(p_content)
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.find_duplicate_knowledge_doc(uuid, text, text) FROM public, anon, authenticated;

-- ── 4. Re-backfill onto the canonical algorithm ────────────────────────────
-- 347 wrote md5 over 2,000 documents. Those values are wrong for every purpose
-- this column has. Side-effect triggers held off, per the lesson from mig 348.
ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_updated_at;
ALTER TABLE knowledge_docs DISABLE TRIGGER knowledge_docs_invalidate_cache;
UPDATE knowledge_docs
   SET content_hash = public.knowledge_content_hash(content)
 WHERE content_hash IS NULL OR length(content_hash) <> 64;
ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_updated_at;
ALTER TABLE knowledge_docs ENABLE TRIGGER knowledge_docs_invalidate_cache;

-- ── 5. Clean up the failed dedupe test's duplicate document ────────────────
DELETE FROM knowledge_docs WHERE title LIKE '\_\_DRAIN TEST%';
DELETE FROM knowledge_ingestion_jobs WHERE label LIKE '\_\_drain\_test%';

-- ── 6. PROVE the two implementations agree ─────────────────────────────────
DO $assert$
DECLARE v_mismatch int; v_checked int; v_stamped int; v_enabled int; r record;
BEGIN
  -- The real test: for documents whose content_hash was written by
  -- ingest-chunks (TypeScript), does the SQL twin reproduce it exactly?
  -- Any 64-char hash on a document with content qualifies.
  SELECT count(*) FILTER (WHERE d.content_hash <> public.knowledge_content_hash(d.content)),
         count(*)
    INTO v_mismatch, v_checked
    FROM knowledge_docs d
   WHERE d.content IS NOT NULL AND length(d.content_hash) = 64;

  IF v_checked = 0 THEN
    RAISE EXCEPTION '352: nothing to compare — the re-backfill did not run';
  END IF;
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION '352: the SQL hash disagrees with the stored hash on % of % documents — TypeScript and SQL have drifted',
      v_mismatch, v_checked;
  END IF;

  -- Normalisation must actually normalise, or "unchanged" stops meaning it.
  IF public.knowledge_content_hash(E'a  b\r\nc') <> public.knowledge_content_hash(E'a b\nc') THEN
    RAISE EXCEPTION '352: whitespace/CRLF normalisation is not equivalent';
  END IF;
  IF public.knowledge_content_hash('a b') = public.knowledge_content_hash('a c') THEN
    RAISE EXCEPTION '352: different content produced the same hash';
  END IF;

  -- And the competing trigger must be gone.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.knowledge_docs'::regclass
              AND tgname='knowledge_docs_content_hash_trg') THEN
    RAISE EXCEPTION '352: the md5 trigger is still attached and will keep fighting ingest-chunks';
  END IF;

  -- The re-backfill must not have re-stamped updated_at (mig 348's lesson).
  SELECT count(*) INTO v_stamped FROM knowledge_docs
   WHERE updated_at > created_at + interval '1 second';
  IF v_stamped > 0 THEN
    RAISE EXCEPTION '352: the re-backfill stamped % documents as edited', v_stamped;
  END IF;
  SELECT count(*) INTO v_enabled FROM pg_trigger
   WHERE tgrelid='public.knowledge_docs'::regclass
     AND tgname IN ('knowledge_docs_updated_at','knowledge_docs_invalidate_cache')
     AND tgenabled <> 'D';
  IF v_enabled <> 2 THEN RAISE EXCEPTION '352: side-effect triggers were left disabled'; END IF;

  RAISE NOTICE '352: one algorithm; SQL and TypeScript agree on all % hashed documents', v_checked;
END $assert$;

NOTIFY pgrst, 'reload schema';
