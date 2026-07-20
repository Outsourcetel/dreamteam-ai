-- ════════════════════════════════════════════════════════════════
-- 201: AI WORKING SESSIONS — the conversational spine (Wave 1)
-- ════════════════════════════════════════════════════════════════
-- Every AI-assisted surface in the product was one-shot: "Draft with AI"
-- produced a result and forgot everything. This adds a durable working
-- SESSION (like a Claude conversation) that any surface can attach to —
-- playbook editing, DE editing, or the workspace assistant — so a user
-- can iterate in plain language across many turns.
--
-- It also adds the AUTO-APPLY + UNDO lane (founder decision 2026-07-20):
-- a narrow allow-list of low-risk changes the assistant may apply without
-- a review card, each recorded with its before-state so it can be undone
-- with one click for 120 hours.
--
-- SECURITY POSTURE (the important part):
--   The model NEVER decides whether something is low-risk. It can only
--   NAME a change kind; this migration owns the allow-list, and anything
--   not on it is rejected at the database boundary — even if the model
--   was talked into asking for it by injected text. Guardrails, trust
--   levels, credentials, publishing, lifecycle and anything
--   customer-facing are permanently ineligible and must keep going
--   through the existing human-reviewed amendment system.
-- ════════════════════════════════════════════════════════════════

-- Documents the assistant writes get their own provenance value rather
-- than being mislabelled as an existing source — "who wrote this doc" is
-- exactly the kind of thing you want to be able to filter on later.
ALTER TABLE knowledge_docs DROP CONSTRAINT IF EXISTS knowledge_docs_source_check;
ALTER TABLE knowledge_docs ADD CONSTRAINT knowledge_docs_source_check
  CHECK (source = ANY (ARRAY['upload','paste','connector','self_improvement','ai_assistant']));

-- ── Sessions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What this session is about. 'workspace' = the platform assistant.
  subject_kind text NOT NULL CHECK (subject_kind IN ('de', 'playbook', 'workspace')),
  subject_id   uuid,                       -- null for workspace sessions
  title        text NOT NULL DEFAULT 'Untitled session',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_lookup
  ON ai_sessions(tenant_id, user_id, subject_kind, subject_id, updated_at DESC);

ALTER TABLE ai_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sessions" ON ai_sessions;
CREATE POLICY "own sessions" ON ai_sessions
  FOR SELECT USING (tenant_id = public.auth_tenant_id() AND user_id = auth.uid());

-- ── Messages ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_session_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      text NOT NULL,
  -- Structured record of what the assistant did this turn (proposals,
  -- applied changes, citations) so the UI can render it richly.
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_session_messages_thread
  ON ai_session_messages(session_id, created_at);

ALTER TABLE ai_session_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own session messages" ON ai_session_messages;
CREATE POLICY "own session messages" ON ai_session_messages
  FOR SELECT USING (
    tenant_id = public.auth_tenant_id()
    AND EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = session_id AND s.user_id = auth.uid())
  );

-- ── Reversible change log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_change_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  change_kind  text NOT NULL,
  target_table text NOT NULL,
  target_id    uuid,
  summary      text NOT NULL,              -- plain language, shown in the UI
  before_state jsonb,                      -- null when the change CREATED the row
  after_state  jsonb,
  applied_by   uuid REFERENCES auth.users(id),
  applied_at   timestamptz NOT NULL DEFAULT now(),
  -- Founder decision: 120-hour undo window.
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '120 hours'),
  undone_at    timestamptz,
  undone_by    uuid REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_ai_change_log_undoable
  ON ai_change_log(tenant_id, applied_at DESC) WHERE undone_at IS NULL;

