-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Knowledge chunks (chunked + embedded articles) ───────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id    uuid,                    -- optional link back to knowledge_articles
  title         text NOT NULL DEFAULT '',
  content       text NOT NULL,
  embedding     vector(1536),            -- OpenAI text-embedding-3-small dimensions
  source_type   text NOT NULL DEFAULT 'manual',
  source_url    text,
  chunk_index   integer NOT NULL DEFAULT 0,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_chunks_tenant ON knowledge_chunks
  FOR ALL
  USING (
    tenant_id = (SELECT tenant_id FROM profiles WHERE user_id = auth.uid() LIMIT 1)
  );

-- IVFFlat index — only kicks in once there are enough rows, harmless before that
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_idx
  ON knowledge_chunks (tenant_id);

-- ── Semantic search function (vector similarity) ──────────────────────────────
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding vector(1536),
  match_tenant_id uuid,
  match_threshold float DEFAULT 0.4,
  match_count     int   DEFAULT 6
)
RETURNS TABLE (id uuid, content text, title text, similarity float)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.title,
    (1 - (kc.embedding <=> query_embedding))::float AS similarity
  FROM knowledge_chunks kc
  WHERE kc.tenant_id = match_tenant_id
    AND kc.embedding IS NOT NULL
    AND (1 - (kc.embedding <=> query_embedding)) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── Full-text search function (keyword fallback, used by workforce-chat) ──────
CREATE OR REPLACE FUNCTION search_knowledge(
  p_tenant_id uuid,
  p_query     text,
  p_limit     int DEFAULT 5
)
RETURNS TABLE (id uuid, title text, body text, similarity float)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    ka.id,
    ka.title,
    ka.body,
    ts_rank(
      to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,'')),
      plainto_tsquery('english', p_query)
    )::float AS similarity
  FROM knowledge_articles ka
  WHERE ka.tenant_id = p_tenant_id
    AND ka.status = 'published'
    AND to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,''))
        @@ plainto_tsquery('english', p_query)
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;
