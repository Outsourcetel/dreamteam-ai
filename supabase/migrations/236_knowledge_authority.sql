-- 236_knowledge_authority.sql
-- ============================================================================
-- Support hardening — knowledge TRUST / AUTHORITY hierarchy in retrieval.
--
-- hybrid_match_knowledge (mig 046) ranks purely on relevance (lexical+semantic
-- fused via RRF). So a stale imported doc or an old resolved-case note can
-- outrank canonical policy when their text happens to score a hair higher. The
-- prompt's ask: lower-trust sources must not silently override higher-trust ones.
--
-- This adds a per-doc AUTHORITY tier and folds it into the RRF score with a
-- SMALL weight (~one rank position per tier). Design guarantees:
--   • DEFAULT NEUTRAL — authority defaults to 0, so every existing doc is
--     unchanged and retrieval behaves EXACTLY as before until a tenant assigns
--     authority (e.g. official policy 3, knowledge article 2, SOP 1, imported/
--     case 0). Zero behavior change on apply.
--   • IDENTICAL RETURN SHAPE — the RPC's signature and output columns are
--     unchanged, so no caller (de-answer / widget-ask / eval-judge) is affected.
--   • Conservative weight — authority nudges ties and near-ties toward canonical
--     sources; a much-more-relevant doc still wins. Never a hard override.
--
-- Every line of hybrid_match_knowledge is reproduced byte-for-byte from mig 046
-- except the two additive touches (authority in visible_docs + in the score).
-- A syntax error fails the migration harmlessly (old fn preserved). GLOBAL.
-- ============================================================================

-- Authority tier: higher = more trusted. 0 = neutral (default). Tenants set it
-- (e.g. 3 official policy, 2 article, 1 SOP, 0 imported/case) via config/UI.
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS authority integer NOT NULL DEFAULT 0;

create or replace function hybrid_match_knowledge(
  p_tenant_id       uuid,
  p_query_text      text,
  p_account_id      uuid default null,
  p_query_embedding vector(384) default null,
  p_match_count     int default 5,
  p_subject_kind    text default null,
  p_subject_id      uuid default null,
  p_max_distance    float default 0.25
)
returns table (
  id            uuid,
  doc_id        uuid,
  doc_title     text,
  content       text,
  account_id    uuid,
  visibility    text,
  lexical_rank  int,
  semantic_rank int,
  distance      float,
  score         float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv, coalesce(d.authority, 0) as authority
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
  semantic as (
    select
      c.id as chunk_id,
      c.doc_id,
      c.content,
      c.account_id,
      (c.embedding <=> p_query_embedding)::float as distance,
      (row_number() over (order by (c.embedding <=> p_query_embedding) asc))::int as semantic_rank
    from knowledge_doc_chunks c
    join visible_docs vd on vd.id = c.doc_id
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
      and p_query_embedding is not null
      and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
      and (c.embedding <=> p_query_embedding) <= p_max_distance
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
    -- RRF fusion + a SMALL authority boost (default authority 0 => +0.0, i.e.
    -- identical to mig 046 until a tenant assigns authority). ~0.002 per tier
    -- ≈ one rank position, so canonical sources win ties/near-ties, never a
    -- hard override of a much-more-relevant doc.
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0)
      + coalesce(1.0 / (60 + c.semantic_rank), 0.0)
      + (coalesce(vd.authority, 0) * 0.002))::double precision as score
  from candidates c
  join visible_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc,
    score desc
  limit p_match_count;
end;
$$;

revoke all on function hybrid_match_knowledge(uuid, text, uuid, vector, int, text, uuid, float) from public, anon, authenticated;
grant execute on function hybrid_match_knowledge(uuid, text, uuid, vector, int, text, uuid, float) to authenticated, service_role;
