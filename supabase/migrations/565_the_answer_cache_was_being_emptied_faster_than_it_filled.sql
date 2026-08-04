-- 565 — the answer cache was being wiped faster than it could fill.
--
-- SYMPTOM: 19 cache hits in 30 days against 276 inquiries (7%), and the table
-- holds exactly ONE row with zero hits on it. Hits had happened; the entries
-- that served them are gone.
--
-- CAUSE: invalidate_answer_cache marks EVERY entry for a tenant invalid whenever
-- ANY knowledge document row changes —
--     update answer_cache set invalidated = true where tenant_id = ...
-- with no reference to whether the answer had anything to do with that document.
-- The trigger is tgtype 29: INSERT **and** UPDATE and DELETE. So INGESTING A NEW
-- DOCUMENT throws away every cached answer in the workspace, including answers
-- that could not possibly have cited a document that did not exist when they
-- were written. With a knowledge base under active ingestion the cache can never
-- accumulate, which is exactly what the single surviving row shows.
--
-- ⚠ THE THRESHOLD IS NOT THE PROBLEM AND MUST NOT BE TOUCHED. CACHE_MAX_DISTANCE
-- is 0.05 — near-verbatim repeats only — and de-answer records why: at 0.15 the
-- cache served the trade-shift answer to "how do I view schedules" and five other
-- crossed pairs at confidence 95, caught by the golden QA suite. Distinct support
-- questions in one domain bottom out at 0.152 pairwise. Loosening the threshold
-- to raise the hit rate would buy the number back by serving wrong answers.
-- A low hit rate is the price of that correctness; an EMPTY CACHE is a bug.
--
-- THE FIX, in three parts:
--   1. UPDATE/DELETE invalidate only entries that CITED the document. The cache
--      already records `sources` (an array of document titles), so this is a
--      containment test, not a guess. Matching OLD.title is right: that is the
--      title the cached answer recorded.
--   2. UPDATE only invalidates when the TITLE or CONTENT actually changed. A
--      lifecycle flip or an updated_at touch changes no answer.
--   3. INSERT stops invalidating entirely — a brand-new document cannot have
--      been cited by an existing answer.
--
-- Part 3 leaves one real gap: a NEW document that supersedes an old answer
-- ("hours changed to 8-6") would not invalidate the cached "hours are 9-5".
-- match_cached_answer has no age limit at all, so nothing else bounds that. So a
-- 30-day TTL is added — the staleness window becomes a month instead of
-- unbounded, which is a far better trade than an empty cache.

BEGIN;

-- ── 1. Age, so staleness can be bounded ────────────────────────────────────
ALTER TABLE answer_cache ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- ── 2. Invalidate what the change actually affects ─────────────────────────
CREATE OR REPLACE FUNCTION public.invalidate_answer_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- A document that has just come into existence cannot have been cited by an
  -- answer written before it. Wiping the workspace's cache on INSERT is what
  -- kept this table empty.
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Nothing an answer could have quoted has changed.
  IF TG_OP = 'UPDATE'
     AND NEW.title IS NOT DISTINCT FROM OLD.title
     AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NEW;
  END IF;

  -- `sources` is a jsonb ARRAY OF TITLES, so `?` is a containment test against
  -- the exact string the answer recorded. OLD.title is the one a cached answer
  -- would carry; NEW.title is checked too so a rename cannot strand an entry.
  UPDATE answer_cache
     SET invalidated = true
   WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
     AND invalidated = false
     AND (sources ? OLD.title
          OR sources ? coalesce(NEW.title, OLD.title));

  RETURN coalesce(NEW, OLD);
END;
$function$;

