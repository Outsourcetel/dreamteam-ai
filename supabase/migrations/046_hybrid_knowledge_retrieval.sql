-- ============================================================
-- Migration 046: HYBRID KNOWLEDGE RETRIEVAL (lexical + semantic,
-- fused via Reciprocal Rank Fusion) — the ONE shared matching
-- primitive for every knowledge consumer, plus retirement of the
-- legacy search_knowledge/knowledge_articles widget path.
--
-- FOUND LIVE during a founder product-demo walkthrough of the
-- customer-facing chat widget (not from a prior audit pass):
--   1. The customer-facing widget (EndUserChatPage -> runPortalTurn
--      -> draftAgentAction) queried a LEGACY table (knowledge_articles,
--      via search_knowledge, pure ts_rank/plainto_tsquery) that had
--      never been unified with the REAL production DE pipeline
--      (knowledge_docs/knowledge_doc_chunks, free gte-small 384-dim
--      embeddings via Supabase.ai, matched with match_doc_chunks).
--      On the live Acme Telecom tenant, knowledge_articles held
--      exactly 3 rows (embedding column present but NEVER populated
--      -- 0/3), so the widget's retrieval path was functionally dead
--      weight duplicating a system that already worked better
--      elsewhere.
--   2. Founder's explicit ask: "a customer can ask a question in 10
--      different ways so it should be smart enough to understand
--      that." Pure lexical search fails on vocabulary mismatch
--      ("I'm locked out" vs. "SSO Login Troubleshooting"); pure
--      semantic search can blur past an exact rare term a customer
--      literally typed. Benchmark research validated same day: BM25-
--      only and dense-only retrieval are statistically tied around
--      NDCG ~0.695-0.698, but a well-tuned hybrid combined via
--      Reciprocal Rank Fusion (RRF) reaches NDCG ~0.75 (~7.4% lift)
--      -- RRF fuses RANK POSITION, not raw score, which sidesteps the
--      score-incompatibility problem between a bounded ts_rank value
--      and an unbounded cosine distance.
--
-- DESIGN:
--   * knowledge_docs gains a generated tsvector column (search_tsv)
--     + GIN index — same shape as knowledge_articles.search_tsv (038)
--     so lexical scoring is consistent across both systems.
--   * hybrid_match_knowledge(...) is the new single retrieval RPC.
--     It extends match_doc_chunks (032)'s scoping (tenant/account/
--     subject/visibility/is_current) rather than duplicating it, and
--     ADDS a lexical CTE ranked by ts_rank over the same doc set, then
--     fuses lexical-rank and semantic-rank per chunk's owning doc via
--     RRF: score = 1/(60 + lexical_rank) + 1/(60 + semantic_rank)
--     (k=60 is the standard RRF constant from the source literature).
--     p_query_embedding is NULLABLE — a caller with no embedding
--     available (e.g. a browser client that cannot run Supabase.ai)
--     still gets full lexical ranking; a caller that supplies an
--     embedding (every edge function) gets the full hybrid fusion.
--   * Same tenant-membership guard as every other knowledge RPC
--     (checked against profiles, not a bare trusted tenant_id), plus
--     an explicit REVOKE ... FROM PUBLIC (not just anon/authenticated
--     -- the PUBLIC-grant gotcha caught live in migration 040 recurs
--     with every new SECURITY DEFINER function unless revoked
--     explicitly at creation time).
--   * search_knowledge / knowledge_articles: audited for any OTHER
--     frontend consumer before touching anything. Exactly one call
--     site exists in the whole repo (src/lib/api.ts draftAgentAction).
--     No other legitimate use case found -> retired cleanly. The
--     functions are left in place (harmless, revoked from PUBLIC
--     already since 038/040) but the frontend no longer calls them;
--     the table is left in place undropped (out of scope / no upside
--     to a destructive drop for 3 orphaned rows) but is no longer on
--     any live retrieval path.
-- ============================================================

-- ── 1. Lexical index on knowledge_docs (mirrors knowledge_articles.search_tsv) ──
alter table knowledge_docs
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored;

