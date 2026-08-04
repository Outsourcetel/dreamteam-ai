-- 543_knowledge_you_cannot_reach_is_knowledge_you_do_not_have.sql
-- ============================================================================
-- Founder: "Knowledge → Library → Where knowledge lives — that page is so badly
-- designed."
--
-- It is not the styling. Look at what the panel actually renders for this
-- workspace today:
--
--     All knowledge      76
--     DreamTeam AI       50
--     My Product          0
--     Getting Started     0
--     Mobile              0
--
-- Fifty plus nothing plus nothing plus nothing is not seventy-six. TWENTY-SIX
-- documents are filed in no collection at all: counted in the total, reachable
-- from nowhere in the tree. A third of the library exists and cannot be got to,
-- and the arithmetic on screen openly contradicts itself.
--
-- A tree whose numbers do not reconcile teaches people not to trust it, and
-- once they stop trusting it they stop using it. That is the defect; three empty
-- folders are merely untidy next to it.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
-- knowledge_unfiled_count()  how many documents sit outside every collection,
--                            using the same tenant + current-version rules the
--                            tree's own counts use, so the two agree.
-- search_knowledge_docs      gains p_unfiled, so that node is clickable rather
--                            than merely honest. p_collection_id IS NULL means
--                            "everything" and always did; there was no way to
--                            ask the opposite question.
--
-- Adding a DEFAULTed parameter creates a second overload rather than replacing
-- the function, and the existing nine-argument call would then match both — so
-- the old signature is dropped. The client calls it with named arguments, which
-- resolve to the new one and get false for the tenth.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.knowledge_unfiled_count()
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE v_tenant uuid; v_n bigint;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM profiles p WHERE p.user_id = auth.uid();
  IF v_tenant IS NULL THEN RETURN 0; END IF;

  SELECT count(*) INTO v_n
    FROM knowledge_docs d
   WHERE d.tenant_id = v_tenant
     AND d.is_current
     AND NOT EXISTS (SELECT 1 FROM knowledge_doc_collections dc WHERE dc.doc_id = d.id);
  RETURN coalesce(v_n, 0);
END $fn$;

COMMENT ON FUNCTION public.knowledge_unfiled_count() IS
  'Documents filed in no collection. Without this the tree''s totals do not add up: the workspace total counts them and no node in the tree can reach them.';

DROP FUNCTION IF EXISTS public.search_knowledge_docs(text,text[],text,text,uuid,boolean,integer,integer,text);

CREATE OR REPLACE FUNCTION public.search_knowledge_docs(p_query text DEFAULT NULL::text, p_tags text[] DEFAULT NULL::text[], p_source text DEFAULT NULL::text, p_visibility text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid, p_current_only boolean DEFAULT true, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_lifecycle text DEFAULT NULL::text, p_unfiled boolean DEFAULT false)
 RETURNS TABLE(id uuid, title text, preview text, tags text[], source text, visibility text, share_archetype_key text, authority integer, last_verified_at timestamp with time zone, is_current boolean, chunk_count integer, embedded_count integer, updated_at timestamp with time zone, citation_count integer, last_cited_at timestamp with time zone, lifecycle_status text, verification_state text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH filtered AS (
    SELECT d.* FROM knowledge_docs d
     WHERE d.tenant_id = v_tenant
       AND (NOT p_current_only OR d.is_current)
       AND (p_source     IS NULL OR d.source = p_source)
       AND (p_visibility IS NULL OR d.visibility = p_visibility)
       AND (p_tags       IS NULL OR d.tags && p_tags)
       AND (p_lifecycle  IS NULL OR d.lifecycle_status = p_lifecycle)
       -- Documents filed nowhere. Asked for explicitly, because a NULL
       -- collection has always meant everywhere and there was no way to
       -- express the opposite.
       AND (NOT p_unfiled OR NOT EXISTS (
              SELECT 1 FROM knowledge_doc_collections dcx WHERE dcx.doc_id = d.id))
       AND (p_unfiled OR p_collection_id IS NULL OR EXISTS (
              -- Closure, not the direct junction: selecting a Space now finds
              -- documents filed anywhere beneath it, which is what clicking a
              -- folder means to a human.
              SELECT 1 FROM knowledge_doc_access_paths ap
               WHERE ap.doc_id = d.id AND ap.collection_id = p_collection_id))
       AND (v_q IS NULL OR d.search_tsv @@ websearch_to_tsquery('english', v_q))
  ), counted AS (SELECT count(*) AS n FROM filtered)
  SELECT f.id, f.title, left(coalesce(f.content, ''), 200) AS preview, f.tags, f.source, f.visibility,
         f.share_archetype_key, f.authority, f.last_verified_at, f.is_current,
         coalesce(f.chunk_count, 0), coalesce(f.embedded_count, 0), f.updated_at,
         coalesce(f.citation_count, 0), f.last_cited_at,
         f.lifecycle_status,
         public.knowledge_verification_state(f.*),
         (SELECT n FROM counted) AS total_count
    FROM filtered f
   ORDER BY
     CASE WHEN v_q IS NULL THEN 0 ELSE ts_rank(f.search_tsv, websearch_to_tsquery('english', v_q)) END DESC,
     f.updated_at DESC
   LIMIT greatest(1, least(200, coalesce(p_limit, 50)))
  OFFSET greatest(0, coalesce(p_offset, 0));
END $function$
;

notify pgrst, 'reload schema';

DO $a$
DECLARE v_tenant uuid; n_unfiled bigint; n_total bigint; n_filed bigint;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  SELECT count(*) INTO n_total FROM knowledge_docs
   WHERE tenant_id = v_tenant AND is_current;
  SELECT count(*) INTO n_unfiled FROM knowledge_docs d
   WHERE d.tenant_id = v_tenant AND d.is_current
     AND NOT EXISTS (SELECT 1 FROM knowledge_doc_collections dc WHERE dc.doc_id = d.id);
  SELECT count(*) INTO n_filed FROM knowledge_docs d
   WHERE d.tenant_id = v_tenant AND d.is_current
     AND EXISTS (SELECT 1 FROM knowledge_doc_collections dc WHERE dc.doc_id = d.id);

  -- The case under test must actually exist, or this proves nothing.
  IF n_unfiled = 0 THEN
    RAISE EXCEPTION '543: no unfiled documents in this workspace — the defect being fixed is not present';
  END IF;

  -- THE ARITHMETIC THE SCREEN WAS CONTRADICTING: filed + unfiled = total.
  IF n_filed + n_unfiled <> n_total THEN
    RAISE EXCEPTION '543: % filed + % unfiled <> % total — the counts still do not reconcile',
      n_filed, n_unfiled, n_total;
  END IF;

  RAISE NOTICE '543: % document(s) were reachable from no node in the tree; % filed + % unfiled = % total',
    n_unfiled, n_filed, n_unfiled, n_total;
END $a$;
