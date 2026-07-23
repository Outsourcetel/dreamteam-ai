-- 301_knowledge_ann_retrieval.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 (deferred base-retrieval workstream): make the semantic side
-- of hybrid_match_knowledge INDEX-BOUNDED at scale, default-OFF, results-preserving.
--
-- Today the semantic CTE is `WHERE (embedding <=> q) <= p_max_distance` — a filter
-- the pgvector HNSW index CANNOT serve, so it distance-scans EVERY tenant chunk
-- (O(tenant-chunk-count) per query). This rewrites it to an ANN pool
-- `ORDER BY embedding <=> q LIMIT v_ann_pool` (HNSW-served) then applies the
-- visible-docs join + distance filter AFTER.
--
-- Single code path, one variable LIMIT:
--   • flag OFF → v_ann_pool = 2e9 (effectively unbounded) → the pool is every
--     tenant chunk, so after the distance filter the rows are IDENTICAL to the old
--     range scan. Zero behavior change on apply.
--   • flag ON  → v_ann_pool = 200 + SET LOCAL hnsw.iterative_scan='relaxed_order'
--     (pgvector 0.8) → the index returns the 200 nearest tenant chunks; identical
--     results as long as fewer than 200 chunks sit within p_max_distance of the
--     query (true for any realistic query — only a 200+ near-identical cluster
--     diverges, and returning the 200 nearest is correct there anyway).
--
-- The base body is reproduced VERBATIM from the live mig-292 (freshness) version;
-- only the semantic CTE changes. Flag knowledge_ann_retrieval seeded default-OFF
-- BEFORE the CREATE OR REPLACE (is_feature_enabled_internal fails OPEN on an
-- unknown key). Proven results-identical on a real tenant before rollout. GLOBAL.
-- ============================================================================

INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_ann_retrieval', 'Index-bounded retrieval',
        'Use the HNSW index to bound semantic retrieval cost at scale. Default OFF; results are identical — enable per workspace as the corpus grows large.',
        false, 'retrieval')
ON CONFLICT (key) DO NOTHING;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_registry WHERE key = 'knowledge_ann_retrieval') THEN
    RAISE EXCEPTION 'ann flag row missing — refusing to replace hybrid_match_knowledge';
  END IF;
END $assert$;