-- ── 3. Bound the staleness the INSERT change leaves behind ─────────────────
-- Body reproduced from the LIVE definition; only the age filter is new. Same
-- signature, so this replaces rather than adding an overload (the mistake in 562).
CREATE OR REPLACE FUNCTION public.match_cached_answer(
  p_tenant_id uuid, p_account_id uuid, p_query_embedding vector,
  p_max_distance double precision DEFAULT 0.15, p_language text DEFAULT NULL::text,
  p_de_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, answer text, confidence integer, sources jsonb, distance double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'anon' then
    raise exception 'tenant access denied';
  end if;
  perform public._assert_caller_tenant(p_tenant_id);
  return query
  select a.id, a.answer, a.confidence, a.sources,
         (a.question_embedding <=> p_query_embedding)::float as distance
  from answer_cache a
  where a.tenant_id = p_tenant_id
    and a.invalidated = false
    -- NEW: a cached answer older than 30 days is no longer served. Precise
    -- invalidation covers edits to documents an answer cited; this covers the
    -- case it cannot see — a NEW document that supersedes an old answer.
    and a.created_at > now() - interval '30 days'
    and a.question_embedding is not null
    and a.de_id is not distinct from p_de_id   -- DE-scoped: a DE's cache serves only that DE
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
    and (
      (p_language is null and (a.language is null or a.language ilike 'english'))
      or (p_language is not null and a.language ilike p_language)
    )
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$function$;

-- ── Asserts ────────────────────────────────────────────────────────────────
-- The one that matters is J3: an edit to a document an answer DID cite must
-- still invalidate it. Precision that under-invalidates would serve stale
-- answers, which is worse than the empty cache this migration is fixing.
DO $probe$
DECLARE
  v_tenant uuid;
  v_doc    uuid;
  v_title  text;
  v_cited  uuid;
  v_other  uuid;
  v_n      int;
BEGIN
  SELECT d.tenant_id, d.id, d.title INTO v_tenant, v_doc, v_title
    FROM knowledge_docs d WHERE d.content IS NOT NULL LIMIT 1;
  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'ASSERT SETUP FAILED: no knowledge document to test against';
  END IF;

  BEGIN
    -- Two entries: one cites the document, one does not.
    INSERT INTO answer_cache (tenant_id, question, answer, confidence, sources, invalidated)
    VALUES (v_tenant, 'probe cited', 'a', 90, to_jsonb(array[v_title]), false)
    RETURNING id INTO v_cited;
    INSERT INTO answer_cache (tenant_id, question, answer, confidence, sources, invalidated)
    VALUES (v_tenant, 'probe uncited', 'a', 90, '["some other document entirely"]'::jsonb, false)
    RETURNING id INTO v_other;

    -- J1: INSERTING a document invalidates NOTHING. This is the bug that
    -- emptied the cache.
    INSERT INTO knowledge_docs (tenant_id, title, content, source)
    VALUES (v_tenant, 'probe brand new doc', 'irrelevant body', 'paste');
    SELECT count(*) INTO v_n FROM answer_cache WHERE id IN (v_cited, v_other) AND invalidated;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'J1 FAILED: inserting a new document invalidated % cache entr(y/ies)', v_n;
    END IF;

    -- J2: a no-op UPDATE (neither title nor content) invalidates nothing.
    UPDATE knowledge_docs SET updated_at = now() WHERE id = v_doc;
    SELECT count(*) INTO v_n FROM answer_cache WHERE id IN (v_cited, v_other) AND invalidated;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'J2 FAILED: touching updated_at invalidated % entr(y/ies)', v_n;
    END IF;

    -- J3: THE ONE THAT MATTERS. Changing the CONTENT of a cited document must
    -- invalidate the answer that quoted it.
    UPDATE knowledge_docs SET content = content || ' (probe edit)' WHERE id = v_doc;
    IF NOT (SELECT invalidated FROM answer_cache WHERE id = v_cited) THEN
      RAISE EXCEPTION 'J3 FAILED: editing a cited document did NOT invalidate its cached answer — this would serve stale answers';
    END IF;

    -- J4: and it must NOT invalidate an answer that cited something else.
    IF (SELECT invalidated FROM answer_cache WHERE id = v_other) THEN
      RAISE EXCEPTION 'J4 FAILED: editing one document invalidated an answer that never cited it — the old sledgehammer';
    END IF;

    RAISE EXCEPTION 'rollback_probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_probe' THEN RAISE; END IF;
  END;

  -- J5: the probe left nothing behind.
  SELECT count(*) INTO v_n FROM answer_cache WHERE question LIKE 'probe %';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'J5 FAILED: % probe cache row(s) survived the rollback', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM knowledge_docs WHERE title = 'probe brand new doc';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'J5 FAILED: the probe document survived the rollback';
  END IF;

  -- J6: one signature for the reader, so no ambiguous-overload repeat of 562.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'match_cached_answer';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'J6 FAILED: % overloads of match_cached_answer', v_n;
  END IF;

  RAISE NOTICE '565 asserts passed: inserts spare the cache, edits invalidate only what cited them.';
END
$probe$;

COMMIT;