create index if not exists knowledge_docs_search_tsv_idx
  on knowledge_docs using gin (search_tsv);

-- ============================================================
-- RPC: hybrid_match_knowledge — lexical + semantic fused via RRF.
--
-- Returns one row per matched chunk (same shape callers already
-- expect from match_doc_chunks, plus a fused `score` and the raw
-- `lexical_rank`/`semantic_rank` components for transparency/testing).
--
-- p_query_text       — required; drives the lexical half always.
-- p_query_embedding  — optional; drives the semantic half when present.
-- Fusion:
--   lexical_rank  = row_number() over docs ordered by ts_rank desc
--                   (only docs whose search_tsv actually matches the
--                   query are ranked; non-matching docs get no
--                   lexical contribution)
--   semantic_rank = row_number() over chunks ordered by cosine
--                   distance asc (only when p_query_embedding given)
--   score         = coalesce(1/(60+lexical_rank), 0)
--                   + coalesce(1/(60+semantic_rank), 0)
-- A chunk that only shows up in one of the two rankings still gets a
-- score (from that ranking alone) — this is what lets a rare exact
-- term surface even if its semantic neighbors are weak, and lets a
-- paraphrase surface even if it shares zero vocabulary with the doc.
-- ============================================================
drop function if exists hybrid_match_knowledge(uuid, text, uuid, vector, int, text, uuid);
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
    select d.id, d.title, d.visibility, d.search_tsv
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
      -- Relevance floor: without this, the nearest neighbor is always
      -- returned even for a totally unrelated question when the tenant's
      -- KB is small (confirmed live: a single-doc KB matched "what's the
      -- weather in Tokyo" at distance 0.29 with no cutoff). Paraphrases of
      -- an actually-covered question measured 0.068-0.199 in the same live
      -- test; an unrelated question measured 0.29+. p_max_distance=0.25
      -- sits between those, calibrated from that real gap, not a guess.
      and (c.embedding <=> p_query_embedding) <= p_max_distance
  ),
  -- Every candidate chunk: prefer real chunk rows from `semantic`; for
  -- docs that only matched lexically (no embedded chunk beat the cut,
  -- or no embedding available at all) fall back to the doc's own
  -- content as a single pseudo-chunk so a purely-lexical hit is never
  -- silently dropped from the fused result.
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
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0) + coalesce(1.0 / (60 + c.semantic_rank), 0.0))::double precision as score
  from candidates c
  join visible_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first, same as match_doc_chunks
    score desc
  limit p_match_count;
end;
$$;

-- PUBLIC-grant gotcha (found repeatedly across prior audits, migration 040):
-- this Supabase project grants EXECUTE on every new public-schema function
-- to anon/authenticated directly at creation time, SEPARATELY from the
-- PUBLIC pseudo-role grant — `revoke ... from public` alone does NOT
-- remove it (confirmed live here: anon still had EXECUTE after `revoke all
-- ... from public` alone). Revoke from PUBLIC and anon and authenticated
-- explicitly, then re-grant only to the roles that should actually call it.
revoke all on function hybrid_match_knowledge(uuid, text, uuid, vector, int, text, uuid, float) from public, anon, authenticated;
grant execute on function hybrid_match_knowledge(uuid, text, uuid, vector, int, text, uuid, float) to authenticated, service_role;

-- ============================================================
-- Knowledge-gaps signal for the live dashboard: a thin, explicitly-
-- scoped read helper so the frontend doesn't need a raw table grant
-- (RLS on knowledge_revision_requests is already SELECT-only for
-- tenant members, so a direct .from() select would also work — this
-- RPC just gives a stable single-number contract for the KPI card).
-- ============================================================
create or replace function count_pending_knowledge_gaps(p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;

  select count(*) into v_count
  from knowledge_revision_requests
  where tenant_id = p_tenant_id
    and status = 'pending_approval';

  return coalesce(v_count, 0);
end;
$$;

revoke all on function count_pending_knowledge_gaps(uuid) from public, anon, authenticated;
grant execute on function count_pending_knowledge_gaps(uuid) to authenticated, service_role;