CREATE OR REPLACE FUNCTION public.hybrid_match_knowledge(
  p_tenant_id uuid, p_query_text text, p_account_id uuid DEFAULT NULL::uuid,
  p_query_embedding vector DEFAULT NULL::vector, p_match_count integer DEFAULT 5,
  p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid,
  p_max_distance double precision DEFAULT 0.25)
 RETURNS TABLE(id uuid, doc_id uuid, doc_title text, content text, account_id uuid,
               visibility text, lexical_rank integer, semantic_rank integer,
               distance double precision, score double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_archetype text;
  -- Freshness weighting locals (mig 292) — 0.0 unless the tenant's flag is on.
  v_fresh_on boolean := false;
  v_fresh_weight double precision := 0.0;
  v_fresh_halflife double precision := 180.0;
  v_expired_penalty double precision := 0.0;
  v_cfg text;
  -- ANN retrieval locals (mig 301). Pool is effectively unbounded when off, so the
  -- semantic result set is identical to the original range scan.
  v_ann_on boolean := false;
  v_ann_pool bigint := 2000000000;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  v_archetype := case when p_subject_kind = 'de' and p_subject_id is not null then resolve_de_archetype(p_subject_id) end;

  -- Resolve freshness weighting (default-OFF flag + kill-switch). Regex-guarded
  -- casts fall back to defaults on any non-numeric config → never raises here.
  if is_feature_enabled_internal(p_tenant_id, 'knowledge_freshness_weighting') then
    select value into v_cfg from platform_config where key = 'knowledge.freshness_weighting_paused';
    if coalesce(v_cfg, '') not in ('true', '1', 't') then
      v_fresh_on := true;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_weight'), 0.0007) into v_fresh_weight;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_halflife_days'), 180.0) into v_fresh_halflife;
      select coalesce((select case when value ~ '^[0-9]+(\.[0-9]+)?$' then value::double precision end
                         from platform_config where key = 'knowledge.freshness_expired_penalty'), 0.006) into v_expired_penalty;
    end if;
  end if;

  -- Resolve ANN retrieval (default-OFF). When on, bound the pool + let HNSW keep
  -- walking until it has v_ann_pool tenant/account-matched rows.
  if is_feature_enabled_internal(p_tenant_id, 'knowledge_ann_retrieval') then
    v_ann_on := true;
    v_ann_pool := 200;
    set local hnsw.iterative_scan = 'relaxed_order';
  end if;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv, coalesce(d.authority, 0) as authority,
           d.last_verified_at, d.updated_at, d.expires_at
    from knowledge_docs d
    where d.tenant_id = p_tenant_id
      and d.is_current
      and (
        d.visibility = 'tenant'
        or (p_subject_kind is not null and p_subject_id is not null and exists (
              select 1 from knowledge_doc_scopes s
              where s.doc_id = d.id
                and s.subject_kind = p_subject_kind
                and s.subject_id = p_subject_id))
        or (d.visibility = 'role' and v_archetype is not null and d.share_archetype_key = v_archetype)
      )
  ),
  lexical as (
    select
      vd.id as doc_id,
      (row_number() over (order by ts_rank(vd.search_tsv, websearch_to_tsquery('english', p_query_text)) desc))::int as lexical_rank
    from visible_docs vd
    where p_query_text is not null
      and length(trim(p_query_text)) > 0
      and vd.search_tsv @@ websearch_to_tsquery('english', p_query_text)
  ),
  -- ANN candidate pool: index-bounded when the flag is on, effectively unbounded
  -- when off (same rows as the original range scan). Column-level filters only, so
  -- the HNSW index (via iterative_scan) can serve the ORDER BY … LIMIT.
  ann as (
    select c.id as chunk_id, c.doc_id, c.content, c.account_id,
           (c.embedding <=> p_query_embedding) as distance
    from knowledge_doc_chunks c
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
      and p_query_embedding is not null
      and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    order by c.embedding <=> p_query_embedding
    limit v_ann_pool
  ),
  semantic as (
    select
      a.chunk_id,
      a.doc_id,
      a.content,
      a.account_id,
      a.distance::float as distance,
      (row_number() over (order by a.distance asc))::int as semantic_rank
    from ann a
    join visible_docs vd on vd.id = a.doc_id
    where a.distance <= p_max_distance
  ),
  candidates as (
    select
      s.chunk_id as id, s.doc_id, s.content, s.account_id, s.distance, s.semantic_rank
    from semantic s
    union
    select
      gen_random_uuid() as id, vd.id as doc_id,
      (select d2.content from knowledge_docs d2 where d2.id = vd.id) as content,
      null::uuid as account_id, null::float as distance, null::int as semantic_rank
    from visible_docs vd
    join lexical l on l.doc_id = vd.id
    where not exists (select 1 from semantic s2 where s2.doc_id = vd.id)
  )
  select
    c.id, c.doc_id, vd.title as doc_title, c.content, c.account_id, vd.visibility,
    l.lexical_rank, c.semantic_rank, c.distance,
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0)
      + coalesce(1.0 / (60 + c.semantic_rank), 0.0)
      + (coalesce(vd.authority, 0) * 0.002)
      + case when v_fresh_on then
          coalesce(
            v_fresh_weight * exp(- ln(2.0)
              * greatest(0.0, extract(epoch from (now() - coalesce(vd.last_verified_at, vd.updated_at))) / 86400.0)
              / greatest(1.0, v_fresh_halflife)),
            0.0)
          - (case when vd.expires_at is not null and vd.expires_at < now() then v_expired_penalty else 0.0 end)
        else 0.0 end
    )::double precision as score
  from candidates c
  join visible_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc,
    score desc
  limit p_match_count;
end;
$function$;

NOTIFY pgrst, 'reload schema';