ALTER TABLE ai_change_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant reads change log" ON ai_change_log;
CREATE POLICY "tenant reads change log" ON ai_change_log
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- ════════════════════════════════════════════════════════════════
-- THE ALLOW-LIST — the security boundary
-- ════════════════════════════════════════════════════════════════
-- Adding a kind here is a deliberate, reviewable act. Everything absent
-- is auto-apply-ineligible, forever, by default.
CREATE OR REPLACE FUNCTION public.ai_change_is_auto_appliable(p_kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_kind IN (
    'knowledge.create',        -- add a knowledge document
    'knowledge.edit',          -- edit a knowledge document's title/content
    'playbook.draft_steps',    -- save DRAFT steps (never publish)
    'de.describe'              -- name / description / purpose / persona only
  );
$$;

-- ── Apply: validates, snapshots, mutates, logs. One transaction. ──
CREATE OR REPLACE FUNCTION public.ai_apply_change(
  p_session_id  uuid,
  p_kind        text,
  p_target_id   uuid,
  p_patch       jsonb,
  p_summary     text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant  uuid := public.auth_tenant_id();
  v_user    uuid := auth.uid();
  v_before  jsonb;
  v_after   jsonb;
  v_table   text;
  v_target  uuid := p_target_id;
  v_change  uuid;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- The boundary the model cannot argue its way past.
  IF NOT public.ai_change_is_auto_appliable(p_kind) THEN
    RAISE EXCEPTION 'change_kind_requires_human_review: %', p_kind;
  END IF;

  -- Session must belong to this caller (prevents cross-user replay).
  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ai_sessions s
    WHERE s.id = p_session_id AND s.tenant_id = v_tenant AND s.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  IF p_kind = 'knowledge.create' THEN
    v_table := 'knowledge_docs';
    INSERT INTO knowledge_docs (tenant_id, title, content, source, tags, visibility)
    VALUES (
      v_tenant,
      coalesce(p_patch->>'title', 'Untitled'),
      coalesce(p_patch->>'content', ''),
      'ai_assistant',
      CASE WHEN jsonb_exists(p_patch, 'tags')
           THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'tags'))
           ELSE '{}'::text[] END,
      'tenant'
    )
    RETURNING id, to_jsonb(knowledge_docs.*) INTO v_target, v_after;

  ELSIF p_kind = 'knowledge.edit' THEN
    v_table := 'knowledge_docs';
    SELECT to_jsonb(k.*) INTO v_before FROM knowledge_docs k
    WHERE k.id = v_target AND k.tenant_id = v_tenant;
    IF v_before IS NULL THEN RAISE EXCEPTION 'knowledge_doc_not_found'; END IF;
    UPDATE knowledge_docs SET
      title   = coalesce(p_patch->>'title', title),
      content = coalesce(p_patch->>'content', content),
      updated_at = now()
    WHERE id = v_target AND tenant_id = v_tenant
    RETURNING to_jsonb(knowledge_docs.*) INTO v_after;

  ELSIF p_kind = 'playbook.draft_steps' THEN
    v_table := 'playbook_definitions';
    SELECT to_jsonb(d.*) INTO v_before FROM playbook_definitions d
    WHERE d.id = v_target AND d.tenant_id = v_tenant;
    IF v_before IS NULL THEN RAISE EXCEPTION 'playbook_not_found'; END IF;
    -- Draft-only: a published playbook is customer-affecting, so the
    -- assistant may never overwrite one in place.
    IF (v_before->>'status') = 'published' THEN
      RAISE EXCEPTION 'published_playbook_requires_human_review';
    END IF;
    UPDATE playbook_definitions SET
      steps = coalesce(p_patch->'steps', steps),
      name  = coalesce(p_patch->>'name', name),
      description = coalesce(p_patch->>'description', description),
      updated_at = now()
    WHERE id = v_target AND tenant_id = v_tenant
    RETURNING to_jsonb(playbook_definitions.*) INTO v_after;

  ELSIF p_kind = 'de.describe' THEN
    v_table := 'digital_employees';
    SELECT to_jsonb(d.*) INTO v_before FROM digital_employees d
    WHERE d.id = v_target AND d.tenant_id = v_tenant;
    IF v_before IS NULL THEN RAISE EXCEPTION 'de_not_found'; END IF;
    -- Identity/description ONLY. Deliberately cannot touch trust level,
    -- reply mode, lifecycle, model, or any guardrail-adjacent column.
    UPDATE digital_employees SET
      name              = coalesce(p_patch->>'name', name),
      persona_name      = coalesce(p_patch->>'persona_name', persona_name),
      description       = coalesce(p_patch->>'description', description),
      purpose_statement = coalesce(p_patch->>'purpose_statement', purpose_statement)
    WHERE id = v_target AND tenant_id = v_tenant
    RETURNING to_jsonb(digital_employees.*) INTO v_after;
  END IF;

  INSERT INTO ai_change_log (
    tenant_id, session_id, change_kind, target_table, target_id,
    summary, before_state, after_state, applied_by
  ) VALUES (
    v_tenant, p_session_id, p_kind, v_table, v_target,
    coalesce(nullif(p_summary, ''), p_kind), v_before, v_after, v_user
  ) RETURNING id INTO v_change;

  -- Auto-applied changes are still audited like everything else.
  PERFORM append_audit_event(
    v_tenant, 'Workspace Assistant', 'de',
    format('Auto-applied: %s', coalesce(nullif(p_summary, ''), p_kind)),
    'config_change',
    jsonb_build_object('change_id', v_change, 'kind', p_kind, 'target_id', v_target, 'undoable_until', now() + interval '120 hours')
  );

  RETURN jsonb_build_object(
    'ok', true, 'change_id', v_change, 'target_id', v_target,
    'undoable_until', (now() + interval '120 hours')::text
  );
