-- 337_platform_shelf_read_api.sql
-- ============================================================================
-- The READ side of the platform knowledge shelf — what a customer can see.
--
-- docs/26: the shelf is one collapsed row in the Knowledge Library, expanding
-- into a read-only view labelled "What your Workforce Assistant knows". That
-- framing is the point: it turns someone else's documents in my library into an
-- audit of what my employee was taught. When a customer asks "why did the
-- assistant tell me that?", they open the shelf.
--
-- ── Why these are safe to expose to a logged-in user ────────────────────────
-- Neither function takes a tenant parameter, a subject parameter, or a filter
-- that names a corpus — there is exactly one shelf and it is identical for
-- every workspace. So unlike every RPC hardened in migs 330 and 333, there is
-- no argument here whose value could select someone else's data. The shelf is
-- also strictly non-tenant content: it is DreamTeam's own product
-- documentation, which every customer is entitled to read.
--
-- They are SECURITY DEFINER because the shelf tables carry deny-all policies
-- and no client grants (mig 334) — these two functions are deliberately the
-- ONLY way a browser can see shelf content, so the surface stays two functions
-- wide rather than five tables wide.
--
-- Both respect `paused`: a paused shelf reads as empty rather than erroring,
-- so the UI degrades to "nothing here" instead of breaking.
-- ============================================================================

-- ── List / search the shelf. Metadata only — no bodies in the list view. ────
CREATE OR REPLACE FUNCTION public.list_platform_shelf(
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, title text, topic text, tags text[],
  source_doc_path text, source_migration text,
  last_verified_at timestamptz, updated_at timestamptz,
  cited_30d bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT d.id, d.title, d.topic, d.tags,
         d.source_doc_path, d.source_migration,
         d.last_verified_at, d.updated_at,
         coalesce((SELECT sum(u.cited_count) FROM platform_knowledge_usage_daily u
                    WHERE u.doc_id = d.id AND u.usage_date > current_date - 30), 0) AS cited_30d
    FROM platform_knowledge_docs d
   WHERE d.is_current
     AND d.published_at IS NOT NULL
     AND NOT coalesce((SELECT paused FROM platform_knowledge_shelf_state WHERE singleton), true)
     AND (
       p_query IS NULL OR length(trim(p_query)) = 0
       OR d.search_tsv @@ websearch_to_tsquery('english', p_query)
       OR d.title ILIKE '%' || p_query || '%'
     )
   ORDER BY
     -- When searching, best match first; otherwise alphabetical so the shelf
     -- reads like a manual rather than a feed.
     CASE WHEN p_query IS NULL OR length(trim(p_query)) = 0 THEN 0
          ELSE ts_rank(d.search_tsv, websearch_to_tsquery('english', p_query)) END DESC,
     d.title ASC
   LIMIT greatest(1, least(coalesce(p_limit, 200), 500));
$fn$;

-- ── Read one document in full. The citation link has to land somewhere. ────
CREATE OR REPLACE FUNCTION public.get_platform_shelf_doc(p_doc_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT to_jsonb(x) FROM (
    SELECT d.id, d.title, d.content, d.topic, d.tags,
           d.source_doc_path, d.source_migration, d.source_commit,
           d.last_verified_at, d.updated_at, d.version
      FROM platform_knowledge_docs d
     WHERE d.id = p_doc_id
       AND d.is_current
       AND d.published_at IS NOT NULL
       AND NOT coalesce((SELECT paused FROM platform_knowledge_shelf_state WHERE singleton), true)
  ) x;
$fn$;

REVOKE ALL ON FUNCTION public.list_platform_shelf(text, integer) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_platform_shelf_doc(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_platform_shelf(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_shelf_doc(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_shelf_status() TO authenticated;

DO $assert$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.list_platform_shelf(NULL, 500);
  IF v_n <> 61 THEN RAISE EXCEPTION '337: shelf listing returned % rows, expected 61', v_n; END IF;

  -- The tables themselves must remain unreachable — these two functions are the
  -- entire client surface.
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name LIKE 'platform_knowledge%'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
  THEN RAISE EXCEPTION '337: a client role gained a direct grant on a shelf table'; END IF;

  IF has_function_privilege('anon', 'public.list_platform_shelf(text, integer)', 'EXECUTE')
  THEN RAISE EXCEPTION '337: list_platform_shelf is anon-callable'; END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
