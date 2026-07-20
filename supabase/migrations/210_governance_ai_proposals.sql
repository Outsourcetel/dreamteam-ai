-- 210_governance_ai_proposals.sql
-- ============================================================================
-- AI-assisted governance (Governance rebuild, Part 2).
--
-- A non-technical user talks to the Workspace Assistant to set up or change
-- safety guardrails in plain language. The safety model is the whole point:
--
--   • The assistant may ONLY record a *pending proposal* here. It has NO path
--     that writes guardrail_rules — not the service role, not an RPC. The
--     ai-session function's apply allow-list already excludes guardrails, and
--     this table is the only thing governance mode can write.
--   • A human approves each proposal. Approval creates the real guardrail via
--     the SAME user-scoped, audited path a person uses by hand (addGuardrailRule
--     / updateGuardrailRule under RLS) — the assistant never touches the live
--     rule. governance_decide_proposal only records the decision.
--
-- So no amount of injected or persuasive text can flip a guardrail off: the
-- assistant can suggest, a person must click.
-- GLOBAL — every tenant, current and future.
-- ============================================================================

-- Governance is now a first-class subject for a working session.
ALTER TABLE ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_subject_kind_check;
ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_subject_kind_check
  CHECK (subject_kind IN ('de', 'playbook', 'workspace', 'governance'));

-- ── Proposals ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  -- Where the proposed guardrail would apply — mirrors guardrail_rules.scope.
  scope           text NOT NULL DEFAULT 'workspace'
                    CHECK (scope IN ('workspace', 'department', 'employee', 'playbook')),
  scope_ref       text,                     -- DE id / department name / playbook id; null = workspace
  -- What the assistant proposes doing.
  action          text NOT NULL CHECK (action IN ('add', 'pause', 'resume', 'edit')),
  -- Fields for a proposed NEW rule (action 'add') or an edit.
  rule_type       text,
  rule_name       text,
  pattern         text,
  threshold       integer,
  severity        text CHECK (severity IN ('blocking', 'warning')),
  -- The existing rule a pause/resume/edit refers to.
  target_rule_id  uuid REFERENCES guardrail_rules(id) ON DELETE CASCADE,
  rationale       text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid REFERENCES auth.users(id),
  decided_at      timestamptz,
  -- Set on approval so the proposal links to the live rule it produced.
  applied_rule_id uuid REFERENCES guardrail_rules(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_governance_proposals_pending
  ON governance_proposals(tenant_id, scope, scope_ref, created_at DESC)
  WHERE status = 'pending';

ALTER TABLE governance_proposals ENABLE ROW LEVEL SECURITY;

-- Any member of the tenant may SEE their workspace's proposals.
DROP POLICY IF EXISTS "tenant reads governance proposals" ON governance_proposals;
CREATE POLICY "tenant reads governance proposals" ON governance_proposals
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- No INSERT/UPDATE/DELETE policy: writes happen only through the service role
-- (the ai-session function recording a proposal) and the SECURITY DEFINER
-- decision RPC below. A tenant member cannot hand-write a "proposal" that
-- masquerades as the assistant's.

-- ── Role gate helper (mirrors the app's owner/admin gate) ────────────────────
CREATE OR REPLACE FUNCTION public.governance_user_can_decide(p_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND tenant_id = p_tenant
      AND role = ANY (ARRAY['tenant_owner', 'tenant_admin'])
  );
$$;

-- ── Record a decision ────────────────────────────────────────────────────────
-- This does NOT create the guardrail. The client creates the live rule first
-- through the ordinary audited addGuardrailRule/updateGuardrailRule path (so
-- RLS + auth.uid() + the audit trail all apply exactly as a manual edit), then
-- calls this to stamp the proposal approved and link the rule it produced.
-- 'dismissed' just closes the proposal with no side effect.
CREATE OR REPLACE FUNCTION public.governance_decide_proposal(
  p_proposal_id   uuid,
  p_decision      text,               -- 'approved' | 'dismissed'
  p_applied_rule_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_status text;
BEGIN
  IF p_decision NOT IN ('approved', 'dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_decision');
  END IF;

  SELECT tenant_id, status INTO v_tenant, v_status
  FROM governance_proposals WHERE id = p_proposal_id;

  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF NOT public.governance_user_can_decide(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  IF v_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_decided', 'status', v_status);
  END IF;

  UPDATE governance_proposals
     SET status = p_decision,
         decided_by = auth.uid(),
         decided_at = now(),
         applied_rule_id = CASE WHEN p_decision = 'approved' THEN p_applied_rule_id ELSE NULL END
   WHERE id = p_proposal_id;

  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END;
$$;

REVOKE ALL ON FUNCTION public.governance_decide_proposal(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.governance_decide_proposal(uuid, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.governance_user_can_decide(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.governance_user_can_decide(uuid) TO authenticated;