END$$;

-- ── Undo: restores the snapshot inside the 120-hour window ──────
CREATE OR REPLACE FUNCTION public.ai_undo_change(p_change_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.auth_tenant_id();
  v_user   uuid := auth.uid();
  v_row    ai_change_log;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_row FROM ai_change_log
  WHERE id = p_change_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'change_not_found'; END IF;
  IF v_row.undone_at IS NOT NULL THEN RAISE EXCEPTION 'already_undone'; END IF;
  IF now() > v_row.expires_at THEN RAISE EXCEPTION 'undo_window_expired'; END IF;

  IF v_row.before_state IS NULL THEN
    -- The change created the row; undo = remove it.
    IF v_row.target_table = 'knowledge_docs' THEN
      DELETE FROM knowledge_docs WHERE id = v_row.target_id AND tenant_id = v_tenant;
    END IF;
  ELSIF v_row.target_table = 'knowledge_docs' THEN
    UPDATE knowledge_docs SET
      title = v_row.before_state->>'title',
      content = v_row.before_state->>'content',
      updated_at = now()
    WHERE id = v_row.target_id AND tenant_id = v_tenant;
  ELSIF v_row.target_table = 'playbook_definitions' THEN
    UPDATE playbook_definitions SET
      steps = v_row.before_state->'steps',
      name = v_row.before_state->>'name',
      description = v_row.before_state->>'description',
      updated_at = now()
    WHERE id = v_row.target_id AND tenant_id = v_tenant;
  ELSIF v_row.target_table = 'digital_employees' THEN
    UPDATE digital_employees SET
      name = v_row.before_state->>'name',
      persona_name = v_row.before_state->>'persona_name',
      description = v_row.before_state->>'description',
      purpose_statement = v_row.before_state->>'purpose_statement'
    WHERE id = v_row.target_id AND tenant_id = v_tenant;
  END IF;

  UPDATE ai_change_log SET undone_at = now(), undone_by = v_user WHERE id = p_change_id;

  PERFORM append_audit_event(
    v_tenant, 'Workspace Assistant', 'human',
    format('Undone: %s', v_row.summary), 'config_change',
    jsonb_build_object('change_id', p_change_id, 'kind', v_row.change_kind)
  );

  RETURN jsonb_build_object('ok', true, 'restored', v_row.target_table);
END$$;

-- ── Read helpers for the UI ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_list_undoable(p_limit int DEFAULT 20)
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (
    SELECT id, change_kind, summary, target_table, target_id,
           applied_at::text, expires_at::text
    FROM ai_change_log
    WHERE tenant_id = public.auth_tenant_id()
      AND undone_at IS NULL AND now() < expires_at
    ORDER BY applied_at DESC
    LIMIT greatest(1, least(p_limit, 100))
  ) x;
$$;

REVOKE ALL ON FUNCTION public.ai_apply_change(uuid, text, uuid, jsonb, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.ai_undo_change(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.ai_list_undoable(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ai_apply_change(uuid, text, uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_undo_change(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_list_undoable(int) TO authenticated, service_role;
GRANT SELECT ON ai_sessions, ai_session_messages, ai_change_log TO authenticated;
