-- Reply-Mode System: Draft response approval workflow
-- Allows DE to draft responses that require human review before sending

-- ════════════════════════════════════════════════════════════════
-- SCHEMA: Draft Responses Table
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS draft_responses (
  draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  user_question TEXT NOT NULL,
  draft_content TEXT NOT NULL,
  confidence NUMERIC DEFAULT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP NOT NULL DEFAULT (now() + INTERVAL '30 minutes'),
  approved_at TIMESTAMP DEFAULT NULL,
  approved_by UUID DEFAULT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_content TEXT DEFAULT NULL,
  rejected_at TIMESTAMP DEFAULT NULL,
  rejected_by UUID DEFAULT NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_draft_responses_de_id_status ON draft_responses(de_id, status);
CREATE INDEX idx_draft_responses_tenant_status ON draft_responses(tenant_id, status);
CREATE INDEX idx_draft_responses_expires_at ON draft_responses(expires_at);
CREATE INDEX idx_draft_responses_conversation_id ON draft_responses(conversation_id);

-- ════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════

ALTER TABLE draft_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see draft_responses in their tenant"
  ON draft_responses FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Users can insert draft_responses in their tenant"
  ON draft_responses FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Users can update draft_responses in their tenant"
  ON draft_responses FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ════════════════════════════════════════════════════════════════
-- RPC: Submit Draft for Review
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION submit_draft_for_review(
  p_de_id UUID,
  p_conversation_id UUID,
  p_user_question TEXT,
  p_draft_content TEXT,
  p_confidence NUMERIC DEFAULT NULL,
  p_sources JSONB DEFAULT '[]'::jsonb,
  p_review_timeout_minutes INTEGER DEFAULT 30
)
RETURNS json AS $$
DECLARE
  v_draft_id UUID;
  v_tenant_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'app.current_tenant_id not set';
  END IF;

  INSERT INTO draft_responses (
    tenant_id,
    de_id,
    conversation_id,
    user_question,
    draft_content,
    confidence,
    sources,
    expires_at
  ) VALUES (
    v_tenant_id,
    p_de_id,
    p_conversation_id,
    p_user_question,
    p_draft_content,
    p_confidence,
    COALESCE(p_sources, '[]'::jsonb),
    now() + (p_review_timeout_minutes || ' minutes')::interval
  )
  RETURNING draft_id INTO v_draft_id;

  RETURN json_build_object(
    'draft_id', v_draft_id,
    'de_id', p_de_id,
    'conversation_id', p_conversation_id,
    'user_question', p_user_question,
    'draft_content', p_draft_content,
    'confidence', p_confidence,
    'sources', COALESCE(p_sources, '[]'::jsonb),
    'created_at', now()::text,
    'expires_at', (now() + (p_review_timeout_minutes || ' minutes')::interval)::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get Pending Draft
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_pending_draft(p_draft_id UUID)
RETURNS json AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'draft_id', draft_id,
      'de_id', de_id,
      'conversation_id', conversation_id,
      'user_question', user_question,
      'draft_content', draft_content,
      'confidence', confidence,
      'sources', sources,
      'created_at', created_at::text,
      'expires_at', expires_at::text
    )
    FROM draft_responses
    WHERE draft_id = p_draft_id
      AND status = 'pending'
      AND expires_at > now()
      AND tenant_id = current_setting('app.current_tenant_id')::uuid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get Pending Drafts for DE
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_pending_drafts_for_de(p_de_id UUID)
RETURNS json AS $$
BEGIN
  RETURN json_agg(
    json_build_object(
      'draft_id', draft_id,
      'de_id', de_id,
      'conversation_id', conversation_id,
      'user_question', user_question,
      'draft_content', draft_content,
      'confidence', confidence,
      'sources', sources,
      'created_at', created_at::text,
      'expires_at', expires_at::text
    )
  ) FILTER (WHERE draft_id IS NOT NULL)
  FROM draft_responses
  WHERE de_id = p_de_id
    AND status = 'pending'
    AND expires_at > now()
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Approve Draft
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION approve_draft(
  p_draft_id UUID,
  p_edited_content TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE draft_responses
  SET
    status = 'approved',
    draft_content = COALESCE(p_edited_content, draft_content),
    edited_content = p_edited_content,
    approved_at = now(),
    approved_by = v_user_id
  WHERE draft_id = p_draft_id
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;

  RETURN json_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Reject Draft
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reject_draft(
  p_draft_id UUID,
  p_reason TEXT
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE draft_responses
  SET
    status = 'rejected',
    rejected_at = now(),
    rejected_by = v_user_id
  WHERE draft_id = p_draft_id
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;

  RETURN json_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- PERMISSIONS
-- ════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION submit_draft_for_review TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_draft TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_drafts_for_de TO authenticated;
GRANT EXECUTE ON FUNCTION approve_draft TO authenticated;
GRANT EXECUTE ON FUNCTION reject_draft TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- EMBED TOKEN SYSTEM: Iframe authentication for widget
-- ════════════════════════════════════════════════════════════════

-- Embed tokens: tenant+DE scoped JWT for iframe authentication
CREATE TABLE IF NOT EXISTS embed_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX idx_embed_tokens_tenant_de ON embed_tokens(tenant_id, de_id);
CREATE INDEX idx_embed_tokens_expires_at ON embed_tokens(expires_at);

-- ════════════════════════════════════════════════════════════════
-- RPC: Generate Embed Token
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION generate_embed_token(
  p_tenant_id UUID,
  p_de_id UUID,
  p_expires_in_hours INTEGER DEFAULT 24
)
RETURNS json AS $$
DECLARE
  v_token TEXT;
  v_token_hash TEXT;
  v_expires_at TIMESTAMP;
BEGIN
  -- Generate random token
  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + (p_expires_in_hours || ' hours')::interval;

  INSERT INTO embed_tokens (tenant_id, de_id, token_hash, expires_at)
  VALUES (p_tenant_id, p_de_id, v_token_hash, v_expires_at);

  RETURN json_build_object(
    'token', v_token,
    'expires_at', v_expires_at::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Get or Create Embed Token
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_or_create_embed_token(
  p_tenant_id UUID,
  p_de_id UUID
)
RETURNS json AS $$
DECLARE
  v_token TEXT;
  v_token_hash TEXT;
  v_expires_at TIMESTAMP;
BEGIN
  -- Check for existing valid token
  SELECT token_id, expires_at INTO v_token_hash, v_expires_at
  FROM embed_tokens
  WHERE tenant_id = p_tenant_id
    AND de_id = p_de_id
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_token_hash IS NOT NULL THEN
    -- Token exists and is still valid; return placeholder (actual token not stored)
    RETURN json_build_object(
      'token', v_token_hash,
      'expires_at', v_expires_at::text
    );
  END IF;

  -- Create new token
  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + INTERVAL '24 hours';

  INSERT INTO embed_tokens (tenant_id, de_id, token_hash, expires_at)
  VALUES (p_tenant_id, p_de_id, v_token_hash, v_expires_at);

  RETURN json_build_object(
    'token', v_token,
    'expires_at', v_expires_at::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- RPC: Verify Embed Token
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION verify_embed_token(
  p_token TEXT,
  p_tenant_id UUID,
  p_de_id UUID
)
RETURNS json AS $$
DECLARE
  v_token_hash TEXT;
BEGIN
  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  -- Verify token exists, is valid, and matches tenant+DE
  PERFORM 1 FROM embed_tokens
  WHERE token_hash = v_token_hash
    AND tenant_id = p_tenant_id
    AND de_id = p_de_id
    AND expires_at > now();

  IF FOUND THEN
    -- Update used_at timestamp
    UPDATE embed_tokens
    SET used_at = now()
    WHERE token_hash = v_token_hash;

    RETURN json_build_object('valid', true);
  ELSE
    RETURN json_build_object('valid', false);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ════════════════════════════════════════════════════════════════
-- PERMISSIONS
-- ════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION generate_embed_token TO authenticated;
GRANT EXECUTE ON FUNCTION get_or_create_embed_token TO authenticated;
GRANT EXECUTE ON FUNCTION verify_embed_token TO anon, authenticated;
